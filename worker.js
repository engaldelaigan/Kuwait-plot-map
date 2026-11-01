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
  "plots_in_bbox", "road_edges_in_bbox", "nbhood_labels", "area_shape",
  "plot_by_gis", "plot_by_block_parcel", "plot_by_parcel_no",
  "search_address", "area_extent",
  "list_governorates", "list_nbhoods", "list_blocks_v3", "list_parcels_v3",
  // A parcel or house number looked up inside one neighbourhood, without
  // first choosing a block. Same reach as the cascade it sits in.
  "find_in_nbhood",
]);

// Signed-in only. Passed through with the caller's own token so the database
// still decides -- the grants on these are revoked from anon, and that remains
// the real gate. Listing them here only makes them reachable.
const AUTHED_RPC = new Set([
  "area_report", "area_plots", "set_plot_type",
  // The same report for a whole neighbourhood or one block, rather than a
  // hand-drawn outline. These were missing, which meant the Analyse button and
  // the block numbers on the map both came back "failed to load": the proxy
  // 404s anything it has not been told about, and an allowlist is only as
  // complete as the last thing added to the page.
  "area_report_nbh", "area_report_blk", "area_plots_nbh", "area_plots_blk",
  "area_report_gov", "area_plots_gov",
  // The private building-regulations reference on /laws.html. Listed here only
  // so the proxy will forward it; the database checks the caller against an
  // allowlist of user ids, so a signed-in stranger gets an empty result.
  "building_laws_search", "building_law_docs",
  // Usage figures on /stats.html, behind the same allowlist. Writing an event
  // is deliberately NOT here: that goes through /api/ev below, so the country
  // and device on every row are the ones Cloudflare resolved and not whatever
  // a caller felt like claiming.
  "usage_report", "usage_months", "set_month_cost", "prune_usage_events",
  "roll_up_month",
]);

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

// When the plot data last changed, as the cache's version stamp.
//
// Cached itself, for a minute, so this costs one extra round trip a minute
// rather than one per viewport. A minute of staleness in the VERSION is
// harmless -- it only delays the moment the real cache starts missing -- while
// a minute of staleness in the DATA is the whole problem being solved.
//
// If it cannot be read, every request gets a distinct stamp and nothing is
// served from cache. Slower, and correct: a cache that cannot tell whether it
// is stale should not be answering.
const VERSION_TTL = 60;

