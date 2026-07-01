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
    let scale = 1, offX = 0, offY = 0;
    let sel = new Set(), hov = 0, opacity = 0.55;
    let maskData = null, maskOpacity = 0.45;
    let segPix = null;
    const selCv = document.createElement('canvas'), selCtx = selCv.getContext('2d');
    const hovCv = document.createElement('canvas'), hovCtx = hovCv.getContext('2d');
    const maskCv = document.createElement('canvas'), maskCtx = maskCv.getContext('2d');

    function setUnit(image, w, h, lab, maskArr) {
      img = image; W = w; H = h; label = lab; maskData = maskArr || null; hov = 0;
      selCv.width = hovCv.width = maskCv.width = W; selCv.height = hovCv.height = maskCv.height = H;
      buildSegPix(); buildSelLayer(); buildMaskLayer(); hovCtx.clearRect(0, 0, W, H);
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

    function layout() {
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!W || !H) return;
      scale = Math.min(cssW / W, cssH / H);
      offX = (cssW - W * scale) / 2; offY = (cssH - H * scale) / 2;
    }
    function render() {
      const cssW = canvas.clientWidth, cssH = canvas.clientHeight;
      ctx.clearRect(0, 0, cssW, cssH);
      if (!img) return;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, offX, offY, W * scale, H * scale);
      if (maskData && maskOpacity > 0) { ctx.globalAlpha = maskOpacity; ctx.drawImage(maskCv, offX, offY, W * scale, H * scale); }
      ctx.globalAlpha = opacity; ctx.drawImage(selCv, offX, offY, W * scale, H * scale);
      ctx.globalAlpha = Math.min(1, opacity + 0.25); ctx.drawImage(hovCv, offX, offY, W * scale, H * scale);
      ctx.globalAlpha = 1;
      drawRuler(cssW, cssH);
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

    return { setUnit, setSelected, setHovered, setOpacity, setMaskOpacity, layout, render, eventToImage, segAt, segSize, inBounds,
             get W() { return W; }, get H() { return H; } };
  }

  root.CanvasView = { create: createView };
})(typeof window !== 'undefined' ? window : globalThis);
