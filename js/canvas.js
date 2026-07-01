// canvas.js — draw a unit's image + 50px ruler + selection/hover highlights,
// and map pointer events to image pixels (origin top-left, x=col, y=row).
(function (root) {
  'use strict';

  const EMPTY = new Int32Array(0);
  const SEL_RGB = [39, 174, 96];     // selected segments (green)
  const HOV_RGB = [245, 133, 24];    // hovered segment (orange)
  const MASK_RGB = [28, 176, 246];   // vessel mask overlay (bright blue)
  const RULER = '#3b7dd8';

  function createView(canvas) {
    const ctx = canvas.getContext('2d');
    let img = null, W = 0, H = 0, label = null;
    // live affine: screen = scale*image + off. fitScale = fit-to-viewport; needFit
    // re-fits on next layout (set when image dims change). User pan/zoom mutate scale/off.
    let scale = 1, offX = 0, offY = 0, fitScale = 1, needFit = true;
    let sel = new Set(), hov = 0, opacity = 0.55;
    let maskData = null, maskOpacity = 0.45;
    let dots = [];   // recorded click coords [x,y] to mark with red dots
    let gray = null, center = 128, width = 255;
    let segPix = null;
    const selCv = document.createElement('canvas'), selCtx = selCv.getContext('2d');
    const hovCv = document.createElement('canvas'), hovCtx = hovCv.getContext('2d');
    const maskCv = document.createElement('canvas'), maskCtx = maskCv.getContext('2d');
    const baseCv = document.createElement('canvas'), baseCtx = baseCv.getContext('2d', { willReadFrequently: true });

    function setUnit(image, w, h, lab, maskArr) {
      if (w !== W || h !== H) needFit = true;   // re-fit only when dimensions change; else keep zoom/pan across frames
      img = image; W = w; H = h; label = lab; maskData = maskArr || null; hov = 0;
      selCv.width = hovCv.width = maskCv.width = baseCv.width = W;
      selCv.height = hovCv.height = maskCv.height = baseCv.height = H;
      baseCtx.drawImage(image, 0, 0, W, H);
      const raw = baseCtx.getImageData(0, 0, W, H).data;
      gray = new Uint8Array(W * H);
      for (let i = 0; i < gray.length; i++) gray[i] = raw[i * 4];
      buildSegPix(); buildSelLayer(); buildMaskLayer(); buildBase(); hovCtx.clearRect(0, 0, W, H);
    }
    function buildLut(C, Wd) {
      const lo = C - Wd / 2, lut = new Uint8Array(256);
      for (let v = 0; v < 256; v++) { const o = Math.round((v - lo) / Wd * 255); lut[v] = o < 0 ? 0 : o > 255 ? 255 : o; }
      return lut;
    }
    function buildBase() {
      if (!gray) return;
      const lut = buildLut(center, width), id = baseCtx.createImageData(W, H), d = id.data;
      for (let i = 0; i < gray.length; i++) { const v = lut[gray[i]], p = i * 4; d[p] = d[p + 1] = d[p + 2] = v; d[p + 3] = 255; }
      baseCtx.putImageData(id, 0, 0);
    }
    function buildSegPix() {
      const counts = new Map();
      for (let i = 0; i < label.length; i++) { const v = label[i]; if (v) counts.set(v, (counts.get(v) || 0) + 1); }
      segPix = new Map(); const cur = new Map();
      for (const [v, c] of counts) { segPix.set(v, new Int32Array(c)); cur.set(v, 0); }
      for (let i = 0; i < label.length; i++) { const v = label[i]; if (v) { const a = segPix.get(v); a[cur.get(v)] = i; cur.set(v, cur.get(v) + 1); } }
    }
    function segPixels(seg) { return (segPix && segPix.get(seg)) || EMPTY; }
    function paint(cx, pixels, rgb) {
      const id = cx.createImageData(W, H), d = id.data;
      for (let k = 0; k < pixels.length; k++) { const p = pixels[k] * 4; d[p] = rgb[0]; d[p + 1] = rgb[1]; d[p + 2] = rgb[2]; d[p + 3] = 255; }
      cx.putImageData(id, 0, 0);
    }
    function buildSelLayer() {
      selCtx.clearRect(0, 0, W, H);
      const id = selCtx.createImageData(W, H), d = id.data;
      for (const seg of sel) { const px = segPixels(seg); for (let k = 0; k < px.length; k++) { const p = px[k] * 4; d[p] = SEL_RGB[0]; d[p + 1] = SEL_RGB[1]; d[p + 2] = SEL_RGB[2]; d[p + 3] = 255; } }
      selCtx.putImageData(id, 0, 0);
    }
    function buildHovLayer() { hovCtx.clearRect(0, 0, W, H); if (hov) paint(hovCtx, segPixels(hov), HOV_RGB); }
    function buildMaskLayer() {
      maskCtx.clearRect(0, 0, W, H);
      if (!maskData) return;
      const id = maskCtx.createImageData(W, H), d = id.data;
      for (let i = 0; i < maskData.length; i++) { if (maskData[i]) { const p = i * 4; d[p] = MASK_RGB[0]; d[p + 1] = MASK_RGB[1]; d[p + 2] = MASK_RGB[2]; d[p + 3] = 255; } }
      maskCtx.putImageData(id, 0, 0);
    }

    function setSelected(s) { sel = s; if (W) buildSelLayer(); }
    function setHovered(seg) { if (seg === hov) return false; hov = seg; buildHovLayer(); return true; }
    function setOpacity(o) { opacity = o; }
    function setMaskOpacity(o) { maskOpacity = o; }
    function setWindow(C, Wd) { center = C; width = Wd; if (gray) buildBase(); }
    function getWindow() { return { center, width }; }
    function autoWindow() {
      if (!gray) return { center, width };
      const hist = new Uint32Array(256);
      for (let i = 0; i < gray.length; i++) hist[gray[i]]++;
      const n = gray.length, loT = n * 0.02, hiT = n * 0.98;
      let acc = 0, lo = 0, hi = 255;
      for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= loT) { lo = v; break; } }
      acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= hiT) { hi = v; break; } }
      if (hi <= lo) { lo = 0; hi = 255; }
      width = Math.max(1, hi - lo); center = Math.round((lo + hi) / 2);
      buildBase(); return { center, width };
    }

    function computeFit() { fitScale = Math.min(canvas.clientWidth / W, canvas.clientHeight / H); }
    const minScale = () => fitScale;                       // never zoom out past fit
    const maxScale = () => Math.max(fitScale * 16, 24);
    function clampPan() {                                   // keep image filling / centered in viewport
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight, iw = W * scale, ih = H * scale;
      offX = iw <= cssW ? (cssW - iw) / 2 : Math.min(0, Math.max(cssW - iw, offX));
      offY = ih <= cssH ? (cssH - ih) / 2 : Math.min(0, Math.max(cssH - ih, offY));
    }
    function layout() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!W || !H) return;
      computeFit();
      if (needFit) { scale = fitScale; needFit = false; }
      else scale = Math.max(minScale(), Math.min(maxScale(), scale));  // keep zoom sane across resize
      clampPan();
    }
    function fitView() { computeFit(); scale = fitScale; clampPan(); }
    function zoomAt(cx, cy, factor) {                       // zoom toward viewport point (cx,cy)
      const ns = Math.max(minScale(), Math.min(maxScale(), scale * factor));
      if (ns === scale) return;
      const ix = (cx - offX) / scale, iy = (cy - offY) / scale;
      scale = ns; offX = cx - ix * scale; offY = cy - iy * scale; clampPan();
    }
    function panBy(dx, dy) { offX += dx; offY += dy; clampPan(); }
    const getZoom = () => (fitScale ? scale / fitScale : 1);  // 1.0 = fit
    function render() {
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      ctx.clearRect(0, 0, cssW, cssH);
      if (!img) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(baseCv, offX, offY, W * scale, H * scale);
      if (maskData && maskOpacity > 0) { ctx.globalAlpha = maskOpacity; ctx.drawImage(maskCv, offX, offY, W * scale, H * scale); }
      ctx.globalAlpha = opacity; ctx.drawImage(selCv, offX, offY, W * scale, H * scale);
      ctx.globalAlpha = Math.min(1, opacity + 0.25); ctx.drawImage(hovCv, offX, offY, W * scale, H * scale);
      ctx.globalAlpha = 1;
      drawRuler(cssW, cssH);
      drawDots();
    }
    function drawDots() {
      if (!dots.length) return;
      ctx.save();
      ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.fillStyle = '#e5484d';
      for (let i = 0; i < dots.length; i++) {
        const sx = offX + (dots[i][0] + 0.5) * scale, sy = offY + (dots[i][1] + 0.5) * scale;
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 6.29); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    }
    function drawRuler() {
      ctx.save();
      ctx.font = '10px sans-serif'; ctx.fillStyle = RULER; ctx.strokeStyle = RULER;
      ctx.lineWidth = 1; ctx.textBaseline = 'top';
      const x1 = offX + W * scale, y1 = offY + H * scale;
      for (let x = 0; x <= W; x += 50) {
        const cx = offX + x * scale, major = (x % 100 === 0);
        ctx.globalAlpha = major ? 0.85 : 0.35;
        ctx.beginPath(); ctx.moveTo(cx, offY); ctx.lineTo(cx, offY + (major ? 8 : 4)); ctx.stroke();
        if (major) { ctx.textAlign = 'left'; ctx.fillText(String(x), cx + 2, offY + 1); }
      }
      for (let y = 0; y <= H; y += 50) {
        const cy = offY + y * scale, major = (y % 100 === 0);
        ctx.globalAlpha = major ? 0.85 : 0.35;
        ctx.beginPath(); ctx.moveTo(offX, cy); ctx.lineTo(offX + (major ? 8 : 4), cy); ctx.stroke();
        if (major) { ctx.textAlign = 'left'; ctx.fillText(String(y), offX + 2, cy + 1); }
      }
      ctx.globalAlpha = 0.5; ctx.strokeRect(offX, offY, W * scale, H * scale);
      ctx.restore();
    }
    function eventToImage(ev) {
      const rect = canvas.getBoundingClientRect();
      return [Math.floor((ev.clientX - rect.left - offX) / scale),
              Math.floor((ev.clientY - rect.top - offY) / scale)];
    }
    function inBounds(x, y) { return x >= 0 && y >= 0 && x < W && y < H; }
    function segAt(x, y) { return inBounds(x, y) ? label[y * W + x] : 0; }
    function segSize(seg) { return segPixels(seg).length; }
    function setDots(arr) { dots = arr || []; }
    function imageToScreen(ix, iy) { return [offX + ix * scale, offY + iy * scale]; }  // canvas-relative CSS px
    // Live grayscale of the CURRENT unit. Callers must use it immediately and never
    // store it — setUnit reallocates gray on every unit switch.
    function getGray() { return { gray, W, H }; }

    return { setUnit, setSelected, setHovered, setOpacity, setMaskOpacity, setWindow, getWindow, autoWindow,
             layout, render, eventToImage, segAt, segSize, inBounds, getGray,
             fitView, zoomAt, panBy, getZoom, setDots, imageToScreen,
             get W() { return W; }, get H() { return H; } };
  }

  root.CanvasView = { create: createView };
})(typeof window !== 'undefined' ? window : globalThis);
