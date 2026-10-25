// Everything the browser asks of Supabase now goes through here.
//
// Before this, the page held the anon key in its source and talked to Supabase
// directly. That key is a bearer token for the whole Data API: a country-wide
// bbox returned 1,000 full rows in 1.4 seconds, and walking a grid copied all
// 311,000 plots in minutes. Nothing on the database side could stop it, because
// every request looked exactly like the map doing its job.
//
// Three things change by putting a Worker in the middle:
//   1. The key becomes a Worker secret. It is never served to anyone, so it
//      cannot be lifted from the page source, and rotating it is one command
//      rather than a redeploy.
//   2. Requests can be counted per IP. Cloudflare's rate-limit binding does
//      this at the edge, before the request reaches Supabase.
//   3. A request for half the country can be refused outright. The bbox cap is
//      the part that actually bounds bulk copying: with it, harvesting the
//      country takes thousands of requests instead of a few hundred.
//
// None of this makes the data uncopyable -- it is a public map, and anything
// drawn on screen can be collected by someone patient enough. It moves bulk
// copying from "minutes, silently" to "days, visibly rate-limited".

// Only what the page actually calls. An allowlist rather than a blocklist: a
// function added to the database later is unreachable until it is named here,
// which is the opposite of the dashboard's "expose new tables" default that
// quietly published plots_history.
const PUBLIC_RPC = new Set([
  "data_updated_at", "list_land_uses", "list_zones", "plot_setback",
  "plots_in_bbox", "road_edges_in_bbox",
  "plot_by_gis", "plot_by_block_parcel", "plot_by_parcel_no",
  "search_address", "area_extent",
  "list_governorates", "list_nbhoods", "list_blocks_v3", "list_parcels_v3",
]);

// Signed-in only. Passed through with the caller's own token so the database
// still decides -- the grants on these are revoked from anon, and that remains
// the real gate. Listing them here only makes them reachable.
const AUTHED_RPC = new Set(["area_report", "area_plots", "set_plot_type"]);

// The largest area a single viewport request may cover, in square degrees.
//
// Sized from the real worst case rather than a round number: the map refuses
// to load plots below zoom 15, and at zoom 15 on a 2560x1440 screen the
// viewport is about 0.110 x 0.054 = 0.006 square degrees. 0.05 leaves roughly
// eight times that headroom, so no genuine viewport is ever refused, while a
// request covering the country (~3.8 square degrees) is.
const MAX_BBOX_SQ_DEG = 0.05;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

function bboxTooBig(params) {
  const n = (k) => {
    const v = params.get(k);
    return v == null ? null : Number(v);
  };
  const [w, s, e, nn] = [n("min_lon"), n("min_lat"), n("max_lon"), n("max_lat")];
  if ([w, s, e, nn].some((v) => v == null || !Number.isFinite(v))) return false;
  return Math.abs(e - w) * Math.abs(nn - s) > MAX_BBOX_SQ_DEG;
}

// Street-level imagery, from Mapillary rather than Google -- Google has no car
// coverage in Kuwait at all. The municipality's own Kuwait Finder was built on
// this same service: its code calls a.mapillary.com with an `organization_keys`
// filter, so PACI uploads its annual road survey here. Their copy broke when
// Mapillary retired API v3 and their certificate lapsed; v4 is live, free, and
// needs no billing.
//
// Proxied for the same reason as Supabase: the token stays a Worker secret
// instead of being readable in the page, and rotating it is one command.
const MAPILLARY = "https://graph.mapillary.com/images";
// A tight box around the point -- roughly 120 m, enough to find the nearest
// pass without dragging in the next street's imagery.
const SV_BOX_DEG = 0.0011;