async function dataVersion(env, ctx) {
  const key = new Request("https://cache.invalid/data-version", { method: "GET" });
  const hit = await caches.default.match(key);
  if (hit) return hit.text();
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/data_updated_at`, {
      headers: {
        apikey: env.SUPABASE_KEY,
        authorization: `Bearer ${env.SUPABASE_KEY}`,
        accept: "application/json",
      },
    });
    if (!res.ok) throw new Error(String(res.status));
    const v = (await res.text()).replace(/[^0-9A-Za-z:.\-]/g, "").slice(0, 40) || "0";
    ctx.waitUntil(caches.default.put(key, new Response(v, {
      headers: { "cache-control": `public, max-age=${VERSION_TTL}` },
    })));
    return v;
  } catch {
    return `nocache-${Date.now()}`;
  }
}

// ---------------------------------------------------------------------------
// Usage events
// ---------------------------------------------------------------------------
// The page decides what is worth recording; this adds the two things only the
// edge knows -- where the request came from and what kind of device asked --
// and forwards the row. Those are taken from Cloudflare's own data rather than
// from the request body, so a caller cannot claim to be somewhere it is not.
//
// Nothing here stores an IP address. The country and city are Cloudflare's
// view of the network, which is the city, not the person; the visitor id is a
// random string the browser made up for itself.

// Three buckets, because the only question being asked of this is whether
// phones deserve more attention than they have had.
function deviceClass(ua) {
  const s = ua || "";
  if (/ipad|tablet|playbook|silk|android(?!.*mobile)/i.test(s)) return "tablet";
  if (/mobile|iphone|ipod|android|blackberry|opera mini|iemobile|phone/i.test(s)) return "phone";
  return "desktop";
}

const clip = (v, n) => {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s.slice(0, n) : null;
};
const int = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};

// Fire-and-forget: an event that cannot be written must never cost the visitor
// anything, so this never throws and the caller never waits for it.
function writeEvent(env, request, ev) {
  const cf = request.cf ?? {};
  const body = {
    p_visitor: clip(ev.visitor, 64),
    p_session: clip(ev.session, 64),
    p_name: clip(ev.name, 40),
    p_gov: int(ev.gov),
    p_nbh: int(ev.nbh),
    p_detail: clip(ev.detail, 120),
    p_country: clip(cf.country, 2),
    p_city: clip(cf.city, 60),
    p_device: deviceClass(request.headers.get("user-agent")),
    p_lang: ev.lang === "en" || ev.lang === "ar" ? ev.lang : null,
    p_ref: clip(ev.ref, 80),
  };
  if (!body.p_visitor || !body.p_session || !body.p_name) return Promise.resolve();
  return fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_event`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_KEY,
      authorization: `Bearer ${env.SUPABASE_KEY}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify(body),
  }).catch(() => {});
}

// A failed API call, recorded by the edge rather than by the page.
//
// This is the gap that hid a real fault for a day: list_blocks_v3 returned 500
// twice for the largest neighbourhood, the page caught it and rendered an empty
// block list, and an empty list is indistinguishable from a city whose blocks
// are genuinely unnumbered. Recorded here it cannot hide, and recording it here
// rather than in the page means it is still recorded when the page's own
// scripts are the thing that broke.
//
// The visitor and session come from headers the page sets on its API calls, so
// a failure belongs to the session it happened in. Without them there is
// nothing to attribute it to and nothing is written -- a count of anonymous
// failures would pollute the visitor numbers it sits beside.
function noteFailure(env, request, ctx, fn, status) {
  const visitor = request.headers.get("x-kwp-v");
  const session = request.headers.get("x-kwp-s");
  if (!visitor || !session) return;
  ctx.waitUntil(writeEvent(env, request, {
    visitor,
    session,
    name: status === 429 ? "rate_limited" : "api_error",
    detail: `${fn} ${status}`,
    lang: request.headers.get("x-kwp-l"),
  }));
}

export default {
  // Freezes last month's and this month's figures so they survive the raw rows
  // being pruned. Runs on the schedule in wrangler.jsonc; the function it calls
  // does nothing if both months were already built in the last six hours, so
  // running it more often than needed costs nothing.
  async scheduled(event, env, ctx) {
    if (!env.SUPABASE_KEY) return;
    ctx.waitUntil(
      fetch(`${env.SUPABASE_URL}/rest/v1/rpc/roll_up_recent`, {
        method: "POST",
        headers: {
          apikey: env.SUPABASE_KEY,
          authorization: `Bearer ${env.SUPABASE_KEY}`,
          "content-type": "application/json",
        },
        body: "{}",
      }).catch(() => {})
    );
  },

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
        // Worth seeing. A real visitor hitting the ceiling means the ceiling is
        // too low; a scraper hitting it means the ceiling is working. The two
        // look identical here and are told apart afterwards by how many
        // sessions are involved.
        noteFailure(env, request, ctx, "rate_limit", 429);
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
        // Keyed on the data's own version as well as the box, so a sync
        // invalidates the cache instead of being invisible until it expires.
        //
        // Without this a parcel added by a sync could not be seen for an hour
        // and there was no way to force it: the staleness is at the edge, so
        // reloading the page does nothing, and the only cure was to pan far
        // enough to ask for a box nobody had asked for yet. That is a bad
        // thing to have to explain, and worse to have to wait out.
        const v = await dataVersion(env, ctx);
        cacheKey = new Request(`${request.url}&v=${encodeURIComponent(v)}`, { method: "GET" });
        const hit = await caches.default.match(cacheKey);
        if (hit) return hit;
      }
      target = `${env.SUPABASE_URL}/rest/v1/rpc/${fn}${url.search}`;
    } else if (url.pathname === "/api/ev") {
      // One event. Answered 204 before the write is confirmed: the page sends
      // these with sendBeacon and does not wait, and a visitor must never be
      // made to wait on bookkeeping either.
      if (request.method !== "POST") return json(405, { error: "POST only" });
      let ev;
      try {
        const text = await request.text();
        if (text.length > 1024) return new Response(null, { status: 204 });
        ev = JSON.parse(text);
      } catch {
        return new Response(null, { status: 204 });
      }
      ctx.waitUntil(writeEvent(env, request, {
        visitor: ev.v, session: ev.s, name: ev.n,
        gov: ev.g, nbh: ev.b, detail: ev.d, lang: ev.l, ref: ev.r,
      }));
      return new Response(null, { status: 204 });
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

    // A failure the page is about to turn into an empty list. Recorded before
    // the reply is built, so it is counted whatever the page decides to show.
    if (res.status >= 500 || res.status === 429) {
      noteFailure(env, request, ctx, url.pathname.replace("/api/rpc/", ""), res.status);
    }

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
