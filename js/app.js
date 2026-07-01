// app.js — wires the UI: open folder, render a unit, click-to-toggle segments,
// hover readout, navigation, save annotation.json into each unit folder.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const State = window.State, Loader = window.Loader, FS = window.FS;

  let rootHandle = null, cases = [], ci = 0, ui = 0;
  let view = null, cur = null, hovRAF = false;
  const cache = new Map();

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
      cache.clear(); ci = 0; ui = 0; buildTree();
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
    if (!cur) return;
    const [x, y] = view.eventToImage(ev), seg = view.segAt(x, y);
    if (!seg) return;
    State.toggle(cur.caseId, cur.unitId, seg, [x, y]);
    refreshCanvasSelection(); refreshMeta(); highlightTree();
  }
  function onMove(ev) {
    if (!cur) return;
    const [x, y] = view.eventToImage(ev), seg = view.segAt(x, y);
    $('cursor').textContent = view.inBounds(x, y)
      ? ('光标 seg ' + seg + (seg ? ' · ' + view.segSize(seg) + 'px' : '') + ' · (' + x + ', ' + y + ')')
      : '光标在图外';
    if (view.setHovered(seg) && !hovRAF) { hovRAF = true; requestAnimationFrame(() => { hovRAF = false; view.render(); }); }
  }
  function onLeave() { $('cursor').textContent = ''; if (view.setHovered(0)) view.render(); }

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
    $('btnOpen').onclick = openFolder;
    $('btnSave').onclick = save;
    $('btnUndo').onclick = undo;
    $('btnClear').onclick = clear;
    $('coordOrder').onchange = e => State.setCoordOrder(e.target.value);
    $('opacity').oninput = e => { view.setOpacity(e.target.value / 100); view.render(); };
    $('maskOpacity').oninput = e => { view.setMaskOpacity(e.target.value / 100); view.render(); };
    $('prevUnit').onclick = () => stepUnit(-1);
    $('nextUnit').onclick = () => stepUnit(1);
    $('prevCase').onclick = () => stepCase(-1);
    $('nextCase').onclick = () => stepCase(1);
    const cv = $('view');
    cv.addEventListener('click', onClick);
    cv.addEventListener('mousemove', onMove);
    cv.addEventListener('mouseleave', onLeave);
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight') stepUnit(1);
      else if (e.key === 'ArrowLeft') stepUnit(-1);
      else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); undo(); }
    });
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
