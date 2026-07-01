// state.js — per-(case,unit) selection sets, undo, localStorage, coord_order,
// and building/parsing annotation.json. Selections are stored internally as [x,y].
(function (root) {
  'use strict';
  const LSKEY = 'vessel_annotator_v1';
  let selections = {}, visited = {}, coordOrder = 'xy', undoStack = [];
  let win = { center: 128, width: 255 };

  const key = (c, u) => c + '/' + u;
  function persist() { try { localStorage.setItem(LSKEY, JSON.stringify({ selections, visited, coordOrder, window: win })); } catch (e) { } }
  function load() {
    try {
      const o = JSON.parse(localStorage.getItem(LSKEY) || 'null');
      if (o) {
        selections = o.selections || {}; visited = o.visited || {};
        coordOrder = o.coordOrder === 'yx' ? 'yx' : 'xy';
        if (o.window && Number.isFinite(o.window.center) && Number.isFinite(o.window.width)) win = { center: o.window.center, width: o.window.width };
      }
    } catch (e) { }
  }

  const getCoordOrder = () => coordOrder;
  function setCoordOrder(o) { coordOrder = (o === 'yx') ? 'yx' : 'xy'; persist(); }
  const getWindow = () => ({ center: win.center, width: win.width });
  function setWindow(C, W) { win = { center: C, width: W }; persist(); }

  const sel = (c, u) => selections[key(c, u)] || (selections[key(c, u)] = {});
  const hasLocal = (c, u) => key(c, u) in selections;
  const selectedIds = (c, u) => Object.keys(sel(c, u)).map(Number).sort((a, b) => a - b);
  const count = (c, u) => Object.keys(sel(c, u)).length;

  function toggle(c, u, seg, clickXY) {
    const s = sel(c, u), ks = String(seg);
    if (ks in s) { const prev = s[ks]; delete s[ks]; undoStack.push({ c, u, ks, prev }); }
    else { s[ks] = clickXY; undoStack.push({ c, u, ks, prev: null }); }
    persist();
  }
  function undo() {
    const e = undoStack.pop(); if (!e) return null;
    const s = sel(e.c, e.u);
    if (e.prev === null) delete s[e.ks]; else s[e.ks] = e.prev;
    persist(); return e;
  }
  function clearUnit(c, u) { selections[key(c, u)] = {}; undoStack = undoStack.filter(e => !(e.c === c && e.u === u)); persist(); }

  function markVisited(c, u) { visited[key(c, u)] = true; persist(); }
  const isVisited = (c, u) => !!visited[key(c, u)];

  // seed selections from a file's annotation.json (convert its coord_order to internal x,y)
  function importAnnotation(c, u, ann) {
    if (!ann || !Array.isArray(ann.collaterals)) return;
    const order = ann.coord_order === 'yx' ? 'yx' : 'xy';
    const s = sel(c, u);
    for (const item of ann.collaterals) {
      const id = Number(item.id); if (!Number.isFinite(id)) continue;
      let x = -1, y = -1;
      if (Array.isArray(item.click) && item.click.length === 2) {
        if (order === 'xy') { x = item.click[0]; y = item.click[1]; } else { y = item.click[0]; x = item.click[1]; }
      }
      s[String(id)] = [x, y];
    }
    persist();
  }

  function buildAnnotation(c, u, W, H) {
    const s = sel(c, u);
    const collaterals = Object.keys(s).map(Number).sort((a, b) => a - b).map(id => {
      const xy = s[String(id)];
      return { id, click: coordOrder === 'xy' ? [xy[0], xy[1]] : [xy[1], xy[0]] };
    });
    return { schema_version: 1, case: c, unit: u, image_size: [W, H], coord_order: coordOrder, collaterals };
  }

  const unitsWithData = () => [...new Set([...Object.keys(selections), ...Object.keys(visited)])];

  root.State = { load, getCoordOrder, setCoordOrder, getWindow, setWindow, hasLocal, selectedIds, count, toggle, undo,
    clearUnit, markVisited, isVisited, importAnnotation, buildAnnotation, unitsWithData, key };
})(typeof window !== 'undefined' ? window : globalThis);
