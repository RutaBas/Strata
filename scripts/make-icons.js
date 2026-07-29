"use strict";

/* STRATA — icon generator.
   Run: node scripts/make-icons.js
   Writes real PNGs into icons/ so the app icon is reproducible from source and
   never a checked-in binary nobody can regenerate. No dependencies: the PNG is
   encoded here with node's own zlib.

   The mark is the anchor: a drill core seen head on — kraft paper, uneven
   sediment bands in the weight ramp, and one oxide-ringed bedrock stone. */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

// ------------------------------------------------------------- PNG encoding
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function encodePNG(w, h, rgba) {
  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // truecolour + alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ------------------------------------------------------------- tiny raster
function hex(h) {
  return [parseInt(h.substr(1, 2), 16), parseInt(h.substr(3, 2), 16), parseInt(h.substr(5, 2), 16)];
}
function surface(w, h) {
  const buf = Buffer.alloc(w * h * 4);
  return {
    w, h, buf,
    set(x, y, c, a) {
      if (x < 0 || y < 0 || x >= w || y >= h) return;
      const i = (y * w + x) * 4;
      const al = a === undefined ? 1 : a;
      buf[i] = Math.round(buf[i] * (1 - al) + c[0] * al);
      buf[i + 1] = Math.round(buf[i + 1] * (1 - al) + c[1] * al);
      buf[i + 2] = Math.round(buf[i + 2] * (1 - al) + c[2] * al);
      buf[i + 3] = Math.max(buf[i + 3], Math.round(255 * al));
    },
    rect(x0, y0, x1, y1, c, a) {
      for (let y = Math.max(0, Math.round(y0)); y < Math.min(h, Math.round(y1)); y++) {
        for (let x = Math.max(0, Math.round(x0)); x < Math.min(w, Math.round(x1)); x++) this.set(x, y, c, a);
      }
    },
    roundRect(x0, y0, x1, y1, r, c) {
      for (let y = Math.round(y0); y < Math.round(y1); y++) {
        for (let x = Math.round(x0); x < Math.round(x1); x++) {
          const dx = Math.max(x0 + r - x, 0, x - (x1 - r - 1));
          const dy = Math.max(y0 + r - y, 0, y - (y1 - r - 1));
          if (dx * dx + dy * dy <= r * r) this.set(x, y, c, 1);
        }
      }
    },
  };
}

const PAPER = hex("#e6e0d4");
const BANDS = ["#ded7c8", "#c9bda3", "#c2ab7d", "#ab9776", "#9d8358", "#8a7350", "#6b563a", "#52452f"];
const OXIDE = hex("#b4522a");
const DEEP = hex("#3d3226");

/* size = pixels; bleed = true draws the bands edge to edge and keeps the
   stone inside the maskable safe zone (the middle 80%). */
function drawIcon(size, opts) {
  const o = opts || {};
  const s = surface(size, size);
  const pad = o.bleed ? 0 : Math.round(size * 0.06);
  const r = o.bleed ? 0 : Math.round(size * 0.22);

  // kraft ground
  if (o.bleed) s.rect(0, 0, size, size, PAPER, 1);
  else s.roundRect(pad, pad, size - pad, size - pad, r, PAPER);

  // uneven sediment bands, thickest in the middle of the core
  const stops = [0, 0.09, 0.17, 0.28, 0.4, 0.55, 0.68, 0.82, 1];
  for (let i = 0; i < stops.length - 1; i++) {
    const y0 = pad + (size - pad * 2) * stops[i];
    const y1 = pad + (size - pad * 2) * stops[i + 1];
    const c = hex(BANDS[i % BANDS.length]);
    if (o.bleed) s.rect(0, y0, size, y1, c, 1);
    else {
      // clip the bands to the rounded card by re-testing the corner radius
      for (let y = Math.round(y0); y < Math.round(y1); y++) {
        for (let x = pad; x < size - pad; x++) {
          const dx = Math.max(pad + r - x, 0, x - (size - pad - r - 1));
          const dy = Math.max(pad + r - y, 0, y - (size - pad - r - 1));
          if (dx * dx + dy * dy <= r * r) s.set(x, y, c, 1);
        }
      }
    }
  }

  // grain: fine vertical scoring, like a drilled face
  for (let x = pad; x < size - pad; x += Math.max(2, Math.round(size / 46))) {
    s.rect(x, pad, x + 1, size - pad, DEEP, 0.06);
  }

  // one bedrock stone, oxide-ringed, dead centre and inside the safe zone
  const half = Math.round(size * (o.bleed ? 0.15 : 0.19));
  const cx = size / 2, cy = size / 2;
  const ring = Math.max(2, Math.round(size * 0.035));
  s.roundRect(cx - half - ring, cy - half - ring, cx + half + ring, cy + half + ring,
    Math.round(size * 0.06), OXIDE);
  s.roundRect(cx - half, cy - half, cx + half, cy + half, Math.round(size * 0.045), DEEP);

  return encodePNG(size, size, s.buf);
}

const out = path.join(__dirname, "..", "icons");
fs.mkdirSync(out, { recursive: true });

const JOBS = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["icon-512-maskable.png", 512, { bleed: true }],
  ["apple-touch-icon.png", 180, { bleed: true }], // iOS masks it itself
  ["favicon-32.png", 32, {}],
];

JOBS.forEach(([name, size, opts]) => {
  const png = drawIcon(size, opts);
  fs.writeFileSync(path.join(out, name), png);
  console.log("wrote icons/" + name + "  " + size + "x" + size + "  " + png.length + " bytes");
});
