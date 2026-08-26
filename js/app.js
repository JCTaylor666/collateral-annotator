// app.js — wires the UI: open folder, render a unit, click-to-toggle segments,
// hover readout, navigation, save annotation.json into each unit folder.
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const State = window.State, Loader = window.Loader, FS = window.FS, I18n = window.I18n;

  let rootHandle = null, cases = [], ci = 0, ui = 0;
  let view = null, cur = null, hovRAF = false;
  const cache = new Map();
  const perfCache = new Map();                 // caseId -> { fields, rendered, radius } | 'failed' (arrival-time fields cached once; coloured on demand at the current smoothness)
  // Decision 4.3-A: the cache is BOUNDED now (it kept every visited case's fields forever — ~27 MB per
  // case, ~8.7 GB across a fully browsed V1). Map insertion order is the recency order: reads re-insert,
  // and after every store the oldest entries beyond the cap are dropped (never the case on screen —
  // evicting the map the doctor is looking at would force a 1-3 s recompute on their next slider move).
  const PERF_CACHE_MAX = 4;
  function perfTouch(id) { const v = perfCache.get(id); if (v !== undefined) { perfCache.delete(id); perfCache.set(id, v); } return v; }
  function perfPut(id, v) {
    perfCache.delete(id); perfCache.set(id, v);
    const keep = curCase() && curCase().id;
    for (const k of perfCache.keys()) {
      if (perfCache.size <= PERF_CACHE_MAX) break;
      if (k === id || k === keep) continue;
      perfCache.delete(k);
    }
  }
  let saveTimer = null, pendingSave = null;   // debounced auto-write-to-disk
  let classes = [];                           // dataset class defs [{index,name}] from classes.json
  let classesFileCorrupt = false;             // classes.json exists but is unparseable — don't auto-overwrite it
  let classesIndexBad = false, classesBadCount = 0;   // 4.7: parseable but with index<1 entries (dropped; same no-auto-rewrite protection, its own banner)
  let lastScanConflicts = 0;                  // # frames the last open found conflicted (newer differing file on disk)
  // Decision 4.2: frames whose file on disk is NEWER than this session's dirty copy AND differs in content.
  // Nothing is auto-resolved any more: the frame keeps BOTH versions (local in State, disk untouched),
  // every write path refuses to touch its annotation.json, and OPENING the frame shows a two-thumbnail
  // chooser. value = { ann, note, annMtime } parsed at detection, or null when detected by the write path
  // (the dialog re-reads lazily).
  const conflictedUnits = new Map();          // State.key() -> {ann, note, annMtime} | null
  let openGen = 0;                            // bumped per COMMITTED openFolder: stale async work (background scan / prefetch / late reads) must never touch the new dataset
  let dsToken = {};                           // identity of the dataset currently open. Replaced ONLY at the commit point in openFolderTxn(), so a cancelled/failed/empty Open aborts nothing that is already running.
  let openBusy = false;                       // an Open is between the picker and its commit: navigation must not resurrect the dataset being replaced, and a second Open must not interleave with this one
  let scanTotal = 0, scanDone = 0;            // background-scan progress (rendered into #scanProg, NOT the banner)
  const sessionLoaded = new Set();            // State.key() of units already disk-reconciled THIS session by loadCur — the background scan skips them (re-resetting would wipe the user's undo history)
  const inflightLoads = new Map();            // State.key() -> Promise<data>: dedups pixel reads between loadCur / prefetch / writeUnit
  const writingUnits = new Map();             // State.key() -> number of writes QUEUED OR IN FLIGHT for that unit — the stale-dirty reconcile must not race a save (.has() reads unchanged; counted so a write waiting its turn is visible too, not just the one running)
  const writeChain = new Map();               // State.key() -> promise of the last queued write for that unit: ONE writer per unit, in call order
  const retryQ = new Map();                   // State.key() -> { caseId, unit, tok, tries } for writes that FAILED and are waiting to be retried
  let retryTimer = null;                      // the single timer that drives retryQ
  const ownWriteAt = new Map();               // State.key() -> ms of OUR last successful annotation write: a file mtime ≤ this+margin is our own write, never "externally newer"
  const lastSeenMtime = new Map();            // State.key() -> annotation.json mtime at our last reconcile: unchanged mtime on a clean revisit ⇒ skip the reset (preserves undo history)
  const prefetchCold = new Set();             // cache keys inserted by PREFETCH and never yet viewed — evicted before anything the user actually looked at
  let cacheCap = 64;                          // LRU capacity — BYTE-aware: min(count formula, ~900MB ÷ real per-frame bytes), refined as frames load
  let maxSeqLen = 0;                          // largest sequence (frame count) in the open dataset
  let maxPxSeen = 0;                          // largest W×H actually loaded — real frames can be 1432², not the 512² of test data
  const corruptUnits = new Set();             // State.key() of units whose annotation.json is present but unparseable
  const corruptBackedUp = new Set();          // …of those, the ones already copied to annotation.json.corrupt
  let copyPickMode = false;                    // true while waiting for the user to pick a frame to copy from
  const PALETTE = ['#e5484d', '#1d9e75', '#3b7dd8', '#e5a50a', '#7c3aed', '#d6409f', '#0f9b8e', '#c2410c'];
  const UNCLASSIFIED_RGB = [39, 174, 96];     // green fallback for segments with no class
  const SNAP_SCREEN_R = 14;                   // magnetic-snap reach (screen px) for single-click select
  let snapTarget = null;                      // {seg,x,y} nearest segment under the cursor (magnetic snap preview)
  let curGeom = null;                         // current unit's geometry.json ({metrics,values,filter,raw}) or null
  let geomLo = 0, geomHi = 0, geomMin = 0, geomMax = 0, geomMetric = null;   // active metric name + its data range [lo,hi] and filter window [min,max]
  let geomSaveTimer = null;
  const pendingGeom = new Map();   // unitKey -> {unit, raw}: debounced write-back of each edited unit's radius window into geometry.json

  // inspect (Cmd/Ctrl loupe) state — the loupe is a side panel only; annotation
  // and hover keep working normally while inspecting.
  let inspect = false, overCanvas = false;
  // Controls that legitimately consume a space keypress. A range slider and a checkbox do not type,
  // so Space over the canvas must still arm the pan even when one of them holds focus (ui-3).
  const isTextEntry = t => !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable ||
    (t.tagName === 'INPUT' && !/^(range|checkbox|radio|button|submit|reset|file|color|image)$/.test((t.type || 'text').toLowerCase())));
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
  let selPendingDeltas = null;   // sp-5: this drag's not-yet-painted membership changes, flushed once per rAF via view.selApplyDelta
  let markerArm = false;   // true while waiting for the user to click the image to place a note marker
  let navGen = 0;          // bumped each showUnit; a stale (slow) load must not clobber a newer navigation
  let navBusy = false;     // a frame load is in flight: block new strokes (they'd straddle the old/new frame)
  let perfSmoothRAF = false;   // coalesce perfusion re-colours while dragging the smoothness slider

  const curCase = () => cases[ci];
  const curUnit = () => curCase() && curCase().units[ui];

  let lastBanner = null;   // { key, vars, kind } | null — replayed on language switch
  // #banner is an in-flow block between the header and .body, so showing it (or hiding it, or a message
  // wrapping onto a second line) changes the height of .stage and therefore of #view. layout() is what
  // sizes the canvas backing store and the dpr transform; without it the backing store keeps the OLD
  // height while eventToImage() maps the pointer through the NEW bounding rect, so every click and hover
  // resolves to an image row above the one under the cursor (~35 image px on a 1432² frame).
  // Re-layout only when the height ACTUALLY changed: calling onResize() on every banner text change would
  // re-clamp the pan and make the image visibly jump while the doctor is working.
  // Banner ARBITRATION (M7 / ORDER-5): the banner is a single slot, and before this ANY later message
  // replaced whatever was showing — a doctor could lose "write FAILED" to a routine "Saved 3" two
  // seconds later while looking at the image. Three priorities now:
  //   2  critical warnings (write/save failures, conflicts, quota, permission, open failures, classes
  //      trouble, a failed frame load) — sticky: only another critical message, an explicit
  //      setBanner(null) (incl. clearUnitBanner on navigation for per-unit keys), or the doctor's own
  //      ✕ can take the slot;
  //   1  ordinary warnings;   0  'ok' confirmations.
  // A lower-priority message arriving while a critical one is up is DROPPED (its information is either
  // repeated elsewhere — save modal, status line — or strictly less important than what it would hide).
  // The set also contains the RESOLUTION messages of critical situations (classesReplaced, conflictKept*):
  // they must be able to take the slot from the warning they retire — P0-9's own gate caught that leaving
  // them ordinary lets a stale "left untouched" banner keep lying after the file was in fact replaced.
  const BANNER_CRITICAL = new Set(['writeFailedBanner', 'saveAborted', 'savedPartial', 'saveFailedMsg',
    'errQuotaFull', 'multiTabWarn', 'errNoWritePermission', 'errOpenFailed', 'errUnsupportedBrowser',
    'classesBackupFailed', 'classesIndexZero', 'classesCorrupt', 'classesReplaced',
    'conflictFoundFmt', 'conflictScanFmt', 'conflictKeptDisk', 'conflictKeptDiskNoBackup',
    'conflictKeptLocal', 'conflictKeptLocalNoBackup', 'errLoadUnitFailed']);
  const bannerPrio = (key, kind) => key == null ? -1 : (BANNER_CRITICAL.has(key) ? 2 : (kind === 'ok' ? 0 : 1));
  function setBanner(key, vars, kind) {
    const b = $('banner');
    if (key && lastBanner && bannerPrio(lastBanner.key, lastBanner.kind) === 2 && bannerPrio(key, kind) < 2) return;
    const txt = key ? I18n.t(key, vars) : '';
    const cls = 'banner' + (key ? (kind ? ' ' + kind : '') : ' hidden');
    lastBanner = key ? { key, vars, kind } : null;
    const h0 = view ? $('view').clientHeight : 0;
    b.textContent = txt;
    if (key && bannerPrio(key, kind) === 2) {   // critical messages are dismissable by hand — sticky must never mean stuck
      const x = document.createElement('span');
      x.className = 'banner-x'; x.textContent = '✕'; x.title = I18n.t('bannerDismiss');
      x.onclick = () => setBanner(null);
      b.appendChild(x);
    }
    b.className = cls;
    if (view && $('view').clientHeight !== h0) onResize();
  }
  // Per-unit warnings (shape mismatch / corrupt annotation / broken mask) describe ONE frame — they
  // must not linger after navigating away. Cleared at the start of every navigation; each unit that
  // still has the condition re-sets its own banner.
  function clearUnitBanner() {
    const perUnit = ['shapeMismatchBanner', 'annCorrupt', 'annUnreadable', 'annLayersDropped', 'maskBad', 'paintSizeBad', 'errLoadUnitFailed', 'perfFailed', 'perfMaskUnavailable'];
    if (lastBanner && perUnit.indexOf(lastBanner.key) >= 0) setBanner(null);
  }

  // A stable per-dataset id lives in a hidden .annotator_dataset.json at the folder root, so
  // localStorage state can be tied to the dataset it came from (never bleed across folders that
  // reuse case_N/frame_M names). Read it; create it on first open. Best-effort: if it can't be
  // written (no permission yet), fall back to a folder-name id for this session.
  async function ensureDatasetId(root) {
    const FNAME = '.annotator_dataset.json';
    let fh = null;
    try { fh = await root.getFileHandle(FNAME); } catch (e) { /* truly absent — create one below */ }
    if (fh) {
      // File EXISTS. If it parses, use its id. If it's present-but-unreadable (corrupt, or a transient
      // Google-Drive sync glitch), return a STABLE name-based id and DON'T overwrite it with a fresh
      // random id — minting a new id here would make switchDataset wipe all unsaved state.
      try {
        const o = JSON.parse(await (await fh.getFile()).text());
        if (o && typeof o.id === 'string' && o.id) return o.id;
      } catch (e) { /* present but unparseable */ }
      return 'name:' + (root.name || 'unknown');
    }
    const id = (self.crypto && crypto.randomUUID) ? crypto.randomUUID() : ('ds-' + Date.now() + '-' + Math.floor(Math.random() * 1e9));
    try { await FS.writeText(root, FNAME, JSON.stringify({ id, created: new Date().toISOString() }, null, 2)); return id; }
    catch (e) { return 'name:' + (root.name || 'unknown'); }
  }

  // Opening a folder is a TRANSACTION. Everything is read and validated into LOCALS first; the module
  // state (rootHandle / cases / classes / dsToken / openGen / State) is replaced in ONE synchronous commit
  // block at the end. A cancelled, failed or case-less pick therefore changes NOTHING: no half-switched
  // rootHandle whose classes.json writes land in the wrong folder, no empty `cases` behind a still-clickable
  // frame list, and no generation bump that would abort a Save / class deletion the doctor started earlier.
  // Never throws. Returns the deferred UI action for openFolder(): null | { restore } | { show, sw }.
  async function openFolderTxn() {
    let prevView = null, sw = null, committed = false;
    try {
      const newRoot = await FS.pickDirectory();
      // Considering the switch. Freeze annotation NOW: the old frame stays visible through the (slow, async)
      // reads below, and a click landing after switchDataset() wipes State would autosave a near-empty file
      // over the OLD dataset's annotation.json via the captured handle — and leak stray marks into the new one.
      commitActiveStroke();
      await flushAutoSave();                 // write any just-committed stroke to the OLD folder before the wipe
      prevView = { had: !!cur, ci, ui };
      // Invalidate any in-flight showUnit: a slow (Google-Drive) loadCur resolving during the reads below
      // would otherwise pass its `gen === navGen` gate and resurrect the OLD unit into `cur`. The openBusy
      // gate our caller set (synchronously, before any await) keeps NEW navigation from un-freezing it.
      cur = null; navGen++; exitCopyPick(); exitMarkerArm();
      $('note').disabled = true; updateCopyBtn();
      // Different dataset while frames are still UNSAVED? Ask BEFORE the wipe — the after-the-fact
      // "discarded" banner can't bring the work back. Cancel restores the frozen view untouched.
      const newId = await ensureDatasetId(newRoot);
      if (newId !== State.getDatasetId() && State.dirtyCount() > 0 &&
          !confirm(I18n.t('confirmSwitchDirty', { n: State.dirtyCount() }))) return { restore: prevView };
      const found = await Loader.discover(newRoot);
      // Nothing is committed yet, so an unusable pick leaves the dataset that IS open fully alive: its rows
      // still navigate, its classes.json is still the one that gets written.
      if (!found.length) { setBanner('errNoCases', null, 'warn'); return { restore: prevView }; }
      const cls = await Loader.loadClasses(newRoot);
      // ------------------ COMMIT (synchronous: no await until the end of this block) ------------------
      for (const c of found) c.units.push({ id: 'perfusion', kind: 'perfusion', virtual: true });   // computed view-only unit after minip
      rootHandle = newRoot; cases = found;
      // Decision 4.7-B: class indices must be >= 1. Index 0 is the paint layer's "unpainted" value, so a
      // class 0 brush is a silent no-op on empty pixels and a silent ERASER over existing paint. Offending
      // entries are dropped with a banner, and the file is treated like a corrupt one: nothing rewrites it
      // automatically — fixing it is the user's (pipeline's) call.
      const badIdx = cls.list.filter(x => !(Number.isFinite(x.index) && x.index >= 1));
      classes = cls.list.filter(x => Number.isFinite(x.index) && x.index >= 1);
      classesFileCorrupt = !cls.ok || badIdx.length > 0; classesBackedUp = false; classesOverwriteOK = false;
      classesIndexBad = cls.ok && badIdx.length > 0; classesBadCount = badIdx.length;   // parseable but with index<1 entries: same protection, its own (accurate) banner
      dsToken = {};                             // new dataset identity: work still running against the previous one aborts from here
      openGen++;                                // bumped WITH rootHandle, never before it: the old dataset's scan/prefetch/late reconciles go inert, and a cancelled Open now aborts nothing
      committed = true;
      scanTotal = 0; scanDone = 0; updateScanProg();   // the old scan is dead — its progress text must not linger
      perfCache.clear(); perfInflight.clear();
      corruptUnits.clear(); corruptBackedUp.clear();
      sw = State.switchDataset(newId);          // wipe any carryover from a different dataset
      cache.clear(); prefetchCold.clear(); inflightLoads.clear(); sessionLoaded.clear(); ownWriteAt.clear(); lastSeenMtime.clear(); conflictedUnits.clear(); rescueFound.clear();
      retryQ.clear(); if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }   // pending retries belong to the dataset we just closed (State for it is wiped below): they can never be written
      window.Loupe.reset(); ci = 0; ui = 0; buildCaseOptions();
      // adaptive LRU capacity: count-based first, tightened by real frame bytes as they load
      maxSeqLen = cases.reduce((m, c) => Math.max(m, c.units.filter(un => !un.virtual).length), 0);
      maxPxSeen = 0; recomputeCacheCap();
      ensureActiveClass();                      // classes.json is already loaded; the scan may ADD missing ones when it finishes
      buildClassMgr(); buildClassPicker();
      setBanner(null);
      // ---------------------------------- end COMMIT ----------------------------------
      return { show: true, sw };
    } catch (e) {
      if (committed) return { show: true, sw };                     // the synchronous commit already ran: the new dataset IS open
      if (!(e && e.name === 'AbortError')) setBanner('errOpenFailed', { msg: e.message }, 'warn');   // AbortError = the doctor closed the picker
      return prevView ? { restore: prevView } : null;               // nothing was committed — put the frozen view back
    }
  }
  async function openFolder() {
    if (openBusy) return;                       // re-entrancy: set synchronously below, BEFORE the first await, so a second click (or a second Open from anywhere) cannot start a competing transaction whose late completion would decide which dataset is open
    openBusy = true; $('btnOpen').disabled = true;
    flushAutoSave(); flushGeomWrite(true);      // persist any pending edits to the CURRENT dataset before we switch away
    let act;
    try { act = await openFolderTxn(); }
    finally { openBusy = false; $('btnOpen').disabled = !FS.supported; }   // release the gate BEFORE the showUnit calls below — they must not be blocked by it
    if (!act) return;                           // picker cancelled and nothing was open — nothing to restore
    if (act.restore) {
      if (act.restore.had) await showUnit(act.restore.ci, act.restore.ui);   // un-freeze: back to the dataset that is still open
      return;                                   // openGen never moved, so that dataset's background scan is still running — do NOT start a second one
    }
    const okUnit = await showUnit(0, 0);        // show the FIRST frame immediately — loadCur reconciles it from disk itself, no need to wait for the scan
    // higher-priority open-time warnings take precedence — but never clobber a load-failure banner
    if (okUnit) {
      if (classesIndexBad) setBanner('classesIndexZero', { n: classesBadCount }, 'warn');
      else if (classesFileCorrupt) setBanner('classesCorrupt', null, 'warn');
      else if (act.sw && act.sw.switched && act.sw.hadDirty) setBanner('datasetSwitched', null, 'warn');
    }
    startBackgroundScan();                      // badges / copy-sources / class auto-add fill in behind the first frame
  }

  // ---- bounded LRU over `cache` (PIXEL data only: decoded image + label + mask; ~2.5MB/frame at 800²).
  // Map iteration order = insertion order; touching re-inserts at the hot end. Prefetched-but-never-viewed
  // entries evict first, then oldest; the currently displayed frame never evicts. Annotations do NOT live
  // here — they are in State, always reconciled from disk on show, so eviction can never lose annotation data.
  function cacheTouch(k) {
    const v = cache.get(k); if (v === undefined) return undefined;
    prefetchCold.delete(k);                                   // it's being USED now — promote out of the cold tier
    cache.delete(k); cache.set(k, v);
    return v;
  }
  function recomputeCacheCap() {
    // per cached frame ≈ label(2B/px) + mask(1B/px) + decoded image (~4B/px) ⇒ ~7B/px; budget ~900MB.
    const byteCap = maxPxSeen ? Math.floor(900e6 / (maxPxSeen * 7)) : 192;
    const want = Math.min(3 * maxSeqLen + 16, byteCap);
    const floor_ = Math.min(192, Math.max(16, maxSeqLen + 8));   // always hold the longest live sequence + margin (anti-thrash)
    cacheCap = Math.min(192, Math.max(floor_, want));
  }
  function cacheInsert(k, data, cold) {
    if (cache.has(k)) cache.delete(k);
    cache.set(k, data);
    if (cold) prefetchCold.add(k); else prefetchCold.delete(k);
    if (data && data.W && data.H && data.W * data.H > maxPxSeen) { maxPxSeen = data.W * data.H; recomputeCacheCap(); }   // big real frames shrink the cap
    evictOver();
  }
  // M11: eviction is PURE RECENCY now. The old cold-first policy ("evict unviewed prefetches before
  // anything the user looked at") sounded protective but measured pathological: the cold tier is
  // precisely the freshly-prefetched next frames, so prefetching frame N+3 evicted the just-prefetched
  // N+1/N+2 while long-abandoned viewed frames survived — 237 of 297 loads in a 60-frame walk were
  // redundant re-reads of evicted prefetches. Map insertion order IS the recency order (cacheTouch
  // re-inserts on use), so evicting from the front drops the genuinely least-recent entry, whatever its
  // tier; a fresh prefetch is at the back and survives. The displayed frame is never evicted.
  function evictOver() {
    if (cache.size <= cacheCap) return;
    const curKey = cur ? State.key(cur.caseId, cur.unitId) : null;
    for (const k of cache.keys()) {
      if (cache.size <= cacheCap) return;
      if (k === curKey) continue;
      cache.delete(k); prefetchCold.delete(k);
    }
  }
  // one shared pixel-read path so loadCur / prefetch / writeUnit never double-read the same unit,
  // and a late read from a switched-away dataset can never pollute the new dataset's cache.
  function loadUnitCached(u, k, cold) {
    const hit = cacheTouch(k); if (hit !== undefined) return Promise.resolve(hit);
    let p = inflightLoads.get(k);
    if (!p) {
      const gen = openGen;
      p = Loader.loadUnit(u).then(data => {
        inflightLoads.delete(k);
        if (gen === openGen) cacheInsert(k, data, cold);
        return data;
      }, err => { inflightLoads.delete(k); throw err; });
      inflightLoads.set(k, p);
    } else if (!cold) p.then(() => { if (cache.has(k)) cacheTouch(k); }, () => { });   // a real view promotes a pending prefetch (rejection handled by the primary caller)
    return p;
  }

  // The FILE's own lastModified, read back after a write. Google Drive stamps its own (server) clock, which
  // can sit further from this machine's clock than the ±2 s margin the reconcile allows — so the stamp we
  // compare against must be the number the file itself will report. Best effort: 0 when it cannot be read.
  async function annFileMtime(unit) {
    try { return (await (await unit.handle.getFileHandle('annotation.json')).getFile()).lastModified || 0; }
    catch (e) { return 0; }
  }
  // "Our own write" time for a unit: the session map, plus the PERSISTED stamp so the very first reconcile
  // after a reload still recognises our own file instead of calling it an external change.
  const ownWriteMs = (c, u, k) => Math.max(ownWriteAt.get(k) || 0, State.getWrittenAt(c, u) || 0);
  // canonical NOTE-content signature (text + markers as internal [x,y], any coord_order): null/absent == empty
  function noteContentSig(n) {
    if (!n || typeof n !== 'object') return JSON.stringify({ t: '', m: [] });
    const order = n.coord_order === 'yx' ? 'yx' : 'xy';
    const conv = c2 => (Array.isArray(c2) && c2.length === 2) ? (order === 'xy' ? [c2[0], c2[1]] : [c2[1], c2[0]]) : null;
    const mks = Array.isArray(n.markers) ? n.markers.map(m => ({ id: m && m.id, p: conv(m && m.click) })) : [];
    return JSON.stringify({ t: typeof n.text === 'string' ? n.text : '', m: mks });
  }
  // Reconcile ONE unit's State from its on-disk annotation. Shared by loadCur (the frame being shown) and
  // the background scan (unvisited frames). NEVER discards silently: if a needed sidecar write fails, the
  // local (dirty) copy is kept. Returns exactly one of:
  //   'clean'            State was not dirty and now mirrors the file
  //   'kept-dirty'       the local copy wins (it is newer, or a save of this unit is in flight)
  //   'stale-clean'      the file is newer but its CONTENT equals the local copy — adopted silently
  //   'conflict'         the file is newer AND differs: recorded in conflictedUnits, NOTHING auto-resolved —
  //                      writers refuse the unit and opening the frame shows the two-version chooser (4.2)
  //   'aborted'          a DIFFERENT dataset was opened meanwhile — State is foreign now, nothing was touched
  // Only 'clean' / 'stale-*' / 'kept-dirty' mean "State is authoritative for this unit"; 'aborted' does not.
  async function reconcileUnitFromDisk(c, u, ann, note, annMtime) {
    const tok = dsToken, k = State.key(c.id, u.id);
    if (!State.isDirty(c.id, u.id)) {
      State.resetUnit(c.id, u.id);
      try { if (ann) State.importAnnotation(c.id, u.id, ann); if (note) State.importNoteJson(c.id, u.id, note); } catch (e) { }   // one malformed file must not abort the load
      return 'clean';
    }
    const ea = State.getEditedAt(c.id, u.id);
    if (!(ann && annMtime && ea && annMtime > ea)) return 'kept-dirty';
    if (annMtime <= ownWriteMs(c.id, u.id, k) + 2000) return 'kept-dirty';   // the "newer" file is OUR OWN recent write — an edit that landed during it must not be reverted as stale (persisted, so this still holds after a reload)
    if (writingUnits.has(k)) return 'kept-dirty';             // a save of this unit is in flight — its write will settle disk vs local, don't race it
    // Dirty flag looks stale (disk written after our last recorded edit). mtime can lie (folder copy /
    // cloud re-sync), so compare CONTENT first: an identical file is adopted silently — no dialog noise
    // for a Drive re-sync that only touched the timestamp.
    let same = true;
    try {
      const sz = (Array.isArray(ann.image_size) && ann.image_size.length === 2) ? ann.image_size : [0, 0];
      const localAnn = State.buildAnnotation(c.id, u.id, sz[0], sz[1]);
      if (annContentSig(localAnn) !== annContentSig(ann)) same = false;
      if (State.hasNoteData(c.id, u.id) && noteContentSig(State.buildNote(c.id, u.id)) !== noteContentSig(note)) same = false;
    } catch (e) { return 'kept-dirty'; }
    if (same) {
      State.resetUnit(c.id, u.id);
      try { State.importAnnotation(c.id, u.id, ann); if (note) State.importNoteJson(c.id, u.id, note); } catch (e) { }
      State.markClean(c.id, u.id, undefined, annMtime);   // State mirrors the file as of annMtime
      return 'stale-clean';
    }
    // Decision 4.2: genuinely different versions are NEVER auto-resolved. Both survive — local stays in
    // State (and in the dirty-frame mirror), the file stays untouched on disk, every writer refuses this
    // unit — and opening the frame shows the two-version chooser. Backups are written at RESOLUTION time,
    // for whichever side the doctor does not keep.
    conflictedUnits.set(k, { ann, note, annMtime });
    return 'conflict';
  }
  // Seed a unit's State from disk if this session never did (star-click / Save reaching a frame the
  // background scan hasn't touched yet, on a browser with no localStorage for this dataset — building
  // from unseeded State would overwrite the on-disk annotation with an EMPTY one).
  //
  // CONTRACT — returns exactly one of:
  //   'already'     this session had already reconciled the unit; State is authoritative
  //   'seeded'      just read from disk and reconciled; State is authoritative
  //   'aborted'     a different dataset was opened during the read; State is NOT authoritative
  //   'unreadable'  the annotation file EXISTS but could not be read (or the read threw); State is NOT
  //                 authoritative. Deliberately NOT the same as "absent": an absent file seeds empty+clean.
  // ONLY 'already' and 'seeded' permit a caller to write this unit. The two failure states deliberately do
  // NOT add the unit to sessionLoaded, so a later attempt (or the background scan) still seeds it properly.
  async function ensureSeeded(c, u) {
    const k = State.key(c.id, u.id), tok = dsToken;
    if (sessionLoaded.has(k)) return 'already';
    let r;
    try { r = await Loader.loadAnnotation(u); }
    catch (e) { return 'unreadable'; }                                     // I/O failure: never let the caller build over a file we could not read
    if (r.unreadable) return 'unreadable';                                 // …and the same when the read "succeeded" but the file could not be opened: seeding EMPTY here is what later lets a star/Save overwrite the real annotations
    if (tok !== dsToken) return 'aborted';                                 // folder switched during the read — this unit belongs to the OLD dataset
    if (r.annCorrupt || r.annDropped) corruptUnits.add(k); else corruptUnits.delete(k);   // keeps backupCorruptOnce's invariant — a later write must still .corrupt-backup the original (an unparseable one, or one whose layers this build cannot represent)
    const rec = await reconcileUnitFromDisk(c, u, r.annotation, r.note, r.mtime || 0);
    if (rec === 'aborted') return 'aborted';
    if (r.annDropped) setBanner('annLayersDropped', { id: u.id, n: r.annDropped }, 'warn');   // saving this frame back would shrink the file — say so before it happens
    lastSeenMtime.set(k, r.mtime || 0);
    sessionLoaded.add(k);
    return 'seeded';
  }

  async function loadCur() {
    const gen = openGen;
    const c = curCase(), u = curUnit(), k = State.key(c.id, u.id);
    let data = cacheTouch(k);
    if (data === undefined) data = await loadUnitCached(u, k, false);
    else if (!data.shapeMismatch) { const fresh = await Loader.loadAnnotation(u); data.annotation = fresh.annotation; data.annCorrupt = fresh.annCorrupt; data.annDropped = fresh.annDropped || 0; data.annUnreadable = !!fresh.unreadable; data.note = fresh.note; data.annMtime = fresh.mtime || 0; }
    if (data.shapeMismatch) return data;   // broken frame: no annotation state; shown as a view-only placeholder
    if (gen !== openGen) return data;      // a folder switch happened during the read — this unit belongs to the OLD dataset: no reconcile, no sessionLoaded (would pollute the new one)
    if (data.annUnreadable) return data;   // this frame's annotation.json exists but could not be read: do NOT reset State from it and do NOT mark the unit seeded — every write path re-reads first (and refuses meanwhile)
    if (data.annCorrupt || data.annDropped) corruptUnits.add(k); else corruptUnits.delete(k);
    const m = data.annMtime || 0;
    // clean revisit with the disk file unchanged since our last reconcile (or only changed by OUR OWN write):
    // State already equals disk — skip the reset so the frame's undo history survives navigation.
    const unchanged = sessionLoaded.has(k) && !State.isDirty(c.id, u.id) &&
      (m === (lastSeenMtime.get(k) || 0) || m <= ownWriteMs(c.id, u.id, k) + 2000);
    if (!unchanged) {
      // disk is the source of truth for CLEAN units; a provably-stale dirty flag reconciles WITH sidecar backups
      const rec = await reconcileUnitFromDisk(c, u, data.annotation, data.note, m);
      if (rec === 'aborted') return data;   // the dataset switched during the reconcile: never record a foreign unit in the NEW dataset's sessionLoaded/lastSeenMtime maps
    }
    lastSeenMtime.set(k, m);
    sessionLoaded.add(k);                  // background scan must skip this unit now (a re-reset would wipe undo history)
    return data;
  }

  // Analyze (once, cached) a case's arrival-time FIELDS from its raw frame grays, then colour on demand.
  // The expensive part (gather every frame's gray + per-pixel argmin) runs once; the smoothness slider
  // only re-colours (Perfusion.render) the cached fields — no re-read, no re-analyze.
  const perfInflight = new Map();   // caseId -> Promise (so concurrent callers share one computation)
  // rendered perfusion map at the CURRENT smoothness (lazy re-colour when the slider moved). null if not ready/failed.
  function perfView(c) {
    const e = perfTouch(c && c.id);
    if (!e || e === 'failed' || !e.fields) return null;
    const maskOn = State.getPerfMask();
    const m = (maskOn && e.minipMask && e.minipMask.mask && e.minipMask.W === e.fields.W && e.minipMask.H === e.fields.H) ? e.minipMask.mask : null;
    if (maskOn && !m) ensureMinipMask(c);                      // kick the lazy load; repaint happens on arrival
    const key = State.getPerfSmooth() + '|' + (m ? 'm' : 'u');
    if (!e.rendered || e.renderedKey !== key) { e.rendered = window.Perfusion.render(e.fields, State.getPerfSmooth(), m); e.renderedKey = key; }
    return e.rendered;
  }
  // lazily read the CASE's minip mask.npy (light: no PNG decode) for the perfusion filter; repaint on arrival
  function ensureMinipMask(c) {
    const e = perfTouch(c && c.id);
    if (!c || !e || e === 'failed' || e.minipMask !== undefined) return;   // undefined = never tried
    const minip = c.units.find(un => un.kind === 'minip');
    if (!minip) { e.minipMask = null; maybeWarnPerfMask(c); return; }
    e.minipMask = 'pending';
    const gen = openGen;
    Loader.loadMask(minip).then(m => {
      if (gen !== openGen) return;
      const e2 = perfTouch(c.id); if (!e2 || e2 === 'failed') return;
      e2.minipMask = m;                                        // null = absent/unreadable
      if (cur && cur.virtual && cur.caseId === c.id) { const pv = perfView(c); if (pv) paintPerfIntoView(pv); maybeWarnPerfMask(c); }
      if (inspect) { stripSig = ''; scheduleLoupe(); }
    });
  }
  function maybeWarnPerfMask(c) {   // showing the perfusion unit with the filter ON but no usable minip mask
    if (!cur || !cur.virtual || !c || cur.caseId !== c.id || !State.getPerfMask()) return;
    // a cosmetic per-unit hint must never replace a data-safety banner (failed write / backed-up edits / quota)
    if (lastBanner && ['writeFailedBanner', 'unsavedBackedUp', 'errQuotaFull', 'multiTabWarn', 'savedPartial'].indexOf(lastBanner.key) >= 0) return;
    const e = perfTouch(c.id);
    const m = e && e !== 'failed' && e.minipMask;
    const usable = m && m.mask && e.fields && m.W === e.fields.W && m.H === e.fields.H;
    if (m !== undefined && m !== 'pending' && !usable) setBanner('perfMaskUnavailable', null, 'warn');
  }
  function ensureCasePerfusion(c) {
    if (!c) return Promise.resolve(null);
    const got = perfTouch(c.id);
    if (got === 'failed') return Promise.resolve(null);
    if (got && got.fields) return Promise.resolve(perfView(c));   // cached fields -> colour at current smoothness
    if (perfInflight.has(c.id)) return perfInflight.get(c.id);
    const pGen = openGen;
    const p = (async () => {
      try {
        const frames = c.units.filter(u => u.kind === 'frame');
        if (frames.length < 2) { perfPut(c.id, 'failed'); return null; }
        const grays = []; let W = 0, H = 0;
        for (const u of frames) {
          const g = await Loader.loadGray(u);
          if (!W) { W = g.W; H = g.H; }
          if (g.W !== W || g.H !== H) { perfPut(c.id, 'failed'); return null; }   // frames must share dimensions
          grays.push(g.gray);
        }
        const fields = window.Perfusion.analyze(grays, W, H);
        if (pGen !== openGen) return null;                    // dataset switched while computing — a reused case id must not show the OLD dataset's map
        if (!fields) { perfPut(c.id, 'failed'); return null; }
        perfPut(c.id, { fields, rendered: null, renderedKey: '' });
        const view = perfView(c);   // colour at the current smoothness
        if (inspect) scheduleLoupe();   // a pinned perfusion tile can now render
        return view;
      } catch (e) { perfPut(c.id, 'failed'); return null; }
      finally { perfInflight.delete(c.id); }
    })();
    perfInflight.set(c.id, p);
    return p;
  }
  const perfState = c => { const v = perfTouch(c && c.id); return v === 'failed' ? 'error' : (v && v.fields) ? 'ok' : 'loading'; };

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
  // Append every element of `src` onto `dst` WITHOUT spreading it into an argument list. A brush-select
  // stroke over a large painted segment produces one change record per cleared pixel, and `push(...src)`
  // throws RangeError past ~124k arguments (measured on V8) — which happened AFTER clearPaintInSegment had
  // already zeroed those pixels, leaving the canvas edited with no undo record so the next stroke persisted
  // the loss. 1432² needs only ~6% of the frame painted inside one segment to reach that limit.
  function appendAll(dst, src) { for (let i = 0; i < src.length; i++) dst.push(src[i]); }
  function selDab(x, y) {
    const sb = State.getSelBrush();
    try {
      if (sb.mode === 'erase') {                              // deselect brush also sweeps up background red dots under the circle
        const rm = State.removePointsInCircle(cur.caseId, cur.unitId, x, y, sb.radius);
        if (rm.length) appendAll(selPointChanges, rm);
      }
      for (const [seg, xy] of view.segsInBrush(x, y, sb.radius)) {
        if (!segVisible(seg)) continue;                       // honor the geometry filter: never select/deselect a hidden vessel
        if (selStrokeSegs.has(seg)) continue;                 // each segment handled once per drag
        selStrokeSegs.add(seg);
        if (sb.mode === 'add' && State.hasPaint(cur.caseId, cur.unitId)) {   // paint ⟂ selection: wipe paint under a newly-selected segment
          const pc = view.clearPaintInSegment(seg);
          if (pc.length) appendAll(selPaintChanges, pc);
        }
        const ch = State.brushSeg(cur.caseId, cur.unitId, seg, xy, State.getActiveClass(), sb.mode === 'erase');
        if (ch) { selChanges.push(ch); if (selPendingDeltas) selPendingDeltas.push({ seg, rgb: sb.mode === 'erase' ? null : segRgb(State.getActiveClass()) }); }
      }
    } catch (e) {
      // Never leave the canvas edited without a matching undo record: restore the view's paint from State
      // (the authoritative copy) and abort the stroke loudly instead of failing silently.
      try { view.setPaint(State.paintDense(cur.caseId, cur.unitId, cur.W, cur.H)); view.render(); } catch (e2) { }
      selecting = false; selStrokeSegs = null; selChanges = null; selPaintChanges = null; selPointChanges = null; selPendingDeltas = null;
      setBanner('errStrokeAborted', null, 'warn');
    }
  }
  // sp-5: paint ONLY the segments this drag changed since the last frame (no 8 MB ImageData allocation,
  // no full-layer loop), then refresh the red dots (erase sweeps them) and composite.
  function flushSelDeltas() {
    if (selPendingDeltas && selPendingDeltas.length) view.selApplyDelta(selPendingDeltas.splice(0));
    refreshDots();
    view.render();
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
    selStrokeSegs = null; selChanges = null; selPaintChanges = null; selPointChanges = null; selPendingDeltas = null;
  }

  // realign ci/ui to whatever unit is actually displayed (cur) — used after a load fails/is superseded so
  // the nav indicator can't point at a frame the canvas isn't showing.
  function syncNavToCur() {
    if (!cur) return false;
    const nc = cases.findIndex(c => c.id === cur.caseId); if (nc < 0) return false;
    const nu = cases[nc].units.findIndex(u => u.id === cur.unitId); if (nu < 0) return false;
    ci = nc; ui = nu; return true;
  }
  async function showUnit(nci, nui) {
    if (openBusy) return false;   // a folder switch is in flight: navigating now would un-freeze the dataset being replaced (its State is about to be wiped), and the next edit would autosave an EMPTY annotation into the OLD folder
    const tc = cases[nci], tu = tc && tc.units[nui];
    if (!tc || !tu) return false;   // no dataset, or a row left over from one: never index into an empty cases array (that used to throw on every click after a case-less Open)
    commitActiveStroke();     // never let a live stroke bleed onto the frame we're switching to
    exitCopyPick();           // leaving a frame cancels an in-progress copy-from-frame pick
    flushAutoSave();          // persist the outgoing unit before we move off it
    flushGeomWrite(false);    // persist the outgoing unit's radius window (if auto-save is on)
    const gen = ++navGen;     // overlapping (slow-disk) loads: only the newest navigation may apply
    const prevCi = ci, prevUi = ui;
    ci = nci; ui = nui;
    const c = curCase(), u = curUnit();
    clearUnitBanner();        // drop any stale per-unit warning from the frame we're leaving
    // Decision 4.3-A: perfusion is LAZY now. Entering a case no longer decodes every frame for a map
    // that may never be looked at (~18 full-frame decodes and ~27 MB per case; ~8.7 GB across V1).
    // It is computed on the three paths that actually SHOW it: opening the perfusion row, opening the
    // inspect loupe (whose pinned tile displays it), and exporting the PNG. First view waits 1-3 s
    // behind the existing nav-busy indicator; after that the (bounded) cache answers.
    if (u.virtual) return await showPerfusionUnit(c, u, gen, prevCi, prevUi);
    let data;
    navBusy = true; setNavBusy(true);
    try { data = await loadCur(); }
    catch (e) {
      if (gen !== navGen) return false;          // a newer navigation superseded this one — stay silent
      if (!syncNavToCur()) { ci = prevCi; ui = prevUi; }   // realign nav to the unit still on screen (fallback: previous)
      setBanner('errLoadUnitFailed', { id: u.id, msg: e.message }, 'warn');
      highlightNav();   // ui-5: the case dropdown / frame-list highlight jumped to the failed target on click — snap them back to what is actually on screen
      return false;
    }
    finally { navBusy = false; if (gen === navGen) setNavBusy(false); }   // a superseded load must leave the NEWEST navigation's busy hint alone
    if (gen !== navGen) return false;            // superseded while loading: drop this stale result entirely
    if (data.shapeMismatch) return showMismatchUnit(c, u, data);   // image/label/mask sizes disagree: grey placeholder
    State.markVisited(c.id, u.id);
    cur = { W: data.W, H: data.H, caseId: c.id, unitId: u.id, unit: u };
    curGeom = data.geometry || null;                          // per-segment radius (drives the geometry stats + filter panel)
    view.setUnit(data.img, data.W, data.H, data.label, data.mask);
    view.setPerfLegend(0);
    view.setSelected(selColorMap(), selFullSet());
    view.setPaint(State.paintDense(c.id, u.id, data.W, data.H));   // load brush paint layer
    refreshDots();
    exitMarkerArm(); refreshMarkers();
    view.layout(); view.render(); updateZoomReadout();
    refreshMeta(); buildFrameList(); refreshGeomPanel(); buildLayerBar();
    $('note').value = State.getNote(c.id, u.id); $('note').disabled = false;
    updateDirtyUI(); updateCopyBtn();
    if (conflictedUnits.has(State.key(c.id, u.id))) showConflictDialog(State.key(c.id, u.id));   // opening a conflicted frame asks which version to keep (4.2) — every revisit, until resolved
    else if (data.annUnreadable) setBanner('annUnreadable', { id: u.id }, 'warn');  // exists but unreadable: nothing is shown FROM it and nothing may be written OVER it
    else if (data.annCorrupt) setBanner('annCorrupt', { id: u.id }, 'warn');       // corrupt file preserved (backed up before any overwrite)
    else if (data.annDropped) setBanner('annLayersDropped', { id: u.id, n: data.annDropped }, 'warn');   // parts of the file cannot be represented by this build
    else if (data.maskBad) setBanner('maskBad', { id: u.id }, 'warn');        // mask present but broken: onmask constraint won't apply
    else {   // stored paint saved at a different size (ANY layer): hidden, and painting there will replace it
      const badPaint = State.getLayers(c.id, u.id).some(ly => { const p = State.readLayer(c.id, u.id, ly.id).paint; return p && p.width && p.height && (p.width !== data.W || p.height !== data.H); });
      if (badPaint) setBanner('paintSizeBad', { id: u.id }, 'warn');
    }
    checkRescueFiles(c, u);   // non-blocking: if rescue files exist, a banner with [View] appears once the listing lands (it defers to conflicts and critical warnings)
    if (inspect) { stripSig = ''; preloadCase(); scheduleLoupe(); }
    schedulePrefetch();       // warm the rest of this sequence + the next two (bounded, cold-tier, cancellable)
    return true;
  }

  // draw a perfusion map into the main canvas (shared by nav-in and the live smoothness slider). Keeps
  // zoom/pan (setUnit only re-fits on a dimension change) so re-colouring mid-drag doesn't jump the view.
  function paintPerfIntoView(perf) {
    const W = perf.W, H = perf.H;
    view.setUnit(perf.canvas, W, H, new Uint16Array(W * H), null, true);   // empty label, no mask, colour image as-is
    view.setPerfLegend(perf.frames);   // arrival-time colour legend (frame ticks)
    view.setSelected(new Map(), new Set()); view.setPaint(new Uint16Array(W * H));
    view.setDots([]); view.setMarkers([]); view.setSnapPreview(0, 0, false); view.setHovered(0);
    view.layout(); view.render(); updateZoomReadout();
  }
  // the computed, view-only perfusion unit: colour image, no label/mask/annotation
  async function showPerfusionUnit(c, u, gen, prevCi, prevUi) {
    navBusy = true; setNavBusy(true);
    let perf; try { perf = await ensureCasePerfusion(c); } finally { navBusy = false; if (gen === navGen) setNavBusy(false); }
    if (gen !== navGen) return false;                       // superseded by a newer navigation
    if (!perf) { ci = prevCi; ui = prevUi; setBanner('perfFailed', null, 'warn'); return false; }
    cur = { W: perf.W, H: perf.H, caseId: c.id, unitId: u.id, unit: u, virtual: true };
    curGeom = null; refreshGeomPanel();                     // perfusion unit has no geometry — hide the panel
    exitMarkerArm();
    paintPerfIntoView(perf);
    maybeWarnPerfMask(c);                                   // filter ON but minip mask known-unavailable for this case
    refreshMeta(); buildFrameList(); buildLayerBar();
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
    if (inspect) exitInspect();                              // a placeholder frame has no valid image for the loupe
    exitMarkerArm();
    view.layout(); view.render(); updateZoomReadout();
    refreshMeta(); buildFrameList(); buildLayerBar();
    $('note').value = ''; $('note').disabled = true;
    updateDirtyUI(); updateCopyBtn();
    setBanner('shapeMismatchBanner', { id: u.id }, 'warn');
    return true;
  }

  // Now that the header follows `cur`, a frame change shows NOTHING until the file has loaded — on a cold
  // Google-Drive folder that is seconds of silence. This is the feedback that the keypress/click registered.
  function setNavBusy(on) {
    const el = $('progress'); if (!el) return;
    if (on) el.textContent = I18n.t('navLoading');
    else if (cur) refreshMeta(); else el.textContent = '';
  }

  function refreshDots() {
    if (!cur) return;
    const segDots = geomActive()
      ? State.selectedSegs(cur.caseId, cur.unitId).filter(it => segVisible(it.seg) && it.xy && it.xy[0] >= 0 && it.xy[1] >= 0).map(it => it.xy)
      : State.selectedClicks(cur.caseId, cur.unitId);
    view.setDots(segDots.concat(State.pointList(cur.caseId, cur.unitId)));
  }
  function refreshCanvasSelection() {
    view.setSelected(selColorMap(), selFullSet());
    refreshDots();
    view.render();
  }

  // ---- layers (per-frame): switch / add / rename / delete ----
  function buildLayerBar() {
    const bar = $('layerBar'), sec = $('layerSec'); if (!bar || !sec) return;
    if (!cur || cur.virtual || cur.mismatch) { sec.classList.add('hidden'); bar.innerHTML = ''; return; }
    sec.classList.remove('hidden');
    const layers = State.getLayers(cur.caseId, cur.unitId), active = State.getActiveLayer(cur.caseId, cur.unitId);
    bar.innerHTML = '';
    for (const ly of layers) {
      const chip = document.createElement('div');
      chip.className = 'layer-chip' + (ly.id === active ? ' active' : '');
      const name = document.createElement('span'); name.className = 'lname'; name.textContent = ly.name; name.title = I18n.t('layerSwitchTitle');
      name.onclick = () => switchLayer(ly.id);
      const ed = document.createElement('span'); ed.className = 'led'; ed.textContent = '✎'; ed.title = I18n.t('layerRenameTitle');
      ed.onclick = e => { e.stopPropagation(); renameLayerAction(ly.id, ly.name); };
      const del = document.createElement('span'); del.className = 'lx'; del.textContent = '✕'; del.title = I18n.t('layerDeleteTitle');
      del.onclick = e => { e.stopPropagation(); deleteLayerAction(ly.id, ly.name); };
      chip.appendChild(name); chip.appendChild(ed); chip.appendChild(del);
      bar.appendChild(chip);
    }
  }
  function renderActiveLayer() {   // re-render the canvas for the current unit's ACTIVE layer (selection/paint/dots)
    if (!cur || cur.virtual || cur.mismatch) return;
    view.setPaint(State.paintDense(cur.caseId, cur.unitId, cur.W, cur.H));
    refreshCanvasSelection();   // setSelected(selColorMap) + refreshDots + render
    refreshMeta();
  }
  function switchLayer(id) {
    if (!cur || id === State.getActiveLayer(cur.caseId, cur.unitId)) return;
    commitActiveStroke();       // don't let a live paint stroke bleed onto the layer we switch to
    State.setActiveLayer(cur.caseId, cur.unitId, id);
    renderActiveLayer(); buildLayerBar(); updateDirtyUI(); updateCopyBtn();
  }
  function addLayerAction() {
    if (!cur || cur.virtual || cur.mismatch) return;
    commitActiveStroke();
    State.addLayer(cur.caseId, cur.unitId);   // creates an empty layer + switches active to it
    renderActiveLayer(); buildLayerBar(); updateDirtyUI(); highlightNav(); scheduleAutoSave();
  }
  function renameLayerAction(id, curName) {
    if (!cur) return;
    const name = prompt(I18n.t('layerRenamePrompt'), curName); if (name == null) return;
    State.renameLayer(cur.caseId, cur.unitId, id, name.trim() || curName);
    buildLayerBar(); updateDirtyUI(); scheduleAutoSave();
  }
  function deleteLayerAction(id, name) {
    if (!cur) return;
    if (!confirm(I18n.t('layerDeleteConfirm', { name }))) return;
    commitActiveStroke();
    State.deleteLayer(cur.caseId, cur.unitId, id);
    renderActiveLayer(); buildLayerBar(); updateDirtyUI(); highlightNav(); scheduleAutoSave();
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
  // Decision 4.5: the DISPLAY map above hides filtered-out segments, but the paint-exclusion set must be
  // the FULL selection — painting over a selected segment that the geometry filter merely hides would
  // write "segment 5 is a collateral" AND "segment 5's pixels are painted" into the same annotation.json,
  // the one break of the paint-⟂-selection invariant kept everywhere else.
  function selFullSet() {
    return cur ? new Set(State.selectedIds(cur.caseId, cur.unitId)) : new Set();
  }

  // ---- geometry (per-segment named metrics) stats + filter ----
  const geomActive = () => !!(curGeom && State.getGeomFilter());
  function segVal(seg) { const t = curGeom && geomMetric && curGeom.values[geomMetric]; const v = t && t[String(seg)]; return typeof v === 'number' ? v : null; }
  function segVisible(seg) {                                   // filter off, or seg has no value for the active metric -> always visible
    if (!geomActive()) return true;
    const r = segVal(seg);
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
    view.setSelected(selColorMap(), selFullSet());            // drop green highlight of hidden selected segs — but keep them paint-excluded (4.5)
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
    const okUnit = !!(cur && !cur.virtual && !cur.mismatch && curGeom && curGeom.metrics && curGeom.metrics.length);
    // only offer metrics that actually have a value on THIS frame's segments (a metric may be defined only
    // for ids absent from this label) — prevents selecting a valueless metric and saving a stale window.
    const segs = okUnit ? view.labelSegs() : [];
    const metrics = okUnit ? curGeom.metrics.filter(m => segs.some(s => typeof curGeom.values[m][String(s)] === 'number')) : [];
    if (!metrics.length) { panel.classList.add('hidden'); view.setVisibleSegs(null); return; }
    geomMetric = (curGeom.filter && curGeom.filter.metric && metrics.indexOf(curGeom.filter.metric) >= 0) ? curGeom.filter.metric : metrics[0];
    const sel = $('geomMetric');
    sel.innerHTML = '';
    // metric names come from an untrusted geometry.json — build options via DOM so a name like
    // `r"><img src=x onerror=…>` can't inject markup (textContent/value, never innerHTML concatenation)
    for (const m of metrics) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
    sel.value = geomMetric;
    $('geomMetricRow').classList.toggle('hidden', metrics.length <= 1);   // show the dropdown only when there's a choice
    panel.classList.remove('hidden');
    setupGeomRangeForMetric(true);
  }
  // compute the ACTIVE metric's data range, (optionally) restore its saved window, refresh stats + filter
  function setupGeomRangeForMetric(restore) {
    const vals = view.labelSegs().map(segVal).filter(v => v != null);
    if (!vals.length) { $('geomPanel').classList.add('hidden'); view.setVisibleSegs(null); return; }
    geomLo = Math.min(...vals); geomHi = Math.max(...vals);
    const clampG = v => Math.max(geomLo, Math.min(geomHi, v));
    const saved = (restore && curGeom.filter && curGeom.filter.metric === geomMetric) ? curGeom.filter : null;
    if (saved) { geomMin = clampG(saved.min); geomMax = Math.max(geomMin, clampG(saved.max)); }   // restore this metric's saved window
    else { geomMin = geomLo; geomMax = geomHi; }               // otherwise full range (min..max)
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
    $('geomStats').textContent = I18n.t('geomStatsFmt', { metric: geomMetric, n, min: fmtN(geomLo), max: fmtN(geomHi), mean: fmtN(mean), med: fmtN(med) });
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
    curGeom.filter = { metric: geomMetric, min: geomMin, max: geomMax };
    curGeom.raw.filter = { metric: geomMetric, min: geomMin, max: geomMax };   // mutate the (cached) raw object so it round-trips in-session too
    pendingGeom.set(State.key(cur.caseId, cur.unitId), { unit: cur.unit, raw: curGeom.raw });   // per-unit, so a manual Save persists EVERY edited unit's window (not just the last)
    if ($('autoSave').checked && rootHandle) {
      if (geomSaveTimer) clearTimeout(geomSaveTimer);
      geomSaveTimer = setTimeout(() => flushGeomWrite(false), 600);
    }
  }
  function flushGeomWrite(force) {
    if (geomSaveTimer) { clearTimeout(geomSaveTimer); geomSaveTimer = null; }
    if (!rootHandle || !pendingGeom.size || (!force && !$('autoSave').checked)) return;
    for (const [, p] of pendingGeom) if (p.unit && p.unit.handle) FS.writeText(p.unit.handle, 'geometry.json', JSON.stringify(p.raw, null, 2)).catch(() => {});   // best-effort; a filter write must never block
    pendingGeom.clear();
  }
  function ensureActiveClass() {
    if (!classes.length) { State.setActiveClass(null); return; }
    if (!classes.some(c => c.index === State.getActiveClass())) State.setActiveClass(classes[0].index);
  }
  let classesBackedUp = false;        // classes.json.corrupt already holds the unreadable file currently on disk
  let classesOverwriteOK = false;     // the doctor confirmed (once per dataset) that replacing an unreadable classes.json is intended
  // Copy an unparseable classes.json to classes.json.corrupt BEFORE anything overwrites it. Returns false if
  // the copy could not be made — the caller must then NOT overwrite (same rule as the per-frame sidecars:
  // never destroy what we could not back up). The latch is set only AFTER a successful copy, so a failed
  // backup is retried on the next attempt instead of being skipped forever.
  async function backupClassesOnce() {
    if (!classesFileCorrupt || classesBackedUp) return true;
    try {
      const fh = await rootHandle.getFileHandle('classes.json');
      await FS.writeText(rootHandle, 'classes.json.corrupt', await (await fh.getFile()).text());
      classesBackedUp = true;
      return true;
    } catch (e) { return false; }
  }
  // Ask once per dataset before replacing an unreadable classes.json. The in-memory list is a RECONSTRUCTION
  // (bare indices the scan found on disk, under random "Unnamed-xxxx" names), so writing it replaces the real
  // class vocabulary of every case in the folder.
  function confirmClassOverwrite() {
    if (!classesFileCorrupt || classesOverwriteOK) return true;
    if (!confirm(I18n.t('confirmClassesCorrupt'))) return false;
    classesOverwriteOK = true;
    return true;
  }
  async function saveClasses() {
    if (!rootHandle) return;
    const wasCorrupt = classesFileCorrupt;
    if (wasCorrupt && !(await backupClassesOnce())) { setBanner('classesBackupFailed', null, 'warn'); setSaveStatus('classesSaveFailed', null, true); return; }
    try {
      await FS.writeText(rootHandle, 'classes.json', JSON.stringify({ classes }, null, 2));
      if (wasCorrupt) {   // the file parses again — and the "left untouched" banner has just become FALSE
        classesFileCorrupt = false; classesBackedUp = false;
        setBanner('classesReplaced', null, 'warn');
      }
      setSaveStatus('classesSaved', { time: hhmm() });
    }
    catch (e) { setSaveStatus('classesSaveFailed', null, true); }
  }
  function randomName() { return I18n.t('unnamedPrefix') + Math.random().toString(36).slice(2, 6); }
  // collect every class index used anywhere inside one annotation.json object — flat v5 AND layered v6
  // canonical ANNOTATION-CONTENT signature (ignores metadata: schema_version/case/unit/image_size/coord_order/
  // layer_name) so "same annotations, different file wrapper" compares equal — used to avoid a spurious
  // unsaved-backup when a stale dirty flag actually matches the disk content.
  function annContentSig(a) {
    if (!a || typeof a !== 'object') return 'null';
    const layer = o => ({ collaterals: o.collaterals || [], points: o.points || [], paint: (o.paint && o.paint.classes) || null });
    if (Array.isArray(a.layers)) return JSON.stringify({ starred: !!a.starred, layers: a.layers.map(l => ({ id: l.id, ...layer(l) })) });
    return JSON.stringify({ starred: !!a.starred, layers: [{ id: 0, ...layer(a) }] });
  }
  function collectAnnClasses(ann, used) {
    const cls = v => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
    const one = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o.collaterals)) for (const it of o.collaterals) { const n = (it && !Array.isArray(it)) ? cls(it.class) : null; if (n != null) used.add(n); }
      if (Array.isArray(o.points)) for (const it of o.points) { const n = (it && !Array.isArray(it)) ? cls(it.class) : null; if (n != null) used.add(n); }
      if (o.paint && o.paint.classes && typeof o.paint.classes === 'object') for (const k in o.paint.classes) { const n = +k; if (n) used.add(n); }
    };
    one(ann);
    if (ann && Array.isArray(ann.layers)) for (const ly of ann.layers) one(ly);
  }
  // Every class index actually used by any annotation: in-memory (incl. unsaved) + on disk.
  // Three changes over the sequential version: it runs on the SAME 8-way pool as the background scan (the
  // serial one measured 46 s over Drive on the real 6052-unit dataset, with no feedback at all — which is
  // also what made the cross-dataset race so wide); it SKIPS units the scan already reconciled, because
  // State.usedClasses() is authoritative for those (after the scan finishes it therefore reads nothing at
  // all); and it counts units it could NOT read, so the caller can refuse to delete on partial evidence.
  // Returns { used, unread, total }.
  async function usedClassSet(onProgress) {
    const used = new Set(State.usedClasses());
    const units = [];
    for (const c of cases) for (const u of c.units) {
      if (u.virtual) continue;                                       // perfusion unit has no files on disk
      if (sessionLoaded.has(State.key(c.id, u.id))) continue;        // already reconciled into State
      units.push(u);
    }
    const total = units.length;
    let next = 0, done = 0, unread = 0;
    if (onProgress) onProgress(0, total);
    const worker = async () => {
      while (next < units.length) {
        const u = units[next++];
        try {
          const r = await Loader.loadAnnotation(u);
          if (r.unreadable) unread++; else collectAnnClasses(r.annotation, used);
        } catch (e) { unread++; }
        done++;
        if (onProgress && ((done & 7) === 0 || done === total)) onProgress(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, units.length)) }, worker));
    return { used, unread, total };
  }
  // Startup scan, now BACKGROUND + CONCURRENT: reads every unit's annotation to (a) reconcile UNVISITED
  // units into State (accurate badges + any frame usable as a copy source), (b) auto-add classes used on
  // disk but missing from classes.json. The displayed frame never depends on this — loadCur reconciles it
  // at show time. Progress renders in #scanProg (never the banner, which per-frame warnings own).
  // A new openFolder bumps openGen and this whole scan goes inert.
  async function startBackgroundScan() {
    const gen = openGen, scanRoot = rootHandle;   // saveClasses at the tail must never target a folder opened later
    const units = [];
    for (const c of cases) for (const u of c.units) if (!u.virtual) units.push({ c, u });
    scanTotal = units.length; scanDone = 0; lastScanConflicts = 0;
    updateScanProg();
    const diskUsed = new Set();          // classes seen in FILES this scan (authoritative even if the user deletes a class mid-scan)
    let next = 0, conflicts = 0;   // conflicted frames found by the scan (the chooser appears when each is opened)
    const worker = async () => {
      while (next < units.length) {
        if (gen !== openGen) return;
        const { c, u } = units[next++];
        let ann = null, note = null, annCorrupt = false, annMtime = 0, annDropped = 0, unreadable = false;
        try { const r = await Loader.loadAnnotation(u); ann = r.annotation; note = r.note; annCorrupt = r.annCorrupt; annMtime = r.mtime || 0; annDropped = r.annDropped || 0; unreadable = !!r.unreadable; }
        catch (e) { unreadable = true; }
        if (gen !== openGen) return;
        const uk = State.key(c.id, u.id);
        if (unreadable) {   // could not read this unit's files. Seeding it EMPTY + marking it seeded (what
          scanDone++;       // this loop used to do) is exactly what later lets a star/Save overwrite the real
          if ((scanDone & 15) === 0 || scanDone === scanTotal) updateScanProg();   // annotations. Leave State alone and let a write path re-read it.
          continue;
        }
        if (annCorrupt || annDropped) corruptUnits.add(uk);
        if (!sessionLoaded.has(uk) && !writingUnits.has(uk)) { // skip units loadCur already reconciled (keeps undo history) and units a save is writing RIGHT NOW (our snapshot of their file is already stale)
          const rec = await reconcileUnitFromDisk(c, u, ann, note, annMtime);
          if (gen !== openGen) return;
          if (rec === 'conflict') conflicts++;
          lastSeenMtime.set(uk, annMtime);
          if (rec !== 'raced') sessionLoaded.add(uk);          // seeded now — later Save/star/copy must not re-read + re-reconcile all of them (O(N) sweep)
        }
        if (curCase() && c.id === curCase().id) updateFrameStar(c.id, u.id);   // the row was built before this unit was read: a stale hollow ☆ that the doctor clicks DELETES the star on disk
        collectAnnClasses(ann, diskUsed);                      // flat v5 AND v6 layers — a class used only inside a layer must be re-added too
        scanDone++;
        if ((scanDone & 15) === 0 || scanDone === scanTotal) updateScanProg();
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, Math.max(1, units.length)) }, worker));
    if (gen !== openGen) return;
    scanDone = scanTotal; updateScanProg();
    lastScanConflicts = conflicts;
    const used = new Set([...diskUsed, ...State.usedClasses()]);   // disk truth + live memory AT THE TAIL — no stale start-snapshot (deleteClass mid-scan must stay deleted)
    const have = new Set(classes.map(cl => cl.index));
    let added = 0;
    for (const idx of [...used].sort((a, b) => a - b)) if (idx >= 1 && !have.has(idx)) { classes.push({ index: idx, name: randomName() }); added++; }   // 4.7: never auto-add class 0 — it is the paint layer's \"unpainted\" value
    if (added && scanRoot === rootHandle) {
      classes.sort((a, b) => a.index - b.index);
      ensureActiveClass(); buildClassMgr(); buildClassPicker();
      // never auto-overwrite a classes.json that failed to parse — that would replace the user's names with placeholders
      if (!classesFileCorrupt) await saveClasses();
    }
    // Star glyphs and the case dropdown's ★ suffix are produced ONLY by these two builders — the old tail
    // called highlightNav(), which updates .active/.done/the annotated dot but never a star.
    if (cases.length && curCase()) { buildCaseOptions(); buildFrameList(); } else highlightNav();
    // conflicts are never auto-resolved (4.2): a quiet count now, the actual chooser only when a
    // conflicted frame is OPENED — no upfront dialog storm.
    if (conflicts) setBanner('conflictScanFmt', { n: conflicts }, 'warn');
    // A reload (or a crash) leaves units marked unsaved that nothing would ever write again: auto-save only
    // ever queues the frame on screen. Every unit is seeded by now, so this costs NO extra reads — it skips
    // everything that is already clean.
    if (State.getAutoSave()) sweepDirty();
  }
  function updateScanProg() {
    const el = $('scanProg'); if (!el) return;
    el.textContent = scanDone < scanTotal ? I18n.t('scanProgress', { done: scanDone, total: scanTotal }) : '';
  }

  // ---- prefetch: rest of the CURRENT sequence + the next TWO (whatever their real frame counts — nothing
  // hardcoded). Inserts into the LRU's COLD tier (dies before anything actually viewed), count-capped so the
  // current sequence always stays resident, deduped via loadUnitCached, dead on any nav/open via gens.
  let prefetchGen = 0;
  function schedulePrefetch() {
    const gen = ++prefetchGen, oGen = openGen;
    const c0 = curCase(); if (!c0 || !cur || cur.virtual || cur.mismatch || !rootHandle) return;
    const curLen = c0.units.filter(un => !un.virtual).length;
    const maxCount = Math.max(0, cacheCap - curLen - 8);       // headroom so prefetch can never push the live sequence out
    const list = [];
    for (const cIdx of [ci, ci + 1, ci + 2]) {
      const c = cases[cIdx]; if (!c) continue;
      for (const u of c.units) {
        if (u.virtual || list.length >= maxCount) continue;
        const k = State.key(c.id, u.id);
        if (cache.has(k) || inflightLoads.has(k)) continue;
        list.push({ u, k });
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        if (gen !== prefetchGen || oGen !== openGen) return;
        const it = list[next++];
        try { await loadUnitCached(it.u, it.k, true); } catch (e) { /* best-effort */ }
      }
    };
    for (let i = 0; i < 2; i++) worker();
  }
  function addClass() {
    const inp = $('className'), name = inp.value.trim(); if (!name) return;
    if (!confirmClassOverwrite()) return;   // an unreadable classes.json would be REPLACED by this edit
    const idx = classes.reduce((m, c) => Math.max(m, c.index), 0) + 1;
    classes.push({ index: idx, name }); inp.value = '';
    ensureActiveClass(); buildClassMgr(); buildClassPicker(); saveClasses();
  }
  function renameClass(idx, name) {
    const c = classes.find(c => c.index === idx); if (!c) return;
    if (!confirmClassOverwrite()) { buildClassMgr(); return; }   // rebuild so the input goes back to the name we still hold
    c.name = name; buildClassPicker(); saveClasses();
  }
  // The class sweep and the background scan share #scanProg. The sweep is the FOREGROUND action, so it owns
  // the line while it runs and hands it back to the scan afterwards.
  function setSweepProg(done, total) {
    const el = $('scanProg'); if (!el) return;
    if (total > 0 && done < total) el.textContent = I18n.t('classScanProgress', { done, total });
    else updateScanProg();
  }
  let classSweepBusy = false;   // a deleteClass sweep is reading the folder: the Delete buttons are disabled meanwhile
  function setClassSweepBusy(on) {
    classSweepBusy = on;
    const box = $('classMgr'); if (!box) return;
    box.querySelectorAll('.cls-del').forEach(b => { b.disabled = on; });
  }
  async function deleteClass(idx) {
    if (classSweepBusy) return;             // one sweep at a time — a second Delete would answer from a half-read folder
    if (!confirmClassOverwrite()) return;   // an unreadable classes.json would be REPLACED by this edit
    // The sweep reads the whole folder. Capture the dataset identity AND the folder handle: without them the
    // question ("is class {idx} still in use?") is answered from THIS dataset's files and then applied to
    // whichever dataset is open when the reading finishes — measured live as "A keeps the class, B loses it".
    const tok = dsToken, root = rootHandle;
    setClassSweepBusy(true);
    let r;
    try { r = await usedClassSet(setSweepProg); }
    finally { setClassSweepBusy(false); setSweepProg(0, 0); }
    if (tok !== dsToken || root !== rootHandle) { setBanner('classDeleteAborted', { idx }, 'warn'); return; }   // another folder was opened while we read: this answer describes a folder we no longer have
    if (r.unread) { setBanner('classDeleteUnsure', { idx, n: r.unread }, 'warn'); return; }                     // some frames could not be read: deleting on partial evidence could orphan their marks
    if (r.used.has(idx) || State.usedClasses().includes(idx)) { setBanner('classInUse', { idx }, 'warn'); return; }   // re-check in-memory too, in case the class was assigned during the disk scan
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
      const del = document.createElement('button'); del.className = 'btn sm cls-del'; del.textContent = I18n.t('btnDelete');
      del.disabled = classSweepBusy;   // a rebuild during the sweep must not hand back an enabled button
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
  // Copy-from-frame mirrors ALL of the source frame's layers, so it only writes into an EMPTY target —
  // refuse if the frame has any content across ANY layer (segments/points/paint), or any numbered marker.
  // A star or a note does NOT block: copy never touches them.
  function copyTargetBusy(c, u) {
    return State.unitHasLayerContent(c, u) || State.markerList(c, u).length > 0;
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
  async function pickCopySource(caseId, unitId) {
    const c = cases.find(x => x.id === caseId), src = c && c.units.find(x => x.id === unitId);
    exitCopyPick();   // exit FIRST so its setBanner(null) can't wipe doCopyFrom's result banner
    if (!c || !src || !cur || cur.caseId !== caseId || cur.unitId === unitId) return;   // the source must be another frame of the case that is actually displayed
    if (!src.virtual && !src.mismatch) {                             // the background scan may not have reached the SOURCE yet — an unseeded source would falsely read as "no annotations"
      const st = await ensureSeeded(c, src);
      if (st !== 'seeded' && st !== 'already') { setBanner('frameNotSeeded', { id: src.id }, 'warn'); return; }   // we could not read the source: say so instead of copying "nothing"
    }
    if (!cur || copyTargetBusy(cur.caseId, cur.unitId)) { setBanner('copyBusyNow', null, 'warn'); return; }   // got busy since picking started: say so, don't silently no-op
    doCopyFrom(c.id, src);
  }
  function doCopyFrom(srcCaseId, srcUnit) {
    const tc = cur.caseId, tu = cur.unitId;                   // target = the currently displayed (empty) frame
    const srcLayers = State.getLayers(srcCaseId, srcUnit.id);
    const layerData = srcLayers.map(ly => ({ ly, data: State.readLayer(srcCaseId, srcUnit.id, ly.id) }));
    if (!layerData.some(({ data }) => data.segs.length || data.points.length || data.paint)) {
      setBanner('copyNoAnnotations', { id: srcUnit.id }, 'warn'); return;
    }
    // target is empty per the gate, but may have empty extra layers the user added — collapse to a single layer 0
    for (let tl = State.getLayers(tc, tu); tl.length > 1; tl = State.getLayers(tc, tu)) State.deleteLayer(tc, tu, tl[tl.length - 1].id, true);   // noUndo: collapsing an EMPTY target is bookkeeping, not a doctor action
    // Mirror EVERY source layer onto the (empty) target: reuse the target's lone layer for the first source
    // layer, add a fresh one for each subsequent. Segments/points are re-resolved by coordinate against the
    // target's own label; paint copies 1:1 only at identical W×H. Each layer's writes go to that layer's bucket.
    let totSegs = 0, totPts = 0, totPaint = 0, dropped = 0, paintSkipped = false;
    for (let li = 0; li < layerData.length; li++) {
      const { ly, data } = layerData[li];
      let tLayer;
      if (li === 0) { tLayer = State.getLayers(tc, tu)[0].id; State.setActiveLayer(tc, tu, tLayer); State.renameLayer(tc, tu, tLayer, ly.name); }
      else { tLayer = State.addLayer(tc, tu, ly.name); }      // new empty layer, becomes active
      view.setPaint(State.paintDense(tc, tu, cur.W, cur.H));  // load this (empty) target layer into the view
      const segMap = new Map(), ptSeen = new Set(), pts = [];
      for (const s of data.segs.concat(data.points)) {
        const xy = s.xy, cls = s.cls;
        if (cls == null) { dropped++; continue; }
        if (!xy || !view.inBounds(xy[0], xy[1])) { dropped++; continue; }   // no/out-of-bounds coordinate: can't re-resolve
        const seg = view.segAt(xy[0], xy[1]);
        if (seg > 0) {
          const prev = segMap.get(seg);
          if (!prev) segMap.set(seg, { xy, cls });
          else if (prev.cls !== cls) dropped++;               // two source marks hit the same target segment with different classes: first wins, count the loser
        }
        else { const k = xy[0] + ',' + xy[1]; if (!ptSeen.has(k)) { ptSeen.add(k); pts.push({ xy, cls }); } }
      }
      for (const [seg, v] of segMap) State.applyClass(tc, tu, seg, v.xy, v.cls);
      for (const p of pts) State.addPoint(tc, tu, p.xy, p.cls);
      totSegs += segMap.size; totPts += pts.length;
      if (data.paint) {
        if (data.paint.width === cur.W && data.paint.height === cur.H) {
          const srcDense = State.decodeRLE(data.paint, cur.W, cur.H), curPaint = view.getPaint(), changes = [];
          let n = 0;
          for (let i = 0; i < srcDense.length; i++) { const v = srcDense[i]; if (v && curPaint[i] !== v) { changes.push([i, curPaint[i]]); curPaint[i] = v; n++; } }
          if (n) {
            view.setPaint(curPaint);
            for (const seg of segMap.keys()) view.clearPaintInSegment(seg);   // keep paint ⟂ selection (do NOT fold into the undo)
            State.pushPaintUndo(tc, tu, changes); State.setPaintDense(tc, tu, view.getPaint(), cur.W, cur.H);
            totPaint += n;
          }
        } else paintSkipped = true;
      }
    }
    // land on the layer that was active in the source (mapped by position), then re-render
    const srcActiveIdx = Math.max(0, srcLayers.findIndex(l => l.id === State.getActiveLayer(srcCaseId, srcUnit.id)));
    const tLayers = State.getLayers(tc, tu);
    State.setActiveLayer(tc, tu, (tLayers[srcActiveIdx] || tLayers[0]).id);
    State.markDirty(tc, tu);
    renderActiveLayer(); buildLayerBar(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
    const droppedTxt = dropped ? I18n.t('copyDoneDropped', { n: dropped }) : '';
    const paintTxt = totPaint ? I18n.t('copyDonePaint', { n: totPaint }) : (paintSkipped ? I18n.t('copyPaintSkipped') : '');
    setBanner('copyDone', { id: srcUnit.id, segs: totSegs, pts: totPts, dropped: droppedTxt + paintTxt }, paintSkipped ? 'warn' : 'ok');
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
        refreshMarkers(); view.render(); updateFrameDot(cur.caseId, cur.unitId); updateDirtyUI(); scheduleAutoSave();
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
    refreshMarkers(); view.render(); updateFrameDot(cur.caseId, cur.unitId); updateDirtyUI(); scheduleAutoSave();
  }

  function onNoteInput() { if (!cur || cur.virtual || cur.mismatch) return; State.setNote(cur.caseId, cur.unitId, $('note').value); State.markDirty(cur.caseId, cur.unitId); updateFrameDot(cur.caseId, cur.unitId); updateDirtyUI(); scheduleAutoSave(); }
  // download the current case's perfusion map as a PNG
  async function exportPerfusion() {
    const c = curCase(); if (!c) { setBanner('errOpenFolderFirst', null, 'warn'); return; }
    let perf = await ensureCasePerfusion(c);
    if (State.getPerfMask() && perf) {                       // wait for the minip mask (bounded) so the export matches the on-screen filter
      ensureMinipMask(c);
      const t0 = Date.now();
      while (Date.now() - t0 < 4000) {
        const e = perfTouch(c.id);
        if (!e || e === 'failed' || (e.minipMask !== undefined && e.minipMask !== 'pending')) break;
        await new Promise(r => setTimeout(r, 60));
      }
      perf = perfView(c) || perf;
    }
    if (!perf || !perf.canvas) { setBanner('perfFailed', null, 'warn'); return; }
    perf.canvas.toBlob(blob => {
      if (!blob) return;
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = c.id + '_perfusion.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, 'image/png');
  }
  // shared perfusion repaint (smoothness slider + minip-mask checkbox): re-colour the cached fields —
  // no re-read, no re-analyze. rAF-coalesced; refreshes the shown map and any pinned loupe tile.
  function repaintPerfusionNow() {
    if (navBusy) return;                     // mid-navigation cur is stale while ci already points at the target case — painting would show the WRONG case's map
    if (cur && cur.virtual) {
      const pv = perfView(curCase()); if (pv) paintPerfIntoView(pv);
      maybeWarnPerfMask(curCase());
      if (!State.getPerfMask() && lastBanner && lastBanner.key === 'perfMaskUnavailable') setBanner(null);   // unchecking clears the warning
    }
    if (inspect) { stripSig = ''; scheduleLoupe(); }
  }
  function repaintPerfusion() {   // rAF-coalesced variant for slider DRAGS (occluded windows pause rAF — discrete toggles must not depend on it)
    if (perfSmoothRAF) return;
    perfSmoothRAF = true;
    requestAnimationFrame(() => { perfSmoothRAF = false; repaintPerfusionNow(); });
  }
  function onPerfSmoothInput() {
    const v = +$('perfSmooth').value;
    $('perfSmoothv').textContent = v;
    State.setPerfSmooth(v);
    repaintPerfusion();
  }
  function onPerfMaskToggle() {
    State.setPerfMask($('perfMaskFilter').checked);
    if (State.getPerfMask() && curCase()) ensureMinipMask(curCase());
    repaintPerfusionNow();   // discrete toggle: repaint immediately, never queued behind a paused rAF
  }
  async function saveNote() {   // saves the whole current frame (annotation + note) so the dirty flag stays honest
    if (!cur || cur.virtual || cur.mismatch) return;   // view-only units have no editable files
    if (!rootHandle) { setBanner('errOpenFolderFirst', null, 'warn'); return; }
    // The handle MUST come from the unit captured atomically in `cur`. curUnit() resolves ci/ui, which
    // showUnit advances BEFORE its await, so during a slow load it names the frame being navigated TO —
    // saveNote then wrote THIS frame's annotation.json and note.json into the NEXT frame's folder.
    const c = cur.caseId, u = cur.unitId, unit = cur.unit, k = State.key(c, u);
    if (!sessionLoaded.has(k)) { setBanner('frameNotSeeded', { id: u }, 'warn'); return; }   // same rule as writeUnit: never overwrite an annotation.json this session could not read
    State.setNote(c, u, $('note').value);
    try {
      const seq = State.getDirtySeq(c, u);                    // an edit landing during the writes below must stay dirty (same guard as writeUnit)
      const data = cache.get(k) || await Loader.loadUnit(unit);
      await backupCorruptOnce(k, unit);                       // preserve an unparseable annotation.json before overwriting it
      await FS.writeText(unit.handle, 'annotation.json', JSON.stringify(State.buildAnnotation(c, u, data.W, data.H), null, 2));
      await FS.writeText(unit.handle, 'note.json', JSON.stringify(State.buildNote(c, u), null, 2));
      corruptUnits.delete(k);                                 // the file on disk is valid JSON again
      const fileMs = (await annFileMtime(unit)) || Date.now();
      ownWriteAt.set(k, fileMs); lastSeenMtime.set(k, fileMs); State.noteWritten(c, u, fileMs);
      State.markClean(c, u, seq, fileMs); updateDirtyUI();
      setSaveStatus('noteSaved', { time: hhmm() });
    } catch (e) { setSaveStatus('noteSaveFailed', null, true); }
  }
  function toggleRPanel() { document.body.classList.toggle('rpanel-collapsed'); onResize(); }

  // Describes the frame that is ON SCREEN (cur) — never the one a slow navigation is heading for. ci/ui
  // advance before showUnit's await, so reading them here relabelled the header (and its mark count) to the
  // incoming frame the instant a click landed, while the doctor was still looking at the previous one.
  function refreshMeta() {
    if (!cur) return;
    const cIdx = cases.findIndex(x => x.id === cur.caseId); if (cIdx < 0) return;
    const c = cases[cIdx], uIdx = c.units.findIndex(x => x.id === cur.unitId); if (uIdx < 0) return;
    const u = c.units[uIdx];
    $('curLabel').textContent = c.id + ' / ' + u.id + '  (' + u.kind + ')';
    $('unitIndicator').textContent = I18n.t('unitIndicatorFmt', { ui: uIdx + 1, uc: c.units.length, ci: cIdx + 1, cc: cases.length });
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
  async function toggleStar(caseId, unitId) {
    const c = cases.find(x => x.id === caseId), u = c && c.units.find(x => x.id === unitId);
    if (!c || !u) return;                  // the row belongs to a case/unit that is no longer part of this dataset
    if (u.virtual || u.mismatch) return;   // view-only units can't be starred (no file to persist it to)
    // CRITICAL guard: this frame may never have been seeded this session (fresh browser + background scan
    // hasn't reached it) — starring would then autosave an EMPTY annotation over its real file. Seed first,
    // and honour the contract: only 'seeded'/'already' mean State matches the file on disk.
    const st = await ensureSeeded(c, u);
    if (st !== 'seeded' && st !== 'already') {                 // 'aborted' (folder switched) or 'unreadable' (I/O): changing the star now would write a State we never reconciled
      if (st === 'unreadable') setBanner('frameNotSeeded', { id: u.id }, 'warn');
      return;
    }
    State.setStarred(c.id, u.id, !State.isStarred(c.id, u.id));
    State.markDirty(c.id, u.id);
    buildCaseOptions(); buildFrameList(); updateDirtyUI();
    if (State.getAutoSave() && rootHandle) {   // write THIS frame (not necessarily the current one)
      try { setSaveStatus('saving'); await writeUnit(c.id, u); setSavedStatus(); updateDirtyUI(); }
      catch (e) { setSaveStatus('saveFailed', null, true); setBanner('writeFailedBanner', { id: u.id }, 'warn'); }
    }
  }
  function buildFrameList() {
    const c = curCase(), list = $('frameList'); list.innerHTML = '';
    if (!c) return;
    // A row outlives the case it was built for: showUnit advances ci BEFORE its (slow) await, so a click that
    // lands during a case switch used to be applied to the INCOMING case's frame of the same index. Bind each
    // row to its own case/unit ID and re-resolve at click time instead.
    const cid = c.id;
    c.units.forEach((u, uidx) => {
      const uid = u.id;
      const el = document.createElement('div');
      el.className = 'frm' + (u.virtual ? ' frm-virtual' : ''); el.dataset.k = State.key(c.id, u.id); el.dataset.base = u.id;
      const name = document.createElement('span'); name.className = 'frm-name'; name.textContent = u.id;
      const badge = document.createElement('span'); badge.className = 'frm-b';
      el.appendChild(name); el.appendChild(badge);
      if (!u.virtual) {   // perfusion is view-only: no star / no annotation badge
        const on = State.isStarred(c.id, u.id);
        const star = document.createElement('span'); star.className = 'frm-star' + (on ? ' on' : ''); star.textContent = on ? '★' : '☆'; star.title = I18n.t('starThisFrame');
        star.onclick = (e) => { e.stopPropagation(); toggleStar(cid, uid); };
        el.appendChild(star);
      }
      el.onclick = () => {
        if (copyPickMode) { if (!u.virtual) pickCopySource(cid, uid); return; }
        const nci = cases.findIndex(x => x.id === cid); if (nci < 0) return;                     // this row's case is gone (folder switched)
        const nui = cases[nci].units.findIndex(x => x.id === uid); if (nui < 0) return;
        showUnit(nci, nui);
      };
      list.appendChild(el);
    });
    highlightNav();
  }
  function highlightNav() {
    // the ACTIVE row is the frame on screen (cur), not the one ci/ui already point at mid-navigation
    const cIdx = cur ? cases.findIndex(x => x.id === cur.caseId) : -1;
    if (cIdx >= 0) $('caseSelect').value = cIdx;
    const k = cur ? State.key(cur.caseId, cur.unitId) : null;
    document.querySelectorAll('#frameList .frm').forEach(el => {
      const [cc, uu] = el.dataset.k.split('/');
      const active = k !== null && el.dataset.k === k;
      el.classList.toggle('active', active);
      el.classList.toggle('done', State.isVisited(cc, uu));
      el.querySelector('.frm-b').classList.toggle('on', State.unitAnnotated(cc, uu));
      if (active) el.scrollIntoView({ block: 'nearest' });
    });
  }
  // refresh ONE row's annotated-dot, without highlightNav's scroll side-effect (per-keystroke note
  // input and marker add/delete never changed the old count badge, so they lack highlightNav calls)
  function updateFrameDot(c, u) {
    const k = State.key(c, u);
    document.querySelectorAll('#frameList .frm').forEach(el => {
      if (el.dataset.k === k) el.querySelector('.frm-b').classList.toggle('on', State.unitAnnotated(c, u));
    });
  }

  // refresh ONE row's star glyph (sibling of updateFrameDot). The background scan learns the on-disk stars
  // long after the rows were built, and a row still showing a hollow ☆ DELETES the star when clicked.
  function updateFrameStar(c, u) {
    const k = State.key(c, u), on = State.isStarred(c, u);
    document.querySelectorAll('#frameList .frm').forEach(el => {
      if (el.dataset.k !== k) return;
      const st = el.querySelector('.frm-star'); if (!st) return;
      st.className = 'frm-star' + (on ? ' on' : ''); st.textContent = on ? '★' : '☆';
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
    if (snap && !segVisible(snap.seg)) snap = null;           // a filtered-out (hidden) vessel is "not there" → fall through to the background-dot path
    if (snap) {
      const seg = snap.seg;
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
    ensureCasePerfusion(cases.find(x => x.id === cur.caseId) || curCase());   // so a pinned perfusion tile is ready — for the DISPLAYED case (pl-4 family: curCase() is the nav target mid-load)
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
  // pl-4: "current" here must be the DISPLAYED frame. During a slow load ui already points at the
  // navigation TARGET while the canvas (and view.getGray()) still shows the previous frame — keying
  // "current" on ui made the loupe label the on-screen pixels with the incoming frame's identity.
  function grayOf(c, i, curIdx) {
    if (i === curIdx) return view.getGray();
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
  function rebuildStrip(idxList, units, curIdx) {
    const strip = $('loupeStrip'); strip.innerHTML = ''; tileEls.clear();
    const s = loupeSizePx();
    for (const i of idxList) {
      const u = units[i];
      const wrap = document.createElement('div');
      wrap.className = 'loupe-tile' + (i === curIdx ? ' cur' : '') + (u.kind === 'perfusion' ? ' perf' : '');   // pl-4: highlight the DISPLAYED frame's tile, not the nav target's
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
    // pl-4: anchor everything on the DISPLAYED frame (cur), never on ci/ui — those move to the
    // navigation target before the load resolves, and mid-load the loupe then reads/labels pixels
    // of a frame that is not on screen.
    const c = cases.find(x => x.id === cur.caseId) || curCase();
    if (!c) return;
    const units = c.units, n = units.length;
    const curIdx = units.findIndex(x => x.id === cur.unitId);
    if (curIdx < 0) return;
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
    units.forEach((u, i) => { if (u.kind === 'frame' && i >= curIdx - R && i <= curIdx + R) idxSet.add(i); });
    idxSet.add(curIdx);                                                    // always include the DISPLAYED unit
    if (lp.pinMinip && minipIdx >= 0) idxSet.add(minipIdx);
    if (lp.pinPerfusion && perfIdx >= 0) idxSet.add(perfIdx);
    const idxList = [...idxSet].sort((a, b) => a - b);

    const sig = idxList.join(',') + '@' + curIdx + 'x' + size;
    if (sig !== stripSig) { rebuildStrip(idxList, units, curIdx); stripSig = sig; }
    for (const i of idxList) {
      const el = tileEls.get(i); if (!el) continue;
      if (units[i].kind === 'perfusion') {
        const st = perfState(c);
        Loupe.drawColorTile(el.canvas, st === 'ok' ? perfView(c) : null, x, y, S, st);   // coloured at the current smoothness
      } else {
        const g = grayOf(c, i, curIdx);
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
      if (i === curIdx) curveCur = pts.length;
      const g = grayOf(c, i, curIdx);
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
    // m10: zooming/panning mid-stroke moves the image under a still-held button; the next mousemove
    // then interpolates from the pre-zoom position and paints a long streak the doctor never drew
    // (measured ~280 px). Commit the live stroke first — the wheel ends the stroke, never extends it.
    if (painting || selecting) commitActiveStroke();
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
    // view-only situations where a drag may pan but must never paint/select: perfusion & shape-mismatch
    // units, a frame load in flight (the stroke would straddle two frames), and copy-source picking
    // (painting here would make the copy target busy and the pick then fails)
    const viewOnly = cur.virtual || cur.mismatch || navBusy || copyPickMode;
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
      selStrokeSegs = new Set(); selChanges = []; selPaintChanges = []; selPointChanges = []; selPendingDeltas = [];
      selLastX = x; selLastY = y;
      selDab(x, y);
      view.setBrushCursor(x, y, sb.radius, true);
      flushSelDeltas();   // sp-5: incremental — the full selColorMap rebuild waits for the stroke to end
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
      if (!selRAF) { selRAF = true; requestAnimationFrame(() => { selRAF = false; flushSelDeltas(); }); }
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

  // ---- decision 4.2: the two-version conflict chooser ----------------------------------------------
  // Everything here renders or resolves; DETECTION lives in reconcileUnitFromDisk (open path) and
  // writeUnitInner (write path). The dialog appears only for the frame on screen.
  let conflictShownFor = null;   // key currently in the dialog (guards double-open + wires the buttons)
  function marksFromAnn(ann) {   // one annotation.json (v5 flat or v6 layers) -> flat overlay marks
    const out = { segs: new Set(), pts: [], paintRles: [], starred: false, note: '' };
    if (!ann || typeof ann !== 'object') return out;
    const order = ann.coord_order === 'yx' ? 'yx' : 'xy';
    const conv = a => order === 'xy' ? [a[0], a[1]] : [a[1], a[0]];
    const one = o => {
      if (Array.isArray(o.collaterals)) for (const it of o.collaterals) { const id = Number(it && it.id); if (Number.isFinite(id)) out.segs.add(id); }
      if (Array.isArray(o.points)) for (const it of o.points) { const c2 = Array.isArray(it) ? it : (it && it.click); if (Array.isArray(c2) && c2.length === 2) out.pts.push(conv(c2)); }
      if (o.paint && o.paint.classes) out.paintRles.push(o.paint);
    };
    if (Array.isArray(ann.layers) && ann.layers.length) { for (const ly of ann.layers) if (ly && typeof ly === 'object') one(ly); }
    else one(ann);
    out.starred = ann.starred === true;
    return out;
  }
  function marksFromLocal(c, u) {   // union of every layer in State
    const out = { segs: new Set(), pts: [], paintRles: [], starred: State.isStarred(c, u), note: State.getNote(c, u) };
    for (const ly of State.getLayers(c, u)) {
      const d = State.readLayer(c, u, ly.id);
      d.segs.forEach(x => out.segs.add(x.seg));
      d.points.forEach(pt => out.pts.push([pt.xy[0], pt.xy[1]]));
      if (d.paint && d.paint.classes) out.paintRles.push(d.paint);
    }
    return out;
  }
  function paintPx(rles, W, H) {   // total painted pixels across layers (for the summary line)
    let mask = null;
    for (const r of rles) { const d = State.decodeRLE(r, W, H); if (!mask) mask = new Uint8Array(W * H); for (let i = 0; i < d.length; i++) if (d[i]) mask[i] = 1; }
    if (!mask) return { n: 0, mask: null };
    let n = 0; for (let i = 0; i < mask.length; i++) n += mask[i];
    return { n, mask };
  }
  // grayscale frame + green segment tint + orange paint tint + red point dots, scaled into `cnv`.
  // Best-effort: in an environment without 2D canvas the dialog still works from the text summaries.
  function renderConflictThumb(cnv, data, marks, paintMask) {
    try {
      const W = data.W, H = data.H;
      const off = document.createElement('canvas'); off.width = W; off.height = H;
      const g = off.getContext('2d');
      if (data.img && typeof ImageData !== 'undefined' && data.img instanceof ImageData) g.putImageData(data.img, 0, 0);
      else if (data.img) g.drawImage(data.img, 0, 0);
      const id2 = g.getImageData(0, 0, W, H), px = id2.data, lab = data.label;
      for (let i = 0; i < W * H; i++) {
        const p4 = i * 4;
        if (lab && marks.segs.has(lab[i])) { px[p4] = px[p4] * 0.3; px[p4 + 1] = Math.min(255, px[p4 + 1] * 0.4 + 150); px[p4 + 2] = px[p4 + 2] * 0.3; }
        else if (paintMask && paintMask[i]) { px[p4] = Math.min(255, px[p4] * 0.4 + 150); px[p4 + 1] = Math.min(255, px[p4 + 1] * 0.4 + 90); px[p4 + 2] = px[p4 + 2] * 0.3; }
      }
      g.putImageData(id2, 0, 0);
      g.fillStyle = '#e11d48';
      const r0 = Math.max(2, Math.round(W / 70));
      for (const [x, y] of marks.pts) { g.beginPath(); g.arc(x, y, r0, 0, 6.3); g.fill(); }
      const sc = Math.min(230 / W, 230 / H, 1);
      cnv.width = Math.max(1, Math.round(W * sc)); cnv.height = Math.max(1, Math.round(H * sc));
      cnv.getContext('2d').drawImage(off, 0, 0, cnv.width, cnv.height);
    } catch (e) { /* no canvas (tests) or decode hiccup: summaries still tell the story */ }
  }
  function conflictSummary(marks, px, whenMs) {
    let t = I18n.t('conflictSumFmt', { segs: marks.segs.size, pts: marks.pts.length, px });
    if (marks.starred) t += ' · ★';
    if (marks.note) t += ' · 「' + (marks.note.length > 14 ? marks.note.slice(0, 14) + '…' : marks.note) + '」';
    if (whenMs) { const d = new Date(whenMs); t += '\n' + I18n.t('conflictModFmt', { t: ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) }); }
    return t;
  }
  async function showConflictDialog(k) {
    if (conflictShownFor === k && !$('conflictModal').classList.contains('hidden')) return;
    if (!cur || State.key(cur.caseId, cur.unitId) !== k) return;   // only for the frame on screen
    const c = cur.caseId, unit = cur.unit;
    let rec = conflictedUnits.get(k);
    if (!rec) {                                        // detected by the write path: parse the disk copy now
      try { const r = await Loader.loadAnnotation(unit); rec = { ann: r.annotation, note: r.note, annMtime: r.mtime || 0 }; conflictedUnits.set(k, rec); }
      catch (e) { return; }
      if (!cur || State.key(cur.caseId, cur.unitId) !== k) return;
    }
    const data = cacheTouch(k); if (!data) return;
    const dm = marksFromAnn(rec.ann), lm = marksFromLocal(c, cur.unitId);
    if (rec.note && typeof rec.note.text === 'string') dm.note = rec.note.text;
    const dp = paintPx(dm.paintRles, data.W, data.H), lp = paintPx(lm.paintRles, data.W, data.H);
    $('conflictTitle').textContent = I18n.t('conflictTitleFmt', { id: cur.unitId });
    renderConflictThumb($('conflictThumbDisk'), data, dm, dp.mask);
    renderConflictThumb($('conflictThumbLocal'), data, lm, lp.mask);
    $('conflictSumDisk').textContent = conflictSummary(dm, dp.n, rec.annMtime);
    $('conflictSumLocal').textContent = conflictSummary(lm, lp.n, State.getEditedAt(c, cur.unitId));
    conflictShownFor = k;
    $('conflictModal').classList.remove('hidden');
  }
  function hideConflictDialog() { $('conflictModal').classList.add('hidden'); conflictShownFor = null; }
  // choice: 'disk' keeps the folder file (session copy sidecar-backed-up first);
  //         'local' keeps the session copy (folder file backed up, then written over).
  async function resolveConflict(k, choice) {
    const rec = conflictedUnits.get(k);
    const [cc, uu] = [k.slice(0, k.lastIndexOf('/')), k.slice(k.lastIndexOf('/') + 1)];
    const cRef = cases.find(x => x.id === cc), unit = cRef && cRef.units.find(x => x.id === uu);
    if (!unit) return;
    const tok = dsToken;
    let r = rec;
    if (!r || !r.ann) { try { const rr = await Loader.loadAnnotation(unit); r = { ann: rr.annotation, note: rr.note, annMtime: rr.mtime || 0 }; } catch (e) { r = { ann: null, note: null, annMtime: 0 }; } }
    if (tok !== dsToken) return;
    if (choice === 'disk') {
      let backedUp = false;
      try {
        const sz = (r.ann && Array.isArray(r.ann.image_size) && r.ann.image_size.length === 2) ? r.ann.image_size : [0, 0];
        const localAnn = State.buildAnnotation(cc, uu, sz[0], sz[1]);
        if (State.unitHasContent(cc, uu) && annContentSig(localAnn) !== annContentSig(r.ann)) {
          await FS.writeText(unit.handle, 'annotation.unsaved-backup.json', JSON.stringify(localAnn, null, 2)); backedUp = true;
        }
        if (State.hasNoteData(cc, uu) && noteContentSig(State.buildNote(cc, uu)) !== noteContentSig(r.note)) {
          await FS.writeText(unit.handle, 'note.unsaved-backup.json', JSON.stringify(State.buildNote(cc, uu), null, 2)); backedUp = true;
        }
      } catch (e) { setBanner('saveFailedMsg', { msg: e.message }, 'warn'); return; }   // could not back the loser up: resolve nothing
      if (tok !== dsToken) return;
      State.resetUnit(cc, uu);
      try { if (r.ann) State.importAnnotation(cc, uu, r.ann); if (r.note) State.importNoteJson(cc, uu, r.note); } catch (e) { }
      State.markClean(cc, uu, undefined, r.annMtime);
      lastSeenMtime.set(k, r.annMtime || 0);
      conflictedUnits.delete(k);
      hideConflictDialog();
      if (cur && cur.caseId === cc && cur.unitId === uu) {                 // repaint the frame with the adopted version
        view.setPaint(State.paintDense(cc, uu, cur.W, cur.H));
        refreshCanvasSelection(); refreshMeta(); refreshMarkers(); buildLayerBar();
        $('note').value = State.getNote(cc, uu);
      }
      highlightNav(); updateDirtyUI();
      setBanner(backedUp ? 'conflictKeptDisk' : 'conflictKeptDiskNoBackup', null, 'ok');
    } else {
      try {
        if (r.ann) await FS.writeText(unit.handle, 'annotation.external-backup.json', JSON.stringify(r.ann, null, 2));
        if (r.note) await FS.writeText(unit.handle, 'note.external-backup.json', JSON.stringify(r.note, null, 2));
      } catch (e) { setBanner('saveFailedMsg', { msg: e.message }, 'warn'); return; }
      if (tok !== dsToken) return;
      conflictedUnits.delete(k);
      lastSeenMtime.set(k, (await annFileMtime(unit)) || 0);   // the file as it stands is KNOWN to us now — our write may proceed over it
      hideConflictDialog();
      try { await writeUnit(cc, unit); } catch (e) { }         // failures land in the retry queue like any write
      highlightNav(); updateDirtyUI();
      setBanner(r.ann ? 'conflictKeptLocal' : 'conflictKeptLocalNoBackup', null, 'ok');
      if (!retryQ.size) setSavedStatus();
    }
  }

  // ---- rescue-file recovery entry (user's option A) ------------------------------------------------
  // The app writes rescue copies in several situations (conflict resolutions, corrupt-file protection):
  // annotation/note .unsaved-backup.json, annotation/note .external-backup.json, annotation.json.corrupt.
  // They used to be write-only — no UI could see or restore them. Now: opening a frame kicks off a
  // non-blocking folder listing; if rescue files exist, a banner with a [View] action opens a chooser in
  // the conflict-dialog style (thumbnail + summary per file, tabs when several). RESTORING IS A SWAP:
  // the version being replaced is written into the same rescue file first, so no choice ever destroys
  // anything — the files trade places, and reopening the frame offers the trade back.
  const RESCUE_NAMES = ['annotation.unsaved-backup.json', 'note.unsaved-backup.json',
    'annotation.external-backup.json', 'note.external-backup.json', 'annotation.json.corrupt'];
  const rescueFound = new Map();   // State.key() -> [names present at last check] (session cache)
  let rescueShownFor = null, rescueFiles = [], rescueSel = 0;
  async function checkRescueFiles(c, u) {
    const k = State.key(c.id, u.id), tok = dsToken;
    try {
      const names = [];
      for await (const [name, h] of u.handle.entries()) if (h.kind === 'file' && RESCUE_NAMES.indexOf(name) >= 0) names.push(name);
      names.sort((a, b) => RESCUE_NAMES.indexOf(a) - RESCUE_NAMES.indexOf(b));
      if (tok !== dsToken) return;
      rescueFound.set(k, names);
      if (!names.length) return;
      if (!cur || State.key(cur.caseId, cur.unitId) !== k) return;        // navigated away while listing
      if (conflictedUnits.has(k)) return;                                  // the conflict chooser owns the banner slot first
      if (lastBanner && bannerPrio(lastBanner.key, lastBanner.kind) === 2) return;   // never displace a critical warning
      setBanner('rescueFoundFmt', { n: names.length }, null);
      const b = $('banner'), act = document.createElement('span');
      act.className = 'banner-act'; act.textContent = I18n.t('rescueViewBtn');
      act.onclick = () => openRescueDialog(k);
      b.appendChild(act);
    } catch (e) { /* listing is best-effort — a transient failure must never disturb annotating */ }
  }
  async function openRescueDialog(k) {
    if (!cur || State.key(cur.caseId, cur.unitId) !== k) return;
    const c = cur.caseId, unit = cur.unit;
    const names = rescueFound.get(k) || [];
    if (!names.length) return;
    rescueFiles = [];
    for (const name of names) {
      try {
        const fh = await unit.handle.getFileHandle(name);
        const txt = await (await fh.getFile()).text();
        let parsed = null; try { parsed = JSON.parse(txt); } catch (e) { }
        rescueFiles.push({ name, bytes: txt.length, parsed, isNote: name.indexOf('note.') === 0 });
      } catch (e) { }
    }
    if (!cur || State.key(cur.caseId, cur.unitId) !== k || !rescueFiles.length) return;
    rescueShownFor = k; rescueSel = 0;
    $('rescueTitle').textContent = I18n.t('rescueTitleFmt', { id: cur.unitId });
    renderRescueTabs();
    renderRescueCompare();
    $('rescueModal').classList.remove('hidden');
  }
  function renderRescueTabs() {
    const tabs = $('rescueTabs'); tabs.innerHTML = '';
    rescueFiles.forEach((f, i) => {
      const t = document.createElement('button');
      t.className = 'rescue-tab' + (i === rescueSel ? ' active' : '');
      t.textContent = f.name;
      t.onclick = () => { rescueSel = i; renderRescueTabs(); renderRescueCompare(); };
      tabs.appendChild(t);
    });
    if (rescueFiles.length <= 1) tabs.classList.add('hidden'); else tabs.classList.remove('hidden');
  }
  function marksFromNoteJson(n) {   // note.json shape -> overlay marks (markers as red dots) + text
    const out = { segs: new Set(), pts: [], paintRles: [], starred: false, note: '' };
    if (!n || typeof n !== 'object') return out;
    out.note = typeof n.text === 'string' ? n.text : '';
    const order = n.coord_order === 'yx' ? 'yx' : 'xy';
    if (Array.isArray(n.markers)) for (const m of n.markers)
      if (m && Array.isArray(m.click) && m.click.length === 2) out.pts.push(order === 'xy' ? [m.click[0], m.click[1]] : [m.click[1], m.click[0]]);
    return out;
  }
  function renderRescueCompare() {
    const f = rescueFiles[rescueSel]; if (!f || !cur) return;
    const data = cacheTouch(State.key(cur.caseId, cur.unitId)); if (!data) return;
    const cm = f.isNote ? marksFromNoteJson(State.buildNote(cur.caseId, cur.unitId)) : marksFromLocal(cur.caseId, cur.unitId);
    const cp = paintPx(cm.paintRles, data.W, data.H);
    renderConflictThumb($('rescueThumbCur'), data, cm, cp.mask);
    $('rescueSumCur').textContent = conflictSummary(cm, cp.n, State.getEditedAt(cur.caseId, cur.unitId));
    if (f.parsed) {
      const bm = f.isNote ? marksFromNoteJson(f.parsed) : marksFromAnn(f.parsed);
      const bp = paintPx(bm.paintRles, data.W, data.H);
      renderConflictThumb($('rescueThumbBak'), data, bm, bp.mask);
      $('rescueSumBak').textContent = conflictSummary(bm, bp.n, 0);
      $('btnRescueRestore').classList.remove('hidden');
    } else {
      try { const g = $('rescueThumbBak').getContext('2d'); $('rescueThumbBak').width = 230; $('rescueThumbBak').height = 60; g.clearRect(0, 0, 230, 60); } catch (e) { }
      $('rescueSumBak').textContent = I18n.t('rescueUnparsableFmt', { bytes: f.bytes });
      $('btnRescueRestore').classList.add('hidden');   // .corrupt that still does not parse: information only
    }
  }
  function hideRescueDialog() { $('rescueModal').classList.add('hidden'); rescueShownFor = null; }
  // THE SWAP: current version -> the rescue file's own name; rescue content -> the live State (+ auto-save).
  async function restoreRescue() {
    const f = rescueFiles[rescueSel];
    if (!f || !f.parsed || !cur || rescueShownFor !== State.key(cur.caseId, cur.unitId)) return;
    const c = cur.caseId, u = cur.unitId, unit = cur.unit, k = State.key(c, u), tok = dsToken;
    const data = cacheTouch(k); if (!data) return;
    try {
      if (f.isNote) {
        await FS.writeText(unit.handle, f.name, JSON.stringify(State.buildNote(c, u), null, 2));
        if (tok !== dsToken) return;
        for (const m of State.markerList(c, u)) State.removeMarker(c, u, m.id);   // clear, then adopt (importNoteJson only fills empty)
        State.setNote(c, u, '');
        State.importNoteJson(c, u, f.parsed);
        if (typeof f.parsed.text === 'string') State.setNote(c, u, f.parsed.text);
        $('note').value = State.getNote(c, u);
        refreshMarkers(); buildMarkerChips();
      } else {
        await FS.writeText(unit.handle, f.name, JSON.stringify(State.buildAnnotation(c, u, data.W, data.H), null, 2));
        if (tok !== dsToken) return;
        const keepNote = State.buildNote(c, u);                                   // annotation restore must not touch the note
        State.resetUnit(c, u);
        try { State.importAnnotation(c, u, f.parsed); } catch (e) { }
        State.importNoteJson(c, u, keepNote);
        if (typeof keepNote.text === 'string') State.setNote(c, u, keepNote.text);
        view.setPaint(State.paintDense(c, u, cur.W, cur.H));
        refreshCanvasSelection(); refreshMeta(); refreshMarkers(); buildLayerBar();
        $('note').value = State.getNote(c, u);
      }
      State.markDirty(c, u);
      highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
      hideRescueDialog();
      setBanner('rescueRestoredFmt', { file: f.name }, 'ok');
    } catch (e) { setBanner('saveFailedMsg', { msg: e.message }, 'warn'); }
  }

  // ---- explicit save: two scopes sharing one engine ------------------------------------------------
  // "Save case" writes the case being annotated now; "Save all" is the end-of-day full write. Both run
  // through runSave(), which shows a progress modal (total is known up front, so the doctor can see how
  // long the full save actually is) with a Cancel that stops BETWEEN frames: everything already written
  // stays written, everything else keeps its unsaved mark. The modal is a .modal-overlay, so the v63
  // hotkey guard automatically blocks navigation/undo behind it while a save runs.
  let saveCancel = false, saveRunning = false;
  function saveModalOpen(titleKey, vars) {
    saveCancel = false;
    $('saveModalTitle').textContent = I18n.t(titleKey, vars);
    $('saveProgFill').style.width = '0%';
    $('saveProgText').textContent = '';
    $('btnSaveCancel').classList.remove('hidden'); $('btnSaveCancel').disabled = false;
    $('btnSaveClose').classList.add('hidden');
    $('saveModal').classList.remove('hidden');
  }
  function saveModalStep(done, total, file) {
    $('saveProgFill').style.width = (total ? Math.round(done * 100 / total) : 100) + '%';
    $('saveProgText').textContent = I18n.t('saveProgFmt', { done, total, file });
  }
  function saveModalFinish(text) {
    $('saveProgText').textContent = text;
    $('btnSaveCancel').classList.add('hidden');
    $('btnSaveClose').classList.remove('hidden');
  }
  // The save buttons carry their scope in the label — "Save s_12" / "Save all · 3 unsaved" — so which
  // button writes what is readable at a glance, and the unsaved count doubles as the missing global
  // unsaved indicator. Dynamic text, so these two carry no data-i18n (langchange re-renders them here).
  function updateSaveButtons() {
    const dn = State.dirtyCount();
    $('btnSave').textContent = dn ? I18n.t('saveAllUnsavedFmt', { n: dn }) : I18n.t('btnSaveAll');
    $('btnSaveCase').textContent = (cur && !cur.virtual) ? I18n.t('saveCaseFmt', { id: cur.caseId }) : I18n.t('btnSaveCaseLabel');
    if (!FS.supported) { $('btnSave').disabled = true; $('btnSaveCase').disabled = true; return; }
    if (!saveRunning) { $('btnSave').disabled = false; $('btnSaveCase').disabled = !cur; }
  }
  async function runSave(caseId) {
    if (saveRunning) return;
    if (!rootHandle) { setBanner('errOpenFolderFirst', null, 'warn'); return; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } pendingSave = null;
    try { if (!(await FS.ensureReadWrite(rootHandle))) { setBanner('errNoWritePermission', null, 'warn'); return; } }
    catch (e) { setBanner('saveFailedMsg', { msg: e.message }, 'warn'); return; }
    flushGeomWrite(true);     // persist the current unit's radius window on an explicit save, even if auto-save is off
    const map = new Map();
    cases.forEach(c => c.units.forEach(u => map.set(State.key(c.id, u.id), { c, u })));
    // scope filter: a case id is a folder name, it can never contain '/', so prefix+'/' is exact
    const keys = State.unitsWithData().filter(k => !caseId || k.slice(0, caseId.length + 1) === caseId + '/');
    const tok = dsToken;        // the dataset this Save belongs to: if another folder is opened mid-save, every remaining unit's State is foreign and must NOT be written
    let n = 0, failed = 0, aborted = false, cancelled = false, done = 0, skippedConflicts = 0;
    saveRunning = true;
    saveModalOpen(caseId ? 'savingCaseFmt' : 'savingAllTitle', caseId ? { id: caseId } : null);
    $('btnSave').disabled = true; $('btnSaveCase').disabled = true; $('btnOpen').disabled = true;
    try {
      for (const k of keys) {
        if (saveCancel) { cancelled = true; break; }     // between frames only: the frame being written always completes
        if (tok !== dsToken) { aborted = true; break; }   // a different dataset was opened while we were writing — stop, and say so (the rest stay unsaved)
        done++; saveModalStep(done, keys.length, k);
        const ref = map.get(k);
        if (!ref) { const [cc, uu] = k.split('/'); if (State.isDirty(cc, uu)) failed++; continue; }   // unit's folder no longer discoverable — surface it, don't silently skip
        if (ref.u.virtual || ref.u.mismatch) continue;                                     // perfusion / shape-mismatch units are never written
        // a unit the background scan hasn't reached yet must be seeded from disk BEFORE we serialize it,
        // or a star-only/dirty-only entry would write an EMPTY annotation over its real file
        let st; try { st = await ensureSeeded(ref.c, ref.u); } catch (e) { st = 'unreadable'; }
        if (st === 'aborted') { aborted = true; break; }
        if (st !== 'seeded' && st !== 'already') { failed++; continue; }   // could not read this frame's file: leave it untouched and report it, never write a State we could not verify
        // don't fabricate empty annotation.json for merely-viewed, never-annotated frames
        if (!State.isDirty(ref.c.id, ref.u.id) && !State.unitHasContent(ref.c.id, ref.u.id)) continue;
        if (conflictedUnits.has(k)) { skippedConflicts++; continue; }   // chooser owns it — not written, not a failure
        try { await writeUnit(ref.c.id, ref.u); if (conflictedUnits.has(k)) skippedConflicts++; else n++; }   // the write itself may detect a fresh conflict and refuse
        catch (e) { failed++; }   // a single unloadable/broken unit must not abort saving the rest
      }
    } finally {
      saveRunning = false;
      $('btnOpen').disabled = openBusy || !FS.supported;   // never re-enable Open underneath a still-running openFolder
    }
    updateDirtyUI();
    // an abort is NOT a write failure: nothing was written for the remaining frames and they are still dirty
    if (aborted) { saveModalFinish(I18n.t('saveDoneAbortedFmt', { n })); setBanner('saveAborted', { n }, 'warn'); setSaveStatus(null); return; }
    if (cancelled) { saveModalFinish(I18n.t('saveCancelledFmt', { n })); setSaveStatus(null); return; }   // frames are still unsaved — the header must not claim Saved
    saveModalStep(keys.length, keys.length, '');
    if (failed) { saveModalFinish(I18n.t('saveDonePartialFmt', { n, failed })); setBanner('savedPartial', { n, failed }, 'warn'); }
    else if (skippedConflicts) { saveModalFinish(I18n.t('saveDoneConflictsFmt', { n, c: skippedConflicts })); setBanner('conflictScanFmt', { n: skippedConflicts }, 'warn'); }
    else { saveModalFinish(I18n.t('saveDoneFmt', { n })); setBanner(null); setBanner('savedAllFmt', { n }, 'ok'); }   // a clean full save retires any stale critical warning first — every frame just reached disk
    if (skippedConflicts) setSaveStatus(null); else setSavedStatus();   // conflicted frames are still unsaved — the header must not say Saved
  }
  function save() { return runSave(null); }
  function saveCase() { if (cur && !cur.virtual) return runSave(cur.caseId); }

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
    updateSaveButtons();   // the Save-all label carries the global unsaved count — keep it live
  }
  function scheduleAutoSave() {
    if (!$('autoSave').checked || !rootHandle || !cur) return;
    if (conflictedUnits.has(State.key(cur.caseId, cur.unitId))) return;   // unresolved conflict: nothing may write this frame; edits stay in State + mirror
    pendingSave = { c: cur.caseId, u: cur.unitId, unit: cur.unit };   // (case,unit,handle) captured atomically in cur — never mix ids with a different unit's handle
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(runAutoSave, 1000);
    setSaveStatus('pendingSave');
  }
  function flushAutoSave() { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; return runAutoSave(); } }   // returns the write promise so callers that must not race it can await
  async function backupCorruptOnce(k, unit) {   // copy an unparseable annotation.json to .corrupt exactly once before we overwrite it
    if (!corruptUnits.has(k) || corruptBackedUp.has(k)) return;
    corruptBackedUp.add(k);
    try {
      const fh = await unit.handle.getFileHandle('annotation.json');
      await FS.writeText(unit.handle, 'annotation.json.corrupt', await (await fh.getFile()).text());
    } catch (e) { /* best effort — never block the real write */ }
  }
  // ---- failed writes: retry queue ------------------------------------------------------------------
  // Today a failed write is NEVER retried: the frame stays dirty, the accurate "write FAILED" banner is
  // replaced by the next per-frame warning, the header inherits "Saved" from some other frame's success, and
  // the work survives only in localStorage. Failures are re-queued here and retried with backoff.
  // The dataset identity is stamped at ENQUEUE time — exactly as writeUnit does it — so a retry that comes
  // due after the doctor opened another folder is DROPPED, never written into whatever is open by then.
  const RETRY_DELAYS = [2000, 5000, 15000, 60000];   // after the last attempt we stop; the unit stays dirty and the warning stays up
  // Errors a retry cannot fix: permission withdrawn, the folder/file is gone. Retrying those forever would
  // only bury the real problem — report them instead.
  const permanentWriteError = e => !!e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError' || e.name === 'SecurityError');
  function retryLater(caseId, unit, tok, err) {
    const k = State.key(caseId, unit.id);
    if (permanentWriteError(err)) { retryQ.delete(k); return false; }
    const e = retryQ.get(k) || { caseId, unit, tok, tries: 0 };
    e.unit = unit; e.tok = tok; e.tries++;
    if (e.tries > RETRY_DELAYS.length) { retryQ.delete(k); return false; }   // give up quietly: the banner + dirty flag already say the work is not on disk
    retryQ.set(k, e);
    setSaveStatus('retryPending', { n: retryQ.size }, true);
    armRetry(RETRY_DELAYS[e.tries - 1]);
    return true;
  }
  function armRetry(ms) {
    if (retryTimer) return;                    // one timer for the whole queue — the earliest due entry drives it
    retryTimer = setTimeout(() => { retryTimer = null; runRetries(); }, ms);
  }
  async function runRetries() {
    let recovered = false;
    for (const e of [...retryQ.values()]) {
      const k = State.key(e.caseId, e.unit.id);
      if (e.tok !== dsToken) { retryQ.delete(k); continue; }                          // queued against a dataset that is no longer open
      const c = cases.find(x => x.id === e.caseId);
      if (!c || !State.isDirty(e.caseId, e.unit.id)) { retryQ.delete(k); continue; }  // gone, or a later write already carried this unit to disk
      let st; try { st = await ensureSeeded(c, e.unit); } catch (err) { st = 'unreadable'; }
      if (st !== 'seeded' && st !== 'already') { retryLater(e.caseId, e.unit, e.tok, null); continue; }   // still cannot verify the file: count it as one more attempt
      try { await writeUnit(e.caseId, e.unit); retryQ.delete(k); recovered = true; }
      catch (err) { }                          // writeUnit's own hook has already re-queued (or dropped) it
    }
    if (retryQ.size) { setSaveStatus('retryPending', { n: retryQ.size }, true); armRetry(RETRY_DELAYS[RETRY_DELAYS.length - 1]); }
    else if (recovered) {
      if (lastBanner && lastBanner.key === 'writeFailedBanner') setBanner(null);      // it did reach the disk after all — that warning is no longer true
      setSaveStatus('saved', { time: hhmm() });
    }
    updateDirtyUI();
  }
  // "Saved HH:MM" must never be claimed while a write is still waiting to be retried.
  function setSavedStatus() {
    if (retryQ.size) setSaveStatus('retryPending', { n: retryQ.size }, true);
    else setSaveStatus('saved', { time: hhmm() });
  }
  // Turning auto-save back ON must write EVERY frame that is still dirty: scheduleAutoSave only ever queues
  // the frame on screen, so everything edited while the checkbox was off stayed unwritten until a manual Save.
  async function sweepDirty() {
    if (!rootHandle) return;
    const tok = dsToken;
    const map = new Map();
    cases.forEach(c => c.units.forEach(u => map.set(State.key(c.id, u.id), { c, u })));
    for (const k of State.unitsWithData()) {
      if (tok !== dsToken) return;                                       // another folder was opened: the remaining units belong to it, not to us
      const ref = map.get(k); if (!ref || ref.u.virtual || ref.u.mismatch) continue;
      if (!State.isDirty(ref.c.id, ref.u.id)) continue;                  // only work that is NOT on disk
      let st; try { st = await ensureSeeded(ref.c, ref.u); } catch (e) { st = 'unreadable'; }
      if (st !== 'seeded' && st !== 'already') continue;                 // unverifiable file: leave it untouched (Save reports it; the retry queue keeps trying)
      try { await writeUnit(ref.c.id, ref.u); } catch (e) { }            // failures land in the retry queue through writeUnit's hook
    }
    updateDirtyUI();
  }
  const writeBegin = k => writingUnits.set(k, (writingUnits.get(k) || 0) + 1);
  const writeEnd = k => { const n = (writingUnits.get(k) || 1) - 1; if (n > 0) writingUnits.set(k, n); else writingUnits.delete(k); };
  // ONE writer per unit, in CALL order. Two writes of the same unit (autosave + star, undo + autosave, …)
  // used to race through their awaits, so the SLOWER-started one could land last and leave OLDER content on
  // disk under a "Synced" UI. The dataset identity is captured HERE, at ENQUEUE time, and passed in: reading
  // it inside the queued body would pick up whatever dataset is open when the turn finally comes, which is
  // exactly the cross-dataset write the guard exists to prevent.
  function writeUnit(caseId, unit) {   // write one unit's annotation.json (+ note.json) and mark it clean
    const k = State.key(caseId, unit.id), tok = dsToken;
    writeBegin(k);                                    // the stale-dirty reconcile must not race a save — from the moment it is QUEUED, not just while it runs
    const prev = writeChain.get(k) || Promise.resolve();
    const p = prev.catch(() => { }).then(() => writeUnitInner(caseId, unit, tok, k));   // a failed predecessor must not cancel the writes queued behind it
    writeChain.set(k, p);
    const done = () => { writeEnd(k); if (writeChain.get(k) === p) writeChain.delete(k); };
    p.then(done, done);                               // NOT .finally(): the promise it derives adopts p's rejection and nobody would handle THAT one
    p.catch(err => { retryLater(caseId, unit, tok, err); });   // every failed write is re-queued against the dataset it was queued for — never silently dropped
    return p;                                         // the caller's own catch still sees the failure
  }
  async function writeUnitInner(caseId, unit, tok, k) {
    const seq = State.getDirtySeq(caseId, unit.id);   // an edit landing during the awaits below bumps this — markClean then declines, so the edit stays dirty and gets its own save
    if (tok !== dsToken) return;                      // a folder switch happened before our turn came — State now belongs to ANOTHER dataset; writing would clobber the old folder with foreign/empty content
    // ensureSeeded()/loadCur() deliberately leave a unit OUT of sessionLoaded when its annotation.json could
    // not be read. Building the file from that State would replace real annotations with an empty document,
    // so refuse: the throw surfaces the write-failure banner and puts the unit in the retry queue.
    if (!sessionLoaded.has(k)) throw new Error('refusing to write ' + k + ': its annotation.json was never read this session');
    if (conflictedUnits.has(k)) return;               // the conflict chooser owns this frame: stays dirty, file stays untouched (4.2)
    let data = cacheTouch(k); if (data === undefined) data = await loadUnitCached(unit, k, false);
    if (tok !== dsToken) return;                      // …or during the load
    if (data.shapeMismatch) { State.markClean(caseId, unit.id, seq); return; }   // never write into a shape-mismatched frame (would fabricate annotation.json)
    // M4 / decision 4.2: never blind-overwrite a file that changed since this session last read or wrote
    // it — that silently destroyed a colleague's (or another machine's) work with a stale in-memory copy
    // while the banner reported success. A newer-but-changed file makes this frame CONFLICTED instead:
    // the write is skipped, the frame stays dirty, and opening it shows the two-version chooser.
    const diskMs = await annFileMtime(unit);
    if (tok !== dsToken) return;
    if (diskMs && diskMs > Math.max(ownWriteMs(caseId, unit.id, k), lastSeenMtime.get(k) || 0) + 2000) {
      conflictedUnits.set(k, null);                   // parsed lazily when the chooser opens
      return;
    }
    await backupCorruptOnce(k, unit);
    if (tok !== dsToken) return;
    await FS.writeText(unit.handle, 'annotation.json', JSON.stringify(State.buildAnnotation(caseId, unit.id, data.W, data.H), null, 2));
    if (State.hasNoteData(caseId, unit.id)) await FS.writeText(unit.handle, 'note.json', JSON.stringify(State.buildNote(caseId, unit.id), null, 2));
    corruptUnits.delete(k);   // the file on disk is valid JSON again
    const fileMs = (await annFileMtime(unit)) || Date.now();   // the FILE's own clock, not ours
    if (tok === dsToken) { ownWriteAt.set(k, fileMs); lastSeenMtime.set(k, fileMs); State.noteWritten(caseId, unit.id, fileMs); }   // a reconcile must never mistake OUR write for an externally-newer file — this session OR after a reload (and a cross-open write must not pollute the new dataset's maps)
    State.markClean(caseId, unit.id, seq, fileMs);
  }
  async function runAutoSave() {
    saveTimer = null;
    const p = pendingSave; pendingSave = null;
    if (!p || !rootHandle || !$('autoSave').checked) return;
    try {
      setSaveStatus('saving'); await writeUnit(p.c, p.unit); updateDirtyUI();
      const k2 = State.key(p.c, p.unit.id);
      if (conflictedUnits.has(k2)) {                  // the write refused: a newer differing file appeared on disk
        setSaveStatus(null);                          // the frame is NOT saved — never claim it is
        setBanner('conflictFoundFmt', { id: p.unit.id }, 'warn');
        if (cur && cur.caseId === p.c && cur.unitId === p.unit.id) showConflictDialog(k2);
      } else setSavedStatus();
    }
    catch (e) { setSaveStatus('autoSaveFailed', null, true); setBanner('writeFailedBanner', { id: p.unit.id }, 'warn'); }   // a failed write must be IMPOSSIBLE to miss — the work stays dirty + in the browser
  }

  async function undo() {
    if (!cur) return;
    // Peek BEFORE popping: an offscreen paint entry needs the unit's dims; after LRU eviction (or a reopen)
    // the cache may not have them and the entry would be consumed with no effect. Pre-load, THEN pop.
    const top = State.peekUndo && State.peekUndo();
    if (top && top.kind === 'paint' && cur && !(top.c === cur.caseId && top.u === cur.unitId)) {
      const k = State.key(top.c, top.u);
      if (!cache.has(k)) {
        const oc = cases.find(cc => cc.id === top.c), ou = oc && oc.units.find(uu => uu.id === top.u);
        if (ou && !ou.virtual) { try { await loadUnitCached(ou, k, false); } catch (err) { return; } }   // can't get dims: leave the entry ON the stack for a later retry
      }
    }
    const e = State.undo();
    if (!e) return;                                         // nothing undone: don't spuriously dirty the current unit
    const sameUnit = e.c === cur.caseId && e.u === cur.unitId;
    // if the undone action was on a DIFFERENT layer of this frame, switch to it so the change is visible/
    // editable — but never for markers: they're frame-level and carry no layer, and treating their missing
    // field as "layer 0" would hijack the reviewer's active layer
    if (sameUnit && e.kind !== 'marker' && (e.layer || 0) !== State.getActiveLayer(cur.caseId, cur.unitId)) {
      State.setActiveLayer(cur.caseId, cur.unitId, e.layer || 0);
      view.setPaint(State.paintDense(cur.caseId, cur.unitId, cur.W, cur.H));   // load that layer's paint before any paint-undo apply
      buildLayerBar();
    }
    const isCurLayer = sameUnit && (e.layer || 0) === State.getActiveLayer(cur.caseId, cur.unitId);
    // a restored clear/delete-layer changes bucket contents (and possibly the layer LIST) wholesale:
    // reload the canvas paint from State and rebuild the layer bar. Offscreen units need nothing extra —
    // their snapshots went straight back into State as stored RLE/objects.
    if (e.kind === 'layerclear' || e.kind === 'layerdel') {
      if (sameUnit) { view.setPaint(State.paintDense(cur.caseId, cur.unitId, cur.W, cur.H)); buildLayerBar(); }
    }
    if (e.kind === 'paint') {
      if (isCurLayer) {
        view.applyPaintUndo(e.changes);                     // current unit+layer: apply via the view's dense array
        State.setPaintDense(cur.caseId, cur.unitId, view.getPaint(), cur.W, cur.H);
      } else {
        // other unit/layer: apply to its stored paint. A full-erase stroke deleted the RLE (and its dims),
        // so offer the unit's cached dims as fallback (pre-loaded by undo() before popping when evicted).
        const d = cache.get(State.key(e.c, e.u));
        if (!State.applyPaintUndoOffscreen(e.c, e.u, e.changes, e.layer, d && d.W, d && d.H)) return;
      }
    }
    State.markDirty(e.c, e.u);                              // dirty the unit the undo actually touched
    if (!sameUnit) {                                        // persist THAT unit directly, leave the displayed one alone
      // dw-5: the screen does not change (the edit lives on another frame), so without this the doctor
      // reads the silence as "nothing happened" and presses Ctrl+Z again — silently unpicking more
      // history elsewhere. Name BOTH frames: what was undone, and where the doctor actually is.
      setBanner('undoOtherFrameFmt', { id: (e.c === cur.caseId ? e.u : e.c + '/' + e.u), cur: cur.unitId }, 'warn');
      highlightNav(); updateDirtyUI();
      const oc = cases.find(c => c.id === e.c), ou = oc && oc.units.find(u => u.id === e.u);
      if (ou && rootHandle && State.getAutoSave()) {
        setSaveStatus('saving');
        writeUnit(e.c, ou).then(() => { setSavedStatus(); updateDirtyUI(); })
          .catch(() => { setSaveStatus('saveFailed', null, true); setBanner('writeFailedBanner', { id: e.u }, 'warn'); });
      }
      return;
    }
    refreshMarkers();
    refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
  }
  function askClear() { if (!cur || cur.virtual || cur.mismatch) return; $('confirmClear').classList.remove('hidden'); }   // view-only units have nothing to clear (and must never be marked dirty)
  function closeClear() { $('confirmClear').classList.add('hidden'); }
  function clear() {
    if (!cur || cur.virtual || cur.mismatch) return;
    State.clearUnit(cur.caseId, cur.unitId);
    view.setPaint(State.paintDense(cur.caseId, cur.unitId, cur.W, cur.H));   // wipe the canvas paint layer too, else the next stroke re-encodes & re-saves the "cleared" paint
    State.markDirty(cur.caseId, cur.unitId);
    refreshCanvasSelection(); refreshMeta(); highlightNav(); updateDirtyUI(); updateCopyBtn(); scheduleAutoSave();
  }
  function stepUnit(d) {                                      // frame nav (arrows + ‹Prev/Next›): stays WITHIN the case
    if (!cases.length) return;
    const nu = ui + d;
    if (nu < 0 || nu >= curCase().units.length) return;       // clamp at the case's first/last unit; use « / » to change case
    showUnit(ci, nu);
  }
  function stepCase(d) { const nc = ci + d; if (nc < 0 || nc >= cases.length) return; showUnit(nc, 0); }
  function onResize() { if (view) { view.layout(); view.render(); updateZoomReadout(); } applyLoupeSize(); }
  function toggleRail() { document.body.classList.toggle('rail-collapsed'); onResize(); }

  // ---- language switcher: re-render every live piece of UI text after a switch ----
  function onLangChange() {
    if (cur) refreshMeta();
    else { $('curLabel').textContent = I18n.t('notLoaded'); $('chips').innerHTML = '<span class="muted">' + I18n.t('none') + '</span>'; }
    updateCopyBtn(); updateDirtyUI();   // updateDirtyUI also re-renders the dynamic save-button labels
    buildCaseOptions(); buildFrameList(); buildClassMgr(); buildClassPicker(); buildMarkerChips(); buildLayerBar(); updateScanProg();
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
    $('perfSmooth').value = State.getPerfSmooth(); $('perfSmoothv').textContent = State.getPerfSmooth();
    $('perfMaskFilter').checked = State.getPerfMask();
    applyLoupeSize();
    $('btnOpen').onclick = openFolder;
    $('btnSave').onclick = save;
    $('btnSaveCase').onclick = saveCase;
    $('btnSaveCancel').onclick = () => { saveCancel = true; $('btnSaveCancel').disabled = true; };
    $('btnConflictDisk').onclick = () => { if (conflictShownFor) resolveConflict(conflictShownFor, 'disk'); };
    $('btnConflictLocal').onclick = () => { if (conflictShownFor) resolveConflict(conflictShownFor, 'local'); };
    $('btnConflictLater').onclick = hideConflictDialog;   // unresolved: frame stays dirty + protected; reopening the frame asks again
    $('btnRescueRestore').onclick = restoreRescue;
    $('btnRescueClose').onclick = hideRescueDialog;
    $('btnSaveClose').onclick = () => $('saveModal').classList.add('hidden');
    updateSaveButtons();
    $('btnUndo').onclick = undo;
    $('btnClear').onclick = askClear;
    $('btnAddLayer').onclick = addLayerAction;
    $('cancelClear').onclick = closeClear;
    $('doClear').onclick = () => { closeClear(); clear(); };
    $('confirmClear').addEventListener('click', e => { if (e.target === $('confirmClear')) closeClear(); });
    $('coordOrder').onchange = e => State.setCoordOrder(e.target.value);
    $('autoSave').checked = State.getAutoSave();
    $('autoSave').onchange = e => {
      State.setAutoSave(e.target.checked);
      if (e.target.checked) { scheduleAutoSave(); sweepDirty(); }   // …and catch up on everything edited while the checkbox was off
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
    $('perfSmooth').oninput = onPerfSmoothInput;
    $('perfMaskFilter').onchange = onPerfMaskToggle;
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
    $('geomMetric').onchange = e => { geomMetric = e.target.value; setupGeomRangeForMetric(true); scheduleGeomSave(); };
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
      if (e.key === 'Escape' && !$('rescueModal').classList.contains('hidden')) { hideRescueDialog(); return; }
      if (e.key === 'Escape' && !$('conflictModal').classList.contains('hidden')) { hideConflictDialog(); return; }   // = "decide later"
      if (e.key === 'Escape' && !$('confirmClear').classList.contains('hidden')) { closeClear(); return; }
      // While ANY full-screen overlay is up, swallow every other hotkey. #confirmClear was already
      // handled; dataformat.js's #dfModal was not, so arrows loaded another frame, digits changed the
      // active class, C/B/P switched the annotation tool and Ctrl+Z popped an undo entry - all invisible
      // behind the overlay, and the next canvas click then painted with a tool the doctor never chose.
      // Matching on .modal-overlay rather than on ids also covers overlays added later.
      if (document.querySelector('.modal-overlay:not(.hidden)')) return;
      if (isInspectMod(e) && !e.repeat && overCanvas && cur && !inspect) { enterInspect(); return; }
      // Space is the documented pan modifier and belongs to the viewport, not to whatever control the
      // mouse last clicked. The canvas is not focusable, so focus stays on the last slider/checkbox and
      // the old "any INPUT" test dropped Space entirely: holding it and dragging PAINTED a real stroke
      // (auto-saved to disk) instead of panning. Only text entry may keep Space for itself.
      if (e.key === ' ' && !isTextEntry(e.target)) {
        spaceHeld = true;
        // Swallow it only while the pointer is over the canvas - there the doctor means to pan, and
        // letting it through would scroll the page, toggle a focused checkbox, or re-fire a focused
        // BUTTON on keyup (#btnUndo undoing a second time, #btnOpen re-opening the folder picker).
        // Away from the canvas Space keeps activating controls, so keyboard use is unchanged.
        if (overCanvas) e.preventDefault();
      }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;   // don't hijack typing (notes, class names)
      if (e.key === 'ArrowRight') stepUnit(1);
      else if (e.key === 'ArrowLeft') stepUnit(-1);
      else if (e.key === '\\') toggleRail();
      else if (e.key.toLowerCase() === 'z' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (!e.repeat && !painting && !selecting) undo(); }   // don't undo mid-stroke (would corrupt the live stroke's change record — paint AND select strokes). !e.repeat = decision 4.9-A: HOLDING the key undoes ONE step, auto-repeats are dropped — a panicked hold after deleting the wrong thing must not machine-gun through the history
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
      if (selecting) finalizeSelectStroke();   // a select stroke must not survive a window blur either
      dragging = false; spaceHeld = false; $('view').style.cursor = '';
      exitInspect();
    }
    window.addEventListener('blur', resetTransientInput);
    document.addEventListener('visibilitychange', () => { if (document.hidden) { resetTransientInput(); State.flushPersist(); } });   // hidden tabs can be killed without pagehide (mobile, OOM): sync the mirror on the way out
    // Closing / reloading the tab: flush the debounced write immediately and, if any frame is still
    // unsaved, show the browser's leave-confirmation. Staying gives the in-flight write time to land;
    // leaving anyway is still safe for the SAME browser (localStorage has every edit) — the dialog exists
    // so the folder isn't handed over while it's missing the last strokes.
    window.addEventListener('beforeunload', e => {
      commitActiveStroke();
      flushGeomWrite(true); flushAutoSave();
      State.flushPersist();                      // persist() is throttled — the crash-recovery mirror must be current before the page can go away
      if (State.dirtyCount() > 0) { e.preventDefault(); e.returnValue = ''; }
    });
    window.addEventListener('pagehide', () => { commitActiveStroke(); flushGeomWrite(true); flushAutoSave(); State.flushPersist(); });   // bfcache / mobile: no dialog possible, just flush
    // The mirror is sharded per dataset (v65), so a second tab on a DIFFERENT folder no longer clobbers
    // this one's crash-recovery records — only a tab on the SAME dataset writes the same keys (last
    // writer wins per frame). Warn once when that actually happens.
    let multiTabWarned = false;
    window.addEventListener('storage', ev => {
      if (!State.isMirrorKey(ev.key) || multiTabWarned || !rootHandle) return;
      multiTabWarned = true; setBanner('multiTabWarn', null, 'warn');
    });
    view.setOpacity($('opacity').value / 100);
    view.setMaskOpacity($('maskOpacity').value / 100);
    if (!FS.supported) {
      setBanner('errUnsupportedBrowser', null, 'warn');
      $('btnOpen').disabled = true; $('btnSave').disabled = true; $('btnSaveCase').disabled = true;
    }
    view.layout(); view.render(); updateZoomReadout();
  }
  window.addEventListener('DOMContentLoaded', init);
  // read-only diagnostics (support/debug; never mutates anything)
  window.__annotDebug = () => ({ cacheCap, cacheSize: cache.size, maxSeqLen, maxPxSeen, prefetchCold: prefetchCold.size, inflight: inflightLoads.size, scan: scanDone + '/' + scanTotal, dirty: State.dirtyCount() });
})();
