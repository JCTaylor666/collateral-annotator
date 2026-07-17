// perfusion.js — arrival-time colour map from a raw DSA frame series (no mask, no labels).
// In DSA, contrast darkens vessels, so a pixel's darkest frame = its peak-contrast (arrival) time.
// We colour each pixel by that time (jet: early=blue … late=red) and keep only pixels that
// darkened meaningfully (contrast amplitude above a threshold), so the background stays dark and
// the perfused vessel tree shows coloured by flow timing — the same idea as a colour-coded DSA.
(function (root) {
  'use strict';

  // jet colormap: t in [0,1] -> [r,g,b] 0..255
  function jet(t) {
    const c = x => x < 0 ? 0 : x > 1 ? 1 : x;
    return [Math.round(c(1.5 - Math.abs(4 * t - 3)) * 255),
            Math.round(c(1.5 - Math.abs(4 * t - 2)) * 255),
            Math.round(c(1.5 - Math.abs(4 * t - 1)) * 255)];
  }

  // ---- stage 1: analyze the raw series into per-pixel arrival-time fields (the EXPENSIVE pass — needs
  // every frame's gray; cache the result per case so the smoothness slider can re-render for free). ----
  // grays: array of Uint8Array(W*H), one per frame in time order. Returns { W,H,frames,tstar,amp,thresh } or null.
  function analyze(grays, W, H) {
    const T = grays.length, N = W * H;
    if (T < 2 || !N) return null;
    for (const g of grays) if (!g || g.length !== N) return null;   // all frames must share dimensions
    const tstar = new Uint16Array(N), amp = new Uint16Array(N);
    let maxAmp = 0;
    for (let i = 0; i < N; i++) {
      let mn = 255, mx = 0, ti = 0;
      for (let t = 0; t < T; t++) { const v = grays[t][i]; if (v < mn) { mn = v; ti = t; } if (v > mx) mx = v; }
      const a = mx - mn; amp[i] = a; tstar[i] = ti; if (a > maxAmp) maxAmp = a;
    }
    const thresh = Math.max(15, maxAmp * 0.15);   // ignore pixels that barely change (background/noise)
    return { W, H, frames: T, tstar, amp, thresh, maxAmp };
  }

  // separable box blur (sliding-window sum, O(N) per pass, clamped at borders). src -> dst.
  function boxH(src, dst, W, H, r) {
    for (let y = 0; y < H; y++) {
      const row = y * W; let sum = 0;
      for (let x = 0; x <= r && x < W; x++) sum += src[row + x];
      for (let x = 0; x < W; x++) {
        dst[row + x] = sum;
        const add = x + r + 1, sub = x - r;
        if (add < W) sum += src[row + add];
        if (sub >= 0) sum -= src[row + sub];
      }
    }
  }
  function boxV(src, dst, W, H, r) {
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let y = 0; y <= r && y < H; y++) sum += src[y * W + x];
      for (let y = 0; y < H; y++) {
        dst[y * W + x] = sum;
        const add = y + r + 1, sub = y - r;
        if (add < H) sum += src[(add) * W + x];
        if (sub >= 0) sum -= src[(sub) * W + x];
      }
    }
  }
  // Masked, amplitude-weighted spatial smoothing of the arrival-time field. Only vessel pixels
  // (amp>=thresh) contribute, weighted by their contrast amplitude (stronger contrast = more reliable
  // arrival estimate); background contributes weight 0, so timing never bleeds into or out of the mask
  // (normalized convolution: result = blur(t*w) / blur(w)). `iters` box passes ≈ a Gaussian.
  function smoothArrival(fields, radius, iters) {
    const { W, H, tstar, amp, thresh } = fields, N = W * H;
    const num = new Float32Array(N), den = new Float32Array(N), tmpA = new Float32Array(N), tmpB = new Float32Array(N);
    for (let i = 0; i < N; i++) { const w = amp[i] >= thresh ? amp[i] : 0; num[i] = tstar[i] * w; den[i] = w; }
    for (let it = 0; it < iters; it++) {
      boxH(num, tmpA, W, H, radius); boxV(tmpA, num, W, H, radius);
      boxH(den, tmpB, W, H, radius); boxV(tmpB, den, W, H, radius);
    }
    const out = new Float32Array(N);
    for (let i = 0; i < N; i++) out[i] = den[i] > 0 ? num[i] / den[i] : tstar[i];
    return out;
  }

  // ---- stage 2: colour the (optionally smoothed) arrival-time field. CHEAP + pure — re-run on slider
  // change without re-reading frames. radius 0 == the original per-pixel argmin colouring, byte-identical. ----
  function render(fields, radius) {
    if (!fields) return null;
    const { W, H, tstar, amp, thresh, frames } = fields, N = W * H;
    const r = Math.max(0, Math.min(64, radius | 0));
    const arr = r > 0 ? smoothArrival(fields, r, 2) : null;   // null => use the integer tstar (exact original)
    const denom = frames > 1 ? (frames - 1) : 1;
    const rgba = new Uint8ClampedArray(N * 4);
    for (let i = 0; i < N; i++) {
      const p = i * 4;
      if (amp[i] < thresh) { rgba[p] = rgba[p + 1] = rgba[p + 2] = 12; rgba[p + 3] = 255; continue; }   // dark background (mask UNCHANGED by smoothing)
      const col = jet((arr ? arr[i] : tstar[i]) / denom);
      rgba[p] = col[0]; rgba[p + 1] = col[1]; rgba[p + 2] = col[2]; rgba[p + 3] = 255;
    }
    let canvas = null;
    if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      canvas.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    }
    return { W, H, rgba, canvas, frames, smooth: r };
  }

  // one-shot convenience (analyze + colour at a given smoothness; default 0). Kept for existing callers/tests.
  function compute(grays, W, H, radius) { return render(analyze(grays, W, H), radius || 0); }

  root.Perfusion = { analyze, render, compute, jet };
})(typeof window !== 'undefined' ? window : globalThis);
