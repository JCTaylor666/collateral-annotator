// state.js — per-(case,unit) selection sets, undo, localStorage, coord_order,
// and building/parsing annotation.json. Selections are stored internally as [x,y].
(function (root) {
  'use strict';
  const LSKEY = 'vessel_annotator_v1';
  // selection value = { xy:[x,y], cls:classIndex|null }. Old data may be a bare [x,y] — normalized on read.
  let selections = {}, visited = {}, coordOrder = 'xy', undoStack = [];
  let points = {};   // caseUnit -> [[x,y], ...] : background clicks (no segment), shown as red dots
  let notes = {};    // caseUnit -> note text (mirrors note.json on disk)
  let noteMarkers = {}; // caseUnit -> [{id, xy:[x,y]}] : numbered circle markers referenced from the note
  let dirty = {};    // caseUnit -> true : has edits not yet written to disk (persisted so unsaved work survives reload)
  let starred = {};  // caseUnit -> true : per-frame star flag (saved into annotation.json)
  let paintR = {};   // caseUnit -> RLE object (row-run-length paint mask, compact; dense never stored here)
  let tool = 'click';                                  // 'click' | 'brush' (top-level: point-select vs pixel-paint)
  let brush = { mode: 'add', radius: 6, onmask: false };
  let clickMode = 'single';                            // within the click tool: 'single' (one segment) | 'brush' (drag to select segments)
  let selBrush = { mode: 'add', radius: 8 };           // the segment-select brush: mode add/erase, radius
  let magSnap = false;                                 // single-click select: magnetic snap to nearest vessel (OFF = click exactly on the segment)
  let win = { center: 128, width: 255 };
  let loupe = { zoom: 6, R: 3, mean: false, size: 92, pinMinip: true, pinPerfusion: true };   // size = loupe tile edge in CSS px; pin* = keep minip/perfusion tiles always visible
  let autoSave = true;
  let classColors = {};     // classIndex -> hex (UI only, not in annotation.json)
  let activeClass = null;   // active class index for new clicks (null = unclassified)
  let datasetId = null;     // id of the dataset the per-unit state above belongs to (guards cross-folder leakage)
  let onPersistFail = null, quotaWarned = false;   // localStorage-full handler + one-shot latch

  const key = (c, u) => c + '/' + u;
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const segXY = v => Array.isArray(v) ? v : (v && v.xy) || [-1, -1];
  const segCls = v => (Array.isArray(v) || !v || v.cls == null) ? null : v.cls;
  function persist() {
    try { localStorage.setItem(LSKEY, JSON.stringify({ datasetId, selections, visited, points, notes, noteMarkers, dirty, starred, paint: paintR, tool, brush, clickMode, selBrush, magSnap, coordOrder, window: win, loupe, autoSave, classColors, activeClass })); quotaWarned = false; }
    catch (e) { if (e && (e.name === 'QuotaExceededError' || e.code === 22) && !quotaWarned) { quotaWarned = true; if (onPersistFail) onPersistFail(); } }
  }
  function setPersistFailHandler(fn) { onPersistFail = fn; }
  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(LSKEY) || 'null');
      if (o) {
        selections = o.selections || {}; visited = o.visited || {}; points = o.points || {}; notes = o.notes || {}; noteMarkers = o.noteMarkers || {}; dirty = o.dirty || {}; starred = o.starred || {}; paintR = o.paint || {};
        if (o.tool === 'brush' || o.tool === 'click') tool = o.tool;
        if (o.brush && typeof o.brush === 'object') brush = { mode: o.brush.mode === 'erase' ? 'erase' : 'add', radius: clamp(o.brush.radius || 6, 1, 40), onmask: !!o.brush.onmask };
        if (o.clickMode === 'brush' || o.clickMode === 'single') clickMode = o.clickMode;
        if (typeof o.magSnap === 'boolean') magSnap = o.magSnap;
        if (o.selBrush && typeof o.selBrush === 'object') selBrush = { mode: o.selBrush.mode === 'erase' ? 'erase' : 'add', radius: clamp(o.selBrush.radius || 8, 1, 40) };
        coordOrder = o.coordOrder === 'yx' ? 'yx' : 'xy';
        if (o.window && Number.isFinite(o.window.center) && Number.isFinite(o.window.width)) win = { center: o.window.center, width: o.window.width };
        if (o.loupe && Number.isFinite(o.loupe.zoom) && Number.isFinite(o.loupe.R))
          loupe = { zoom: clamp(o.loupe.zoom, 2, 16), R: clamp(o.loupe.R, 1, 6), mean: !!o.loupe.mean, size: clamp(o.loupe.size || 92, 92, 280), pinMinip: o.loupe.pinMinip !== false, pinPerfusion: o.loupe.pinPerfusion !== false };
        if (typeof o.autoSave === 'boolean') autoSave = o.autoSave;
        if (o.classColors && typeof o.classColors === 'object') classColors = o.classColors;
        if (Number.isFinite(o.activeClass)) activeClass = o.activeClass;
        if (typeof o.datasetId === 'string') datasetId = o.datasetId;
      }
    } catch (e) { }
  }
  const getDatasetId = () => datasetId;
  // Point per-unit state at a dataset. If it currently belongs to a DIFFERENT dataset, wipe it
  // first so one folder's unsaved (dirty) annotations can never render on / be written into another
  // folder that reuses the same case_N/frame_M names. Global prefs (window, loupe, colors…) are kept.
  function switchDataset(newId) {
    if (datasetId === newId) return { switched: false, hadDirty: false };
    const hadDirty = Object.keys(dirty).length > 0;
    selections = {}; visited = {}; points = {}; notes = {}; noteMarkers = {};
    dirty = {}; starred = {}; paintR = {}; undoStack.length = 0;
    datasetId = newId; persist();
    return { switched: true, hadDirty };
  }

  const getCoordOrder = () => coordOrder;
  function setCoordOrder(o) { coordOrder = (o === 'yx') ? 'yx' : 'xy'; persist(); }
  const getWindow = () => ({ center: win.center, width: win.width });
  function setWindow(C, W) { win = { center: C, width: W }; persist(); }
  const getLoupe = () => ({ zoom: loupe.zoom, R: loupe.R, mean: loupe.mean, size: loupe.size || 92, pinMinip: loupe.pinMinip !== false, pinPerfusion: loupe.pinPerfusion !== false });
  function setLoupe(zoom, R, mean, size) { loupe = { zoom: clamp(zoom, 2, 16), R: clamp(R, 1, 6), mean: !!mean, size: clamp(size || 92, 92, 280), pinMinip: loupe.pinMinip, pinPerfusion: loupe.pinPerfusion }; persist(); }
  function setLoupePins(minip, perfusion) { loupe.pinMinip = !!minip; loupe.pinPerfusion = !!perfusion; persist(); }
  const getAutoSave = () => autoSave;
  function setAutoSave(b) { autoSave = !!b; persist(); }

  const sel = (c, u) => selections[key(c, u)] || (selections[key(c, u)] = {});   // create-on-read: writers only
  const pts = (c, u) => points[key(c, u)] || (points[key(c, u)] = []);
  const selR = (c, u) => selections[key(c, u)] || {};                             // non-creating: readers, so merely displaying a frame doesn't fabricate empty entries that later get saved as empty annotation.json
  const ptsR = (c, u) => points[key(c, u)] || [];
  const hasLocal = (c, u) => (key(c, u) in selections) || (key(c, u) in points);
  const selectedIds = (c, u) => Object.keys(selR(c, u)).map(Number).sort((a, b) => a - b);
  const count = (c, u) => Object.keys(selR(c, u)).length;
  // click coords of selected segments (for red dots); skip any without a real coord
  const selectedClicks = (c, u) => { const s = selR(c, u); return Object.keys(s).map(k => segXY(s[k])).filter(xy => xy && xy[0] >= 0 && xy[1] >= 0); };
  // selected segments with their class (for per-class coloring)
  const selectedSegs = (c, u) => { const s = selR(c, u); return Object.keys(s).map(k => ({ seg: +k, cls: segCls(s[k]), xy: segXY(s[k]) })); };
  // all class indices currently assigned to any segment across every unit in memory
  const usedClasses = () => { const set = new Set(); for (const kk in selections) { const s = selections[kk]; for (const g in s) { const cl = segCls(s[g]); if (cl != null) set.add(cl); } } usedClassesInPaint().forEach(c => set.add(c)); return [...set]; };
  // background points now carry a class (the active class at click time). Old data may be a bare [x,y].
  const ptXY = p => Array.isArray(p) ? p : (p && p.xy) || [-1, -1];
  const ptCls = p => (Array.isArray(p) || !p || p.cls == null) ? null : p.cls;
  const pointList = (c, u) => ptsR(c, u).map(p => { const xy = ptXY(p); return [xy[0], xy[1]]; });   // coords, for red dots
  const pointItems = (c, u) => ptsR(c, u).map(p => ({ xy: ptXY(p), cls: ptCls(p) }));                // coords + class, for copy/json
  const pointCount = (c, u) => ptsR(c, u).length;
  const markCount = (c, u) => count(c, u) + pointCount(c, u);

  const getActiveClass = () => activeClass;
  function setActiveClass(cls) { activeClass = Number.isFinite(cls) ? cls : null; persist(); }
  const getClassColor = idx => classColors[idx] || null;
  function setClassColor(idx, hex) { classColors[idx] = hex; persist(); }
  const noteKey = (c, u) => key(c, u);
  const hasNote = (c, u) => noteKey(c, u) in notes;
  const getNote = (c, u) => notes[noteKey(c, u)] || '';
  function setNote(c, u, text) { notes[noteKey(c, u)] = text; persist(); }
  function importNote(c, u, text) { if (!hasNote(c, u) && typeof text === 'string') { notes[noteKey(c, u)] = text; persist(); } }

  // ---- note markers: numbered circles on the image, saved inside note.json ----
  const mksGet = (c, u) => noteMarkers[key(c, u)] || [];                                  // read: never creates the key
  const mksMut = (c, u) => noteMarkers[key(c, u)] || (noteMarkers[key(c, u)] = []);       // write: create-on-demand
  const markerList = (c, u) => mksGet(c, u).map(m => ({ id: m.id, xy: [m.xy[0], m.xy[1]] }));
  const nextMarkerId = (c, u) => mksGet(c, u).reduce((m, x) => Math.max(m, x.id), 0) + 1;   // ids are stable, never reused while any remain
  function addMarker(c, u, xy) {
    const a = mksMut(c, u), id = nextMarkerId(c, u);
    a.push({ id, xy: [xy[0], xy[1]] });
    undoStack.push({ kind: 'marker', c, u, op: 'add' });
    persist(); return id;
  }
  function removeMarker(c, u, id) {
    const a = mksGet(c, u), i = a.findIndex(m => m.id === id); if (i < 0) return;
    const item = a.splice(i, 1)[0];
    undoStack.push({ kind: 'marker', c, u, op: 'remove', index: i, item });
    persist();
  }
  // key-existence (not length) so deleting the LAST marker still rewrites note.json — otherwise the stale file resurrects it
  const hasNoteData = (c, u) => hasNote(c, u) || (key(c, u) in noteMarkers);
  // note.json (schema v1): { schema_version, coord_order, text, markers:[{id, click}] }
  function buildNote(c, u) {
    const enc = xy => coordOrder === 'xy' ? [xy[0], xy[1]] : [xy[1], xy[0]];
    return { schema_version: 1, coord_order: coordOrder, text: getNote(c, u), markers: mksGet(c, u).map(m => ({ id: m.id, click: enc(m.xy) })) };
  }
  function importNoteJson(c, u, o) {
    if (!o || typeof o !== 'object') return;
    if (typeof o.text === 'string') importNote(c, u, o.text);
    const k = key(c, u);
    if (!mksGet(c, u).length && Array.isArray(o.markers)) {
      const order = o.coord_order === 'yx' ? 'yx' : 'xy';
      const conv = a => order === 'xy' ? [a[0], a[1]] : [a[1], a[0]];
      const list = [];
      for (const m of o.markers) {
        const id = m && Number(m.id);
        if (m && Array.isArray(m.click) && m.click.length === 2 && Number.isFinite(id)) list.push({ id, xy: conv(m.click) });
      }
      if (list.length) noteMarkers[k] = list;
    }
    persist();
  }

  // assign the active class to a segment: unassigned -> add; same class -> remove; other class -> reassign
  function applyClass(c, u, seg, clickXY, cls) {
    const s = sel(c, u), ks = String(seg), prev = (ks in s) ? s[ks] : null;
    if (prev !== null && segCls(prev) === (cls == null ? null : cls)) { delete s[ks]; }
    else { s[ks] = { xy: [clickXY[0], clickXY[1]], cls: cls == null ? null : cls }; }
    undoStack.push({ kind: 'seg', c, u, ks, prev });
    persist();
  }
  function addPoint(c, u, xy, cls) { pts(c, u).push({ xy: [xy[0], xy[1]], cls: cls == null ? null : cls }); undoStack.push({ kind: 'point', c, u, op: 'add' }); persist(); }
  function removePoint(c, u, index) { const a = pts(c, u); if (index < 0 || index >= a.length) return; const item = a.splice(index, 1)[0]; undoStack.push({ kind: 'point', c, u, op: 'remove', index, item }); persist(); }
  function pushPaintUndo(c, u, changes) { undoStack.push({ kind: 'paint', c, u, changes }); }
  // brush-select: select (or deselect) a segment WITHOUT its own undo/persist entry — the caller
  // batches a whole drag into one undo via pushSegBatchUndo, and persists once via markDirty.
  // Returns { ks, prev } describing the change, or null if nothing changed (idempotent).
  function brushSeg(c, u, seg, xy, cls, erase) {
    const s = sel(c, u), ks = String(seg), prev = (ks in s) ? s[ks] : null;
    if (erase) {
      if (prev === null) return null;                       // already not selected
      delete s[ks];
      return { ks, prev };
    }
    const want = cls == null ? null : cls;
    if (prev !== null && segCls(prev) === want) return null; // already selected with this class
    s[ks] = { xy: [xy[0], xy[1]], cls: want };
    return { ks, prev };
  }
  function pushSegBatchUndo(c, u, changes) { if (changes && changes.length) undoStack.push({ kind: 'segbatch', c, u, changes }); }
  // brush-select ERASE also clears background red dots: remove every point inside the circle WITHOUT its
  // own undo/persist (the whole drag is batched via pushPointBatchUndo). Returns [{index,item}] desc by index.
  function removePointsInCircle(c, u, cx, cy, r) {
    const a = ptsR(c, u); if (!a.length) return [];
    const r2 = r * r, removed = [];
    for (let i = a.length - 1; i >= 0; i--) {
      const xy = ptXY(a[i]), dx = xy[0] - cx, dy = xy[1] - cy;
      if (dx * dx + dy * dy <= r2) removed.push({ index: i, item: a.splice(i, 1)[0] });
    }
    return removed;
  }
  function pushPointBatchUndo(c, u, removed) { if (removed && removed.length) undoStack.push({ kind: 'pointbatch', c, u, removed }); }
  function undo() {
    const e = undoStack.pop(); if (!e) return null;
    if (e.kind === 'point') {
      const a = pts(e.c, e.u);
      if (e.op === 'add') a.pop(); else a.splice(e.index, 0, e.item);
    } else if (e.kind === 'marker') {
      const a = mksMut(e.c, e.u);
      if (e.op === 'add') a.pop(); else a.splice(e.index, 0, e.item);
    } else if (e.kind === 'paint') {
      /* paint undo needs the view's dense array — the caller (app) applies e.changes then re-encodes */
    } else if (e.kind === 'segbatch') {
      const s = sel(e.c, e.u);
      for (const ch of e.changes) { if (ch.prev === null) delete s[ch.ks]; else s[ch.ks] = ch.prev; }
    } else if (e.kind === 'pointbatch') {
      const a = pts(e.c, e.u);
      for (let i = e.removed.length - 1; i >= 0; i--) a.splice(e.removed[i].index, 0, e.removed[i].item);   // re-insert ascending by original index
    } else {
      const s = sel(e.c, e.u);
      if (e.prev === null) delete s[e.ks]; else s[e.ks] = e.prev;
    }
    persist(); return e;
  }
  function clearUnit(c, u) { selections[key(c, u)] = {}; points[key(c, u)] = []; delete paintR[key(c, u)]; delete starred[key(c, u)]; undoStack = undoStack.filter(e => !(e.c === c && e.u === u)); persist(); }
  // wipe a unit's in-memory annotation so it can be re-seeded from disk (used for clean units on load)
  function resetUnit(c, u) { const k = key(c, u); delete selections[k]; delete points[k]; delete notes[k]; delete noteMarkers[k]; delete starred[k]; delete paintR[k]; undoStack = undoStack.filter(e => !(e.c === c && e.u === u)); persist(); }

  const isDirty = (c, u) => !!dirty[key(c, u)];
  function markDirty(c, u) { dirty[key(c, u)] = true; persist(); }
  function markClean(c, u) { delete dirty[key(c, u)]; persist(); }

  const isStarred = (c, u) => !!starred[key(c, u)];
  function setStarred(c, u, on) { if (on) starred[key(c, u)] = true; else delete starred[key(c, u)]; persist(); }
  const caseStarred = (c, unitIds) => unitIds.some(uid => !!starred[key(c, uid)]);

  const getTool = () => tool;
  function setTool(t) { tool = (t === 'brush') ? 'brush' : 'click'; persist(); }
  const getBrush = () => ({ mode: brush.mode, radius: brush.radius, onmask: brush.onmask });
  function setBrush(b) { brush = { mode: b.mode === 'erase' ? 'erase' : 'add', radius: clamp(b.radius, 1, 40), onmask: !!b.onmask }; persist(); }
  const getClickMode = () => clickMode;
  function setClickMode(m) { clickMode = (m === 'brush') ? 'brush' : 'single'; persist(); }
  const getMagSnap = () => magSnap;
  function setMagSnap(b) { magSnap = !!b; persist(); }
  const getSelBrush = () => ({ mode: selBrush.mode, radius: selBrush.radius });
  function setSelBrush(b) { selBrush = { mode: b.mode === 'erase' ? 'erase' : 'add', radius: clamp(b.radius, 1, 40) }; persist(); }

  // ---- brush paint layer: dense Uint16Array(W*H) <-> compact row-run-length (stored/serialized) ----
  // RLE run = [row, col, length]: row=y (0=top), col=x (0=left) run start, length=consecutive same-class px toward +x.
  function rleEncode(dense, W, H) {
    const classes = {};
    for (let y = 0; y < H; y++) {
      const base = y * W;
      for (let x = 0; x < W;) {
        const v = dense[base + x];
        if (!v) { x++; continue; }
        let len = 1; while (x + len < W && dense[base + x + len] === v) len++;
        (classes[v] || (classes[v] = [])).push([y, x, len]);
        x += len;
      }
    }
    return { encoding: 'rle_rows_v1', axes: 'run=[row,col,length]; row=y image row (0=top); col=x image column (0=left) of run start; length=consecutive same-class pixels toward +x. NOT flipped by coord_order.', width: W, height: H, classes };
  }
  function rleDecode(rle, W, H) {
    const dense = new Uint16Array(W * H);
    if (!rle || !rle.classes) return dense;
    for (const k in rle.classes) {
      const cls = +k; if (!cls) continue;
      const runs = rle.classes[k]; if (!Array.isArray(runs)) continue;
      for (const run of runs) {
        if (!Array.isArray(run) || run.length < 3) continue;
        const y = run[0], x = run[1], len = run[2];
        if (!(y >= 0 && y < H && x >= 0)) continue;
        const base = y * W, end = Math.min(W, x + len);
        for (let xx = Math.max(0, x); xx < end; xx++) dense[base + xx] = cls;
      }
    }
    return dense;
  }
  const hasPaint = (c, u) => { const r = paintR[key(c, u)]; return !!(r && r.classes && Object.keys(r.classes).length); };
  // decode paint for display. If the stored RLE was recorded at other dimensions (frame re-exported at a
  // new size, or annotation.json copied between differently-sized units), don't decode it into the current
  // frame's coordinate grid — that would display paint at wrong locations. Return empty; the stored RLE is
  // left untouched (buildAnnotation writes it verbatim) so a load+save can't destroy it.
  const paintDense = (c, u, W, H) => {
    const r = paintR[key(c, u)];
    if (r && (r.encoding !== 'rle_rows_v1' || (r.width && r.width !== W) || (r.height && r.height !== H))) return new Uint16Array(W * H);
    return rleDecode(r, W, H);
  };
  function setPaintDense(c, u, dense, W, H) {
    const rle = rleEncode(dense, W, H);
    if (Object.keys(rle.classes).length) paintR[key(c, u)] = rle; else delete paintR[key(c, u)];
    persist();
  }
  const usedClassesInPaint = () => { const s = new Set(); for (const kk in paintR) { const cl = paintR[kk] && paintR[kk].classes; for (const c in (cl || {})) { const n = +c; if (n) s.add(n); } } return [...s]; };

  function markVisited(c, u) { visited[key(c, u)] = true; persist(); }
  const isVisited = (c, u) => !!visited[key(c, u)];

  // seed selections + background points from a file's annotation.json (convert its coord_order to internal x,y)
  function importAnnotation(c, u, ann) {
    if (!ann) return;
    const order = ann.coord_order === 'yx' ? 'yx' : 'xy';
    const conv = arr => order === 'xy' ? [arr[0], arr[1]] : [arr[1], arr[0]];
    if (Array.isArray(ann.collaterals)) {
      const s = sel(c, u);
      for (const item of ann.collaterals) {
        if (!item || typeof item !== 'object') continue;   // a null/garbage element must not abort the whole import (and the folder open)
        const id = Number(item.id); if (!Number.isFinite(id)) continue;
        const xy = (Array.isArray(item.click) && item.click.length === 2) ? conv(item.click) : [-1, -1];
        s[String(id)] = { xy, cls: Number.isFinite(item.class) ? item.class : null };
      }
    }
    if (Array.isArray(ann.points)) {
      const a = pts(c, u);
      for (const item of ann.points) {
        const click = Array.isArray(item) ? item : (item && item.click);
        if (Array.isArray(click) && click.length === 2) a.push({ xy: conv(click), cls: (item && Number.isFinite(item.class)) ? item.class : null });
      }
    }
    if (ann.starred === true) starred[key(c, u)] = true;
    if (ann.paint && ann.paint.classes && typeof ann.paint.classes === 'object') paintR[key(c, u)] = ann.paint;
    persist();
  }

  function buildAnnotation(c, u, W, H) {
    const s = sel(c, u);
    const enc = xy => coordOrder === 'xy' ? [xy[0], xy[1]] : [xy[1], xy[0]];
    const collaterals = Object.keys(s).map(Number).sort((a, b) => a - b).map(id => {
      const v = s[String(id)], o = { id, click: enc(segXY(v)) }, cls = segCls(v);
      if (cls != null) o.class = cls;
      return o;
    });
    const pointsOut = pts(c, u).map(p => { const o = { click: enc(ptXY(p)) }; const cl = ptCls(p); if (cl != null) o.class = cl; return o; });
    const out = { schema_version: 5, case: c, unit: u, image_size: [W, H], coord_order: coordOrder, collaterals, points: pointsOut };
    if (starred[key(c, u)]) out.starred = true;
    if (paintR[key(c, u)]) out.paint = paintR[key(c, u)];
    return out;
  }

  const unitsWithData = () => [...new Set([...Object.keys(selections), ...Object.keys(visited), ...Object.keys(points), ...Object.keys(notes), ...Object.keys(noteMarkers), ...Object.keys(starred), ...Object.keys(paintR)])];
  // does this unit hold anything actually worth writing to disk? (used to skip empty, merely-viewed frames)
  function unitHasContent(c, u) {
    const k = key(c, u);
    if (selections[k] && Object.keys(selections[k]).length) return true;
    if (points[k] && points[k].length) return true;
    if (paintR[k] && paintR[k].classes && Object.keys(paintR[k].classes).length) return true;
    if (starred[k]) return true;
    if (notes[k] && notes[k].length) return true;
    if (noteMarkers[k] && noteMarkers[k].length) return true;
    return false;
  }

  root.State = { load, getCoordOrder, setCoordOrder, getWindow, setWindow, getLoupe, setLoupe, setLoupePins, getAutoSave, setAutoSave, hasLocal, selectedIds, count,
    selectedClicks, selectedSegs, usedClasses, pointList, pointItems, pointCount, markCount, applyClass, addPoint, removePoint, undo,
    getActiveClass, setActiveClass, getClassColor, setClassColor, hasNote, getNote, setNote, importNote,
    markerList, nextMarkerId, addMarker, removeMarker, hasNoteData, buildNote, importNoteJson,
    isDirty, markDirty, markClean, resetUnit, isStarred, setStarred, caseStarred,
    getTool, setTool, getBrush, setBrush, getClickMode, setClickMode, getMagSnap, setMagSnap, getSelBrush, setSelBrush, brushSeg, pushSegBatchUndo, removePointsInCircle, pushPointBatchUndo,
    hasPaint, paintDense, setPaintDense, pushPaintUndo, usedClassesInPaint,
    clearUnit, markVisited, isVisited, importAnnotation, buildAnnotation, unitsWithData, unitHasContent, key,
    getDatasetId, switchDataset, setPersistFailHandler };
})(typeof window !== 'undefined' ? window : globalThis);
