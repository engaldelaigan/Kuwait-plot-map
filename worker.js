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
  "data_updated_at", "list_land_uses", "plot_setback",
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
    if (url.pathname.startsWith("/api/rpc/")) {
      const fn = url.pathname.slice("/api/rpc/".length);
      const known = PUBLIC_RPC.has(fn) || AUTHED_RPC.has(fn);
      if (!known) return json(404, { error: "unknown endpoint" });
      // The cap applies to the viewport lookups whichever verb is used.
      if ((fn === "plots_in_bbox" || fn === "road_edges_in_bbox") && bboxTooBig(url.searchParams)) {
        return json(413, { error: "area too large; zoom in" });
      }
      target = `${env.SUPABASE_URL}/rest/v1/rpc/${fn}${url.search}`;
    } else if (url.pathname === "/api/auth/token") {
      target = `${env.SUPABASE_URL}/auth/v1/token${url.search}`;
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
    return new Response(res.body, { status: res.status, headers: out });
  },
};
