// Generates the PWA icons as PNGs with no external dependencies -- a plain
// raster encoded with Node's built-in zlib. The mark is a parcel outline with
// a corner node, echoing the map's own styling.
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const BG = [0x3c, 0x6e, 0x47]; // --accent green
const FG = [0xff, 0xff, 0xff];

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size, draw) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, rgb, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a;
  };
  draw(set, size);

  // each scanline gets a leading filter byte (0 = none)
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Parcel outline with a measured corner node.
function drawMark(set, S) {
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) set(x, y, BG);

  const m = Math.round(S * 0.24);          // margin
  const t = Math.max(2, Math.round(S * 0.055)); // stroke
  const x0 = m, x1 = S - m, y0 = m, y1 = S - m;

  const hLine = (xa, xb, y) => {
    for (let x = xa; x <= xb; x++) for (let d = 0; d < t; d++) set(x, y + d, FG);
  };
  const vLine = (ya, yb, x) => {
    for (let y = ya; y <= yb; y++) for (let d = 0; d < t; d++) set(x + d, y, FG);
  };
  hLine(x0, x1, y0);
  hLine(x0, x1, y1 - t);
  vLine(y0, y1, x0);
  vLine(y0, y1, x1 - t);

  // corner node, like the ruler's snap indicator
  const r = Math.round(S * 0.085);
  const cx = x0, cy = y1 - t;
  for (let y = -r; y <= r; y++)
    for (let x = -r; x <= r; x++)
      if (x * x + y * y <= r * r) set(cx + x, cy + y, FG);
}

const out = path.join(__dirname, "..");
for (const size of [192, 512, 180]) {
  const file = path.join(out, `icon-${size}.png`);
  fs.writeFileSync(file, png(size, drawMark));
  console.log("wrote", file, fs.statSync(file).size, "bytes");
}
