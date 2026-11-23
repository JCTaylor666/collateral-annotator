// worker.js — everything heavy for prepare.html, off the main thread:
//   models   download (cached, checksum-verified) and ONNX Runtime sessions, WebGPU or WebAssembly
//   DICOM    decode, 8-bit window, MinIP, black-border crop            (dicom.js)
//   mask     nnU-Net sliding-window inference, logits averaged over folds (+ mirroring)
//   label    branch partition of the mask                               (partition.js)
//   geometry per-segment metrics                                        (metrics.js)
//   files    frames.png, mask.npy, label.npy, geometry.json as bytes / text for the page to write
//
// Inference mirrors nnU-Net v2's predictor for this 2-D model: crop to the non-zero box, z-score, pad to the
// patch, Gaussian-weighted tiles at step 0.5, mean of the logits over folds x flips, softmax > 0.5.
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/ort.webgpu.min.mjs';

// Same release tag as the page. No top-level await: a message arriving while a module worker is still
// awaiting is dropped, so the handler at the bottom is installed at once and waits for libsReady itself.
const V = new URL(self.location.href).searchParams.get('v') || '0';
const L = {};
const libsReady = Promise.all(['dicom', 'png', 'partition', 'metrics', 'npywriter'].map((n) => import(`./${n}.js?v=${V}`)))
  .then((mods) => mods.forEach((m) => Object.assign(L, m)));

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.1/dist/';
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, navigator.hardwareConcurrency || 4) : 1;

const CACHE = 'dsa-vessel-seg-models-v1';      // shared with the vessel-segmentation page on the same site
const sessions = new Map();
let ep = null, PH = 896, PW = 768, cancelled = false;
let download = null;      // while models are being fetched: the AbortController of that download, so Stop can end it
const post = (msg, transfer) => self.postMessage(msg, transfer || []);

