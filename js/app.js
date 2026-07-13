// app.js — wires the UI: open folder, render a unit, click-to-toggle segments,
// hover readout, navigation, save annotation.json into each unit folder.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const State = window.State, Loader = window.Loader, FS = window.FS, I18n = window.I18n;

  let rootHandle = null, cases = [], ci = 0, ui = 0;
  let view = null, cur = null, hovRAF = false;
  const cache = new Map();
  const perfCache = new Map();                 // caseId -> { W,H,rgba,canvas } | 'computing' | 'failed' (arrival-time perfusion map)
  let saveTimer = null, pendingSave = null;   // debounced auto-write-to-disk
  let classes = [];                           // dataset class defs [{index,name}] from classes.json
  let classesFileCorrupt = false;             // classes.json exists but is unparseable — don't auto-overwrite it
  const corruptUnits = new Set();             // State.key() of units whose annotation.json is present but unparseable
  const corruptBackedUp = new Set();          // …of those, the ones already copied to annotation.json.corrupt
  let copyPickMode = false;                    // true while waiting for the user to pick a frame to copy from
  const PALETTE = ['#e5484d', '#1d9e75', '#3b7dd8', '#e5a50a', '#7c3aed', '#d6409f', '#0f9b8e', '#c2410c'];
  const UNCLASSIFIED_RGB = [39, 174, 96];     // green fallback for segments with no class
  const SNAP_SCREEN_R = 14;                   // magnetic-snap reach (screen px) for single-click select
  let snapTarget = null;                      // {seg,x,y} nearest segment under the cursor (magnetic snap preview)
  let curGeom = null;                         // current unit's geometry.json ({metric,unit,segments,filter,raw}) or null
  let geomLo = 0, geomHi = 0, geomMin = 0, geomMax = 0;   // data range [lo,hi] and current filter window [min,max]
  let geomSaveTimer = null, pendingGeom = null;   // debounced write-back of the reviewer's radius window into geometry.json

  // inspect (Cmd/Ctrl loupe) state — the loupe is a side panel only; annotation
  // and hover keep working normally while inspecting.
  let inspect = false, overCanvas = false;
  let lastCX = 0, lastCY = 0, loupeRAF = false, stripSig = '';
  const tileEls = new Map();  // unit index -> { wrap, canvas, cap }
  const isInspectMod = e => e.metaKey || e.ctrlKey;

  // pan/zoom (main view) state
  let dragging = false, dragMoved = false, suppressClick = false;
  let dragSX = 0, dragSY = 0, dragLX = 0, dragLY = 0;
  const DRAG_THRESH = 4;
  let painting = false, spaceHeld = false, brushRAF = false;   // pixel-paint brush state
  // brush-select (click tool, drag to select segments) stroke state
  let selecting = false, selRAF = false, selLastX = 0, selLastY = 0;
  let selStrokeSegs = null, selChanges = null, selPaintChanges = null, selPointChanges = null;
  let markerArm = false;   // true while waiting for the user to click the image to place a note marker
  let navGen = 0;          // bumped each showUnit; a stale (slow) load must not clobber a newer navigation

  const curCase = () => cases[ci];
  const curUnit = () => curCase() && curCase().units[ui];

  let lastBanner = null;   // { key, vars, kind } | null — replayed on language switch
  function setBanner(key, vars, kind) {
    const b = $('banner');
    lastBanner = key ? { key, vars, kind } : null;
    b.textContent = key ? I18n.t(key, vars) : '';
    b.className = 'banner' + (key ? (kind ? ' ' + kind : '') : ' hidden');
  }
  // Per-unit warnings (shape mismatch / corrupt annotation / broken mask) describe ONE frame — they
  // must not linger after navigating away. Cleared at the start of every navigation; each unit that
  // still has the condition re-sets its own banner.
  function clearUnitBanner() {
    if (lastBanner && (lastBanner.key === 'shapeMismatchBanner' || lastBanner.key === 'annCorrupt' || lastBanner.key === 'maskBad')) setBanner(null);
  }

  // A stable per-dataset id lives in a hidden .annotator_dataset.json at the folder root, so
  // localStorage state can be tied to the dataset it came from (never bleed across folders that
  // reuse case_N/frame_M names). Read it; create it on first open. Best-effort: if it can't be
  // written (no permission yet), fall back to a folder-name id for this session.
  async function ensureDatasetId(root) {
    const FNAME = '.annotator_dataset.json';
    try {
      const fh = await root.getFileHandle(FNAME);
      const o = JSON.parse(await (await fh.getFile()).text());
      if (o && typeof o.id === 'string' && o.id) return o.id;
    } catch (e) { /* absent or unreadable — create below */ }
    const id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('ds-' + Date.now() + '-' + Math.floor(Math.random() * 1e9));
    try { await FS.writeText(root, FNAME, JSON.stringify({ id, created: new Date().toISOString() }, null, 2)); return id; }
    catch (e) { return 'name:' + (root.name || 'unknown'); }
  }

  async function openFolder() {
    try {
      rootHandle = await FS.pickDirectory();
      cases = await Loader.discover(rootHandle);
      if (!cases.length) { setBanner('errNoCases', null, 'warn'); return; }
      for (const c of cases) c.units.push({ id: 'perfusion', kind: 'perfusion', virtual: true });   // computed view-only unit after minip
      perfCache.clear();
      const cls = await Loader.loadClasses(rootHandle);
      classes = cls.list; classesFileCorrupt = !cls.ok;
      corruptUnits.clear(); corruptBackedUp.clear();
      const sw = State.switchDataset(await ensureDatasetId(rootHandle));   // wipe any carryover from a different dataset
      setBanner('scanningExisting');
      await scanDataset();
      ensureActiveClass();
      cache.clear(); window.Loupe.reset(); ci = 0; ui = 0; buildCaseOptions();
      buildClassMgr(); buildClassPicker();
      setBanner(null);
      const okUnit = await showUnit(0, 0);   // may set a per-unit corrupt/mask warning
      // higher-priority open-time warnings take precedence — but never clobber a load-failure banner
      if (okUnit) {
        if (classesFileCorrupt) setBanner('classesCorrupt', null, 'warn');
        else if (sw.switched && sw.hadDirty) setBanner('datasetSwitched', null, 'warn');
      }
    } catch (e) { if (e && e.name === 'AbortError') return; setBanner('errOpenFailed', { msg: e.message }, 'warn'); }
  }

  async function loadCur() {
    const c = curCase(), u = curUnit(), k = State.key(c.id, u.id);
    let data = cache.get(k);
    if (!data) { data = await Loader.loadUnit(u); cache.set(k, data); }
    else if (!data.shapeMismatch) { const fresh = await Loader.loadAnnotation(u); data.annotation = fresh.annotation; data.annCorrupt = fresh.annCorrupt; data.note = fresh.note; }
    if (data.shapeMismatch) return data;   // broken frame: no annotation state; shown as a view-only placeholder
    if (data.annCorrupt) corruptUnits.add(k); else corruptUnits.delete(k);
    // disk is the source of truth: reconcile CLEAN units from disk each load; keep unsaved (dirty) units as-is
    if (!State.isDirty(c.id, u.id)) {
      State.resetUnit(c.id, u.id);
      if (data.annotation) State.importAnnotation(c.id, u.id, data.annotation);
      if (data.note) State.importNoteJson(c.id, u.id, data.note);
    }
    return data;
  }

  // Compute (once, cached) a case's arrival-time perfusion map from its raw frame grays. No mask/labels.
  const perfInflight = new Map();   // caseId -> Promise (so concurrent callers share one computation)
  function ensureCasePerfusion(c) {
    if (!c) return Promise.resolve(null);
    const got = perfCache.get(c.id);
    if (got && got !== 'failed') return Promise.resolve(got);
    if (got === 'failed') return Promise.resolve(null);
    if (perfInflight.has(c.id)) return perfInflight.get(c.id);
    const p = (async () => {
      try {
        const frames = c.units.filter(u => u.kind === 'frame');
        if (frames.length < 2) { perfCache.set(c.id, 'failed'); return null; }
        const grays = []; let W = 0, H = 0;
        for (const u of frames) {
          const g = await Loader.loadGray(u);
          if (!W) { W = g.W; H = g.H; }
          if (g.W !== W || g.H !== H) { perfCache.set(c.id, 'failed'); return null; }   // frames must share dimensions
          grays.push(g.gray);
        }
        const perf = window.Perfusion.compute(grays, W, H);
        perfCache.set(c.id, perf || 'failed');
        if (perf && inspect) scheduleLoupe();   // a pinned perfusion tile can now render
        return perf || null;
      } catch (e) { perfCache.set(c.id, 'failed'); return null; }
      finally { perfInflight.delete(c.id); }
    })();
    perfInflight.set(c.id, p);
    return p;
  }
  const perfState = c => { const v = perfCache.get(c && c.id); return v === 'failed' ? 'error' : (v && v !== 'failed') ? 'ok' : 'loading'; };

  // commit an in-progress stroke (pixel-paint OR brush-select) to the CURRENT unit before we navigate
  // away, so its pixels/selection/undo can never be misattributed to (or lost by) the unit we switch to.
  function commitActiveStroke() {
    if (painting) {
      painting = false;
      const rec = view.strokeEnd();
      if (rec.changes.length && cur) {
        State.pushPaintUndo(cur.caseId, cur.unitId, rec.changes);
        State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H);
        State.markDirty(cur.caseId, cur.unitId);
        scheduleAutoSave();   // queue the outgoing unit; the flushAutoSave() in showUnit writes it immediately
      }
    }
    if (selecting) finalizeSelectStroke();
  }

  // brush-select: process one brush dab — select (or deselect) every segment under the circle, once per stroke
  function selDab(x, y) {
    const sb = State.getSelBrush();
    if (sb.mode === 'erase') {                              // deselect brush also sweeps up background red dots under the circle
      const rm = State.removePointsInCircle(cur.caseId, cur.unitId, x, y, sb.radius);
      if (rm.length) selPointChanges.push(...rm);
    }
    for (const [seg, xy] of view.segsInBrush(x, y, sb.radius)) {
      if (selStrokeSegs.has(seg)) continue;                 // each segment handled once per drag
      selStrokeSegs.add(seg);
      if (sb.mode === 'add' && State.hasPaint(cur.caseId, cur.unitId)) {   // paint ⟂ selection: wipe paint under a newly-selected segment
        const pc = view.clearPaintInSegment(seg);
        if (pc.length) selPaintChanges.push(...pc);
      }
      const ch = State.brushSeg(cur.caseId, cur.unitId, seg, xy, State.getActiveClass(), sb.mode === 'erase');
      if (ch) selChanges.push(ch);
    }
  }
  function finalizeSelectStroke() {
    if (!selecting) return;
    selecting = false;
    if (selPaintChanges && selPaintChanges.length) {
      State.pushPaintUndo(cur.caseId, cur.unitId, selPaintChanges);
      State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H);
    }
    if (selChanges && selChanges.length) State.pushSegBatchUndo(cur.caseId, cur.unitId, selChanges);
    if (selPointChanges && selPointChanges.length) State.pushPointBatchUndo(cur.caseId, cur.unitId, selPointChanges);
    if ((selChanges && selChanges.length) || (selPaintChanges && selPaintChanges.length) || (selPointChanges && selPointChanges.length)) {
      State.markDirty(cur.caseId, cur.unitId);
      refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
    }
    selStrokeSegs = null; selChanges = null; selPaintChanges = null; selPointChanges = null;
  }

  async function showUnit(nci, nui) {
    commitActiveStroke();     // never let a live stroke bleed onto the frame we're switching to
    exitCopyPick();           // leaving a frame cancels an in-progress copy-from-frame pick
    flushAutoSave();          // persist the outgoing unit before we move off it
    flushGeomWrite(false);    // persist the outgoing unit's radius window (if auto-save is on)
    const gen = ++navGen;     // overlapping (slow-disk) loads: only the newest navigation may apply
    const prevCi = ci, prevUi = ui;
    ci = nci; ui = nui;
    const c = curCase(), u = curUnit();
    clearUnitBanner();        // drop any stale per-unit warning from the frame we're leaving
    ensureCasePerfusion(c);   // kick off (cached) perfusion compute on entering a case, so it's ready to view / pin
    if (u.virtual) return await showPerfusionUnit(c, u, gen, prevCi, prevUi);
    let data;
    try { data = await loadCur(); }
    catch (e) {
      if (gen !== navGen) return false;          // a newer navigation superseded this one — stay silent
      ci = prevCi; ui = prevUi;                  // keep nav state matching the still-displayed unit
      setBanner('errLoadUnitFailed', { id: u.id, msg: e.message }, 'warn');
      return false;
    }
    if (gen !== navGen) return false;            // superseded while loading: drop this stale result entirely
    if (data.shapeMismatch) return showMismatchUnit(c, u, data);   // image/label/mask sizes disagree: grey placeholder
    State.markVisited(c.id, u.id);
    cur = { W: data.W, H: data.H, caseId: c.id, unitId: u.id, unit: u };
    curGeom = data.geometry || null;                          // per-segment radius (drives the geometry stats + filter panel)
    view.setUnit(data.img, data.W, data.H, data.label, data.mask);
    view.setPerfLegend(0);
    view.setSelected(selColorMap());
    view.setPaint(State.paintDense(c.id, u.id, data.W, data.H));   // load brush paint layer
    refreshDots();
    exitMarkerArm(); refreshMarkers();
    view.layout(); view.render(); updateZoomReadout();
    refreshMeta(); buildFrameList(); refreshGeomPanel();
    $('note').value = State.getNote(c.id, u.id); $('note').disabled = false;
    updateDirtyUI(); updateCopyBtn();
    if (data.annCorrupt) setBanner('annCorrupt', { id: u.id }, 'warn');       // corrupt file preserved (backed up before any overwrite)
    else if (data.maskBad) setBanner('maskBad', { id: u.id }, 'warn');        // mask present but broken: onmask constraint won't apply
    if (inspect) { stripSig = ''; preloadCase(); scheduleLoupe(); }
    return true;
  }

  // the computed, view-only perfusion unit: colour image, no label/mask/annotation
  async function showPerfusionUnit(c, u, gen, prevCi, prevUi) {
    const perf = await ensureCasePerfusion(c);
    if (gen !== navGen) return false;                       // superseded by a newer navigation
    if (!perf) { ci = prevCi; ui = prevUi; setBanner('perfFailed', null, 'warn'); return false; }
    const W = perf.W, H = perf.H;
    cur = { W, H, caseId: c.id, unitId: u.id, unit: u, virtual: true };
    curGeom = null; refreshGeomPanel();                     // perfusion unit has no geometry — hide the panel
    view.setUnit(perf.canvas, W, H, new Uint16Array(W * H), null, true);   // empty label, no mask, colour image as-is
    view.setPerfLegend(perf.frames);   // arrival-time colour legend (frame ticks)
    view.setSelected(new Map()); view.setPaint(new Uint16Array(W * H));
    view.setDots([]); view.setMarkers([]); view.setSnapPreview(0, 0, false); view.setHovered(0);
    exitMarkerArm();
    view.layout(); view.render(); updateZoomReadout();
    refreshMeta(); buildFrameList();
    $('note').value = ''; $('note').disabled = true;
    updateDirtyUI(); updateCopyBtn();
    if (inspect) { stripSig = ''; preloadCase(); scheduleLoupe(); }
    return true;
  }

  // A frame whose frames.png / label.npy / mask.npy sizes don't all agree: don't hard-fail — show a
  // grey placeholder panel listing the three shapes so the mismatch is obvious. View-only, never saved.
  function showMismatchUnit(c, u, data) {
    State.markVisited(c.id, u.id);
    u.mismatch = true;                                        // let save()/star skip it even before it's re-opened
    cur = { W: data.W || 0, H: data.H || 0, caseId: c.id, unitId: u.id, unit: u, mismatch: true };
    curGeom = null; refreshGeomPanel();                     // shape-mismatch unit has no geometry — hide the panel
    const fmt = s => Array.isArray(s) ? s.join(' × ') : String(s);
    const keyOf = s => Array.isArray(s) ? s.join('x') : null;
    // Mark each file against the MAJORITY shape (so the real odd-one-out gets the ✗, even when it's
    // the label). No majority (all three differ / only two present & unequal) -> everything is ✗.
    const parts = [
      { label: I18n.t('smImage'), shape: data.imgShape, present: true, bad: false },
      { label: I18n.t('smLabel'), shape: data.labelShape, present: true, bad: false },
      { label: I18n.t('smMask'), shape: data.maskShape, present: data.maskPresent, bad: data.maskUnreadable },
    ];
    const counts = new Map();
    for (const p of parts) { const k = p.present && !p.bad && keyOf(p.shape); if (k) counts.set(k, (counts.get(k) || 0) + 1); }
    let mode = null, best = 0;
    for (const [k, n] of counts) if (n > best) { best = n; mode = k; }
    const rows = parts.map(p => ({
      label: p.label,
      val: !p.present ? I18n.t('smNone') : p.bad ? I18n.t('smUnreadable') : fmt(p.shape),
      ok: best >= 2 && p.present && !p.bad && keyOf(p.shape) === mode,
    }));
    view.setPlaceholder({ title: u.id, subtitle: I18n.t('shapeMismatchTitle'), hint: I18n.t('shapeMismatchHint'), rows });
    view.setPerfLegend(0);
    view.setSnapPreview(0, 0, false); view.setHovered(0);
    exitMarkerArm();
    view.layout(); view.render(); updateZoomReadout();
    refreshMeta(); buildFrameList();
    $('note').value = ''; $('note').disabled = true;
    updateDirtyUI(); updateCopyBtn();
    setBanner('shapeMismatchBanner', { id: u.id }, 'warn');
    return true;
  }

  function refreshDots() {
    if (!cur) return;
    const segDots = geomActive()
      ? State.selectedSegs(cur.caseId, cur.unitId).filter(it => segVisible(it.seg) && it.xy && it.xy[0] >= 0 && it.xy[1] >= 0).map(it => it.xy)
      : State.selectedClicks(cur.caseId, cur.unitId);
    view.setDots(segDots.concat(State.pointList(cur.caseId, cur.unitId)));
  }
  function refreshCanvasSelection() {
    view.setSelected(selColorMap());
    refreshDots();
    view.render();
  }

  // ---- multiclass: colors, class management, active class ----
  function defaultColor(idx) { return PALETTE[((idx - 1) % PALETTE.length + PALETTE.length) % PALETTE.length]; }
  function classColor(cls) { return cls == null ? null : (State.getClassColor(cls) || defaultColor(cls)); }
  function hexToRgb(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
  function segRgb(cls) { const c = classColor(cls); return c ? hexToRgb(c) : UNCLASSIFIED_RGB; }
  function selColorMap() {
    const m = new Map();
    if (!cur) return m;
    for (const it of State.selectedSegs(cur.caseId, cur.unitId)) { if (segVisible(it.seg)) m.set(it.seg, segRgb(it.cls)); }
    return m;
  }

  // ---- geometry (per-segment radius) stats + filter ----
  const geomActive = () => !!(curGeom && State.getGeomFilter());
  function segRadius(seg) { const v = curGeom && curGeom.segments[String(seg)]; return typeof v === 'number' ? v : null; }
  function segVisible(seg) {                                   // filter off, or seg has no radius -> always visible
    if (!geomActive()) return true;
    const r = segRadius(seg);
    return r == null ? true : (r >= geomMin - 1e-9 && r <= geomMax + 1e-9);
  }
  function computeVisibleSegs() {                             // Set of segs to draw in the mask overlay (null = no filter)
    if (!geomActive() || !cur) return null;
    const set = new Set();
    for (const s of view.labelSegs()) if (segVisible(s)) set.add(s);
    return set;
  }
  function applyGeomFilter() {                                // push the current filter into the view + refresh dependent layers
    if (!cur || cur.virtual || cur.mismatch) { view.setVisibleSegs(null); return; }
    view.setVisibleSegs(computeVisibleSegs());
    view.setSelected(selColorMap());                          // drop green highlight of hidden selected segs
    refreshDots();                                            // drop red dots of hidden segs
    view.render();
    updateGeomCount();
  }
  const fmtN = v => (Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1));
  function updateGeomCount() {
    const el = $('geomCount'); if (!el || !curGeom || !cur) return;
    const all = view.labelSegs();
    const shown = geomActive() ? all.filter(segVisible).length : all.length;
    el.textContent = I18n.t('geomShowingFmt', { x: shown, n: all.length });
  }
  function refreshGeomPanel() {                               // show/populate the panel for the current unit (or hide it)
    const panel = $('geomPanel'); if (!panel) return;
    const has = !!(cur && !cur.virtual && !cur.mismatch && curGeom);
    let vals = [];
    if (has) { vals = view.labelSegs().map(segRadius).filter(v => v != null); }
    if (!has || !vals.length) { panel.classList.add('hidden'); curGeom = has ? curGeom : null; view.setVisibleSegs(null); return; }
    panel.classList.remove('hidden');
    geomLo = Math.min(...vals); geomHi = Math.max(...vals);
    const clampG = v => Math.max(geomLo, Math.min(geomHi, v));
    if (curGeom.filter) { geomMin = clampG(curGeom.filter.min); geomMax = Math.max(geomMin, clampG(curGeom.filter.max)); }  // restore the reviewer's saved window
    else { geomMin = geomLo; geomMax = geomHi; }             // none saved yet -> full range (min..max)
    const step = Math.max((geomHi - geomLo) / 100, 0.01);
    ['geomMin', 'geomMax'].forEach(id => { const s = $(id); s.min = geomLo; s.max = geomHi; s.step = step; });
    $('geomMin').value = geomMin; $('geomMax').value = geomMax;
    $('geomMinV').textContent = fmtN(geomMin); $('geomMaxV').textContent = fmtN(geomMax);
    $('geomEnable').checked = State.getGeomFilter();
    updateGeomStats(vals);
    applyGeomFilter();
  }
  function updateGeomStats(vals) {
    const n = vals.length, sorted = [...vals].sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / n;
    const med = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
    const u = curGeom.unit ? ' ' + curGeom.unit : '';
    $('geomStats').textContent = I18n.t('geomStatsFmt', { metric: curGeom.metric, n, min: fmtN(geomLo) + u, max: fmtN(geomHi) + u, mean: fmtN(mean) + u, med: fmtN(med) + u });
    buildGeomHistogram(sorted);
  }
  function buildGeomHistogram(sorted) {
    const host = $('geomHist'); if (!host) return;
    const BINS = 14, lo = geomLo, hi = geomHi, span = (hi - lo) || 1, counts = new Array(BINS).fill(0);
    for (const v of sorted) { let b = Math.floor((v - lo) / span * BINS); if (b >= BINS) b = BINS - 1; if (b < 0) b = 0; counts[b]++; }
    const peak = Math.max(1, ...counts);
    host.innerHTML = counts.map(c => '<i style="height:' + Math.round(c / peak * 100) + '%"></i>').join('');
  }
  function onGeomRange() {                                    // slider drag: keep min<=max, update labels, re-apply if enabled
    $('geomMinV').textContent = fmtN(geomMin); $('geomMaxV').textContent = fmtN(geomMax);
    if (State.getGeomFilter()) applyGeomFilter(); else updateGeomCount();
  }
  // Persist the reviewer's radius window back into this unit's geometry.json (segments/other fields kept).
  // Called on slider release; debounced. Range is per-unit; the on/off toggle stays a global preference.
  function scheduleGeomSave() {
    if (!curGeom || !curGeom.raw || !cur) return;
    curGeom.filter = { min: geomMin, max: geomMax };
    curGeom.raw.filter = { min: geomMin, max: geomMax };     // mutate the (cached) raw object so it round-trips in-session too
    pendingGeom = { unit: cur.unit, raw: curGeom.raw };       // remember for nav-flush / manual save
    if ($('autoSave').checked && rootHandle) {
      if (geomSaveTimer) clearTimeout(geomSaveTimer);
      geomSaveTimer = setTimeout(() => flushGeomWrite(false), 600);
    }
  }
  function flushGeomWrite(force) {
    if (geomSaveTimer) { clearTimeout(geomSaveTimer); geomSaveTimer = null; }
    const p = pendingGeom;
    if (!p || !p.unit || !p.unit.handle || !rootHandle || (!force && !$('autoSave').checked)) return;
    pendingGeom = null;
    FS.writeText(p.unit.handle, 'geometry.json', JSON.stringify(p.raw, null, 2)).catch(() => {});   // best-effort; a filter write must never block
  }
  function ensureActiveClass() {
    if (!classes.length) { State.setActiveClass(null); return; }
    if (!classes.some(c => c.index === State.getActiveClass())) State.setActiveClass(classes[0].index);
  }
  async function saveClasses() {
    if (!rootHandle) return;
    try { await FS.writeText(rootHandle, 'classes.json', JSON.stringify({ classes }, null, 2)); setSaveStatus('classesSaved', { time: hhmm() }); }
    catch (e) { setSaveStatus('classesSaveFailed', null, true); }
  }
  function randomName() { return I18n.t('unnamedPrefix') + Math.random().toString(36).slice(2, 6); }
  // every class index actually used by any annotation — in-memory (incl unsaved) + on disk across all units
  async function usedClassSet() {
    const used = new Set(State.usedClasses());
    for (const c of cases) for (const u of c.units) {
      if (u.virtual) continue;                                // perfusion unit has no files on disk
      try {
        const { annotation } = await Loader.loadAnnotation(u);
        if (annotation && Array.isArray(annotation.collaterals))
          for (const it of annotation.collaterals) if (Number.isFinite(it.class)) used.add(it.class);
        if (annotation && annotation.paint && annotation.paint.classes)
          for (const k in annotation.paint.classes) { const n = +k; if (n) used.add(n); }
      } catch (e) { }
    }
    return used;
  }
  // startup: read every unit's annotation from disk. Import clean units into memory (disk-as-truth, so frame
  // badges are accurate on open + any frame is a valid copy source); auto-add any class used but missing from meta.
  async function scanDataset() {
    const used = new Set(State.usedClasses());
    for (const c of cases) for (const u of c.units) {
      if (u.virtual) continue;                                // perfusion unit has no files on disk
      let ann = null, note = null, annCorrupt = false;
      try { const r = await Loader.loadAnnotation(u); ann = r.annotation; note = r.note; annCorrupt = r.annCorrupt; } catch (e) { }
      if (annCorrupt) corruptUnits.add(State.key(c.id, u.id));
      if (!State.isDirty(c.id, u.id)) {
        State.resetUnit(c.id, u.id);
        try { if (ann) State.importAnnotation(c.id, u.id, ann); if (note) State.importNoteJson(c.id, u.id, note); } catch (e) { }   // one malformed file must not abort the whole scan
      }
      if (ann && Array.isArray(ann.collaterals)) for (const it of ann.collaterals) if (it && Number.isFinite(it.class)) used.add(it.class);
    }
    const have = new Set(classes.map(c => c.index));
    let added = 0;
    for (const idx of [...used].sort((a, b) => a - b)) if (!have.has(idx)) { classes.push({ index: idx, name: randomName() }); added++; }
    // never auto-overwrite a classes.json that failed to parse — that would replace the user's names with placeholders
    if (added && !classesFileCorrupt) { classes.sort((a, b) => a.index - b.index); await saveClasses(); }
    else if (added) classes.sort((a, b) => a.index - b.index);
  }
  function addClass() {
    const inp = $('className'), name = inp.value.trim(); if (!name) return;
    const idx = classes.reduce((m, c) => Math.max(m, c.index), 0) + 1;
    classes.push({ index: idx, name }); inp.value = '';
    ensureActiveClass(); buildClassMgr(); buildClassPicker(); saveClasses();
  }
  function renameClass(idx, name) {
    const c = classes.find(c => c.index === idx); if (!c) return;
    c.name = name; buildClassPicker(); saveClasses();
  }
  async function deleteClass(idx) {
    const used = await usedClassSet();                                   // slow: re-reads every unit from disk
    if (used.has(idx) || State.usedClasses().includes(idx)) { setBanner('classInUse', { idx }, 'warn'); return; }   // re-check in-memory too, in case the class was assigned during the disk scan
    classes = classes.filter(c => c.index !== idx);
    ensureActiveClass(); buildClassMgr(); buildClassPicker();
    if (cur) refreshCanvasSelection();
    saveClasses();
  }
  function buildClassMgr() {
    const box = $('classMgr'); box.innerHTML = '';
    if (!classes.length) { box.innerHTML = '<div class="muted" style="font-size:12px">' + I18n.t('noClassesYetMgr') + '</div>'; return; }
    classes.forEach(c => {
      const row = document.createElement('div'); row.className = 'cls-mgr-row';
      const idx = document.createElement('span'); idx.className = 'cls-idx'; idx.textContent = c.index;
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = c.name; inp.className = 'cls-name-inp';
      inp.onchange = () => renameClass(c.index, inp.value.trim() || I18n.t('classFallbackName', { idx: c.index }));
      const del = document.createElement('button'); del.className = 'btn sm'; del.textContent = I18n.t('btnDelete');
      del.onclick = () => deleteClass(c.index);
      row.appendChild(idx); row.appendChild(inp); row.appendChild(del); box.appendChild(row);
    });
  }
  function buildClassPicker() {
    const box = $('classPicker'); box.innerHTML = '';
    if (!classes.length) { box.innerHTML = '<div class="muted" style="font-size:12px">' + I18n.t('noClassesYetPicker') + '</div>'; return; }
    const active = State.getActiveClass();
    classes.forEach(c => {
      const row = document.createElement('div'); row.className = 'cls-row' + (c.index === active ? ' active' : '');
      const color = document.createElement('input'); color.type = 'color'; color.value = classColor(c.index); color.className = 'cls-color';
      color.oninput = e => { State.setClassColor(c.index, e.target.value); if (cur) { view.setPaint(view.getPaint()); refreshCanvasSelection(); } };
      color.onclick = e => e.stopPropagation();
      const name = document.createElement('span'); name.className = 'cls-name'; name.textContent = c.index + ' · ' + c.name;
      row.appendChild(color); row.appendChild(name);
      if (c.index >= 1 && c.index <= 9) {   // keyboard shortcut: press this index to activate the class
        const key = document.createElement('span'); key.className = 'cls-key'; key.textContent = c.index; key.title = 'Hotkey ' + c.index;
        row.appendChild(key);
      }
      row.onclick = () => { State.setActiveClass(c.index); buildClassPicker(); };
      box.appendChild(row);
    });
  }
  // ---- copy annotation from another frame (re-resolved by coordinate onto the current frame) ----
  // Copy-from-frame only writes into an EMPTY target — refuse if the frame already has any content
  // (segments/points, brush paint, or numbered markers), so copied paint/selections never collide.
  function copyTargetBusy(c, u) {
    return State.markCount(c, u) > 0 || State.hasPaint(c, u) || State.markerList(c, u).length > 0;
  }
  function updateCopyBtn() {
    const b = $('btnCopyFrom'); if (!b) return;
    b.disabled = !cur || cur.virtual || cur.mismatch || copyTargetBusy(cur.caseId, cur.unitId);
    b.textContent = copyPickMode ? I18n.t('btnCancelCopy') : I18n.t('btnCopyFrom');
  }
  function enterCopyPick() {
    if (!cur || copyTargetBusy(cur.caseId, cur.unitId)) return;
    exitMarkerArm();                                        // the two click-capturing modes are mutually exclusive
    copyPickMode = true;
    $('frameList').classList.add('picking');
    document.body.classList.add('copy-picking');
    setBanner('copyPickHint');
    updateCopyBtn();
  }
  function exitCopyPick() {
    if (!copyPickMode) return;
    copyPickMode = false;
    $('frameList').classList.remove('picking');
    document.body.classList.remove('copy-picking');
    setBanner(null);
    updateCopyBtn();
  }
  function toggleCopyPick() { if (copyPickMode) exitCopyPick(); else enterCopyPick(); }
  function pickCopySource(uidx) {
    const src = curCase().units[uidx];
    exitCopyPick();   // exit FIRST so its setBanner(null) can't wipe doCopyFrom's result banner
    if (src && uidx !== ui && cur && !copyTargetBusy(cur.caseId, cur.unitId)) doCopyFrom(curCase().id, src);
  }
  function doCopyFrom(srcCaseId, srcUnit) {
    // gather source clicks (segments + background points) — each carries the class chosen when it was clicked
    const clicks = State.selectedSegs(srcCaseId, srcUnit.id).map(s => ({ xy: s.xy, cls: s.cls }))
      .concat(State.pointItems(srcCaseId, srcUnit.id));
    const srcHasPaint = State.hasPaint(srcCaseId, srcUnit.id);
    if (!clicks.length && !srcHasPaint) { setBanner('copyNoAnnotations', { id: srcUnit.id }, 'warn'); return; }
    // re-resolve EACH coordinate against the current frame's label: segment there -> class mark; background -> red dot.
    // clicks with no class are dropped.
    const segMap = new Map(), ptSeen = new Set(), pts = [];
    let dropped = 0;
    for (const { xy, cls } of clicks) {
      if (cls == null) { dropped++; continue; }
      if (!xy || !view.inBounds(xy[0], xy[1])) continue;
      const seg = view.segAt(xy[0], xy[1]);
      if (seg > 0) { if (!segMap.has(seg)) segMap.set(seg, { xy, cls }); }
      else { const k = xy[0] + ',' + xy[1]; if (!ptSeen.has(k)) { ptSeen.add(k); pts.push({ xy, cls }); } }
    }
    for (const [seg, v] of segMap) State.applyClass(cur.caseId, cur.unitId, seg, v.xy, v.cls);
    for (const p of pts) State.addPoint(cur.caseId, cur.unitId, p.xy, p.cls);
    // also copy the source brush-painted mask (paint layer). Paint is per-pixel — no coordinate
    // re-resolution is possible — so it only transfers at IDENTICAL W×H; otherwise it's skipped.
    let paintCopied = 0, paintSkipped = false;
    if (srcHasPaint) {
      const srcPaint = State.paintDense(srcCaseId, srcUnit.id, cur.W, cur.H);   // all-zero when the source was painted at a different size
      const curPaint = view.getPaint(), changes = [];
      for (let i = 0; i < srcPaint.length; i++) { const v = srcPaint[i]; if (v && curPaint[i] !== v) { changes.push([i, curPaint[i]]); curPaint[i] = v; paintCopied++; } }
      if (paintCopied) {
        view.setPaint(curPaint);
        for (const seg of segMap.keys()) { const c2 = view.clearPaintInSegment(seg); if (c2.length) changes.push(...c2); }   // keep paint ⟂ selection
        State.pushPaintUndo(cur.caseId, cur.unitId, changes);
        State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H);
      } else {
        paintSkipped = true;   // had paint but nothing landed → frames differ in size
      }
    }
    State.markDirty(cur.caseId, cur.unitId);
    refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
    const droppedTxt = dropped ? I18n.t('copyDoneDropped', { n: dropped }) : '';
    const paintTxt = paintCopied ? I18n.t('copyDonePaint', { n: paintCopied }) : (paintSkipped ? I18n.t('copyPaintSkipped') : '');
    setBanner('copyDone', { id: srcUnit.id, segs: segMap.size, pts: pts.length, dropped: droppedTxt + paintTxt }, paintSkipped ? 'warn' : 'ok');
  }

  // ---- note markers: place numbered circles from the note panel ----
  function refreshMarkers() {
    if (!cur) return;
    view.setMarkerHighlight(0);                             // never carry a chip-hover highlight across rebuilds/frames
    view.setMarkers(State.markerList(cur.caseId, cur.unitId));
    buildMarkerChips();
    if (markerArm) setBanner('markerPlaceHint', { n: State.nextMarkerId(cur.caseId, cur.unitId) });   // keep the promised number fresh
  }
  function buildMarkerChips() {
    const box = $('markerChips'); if (!box) return;
    box.innerHTML = '';
    if (!cur) return;
    for (const m of State.markerList(cur.caseId, cur.unitId)) {
      const chip = document.createElement('span'); chip.className = 'mk-chip';
      const dot = document.createElement('span'); dot.className = 'mk-dot'; dot.textContent = m.id;
      const x = document.createElement('span'); x.className = 'mk-x'; x.textContent = '×'; x.title = I18n.t('markerDelete');
      x.onclick = () => {
        State.removeMarker(cur.caseId, cur.unitId, m.id);
        view.setMarkerHighlight(0);
        State.markDirty(cur.caseId, cur.unitId);
        refreshMarkers(); view.render(); updateDirtyUI(); scheduleAutoSave();
      };
      chip.onmouseenter = () => { view.setMarkerHighlight(m.id); view.render(); };
      chip.onmouseleave = () => { view.setMarkerHighlight(0); view.render(); };
      chip.appendChild(dot); chip.appendChild(x); box.appendChild(chip);
    }
  }
  function enterMarkerArm() {
    if (!cur || cur.virtual || cur.mismatch || markerArm) return;   // perfusion / shape-mismatch units are view-only
    exitCopyPick();                                         // the two click-capturing modes are mutually exclusive
    markerArm = true;
    document.body.classList.add('marker-arming');
    setBanner('markerPlaceHint', { n: State.nextMarkerId(cur.caseId, cur.unitId) });
  }
  function exitMarkerArm() {
    if (!markerArm) return;
    markerArm = false;
    document.body.classList.remove('marker-arming');
    if (lastBanner && lastBanner.key === 'markerPlaceHint') setBanner(null);   // never eat another mode's banner
  }
  function placeMarker(ev) {   // one-shot: place at the clicked pixel, then leave arm mode
    const [x, y] = view.eventToImage(ev);
    if (!view.inBounds(x, y)) return;   // ignore letterbox clicks, stay armed
    State.addMarker(cur.caseId, cur.unitId, [x, y]);
    exitMarkerArm();
    State.markDirty(cur.caseId, cur.unitId);
    refreshMarkers(); view.render(); updateDirtyUI(); scheduleAutoSave();
  }

  function onNoteInput() { if (!cur || cur.virtual || cur.mismatch) return; State.setNote(cur.caseId, cur.unitId, $('note').value); State.markDirty(cur.caseId, cur.unitId); updateDirtyUI(); scheduleAutoSave(); }
  // download the current case's perfusion map as a PNG
  async function exportPerfusion() {
    const c = curCase(); if (!c) { setBanner('errOpenFolderFirst', null, 'warn'); return; }
    const perf = await ensureCasePerfusion(c);
    if (!perf || !perf.canvas) { setBanner('perfFailed', null, 'warn'); return; }
    perf.canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = c.id + '_perfusion.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }
  async function saveNote() {   // saves the whole current frame (annotation + note) so the dirty flag stays honest
    if (!cur || cur.virtual || cur.mismatch) return;   // view-only units have no editable files
    if (!rootHandle) { setBanner('errOpenFolderFirst', null, 'warn'); return; }
    const c = cur.caseId, u = cur.unitId, unit = curUnit();
    State.setNote(c, u, $('note').value);
    try {
      const data = cache.get(State.key(c, u)) || await Loader.loadUnit(unit);
      await FS.writeText(unit.handle, 'annotation.json', JSON.stringify(State.buildAnnotation(c, u, data.W, data.H), null, 2));
      await FS.writeText(unit.handle, 'note.json', JSON.stringify(State.buildNote(c, u), null, 2));
      State.markClean(c, u); updateDirtyUI();
      setSaveStatus('noteSaved', { time: hhmm() });
    } catch (e) { setSaveStatus('noteSaveFailed', null, true); }
  }
  function toggleRPanel() { document.body.classList.toggle('rpanel-collapsed'); onResize(); }

  function refreshMeta() {
    const c = curCase(), u = curUnit();
    $('curLabel').textContent = c.id + ' / ' + u.id + '  (' + u.kind + ')';
    $('unitIndicator').textContent = I18n.t('unitIndicatorFmt', { ui: ui + 1, uc: curCase().units.length, ci: ci + 1, cc: cases.length });
    const ids = State.selectedIds(c.id, u.id);
    $('chips').innerHTML = ids.length ? ids.map(i => '<span class="chip">' + i + '</span>').join('') : '<span class="muted">' + I18n.t('none') + '</span>';
    $('progress').textContent = I18n.t('progressFmt', { segs: ids.length, pts: State.pointCount(c.id, u.id) });
  }

  function buildCaseOptions() {
    const sel = $('caseSelect'); sel.innerHTML = '';
    cases.forEach((c, idx) => {
      const o = document.createElement('option');
      o.value = idx;
      o.textContent = c.id + (State.caseStarred(c.id, c.units.map(u => u.id)) ? ' ★' : '');
      sel.appendChild(o);
    });
  }
  async function toggleStar(uidx) {
    const c = curCase(); if (!c) return;
    const u = c.units[uidx];
    if (u.virtual || u.mismatch) return;   // view-only units can't be starred (no file to persist it to)
    State.setStarred(c.id, u.id, !State.isStarred(c.id, u.id));
    State.markDirty(c.id, u.id);
    buildCaseOptions(); buildFrameList(); updateDirtyUI();
    if (State.getAutoSave() && rootHandle) {   // write THIS frame (not necessarily the current one)
      try { setSaveStatus('saving'); await writeUnit(c.id, u); setSaveStatus('saved', { time: hhmm() }); updateDirtyUI(); }
      catch (e) { setSaveStatus('saveFailed', null, true); }
    }
  }
  function buildFrameList() {
    const c = curCase(), list = $('frameList'); list.innerHTML = '';
    if (!c) return;
    c.units.forEach((u, uidx) => {
      const el = document.createElement('div');
      el.className = 'frm' + (u.virtual ? ' frm-virtual' : ''); el.dataset.k = State.key(c.id, u.id); el.dataset.base = u.id;
      const name = document.createElement('span'); name.className = 'frm-name'; name.textContent = u.id;
      const badge = document.createElement('span'); badge.className = 'frm-b';
      el.appendChild(name); el.appendChild(badge);
      if (!u.virtual) {   // perfusion is view-only: no star / no annotation badge
        const on = State.isStarred(c.id, u.id);
        const star = document.createElement('span'); star.className = 'frm-star' + (on ? ' on' : ''); star.textContent = on ? '★' : '☆'; star.title = I18n.t('starThisFrame');
        star.onclick = (e) => { e.stopPropagation(); toggleStar(uidx); };
        el.appendChild(star);
      }
      el.onclick = () => { if (copyPickMode) { if (!u.virtual) pickCopySource(uidx); } else showUnit(ci, uidx); };
      list.appendChild(el);
    });
    highlightNav();
  }
  function highlightNav() {
    if (!curCase()) return;
    $('caseSelect').value = ci;
    const k = State.key(curCase().id, curUnit().id);
    document.querySelectorAll('#frameList .frm').forEach(el => {
      const [cc, uu] = el.dataset.k.split('/');
      const n = State.markCount(cc, uu), active = el.dataset.k === k;
      el.classList.toggle('active', active);
      el.classList.toggle('done', State.isVisited(cc, uu));
      el.querySelector('.frm-b').textContent = n ? n : '';
      if (active) el.scrollIntoView({ block: 'nearest' });
    });
  }

  const PICK_PX = 10;   // screen-space radius to hit an existing red dot
  function nearestBgPoint(ev) {
    const list = State.pointList(cur.caseId, cur.unitId);
    if (!list.length) return -1;
    const rect = $('view').getBoundingClientRect();
    const sx = ev.clientX - rect.left, sy = ev.clientY - rect.top;
    let best = PICK_PX, idx = -1;
    for (let i = 0; i < list.length; i++) {
      const p = view.imageToScreen(list[i][0] + 0.5, list[i][1] + 0.5);
      const d = Math.hypot(p[0] - sx, p[1] - sy);
      if (d <= best) { best = d; idx = i; }
    }
    return idx;
  }
  function onClick(ev) {
    if (suppressClick) { suppressClick = false; return; }   // this click ended a pan-drag / brush stroke, not an annotate
    if (cur && (cur.virtual || cur.mismatch)) return;       // perfusion / shape-mismatch units are view-only
    if (copyPickMode) return;                               // while picking a copy source, canvas clicks must not annotate
    if (markerArm && cur) { placeMarker(ev); return; }      // marker placement takes priority over any tool
    if (State.getTool() === 'brush') return;                // paint mode: clicks paint, not select
    if (State.getClickMode() === 'brush') return;           // brush-select handles selection via the drag path
    if (!cur) return;                                       // inspect no longer blocks annotation
    const [x, y] = view.eventToImage(ev);
    if (!view.inBounds(x, y)) return;                       // ignore clicks in the letterbox / outside image
    // magnetic snap (opt-in): ON grabs the nearest vessel even if the click is just off it; OFF selects
    // only the segment exactly under the click (off-vessel clicks fall through to the background-dot path).
    let snap;
    if (State.getMagSnap()) { snap = view.nearestSegNear(x, y, SNAP_SCREEN_R); }
    else { const s = view.segAt(x, y); snap = s ? { seg: s, x, y } : null; }
    if (snap) {
      const seg = snap.seg;
      if (!segVisible(seg)) return;                          // clicking a filtered-out (hidden) vessel does nothing
      // paint ⟂ selection: if this click will SELECT the segment, wipe any paint under it first
      if (State.hasPaint(cur.caseId, cur.unitId)) {
        const now = State.selectedSegs(cur.caseId, cur.unitId).find(s => s.seg === seg);
        if (!now || now.cls !== State.getActiveClass()) {
          const changes = view.clearPaintInSegment(seg);
          if (changes.length) { State.pushPaintUndo(cur.caseId, cur.unitId, changes); State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H); }
        }
      }
      State.applyClass(cur.caseId, cur.unitId, seg, [snap.x, snap.y], State.getActiveClass());   // point recorded ON the vessel, not in the empty pixel that was clicked
    } else {                                                // no vessel within reach: toggle a background red dot (remove nearby, else add)
      const idx = nearestBgPoint(ev);
      if (idx >= 0) State.removePoint(cur.caseId, cur.unitId, idx);
      else State.addPoint(cur.caseId, cur.unitId, [x, y], State.getActiveClass());   // record active class on the point
    }
    State.markDirty(cur.caseId, cur.unitId); refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
  }
  function onMove(ev) {
    if (!cur) return;
    lastCX = ev.clientX; lastCY = ev.clientY; overCanvas = true;
    const [x, y] = view.eventToImage(ev), seg = view.segAt(x, y);
    $('cursor').textContent = view.inBounds(x, y)
      ? (I18n.t('cursorSeg', { seg }) + (seg ? ' · ' + view.segSize(seg) + 'px' : '') + ' · (' + x + ', ' + y + ')')
      : I18n.t('cursorOutside');
    if (!inspect && isInspectMod(ev)) enterInspect();
    if (inspect) scheduleLoupe();                           // update loupe; hover still tracks below
    const ringR = State.getTool() === 'brush' ? State.getBrush().radius
                : (State.getClickMode() === 'brush' ? State.getSelBrush().radius : 0);
    if (ringR) {                                            // brush cursor ring (paint OR brush-select) replaces segment hover
      view.setBrushCursor(x, y, ringR, !spaceHeld);
      view.setHovered(0); view.setSnapPreview(0, 0, false); snapTarget = null;
      if (!hovRAF) { hovRAF = true; requestAnimationFrame(() => { hovRAF = false; view.render(); }); }
      return;
    }
    // single-click select. With magnetic snap ON: highlight the nearest vessel and preview where the point
    // will land (hollow ring). With snap OFF: just highlight the segment exactly under the cursor, no ring.
    if (State.getMagSnap()) {
      const snap = view.nearestSegNear(x, y, SNAP_SCREEN_R);
      const vis = snap && segVisible(snap.seg);              // don't snap to / preview a filtered-out vessel
      snapTarget = vis ? snap : null;
      view.setHovered(vis ? snap.seg : 0);
      view.setSnapPreview(vis ? snap.x : 0, vis ? snap.y : 0, !!vis);
    } else {
      snapTarget = null;
      view.setHovered(segVisible(seg) ? seg : 0);           // exact segment under cursor (0 = background or hidden)
      view.setSnapPreview(0, 0, false);
    }
    if (!hovRAF) { hovRAF = true; requestAnimationFrame(() => { hovRAF = false; view.render(); }); }
  }
  function onLeave() { overCanvas = false; $('cursor').textContent = ''; view.setBrushCursor(0, 0, 0, false); view.setHovered(0); view.setSnapPreview(0, 0, false); snapTarget = null; view.render(); }

  // ---- inspect (Cmd/Ctrl cross-frame loupe) ----
  const Loupe = window.Loupe;
  function enterInspect() {
    if (inspect || !cur) return;
    inspect = true; stripSig = '';
    document.body.classList.add('inspecting');
    $('loupePanel').classList.remove('hidden');
    ensureCasePerfusion(curCase());   // so a pinned perfusion tile is ready
    preloadCase(); scheduleLoupe();
  }
  function exitInspect() {
    if (!inspect) return;
    inspect = false;
    document.body.classList.remove('inspecting');
    $('loupePanel').classList.add('hidden');
  }
  function scheduleLoupe() {
    if (loupeRAF) return;
    loupeRAF = true;
    requestAnimationFrame(() => { loupeRAF = false; if (inspect) renderLoupe(); });
  }
  function preloadCase() {
    const c = curCase(); if (!c) return;
    for (const u of c.units) Loupe.ensure(State.key(c.id, u.id), u);
  }
  // gray of a unit for the loupe: fresh snapshot for the current unit (never stored),
  // cache for neighbors. Returns { W, H, gray } or null (not yet loaded / failed).
  function grayOf(c, i) {
    if (i === ui) return view.getGray();
    return Loupe.get(State.key(c.id, c.units[i].id));
  }
  function sampleVal(g, x, y, mean) {
    const W = g.W, H = g.H;
    if (x < 0 || y < 0 || x >= W || y >= H) return null;
    if (!mean) return g.gray[y * W + x];
    let s = 0, n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < W && yy < H) { s += g.gray[yy * W + xx]; n++; }
    }
    return n ? Math.round(s / n) : null;
  }
  const loupeSizePx = () => State.getLoupe().size || 92;
  function applyLoupeSize() {   // panel grows with the tile size (3 tiles per row when they fit); never below the old 320px
    const s = loupeSizePx();
    $('loupePanel').style.width = Math.max(320, Math.min(s * 3 + 34, Math.round(window.innerWidth * 0.55))) + 'px';
  }
  function rebuildStrip(idxList, units) {
    const strip = $('loupeStrip'); strip.innerHTML = ''; tileEls.clear();
    const s = loupeSizePx();
    for (const i of idxList) {
      const u = units[i];
      const wrap = document.createElement('div');
      wrap.className = 'loupe-tile' + (i === ui ? ' cur' : '') + (u.kind === 'perfusion' ? ' perf' : '');
      const cv = document.createElement('canvas');
      cv.style.width = cv.style.height = s + 'px';
      const cap = document.createElement('div'); cap.className = 'cap';
      cap.textContent = u.kind === 'perfusion' ? I18n.t('perfCap') : (u.id + (u.kind === 'minip' ? I18n.t('projectionSuffix') : ''));
      wrap.appendChild(cv); wrap.appendChild(cap); strip.appendChild(wrap);
      tileEls.set(i, { wrap, canvas: cv });
    }
  }
  function renderLoupe() {
    if (!inspect || !cur) return;
    const c = curCase(), units = c.units, n = units.length;
    const [x, y] = view.eventToImage({ clientX: lastCX, clientY: lastCY });
    const zoom = +$('loupeZoom').value, R = +$('loupeR').value, mean = $('loupeMean').checked, size = loupeSizePx();
    const lp = State.getLoupe();
    const snap = view.getGray(), W = snap.W, H = snap.H;
    const win = view.getWindow(), lut = Loupe.buildLut(win.center, win.width);
    $('loupeCoord').textContent = view.inBounds(x, y) ? ('(' + x + ', ' + y + ')') : I18n.t('cursorOutside');
    let S = Math.max(3, Math.round(size / zoom)); if (S % 2 === 0) S++;   // field of view = tile size / magnification

    // tile set = regular frames within ±R of the current frame, plus pinned minip / perfusion
    const minipIdx = units.findIndex(u => u.kind === 'minip');
    const perfIdx = units.findIndex(u => u.kind === 'perfusion');
    const idxSet = new Set();
    units.forEach((u, i) => { if (u.kind === 'frame' && i >= ui - R && i <= ui + R) idxSet.add(i); });
    idxSet.add(ui);                                                        // always include the current unit
    if (lp.pinMinip && minipIdx >= 0) idxSet.add(minipIdx);
    if (lp.pinPerfusion && perfIdx >= 0) idxSet.add(perfIdx);
    const idxList = [...idxSet].sort((a, b) => a - b);

    const sig = idxList.join(',') + '@' + ui + 'x' + size;
    if (sig !== stripSig) { rebuildStrip(idxList, units); stripSig = sig; }
    for (const i of idxList) {
      const el = tileEls.get(i); if (!el) continue;
      if (units[i].kind === 'perfusion') {
        const st = perfState(c);
        Loupe.drawColorTile(el.canvas, st === 'ok' ? perfCache.get(c.id) : null, x, y, S, st);
      } else {
        const g = grayOf(c, i);
        let st = 'ok';
        if (!g) st = Loupe.state(State.key(c.id, units[i].id));
        else if (g.W !== W || g.H !== H) st = 'mismatch';
        Loupe.drawTile(el.canvas, st === 'ok' ? g : null, x, y, S, lut, st);
      }
    }

    // cross-frame intensity curve over frames + minip only (perfusion is a timing map, not an intensity)
    const pts = []; let curveCur = -1;
    for (let i = 0; i < n; i++) {
      if (units[i].kind === 'perfusion') continue;
      if (i === ui) curveCur = pts.length;
      const g = grayOf(c, i);
      let val = null;
      if (g && g.W === W && g.H === H) val = sampleVal(g, x, y, mean);
      pts.push({ val, label: units[i].id, isMinip: units[i].kind === 'minip' });
    }
    Loupe.drawCurve($('loupeCurve'), pts, curveCur);
  }

  // ---- pan / zoom (main view) ----
  function updateZoomReadout() { $('zoomv').textContent = view.getZoom().toFixed(1) + '×'; }
  function afterViewChange() { view.render(); updateZoomReadout(); if (inspect) scheduleLoupe(); }
  // Heuristic: line/page-mode wheels and chunky vertical-only pixel steps are a mouse
  // wheel (-> zoom). Smooth/horizontal pixel deltas are trackpad two-finger (-> pan).
  function isMouseWheel(e) {
    return e.deltaMode !== 0 || (e.deltaX === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY));
  }
  function onWheel(ev) {
    if (!cur) return;
    ev.preventDefault();
    const rect = $('view').getBoundingClientRect();
    const cx = ev.clientX - rect.left, cy = ev.clientY - rect.top;
    if (!ev.ctrlKey && !isMouseWheel(ev)) {
      view.panBy(-ev.deltaX, -ev.deltaY);                   // trackpad two-finger scroll -> pan
    } else {
      const step = ev.deltaMode === 0 ? ev.deltaY : ev.deltaY * 16;   // normalize line/page mode
      view.zoomAt(cx, cy, Math.exp(-step * (ev.ctrlKey ? 0.01 : 0.0015)));  // wheel / pinch -> zoom at cursor
    }
    afterViewChange();
  }
  function onDragStart(ev) {
    if (ev.button !== 0 || !cur) return;
    const viewOnly = cur.virtual || cur.mismatch;   // perfusion / shape-mismatch: only pan, never paint/select
    // while marker-armed, skip only the brush branch: the normal pan-drag path below keeps
    // panning working, and its click suppression stops a drag-release from placing a marker
    if (!viewOnly && !markerArm && State.getTool() === 'brush' && !spaceHeld) {   // paint mode: left-drag paints (space+drag still pans)
      const b = State.getBrush();
      if (b.mode === 'add' && State.getActiveClass() == null) { setBanner('errPickClassFirst', null, 'warn'); return; }
      const [x, y] = view.eventToImage(ev);
      painting = true; suppressClick = true;
      view.strokeStart(x, y, b.radius, State.getActiveClass() || 0, b.mode, b.onmask);
      view.setBrushCursor(x, y, b.radius, true); view.render();
      return;
    }
    if (!viewOnly && !markerArm && State.getTool() === 'click' && State.getClickMode() === 'brush' && !spaceHeld) {   // brush-select: left-drag selects segments (space+drag pans)
      const sb = State.getSelBrush();
      if (sb.mode === 'add' && State.getActiveClass() == null) { setBanner('errPickClassFirst', null, 'warn'); return; }
      const [x, y] = view.eventToImage(ev);
      selecting = true; suppressClick = true;
      selStrokeSegs = new Set(); selChanges = []; selPaintChanges = []; selPointChanges = [];
      selLastX = x; selLastY = y;
      selDab(x, y);
      view.setBrushCursor(x, y, sb.radius, true);
      refreshCanvasSelection();
      return;
    }
    dragging = true; dragMoved = false; suppressClick = false;
    dragSX = dragLX = ev.clientX; dragSY = dragLY = ev.clientY;
  }
  function onDragMove(ev) {
    if (painting) {
      if (!(ev.buttons & 1)) { onDragEnd(); return; }   // left button was released off-window (lost mouseup): end the stroke, don't keep painting under a released button
      const b = State.getBrush(), p = view.eventToImage(ev);
      view.strokeMove(p[0], p[1], b.radius, State.getActiveClass() || 0, b.mode, b.onmask);
      view.setBrushCursor(p[0], p[1], b.radius, true);
      if (!brushRAF) { brushRAF = true; requestAnimationFrame(() => { brushRAF = false; view.render(); }); }
      return;
    }
    if (selecting) {
      if (!(ev.buttons & 1)) { onDragEnd(); return; }   // lost mouseup: finish the selection stroke
      const sb = State.getSelBrush(), p = view.eventToImage(ev);
      // interpolate along the path so a fast drag doesn't skip segments between mouse samples
      const dist = Math.hypot(p[0] - selLastX, p[1] - selLastY), step = Math.max(1, Math.floor(sb.radius));
      const n = Math.max(1, Math.ceil(dist / step));
      for (let k = 1; k <= n; k++) { const t = k / n; selDab(Math.round(selLastX + (p[0] - selLastX) * t), Math.round(selLastY + (p[1] - selLastY) * t)); }
      selLastX = p[0]; selLastY = p[1];
      view.setBrushCursor(p[0], p[1], sb.radius, true);
      if (!selRAF) { selRAF = true; requestAnimationFrame(() => { selRAF = false; refreshCanvasSelection(); }); }
      return;
    }
    if (!dragging) return;
    if (!dragMoved && Math.hypot(ev.clientX - dragSX, ev.clientY - dragSY) > DRAG_THRESH) {
      dragMoved = true; $('view').style.cursor = 'grabbing';
    }
    if (!dragMoved) return;
    view.panBy(ev.clientX - dragLX, ev.clientY - dragLY);
    dragLX = ev.clientX; dragLY = ev.clientY;
    afterViewChange();
  }
  function onDragEnd(ev) {
    if (ev && ev.button !== 0) return;   // a right/middle-button release must not commit/end a left-button stroke or pan
    if (painting) {
      painting = false;
      const rec = view.strokeEnd();
      if (rec.changes.length) {
        State.pushPaintUndo(cur.caseId, cur.unitId, rec.changes);
        State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H);
        State.markDirty(cur.caseId, cur.unitId);
        refreshMeta(); highlightNav(); updateDirtyUI(); scheduleAutoSave();
      }
      view.render();
      return;
    }
    if (selecting) { finalizeSelectStroke(); return; }
    if (!dragging) return;
    dragging = false; $('view').style.cursor = '';
    if (dragMoved) suppressClick = true;                    // swallow the click that follows a real drag
  }

  async function save() {
    if (!rootHandle) { setBanner('errOpenFolderFirst', null, 'warn'); return; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } pendingSave = null;
    try { if (!(await FS.ensureReadWrite(rootHandle))) { setBanner('errNoWritePermission', null, 'warn'); return; } }
    catch (e) { setBanner('saveFailedMsg', { msg: e.message }, 'warn'); return; }
    flushGeomWrite(true);     // persist the current unit's radius window on an explicit save, even if auto-save is off
    const map = new Map();
    cases.forEach(c => c.units.forEach(u => map.set(State.key(c.id, u.id), { c, u })));
    let n = 0, failed = 0;
    for (const k of State.unitsWithData()) {
      const ref = map.get(k); if (!ref || ref.u.virtual || ref.u.mismatch) continue;   // perfusion / shape-mismatch units are never written
      // don't fabricate empty annotation.json for merely-viewed, never-annotated frames
      if (!State.isDirty(ref.c.id, ref.u.id) && !State.unitHasContent(ref.c.id, ref.u.id)) continue;
      try { await writeUnit(ref.c.id, ref.u); n++; }
      catch (e) { failed++; }   // a single unloadable/broken unit must not abort saving the rest
    }
    updateDirtyUI();
    if (failed) setBanner('savedPartial', { n, failed }, 'warn'); else setBanner('savedAllFmt', { n }, 'ok');
    setSaveStatus('saved', { time: hhmm() });
  }

  // ---- debounced auto-write-to-disk (toggle in Settings; default on) ----
  function hhmm() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  let lastSaveStatus = null;   // { key, vars, warn } | null — replayed on language switch
  function setSaveStatus(key, vars, warn) {
    const el = $('saveStatus'); if (!el) return;
    lastSaveStatus = key ? { key, vars, warn: !!warn } : null;
    el.textContent = key ? I18n.t(key, vars) : '';
    el.classList.toggle('warn-text', !!warn);
  }
  function updateDirtyUI() {
    const el = $('dirtyState'); if (!el) return;
    if (cur && State.isDirty(cur.caseId, cur.unitId)) { el.textContent = I18n.t('unsavedDot'); el.className = 'ro warn-text'; }
    else { el.textContent = cur ? I18n.t('synced') : ''; el.className = 'ro'; }
  }
  function scheduleAutoSave() {
    if (!$('autoSave').checked || !rootHandle || !cur) return;
    pendingSave = { c: cur.caseId, u: cur.unitId, unit: cur.unit };   // (case,unit,handle) captured atomically in cur — never mix ids with a different unit's handle
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(runAutoSave, 1000);
    setSaveStatus('pendingSave');
  }
  function flushAutoSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; runAutoSave(); } }
  async function backupCorruptOnce(k, unit) {   // copy an unparseable annotation.json to .corrupt exactly once before we overwrite it
    if (!corruptUnits.has(k) || corruptBackedUp.has(k)) return;
    corruptBackedUp.add(k);
    try {
      const fh = await unit.handle.getFileHandle('annotation.json');
      await FS.writeText(unit.handle, 'annotation.json.corrupt', await (await fh.getFile()).text());
    } catch (e) { /* best effort — never block the real write */ }
  }
  async function writeUnit(caseId, unit) {   // write one unit's annotation.json (+ note.json) and mark it clean
    const k = State.key(caseId, unit.id);
    let data = cache.get(k); if (!data) { data = await Loader.loadUnit(unit); cache.set(k, data); }
    if (data.shapeMismatch) { State.markClean(caseId, unit.id); return; }   // never write into a shape-mismatched frame (would fabricate annotation.json)
    await backupCorruptOnce(k, unit);
    await FS.writeText(unit.handle, 'annotation.json', JSON.stringify(State.buildAnnotation(caseId, unit.id, data.W, data.H), null, 2));
    if (State.hasNoteData(caseId, unit.id)) await FS.writeText(unit.handle, 'note.json', JSON.stringify(State.buildNote(caseId, unit.id), null, 2));
    corruptUnits.delete(k);   // the file on disk is valid JSON again
    State.markClean(caseId, unit.id);
  }
  async function runAutoSave() {
    saveTimer = null;
    const p = pendingSave; pendingSave = null;
    if (!p || !rootHandle || !$('autoSave').checked) return;
    try { setSaveStatus('saving'); await writeUnit(p.c, p.unit); updateDirtyUI(); setSaveStatus('saved', { time: hhmm() }); }
    catch (e) { setSaveStatus('autoSaveFailed', null, true); }
  }

  function undo() {
    if (!cur) return;
    const e = State.undo();
    if (!e) return;                                         // nothing undone: don't spuriously dirty the current unit
    const isCur = e.c === cur.caseId && e.u === cur.unitId;
    if (e.kind === 'paint') {
      if (!isCur) return;                                   // another unit's paint can't be applied without its dense array (entry consumed)
      view.applyPaintUndo(e.changes);                       // paint undo needs the view's dense array
      State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H);
    }
    State.markDirty(e.c, e.u);                              // dirty the unit the undo actually touched
    if (!isCur) {                                           // persist THAT unit directly, leave the displayed one alone
      highlightNav(); updateDirtyUI();
      const oc = cases.find(c => c.id === e.c), ou = oc && oc.units.find(u => u.id === e.u);
      if (ou && rootHandle && State.getAutoSave()) {
        setSaveStatus('saving');
        writeUnit(e.c, ou).then(() => { setSaveStatus('saved', { time: hhmm() }); updateDirtyUI(); })
          .catch(() => setSaveStatus('saveFailed', null, true));
      }
      return;
    }
    refreshMarkers();
    refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
  }
  function askClear() { if (!cur) return; $('confirmClear').classList.remove('hidden'); }
  function closeClear() { $('confirmClear').classList.add('hidden'); }
  function clear() {
    if (!cur) return;
    State.clearUnit(cur.caseId, cur.unitId);
    view.setPaint(State.paintDense(cur.caseId, cur.unitId, cur.W, cur.H));   // wipe the canvas paint layer too, else the next stroke re-encodes & re-saves the "cleared" paint
    State.markDirty(cur.caseId, cur.unitId);
    refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
  }
  function stepUnit(d) {
    if (!cases.length) return;
    let nu = ui + d, nc = ci;
    if (nu < 0) { nc = ci - 1; if (nc < 0) return; nu = cases[nc].units.length - 1; }
    else if (nu >= curCase().units.length) { nc = ci + 1; if (nc >= cases.length) return; nu = 0; }
    showUnit(nc, nu);
  }
  function stepCase(d) { const nc = ci + d; if (nc < 0 || nc >= cases.length) return; showUnit(nc, 0); }
  function onResize() { if (view) { view.layout(); view.render(); updateZoomReadout(); } applyLoupeSize(); }
  function toggleRail() { document.body.classList.toggle('rail-collapsed'); onResize(); }

  // ---- language switcher: re-render every live piece of UI text after a switch ----
  function onLangChange() {
    if (cur) refreshMeta();
    else { $('curLabel').textContent = I18n.t('notLoaded'); $('chips').innerHTML = '<span class="muted">' + I18n.t('none') + '</span>'; }
    updateCopyBtn(); updateDirtyUI();
    buildCaseOptions(); buildFrameList(); buildClassMgr(); buildClassPicker(); buildMarkerChips();
    if (lastBanner) setBanner(lastBanner.key, lastBanner.vars, lastBanner.kind);
    if (lastSaveStatus) setSaveStatus(lastSaveStatus.key, lastSaveStatus.vars, lastSaveStatus.warn);
  }

  function init() {
    I18n.applyStatic();
    $('langEN').onclick = () => I18n.setLang('en');
    $('langZH').onclick = () => I18n.setLang('zh');
    document.addEventListener('langchange', onLangChange);

    view = window.CanvasView.create($('view'));
    State.load();
    State.setPersistFailHandler(() => setBanner('errQuotaFull', null, 'warn'));   // localStorage full: tell the user before silent data loss
    view.setPaintColorFn(segRgb);
    $('coordOrder').value = State.getCoordOrder();
    const w0 = State.getWindow();
    $('winC').value = w0.center; $('winW').value = w0.width;
    $('winCv').textContent = w0.center; $('winWv').textContent = w0.width;
    view.setWindow(w0.center, w0.width);
    const l0 = State.getLoupe();
    $('loupeZoom').value = l0.zoom; $('loupeZoomv').textContent = l0.zoom;
    $('loupeR').value = l0.R; $('loupeRv').textContent = l0.R;
    $('loupeMean').checked = !!l0.mean;
    $('loupeSize').value = l0.size; $('loupeSizev').textContent = l0.size;
    $('pinMinip').checked = l0.pinMinip !== false; $('pinPerfusion').checked = l0.pinPerfusion !== false;
    applyLoupeSize();
    $('btnOpen').onclick = openFolder;
    $('btnSave').onclick = save;
    $('btnUndo').onclick = undo;
    $('btnClear').onclick = askClear;
    $('cancelClear').onclick = closeClear;
    $('doClear').onclick = () => { closeClear(); clear(); };
    $('confirmClear').addEventListener('click', e => { if (e.target === $('confirmClear')) closeClear(); });
    $('coordOrder').onchange = e => State.setCoordOrder(e.target.value);
    $('autoSave').checked = State.getAutoSave();
    $('autoSave').onchange = e => {
      State.setAutoSave(e.target.checked);
      if (e.target.checked) scheduleAutoSave();
      else { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } setSaveStatus(null); }
    };
    $('opacity').oninput = e => { view.setOpacity(e.target.value / 100); view.render(); };
    $('maskOpacity').oninput = e => { view.setMaskOpacity(e.target.value / 100); view.render(); };
    let winRAF = false;
    function scheduleWindow() {
      $('winCv').textContent = $('winC').value; $('winWv').textContent = $('winW').value;
      if (winRAF) return;
      winRAF = true;
      requestAnimationFrame(() => { winRAF = false; const c = +$('winC').value, w = +$('winW').value; view.setWindow(c, w); view.render(); State.setWindow(c, w); });
    }
    $('winC').oninput = scheduleWindow;
    $('winW').oninput = scheduleWindow;
    $('btnAuto').onclick = () => { const w = view.autoWindow(); $('winC').value = w.center; $('winW').value = w.width; $('winCv').textContent = w.center; $('winWv').textContent = w.width; view.render(); State.setWindow(w.center, w.width); };
    $('btnWinReset').onclick = () => { $('winC').value = 128; $('winW').value = 255; $('winCv').textContent = 128; $('winWv').textContent = 255; view.setWindow(128, 255); view.render(); State.setWindow(128, 255); };
    $('loupeZoom').oninput = e => { $('loupeZoomv').textContent = e.target.value; State.setLoupe(+e.target.value, +$('loupeR').value, $('loupeMean').checked, +$('loupeSize').value); if (inspect) scheduleLoupe(); };
    $('loupeR').oninput = e => { $('loupeRv').textContent = e.target.value; State.setLoupe(+$('loupeZoom').value, +e.target.value, $('loupeMean').checked, +$('loupeSize').value); if (inspect) scheduleLoupe(); };
    $('loupeMean').onchange = e => { State.setLoupe(+$('loupeZoom').value, +$('loupeR').value, e.target.checked, +$('loupeSize').value); if (inspect) scheduleLoupe(); };
    const syncPins = () => { State.setLoupePins($('pinMinip').checked, $('pinPerfusion').checked); stripSig = ''; if (inspect) scheduleLoupe(); };
    $('pinMinip').onchange = syncPins; $('pinPerfusion').onchange = syncPins;
    $('btnExportPerf').onclick = exportPerfusion;
    $('loupeSize').oninput = e => { $('loupeSizev').textContent = e.target.value; State.setLoupe(+$('loupeZoom').value, +$('loupeR').value, $('loupeMean').checked, +e.target.value); applyLoupeSize(); if (inspect) scheduleLoupe(); };
    Loupe.onReady(() => { if (inspect) scheduleLoupe(); });
    $('caseSelect').onchange = e => showUnit(+e.target.value, 0);
    $('railToggle').onclick = toggleRail;
    $('rpanelToggle').onclick = toggleRPanel;
    $('btnAddClass').onclick = addClass;
    $('btnCopyFrom').onclick = toggleCopyPick;
    $('className').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addClass(); } });
    $('note').oninput = onNoteInput;
    $('btnSaveNote').onclick = saveNote;
    $('btnAddMarker').onclick = () => { if (markerArm) exitMarkerArm(); else enterMarkerArm(); };
    function syncToolUI() {
      const brush = State.getTool() === 'brush';
      const cm = State.getClickMode();
      const selBrush = !brush && cm === 'brush';
      $('toolClick').classList.toggle('active', !brush);
      $('toolBrush').classList.toggle('active', brush);
      document.body.classList.toggle('brush-mode', brush);
      document.body.classList.toggle('sel-brush-mode', selBrush);
      $('clickSingle').classList.toggle('active', !brush && cm === 'single');
      $('clickBrushSel').classList.toggle('active', selBrush);
      const b = State.getBrush();
      $('brushAdd').classList.toggle('active', b.mode !== 'erase');
      $('brushErase').classList.toggle('active', b.mode === 'erase');
      $('brushRadius').value = b.radius; $('brushRv').textContent = b.radius;
      $('brushOnmask').checked = b.onmask;
      const sb = State.getSelBrush();
      $('selAdd').classList.toggle('active', sb.mode !== 'erase');
      $('selErase').classList.toggle('active', sb.mode === 'erase');
      $('selRadius').value = sb.radius; $('selRv').textContent = sb.radius;
      $('magSnap').checked = State.getMagSnap();
      if (view) { view.setBrushActive(brush); view.setBrushCursor(0, 0, 0, false); view.setHovered(0); view.setSnapPreview(0, 0, false); view.render(); }
    }
    $('toolClick').onclick = () => { State.setTool('click'); syncToolUI(); };
    $('toolBrush').onclick = () => { State.setTool('brush'); syncToolUI(); };
    $('clickSingle').onclick = () => { State.setClickMode('single'); syncToolUI(); };
    $('clickBrushSel').onclick = () => { State.setClickMode('brush'); syncToolUI(); };
    $('magSnap').onchange = e => { State.setMagSnap(e.target.checked); snapTarget = null; if (view) { view.setSnapPreview(0, 0, false); view.setHovered(0); view.render(); } };
    $('geomEnable').onchange = e => { State.setGeomFilter(e.target.checked); applyGeomFilter(); };
    $('geomMin').oninput = e => { geomMin = Math.min(+e.target.value, geomMax); e.target.value = geomMin; onGeomRange(); };
    $('geomMax').oninput = e => { geomMax = Math.max(+e.target.value, geomMin); e.target.value = geomMax; onGeomRange(); };
    $('geomMin').onchange = $('geomMax').onchange = scheduleGeomSave;   // write the range back on release (per-unit)
    $('selAdd').onclick = () => { const s = State.getSelBrush(); State.setSelBrush({ mode: 'add', radius: s.radius }); syncToolUI(); };
    $('selErase').onclick = () => { const s = State.getSelBrush(); State.setSelBrush({ mode: 'erase', radius: s.radius }); syncToolUI(); };
    $('selRadius').oninput = e => { const s = State.getSelBrush(); State.setSelBrush({ mode: s.mode, radius: +e.target.value }); $('selRv').textContent = e.target.value; };
    $('brushAdd').onclick = () => { const b = State.getBrush(); State.setBrush({ mode: 'add', radius: b.radius, onmask: b.onmask }); syncToolUI(); };
    $('brushErase').onclick = () => { const b = State.getBrush(); State.setBrush({ mode: 'erase', radius: b.radius, onmask: b.onmask }); syncToolUI(); };
    $('brushRadius').oninput = e => { const b = State.getBrush(); State.setBrush({ mode: b.mode, radius: +e.target.value, onmask: b.onmask }); $('brushRv').textContent = e.target.value; };
    $('brushOnmask').onchange = e => { const b = State.getBrush(); State.setBrush({ mode: b.mode, radius: b.radius, onmask: e.target.checked }); };
    syncToolUI();
    buildClassMgr(); buildClassPicker();
    $('prevUnit').onclick = () => stepUnit(-1);
    $('nextUnit').onclick = () => stepUnit(1);
    $('prevCase').onclick = () => stepCase(-1);
    $('nextCase').onclick = () => stepCase(1);
    const cv = $('view');
    cv.addEventListener('click', onClick);
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', onLeave);
    cv.addEventListener('mouseenter', ev => { overCanvas = true; lastCX = ev.clientX; lastCY = ev.clientY; });
    cv.addEventListener('contextmenu', ev => { if (inspect || isInspectMod(ev) || State.getTool() === 'brush') ev.preventDefault(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('mousedown', onDragStart);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    $('btnFit').onclick = () => { view.fitView(); afterViewChange(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && markerArm) { exitMarkerArm(); return; }
      if (e.key === 'Escape' && copyPickMode) { exitCopyPick(); return; }
      if (e.key === 'Escape' && !$('confirmClear').classList.contains('hidden')) { closeClear(); return; }
      // while the clear-confirm modal is open, swallow every other hotkey so navigation/undo can't
      // silently change which frame "Continue clearing" will wipe
      if (!$('confirmClear').classList.contains('hidden')) return;
      if (isInspectMod(e) && !e.repeat && overCanvas && cur && !inspect) { enterInspect(); return; }
      if (e.key === ' ' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'SELECT') { spaceHeld = true; if (State.getTool() === 'brush') e.preventDefault(); }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;   // don't hijack typing (notes, class names)
      if (e.key === 'ArrowRight') stepUnit(1);
      else if (e.key === 'ArrowLeft') stepUnit(-1);
      else if (e.key === '\\') toggleRail();
      else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!painting) undo(); }   // don't undo mid-stroke (would corrupt the live stroke's change record)
      else if (!e.ctrlKey && !e.metaKey && !e.altKey) {
        if (e.key >= '1' && e.key <= '9') { const n = +e.key; if (classes.some(c => c.index === n)) { State.setActiveClass(n); buildClassPicker(); } }   // number = activate class with that index
        else { const k = e.key.toLowerCase();                                                                                                             // C/B/P = single-select / brush-select / paint
          if (k === 'c') { State.setTool('click'); State.setClickMode('single'); syncToolUI(); }
          else if (k === 'b') { State.setTool('click'); State.setClickMode('brush'); syncToolUI(); }
          else if (k === 'p') { State.setTool('brush'); syncToolUI(); } }
      }
    });
    window.addEventListener('keyup', e => { if (e.key === ' ') spaceHeld = false; if (!e.metaKey && !e.ctrlKey) exitInspect(); });
    // losing the window can swallow the mouseup/keyup: commit any live stroke and clear transient input
    // state so the brush can't come back "stuck" painting with no button held.
    function resetTransientInput() {
      if (painting) onDragEnd();
      dragging = false; spaceHeld = false; $('view').style.cursor = '';
      exitInspect();
    }
    window.addEventListener('blur', resetTransientInput);
    document.addEventListener('visibilitychange', () => { if (document.hidden) resetTransientInput(); });
    view.setOpacity($('opacity').value / 100);
    view.setMaskOpacity($('maskOpacity').value / 100);
    if (!FS.supported) {
      setBanner('errUnsupportedBrowser', null, 'warn');
      $('btnOpen').disabled = true; $('btnSave').disabled = true;
    }
    view.layout(); view.render(); updateZoomReadout();
  }
  window.addEventListener('DOMContentLoaded', init);
})();
