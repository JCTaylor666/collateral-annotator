// loupe.js — inspect-mode data layer + drawing helpers.
// Holds a per-(case,unit) grayscale cache for neighbor frames (loaded lazily via
// Loader.loadGray) and pure canvas drawers for the magnified tiles + cross-frame
// intensity curve. Records nothing; touches no annotation state.
(function (root) {
  'use strict';

  const grayCache = new Map();   // key -> { W, H, gray }
  const inflight = new Map();    // key -> Promise
  const failed = new Set();      // key
  let epoch = 0;                 // dataset generation; bumped on reset()
  const readyCbs = [];

  function reset() { grayCache.clear(); inflight.clear(); failed.clear(); epoch++; }
  function onReady(fn) { readyCbs.push(fn); }
  function fireReady() { for (const fn of readyCbs) { try { fn(); } catch (e) { } } }

  // Lazily ensure a unit's gray is cached. Fire-and-forget from event handlers —
  // never await this on a mousemove. Late results from a stale dataset are dropped.
  function ensure(key, unit) {
    if (grayCache.has(key) || failed.has(key)) return inflight.get(key) || Promise.resolve();
    if (inflight.has(key)) return inflight.get(key);
    const myEpoch = epoch;
    const p = root.Loader.loadGray(unit).then(g => {
      inflight.delete(key);
      if (myEpoch !== epoch) return;      // dataset changed while loading — discard
      grayCache.set(key, g);
      fireReady();
    }).catch(() => {
      inflight.delete(key);
      if (myEpoch === epoch) failed.add(key);
    });
    inflight.set(key, p);
    return p;
  }

  function get(key) { return grayCache.get(key) || null; }
  function state(key) {
    if (grayCache.has(key)) return 'ok';
    if (failed.has(key)) return 'error';
    return 'loading';
  }

  // Windowing LUT — same math as canvas.js buildLut.
  function buildLut(C, Wd) {
    const lo = C - Wd / 2, lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) { const o = Math.round((v - lo) / Wd * 255); lut[v] = o < 0 ? 0 : o > 255 ? 255 : o; }
    return lut;
  }

  // Draw an S×S source-pixel crop centered on (cx,cy) into a fixed-size canvas.
  // Integer block fill in device pixels (no drawImage scaling) => crisp on Retina.
  // st: 'ok' | 'loading' | 'mismatch' | 'error'. g = { W, H, gray } when st==='ok'.
  function drawTile(canvas, g, cx, cy, S, lut, st) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 92, cssH = canvas.clientHeight || 92;
    const DW = Math.max(1, Math.round(cssW * dpr)), DH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== DW) canvas.width = DW;
    if (canvas.height !== DH) canvas.height = DH;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, DW, DH);
    if (st !== 'ok' || !g) {
      ctx.fillStyle = '#2b2f36'; ctx.fillRect(0, 0, DW, DH);
      ctx.fillStyle = '#9aa4b2'; ctx.font = Math.round(11 * dpr) + 'px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(st === 'mismatch' ? window.I18n.t('loupeMismatch') : st === 'error' ? '×' : window.I18n.t('loupeLoading'), DW / 2, DH / 2);
      return;
    }
    const gray = g.gray, W = g.W, H = g.H, OUT = 58;
    const half = (S - 1) / 2;
    const x0 = Math.round(cx - half), y0 = Math.round(cy - half);
    for (let j = 0; j < S; j++) {
      const py0 = Math.floor(j * DH / S), py1 = Math.floor((j + 1) * DH / S), sy = y0 + j;
      for (let i = 0; i < S; i++) {
        const px0 = Math.floor(i * DW / S), px1 = Math.floor((i + 1) * DW / S), sx = x0 + i;
        const col = (sx < 0 || sy < 0 || sx >= W || sy >= H) ? OUT : lut[gray[sy * W + sx]];
        ctx.fillStyle = 'rgb(' + col + ',' + col + ',' + col + ')';
        ctx.fillRect(px0, py0, px1 - px0, py1 - py0);
      }
    }
    // crosshair on the center source pixel (the one under the cursor)
    const ci = cx - x0, cj = cy - y0;
    const cpx0 = Math.floor(ci * DW / S), cpx1 = Math.floor((ci + 1) * DW / S);
    const cpy0 = Math.floor(cj * DH / S), cpy1 = Math.floor((cj + 1) * DH / S);
    const mx = (cpx0 + cpx1) / 2, my = (cpy0 + cpy1) / 2;
    ctx.strokeStyle = 'rgba(245,133,24,0.95)'; ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(cpx0 + 0.5, cpy0 + 0.5, (cpx1 - cpx0) - 1, (cpy1 - cpy0) - 1);
    ctx.globalAlpha = 0.3; ctx.beginPath();
    ctx.moveTo(mx, 0); ctx.lineTo(mx, DH); ctx.moveTo(0, my); ctx.lineTo(DW, my); ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // points: [{ val:number|null, label:string, isMinip:bool }]. curIdx = current unit.
  function drawCurve(canvas, points, curIdx) {
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth || 280, cssH = canvas.clientHeight || 120;
    const DW = Math.max(1, Math.round(cssW * dpr)), DH = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== DW) canvas.width = DW;
    if (canvas.height !== DH) canvas.height = DH;
    const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    const padL = 26, padR = 8, padT = 8, padB = 18;
    const x0 = padL, x1 = cssW - padR, y0 = padT, y1 = cssH - padB, n = points.length;
    const vx = i => n <= 1 ? (x0 + x1) / 2 : x0 + (x1 - x0) * i / (n - 1);
    const vy = v => y1 - (y1 - y0) * (v / 255);
    // y grid + labels
    ctx.strokeStyle = 'rgba(0,0,0,0.12)'; ctx.fillStyle = '#6b7280'; ctx.font = '10px sans-serif'; ctx.lineWidth = 1;
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    [0, 128, 255].forEach(v => { const y = vy(v); ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke(); ctx.fillText(String(v), x0 - 3, y); });
    // minip dashed separators
    points.forEach((p, i) => {
      if (p.isMinip && i > 0) {
        ctx.save(); ctx.setLineDash([3, 3]); ctx.strokeStyle = 'rgba(0,0,0,0.25)';
        const xm = (vx(i - 1) + vx(i)) / 2; ctx.beginPath(); ctx.moveTo(xm, y0); ctx.lineTo(xm, y1); ctx.stroke(); ctx.restore();
      }
    });
    // polyline through non-null points, broken at gaps
    ctx.strokeStyle = '#3b7dd8'; ctx.lineWidth = 1.5; ctx.beginPath(); let pen = false;
    points.forEach((p, i) => { if (p.val == null) { pen = false; return; } const X = vx(i), Y = vy(p.val); if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y); });
    ctx.stroke();
    // markers
    points.forEach((p, i) => {
      const X = vx(i);
      if (p.val == null) { ctx.strokeStyle = 'rgba(107,114,128,0.6)'; ctx.beginPath(); ctx.arc(X, (y0 + y1) / 2, 2, 0, 6.29); ctx.stroke(); return; }
      const Y = vy(p.val);
      if (p.isMinip) { ctx.fillStyle = '#7c3aed'; ctx.fillRect(X - 2.5, Y - 2.5, 5, 5); }
      else { ctx.fillStyle = '#3b7dd8'; ctx.beginPath(); ctx.arc(X, Y, 2.2, 0, 6.29); ctx.fill(); }
    });
    // current unit highlight
    if (curIdx >= 0 && curIdx < n) {
      const X = vx(curIdx); ctx.strokeStyle = 'rgba(39,174,96,0.9)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(X, y0); ctx.lineTo(X, y1); ctx.stroke();
      const cp = points[curIdx];
      if (cp && cp.val != null) {
        const Y = vy(cp.val); ctx.fillStyle = '#166534'; ctx.beginPath(); ctx.arc(X, Y, 3.2, 0, 6.29); ctx.fill();
        ctx.font = '11px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.fillText(String(cp.val), X, Y - 4);
      }
    }
    // x labels (unit ids), sparse when many
    ctx.fillStyle = '#6b7280'; ctx.font = '9px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const step = n > 8 ? Math.ceil(n / 8) : 1;
    points.forEach((p, i) => { if (i % step === 0 || i === curIdx) ctx.fillText(p.label.replace('frame_', 'f'), vx(i), y1 + 3); });
  }

  root.Loupe = { reset, ensure, get, state, onReady, buildLut, drawTile, drawCurve };
})(typeof window !== 'undefined' ? window : globalThis);
