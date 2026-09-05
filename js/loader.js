// loader.js — discover cases/units under a picked directory handle and read a unit.
(function (root) {
  'use strict';

  let grayCanvas = null; // reused offscreen canvas for loadGray

  // A case/frame folder is any name that carries a number: pure digits, a trailing `_<digits>`,
  // or a leading `<digits>_`. The rest of the name doesn't matter — the number drives ordering.
  // (Matches e.g. case_0001, frame_3, 0001_patient, minip is handled separately.)
  function folderNum(name) {
    const m = name.match(/^(\d+)$/) || name.match(/_(\d+)$/) || name.match(/^(\d+)_/);
    return m ? parseInt(m[1], 10) : null;
  }

  // sp-10: the root listing is one stream, but each CASE folder's listing used to run strictly after
  // the previous one — 328 sequential directory reads before the first frame could show, and on Google
  // Drive every one is a network round-trip. The per-case listings now run through an 8-wide pool; the
  // result (order, filtering, sorting) is byte-identical to the serial version.
  async function discover(rootHandle) {
    const dirs = [];
    for await (const [name, handle] of rootHandle.entries()) {
      if (handle.kind !== 'directory' || name.startsWith('.')) continue;
      const cnum = folderNum(name);
      if (cnum === null) continue;                            // not a numbered case folder — ignore
      dirs.push({ name, handle, cnum });
    }
    const cases = new Array(dirs.length); let next = 0;
    const worker = async () => {
      while (next < dirs.length) {
        const i = next++, d = dirs[i];
        const units = [];
        for await (const [uname, uhandle] of d.handle.entries()) {
          if (uhandle.kind !== 'directory' || uname.startsWith('.')) continue;
          const isMinip = uname === 'minip';
          const unum = folderNum(uname);
          if (!isMinip && unum === null) continue;            // not a numbered frame folder (nor minip) — ignore
          units.push({ id: uname, kind: isMinip ? 'minip' : 'frame',
                       order: isMinip ? Infinity : unum, handle: uhandle });
        }
        units.sort((a, b) => a.order - b.order);
        cases[i] = units.length ? { id: d.name, num: d.cnum, handle: d.handle, units } : null;
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, dirs.length)) }, worker));
    const out = cases.filter(Boolean);
    out.sort((a, b) => a.num - b.num);
    return out;
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
      im.onload = () => { URL.revokeObjectURL(url); resolve(im); };      // decoded — free the blob URL (no per-frame leak)
      im.onerror = () => { URL.revokeObjectURL(url); reject(new Error(unit.id + ': failed to load frames.png')); };
      im.src = url;
    });
    const imgW = img.naturalWidth, imgH = img.naturalHeight;

    // mask.npy is optional. Read its shape (if present) so we can apply it as the overlay when it
    // matches, and report it in the mismatch panel otherwise. Distinguish absent / present-good /
    // present-wrong-shape / present-unreadable.
    let mask = null, maskShape = null, maskPresent = false, maskUnreadable = false;
    try {
      const mH = await unit.handle.getFileHandle('mask.npy');
      maskPresent = true;
      try {
        const mp = root.NPY.parseNpy(await (await mH.getFile()).arrayBuffer());
        maskShape = mp.shape.slice();
        if (mp.shape.length === 2 && mp.shape[0] === H && mp.shape[1] === W && mp.data.length === W * H) mask = mp.data;
        // non-2-D, or data shorter than the header claims (truncated) → the shape can't be trusted; flag it
        // as unreadable so the mismatch panel shows "unreadable" (✗) instead of a false matching-shape ✓.
        else if (mp.shape.length !== 2 || mp.data.length !== mp.shape.reduce((a, b) => a * b, 1)) maskUnreadable = true;
      } catch (pe) { maskUnreadable = true; }
    } catch (e) { /* mask.npy absent — fine */ }

    // Shape contract: frames.png, label.npy, and mask.npy (IF present) must all be the same H×W.
    // If any disagree, don't hard-fail the whole frame — return a placeholder descriptor so the UI can
    // show a grey panel listing the three shapes for diagnosis (view-only, never annotated or saved).
    const imgOk = (imgW === W && imgH === H);
    // Decision 4.6-A: an UNREADABLE mask.npy (corrupt / truncated / not 2-D) no longer turns the whole
    // frame into a read-only placeholder — the frame loads normally with mask=null (overlay and the
    // brush's foreground-only limit are simply off) and maskBad makes app.js say why. Only a PARSEABLE
    // mask with the WRONG SHAPE still fails the shape contract below (image/label/mask must agree).
    const maskOk = !maskPresent || mask !== null || maskUnreadable;
    if (!imgOk || !maskOk) {
      return {                                                 // (blob URL already revoked on decode)
        shapeMismatch: true,
        W, H,                                                 // nominal (label) grid — used only as the placeholder's cur size
        imgShape: [imgW, imgH],                               // W × H
        labelShape: [W, H],                                   // W × H
        maskPresent, maskUnreadable,
        maskShape: (maskShape && maskShape.length === 2) ? [maskShape[1], maskShape[0]] : maskShape,  // -> W × H when 2-D
      };
    }

    const a = await readAnnotation(unit);
    const n = await readNote(unit);
    const geometry = await readGeometry(unit);
    return { W, H, img, label: parsed.data, mask, maskBad: maskUnreadable, annotation: a.annotation, annCorrupt: a.corrupt, noteCorrupt: !!n.corrupt, versionAhead: a.versionAhead || 0,
             annDropped: a.dropped || 0, annUnreadable: !!(a.unreadable || n.unreadable), annMtime: a.mtime || 0, note: n.note, geometry };
  }

  // read annotation.json, distinguishing absent (annotation:null, corrupt:false) from
  // present-but-unparseable (annotation:null, corrupt:true) so a bad file is never mistaken
  // for "unannotated" and silently overwritten. A file from a NEWER schema than this build
  // understands (schema_version > 6) is treated the same way: importing it as v5/v6 would
  // misread it, and the corrupt path backs the original up before any overwrite.
  // THREE outcomes must stay distinguishable, because "absent" is the only one that may be seeded as an
  // empty annotation (and later overwritten):
  //   absent      -> { annotation:null, corrupt:false }               nothing was ever saved for this frame
  //   unreadable  -> { annotation:null, unreadable:true }             the file EXISTS but could not be read
  //                                                                   (permission withdrawn, Drive/File-Provider
  //                                                                   hiccup, I/O error) — callers must NOT reset
  //                                                                   State from it and must NOT write over it
  //   corrupt     -> { annotation:null, corrupt:true }                present, readable, but not usable JSON
  // `dropped` counts layer entries this build cannot represent (see State.annotationDropped): the file is
  // readable and mostly usable, but saving it back would SHRINK it, so callers back it up like a corrupt one.
  async function readAnnotation(unit) {
    let fh;
    try { fh = await unit.handle.getFileHandle('annotation.json'); }
    catch (e) {
      if (e && e.name === 'NotFoundError') return { annotation: null, corrupt: false, dropped: 0, mtime: 0 };   // truly absent
      return { annotation: null, corrupt: false, unreadable: true, dropped: 0, mtime: 0 };                      // every OTHER error means "exists, but we could not look at it"
    }
    let file, text;
    try { file = await fh.getFile(); text = await file.text(); }
    catch (e) { return { annotation: null, corrupt: false, unreadable: true, dropped: 0, mtime: 0 }; }
    const mtime = file.lastModified || 0;   // when the file was last WRITTEN — lets open-time reconciliation spot a stale localStorage dirty flag
    let ann;
    try { ann = JSON.parse(text); }
    catch (e) { return { annotation: null, corrupt: true, dropped: 0, mtime }; }   // read fine, but it is not JSON — the real "corrupt"
    // A1: a schema_version newer than this build is NOT "corrupt" — it is a healthy file from a newer
    // app. Classified separately so the app can make the frame read-only instead of letting the
    // corrupt path back it up and then OVERWRITE it with a downgraded rewrite.
    if (ann && typeof ann === 'object' && Number(ann.schema_version) > 6) return { annotation: null, versionAhead: Number(ann.schema_version), corrupt: false, dropped: 0, mtime };
    const dropped = (root.State && root.State.annotationDropped) ? root.State.annotationDropped(ann) : 0;
    return { annotation: ann, corrupt: false, dropped, mtime };
  }
  async function readNote(unit) {
    let fh;
    try { fh = await unit.handle.getFileHandle('note.json'); }
    catch (e) { return (e && e.name === 'NotFoundError') ? { note: null } : { note: null, unreadable: true }; }   // absent vs. present-but-unreachable
    let text;
    try { text = await (await fh.getFile()).text(); }
    catch (e) { return { note: null, unreadable: true }; }
    try { return { note: JSON.parse(text) }; }
    catch (e) { return { note: null, corrupt: true }; }   // present but not JSON: flagged so the app backs the original up to note.json.corrupt before any write replaces it (A2)
  }
  // Optional geometry.json: per-segment named metrics that drive the stats + filter UI.
  // { segments: { "<segId>": { "<metric>": <number>, ... } }, filter?: {metric,min,max} }.
  // Legacy form { metric, segments:{ "<segId>": <number> } } is still accepted (one metric).
  // Absent/broken -> null (feature off). Normalizes to { metrics:[names], values:{name:{segId:num}}, filter, raw }.
  async function readGeometry(unit) {
    let o;
    try { const h = await unit.handle.getFileHandle('geometry.json'); o = JSON.parse(await (await h.getFile()).text()); }
    catch (e) { return null; }                                  // absent or unparseable — feature simply off
    if (!o || typeof o.segments !== 'object' || !o.segments) return null;
    // Metric names and segment ids come straight from an untrusted file. With a plain {}, values['__proto__']
    // resolves to Object.prototype, so the assignment below writes numeric properties onto Object.prototype for
    // the WHOLE page: every frame then believes those segments carry a metric value (the geometry filter hides
    // them and they can no longer be clicked), a second such key throws ("Cannot create property on number") and
    // makes the frame unopenable, and a key like 'class' makes state.js read a class for marks that never had
    // one — which the next save writes to disk.
    const DANGEROUS = k => k === '__proto__' || k === 'constructor' || k === 'prototype';
    const values = Object.create(null), metrics = [];
    const add = (name, id, raw) => {
      if (DANGEROUS(name) || DANGEROUS(id)) return;                     // never let a file-supplied key reach Object.prototype
      if (raw == null || raw === '') return;   // B2: "no measurement" is NOT "measurement = 0" — Number(null) is 0, which made the filter hide (and un-click) the segment. No value => never filtered.
      const v = Number(raw); if (!Number.isFinite(v)) return;
      if (!values[name]) { values[name] = Object.create(null); metrics.push(name); }
      values[name][id] = v;
    };
    for (const id in o.segments) {
      const sv = o.segments[id];
      if (sv && typeof sv === 'object') { for (const m in sv) add(m, id, sv[m]); }   // { radius:.., length:.. }
      else add(String(o.metric || 'value'), id, sv);                                  // legacy: bare number
    }
    if (!metrics.length) return null;
    let filter = null;                                        // the reviewer's saved window (written back on slider change)
    if (o.filter && Number.isFinite(Number(o.filter.min)) && Number.isFinite(Number(o.filter.max))) {
      filter = { metric: o.filter.metric != null ? String(o.filter.metric) : null, min: Number(o.filter.min), max: Number(o.filter.max) };
    }
    return { metrics, values, filter, raw: o };
  }

  // light re-read of just the mutable per-unit files (annotation.json + note.json) — no image decode
  async function loadAnnotation(unit) {
    const a = await readAnnotation(unit), n = await readNote(unit);
    return { annotation: a.annotation, annCorrupt: a.corrupt, annDropped: a.dropped || 0, versionAhead: a.versionAhead || 0,
             unreadable: !!(a.unreadable || n.unreadable), note: n.note, noteCorrupt: !!n.corrupt, mtime: a.mtime || 0 };
  }

  // read the dataset-level class definitions from classes.json at the root.
  // { list, ok, dropped, raw }:
  //   ok=false     the file EXISTS but is unparseable/wrong-shaped — callers must NOT auto-regenerate it
  //                (that would replace the user's class names with placeholders).
  //   dropped>0    it parsed, but N entries carry no usable `index` and were discarded. REVIEW FIX F1:
  //                these used to vanish inside .filter() while ok stayed TRUE, and app.js computes its
  //                "is this file trustworthy?" check from the POST-filter list — so it could never see
  //                them. A pipeline writing "id" instead of "index" (or index:"one", or one entry missing
  //                it) therefore looked like a perfectly healthy file, the background scan invented
  //                Unnamed-xxxx names for the indices it found on disk, and saveClasses OVERWROTE the real
  //                vocabulary with no backup and no confirmation. Report them so the caller can refuse.
  //   raw          the parsed object as it was on disk. REVIEW FIX UI-2: saveClasses rebuilt the file from
  //                a lossy {index,name} model, dropping schema_version/dataset/generated_by and every
  //                per-class color/abbrev/description. readGeometry keeps `raw` for exactly this reason.
  //   absent       -> { list: [], ok: true } (a fresh dataset, fine to create later). A present-but-
  //                unreadable file is NOT absent: only NotFoundError takes that path.
  async function loadClasses(rootHandle) {
    let fh;
    try { fh = await rootHandle.getFileHandle('classes.json'); }
    catch (e) { return (e && e.name === 'NotFoundError') ? { list: [], ok: true } : { list: [], ok: false }; }
    try {
      const o = JSON.parse(await (await fh.getFile()).text());
      if (!o || !Array.isArray(o.classes)) return { list: [], ok: false };
      let dropped = 0;
      const list = [];
      for (const c of o.classes) {
        const idx = Number(c && c.index);
        if (!Number.isFinite(idx)) { dropped++; continue; }             // coerces string indices ("1") written by other tools
        list.push({ index: idx, name: String((c && c.name) || window.I18n.t('classFallbackName', { idx })) });
      }
      return { list, ok: true, dropped, raw: o };
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

  // Light read of ONLY mask.npy (perfusion minip-mask filter): no PNG decode, no label parse.
  // Returns { W, H, mask } or null (absent / unreadable / non-2D / truncated).
  async function loadMask(unit) {
    try {
      const mH = await unit.handle.getFileHandle('mask.npy');
      const mp = root.NPY.parseNpy(await (await mH.getFile()).arrayBuffer());
      if (mp.shape.length !== 2 || mp.data.length !== mp.shape[0] * mp.shape[1]) return null;
      return { W: mp.shape[1], H: mp.shape[0], mask: mp.data };
    } catch (e) { return null; }
  }

  root.Loader = { discover, loadUnit, loadAnnotation, loadGray, loadClasses, loadMask };
})(typeof window !== 'undefined' ? window : globalThis);