// ---------------------------------------------------------------- models

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function fetchModel(m, report, signal) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (e) { cache = null; }
  if (cache) {
    try {
      const hit = await cache.match(m.url);
      if (hit) {
        const b = new Uint8Array(await hit.arrayBuffer());
        report(b.byteLength, 'cache');
        if (!m.sha256 || (await sha256Hex(b)) === m.sha256) return b;
        await cache.delete(m.url);
      }
    } catch (e) { /* fall through to the network */ }
  }
  const res = await fetch(m.url, signal ? { mode: 'cors', signal } : { mode: 'cors' });
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status} from ${m.url}`);
  const reader = res.body.getReader();
  const chunks = []; let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); loaded += value.length;
    report(loaded, 'download');
  }
  const bytes = new Uint8Array(loaded); let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  if (m.sha256) {
    const got = await sha256Hex(bytes);
    if (got !== m.sha256) throw new Error(`Checksum mismatch for ${m.key} (got ${got.slice(0, 12)}…, expected ${m.sha256.slice(0, 12)}…)`);
  }
  if (cache) {
    try { await cache.put(m.url, new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'x-model-bytes': String(bytes.byteLength) } })); }
    catch (e) { /* quota: just don't cache */ }
  }
  return bytes;
}

async function webgpuUsable() {
  if (!('gpu' in navigator)) return false;
  try { return !!(await navigator.gpu.requestAdapter()); } catch (e) { return false; }
}

async function createSession(bytes, prefer) {
  const order = ep ? [ep] : prefer === 'wasm' ? ['wasm'] : prefer === 'webgpu' ? ['webgpu'] : ['webgpu', 'wasm'];
  const errors = [];
  for (const e of order) {
    if (e === 'webgpu' && !(await webgpuUsable())) { errors.push('webgpu: not available in this browser'); continue; }
    try {
      const s = await ort.InferenceSession.create(bytes, { executionProviders: [e], graphOptimizationLevel: 'all' });
      ep = e;
      return s;
    } catch (err) { errors.push(`${e}: ${(err && err.message) || err}`); }
  }
  throw new Error('Could not start the model. ' + errors.join(' | '));
}

async function load({ id, models, patch, prefer }) {
  [PH, PW] = patch;
  const todo = models.filter((m) => !sessions.has(m.key));
  const total = todo.reduce((s, m) => s + (m.size || 0), 0);
  let before = 0;
  // Stop during the download ends it at once (it used to run to its end first: minutes on a slow line). A model
  // that was cut off is not kept; the ones that were complete stay loaded for the next run.
  download = typeof AbortController !== 'undefined' ? new AbortController() : null;
  try {
    for (let i = 0; i < todo.length; i++) {
      if (cancelled) throw new Error('cancelled');
      const m = todo[i];
      let lastPost = 0;
      const bytes = await fetchModel(m, (loaded, phase) => {
        const now = performance.now();
        if (phase === 'cache' || now - lastPost > 100) {
          post({ type: 'progress', id, phase, key: m.key, index: i + 1, count: todo.length, loaded: before + loaded, total });
          lastPost = now;
        }
      }, download && download.signal);
      if (cancelled) throw new Error('cancelled');
      post({ type: 'progress', id, phase: 'compile', key: m.key, index: i + 1, count: todo.length, loaded: before + bytes.byteLength, total });
      const session = await createSession(bytes, prefer);
      sessions.set(m.key, { session, input: session.inputNames[0], output: session.outputNames[0] });
      before += m.size || bytes.byteLength;
    }
  } catch (e) {
    if (cancelled) throw new Error('cancelled');      // the download was cut off by Stop (it ends with an AbortError)
    throw e;
  } finally { download = null; }
  post({ type: 'ready', id, ep, threads: ort.env.wasm.numThreads, loaded: [...sessions.keys()] });
}

// ---------------------------------------------------------------- inference

function steps(imageSize, tile, stepFrac = 0.5) {
  const target = tile * stepFrac;
  const n = Math.ceil((imageSize - tile) / target) + 1;
  if (n <= 1) return [0];
  const actual = (imageSize - tile) / (n - 1);
  return Array.from({ length: n }, (_, i) => Math.round(actual * i));
}

let gauss = null;
function gaussian() {
  if (gauss && gauss.length === PH * PW) return gauss;
  const gy = new Float32Array(PH), gx = new Float32Array(PW);
  const sy = PH / 8, sx = PW / 8, cy = PH >> 1, cx = PW >> 1;
  for (let y = 0; y < PH; y++) gy[y] = Math.exp(-((y - cy) ** 2) / (2 * sy * sy));
  for (let x = 0; x < PW; x++) gx[x] = Math.exp(-((x - cx) ** 2) / (2 * sx * sx));
  gauss = new Float32Array(PH * PW);
  for (let y = 0; y < PH; y++) for (let x = 0; x < PW; x++) gauss[y * PW + x] = gy[y] * gx[x];
  return gauss;
}

// gray: Uint8Array w*h -> vessel mask Uint8Array w*h (1 = vessel, i.e. softmax > 0.5)
async function segmentGray(gray, w, h, mirror, models, onRun) {
  const bw = new Uint8Array(w * h);
  let y0 = h, y1 = -1, x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (gray[row + x] !== 0) {
      if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x;
    }
  }
  if (y1 < 0) return bw;
  const ch = y1 - y0 + 1, cw = x1 - x0 + 1, n = ch * cw;
  let sum = 0, sq = 0;
  for (let y = 0; y < ch; y++) { const row = (y + y0) * w + x0; for (let x = 0; x < cw; x++) { const v = gray[row + x]; sum += v; sq += v * v; } }
  const mean = sum / n, sd = Math.max(Math.sqrt(Math.max(0, sq / n - mean * mean)), 1e-8);
  const Hp = Math.max(ch, PH), Wp = Math.max(cw, PW);
  const pt = (Hp - ch) >> 1, pl = (Wp - cw) >> 1;
  const img = new Float32Array(Hp * Wp);
  for (let y = 0; y < ch; y++) {
    const src = (y + y0) * w + x0, dst = (y + pt) * Wp + pl;
    for (let x = 0; x < cw; x++) img[dst + x] = (gray[src + x] - mean) / sd;
  }
  const ys = steps(Hp, PH), xs = steps(Wp, PW);
  const flips = mirror ? [[0, 0], [0, 1], [1, 0], [1, 1]] : [[0, 0]];
  const G = gaussian(), P = PH * PW;
  const acc = new Float32Array(Hp * Wp), wsum = new Float32Array(Hp * Wp);
  const diff = new Float32Array(P), tile = new Float32Array(P);
  const total = ys.length * xs.length * flips.length * models.length;
  let done = 0;
  for (const ty of ys) for (const tx of xs) {
    diff.fill(0);
    for (const [fy, fx] of flips) {
      for (let y = 0; y < PH; y++) {
        const sy = fy ? PH - 1 - y : y, src = (ty + sy) * Wp + tx, dst = y * PW;
        if (fx) for (let x = 0; x < PW; x++) tile[dst + x] = img[src + PW - 1 - x];
        else tile.set(img.subarray(src, src + PW), dst);
      }
      for (const m of models) {
        if (cancelled) throw new Error('cancelled');
        const out = await m.session.run({ [m.input]: new ort.Tensor('float32', tile, [1, 1, PH, PW]) });
        const Lg = out[m.output].data;
        for (let y = 0; y < PH; y++) {
          const dy = fy ? PH - 1 - y : y;
          for (let x = 0; x < PW; x++) {
            const i = y * PW + x, dx = fx ? PW - 1 - x : x;
            diff[dy * PW + dx] += Lg[P + i] - Lg[i];
          }
        }
        if (out[m.output].dispose) out[m.output].dispose();
        onRun(++done, total);
      }
    }
    const k = 1 / (flips.length * models.length);
    for (let y = 0; y < PH; y++) {
      const row = (ty + y) * Wp + tx, grow = y * PW;
      for (let x = 0; x < PW; x++) { const g = G[grow + x]; acc[row + x] += diff[grow + x] * k * g; wsum[row + x] += g; }
    }
  }
  for (let y = 0; y < ch; y++) {
    const src = (y + pt) * Wp + pl, dst = (y + y0) * w + x0;
    for (let x = 0; x < cw; x++) if (acc[src + x] / wsum[src + x] > 0) bw[dst + x] = 1;
  }
  return bw;
}

// ---------------------------------------------------------------- one DICOM -> annotator units

async function bitmapToGray(bitmap) {
  const w = bitmap.width, h = bitmap.height;
  const c = new OffscreenCanvas(w, h), ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  const rgba = ctx.getImageData(0, 0, w, h).data, gray = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) gray[i] = rgba[j];
  return gray;
}
const decodeOpts = {
  jpegBaselineDecode: async (bytes) => bitmapToGray(await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), { colorSpaceConversion: 'none' })),
};

async function processDicom({ id, file, crop, minip, mirror, keys, skipUnits }) {
  cancelled = false;
  const models = keys.map((k) => sessions.get(k));
  if (!models.length || models.some((m) => !m)) throw new Error('Model not loaded yet');
  const t0 = performance.now();
  const d = await L.decodeDicom(await file.arrayBuffer(), decodeOpts);
  const W = d.cols, H = d.rows;
  const grays = d.frames.map((f) => L.windowTo8bit(f, d.wc, d.ww));
  const minipGray = L.windowTo8bit(L.minOverFrames(d.frames), d.wc, d.ww);
  const decoded = d.frames.length;
  d.frames.length = 0;
  // one crop box per DICOM: the box of its MinIP (pixels > 0 in every frame), so all its units share one size
  const box = crop ? L.positiveBox(minipGray, W, H) : null;
  const ow = box ? box[3] - box[2] : W, oh = box ? box[1] - box[0] : H;
  const cut = (g) => (box ? L.cropGray(g, W, box) : g);
  const items = grays.map((g, i) => ({ name: `f_${i + 1}`, gray: cut(g) }));
  if (minip && grays.length > 1) items.push({ name: 'minip', gray: cut(minipGray) });
  const skip = new Set(skipUnits || []);
  post({ type: 'caseinfo', id, count: items.length, units: items.map((it) => it.name), w: ow, h: oh, srcW: W, srcH: H, box,
    tsName: d.tsName, framesHeader: d.info.nFramesHeader, framesDecoded: decoded });
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (skip.has(it.name)) { post({ type: 'skipped', id, name: it.name, index: i, count: items.length }); items[i] = null; continue; }
    const tu = performance.now();
    const bw = await segmentGray(it.gray, ow, oh, mirror, models,
      (done, total) => post({ type: 'run', id, index: i, count: items.length, done, total }));
    const { label, skel, chains } = L.partition(bw, oh, ow);
    let seg, warning = '';
    try { seg = L.segmentMetrics(label, bw, skel, chains, oh, ow, { nearestSite: L.nearestSite }); }
    catch (e) { seg = L.segmentMetrics(label, bw, skel, chains, oh, ow, { nearestSite: L.nearestSite, checkSteps: false }); warning = e.message; }
    let vessel = 0; for (let k = 0; k < bw.length; k++) vessel += bw[k];
    const geometry = L.geometryJson(seg, L.defaultFilter(seg));
    const framesPng = await L.encodeGrayPng(it.gray, ow, oh);
    const maskNpy = L.npyBytes(bw, '|u1', oh, ow);
    const labelNpy = L.npyBytes(label, '<u2', oh, ow);
    post({ type: 'unit', id, name: it.name, index: i, count: items.length, w: ow, h: oh, framesPng, maskNpy, labelNpy, geometry,
      segments: Object.keys(seg).length, vessel, seconds: (performance.now() - tu) / 1000, warning, gray: it.gray, label },
      [framesPng.buffer, maskNpy.buffer, labelNpy.buffer, it.gray.buffer, label.buffer]);
    items[i] = null;
  }
  post({ type: 'done', id, ms: performance.now() - t0 });
}

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'cancel') { cancelled = true; if (download) download.abort(); return; }
  if (m.type === 'load') cancelled = false;          // a Stop from before this request belonged to an earlier one
  try {
    await libsReady;
    if (m.type === 'load') await load(m);
    else if (m.type === 'process') await processDicom(m);
  } catch (err) {
    const msg = (err && err.message) || String(err);
    post({ type: msg === 'cancelled' ? 'cancelled' : 'error', id: m.id, message: msg });
  }
};
