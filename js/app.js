// app.js — wires the UI: open folder, render a unit, click-to-toggle segments,
// hover readout, navigation, save annotation.json into each unit folder.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const State = window.State, Loader = window.Loader, FS = window.FS;

  let rootHandle = null, cases = [], ci = 0, ui = 0;
  let view = null, cur = null, hovRAF = false;
  const cache = new Map();
  let saveTimer = null, pendingSave = null;   // debounced auto-write-to-disk
  let classes = [];                           // dataset class defs [{index,name}] from classes.json
  let copyPickMode = false;                    // true while waiting for the user to pick a frame to copy from
  const PALETTE = ['#e5484d', '#1d9e75', '#3b7dd8', '#e5a50a', '#7c3aed', '#d6409f', '#0f9b8e', '#c2410c'];
  const UNCLASSIFIED_RGB = [39, 174, 96];     // green fallback for segments with no class

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

  const curCase = () => cases[ci];
  const curUnit = () => curCase() && curCase().units[ui];

  function setBanner(msg, kind) {
    const b = $('banner');
    b.textContent = msg || '';
    b.className = 'banner' + (msg ? (kind ? ' ' + kind : '') : ' hidden');
  }

  async function openFolder() {
    try {
      rootHandle = await FS.pickDirectory();
      cases = await Loader.discover(rootHandle);
      if (!cases.length) { setBanner('没找到 case_* 文件夹,请选包含 case_0001 等的数据根目录。', 'warn'); return; }
      classes = await Loader.loadClasses(rootHandle);
      setBanner('正在扫描已有标注…');
      await scanDataset();
      ensureActiveClass();
      cache.clear(); window.Loupe.reset(); ci = 0; ui = 0; buildCaseOptions();
      buildClassMgr(); buildClassPicker();
      await showUnit(0, 0); setBanner('');
    } catch (e) { if (e && e.name === 'AbortError') return; setBanner('打开失败:' + e.message, 'warn'); }
  }

  async function loadCur() {
    const c = curCase(), u = curUnit(), k = State.key(c.id, u.id);
    let data = cache.get(k);
    if (!data) { data = await Loader.loadUnit(u); cache.set(k, data); }
    else { const fresh = await Loader.loadAnnotation(u); data.annotation = fresh.annotation; data.note = fresh.note; }
    // disk is the source of truth: reconcile CLEAN units from disk each load; keep unsaved (dirty) units as-is
    if (!State.isDirty(c.id, u.id)) {
      State.resetUnit(c.id, u.id);
      if (data.annotation) State.importAnnotation(c.id, u.id, data.annotation);
      if (data.note != null) State.importNote(c.id, u.id, data.note);
    }
    return data;
  }

  async function showUnit(nci, nui) {
    flushAutoSave();          // persist the outgoing unit before we move off it
    ci = nci; ui = nui;
    const c = curCase(), u = curUnit();
    let data;
    try { data = await loadCur(); } catch (e) { setBanner(u.id + ' 载入失败:' + e.message, 'warn'); return; }
    State.markVisited(c.id, u.id);
    cur = { W: data.W, H: data.H, caseId: c.id, unitId: u.id };
    view.setUnit(data.img, data.W, data.H, data.label, data.mask);
    view.setSelected(selColorMap());
    refreshDots();
    view.layout(); view.render(); updateZoomReadout();
    refreshMeta(); buildFrameList();
    $('note').value = State.getNote(c.id, u.id);
    updateDirtyUI(); updateCopyBtn();
    if (inspect) { stripSig = ''; preloadCase(); scheduleLoupe(); }
  }

  function refreshDots() {
    if (!cur) return;
    view.setDots(State.selectedClicks(cur.caseId, cur.unitId).concat(State.pointList(cur.caseId, cur.unitId)));
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
    for (const it of State.selectedSegs(cur.caseId, cur.unitId)) m.set(it.seg, segRgb(it.cls));
    return m;
  }
  function ensureActiveClass() {
    if (!classes.length) { State.setActiveClass(null); return; }
    if (!classes.some(c => c.index === State.getActiveClass())) State.setActiveClass(classes[0].index);
  }
  async function saveClasses() {
    if (!rootHandle) return;
    try { await FS.writeText(rootHandle, 'classes.json', JSON.stringify({ classes }, null, 2)); setSaveStatus('类别已保存 ' + hhmm()); }
    catch (e) { setSaveStatus('类别保存失败', true); }
  }
  function randomName() { return '未命名-' + Math.random().toString(36).slice(2, 6); }
  // every class index actually used by any annotation — in-memory (incl unsaved) + on disk across all units
  async function usedClassSet() {
    const used = new Set(State.usedClasses());
    for (const c of cases) for (const u of c.units) {
      try {
        const { annotation } = await Loader.loadAnnotation(u);
        if (annotation && Array.isArray(annotation.collaterals))
          for (const it of annotation.collaterals) if (Number.isFinite(it.class)) used.add(it.class);
      } catch (e) { }
    }
    return used;
  }
  // startup: read every unit's annotation from disk. Import clean units into memory (disk-as-truth, so frame
  // badges are accurate on open + any frame is a valid copy source); auto-add any class used but missing from meta.
  async function scanDataset() {
    const used = new Set(State.usedClasses());
    for (const c of cases) for (const u of c.units) {
      let ann = null, note = null;
      try { const r = await Loader.loadAnnotation(u); ann = r.annotation; note = r.note; } catch (e) { }
      if (!State.isDirty(c.id, u.id)) {
        State.resetUnit(c.id, u.id);
        if (ann) State.importAnnotation(c.id, u.id, ann);
        if (note != null) State.importNote(c.id, u.id, note);
      }
      if (ann && Array.isArray(ann.collaterals)) for (const it of ann.collaterals) if (Number.isFinite(it.class)) used.add(it.class);
    }
    const have = new Set(classes.map(c => c.index));
    let added = 0;
    for (const idx of [...used].sort((a, b) => a - b)) if (!have.has(idx)) { classes.push({ index: idx, name: randomName() }); added++; }
    if (added) { classes.sort((a, b) => a.index - b.index); await saveClasses(); }
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
    if ((await usedClassSet()).has(idx)) { setBanner('类别 ' + idx + ' 已被标注使用，不能删除（先取消相关标注、或保存后再删）。', 'warn'); return; }
    classes = classes.filter(c => c.index !== idx);
    ensureActiveClass(); buildClassMgr(); buildClassPicker();
    if (cur) refreshCanvasSelection();
    saveClasses();
  }
  function buildClassMgr() {
    const box = $('classMgr'); box.innerHTML = '';
    if (!classes.length) { box.innerHTML = '<div class="muted" style="font-size:12px">还没有类别，输入名字点“添加”。</div>'; return; }
    classes.forEach(c => {
      const row = document.createElement('div'); row.className = 'cls-mgr-row';
      const idx = document.createElement('span'); idx.className = 'cls-idx'; idx.textContent = c.index;
      const inp = document.createElement('input'); inp.type = 'text'; inp.value = c.name; inp.className = 'cls-name-inp';
      inp.onchange = () => renameClass(c.index, inp.value.trim() || ('类别 ' + c.index));
      const del = document.createElement('button'); del.className = 'btn sm'; del.textContent = '删除';
      del.onclick = () => deleteClass(c.index);
      row.appendChild(idx); row.appendChild(inp); row.appendChild(del); box.appendChild(row);
    });
  }
  function buildClassPicker() {
    const box = $('classPicker'); box.innerHTML = '';
    if (!classes.length) { box.innerHTML = '<div class="muted" style="font-size:12px">在左栏“分类管理”添加类别后，这里选择当前标注类别与颜色。</div>'; return; }
    const active = State.getActiveClass();
    classes.forEach(c => {
      const row = document.createElement('div'); row.className = 'cls-row' + (c.index === active ? ' active' : '');
      const color = document.createElement('input'); color.type = 'color'; color.value = classColor(c.index); color.className = 'cls-color';
      color.oninput = e => { State.setClassColor(c.index, e.target.value); if (cur) refreshCanvasSelection(); };
      color.onclick = e => e.stopPropagation();
      const name = document.createElement('span'); name.className = 'cls-name'; name.textContent = c.index + ' · ' + c.name;
      row.appendChild(color); row.appendChild(name);
      row.onclick = () => { State.setActiveClass(c.index); buildClassPicker(); };
      box.appendChild(row);
    });
  }
  // ---- copy annotation from another frame (re-resolved by coordinate onto the current frame) ----
  function updateCopyBtn() {
    const b = $('btnCopyFrom'); if (!b) return;
    b.disabled = !cur || State.markCount(cur.caseId, cur.unitId) > 0;
    b.textContent = copyPickMode ? '取消复制' : '从其他帧复制…';
  }
  function enterCopyPick() {
    if (!cur || State.markCount(cur.caseId, cur.unitId) > 0) return;
    copyPickMode = true;
    $('frameList').classList.add('picking');
    document.body.classList.add('copy-picking');
    setBanner('点击左侧要复制标注的帧（Esc 取消）。');
    updateCopyBtn();
  }
  function exitCopyPick() {
    if (!copyPickMode) return;
    copyPickMode = false;
    $('frameList').classList.remove('picking');
    document.body.classList.remove('copy-picking');
    setBanner('');
    updateCopyBtn();
  }
  function toggleCopyPick() { if (copyPickMode) exitCopyPick(); else enterCopyPick(); }
  function pickCopySource(uidx) {
    const src = curCase().units[uidx];
    if (src && uidx !== ui) doCopyFrom(curCase().id, src);
    exitCopyPick();
  }
  function doCopyFrom(srcCaseId, srcUnit) {
    // gather source clicks (segments + background points) — each carries the class chosen when it was clicked
    const clicks = State.selectedSegs(srcCaseId, srcUnit.id).map(s => ({ xy: s.xy, cls: s.cls }))
      .concat(State.pointItems(srcCaseId, srcUnit.id));
    if (!clicks.length) { setBanner('“' + srcUnit.id + '” 没有可复制的标注。', 'warn'); return; }
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
    State.markDirty(cur.caseId, cur.unitId);
    refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
    setBanner('已从 “' + srcUnit.id + '” 复制并重新解析：' + segMap.size + ' 段 · ' + pts.length + ' 点' + (dropped ? '（' + dropped + ' 个无类别已跳过）' : '') + '。', 'ok');
  }

  function onNoteInput() { if (!cur) return; State.setNote(cur.caseId, cur.unitId, $('note').value); State.markDirty(cur.caseId, cur.unitId); updateDirtyUI(); scheduleAutoSave(); }
  async function saveNote() {   // saves the whole current frame (annotation + note) so the dirty flag stays honest
    if (!cur) return;
    if (!rootHandle) { setBanner('先打开数据文件夹。', 'warn'); return; }
    const c = cur.caseId, u = cur.unitId, unit = curUnit();
    State.setNote(c, u, $('note').value);
    try {
      const data = cache.get(State.key(c, u)) || await Loader.loadUnit(unit);
      await FS.writeText(unit.handle, 'annotation.json', JSON.stringify(State.buildAnnotation(c, u, data.W, data.H), null, 2));
      await FS.writeText(unit.handle, 'note.txt', $('note').value);
      State.markClean(c, u); updateDirtyUI();
      setSaveStatus('笔记已保存 ' + hhmm());
    } catch (e) { setSaveStatus('笔记保存失败', true); }
  }
  function toggleRPanel() { document.body.classList.toggle('rpanel-collapsed'); onResize(); }

  function refreshMeta() {
    const c = curCase(), u = curUnit();
    $('curLabel').textContent = c.id + ' / ' + u.id + '  (' + u.kind + ')';
    $('unitIndicator').textContent = '单元 ' + (ui + 1) + '/' + curCase().units.length + ' · 病例 ' + (ci + 1) + '/' + cases.length;
    const ids = State.selectedIds(c.id, u.id);
    $('chips').innerHTML = ids.length ? ids.map(i => '<span class="chip">' + i + '</span>').join('') : '<span class="muted">（无）</span>';
    $('progress').textContent = '本单元已标 ' + ids.length + ' 段 · ' + State.pointCount(c.id, u.id) + ' 点';
  }

  function buildCaseOptions() {
    const sel = $('caseSelect'); sel.innerHTML = '';
    cases.forEach((c, idx) => {
      const o = document.createElement('option');
      o.value = idx; o.textContent = c.id;
      sel.appendChild(o);
    });
  }
  function buildFrameList() {
    const c = curCase(), list = $('frameList'); list.innerHTML = '';
    if (!c) return;
    c.units.forEach((u, uidx) => {
      const el = document.createElement('div');
      el.className = 'frm'; el.dataset.k = State.key(c.id, u.id); el.dataset.base = u.id;
      const name = document.createElement('span'); name.textContent = u.id;
      const badge = document.createElement('span'); badge.className = 'frm-b';
      el.appendChild(name); el.appendChild(badge);
      el.onclick = () => { if (copyPickMode) pickCopySource(uidx); else showUnit(ci, uidx); };
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
    if (suppressClick) { suppressClick = false; return; }   // this click ended a pan-drag, not an annotate
    if (!cur) return;                                       // inspect no longer blocks annotation
    const [x, y] = view.eventToImage(ev);
    if (!view.inBounds(x, y)) return;                       // ignore clicks in the letterbox / outside image
    const seg = view.segAt(x, y);
    if (seg) {
      State.applyClass(cur.caseId, cur.unitId, seg, [x, y], State.getActiveClass());
    } else {                                                // background: toggle a red dot (remove nearby, else add)
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
      ? ('光标 seg ' + seg + (seg ? ' · ' + view.segSize(seg) + 'px' : '') + ' · (' + x + ', ' + y + ')')
      : '光标在图外';
    if (!inspect && isInspectMod(ev)) enterInspect();
    if (inspect) scheduleLoupe();                           // update loupe; hover still tracks below
    if (view.setHovered(seg) && !hovRAF) { hovRAF = true; requestAnimationFrame(() => { hovRAF = false; view.render(); }); }
  }
  function onLeave() { overCanvas = false; $('cursor').textContent = ''; if (view.setHovered(0)) view.render(); }

  // ---- inspect (Cmd/Ctrl cross-frame loupe) ----
  const Loupe = window.Loupe;
  function enterInspect() {
    if (inspect || !cur) return;
    inspect = true; stripSig = '';
    document.body.classList.add('inspecting');
    $('loupePanel').classList.remove('hidden');
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
  function rebuildStrip(lo, hi, units) {
    const strip = $('loupeStrip'); strip.innerHTML = ''; tileEls.clear();
    for (let i = lo; i <= hi; i++) {
      const wrap = document.createElement('div');
      wrap.className = 'loupe-tile' + (i === ui ? ' cur' : '');
      const cv = document.createElement('canvas');
      const cap = document.createElement('div'); cap.className = 'cap';
      cap.textContent = units[i].id + (units[i].kind === 'minip' ? '（投影）' : '');
      wrap.appendChild(cv); wrap.appendChild(cap); strip.appendChild(wrap);
      tileEls.set(i, { wrap, canvas: cv });
    }
  }
  function renderLoupe() {
    if (!inspect || !cur) return;
    const c = curCase(), units = c.units, n = units.length;
    const [x, y] = view.eventToImage({ clientX: lastCX, clientY: lastCY });
    const zoom = +$('loupeZoom').value, R = +$('loupeR').value, mean = $('loupeMean').checked;
    const snap = view.getGray(), W = snap.W, H = snap.H;
    const win = view.getWindow(), lut = Loupe.buildLut(win.center, win.width);
    $('loupeCoord').textContent = view.inBounds(x, y) ? ('(' + x + ', ' + y + ')') : '光标在图外';

    let S = Math.max(3, Math.round(92 / zoom)); if (S % 2 === 0) S++;
    const lo = Math.max(0, ui - R), hi = Math.min(n - 1, ui + R);
    const sig = lo + '-' + hi + '@' + ui;
    if (sig !== stripSig) { rebuildStrip(lo, hi, units); stripSig = sig; }
    for (let i = lo; i <= hi; i++) {
      const el = tileEls.get(i); if (!el) continue;
      const g = grayOf(c, i);
      let st = 'ok';
      if (!g) st = Loupe.state(State.key(c.id, units[i].id));
      else if (g.W !== W || g.H !== H) st = 'mismatch';
      Loupe.drawTile(el.canvas, st === 'ok' ? g : null, x, y, S, lut, st);
    }

    const pts = [];
    for (let i = 0; i < n; i++) {
      const g = grayOf(c, i);
      let val = null;
      if (g && g.W === W && g.H === H) val = sampleVal(g, x, y, mean);
      pts.push({ val, label: units[i].id, isMinip: units[i].kind === 'minip' });
    }
    Loupe.drawCurve($('loupeCurve'), pts, ui);
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
    dragging = true; dragMoved = false; suppressClick = false;
    dragSX = dragLX = ev.clientX; dragSY = dragLY = ev.clientY;
  }
  function onDragMove(ev) {
    if (!dragging) return;
    if (!dragMoved && Math.hypot(ev.clientX - dragSX, ev.clientY - dragSY) > DRAG_THRESH) {
      dragMoved = true; $('view').style.cursor = 'grabbing';
    }
    if (!dragMoved) return;
    view.panBy(ev.clientX - dragLX, ev.clientY - dragLY);
    dragLX = ev.clientX; dragLY = ev.clientY;
    afterViewChange();
  }
  function onDragEnd() {
    if (!dragging) return;
    dragging = false; $('view').style.cursor = '';
    if (dragMoved) suppressClick = true;                    // swallow the click that follows a real drag
  }

  async function save() {
    if (!rootHandle) { setBanner('先打开数据文件夹。', 'warn'); return; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } pendingSave = null;
    try {
      if (!(await FS.ensureReadWrite(rootHandle))) { setBanner('没有写入权限,无法保存。', 'warn'); return; }
      const map = new Map();
      cases.forEach(c => c.units.forEach(u => map.set(State.key(c.id, u.id), { c, u })));
      let n = 0;
      for (const k of State.unitsWithData()) {
        const ref = map.get(k); if (!ref) continue;
        let data = cache.get(k);
        if (!data) { data = await Loader.loadUnit(ref.u); cache.set(k, data); }
        const ann = State.buildAnnotation(ref.c.id, ref.u.id, data.W, data.H);
        await FS.writeText(ref.u.handle, 'annotation.json', JSON.stringify(ann, null, 2));
        if (State.hasNote(ref.c.id, ref.u.id)) await FS.writeText(ref.u.handle, 'note.txt', State.getNote(ref.c.id, ref.u.id));
        State.markClean(ref.c.id, ref.u.id);
        n++;
      }
      updateDirtyUI();
      setBanner('已保存 ' + n + ' 个单元的 annotation.json 到各自文件夹。', 'ok');
      setSaveStatus('已保存 ' + hhmm());
    } catch (e) { setBanner('保存失败:' + e.message, 'warn'); }
  }

  // ---- debounced auto-write-to-disk (toggle in 设置; default on) ----
  function hhmm() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }
  function setSaveStatus(msg, warn) { const el = $('saveStatus'); if (!el) return; el.textContent = msg || ''; el.classList.toggle('warn-text', !!warn); }
  function updateDirtyUI() {
    const el = $('dirtyState'); if (!el) return;
    if (cur && State.isDirty(cur.caseId, cur.unitId)) { el.textContent = '●未保存'; el.className = 'ro warn-text'; }
    else { el.textContent = cur ? '已同步' : ''; el.className = 'ro'; }
  }
  function scheduleAutoSave() {
    if (!$('autoSave').checked || !rootHandle || !cur) return;
    pendingSave = { c: cur.caseId, u: cur.unitId, unit: curUnit() };   // capture the unit now, in case we navigate
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(runAutoSave, 1000);
    setSaveStatus('待保存…');
  }
  function flushAutoSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; runAutoSave(); } }
  async function runAutoSave() {
    saveTimer = null;
    const p = pendingSave; pendingSave = null;
    if (!p || !rootHandle || !$('autoSave').checked) return;
    try {
      setSaveStatus('保存中…');
      let data = cache.get(State.key(p.c, p.u));
      if (!data) data = await Loader.loadUnit(p.unit);
      const ann = State.buildAnnotation(p.c, p.u, data.W, data.H);
      await FS.writeText(p.unit.handle, 'annotation.json', JSON.stringify(ann, null, 2));
      if (State.hasNote(p.c, p.u)) await FS.writeText(p.unit.handle, 'note.txt', State.getNote(p.c, p.u));
      State.markClean(p.c, p.u); updateDirtyUI();
      setSaveStatus('已保存 ' + hhmm());
    } catch (e) { setSaveStatus('自动保存失败', true); }
  }

  function undo() { if (!cur) return; State.undo(); State.markDirty(cur.caseId, cur.unitId); refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave(); }
  function askClear() { if (!cur) return; $('confirmClear').classList.remove('hidden'); }
  function closeClear() { $('confirmClear').classList.add('hidden'); }
  function clear() { if (!cur) return; State.clearUnit(cur.caseId, cur.unitId); State.markDirty(cur.caseId, cur.unitId); refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave(); }
  function stepUnit(d) {
    if (!cases.length) return;
    let nu = ui + d, nc = ci;
    if (nu < 0) { nc = ci - 1; if (nc < 0) return; nu = cases[nc].units.length - 1; }
    else if (nu >= curCase().units.length) { nc = ci + 1; if (nc >= cases.length) return; nu = 0; }
    showUnit(nc, nu);
  }
  function stepCase(d) { const nc = ci + d; if (nc < 0 || nc >= cases.length) return; showUnit(nc, 0); }
  function onResize() { if (view) { view.layout(); view.render(); updateZoomReadout(); } }
  function toggleRail() { document.body.classList.toggle('rail-collapsed'); onResize(); }

  function init() {
    view = window.CanvasView.create($('view'));
    State.load();
    $('coordOrder').value = State.getCoordOrder();
    const w0 = State.getWindow();
    $('winC').value = w0.center; $('winW').value = w0.width;
    $('winCv').textContent = w0.center; $('winWv').textContent = w0.width;
    view.setWindow(w0.center, w0.width);
    const l0 = State.getLoupe();
    $('loupeZoom').value = l0.zoom; $('loupeZoomv').textContent = l0.zoom;
    $('loupeR').value = l0.R; $('loupeRv').textContent = l0.R;
    $('loupeMean').checked = !!l0.mean;
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
      else { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } setSaveStatus(''); }
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
    $('loupeZoom').oninput = e => { $('loupeZoomv').textContent = e.target.value; State.setLoupe(+e.target.value, +$('loupeR').value, $('loupeMean').checked); if (inspect) scheduleLoupe(); };
    $('loupeR').oninput = e => { $('loupeRv').textContent = e.target.value; State.setLoupe(+$('loupeZoom').value, +e.target.value, $('loupeMean').checked); if (inspect) scheduleLoupe(); };
    $('loupeMean').onchange = e => { State.setLoupe(+$('loupeZoom').value, +$('loupeR').value, e.target.checked); if (inspect) scheduleLoupe(); };
    Loupe.onReady(() => { if (inspect) scheduleLoupe(); });
    $('caseSelect').onchange = e => showUnit(+e.target.value, 0);
    $('railToggle').onclick = toggleRail;
    $('rpanelToggle').onclick = toggleRPanel;
    $('btnAddClass').onclick = addClass;
    $('btnCopyFrom').onclick = toggleCopyPick;
    $('className').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addClass(); } });
    $('note').oninput = onNoteInput;
    $('btnSaveNote').onclick = saveNote;
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
    cv.addEventListener('contextmenu', ev => { if (inspect || isInspectMod(ev)) ev.preventDefault(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('mousedown', onDragStart);
    window.addEventListener('mousemove', onDragMove);
    window.addEventListener('mouseup', onDragEnd);
    $('btnFit').onclick = () => { view.fitView(); afterViewChange(); };
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && copyPickMode) { exitCopyPick(); return; }
      if (e.key === 'Escape' && !$('confirmClear').classList.contains('hidden')) { closeClear(); return; }
      if (isInspectMod(e) && !e.repeat && overCanvas && cur && !inspect) { enterInspect(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight') stepUnit(1);
      else if (e.key === 'ArrowLeft') stepUnit(-1);
      else if (e.key === '\\') toggleRail();
      else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
    });
    window.addEventListener('keyup', e => { if (!e.metaKey && !e.ctrlKey) exitInspect(); });
    window.addEventListener('blur', exitInspect);
    document.addEventListener('visibilitychange', () => { if (document.hidden) exitInspect(); });
    view.setOpacity($('opacity').value / 100);
    view.setMaskOpacity($('maskOpacity').value / 100);
    if (!FS.supported) {
      setBanner('此浏览器不支持自动写盘(File System Access API)。请用 Chrome 或 Edge 打开本页。', 'warn');
      $('btnOpen').disabled = true; $('btnSave').disabled = true;
    }
    view.layout(); view.render(); updateZoomReadout();
  }
  window.addEventListener('DOMContentLoaded', init);
})();