async function streetView(url, env) {
  if (!env.MAPILLARY_TOKEN) return json(500, { error: "street view is not configured" });
  const lon = Number(url.searchParams.get("lon"));
  const lat = Number(url.searchParams.get("lat"));
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    return json(400, { error: "lon and lat required" });
  }
  const bbox = [lon - SV_BOX_DEG, lat - SV_BOX_DEG, lon + SV_BOX_DEG, lat + SV_BOX_DEG].join(",");
  const fields = "id,captured_at,compass_angle,geometry,thumb_1024_url,creator,is_pano";
  const target = `${MAPILLARY}?bbox=${bbox}&fields=${fields}&limit=50` +
                 `&access_token=${encodeURIComponent(env.MAPILLARY_TOKEN)}`;
  const res = await fetch(target, { headers: { accept: "application/json" } });
  const body = await res.text();
  // Mapillary's own error text is passed through: a bad token has to be
  // debuggable, and nothing here is secret except the token, which is not
  // echoed back.
  return new Response(body, {
    status: res.status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// Viewport responses are cached, but the bounding box is NOT widened to get
// cache hits. That was tried and it broke the map.
//
// The reasoning was that every pan produces a box unique to fifteen decimal
// places, so nothing ever matches and nothing can be cached; snapping the box
// out to a 0.01 degree grid would make panning inside a cell reuse one URL.
// It did, and repeat views dropped from ~1,800 ms to under 100 ms.
//
// What it missed: plots_in_bbox is capped at 1,000 rows and has no ORDER BY,
// so once a box holds more plots than the cap, WHICH thousand come back is
// arbitrary. A widened box in a dense area therefore returns a thousand plots
// from somewhere else in the enlarged area, not the ones under the viewer's
// screen. Measured on real browser-sized viewports: 86% of the plots that
// should have been visible were missing at zoom 16, and 100% at zoom 15.
// Zooming in shrank the box under the cap and they reappeared, which is
// exactly how it was reported -- "I have to zoom in and out for them to
// appear".
//
// So the cache key is the exact box the page asked for. Hit rate is low --
// only a viewer returning to precisely the same view benefits -- and that is
// the correct trade: a fast map that shows the wrong parcels is not a map.
// Making this cacheable again means fixed tiles small enough to sit under the
// row cap, which is a different design, not a rounding tweak.
const VIEWPORT_TTL = 3600; // plot data changes once a week, on the Friday sync

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Anything that is not an API call is the site itself.
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }
    if (!env.SUPABASE_KEY) {
      return json(500, { error: "proxy is not configured" });
    }

    // Per-IP, at the edge. Counted before anything is forwarded, so a scraper
    // costs us a Worker invocation and nothing else.
    const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (env.RATE_LIMITER) {
      const { success } = await env.RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return json(429, { error: "too many requests" });
      }
    }

    const auth = request.headers.get("authorization") ?? "";
    // A real user token is a session JWT the sign-in flow returned. Anything
    // else -- including a caller inventing a bearer -- is treated as anonymous
    // and gets the anon key, so the database applies anon's grants.
    const userToken = /^Bearer\s+ey/i.test(auth) ? auth.slice(7).trim() : null;

    let target;
    let cacheKey = null;
    if (url.pathname.startsWith("/api/rpc/")) {
      const fn = url.pathname.slice("/api/rpc/".length);
      const known = PUBLIC_RPC.has(fn) || AUTHED_RPC.has(fn);
      if (!known) return json(404, { error: "unknown endpoint" });
      // The cap applies to the viewport lookups whichever verb is used.
      if ((fn === "plots_in_bbox" || fn === "road_edges_in_bbox") && bboxTooBig(url.searchParams)) {
        return json(413, { error: "area too large; zoom in" });
      }

      // The viewport lookups are cached under the exact box requested. Only
      // for anonymous callers: a signed-in reply must never be stored and
      // handed to the next visitor.
      const cacheable = (fn === "plots_in_bbox" || fn === "road_edges_in_bbox")
        && request.method === "GET" && !userToken;
      if (cacheable) {
        cacheKey = new Request(request.url, { method: "GET" });
        const hit = await caches.default.match(cacheKey);
        if (hit) return hit;
      }
      target = `${env.SUPABASE_URL}/rest/v1/rpc/${fn}${url.search}`;
    } else if (url.pathname === "/api/auth/token") {
      target = `${env.SUPABASE_URL}/auth/v1/token${url.search}`;
    } else if (url.pathname === "/api/streetview") {
      return streetView(url, env);
    } else {
      return json(404, { error: "unknown endpoint" });
    }

    const headers = new Headers();
    headers.set("apikey", env.SUPABASE_KEY);
    headers.set("authorization", `Bearer ${userToken ?? env.SUPABASE_KEY}`);
    const ct = request.headers.get("content-type");
    if (ct) headers.set("content-type", ct);
    headers.set("accept", request.headers.get("accept") ?? "application/json");

    const res = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.text(),
    });

    // Copy the reply through, minus anything that would let a caller learn
    // about the upstream project.
    const out = new Headers();
    for (const k of ["content-type", "content-range"]) {
      const v = res.headers.get(k);
      if (v) out.set(k, v);
    }

    // Store a good viewport reply for the next viewer of the same cell. Only
    // 200s: caching an error would pin it there for the whole TTL.
    if (cacheKey && res.status === 200) {
      out.set("cache-control", `public, max-age=${VIEWPORT_TTL}`);
      const body = await res.arrayBuffer();
      const reply = new Response(body, { status: 200, headers: out });
      // waitUntil, so storing it does not delay the response being sent.
      ctx.waitUntil(caches.default.put(cacheKey, reply.clone()));
      return reply;
    }
    return new Response(res.body, { status: res.status, headers: out });
  },
};
