const http = require("http");
const fs = require("fs");
const path = require("path");

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
  })
  .listen(8080, () => console.log("Serving on http://localhost:8080"));
