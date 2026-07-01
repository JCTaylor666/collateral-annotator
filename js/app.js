// app.js — wires the UI: open folder, render a unit, click-to-toggle segments,
// hover readout, navigation, save annotation.json into each unit folder.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const State = window.State, Loader = window.Loader, FS = window.FS;

  let rootHandle = null, cases = [], ci = 0, ui = 0;
  let view = null, cur = null, hovRAF = false;
  const cache = new Map();

  // inspect (Cmd/Ctrl loupe) state
  let inspect = false, overCanvas = false, swallowClick = false;
  let lastCX = 0, lastCY = 0, loupeRAF = false, stripSig = '';
  const tileEls = new Map();  // unit index -> { wrap, canvas, cap }
  const isInspectMod = e => e.metaKey || e.ctrlKey;

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
      cache.clear(); window.Loupe.reset(); ci = 0; ui = 0; buildTree();
      await showUnit(0, 0); setBanner('');
    } catch (e) { if (e && e.name === 'AbortError') return; setBanner('打开失败:' + e.message, 'warn'); }
  }

  async function loadCur() {
    const c = curCase(), u = curUnit(), k = State.key(c.id, u.id);
    if (cache.has(k)) return cache.get(k);
    const data = await Loader.loadUnit(u);
    cache.set(k, data);
    if (!State.hasLocal(c.id, u.id) && data.annotation) State.importAnnotation(c.id, u.id, data.annotation);
    return data;
  }

  async function showUnit(nci, nui) {
    ci = nci; ui = nui;
    const c = curCase(), u = curUnit();
    let data;
    try { data = await loadCur(); } catch (e) { setBanner(u.id + ' 载入失败:' + e.message, 'warn'); return; }
    State.markVisited(c.id, u.id);
    cur = { W: data.W, H: data.H, caseId: c.id, unitId: u.id };
    view.setUnit(data.img, data.W, data.H, data.label, data.mask);
    view.setSelected(new Set(State.selectedIds(c.id, u.id)));
    view.layout(); view.render();
    refreshMeta(); highlightTree();
    if (inspect) { stripSig = ''; preloadCase(); scheduleLoupe(); }
  }

  function refreshCanvasSelection() {
    view.setSelected(new Set(State.selectedIds(cur.caseId, cur.unitId)));
    view.render();
  }

  function refreshMeta() {
    const c = curCase(), u = curUnit();
    $('curLabel').textContent = c.id + ' / ' + u.id + '  (' + u.kind + ')';
    $('unitIndicator').textContent = '单元 ' + (ui + 1) + '/' + curCase().units.length + ' · 病例 ' + (ci + 1) + '/' + cases.length;
    const ids = State.selectedIds(c.id, u.id);
    $('chips').innerHTML = ids.length ? ids.map(i => '<span class="chip">' + i + '</span>').join('') : '<span class="muted">（无）</span>';
    $('progress').textContent = '本单元已标 ' + ids.length + ' 段';
  }

  function buildTree() {
    const t = $('tree'); t.innerHTML = '';
    cases.forEach((c, idx) => {
      const cd = document.createElement('div'); cd.className = 'tcase'; cd.textContent = c.id; t.appendChild(cd);
      c.units.forEach((u, uidx) => {
        const el = document.createElement('div');
        el.className = 'tunit'; el.dataset.k = State.key(c.id, u.id); el.dataset.base = u.id; el.textContent = u.id;
        el.onclick = () => showUnit(idx, uidx);
        t.appendChild(el);
      });
    });
    highlightTree();
  }
  function highlightTree() {
    const k = curCase() ? State.key(curCase().id, curUnit().id) : '';
    document.querySelectorAll('.tunit').forEach(el => {
      const [cc, uu] = el.dataset.k.split('/');
      const n = State.count(cc, uu);
      el.classList.toggle('active', el.dataset.k === k);
      el.classList.toggle('done', State.isVisited(cc, uu));
      el.textContent = el.dataset.base + (n ? ' · ' + n : '');
    });
  }

  function onClick(ev) {
    if (swallowClick) { swallowClick = false; return; }   // consumed by an inspect gesture
    if (inspect || isInspectMod(ev)) return;               // never annotate while inspecting
    if (!cur) return;
    const [x, y] = view.eventToImage(ev), seg = view.segAt(x, y);
    if (!seg) return;
    State.toggle(cur.caseId, cur.unitId, seg, [x, y]);
    refreshCanvasSelection(); refreshMeta(); highlightTree();
  }
  function onMove(ev) {
    if (!cur) return;
    lastCX = ev.clientX; lastCY = ev.clientY; overCanvas = true;
    const [x, y] = view.eventToImage(ev), seg = view.segAt(x, y);
    $('cursor').textContent = view.inBounds(x, y)
      ? ('光标 seg ' + seg + (seg ? ' · ' + view.segSize(seg) + 'px' : '') + ' · (' + x + ', ' + y + ')')
      : '光标在图外';
    if (!inspect && isInspectMod(ev)) enterInspect();
    if (inspect) { scheduleLoupe(); return; }               // freeze hover during inspect
    if (view.setHovered(seg) && !hovRAF) { hovRAF = true; requestAnimationFrame(() => { hovRAF = false; view.render(); }); }
  }
  function onLeave() { overCanvas = false; $('cursor').textContent = ''; if (view.setHovered(0)) view.render(); }

  // ---- inspect (Cmd/Ctrl cross-frame loupe) ----
  const Loupe = window.Loupe;
  function enterInspect() {
    if (inspect || !cur) return;
    inspect = true; swallowClick = false; stripSig = '';
    document.body.classList.add('inspecting');
    $('loupePanel').classList.remove('hidden');
    preloadCase(); scheduleLoupe();
  }
  function exitInspect() {
    if (!inspect) return;
    inspect = false; swallowClick = false;
    document.body.classList.remove('inspecting');
    $('loupePanel').classList.add('hidden');
    if (overCanvas) { view.setHovered(0); view.render(); }  // drop frozen hover, restore interactivity
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

  async function save() {
    if (!rootHandle) { setBanner('先打开数据文件夹。', 'warn'); return; }
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
        n++;
      }
      setBanner('已保存 ' + n + ' 个单元的 annotation.json 到各自文件夹。', 'ok');
    } catch (e) { setBanner('保存失败:' + e.message, 'warn'); }
  }

  function undo() { if (!cur) return; State.undo(); refreshCanvasSelection(); refreshMeta(); highlightTree(); }
  function askClear() { if (!cur) return; $('confirmClear').classList.remove('hidden'); }
  function closeClear() { $('confirmClear').classList.add('hidden'); }
  function clear() { if (!cur) return; State.clearUnit(cur.caseId, cur.unitId); refreshCanvasSelection(); refreshMeta(); highlightTree(); }
  function stepUnit(d) {
    if (!cases.length) return;
    let nu = ui + d, nc = ci;
    if (nu < 0) { nc = ci - 1; if (nc < 0) return; nu = cases[nc].units.length - 1; }
    else if (nu >= curCase().units.length) { nc = ci + 1; if (nc >= cases.length) return; nu = 0; }
    showUnit(nc, nu);
  }
  function stepCase(d) { const nc = ci + d; if (nc < 0 || nc >= cases.length) return; showUnit(nc, 0); }
  function onResize() { if (view) { view.layout(); view.render(); } }

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
    $('prevUnit').onclick = () => stepUnit(-1);
    $('nextUnit').onclick = () => stepUnit(1);
    $('prevCase').onclick = () => stepCase(-1);
    $('nextCase').onclick = () => stepCase(1);
    const cv = $('view');
    cv.addEventListener('click', onClick);
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', onLeave);
    cv.addEventListener('mouseenter', ev => { overCanvas = true; lastCX = ev.clientX; lastCY = ev.clientY; });
    cv.addEventListener('mousedown', ev => { if (inspect || isInspectMod(ev)) swallowClick = true; });
    cv.addEventListener('contextmenu', ev => { if (inspect || isInspectMod(ev)) ev.preventDefault(); });
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('confirmClear').classList.contains('hidden')) { closeClear(); return; }
      if (isInspectMod(e) && !e.repeat && overCanvas && cur && !inspect) { enterInspect(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight') stepUnit(1);
      else if (e.key === 'ArrowLeft') stepUnit(-1);
      else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey) && !inspect) { e.preventDefault(); undo(); }
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
    view.layout(); view.render();
  }
  window.addEventListener('DOMContentLoaded', init);
})();
