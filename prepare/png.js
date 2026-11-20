// png.js — encode an 8-bit single-channel (grayscale, PNG colour type 0) image.
// Canvas PNG export would write RGBA (H x W x 4); this keeps the files H x W like the pipeline's PIL "L" PNGs.
// Rows are filtered adaptively (None/Sub/Up/Average/Paeth, smallest sum of |residual|, as libpng does).
// Uses CompressionStream, so it runs in browsers and in Node >= 18.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf, crc = 0xffffffff) {
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length), dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, (crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff) >>> 0);
  return out;
}

function filterRows(gray, w, h) {
  const out = new Uint8Array((w + 1) * h), cand = Array.from({ length: 5 }, () => new Uint8Array(w));
  const zero = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const cur = gray.subarray(y * w, (y + 1) * w), up = y ? gray.subarray((y - 1) * w, y * w) : zero;
    let best = 0, bestSum = Infinity;
    for (let t = 0; t < 5; t++) {
      const c = cand[t]; let sum = 0;
      for (let x = 0; x < w; x++) {
        const a = x ? cur[x - 1] : 0, b = up[x], cc = x ? up[x - 1] : 0;
        let pred = 0;
        if (t === 1) pred = a; else if (t === 2) pred = b; else if (t === 3) pred = (a + b) >> 1;
        else if (t === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
        const r = (cur[x] - pred) & 0xff; c[x] = r; sum += r < 128 ? r : 256 - r;
        if (sum >= bestSum) break;
      }
      if (sum < bestSum) { bestSum = sum; best = t; }
    }
    // recompute the winner fully (the loop above may have stopped early for it only if it lost)
    const c = cand[best];
    for (let x = 0; x < w; x++) {
      const a = x ? cur[x - 1] : 0, b = up[x], cc = x ? up[x - 1] : 0;
      let pred = 0;
      if (best === 1) pred = a; else if (best === 2) pred = b; else if (best === 3) pred = (a + b) >> 1;
      else if (best === 4) { const p = a + b - cc, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - cc); pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : cc; }
      c[x] = (cur[x] - pred) & 0xff;
    }
    out[y * (w + 1)] = best;
    out.set(c, y * (w + 1) + 1);
  }
  return out;
}

export async function encodeGrayPng(gray, w, h) {
  if (gray.length !== w * h) throw new Error('encodeGrayPng: size mismatch');
  const filtered = filterRows(gray, w, h);
  const z = new Uint8Array(await new Response(new Blob([filtered]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  const ihdr = new Uint8Array(13), dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;      // 8-bit, grayscale, deflate, adaptive filter, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
