// loader.js — discover cases/units under a picked directory handle and read a unit.
(function (root) {
  'use strict';

  const CASE_RE = /^case_\d+$/;
  const FRAME_RE = /^frame_(\d+)$/;

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

    let annotation = null;
    try {
      const annH = await unit.handle.getFileHandle('annotation.json');
      annotation = JSON.parse(await (await annH.getFile()).text());
    } catch (e) { /* not annotated yet */ }

    return { W, H, img, url, label: parsed.data, annotation };
  }

  root.Loader = { discover, loadUnit };
})(typeof window !== 'undefined' ? window : globalThis);
