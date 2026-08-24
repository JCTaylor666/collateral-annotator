// raillayout.js — lets the doctor drag the left rail's collapsible panels into their own order.
//
// Scope: ONLY the `<details class="grp" data-sec="…">` panels. The file buttons, Navigation
// (case picker + frame list) and Contrast stay pinned at the top of the rail and are never moved,
// so the primary navigation is always in the same place.
//
// Nothing here touches annotation data or the data folder: the order lives in its own small
// localStorage key. That key is deliberately NOT State's — State's blob holds every annotation and
// is measured to hit the 5MB quota at roughly 600-860 annotated units; once it does, persist()
// fails wholesale and the panel order would silently stop being saved with it.
(function () {
  'use strict';

  const LSKEY = 'vessel_annotator_ui_v1';
  const SEL = ':scope > .grp[data-sec]';
  const EDGE = 36;        // px from a rail edge where a drag starts auto-scrolling
  const STEP = 10;        // px per auto-scroll tick

  let rail = null, defaultOrder = [];
  let dragEl = null, dragGrip = null, dragPointer = null, lastY = 0;
  let scrollTimer = 0, scrollDir = 0;

  const sections = () => Array.prototype.slice.call(rail.querySelectorAll(SEL));
  // getClientRects() is empty for a display:none panel — #geomPanel is hidden whenever the dataset
  // has no geometry.json, and a hidden panel's 0x0 rect would sit at the top of the viewport and
  // wreck the midpoint test below. Its slot in the saved order is still kept.
  const visible = () => sections().filter(el => el.getClientRects().length > 0);

  function readOrder() {
    try {
      const o = JSON.parse(localStorage.getItem(LSKEY) || 'null');
      return (o && Array.isArray(o.railOrder)) ? o.railOrder.filter(k => typeof k === 'string') : null;
    } catch (e) { return null; }
  }
  function writeOrder() {
    try {
      let o = null;
      try { o = JSON.parse(localStorage.getItem(LSKEY) || '{}'); } catch (e) { }
      if (!o || typeof o !== 'object') o = {};
      o.railOrder = sections().map(el => el.dataset.sec);
      localStorage.setItem(LSKEY, JSON.stringify(o));
    } catch (e) { }   // layout is cosmetic: a full or blocked store must never break annotating
  }

  // Re-append every panel in the stored order. Panels the stored order does not mention (a section
  // added by a later version) keep their original relative position at the end instead of vanishing.
  function applyOrder(keys) {
    if (!keys || !keys.length) return;
    const byKey = new Map(sections().map(el => [el.dataset.sec, el]));
    const seen = new Set(), ordered = [];
    keys.forEach(k => { const el = byKey.get(k); if (el && !seen.has(k)) { seen.add(k); ordered.push(el); } });
    sections().forEach(el => { if (!seen.has(el.dataset.sec)) ordered.push(el); });
    ordered.forEach(el => rail.appendChild(el));   // the pinned blocks are never in this list, so they stay on top
  }

  function reorderAt(y) {
    if (!dragEl) return;
    const sibs = visible().filter(el => el !== dragEl);
    for (let i = 0; i < sibs.length; i++) {
      const r = sibs[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) { rail.insertBefore(dragEl, sibs[i]); return; }
    }
    rail.appendChild(dragEl);
  }

  function stopScroll() { if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = 0; } scrollDir = 0; }
  function edgeScroll(y) {
    const r = rail.getBoundingClientRect();
    scrollDir = y < r.top + EDGE ? -1 : (y > r.bottom - EDGE ? 1 : 0);
    if (!scrollDir) { stopScroll(); return; }
    if (scrollTimer) return;   // direction is re-read from scrollDir each tick, so one timer is enough
    scrollTimer = setInterval(() => {
      if (!dragEl || !scrollDir) { stopScroll(); return; }
      const before = rail.scrollTop;
      rail.scrollTop = before + scrollDir * STEP;
      if (rail.scrollTop === before) { stopScroll(); return; }   // already at an end
      reorderAt(lastY);
    }, 16);
  }

  function onDown(e) {
    if (dragEl) return;
    if (e.button != null && e.button > 0) return;               // left button (or touch/pen) only
    const g = e.target.closest && e.target.closest('.grip');
    if (!g) return;
    const el = g.closest('.grp[data-sec]');
    if (!el || el.parentNode !== rail) return;
    e.preventDefault();                                         // no text selection, no summary scroll-into-view
    dragEl = el; dragGrip = g; dragPointer = e.pointerId; lastY = e.clientY;
    try { g.setPointerCapture(e.pointerId); } catch (err) { }
    el.classList.add('dragging');
    document.body.classList.add('rail-dragging');
  }

  function onMove(e) {
    if (!dragEl || (dragPointer != null && e.pointerId !== dragPointer)) return;
    lastY = e.clientY;
    reorderAt(lastY);
    edgeScroll(lastY);
  }

  function endDrag() {
    if (!dragEl) return;
    stopScroll();
    dragEl.classList.remove('dragging');
    document.body.classList.remove('rail-dragging');
    try { dragGrip.releasePointerCapture(dragPointer); } catch (e) { }
    dragEl = null; dragGrip = null; dragPointer = null;
    writeOrder();
  }

  function resetOrder() {
    try { localStorage.removeItem(LSKEY); } catch (e) { }
    const byKey = new Map(sections().map(el => [el.dataset.sec, el]));
    defaultOrder.forEach(k => { const el = byKey.get(k); if (el) rail.appendChild(el); });
  }

  function onKeyDown(e) {
    const g = e.target.closest && e.target.closest('.grip');
    if (!g) return;
    // app.js's global hotkey handler only skips INPUT/SELECT/TEXTAREA. Without this, any key pressed
    // while a grip has focus would ALSO step frames (arrows), switch tools (c/b/p) or arm Space-pan.
    e.stopPropagation();
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); return; }   // never toggle the panel from the grip
    const up = e.key === 'ArrowUp', down = e.key === 'ArrowDown';
    if (!up && !down || !e.altKey) return;
    const el = g.closest('.grp[data-sec]');
    if (!el || el.parentNode !== rail) return;
    e.preventDefault();
    const vis = visible(), i = vis.indexOf(el);
    if (i < 0) return;
    if (up && i > 0) rail.insertBefore(el, vis[i - 1]);
    else if (down && i < vis.length - 1) rail.insertBefore(el, vis[i + 1].nextSibling);
    else return;
    writeOrder();
    g.focus();
  }

  function init() {
    rail = document.getElementById('rail');
    if (!rail) return;
    defaultOrder = sections().map(el => el.dataset.sec);
    if (!defaultOrder.length) return;
    applyOrder(readOrder());

    rail.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);
    window.addEventListener('blur', endDrag);                   // losing the window must not leave a panel stuck mid-drag
    // Capture phase: cancel the click BEFORE <summary>'s activation behaviour runs, so releasing a
    // drag (or a plain click on the handle) never expands or collapses the panel.
    rail.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.grip')) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    rail.addEventListener('keydown', onKeyDown);

    const reset = document.getElementById('btnResetLayout');
    if (reset) reset.onclick = resetOrder;
  }
  window.addEventListener('DOMContentLoaded', init);
})();
