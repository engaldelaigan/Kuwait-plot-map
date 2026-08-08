// Local dev server. Serves real files (manifest, service worker, icons) rather
// than returning index.html for every path -- the PWA can't be tested if
// /sw.js and /manifest.webmanifest come back as HTML.
const http = require("http");
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

http
  .createServer((req, res) => {
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
