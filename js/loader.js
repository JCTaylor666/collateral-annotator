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
    if (parsed.data.length !== W * H) throw new Error(unit.id + ': label.npy is truncated (' + parsed.data.length + ' values, expected ' + (W * H) + ')');

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

    // mask.npy is optional; but distinguish absent (fine) from present-but-broken (warn + no onmask constraint)
    let mask = null, maskBad = false;
    try {
      const mH = await unit.handle.getFileHandle('mask.npy');
      try {
        const mp = root.NPY.parseNpy(await (await mH.getFile()).arrayBuffer());
        if (mp.shape.length === 2 && mp.shape[0] === H && mp.shape[1] === W && mp.data.length === W * H) mask = mp.data;
        else maskBad = true;
      } catch (pe) { maskBad = true; }
    } catch (e) { /* mask.npy absent — fine */ }

    const a = await readAnnotation(unit);
    const n = await readNote(unit);
    return { W, H, img, url, label: parsed.data, mask, maskBad, annotation: a.annotation, annCorrupt: a.corrupt, note: n.note };
  }

  // read annotation.json, distinguishing absent (annotation:null, corrupt:false) from
  // present-but-unparseable (annotation:null, corrupt:true) so a bad file is never mistaken
  // for "unannotated" and silently overwritten.
  async function readAnnotation(unit) {
    let fh;
    try { fh = await unit.handle.getFileHandle('annotation.json'); }
    catch (e) { return { annotation: null, corrupt: false }; }   // absent
    try { return { annotation: JSON.parse(await (await fh.getFile()).text()), corrupt: false }; }
    catch (e) { return { annotation: null, corrupt: true }; }    // present but broken
  }
  async function readNote(unit) {
    try { const h = await unit.handle.getFileHandle('note.json'); return { note: JSON.parse(await (await h.getFile()).text()) }; }
    catch (e) { return { note: null }; }
  }

  // light re-read of just the mutable per-unit files (annotation.json + note.json) — no image decode
  async function loadAnnotation(unit) {
    const a = await readAnnotation(unit), n = await readNote(unit);
    return { annotation: a.annotation, annCorrupt: a.corrupt, note: n.note };
  }

  // read the dataset-level class definitions from classes.json at the root.
  // { list, ok }: ok=false means the file EXISTS but is unparseable/wrong-shaped — callers must
  // NOT auto-regenerate it (that would replace the user's class names with placeholders).
  async function loadClasses(rootHandle) {
    let fh;
    try { fh = await rootHandle.getFileHandle('classes.json'); }
    catch (e) { return { list: [], ok: true }; }   // absent — a fresh dataset, fine to create later
    try {
      const o = JSON.parse(await (await fh.getFile()).text());
      if (!o || !Array.isArray(o.classes)) return { list: [], ok: false };
      const list = o.classes
        .map(c => ({ index: Number(c.index), name: c.name }))          // coerce string indices ("1") written by other tools
        .filter(c => Number.isFinite(c.index))
        .map(c => ({ index: c.index, name: String(c.name || window.I18n.t('classFallbackName', { idx: c.index })) }));
      return { list, ok: true };
    } catch (e) { return { list: [], ok: false }; }   // present but broken
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
