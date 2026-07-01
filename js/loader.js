// loader.js — discover cases/units under a picked directory handle and read a unit.
(function (root) {
  'use strict';

  const CASE_RE = /^case_\d+$/;
  const FRAME_RE = /^frame_(\d+)$/;
  let grayCanvas = null; // reused offscreen canvas for loadGray

  async function discover(rootHandle) {
    const cases = [];
    for await (const [name, handle] of rootHandle.entries()) {
      if (handle.kind !== 'directory' || name.startsWith('.') || !CASE_RE.test(name)) continue;
      const units = [];
      for await (const [uname, uhandle] of handle.entries()) {
        if (uhandle.kind !== 'directory' || uname.startsWith('.')) continue;
        const fm = uname.match(FRAME_RE);
        const isMinip = uname === 'minip';
        if (!fm && !isMinip) continue;
        units.push({ id: uname, kind: isMinip ? 'minip' : 'frame',
                     order: isMinip ? Infinity : parseInt(fm[1], 10), handle: uhandle });
      }
      units.sort((a, b) => a.order - b.order);
      if (units.length) cases.push({ id: name, num: parseInt(name.slice(5), 10), handle, units });
    }
    cases.sort((a, b) => a.num - b.num);
    return cases;
  }

  // Reads frames.png (as a decoded Image), label.npy (Uint16), and annotation.json if present.
  async function loadUnit(unit) {
    const pngH = await unit.handle.getFileHandle('frames.png');
    const labH = await unit.handle.getFileHandle('label.npy');

    const labBuf = await (await labH.getFile()).arrayBuffer();
    const parsed = root.NPY.parseNpy(labBuf);
    if (parsed.shape.length !== 2) throw new Error(unit.id + ': label.npy is not 2-D');
    const [H, W] = parsed.shape;

    const pngFile = await pngH.getFile();
    const url = URL.createObjectURL(pngFile);
    const img = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(unit.id + ': failed to load frames.png'));
      im.src = url;
    });
    // transpose / mismatch guard (square data would hide an x/y swap otherwise)
    if (img.naturalWidth !== W || img.naturalHeight !== H) {
      URL.revokeObjectURL(url);
      throw new Error(`${unit.id}: image ${img.naturalWidth}x${img.naturalHeight} != label ${W}x${H} (W=shape[1],H=shape[0])`);
    }

    let mask = null;
    try {
      const mH = await unit.handle.getFileHandle('mask.npy');
      const mp = root.NPY.parseNpy(await (await mH.getFile()).arrayBuffer());
      if (mp.shape.length === 2 && mp.shape[0] === H && mp.shape[1] === W) mask = mp.data;
    } catch (e) { /* no mask.npy */ }

    let annotation = null;
    try {
      const annH = await unit.handle.getFileHandle('annotation.json');
      annotation = JSON.parse(await (await annH.getFile()).text());
    } catch (e) { /* not annotated yet */ }

    let note = null;
    try {
      const nH = await unit.handle.getFileHandle('note.txt');
      note = await (await nH.getFile()).text();
    } catch (e) { /* no note yet */ }

    return { W, H, img, url, label: parsed.data, mask, annotation, note };
  }

  // light re-read of just the mutable per-unit files (annotation.json + note.txt) — no image decode
  async function loadAnnotation(unit) {
    let annotation = null, note = null;
    try { const h = await unit.handle.getFileHandle('annotation.json'); annotation = JSON.parse(await (await h.getFile()).text()); } catch (e) { }
    try { const h = await unit.handle.getFileHandle('note.txt'); note = await (await h.getFile()).text(); } catch (e) { }
    return { annotation, note };
  }

  // read the dataset-level class definitions from classes.json at the root (or [] if none)
  async function loadClasses(rootHandle) {
    try {
      const fh = await rootHandle.getFileHandle('classes.json');
      const o = JSON.parse(await (await fh.getFile()).text());
      if (o && Array.isArray(o.classes))
        return o.classes.filter(c => Number.isFinite(c.index)).map(c => ({ index: c.index, name: String(c.name || ('类别 ' + c.index)) }));
    } catch (e) { /* no classes.json */ }
    return [];
  }

  // Lightweight read for the inspect loupe: only frames.png -> grayscale (R channel).
  // No npy, no annotation. Returns { W, H, gray:Uint8Array(W*H) }.
  async function loadGray(unit) {
    const pngH = await unit.handle.getFileHandle('frames.png');
    const file = await pngH.getFile();
    const url = URL.createObjectURL(file);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(unit.id + ': failed to load frames.png'));
        im.src = url;
      });
      const W = img.naturalWidth, H = img.naturalHeight;
      const cv = grayCanvas || (grayCanvas = document.createElement('canvas'));
      cv.width = W; cv.height = H;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, W, H);
      const raw = cx.getImageData(0, 0, W, H).data;
      const gray = new Uint8Array(W * H);
      for (let i = 0; i < gray.length; i++) gray[i] = raw[i * 4];
      return { W, H, gray };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  root.Loader = { discover, loadUnit, loadAnnotation, loadGray, loadClasses };
})(typeof window !== 'undefined' ? window : globalThis);
