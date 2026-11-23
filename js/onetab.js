// onetab.js — one working page of the annotator per browser.
//
// Two pages of this tool in one browser share the browser's record of unsaved work and write the same files;
// working in both is how a frame ends up with two versions. So only ONE page works. The first page to arrive
// holds a Web Lock for as long as it lives. A later page is not started at all — app.js's init() is not run,
// so nothing in it is wired: no folder can be opened and nothing can be written from it — and shows a notice
// instead. It starts when the working page is gone:
//   * while it is on screen it waits in line for the lock, so closing the other tab is enough;
//   * while it is hidden it does NOT wait. Otherwise a forgotten background tab would take the lock in the
//     moment the working tab is reloaded, and the tab the user is looking at would come back blocked.
//
// What this cannot see: another browser, another browser profile or a private window (they share nothing
// with this one), another computer, and a page of a version from before this file existed. The folder-level
// protections in app.js are still there for those. Where Web Locks are missing or refuse the first request,
// the page starts as it always did: the check must never be the reason the tool cannot be used.
(function () {
  'use strict';
  const NAME = 'collateral-annotator::working-page';
  let called = false;

  // The notice, and the page behind it out of reach (the page was never started, but the help panel and the
  // sidebar order have handlers of their own; `inert` also keeps the keyboard out).
  let shown = false;
  function notice(on) {
    if (on === shown) return;
    shown = on;
    // Whether a page is started never depends on this having worked: a failure here is reported and passed over.
    try {
      const m = document.getElementById('oneTabModal');
      if (on && window.I18n) window.I18n.applyStatic();      // init() has not run: the texts are still untranslated
      const kids = document.body ? Array.prototype.slice.call(document.body.children) : [];
      for (const el of kids) {
        if (el === m || el.tagName === 'SCRIPT') continue;
        if (on) el.setAttribute('inert', ''); else el.removeAttribute('inert');
      }
      if (m) m.classList.toggle('hidden', !on);
    } catch (e) { setTimeout(() => { throw e; }, 0); }
  }

  // run(start): call start() once — now if this is the only page, otherwise when it has become the only one.
  function run(start) {
    if (called) return;
    called = true;
    let started = false, waiting = null, busy = false;       // busy: another page was found working
    const hold = () => new Promise(() => { });               // never settles: the lock goes when the page goes
    const onVisibility = () => { if (document.hidden) leave(); else wait(); };
    function go() {
      if (started) return;
      started = true;
      document.removeEventListener('visibilitychange', onVisibility);
      notice(false);
      // A start that throws must not give the lock back (the page is half wired, another one must not start
      // next to it); the error is still reported, from a task of its own.
      try { start(); } catch (e) { setTimeout(() => { throw e; }, 0); }
    }
    const locks = typeof navigator !== 'undefined' && navigator.locks;
    if (!locks || !locks.request) { go(); return; }

    function wait() {                                          // in line for the lock, while on screen
      if (started || waiting || document.hidden) return;
      const ac = waiting = new AbortController();
      const out = () => { if (waiting === ac) waiting = null; };   // left the line (hidden), or the request failed: still blocked
      let asked;
      try { asked = locks.request(NAME, { signal: ac.signal }, () => { out(); go(); return hold(); }); } catch (e) { out(); return; }
      if (asked && asked.catch) asked.catch(out);
    }
    function leave() { if (waiting) { const ac = waiting; waiting = null; ac.abort(); } }

    let first;
    try {
      first = locks.request(NAME, { ifAvailable: true }, lock => {
        if (lock) { go(); return hold(); }
        busy = true;                                           // another page is working
        notice(true);
        document.addEventListener('visibilitychange', onVisibility);
        wait();
        return undefined;
      });
    } catch (e) { go(); return; }
    // Web Locks refused before saying anything: start unchecked. Once another page is known to be working,
    // nothing that goes wrong afterwards may start this one.
    if (first && first.catch) first.catch(() => { if (!busy) go(); });
  }

  window.OneTab = { run, LOCK_NAME: NAME };
})();
