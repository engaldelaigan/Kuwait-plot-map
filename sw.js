// Service worker for the installable app.
//
// Deliberately conservative: the page shell is fetched from the network first
// and only falls back to cache when offline. Cache-first would be faster but
// would keep serving a stale build after a deploy, and this app's correctness
// depends on shipping fixes promptly -- an old cached copy could show the
// wrong parcel for an address long after the bug was fixed.
//
// Plot data is never cached: it is fetched from Supabase per viewport, and a
// stale boundary or dimension is worse than a slow one in a measuring tool.
// v2 drops every v1 cache on activate, which is how the API responses v1 had
// been storing get off people's devices.
const VERSION = "v2";
const SHELL = `shell-${VERSION}`;
const SHELL_URLS = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Never intercept data or map tiles -- always live.
  //
  // /api/ is same-origin in production -- the Worker holding the Supabase key
  // serves the page and proxies the data from one hostname -- so the
  // cross-origin test alone did not exclude it, and this was doing both of the
  // things the comment above says it does not. Every viewport, lookup and
  // report was being written into the shell cache, and on a failed request the
  // fallback below handed back index.html: a 200 whose body is HTML, which the
  // page then tried to parse as JSON. "Unexpected token '<'" was the data layer
  // reporting an outage as a syntax error.
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/index.html")))
  );
});
