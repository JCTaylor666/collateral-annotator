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

  // grays: array of Uint8Array(W*H), one per frame in time order. Returns { W, H, rgba, canvas } or null.
  function compute(grays, W, H) {
    const T = grays.length, N = W * H;
    if (T < 2 || !N) return null;
    for (const g of grays) if (!g || g.length !== N) return null;   // all frames must share dimensions

    const tstar = new Uint16Array(N), amp = new Uint16Array(N);
    let globalMaxAmp = 0;
    for (let i = 0; i < N; i++) {
      let mn = 255, mx = 0, ti = 0;
      for (let t = 0; t < T; t++) { const v = grays[t][i]; if (v < mn) { mn = v; ti = t; } if (v > mx) mx = v; }
      const a = mx - mn; amp[i] = a; tstar[i] = ti; if (a > globalMaxAmp) globalMaxAmp = a;
    }
    const thresh = Math.max(15, globalMaxAmp * 0.15);   // ignore pixels that barely change (background/noise)

    const rgba = new Uint8ClampedArray(N * 4);
    const denom = T > 1 ? (T - 1) : 1;
    for (let i = 0; i < N; i++) {
      const p = i * 4;
      if (amp[i] < thresh) { rgba[p] = rgba[p + 1] = rgba[p + 2] = 12; rgba[p + 3] = 255; continue; }   // dark background
      const col = jet(tstar[i] / denom);
      rgba[p] = col[0]; rgba[p + 1] = col[1]; rgba[p + 2] = col[2]; rgba[p + 3] = 255;
    }

    let canvas = null;
    if (typeof document !== 'undefined') {
      canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
      canvas.getContext('2d').putImageData(new ImageData(rgba, W, H), 0, 0);
    }
    return { W, H, rgba, canvas, frames: T };
  }

  root.Perfusion = { compute, jet };
})(typeof window !== 'undefined' ? window : globalThis);
