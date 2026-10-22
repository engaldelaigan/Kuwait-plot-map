// Local dev server. Serves real files (manifest, service worker, icons) rather
// than returning index.html for every path -- the PWA can't be tested if
// /sw.js and /manifest.webmanifest come back as HTML.
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

const TYPES = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".png": "image/png",
  ".css": "text/css",
};

// The page calls its own /api, which in production is the Worker holding the
// Supabase key. Nothing here can serve that -- the key is a Worker secret and
// deliberately not on this machine -- so dev forwards those calls to the
// deployed Worker. Without this, every data request 404s locally and the map
// comes up empty.
const UPSTREAM = process.env.KWPLOTS_API ?? "https://kuwaitplot.com";

function proxyApi(req, res) {
  const target = new URL(req.url, UPSTREAM);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    const headers = { accept: req.headers.accept ?? "application/json" };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"];
    // A signed-in session's own token, when the page sends one.
    if (req.headers.authorization) headers.authorization = req.headers.authorization;
    const r = https.request(
      target,
      { method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode ?? 502, {
          "Content-Type": up.headers["content-type"] ?? "application/json",
          "Cache-Control": "no-store",
        });
        up.pipe(res);
      }
    );
    r.on("error", (err) => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `dev proxy: ${err.message}` }));
    });
    if (body.length) r.write(body);
    r.end();
  });
}

http
  .createServer((req, res) => {
    if ((req.url || "").startsWith("/api/")) return proxyApi(req, res);
    const url = decodeURIComponent((req.url || "/").split("?")[0]);
    const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const file = path.join(__dirname, rel);

    // don't serve anything outside this directory
    if (!file.startsWith(__dirname) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("not found");
    }

    res.writeHead(200, {
      "Content-Type": TYPES[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(fs.readFileSync(file));
  })
  .listen(8080, () => console.log("Serving on http://localhost:8080"));
