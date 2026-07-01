// state.js — per-(case,unit) selection sets, undo, localStorage, coord_order,
// and building/parsing annotation.json. Selections are stored internally as [x,y].
(function (root) {
  'use strict';
  const LSKEY = 'vessel_annotator_v1';
  // selection value = { xy:[x,y], cls:classIndex|null }. Old data may be a bare [x,y] — normalized on read.
  let selections = {}, visited = {}, coordOrder = 'xy', undoStack = [];
  let points = {};   // caseUnit -> [[x,y], ...] : background clicks (no segment), shown as red dots
  let notes = {};    // caseUnit -> note text (mirrors note.txt on disk)
  let win = { center: 128, width: 255 };
  let loupe = { zoom: 6, R: 3, mean: false };
  let autoSave = true;
  let classColors = {};     // classIndex -> hex (UI only, not in annotation.json)
  let activeClass = null;   // active class index for new clicks (null = unclassified)

  const key = (c, u) => c + '/' + u;
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const segXY = v => Array.isArray(v) ? v : (v && v.xy) || [-1, -1];
  const segCls = v => (Array.isArray(v) || !v || v.cls == null) ? null : v.cls;
  function persist() { try { localStorage.setItem(LSKEY, JSON.stringify({ selections, visited, points, notes, coordOrder, window: win, loupe, autoSave, classColors, activeClass })); } catch (e) { } }
  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(LSKEY) || 'null');
      if (o) {
        selections = o.selections || {}; visited = o.visited || {}; points = o.points || {}; notes = o.notes || {};
        coordOrder = o.coordOrder === 'yx' ? 'yx' : 'xy';
        if (o.window && Number.isFinite(o.window.center) && Number.isFinite(o.window.width)) win = { center: o.window.center, width: o.window.width };
        if (o.loupe && Number.isFinite(o.loupe.zoom) && Number.isFinite(o.loupe.R))
          loupe = { zoom: clamp(o.loupe.zoom, 2, 16), R: clamp(o.loupe.R, 1, 6), mean: !!o.loupe.mean };
        if (typeof o.autoSave === 'boolean') autoSave = o.autoSave;
        if (o.classColors && typeof o.classColors === 'object') classColors = o.classColors;
        if (Number.isFinite(o.activeClass)) activeClass = o.activeClass;
      }
    } catch (e) { }
  }

  const getCoordOrder = () => coordOrder;
  function setCoordOrder(o) { coordOrder = (o === 'yx') ? 'yx' : 'xy'; persist(); }
  const getWindow = () => ({ center: win.center, width: win.width });
  function setWindow(C, W) { win = { center: C, width: W }; persist(); }
  const getLoupe = () => ({ zoom: loupe.zoom, R: loupe.R, mean: loupe.mean });
  function setLoupe(zoom, R, mean) { loupe = { zoom: clamp(zoom, 2, 16), R: clamp(R, 1, 6), mean: !!mean }; persist(); }
  const getAutoSave = () => autoSave;
  function setAutoSave(b) { autoSave = !!b; persist(); }

  const sel = (c, u) => selections[key(c, u)] || (selections[key(c, u)] = {});
  const pts = (c, u) => points[key(c, u)] || (points[key(c, u)] = []);
  const hasLocal = (c, u) => (key(c, u) in selections) || (key(c, u) in points);
  const selectedIds = (c, u) => Object.keys(sel(c, u)).map(Number).sort((a, b) => a - b);
  const count = (c, u) => Object.keys(sel(c, u)).length;
  // click coords of selected segments (for red dots); skip any without a real coord
  const selectedClicks = (c, u) => { const s = sel(c, u); return Object.keys(s).map(k => segXY(s[k])).filter(xy => xy && xy[0] >= 0 && xy[1] >= 0); };
  // selected segments with their class (for per-class coloring)
  const selectedSegs = (c, u) => { const s = sel(c, u); return Object.keys(s).map(k => ({ seg: +k, cls: segCls(s[k]), xy: segXY(s[k]) })); };
  const pointList = (c, u) => pts(c, u).map(p => [p[0], p[1]]);
  const pointCount = (c, u) => pts(c, u).length;
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

  // assign the active class to a segment: unassigned -> add; same class -> remove; other class -> reassign
  function applyClass(c, u, seg, clickXY, cls) {
    const s = sel(c, u), ks = String(seg), prev = (ks in s) ? s[ks] : null;
    if (prev !== null && segCls(prev) === (cls == null ? null : cls)) { delete s[ks]; }
    else { s[ks] = { xy: [clickXY[0], clickXY[1]], cls: cls == null ? null : cls }; }
    undoStack.push({ kind: 'seg', c, u, ks, prev });
    persist();
  }
  function addPoint(c, u, xy) { pts(c, u).push([xy[0], xy[1]]); undoStack.push({ kind: 'point', c, u, op: 'add' }); persist(); }
  function removePoint(c, u, index) { const a = pts(c, u); if (index < 0 || index >= a.length) return; const xy = a.splice(index, 1)[0]; undoStack.push({ kind: 'point', c, u, op: 'remove', index, xy }); persist(); }
  function undo() {
    const e = undoStack.pop(); if (!e) return null;
    if (e.kind === 'point') {
      const a = pts(e.c, e.u);
      if (e.op === 'add') a.pop(); else a.splice(e.index, 0, e.xy);
    } else {
      const s = sel(e.c, e.u);
      if (e.prev === null) delete s[e.ks]; else s[e.ks] = e.prev;
    }
    persist(); return e;
  }
  function clearUnit(c, u) { selections[key(c, u)] = {}; points[key(c, u)] = []; undoStack = undoStack.filter(e => !(e.c === c && e.u === u)); persist(); }

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
        const id = Number(item.id); if (!Number.isFinite(id)) continue;
        const xy = (Array.isArray(item.click) && item.click.length === 2) ? conv(item.click) : [-1, -1];
        s[String(id)] = { xy, cls: Number.isFinite(item.class) ? item.class : null };
      }
    }
    if (Array.isArray(ann.points)) {
      const a = pts(c, u);
      for (const item of ann.points) {
        const click = Array.isArray(item) ? item : (item && item.click);
        if (Array.isArray(click) && click.length === 2) a.push(conv(click));
      }
    }
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
    const pointsOut = pts(c, u).map(xy => ({ click: enc(xy) }));
    return { schema_version: 3, case: c, unit: u, image_size: [W, H], coord_order: coordOrder, collaterals, points: pointsOut };
  }

  const unitsWithData = () => [...new Set([...Object.keys(selections), ...Object.keys(visited), ...Object.keys(points), ...Object.keys(notes)])];

  root.State = { load, getCoordOrder, setCoordOrder, getWindow, setWindow, getLoupe, setLoupe, getAutoSave, setAutoSave, hasLocal, selectedIds, count,
    selectedClicks, selectedSegs, pointList, pointCount, markCount, applyClass, addPoint, removePoint, undo,
    getActiveClass, setActiveClass, getClassColor, setClassColor, hasNote, getNote, setNote, importNote,
    clearUnit, markVisited, isVisited, importAnnotation, buildAnnotation, unitsWithData, key };
})(typeof window !== 'undefined' ? window : globalThis);
