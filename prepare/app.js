// prepare/app.js — turn a folder of DSA DICOM files into a dataset the Collateral Annotator opens directly.
//
//   <dataset>/classes.json, case_mapping.csv, manifest.csv, build_params.json
//   <dataset>/s_<N>/f_<k>/  and  s_<N>/minip/   each with frames.png, mask.npy, label.npy, geometry.json, note.json
//
// The annotator only discovers folders whose name carries a number, so cases are renamed s_0, s_1, … and
// case_mapping.csv keeps the link to the source DICOMs. The heavy work runs in worker.js; this file scans,
// plans, writes files and shows progress. Pixels never leave this machine.

const V = new URL(import.meta.url).searchParams.get('v') || '0';
const { readDicomHeader } = await import(`./dicom.js?v=${V}`);

const DEFAULT_WEIGHTS = 'https://huggingface.co/cjy666/dsa-vessel-seg/resolve/main/';
const params = new URLSearchParams(location.search);
const WEIGHTS = (params.get('weights') || DEFAULT_WEIGHTS).replace(/\/?$/, '/');
const REPO_PAGE = WEIGHTS.replace(/\/resolve\/[^/]+\/$/, '');
const DATASET_PREFIX = 'annotator_dataset_';
const SKIP_DIRS = /^(annotator_dataset_|vessel_seg_output_)/;     // our own outputs are never inputs
const MODEL_CACHE = /^dsa-vessel-seg-models/;
const GENERATOR = 'collateral-annotator prepare.html';

const MAPPING_FIELDS = ['case', 'sid', 'source_path', 'patient_id', 'view', 'acq_datetime', 'study_instance_uid', 'series_number',
  'run_rank', 'n_runs_patient', 'run_label', 'frames', 'rows', 'cols', 'width', 'height', 'crop_box', 'transfer_syntax',
  'pixel_spacing_mm', 'manufacturer', 'status', 'units', 'seconds', 'message'];
const MANIFEST_FIELDS = ['case', 'unit', 'sid', 'fid', 'height', 'width', 'segments', 'vessel_px', 'seconds',
  'patient_id', 'view', 'acq_datetime', 'run_rank', 'n_runs_patient', 'run_label', 'source_path', 'pixel_spacing_mm'];
const MINIP_FID = 999999;            // sorts a MinIP last in manifest.csv, as in the earlier datasets
const MAX_SID = 999999999;           // the highest case number

const $ = (id) => document.getElementById(id);
const el = {
  modelInfo: $('modelInfo'), unsupported: $('unsupported'), openFolder: $('openFolder'), inputInfo: $('inputInfo'),
  crop: $('crop'), minip: $('minip'), backend: $('backend'), folds: $('folds'), foldInfo: $('foldInfo'), mirror: $('mirror'),
  startNum: $('startNum'), seedNotes: $('seedNotes'),
  chooseOut: $('chooseOut'), outInfo: $('outInfo'),
  run: $('run'), cancel: $('cancel'), progressWrap: $('progressWrap'), bar: $('bar'), status: $('status'),
  opacity: $('opacity'), previewInfo: $('previewInfo'), cacheInfo: $('cacheInfo'), clearCache: $('clearCache'),
  stage: $('stage'), empty: $('empty'), view: $('view'), weightsLink: $('weightsLink'),
  planTitle: $('planTitle'), planSummary: $('planSummary'), planBody: document.querySelector('#planTable tbody'),
};

let manifest = null;
let worker = null, workerBackend = null, loadedKeys = new Set(), runtimeLabel = '';
let msgId = 0;
const waiting = new Map();
let inputDir = null, scanned = [], plan = [];
let outParent = null;
let busy = false, cancelRequested = false, preview = null;
let endFolderWait = null;      // set while a run waits its turn for the output folder: Stop calls it to end the wait
let endTailWait = null;        // set while a finished run looks at its two lists once more: Stop ends that wait too
let settled = false;           // the run has said how it ended and is only taking its mark away
let cacheState = { files: 0, bytes: 0 }, disarmTimer = 0;

const fmtMB = (b) => (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB';
const fmtS = (ms) => ms < 60000 ? (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' s'
  : ms < 3600000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const outMode = () => document.querySelector('input[name=outMode]:checked').value;

function setStatus(text, isError = false) { el.status.textContent = text; el.status.classList.toggle('err', isError); }
function setProgress(frac) {
  if (frac == null) { el.progressWrap.hidden = true; return; }
  el.progressWrap.hidden = false;
  el.bar.style.width = Math.max(0, Math.min(100, frac * 100)).toFixed(1) + '%';
}
const selectedFolds = () => manifest ? manifest.folds.filter((f) => el.folds.querySelector(`input[value="${f.fold}"]`).checked) : [];
const keyOf = (f) => `fold${f.fold}`;

function refreshButtons() {
  const supported = 'showDirectoryPicker' in window;
  el.openFolder.disabled = busy || !supported;
  el.chooseOut.disabled = busy || !supported;
  const destOk = outMode() === 'new' ? !!inputDir : !!outParent;
  const n = plan.length;
  el.run.disabled = busy || !manifest || !n || !destOk || selectedFolds().length === 0;
  el.run.textContent = n ? `Prepare dataset (${plural(n, 'case')})` : 'Prepare dataset';
  for (const i of [el.crop, el.minip, el.backend, el.mirror, el.startNum, el.seedNotes,
    ...el.folds.querySelectorAll('input'), ...document.querySelectorAll('input[name=outMode]')]) i.disabled = busy;
  el.clearCache.disabled = busy || !cacheState.files;
}
function refreshFoldInfo() {
  if (!manifest) return;
  const sel = selectedFolds(), toFetch = sel.filter((f) => !loadedKeys.has(keyOf(f)));
  el.foldInfo.textContent = !sel.length ? 'Pick at least one fold.'
    : `${sel.length === 1 ? '1 fold' : sel.length + ' folds averaged'} · ` +
      (toFetch.length ? `${toFetch.every((f) => Number.isFinite(f.size)) ? fmtMB(toFetch.reduce((s, f) => s + f.size, 0)) + ' ' : ''}to load (cached after the first download)` : 'loaded');
  refreshButtons();
}

// ---------------------------------------------------------------- model manifest + worker

// The model list is asked for when the page opens and again when a folder is picked while it is still missing.
// The two requests can finish in either order, so each one may only write what is still true when it returns:
//  * the first one that SUCCEEDS puts the list on the page; a later success finds it there and changes nothing;
//  * a FAILURE is shown only if no list has arrived and no newer request is on its way. (An old request that
//    failed late used to write "Model info unavailable" over a list the retry had already loaded, with the
//    button live.)
let manifestAsk = 0, manifestErrShown = false;
async function loadManifest() {
  const ask = ++manifestAsk;
  try {
    const res = await fetch(WEIGHTS + 'model.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const m = await res.json();
    // only a list this page can work with counts as one: an answer without folds used to be taken, and the
    // valid answer that came after it was then ignored
    // …nor is one whose patch is not two positive whole numbers (it sizes the tiles the model is run on), whose
    // folds share a name (two entries, one model loaded), or whose sizes are not sizes. (A fold's name goes into
    // the page as it is: a plain token.) A weight file's name is a name: one made of blanks — or with blanks
    // around it — asked the weights FOLDER for a file and got "not found" on every run, while the valid list
    // that came after it was ignored.
    const whole = (v) => Number.isInteger(v) && v > 0;
    if (!(m && typeof m === 'object' && typeof m.name === 'string' && Array.isArray(m.patch) && m.patch.length === 2 && m.patch.every(whole) &&
          Array.isArray(m.folds) && m.folds.length &&
          m.folds.every((f) => f && typeof f.file === 'string' && f.file.trim() && f.file === f.file.trim() && (typeof f.fold === 'string' || Number.isInteger(f.fold)) && /^[0-9A-Za-z_-]+$/.test(String(f.fold)) &&
            (f.size === undefined || (Number.isFinite(f.size) && f.size >= 0)) &&
            (f.sha256 == null || f.sha256 === '' || (typeof f.sha256 === 'string' && /^[0-9a-fA-F]{64}$/.test(f.sha256)))) &&
          new Set(m.folds.map((f) => String(f.fold))).size === m.folds.length)) throw new Error('the model list is not valid');
    if (manifest) return;
    for (const f of m.folds) { if (f.sha256) f.sha256 = f.sha256.toLowerCase(); else delete f.sha256; }   // compared with a lower-case digest; an upper-case one is the same checksum
    manifest = m;
    el.modelInfo.textContent = `${manifest.name} · ${manifest.folds.length} folds`;
    el.weightsLink.href = REPO_PAGE;
    el.folds.innerHTML = '';
    for (const f of manifest.folds) {
      const l = document.createElement('label');
      l.innerHTML = `<input type="checkbox" value="${f.fold}" checked> ${f.fold}`;
      el.folds.appendChild(l);
    }
    el.folds.addEventListener('change', refreshFoldInfo);
    refreshFoldInfo();
    // a request that failed earlier may have left its message standing: the list is here now
    if (manifestErrShown && !busy) setStatus(!inputDir ? 'Open a DICOM folder to start. The vessel model downloads on the first run and is cached afterwards.'
      : plan.length ? 'Ready. Check the cases below, then press “Prepare dataset”.' : 'Pick a folder that contains DICOM files.');
    manifestErrShown = false;
  } catch (e) {
    if (manifest || ask !== manifestAsk) return;
    el.modelInfo.textContent = 'Model info unavailable';
    setStatus(`Could not read ${WEIGHTS}model.json (${e.message}).`, true);
    manifestErrShown = true;
  }
  refreshButtons();
}

function ensureWorker() {
  const backend = el.backend.value;
  if (worker && workerBackend === backend) return;
  if (worker) worker.terminate();
  loadedKeys = new Set();
  // a bare relative path would resolve against prepare.html; anchor it to this file instead
  worker = new Worker(new URL(`./worker.js?v=${encodeURIComponent(V)}`, import.meta.url), { type: 'module' });
  workerBackend = backend;
  worker.onmessage = (e) => {
    const m = e.data, w = waiting.get(m.id);
    if (!w) return;
    if (m.type === 'error' || m.type === 'cancelled') { waiting.delete(m.id); w.reject(new Error(m.type === 'cancelled' ? 'cancelled' : m.message)); }
    else if (m.type === 'ready' || m.type === 'done') { waiting.delete(m.id); w.resolve(m); }
    else if (w.on) w.on(m);
  };
  worker.onerror = (e) => {
    const err = new Error(e.message || 'The processing worker failed to start');
    for (const w of waiting.values()) w.reject(err);
    waiting.clear(); worker = null; workerBackend = null; loadedKeys = new Set();
  };
}

function ask(msg, on, transfer = []) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject, on });
    worker.postMessage({ ...msg, id }, transfer);
  });
}

async function ensureLoaded(folds) {
  ensureWorker();
  // (A file name is not a piece of a URL: a "#" or "?" in it cut the address short — "weight#1.onnx" asked for
  // "weight" and got "not found" — and a "%" was read as the start of an escape, so "weight%23.onnx" asked for
  // the file "weight#.onnx". Each part of the path is written the way an address spells it; a name of plain
  // letters, digits, "-", "_" and "." gives the address it always gave.)
  const models = folds.map((f) => ({ key: keyOf(f), url: WEIGHTS + String(f.file).split('/').map(encodeURIComponent).join('/'), size: f.size, sha256: f.sha256 }));
  const r = await ask({ type: 'load', models, patch: manifest.patch, prefer: el.backend.value }, (m) => {
    const what = `fold ${m.key.replace('fold', '')} (${m.index}/${m.count})`;
    if (m.phase === 'download') { setStatus(`Downloading ${what}… ${fmtMB(m.loaded)} / ${fmtMB(m.total)}`); setProgress(m.total ? m.loaded / m.total : null); }
    else if (m.phase === 'cache') setStatus(`Loading ${what} from browser storage…`);
    else if (m.phase === 'compile') setStatus(`Preparing ${what} on this device…`);
  });
  loadedKeys = new Set(r.loaded);
  runtimeLabel = r.ep === 'webgpu' ? 'WebGPU (GPU)' : `CPU / WebAssembly, ${plural(r.threads, 'thread')}`;
  el.modelInfo.textContent = `${manifest.name} · running on ${runtimeLabel}`;
  refreshFoldInfo();
}

// ---------------------------------------------------------------- scanning + planning

const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

async function scanDicoms(dir) {
  const found = [];
  async function walk(d, dirs) {
    const kids = [];
    for await (const [name, h] of d.entries()) kids.push([name, h]);
    kids.sort((a, b) => natural(a[0], b[0]));
    for (const [name, h] of kids) {
      if (name.startsWith('.')) continue;
      if (h.kind === 'directory') { if (!SKIP_DIRS.test(name)) await walk(h, [...dirs, name]); continue; }
      const lower = name.toLowerCase();
      let isDcm = /\.(dcm|dicom)$/.test(lower);
      if (!isDcm && !lower.includes('.')) {
        try {
          const f = await h.getFile();
          const head = new Uint8Array(await f.slice(128, 132).arrayBuffer());
          isDcm = head[0] === 0x44 && head[1] === 0x49 && head[2] === 0x43 && head[3] === 0x4d;
        } catch (e) { /* unreadable: ignore */ }
      }
      if (isDcm) found.push({ dirs, name, path: [...dirs, name].join('/'), handle: h });
    }
  }
  await walk(dir, []);
  for (let i = 0; i < found.length; i++) {
    const e = found[i];
    el.inputInfo.textContent = `Reading DICOM headers… ${i + 1}/${found.length}`;
    try {
      const f = await e.handle.getFile();
      e.size = f.size;
      e.header = await readDicomHeader(f);
      if (!e.header.supported) e.error = `unsupported compression: ${e.header.tsName}`;
    } catch (err) { e.error = err.message; }
  }
  return found;
}

function fmtDateTime(date, time) {
  if (!date || date.length < 8) return '';
  const t = (time || '').replace(/[^0-9]/g, '');
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` + (t.length >= 4 ? ` ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6) || '00'}` : '');
}
// The same instant as a sort key that keeps the DICOM fraction of a second ("HHMMSS.FFFFFF"). The shown time
// stops at the second, and two runs that start within one second were then ranked by their key text instead of
// by time, which could swap "pre" and "post".
function timeKey(date, time) {
  if (!date || date.length < 8) return '';
  const t = (time || '').replace(/[^0-9]/g, '');
  return date.slice(0, 8) + (t.length >= 4 ? t.padEnd(12, '0').slice(0, 12) : '');
}
function acqStamp(h) {
  for (const [d, t] of [[h.acqDate, h.acqTime], [h.contentDate, h.contentTime], [h.seriesDate, h.seriesTime], [h.studyDate, h.studyTime]])
    if (d) return { dt: fmtDateTime(d, t), key: timeKey(d, t) };
  return { dt: '', key: '' };
}
function viewOf(name, h) {
  if (/anterior[-_ ]?posterior/i.test(name) || /(^|[^a-z])ap([^a-z]|$)/i.test(name)) return 'AP';
  if (/lateral/i.test(name) || /(^|[^a-z])lat([^a-z]|$)/i.test(name)) return 'LAT';
  if (h.primaryAngle != null) { const a = Math.abs(h.primaryAngle); return a <= 45 || a >= 135 ? 'AP' : 'LAT'; }
  return '';
}
// The patient is the file name up to the first "_", as in the earlier datasets. The DICOM PatientID is not
// used: different sources fill it differently.
function patientOf(e) {
  const stem = e.name.replace(/\.(dcm|dicom)$/i, '');
  return (stem.includes('_') ? stem.split('_')[0] : stem) || 'unknown';
}

// Order: patient, then run time (runs = patient + StudyInstanceUID + SeriesNumber, as in the earlier
// datasets), AP before LAT; numbered from "First case number".
function buildPlan() {
  const ok = scanned.filter((e) => !e.error);
  const infos = ok.map((e) => {
    const h = e.header, patient = patientOf(e), { dt, key: tk } = acqStamp(h);
    return { e, patient, view: viewOf(e.name, h), dt, tk, runKey: `${patient}|${h.studyUid}|${h.seriesNumber || (h.studyUid ? '' : e.path)}` };
  });
  const runs = new Map();                                    // runKey -> earliest time
  for (const i of infos) { const t = i.tk || '9999'; if (!runs.has(i.runKey) || t < runs.get(i.runKey)) runs.set(i.runKey, t); }
  const byPatient = new Map();
  for (const [k, t] of runs) { const p = k.split('|')[0]; if (!byPatient.has(p)) byPatient.set(p, []); byPatient.get(p).push([t, k]); }
  const rank = new Map();
  for (const [, list] of byPatient) {
    list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    list.forEach(([, k], idx) => rank.set(k, { x: idx + 1, n: list.length }));
  }
  // patient IDs are compared as plain strings, like Python's sorted(): IDs are often hex hashes, and a
  // "natural" (numeric-aware) order would read "0391bb…" as the number 391
  const vr = { AP: 0, LAT: 1, '': 2 };
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  infos.sort((a, b) => cmp(a.patient, b.patient) || cmp(runs.get(a.runKey), runs.get(b.runKey))
    || cmp(a.runKey, b.runKey) || vr[a.view] - vr[b.view] || natural(a.e.path, b.e.path));

  // Case folders are numbered s_<N> with N counted up by one. Above 2^53 adding one changes nothing, and every
  // case then got the SAME folder; keep the numbers far below that.
  const asked = Math.max(0, parseInt(el.startNum.value, 10) || 0);
  let next = Math.min(asked, Math.max(0, MAX_SID - infos.length + 1));
  if (next !== asked) el.startNum.value = String(next);
  plan = infos.map((i) => {
    const { x, n } = rank.get(i.runKey);
    const sid = next++;
    return {
      sid, case: `s_${sid}`, e: i.e, patient: i.patient, view: i.view, dt: i.dt, runRank: x, nRuns: n,
      runLabel: n === 1 ? 'only' : x === 1 ? 'pre' : x === n ? 'post' : 'mid',
      status: 'planned', message: '', w: '', h: '', box: '', units: '', seconds: '',
    };
  });
  renderPlan();
}

function renderPlan() {
  el.planBody.innerHTML = '';
  const rows = plan.slice(0, 1000);
  for (const c of rows) {
    const tr = document.createElement('tr');
    const h = c.e.header;
    const cells = [c.case, c.e.path, c.patient, c.view, c.dt, `${c.runRank}/${c.nRuns}`, h.frames, `${h.cols}×${h.rows}`, c.message || c.status];
    cells.forEach((v, k) => { const td = document.createElement('td'); td.textContent = v; if (k === 1) td.className = 'file'; if (k === 8) td.className = 'st'; td.title = String(v); tr.appendChild(td); });
    tr.dataset.state = c.status;
    c.tr = tr;
    el.planBody.appendChild(tr);
  }
  if (plan.length > rows.length) {                 // the table lists the first 1000; the others are prepared all the same
    const tr = document.createElement('tr');
    tr.dataset.state = 'planned';
    const rest = `${plural(plan.length - rows.length, 'more case')} not listed here (s_${plan[rows.length].sid} … s_${plan[plan.length - 1].sid}); they are prepared like the others`;
    ['…', rest, '', '', '', '', '', '', ''].forEach((v, k) => { const td = document.createElement('td'); td.textContent = v; if (k === 1) td.className = 'file'; if (k === 8) td.className = 'st'; td.title = v; tr.appendChild(td); });
    el.planBody.appendChild(tr);
  }
  for (const e of scanned.filter((x) => x.error).slice(0, 200)) {
    const tr = document.createElement('tr');
    tr.dataset.state = 'skipped';
    ['—', e.path, '', '', '', '', '', '', `skipped: ${e.error}`].forEach((v, k) => { const td = document.createElement('td'); td.textContent = v; if (k === 1) td.className = 'file'; if (k === 8) td.className = 'st'; td.title = v; tr.appendChild(td); });
    el.planBody.appendChild(tr);
  }
  const units = plan.reduce((s, c) => s + c.e.header.frames + (el.minip.checked && c.e.header.frames > 1 ? 1 : 0), 0);
  el.planTitle.textContent = plan.length ? `Cases s_${plan[0].sid} … s_${plan[plan.length - 1].sid}` : 'Cases';
  el.planSummary.textContent = plan.length ? `${plural(plan.length, 'case')} · ${plural(units, 'unit')} to prepare` : '';
  refreshButtons();
}

function setCaseState(c, state, text) {        // display only; c.status is set by the run itself
  if (!c.tr) return;
  c.tr.dataset.state = state;
  const td = c.tr.lastChild;
  td.textContent = text; td.title = text;
}

async function openFolder() {
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'prepareInput', mode: 'read' }); }
  catch (e) { if (e.name !== 'AbortError') setStatus(`Could not open the folder (${e.message}).`, true); return; }
  await useInputFolder(dir);
}

async function useInputFolder(dir) {
  inputDir = dir; scanned = []; plan = [];
  busy = true; refreshButtons();
  el.inputInfo.textContent = `Scanning “${dir.name}”…`;
  try { scanned = await scanDicoms(dir); }
  catch (e) { el.inputInfo.textContent = `Could not read “${dir.name}” (${e.message}).`; busy = false; refreshButtons(); return; }
  busy = false;
  const bad = scanned.filter((e) => e.error).length, frames = scanned.reduce((s, e) => s + (e.header && !e.error ? e.header.frames : 0), 0);
  el.inputInfo.textContent = scanned.length
    ? `“${dir.name}”: ${plural(scanned.length - bad, 'DICOM file')}, ${plural(frames, 'frame')}${bad ? ` · ${bad} skipped` : ''}.`
    : `“${dir.name}” contains no DICOM files.`;
  buildPlan(); refreshOutInfo();
  if (!manifest) await loadManifest();             // the model list could not be read when the page opened (or is still on its way): ask again now
  if (manifest) setStatus(plan.length ? 'Ready. Check the cases below, then press “Prepare dataset”.' : 'Pick a folder that contains DICOM files.');
  // without it the button stays off, and the status keeps saying why (set by loadManifest)
}

// ---------------------------------------------------------------- output folder

async function chooseOut() {
  try {
    outParent = await window.showDirectoryPicker({ id: 'prepareOutput', mode: 'readwrite' });
    document.querySelector('input[name=outMode][value=elsewhere]').checked = true;
    onModeChange();
  } catch (e) { if (e.name !== 'AbortError') setStatus(`Could not open that folder (${e.message}).`, true); }
}

function onModeChange() {
  refreshOutInfo(); refreshButtons();
}

function refreshOutInfo() {
  const parent = outMode() === 'new' ? inputDir : outParent;
  el.outInfo.textContent = parent
    ? `Each run creates a new folder “${DATASET_PREFIX}<date>-<time>” inside “${parent.name}”.`
    : outMode() === 'new' ? 'Each run creates a new dataset folder inside the DICOM folder.' : 'Choose where the new dataset folder should go.';
}

// ---------------------------------------------------------------- CSV + file helpers

const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const toCsv = (rows, fields) => [fields.join(','), ...rows.map((r) => fields.map((f) => csvCell(r[f])).join(','))].join('\r\n') + '\r\n';
async function writeFile(dir, name, data) {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}
async function dirThere(dir, name) {
  try { await dir.getDirectoryHandle(name); return true; }
  catch (e) { if (e && e.name === 'NotFoundError') return false; if (e && e.name === 'TypeMismatchError') return true; throw e; }
}
// Is the entry `name` of `parent` still the very directory `dir`? A folder this run made can be moved away and
// another one put in its place under the same name: that one is not this run's to remove. (Where it cannot be
// told, the answer is no.)
async function stillDir(parent, name, dir) {
  try { const now = await parent.getDirectoryHandle(name); return now === dir || (typeof now.isSameEntry === 'function' && await now.isSameEntry(dir)); }
  catch (e) { return false; }
}
// Is the entry `name` of `dir` still the very file `fh`? Asked where bytes cannot tell: an EMPTY file this run
// has just created looks like any other empty file. (As far as the file system can tell: a handle is a path in
// Chromium, so a file that was exchanged for another one under the same name answers yes there.)
async function stillFile(dir, name, fh) {
  if (!fh) return true;
  const now = await dir.getFileHandle(name);
  return now === fh || (typeof now.isSameEntry === 'function' && await now.isSameEntry(fh));
}
// Is there an entry of that name? (Anything but "not found" is passed on: not knowing is not "free".)
async function isThere(dir, name) {
  try { await dir.getFileHandle(name); return true; }
  catch (e) { if (e && e.name === 'NotFoundError') return false; if (e && e.name === 'TypeMismatchError') return true; throw e; }
}
const toBytes = (data) => typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data);
// Does the file hold exactly these bytes? Bytes, not text: read as text, a file that somebody saved again with a
// byte-order mark in front looks like the one this run wrote.
async function holdsBytes(dir, name, data) {
  const want = toBytes(data), f = await (await dir.getFileHandle(name)).getFile();
  if (f.size !== want.length) return false;
  const got = new Uint8Array(await f.arrayBuffer());
  if (got.length !== want.length) return false;
  for (let i = 0; i < got.length; i++) if (got[i] !== want[i]) return false;
  return true;
}
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${DATASET_PREFIX}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// A run never writes into a folder that already exists. The name has one-second resolution and local time, so
// two runs could meet in one folder: a second tab, a quick second try, the hour that repeats when summer time
// ends. The second run then replaced images, classes.json and notes while the first run's annotations stayed in
// place — on images they were not drawn on. The name stays <prefix><date>-<time>; only a name that is taken
// gets "-2", "-3", … Tabs of this site take turns through a Web Lock, so two of them cannot both find the same
// name free.
// The lock ends at this browser. A run in ANOTHER browser (or profile) can find the same name free in the same
// instant, and creating a folder that has just been created does not fail. So a run takes a folder in two
// steps: it puts a mark of its own in it — an empty file whose name contains the run's id — and then looks at
// what the folder holds. Only a folder that holds NOTHING but that mark is the run's own:
//  * another run's mark: two runs found the name free together (each writes its mark before it looks, so of
//    two runs in one folder at least one sees the other);
//  * anything else: somebody was here before — a run that has already finished and taken its mark away again
//    looks exactly like that, and writing this run's lists there replaced the lists of a finished dataset.
// A run that does not find the folder its own leaves it as it is and takes a name nobody else can have: the
// time stamp followed by its whole id. That folder is checked the same way.
const RUN_MARK = '.prepare-run-';
const newRunId = () => (globalThis.crypto && crypto.randomUUID) ? crypto.randomUUID()
  : Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10).padEnd(8, '0')).join('');
async function createRunFolder(parent, runId) {
  const mark = RUN_MARK + runId;
  // true: `dir` is this run's alone. false: it is not, and nothing of this run is left in it.
  const claim = async (dir, name) => {
    let alone = true, failure = null;
    try {
      await writeFile(dir, mark, '');
      for await (const [n] of dir.entries()) if (n !== mark) { alone = false; break; }
      if (alone) return true;
    } catch (e) { failure = e; }   // the mark could not be written (or the folder not be read): said below, after taking back what there is of it
    // Not this run's alone. What this run put there goes again — and nothing else:
    //  * its mark, while that is still the EMPTY file this run made (a file of that name that holds something by
    //    now is somebody's file);
    //  * the folder, only when the mark was there to take back — that is what shows that the folder under this
    //    name is still the one this run made, and not one that was put in its place meanwhile — and only empty.
    // (Both used to be removed unasked: a file somebody had put under the mark's name was deleted, and so was
    // an empty folder that had been moved in under the folder's name.)
    let had = false;
    try { if (await holdsBytes(dir, mark, '')) { await dir.removeEntry(mark); had = true; } } catch (e) { /* not there, or not readable: left */ }
    if (had) { try { if (await stillDir(parent, name, dir)) await parent.removeEntry(name); } catch (e) { /* not empty: it is somebody's */ } }
    if (failure) throw failure;
    return false;
  };
  const pick = async () => {
    if (cancelRequested) return null;                                                 // Stop arrived while this run waited for its turn
    const base = stamp();
    for (let i = 1; i <= 200; i++) {
      const name = i === 1 ? base : `${base}-${i}`;
      try { await parent.getDirectoryHandle(name); continue; }                       // taken (by anyone): never reuse it
      catch (e) { if (e && e.name === 'TypeMismatchError') continue; if (!e || e.name !== 'NotFoundError') throw e; }
      const dir = await parent.getDirectoryHandle(name, { create: true });
      if (await claim(dir, name)) return dir;
      const ownName = `${base}-${runId}`;
      const own = await parent.getDirectoryHandle(ownName, { create: true });
      if (await claim(own, ownName)) return own;
      throw new Error(`the output folder “${ownName}” is in use by something else`);
    }
    throw new Error(`no free folder name left for “${base}”`);
  };
  const locks = typeof navigator !== 'undefined' && navigator.locks;
  if (!(locks && locks.request)) return pick();
  // Stop must also end the WAIT for the lock (another tab may hold it for long). The request itself stays in
  // the queue; when its turn comes it finds itself given up and does nothing. A run that has its turn already
  // is not cut short here: it finishes taking its folder, and runAll puts the folder away again.
  let givenUp = false, started = false, mine = null;
  const stop = new Promise((resolve) => { mine = endFolderWait = () => { if (!started) { givenUp = true; resolve(null); } }; });
  try { return await Promise.race([locks.request('collateral-annotator-prepare-output', () => { if (givenUp) return null; started = true; return pick(); }), stop]); }
  finally { if (endFolderWait === mine) endFolderWait = null; }
}
// Take away a run folder in which no case was written. A file goes only if it is one this run wrote AND still
// holds exactly what this run wrote into it, and only if the folder holds nothing else: a case folder, another
// run's mark, a file of another name, or one of this run's files that somebody has changed since — and
// everything stays exactly as it is. The folder itself is removed empty or not at all, never with its
// contents: under one name there can be somebody else's work. (Between looking at a file and removing it
// there is no way to hold it still; the folder is this run's own by its mark, which keeps that gap to files
// nobody else has a reason to touch.)
// (made / tried: the files this run CREATED, and what a write that was reported as failed tried to put into one.
// A file this run created and could not fill is its own too — empty, or holding what that write tried to write:
// a run whose very first write failed used to leave its folder behind with an empty classes.json in it.)
async function removeEmptyRun(parent, root, runId, wrote, made, tried, handleOf) {
  const mark = RUN_MARK + runId, found = [];
  if (!(await stillDir(parent, root.name, root))) return false;   // the folder under this name is no longer the one this run made
  for await (const [name, h] of root.entries()) {
    const known = name === mark || wrote.has(name) || !!(made && made.has(name));
    if (h.kind !== 'file' || !known) return false;
    // (the mark is this run's while it is the empty file this run put there: one that holds something by now
    // is somebody's file under that name)
    let own = false;
    if (name === mark) own = await holdsBytes(root, name, '');
    else {
      if (wrote.has(name)) own = await holdsBytes(root, name, wrote.get(name));
      if (!own && tried && tried.has(name)) own = await holdsBytes(root, name, tried.get(name));
      // (empty, and — as far as the file system can tell — the very file this run created: see put)
      if (!own && !wrote.has(name)) own = await holdsBytes(root, name, '') && await stillFile(root, name, handleOf && handleOf.get(name));
    }
    if (!own) return false;
    found.push(name);
  }
  if (!found.includes(mark)) return false;                       // not marked as this run's
  for (const name of found) if (name !== mark) await root.removeEntry(name);
  await root.removeEntry(mark);
  await parent.removeEntry(root.name);                           // not recursive: fails if anything appeared meanwhile
  return true;
}
async function ensureWritable(dir) {
  const o = { mode: 'readwrite' };
  if ((await dir.queryPermission(o)) === 'granted') return true;
  return (await dir.requestPermission(o)) === 'granted';
}

function mappingRow(c) {
  const h = c.e.header;
  return {
    case: c.case, sid: c.sid, source_path: c.e.path, patient_id: c.patient, view: c.view, acq_datetime: c.dt,
    study_instance_uid: h.studyUid, series_number: h.seriesNumber, run_rank: c.runRank, n_runs_patient: c.nRuns, run_label: c.runLabel,
    frames: h.frames, rows: h.rows, cols: h.cols, width: c.w, height: c.h, crop_box: c.box, transfer_syntax: h.tsName,
    pixel_spacing_mm: h.pixelSpacing, manufacturer: h.manufacturer, status: c.status, units: c.units, seconds: c.seconds, message: c.message,
  };
}

// ---------------------------------------------------------------- the run

// Every run builds a complete new dataset folder from all DICOMs in the plan.
async function runAll() {
  if (busy) return;
  const folds = selectedFolds();
  if (!folds.length || !plan.length) return;
  busy = true; cancelRequested = false;
  el.cancel.hidden = false; el.cancel.disabled = false;
  for (const c of plan) { c.status = 'planned'; c.message = ''; c.w = c.h = c.box = c.units = c.seconds = ''; setCaseState(c, 'planned', 'planned'); }
  refreshButtons();
  const t0 = performance.now();
  let root = null, parent = null, nDone = 0, nFail = 0, stopped = false, listErr = null;
  const unitTimes = [], manifestRows = [], runId = newRunId();
  const wrote = new Map();                                       // file in the run folder -> the text this run last wrote into it
  // The folder was taken empty, so the first time this run writes one of its files there is no file of that name
  // — unless something else has written it in the moment since. Then it is not this run's to write over: the
  // run ends, and the folder is left as it is.
  // A file is this run's from the moment this run has CREATED it — not from the moment it first tried to. (The
  // first try used to count: when creating the file itself failed and nobody else was involved, the next try
  // found "its" file missing and blamed somebody else; and when somebody else created an empty file of that
  // name in between, the next try took it for the run's own empty file and wrote into it.) Until then the name
  // has to be free, on every try.
  // Every LATER write replaces a file this run wrote before — the two lists are rewritten after each case, a
  // whole case's computing apart. It is replaced only while it still holds what this run put there: its last
  // good write, or what a write that was reported as failed may have left (the text it tried to write, or the
  // empty file it had just created). Anything else — or the file being gone — is somebody else's doing, and
  // stays: the run stops and says which file. When the file cannot be READ for that check, nothing is known:
  // that is not blamed on anybody, the write is tried again like any write that failed, and if it still cannot
  // be read the run says that it could not check.
  // The folder this run writes into is the run's by its MARK — the empty file with the run's id that it put
  // there when it took the folder. A folder can be moved away while the run is working and another one put in
  // its place under the same name: the run's handle then leads into that other folder (a handle is a path), and
  // the run went on to write whole cases — images, labels, notes — into a folder that was never its own, and
  // called them part of its dataset. So before anything more is written (each of the lists, each unit) the mark
  // is looked for again; without it the run stops and says so. (A folder that is copied together with its mark,
  // or exchanged in the instant after the look, cannot be told apart this way.)
  // (The mark not being there is an answer. A reading that fails for another reason is none: it is tried again —
  // one such failure used to end the case that was being written.)
  const markName = RUN_MARK + runId;
  const rootIsOurs = async () => {
    for (let i = 0; ; i++) {
      try { return await holdsBytes(root, markName, ''); }
      catch (e) {
        if (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) return false;
        if (i >= 2) throw e;
        await new Promise((r) => setTimeout(r, 150));
      }
    }
  };
  const lostRoot = () => Object.assign(new Error(`this run's mark is gone from “${root.name}”: the folder was moved or replaced while the run was working, or the mark was taken out of it`), { foreign: true, lost: true });
  const made = new Set(), tried = new Map(), handleOf = new Map();
  const put = async (name, text) => {
    if (!(await rootIsOurs())) throw lostRoot();
    let fh;
    if (!made.has(name)) {
      if (await isThere(root, name)) throw Object.assign(new Error(`“${name}” has appeared in “${root.name}”: the folder is being used by something else`), { foreign: true });
      fh = await root.getFileHandle(name, { create: true });
      made.add(name); handleOf.set(name, fh);
    } else {
      let own = false;
      try {
        // (the empty file this run created and has not filled yet: bytes say nothing about an empty file, so —
        // where the file system can be asked — it also has to be the very file this run created. Another empty
        // file put in its place used to be taken for it, and was written full.)
        own = (wrote.has(name) && await holdsBytes(root, name, wrote.get(name))) || (tried.has(name) && await holdsBytes(root, name, tried.get(name))) ||
              (!wrote.has(name) && await holdsBytes(root, name, '') && await stillFile(root, name, handleOf.get(name)));
      } catch (e) {
        // gone, or a folder under that name now: somebody else's doing. Anything else: it cannot be read just now.
        if (!(e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError'))) throw new Error(`“${name}” cannot be read just now, so it could not be checked that it still holds what this run wrote (${(e && e.message) || e})`);
      }
      if (!own) throw Object.assign(new Error(`“${name}” was changed by something else after this run wrote it`), { foreign: true });
      fh = await root.getFileHandle(name);
    }
    try { const w = await fh.createWritable(); await w.write(text); await w.close(); }
    catch (e) {
      tried.set(name, text);
      // A write can be reported as failed after it has landed (the last step, the close, answers with an error
      // and the file holds every byte). Then it IS written: saying otherwise ended the run with "the lists do
      // not show the last case" over lists that showed it.
      let landed = false;
      try { landed = await holdsBytes(root, name, text); } catch (e2) { landed = false; }
      if (!landed) throw e;
    }
    wrote.set(name, text); tried.delete(name);
  };
  // What do the lists hold now, against what this run last wrote? Looked at, never written: a list that somebody
  // else has changed is theirs. 'same' / 'changed' (also: gone, or a folder under that name) / 'unknown' — it
  // cannot be read just now, and then nothing is said about it either way (it used to count as unchanged, and
  // the last line called a list "up to date" that held somebody else's text).
  const LISTS = ['case_mapping.csv', 'manifest.csv'];
  const listsNow = async () => {
    const out = {};
    for (const n of LISTS) {
      if (!wrote.has(n)) continue;
      try { out[n] = (await holdsBytes(root, n, wrote.get(n))) ? 'same' : 'changed'; }
      catch (e) { out[n] = (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError')) ? 'changed' : 'unknown'; }
    }
    return out;
  };
  try {
    parent = outMode() === 'new' ? inputDir : outParent;
    if (!(await ensureWritable(parent))) throw new Error(`no permission to write into “${parent.name}”`);
    // Stop pressed while the permission was being asked: the model is not loaded (or downloaded) after all
    if (cancelRequested) { setStatus('Stopped before anything was written.'); setProgress(null); return; }
    setStatus('Loading the vessel model…'); setProgress(0);
    // Stop pressed while the model was loading: the worker ends the download and says "cancelled". Nothing has
    // been written yet, so nothing is — no empty dataset folder to open by mistake.
    try { await ensureLoaded(folds); }
    catch (e) { if (!(cancelRequested && e && e.message === 'cancelled')) throw e; }
    if (cancelRequested) { setStatus('Stopped before anything was written.'); setProgress(null); return; }
    root = await createRunFolder(parent, runId);
    if (!root || cancelRequested) {                              // stopped while waiting for the folder, or right after getting it
      let gone = !root;
      if (root) { try { gone = await removeEmptyRun(parent, root, runId, wrote, made, tried, handleOf); } catch (e) { gone = false; } }
      setStatus(gone ? 'Stopped before anything was written.' : `Stopped before anything was written; “${root.name}” holds no cases.`); setProgress(null); return;
    }

    await put('classes.json', JSON.stringify({ classes: [{ index: 1, name: 'Collateral' }] }, null, 2));
    const params = {
      generator: GENERATOR, generator_release: V, created: new Date().toISOString(), input_folder: inputDir.name,
      settings: { remove_black_border: el.crop.checked, minip_unit: el.minip.checked, folds: folds.map((f) => f.fold), mirroring: el.mirror.checked,
        backend: runtimeLabel, seed_notes: el.seedNotes.checked, patient_from: 'file name up to the first "_"' },
      model: { name: manifest.name, weights: REPO_PAGE, files: folds.map((f) => ({ file: f.file, sha256: f.sha256 })), minip_mask: 'same nnU-Net as the frames' },
      formats: { case_fmt: 's_{}', frame_fmt: 'f_{}', label_dtype: '<u2', mask_dtype: '|u1', schema_version: 5, coord_order: 'xy', px: 1.0, py: 1.0, unit_suffix: 'px' },
      notes: [
        '8-bit conversion as preprocess_zurich_dsa_selected.py (first WindowCenter/Width, float32, truncation); MinIP = min over raw frames, then windowed.',
        'Black border: one crop box per DICOM, the bounding box of the windowed MinIP > 0.',
        'Pixels: only the Bits Stored bits count (signed samples are two\'s complement in them); a JPEG Lossless frame with a point transform is decoded as ITU-T T.81 says (like GDCM and FFmpeg; pylibjpeg-libjpeg returns such frames too bright).',
        'label.npy / geometry.json: JavaScript port of prepare_dataset partition.py / metrics.py; identical except where a pixel is exactly as far from two branches.',
      ],
    };
    await put('build_params.json', JSON.stringify(params, null, 2));

    // the mapping is written first and rewritten after every case, so it always says what is in the folder
    const saveMapping = () => put('case_mapping.csv', toCsv(plan.map(mappingRow), MAPPING_FIELDS));
    const saveManifest = () => put('manifest.csv', toCsv(manifestRows, MANIFEST_FIELDS));
    // Both lists, a few tries: one failed write of a small file should not end a run that has hours of
    // computed frames on disk. A list that still cannot be written ends the run with a message that says so
    // (below) — the frames written so far stay, complete, but the lists do not show the last case.
    // (A list that is written is not written again by a later try: the tries used to start over, so "the mapping
    // was written, then the manifest failed, then the mapping failed" ended with the message for a mapping that
    // is behind — while it was the manifest that was.)
    const saveLists = async () => {
      let mappingDone = false;
      for (let i = 0; ; i++) {
        let list = 'case_mapping.csv';
        try { if (!mappingDone) { await saveMapping(); mappingDone = true; } list = 'manifest.csv'; await saveManifest(); return; }
        catch (e) { if (i >= 2 || e.foreign) { e.list = list; throw e; } await new Promise((r) => setTimeout(r, 250)); }   // (a file somebody else has changed is not tried again)
      }
    };
    await saveLists();

    const todo = plan, totalUnits = todo.reduce((s, c) => s + c.e.header.frames + (el.minip.checked && c.e.header.frames > 1 ? 1 : 0), 0);
    let unitsSoFar = 0;
    for (let ci = 0; ci < todo.length; ci++) {
      if (cancelRequested) { stopped = true; break; }
      const c = todo[ci];
      const tc = performance.now();
      setCaseState(c, 'working', 'decoding…');
      // Units are written one after another, in the order the worker delivers them. A unit is listed in
      // manifest.csv only when all of its files are on disk. The first failed write ends the case: nothing more
      // of it is written, the unit it interrupted is removed, and the worker stops computing units that could
      // not be saved. `writes` never rejects, so a failure cannot go unnoticed while the worker is still busy.
      let caseDir = null, caseMade = false, writes = Promise.resolve(), writeErr = null, units = 0, count = 0, info = null, warnings = [];
      const note = JSON.stringify({ schema_version: 1, coord_order: 'xy', text: `${c.patient} | ${c.view} | ${c.dt} | ${c.runRank}/${c.nRuns}`, markers: [] }, null, 2);
      try {
        const file = await c.e.handle.getFile();
        // Stop arrived while the file was being read. The worker would never see it (it clears its flag when a
        // case starts), and the whole case was then processed and reported as done.
        if (cancelRequested) { setCaseState(c, 'planned', 'planned'); stopped = true; break; }
        let lastUnitAt = performance.now();
        await ask({ type: 'process', file, crop: el.crop.checked, minip: el.minip.checked, mirror: el.mirror.checked, keys: folds.map(keyOf) }, (m) => {
          if (m.type === 'caseinfo') { info = m; count = m.count; c.w = m.w; c.h = m.h; c.box = m.box ? m.box.join(' ') : ''; }
          else if (m.type === 'run') {
            setProgress((unitsSoFar + m.index + m.done / m.total) / Math.max(1, totalUnits));
            const per = unitTimes.length ? unitTimes.reduce((a, b) => a + b, 0) / unitTimes.length : 0;
            const eta = per ? ` · about ${fmtS(per * (totalUnits - unitsSoFar - m.index))} left` : '';
            setStatus(`Case ${ci + 1}/${todo.length} (${c.case}) · unit ${m.index + 1}/${m.count}${eta}`);
            setCaseState(c, 'working', `${m.index + 1}/${m.count}`);
          } else if (m.type === 'unit') {
            const now = performance.now(); unitTimes.push(now - lastUnitAt); lastUnitAt = now;
            if (m.warning) warnings.push(`${m.name}: ${m.warning}`);
            const row = { case: c.case, unit: m.name, sid: c.sid, fid: m.name === 'minip' ? MINIP_FID : parseInt(m.name.slice(2), 10),
              height: m.h, width: m.w, segments: m.segments, vessel_px: m.vessel, seconds: m.seconds.toFixed(3),
              patient_id: c.patient, view: c.view, acq_datetime: c.dt, run_rank: c.runRank, n_runs_patient: c.nRuns, run_label: c.runLabel,
              source_path: c.e.path, pixel_spacing_mm: c.e.header.pixelSpacing };
            writes = writes.then(async () => {
              // Stop also holds for units that are computed and only wait to be written: none of them is started
              // after it. (The worker can be done with a case while its last units are still in this queue.)
              if (writeErr || cancelRequested) return;
              // What this run put into the unit: [name, data] for a file it created and finished, [name, null]
              // for one it created and could not fill (an empty file is left then). Nothing else is ever taken
              // back — not a file that was there before (the unit's folder is new, so such a file is somebody
              // else's, and it is not written over either), not one that holds something else by now.
              // (…or for one whose write was reported as failed AFTER it had landed: [name, null, data]. It holds
              // every byte then, and is taken back like the rest — left in place, it was all that remained of
              // the unit: a folder with one file in it, which the annotator lists as a frame and cannot open.)
              // (Each entry also carries the handle the file was created with: where the file system can tell two
              // files apart, only that very file is taken back — bytes alone took another file of the same
              // content for this run's.)
              let u = null, unitMade = false; const mine = [];
              const w = async (name, data, first) => {
                // (the mark is looked for before EACH file, not only before the unit: a folder exchanged while a
                // unit was being written got the rest of that unit's files. The first file comes right after
                // the look that starts the unit.)
                if (!first && !(await rootIsOurs())) throw lostRoot();
                if (await isThere(u, name)) throw new Error(`“${name}” is already in “${c.case}/${m.name}”: the folder is being used by something else`);
                let fh = null;
                try {
                  fh = await u.getFileHandle(name, { create: true });
                  const ws = await fh.createWritable(); await ws.write(data); await ws.close();
                  mine.push([name, data, null, fh]);
                } catch (e) { if (fh) mine.push([name, null, data, fh]); throw e; }
              };
              try {
                if (!(await rootIsOurs())) throw lostRoot();          // (see rootIsOurs: before anything of this unit is created)
                // Stop pressed while the mark was being looked for: nothing of this unit exists yet, and nothing
                // of it is started now. (The look used to be followed by the whole unit all the same.)
                if (cancelRequested) return;
                // (A folder that is already there — empty, made by somebody else — is used, but it is not this
                // run's to remove if the unit fails: only folders this run made are taken away again.)
                if (!caseDir) { caseMade = !(await dirThere(root, c.case)); caseDir = await root.getDirectoryHandle(c.case, { create: true }); }
                unitMade = !(await dirThere(caseDir, m.name));
                u = await caseDir.getDirectoryHandle(m.name, { create: true });
                await w('label.npy', m.labelNpy, true);
                await w('mask.npy', m.maskNpy);
                await w('geometry.json', m.geometry);
                if (el.seedNotes.checked) await w('note.json', note);
                await w('frames.png', m.framesPng);                 // the image last: without it a unit cannot pass for a finished one
                manifestRows.push(row); units++;
              } catch (e) {
                writeErr = e;
                // Take back the files this run put into the unit — each one only if it still holds exactly what
                // this run wrote (a name alone proves nothing: the file may be somebody else's by now) — then the
                // unit's folder if that leaves it empty. Never the folder with whatever is in it.
                // Nothing at all is taken back when the folder is no longer this run's (its mark is gone): what
                // this path leads to now may be a folder that was put in its place, and a file of the same content
                // in there is not this run's to remove. The unit's files stay where they were written.
                let ours = false;
                if (u && !e.lost) { try { ours = await rootIsOurs(); } catch (e2) { ours = false; } }
                if (u && ours) {
                  for (const [name, data, attempted, fh] of mine) {
                    try {
                      if ((await holdsBytes(u, name, data === null ? new Uint8Array(0) : data) ||
                          (data === null && attempted != null && await holdsBytes(u, name, attempted))) && await stillFile(u, name, fh)) await u.removeEntry(name);
                    } catch (e2) { /* gone, or not readable: left alone */ }
                  }
                  if (unitMade) { try { if (await stillDir(caseDir, m.name, u)) await caseDir.removeEntry(m.name); } catch (e2) { /* not empty: left as it is, without frames.png */ } }
                }
                if (worker) worker.postMessage({ type: 'cancel' });
              }
            });
            preview = { w: m.w, h: m.h, gray: m.gray, label: m.label };
            el.previewInfo.textContent = `${c.case}/${m.name} · ${m.w}×${m.h} · ${plural(m.segments, 'segment')} · vessel ${(100 * m.vessel / (m.w * m.h)).toFixed(1)} %`;
            draw();
          }
        });
        await writes;
        if (writeErr) throw writeErr;
        if (cancelRequested && units < count) throw new Error('cancelled');   // stopped while units were waiting to be written: the case is incomplete
        unitsSoFar += count;
        c.status = 'done'; c.units = units; c.seconds = ((performance.now() - tc) / 1000).toFixed(1);
        c.message = `${plural(units, 'unit')} · ${c.w}×${c.h}${info && (info.w !== info.srcW || info.h !== info.srcH) ? ` (cropped from ${info.srcW}×${info.srcH})` : ''}` +
          (info && info.framesDecoded < info.framesHeader ? ` · ${info.framesHeader - info.framesDecoded} unreadable frame(s) at the end skipped` : '') +
          (warnings.length ? ` · ${warnings.join('; ')}` : '');
        setCaseState(c, 'done', c.message);
        nDone++;
      } catch (err) {
        await writes;
        c.units = units || '';                               // what is really in the folder for this case
        if (writeErr) {                                      // (the worker reports "cancelled" here because we stopped it)
          c.status = 'failed'; c.message = `could not write the output (${writeErr.message})${units ? ` · ${plural(units, 'unit')} written before that` : ''}`;
          setCaseState(c, 'failed', c.message); nFail++;
          if (caseDir && caseMade && !units && !writeErr.lost) { try { if (await stillDir(root, c.case, caseDir)) await root.removeEntry(c.case); } catch (e2) { /* not empty or not removable: left as is */ } }   // (not when the folder is no longer this run's: see the unit, above)
        } else if (err.message === 'cancelled') {
          c.status = 'partial'; c.message = 'stopped (this case is incomplete)';
          setCaseState(c, 'failed', c.message); stopped = true;
        } else {
          c.status = 'failed'; c.message = err.message; setCaseState(c, 'failed', err.message); nFail++;
        }
      }
      try { await saveLists(); } catch (e) { listErr = e; break; }
      if (stopped) break;
    }
    const per = unitTimes.length ? ` · ${fmtS(unitTimes.reduce((a, b) => a + b, 0) / unitTimes.length)} per unit` : '';
    // the units counted are the ones on disk and in manifest.csv — also those of a case that failed or was
    // stopped part-way (they used to be left out, so the line said fewer units than the folder holds)
    const nUnits = manifestRows.length;
    if (listErr && listErr.lost) {
      // The run's mark is not in the folder under this name any more (see rootIsOurs): the folder was moved or
      // replaced, or the mark was taken out. Nothing more was written, and nothing is said about what "the
      // folder" holds now. What the run wrote is in the folder it started in — wherever that is by now — with
      // its lists as they were last written; the unit that was being written when the mark went may be there in
      // part. (This used to say the units were "in the folder that was moved", also when nothing had moved.)
      setStatus(`Stopped: this run's mark is gone from “${root.name}” — the folder was moved or replaced while the run was working, or the mark was taken out of it — and nothing more was written. ` +
        (nUnits ? `${plural(nUnits, 'unit')} had been written completely before that, into the folder the run started in; its lists may not show the last case.` : 'No unit had been written completely.') +
        ' The unit that was being written at that moment may be incomplete there.', true);
      setProgress(null);
      return;
    }
    // (said about the lists as they are NOW: one that somebody else has changed since this run last wrote it is
    // left as it is — and is not called up to date; one that cannot be read just now is not called anything.)
    // The run has nothing left to write here. This last look only reads, so it is not waited for without end:
    // Stop ends it, and so do a few seconds — a folder that does not answer kept the page locked ("Stopping…")
    // until it did. What answers later is not used.
    // (The mark is looked for once more with it: a folder that was exchanged after the last list had been written
    // used to be announced as the finished dataset — "open it in the annotator" — under a name that leads
    // somewhere else by now.)
    let endTail = null;
    const tail = await Promise.race([
      (async () => { let ours = null; try { ours = await rootIsOurs(); } catch (e) { ours = null; } return { ours, lists: await listsNow().catch(() => null) }; })(),
      new Promise((r) => { endTail = endTailWait = () => r(null); setTimeout(endTail, 5000); })]);
    if (endTailWait === endTail) endTailWait = null;
    const lists = tail ? tail.lists : null, markGone = !!tail && tail.ours === false;
    const stateOf = (n) => !wrote.has(n) ? 'none' : (lists ? lists[n] : 'unknown');
    const changed = LISTS.filter((n) => stateOf(n) === 'changed'), unknown = LISTS.filter((n) => stateOf(n) === 'unknown');
    const unknownNote = unknown.length ? ` Note: ${unknown.join(' and ')} could not be read just now, so it could not be checked that ${unknown.length === 1 ? 'it still holds' : 'they still hold'} what this run wrote.` : '';
    if (listErr) {
      // say which list it was: the mapping is written first, so when the manifest fails the mapping is current
      const m = stateOf('case_mapping.csv');
      const what = listErr.list === 'manifest.csv'
        ? `manifest.csv could not be written; ${m === 'changed' ? 'case_mapping.csv was written by this run and has been changed by something else since' : m === 'unknown' ? 'case_mapping.csv was written by this run and cannot be read just now to check it' : 'case_mapping.csv is up to date'}, manifest.csv does not list the last case`
        : 'case_mapping.csv could not be written; neither case_mapping.csv nor manifest.csv shows the last case';
      setStatus(`Stopped: in “${root.name}” ${what} (${listErr.message}). ${plural(nUnits, 'unit')} in the folder ${nUnits === 1 ? 'is' : 'are'} complete.`, true);
    } else if (stopped && !nUnits && !nFail) {
      // stopped before a single unit was written: the folder holds only this run's own lists, so it goes again
      let removed = false;
      try { removed = await removeEmptyRun(parent, root, runId, wrote, made, tried, handleOf); } catch (e) { /* left in place */ }
      setStatus(removed ? 'Stopped before anything was written.' : `Stopped before anything was written; “${root.name}” holds no cases.`);
    } else if (markGone) {
      setStatus(`${stopped ? 'Stopped' : 'Done'}: ${plural(nDone, 'case')}${nFail ? `, ${nFail} failed` : ''}, ${plural(nUnits, 'unit')} in ${fmtS(performance.now() - t0)}${per} — but this run's mark is gone from “${root.name}”: ` +
        'the folder was moved or replaced before the run had finished, or the mark was taken out of it. The dataset is in the folder the run started in; make sure the folder under this name is that one before opening it.', true);
    } else {
      setStatus(`${stopped ? 'Stopped' : 'Done'}: ${plural(nDone, 'case')}${nFail ? `, ${nFail} failed` : ''}, ${plural(nUnits, 'unit')} in ${fmtS(performance.now() - t0)}${per}. ` +
        `Dataset: “${root.name}” — open it in the annotator with “Open data folder”.` +
        (changed.length ? ` Note: ${changed.join(' and ')} ${changed.length === 1 ? 'was' : 'were'} changed by something else after this run last wrote ${changed.length === 1 ? 'it' : 'them'}, and left that way — check ${changed.length === 1 ? 'it' : 'them'} against the folder.` : '') + unknownNote, nFail > 0 || changed.length > 0 || unknown.length > 0);
    }
    setProgress(null);
  } catch (e) {
    // the run ended before its first case (the folder or its lists could not be written): no half-made dataset
    // folder is left to be opened by mistake — if it is this run's and holds nothing but what this run put there
    let where = '';
    if (root && !manifestRows.length) { try { if (!(await removeEmptyRun(parent, root, runId, wrote, made, tried, handleOf))) where = ` (“${root.name}” was left as it is)`; } catch (e2) { where = ` (“${root.name}” was left as it is)`; } }
    setStatus(((e && e.message) || 'The run could not start.') + where, true); setProgress(null);
  } finally {
    // (the mark goes while it is still the empty file this run put there; a file of that name that holds something is not this run's)
    // The run is over and has said so; taking the mark away is not waited for without end either. Stop ends the
    // wait, and so do a few seconds — a folder that does not answer kept the page locked here after the lists'
    // last look had been given up. A mark that is left behind is an empty file with this run's id in its name:
    // it is in nobody's way, and if the folder answers later it is taken away then.
    if (root) {
      settled = true;
      const unmark = (async () => { try { if (await holdsBytes(root, RUN_MARK + runId, '')) await root.removeEntry(RUN_MARK + runId); } catch (e) { /* already gone with the folder */ } })();
      let endMark = null, markTimer = 0;
      await Promise.race([unmark, new Promise((r) => { endMark = endTailWait = () => r(); markTimer = setTimeout(endMark, 5000); })]);
      clearTimeout(markTimer);
      if (endTailWait === endMark) endTailWait = null;
      settled = false;
    }
    busy = false; el.cancel.hidden = true;
    refreshButtons(); refreshCacheInfo();
  }
}

function cancelRun() {
  if (!busy) return;
  cancelRequested = true; el.cancel.disabled = true;
  if (endFolderWait) endFolderWait();                // ends the wait for the output-folder lock
  if (endTailWait) endTailWait();                    // …and a finished run's last look at its lists, and at its mark
  if (worker) worker.postMessage({ type: 'cancel' });
  if (!settled) setStatus('Stopping…');              // (a run that has already said how it ended keeps that line)
}

// ---------------------------------------------------------------- preview

function colorOf(id) {                     // stable, well-spread colour per segment id
  const h = (id * 137.508) % 360, s = 0.75, v = 0.95;
  const f = (n) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return [f(5) * 255, f(3) * 255, f(1) * 255];
}
function draw() {
  if (!preview) return;
  const { w, h, gray, label } = preview;
  const mode = document.querySelector('input[name=mode]:checked').value;
  el.empty.hidden = true; el.view.hidden = false;
  el.view.width = w; el.view.height = h;
  const ctx = el.view.getContext('2d'), out = ctx.createImageData(w, h), d = out.data, a = el.opacity.value / 100;
  const cache = new Map();
  for (let i = 0, j = 0; i < gray.length; i++, j += 4) {
    let r = gray[i], g = gray[i], b = gray[i];
    const l = label[i];
    if (l && mode === 'mask') { r = r * (1 - a) + 255 * a; g = g * (1 - a) + 64 * a; b = b * (1 - a) + 64 * a; }
    else if (l && mode === 'segments') {
      let c = cache.get(l); if (!c) { c = colorOf(l); cache.set(l, c); }
      r = r * (1 - a) + c[0] * a; g = g * (1 - a) + c[1] * a; b = b * (1 - a) + c[2] * a;
    }
    d[j] = r; d[j + 1] = g; d[j + 2] = b; d[j + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
}

// ---------------------------------------------------------------- downloaded-model storage (shared with the
// vessel-segmentation page on the same site)

async function cacheSummary() {
  if (!('caches' in self)) return null;
  let files = 0, bytes = 0;
  for (const name of await caches.keys()) {
    if (!MODEL_CACHE.test(name)) continue;
    const cache = await caches.open(name);
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (!res) continue;
      files++;
      bytes += Number(res.headers.get('x-model-bytes')) || (await res.blob()).size;
    }
  }
  return { files, bytes };
}
async function refreshCacheInfo() {
  try {
    const s = await cacheSummary();
    cacheState = s || { files: 0, bytes: 0 };
    el.cacheInfo.textContent = !s ? 'This browser has no cache storage, so models are not kept between visits.'
      : s.files ? `${plural(s.files, 'model file')} stored in this browser · ${fmtMB(s.bytes)}` : 'No model files stored in this browser.';
  } catch (e) { el.cacheInfo.textContent = `Could not read this browser's storage (${e.message}).`; }
  refreshButtons();
}
function disarmClear() { clearTimeout(disarmTimer); el.clearCache.classList.remove('armed'); el.clearCache.textContent = 'Delete downloaded models'; }
async function clearCache() {
  if (busy || !cacheState.files) return;
  if (!el.clearCache.classList.contains('armed')) {
    el.clearCache.classList.add('armed');
    el.clearCache.textContent = `Click again to delete ${fmtMB(cacheState.bytes)}`;
    disarmTimer = setTimeout(disarmClear, 5000);
    return;
  }
  disarmClear();
  busy = true; refreshButtons();
  try {
    const before = await cacheSummary();
    for (const name of await caches.keys()) if (MODEL_CACHE.test(name)) await caches.delete(name);
    if (worker) { worker.terminate(); worker = null; workerBackend = null; }
    loadedKeys = new Set();
    setStatus(`Deleted ${plural(before.files, 'model file')} (${fmtMB(before.bytes)}). The next run downloads them again.`);
  } catch (e) { setStatus(`Could not delete the stored models (${e.message}).`, true); }
  finally { busy = false; refreshFoldInfo(); await refreshCacheInfo(); }
}

// ---------------------------------------------------------------- wiring

el.openFolder.addEventListener('click', openFolder);
el.chooseOut.addEventListener('click', chooseOut);
document.querySelectorAll('input[name=outMode]').forEach((r) => r.addEventListener('change', onModeChange));
for (const i of [el.startNum, el.minip]) i.addEventListener('change', () => { if (scanned.length) buildPlan(); });
el.run.addEventListener('click', runAll);
el.cancel.addEventListener('click', cancelRun);
el.backend.addEventListener('change', () => { if (worker && !busy) { worker.terminate(); worker = null; workerBackend = null; loadedKeys = new Set(); refreshFoldInfo(); } });
el.opacity.addEventListener('input', draw);
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', draw));
el.clearCache.addEventListener('click', clearCache);
el.clearCache.addEventListener('blur', disarmClear);

// Hooks for automated checks (the folder pickers cannot be scripted): window.__prepare
window.__prepare = {
  useInputFolder, runAll, isBusy: () => busy, plan: () => plan.map((c) => ({ case: c.case, path: c.e.path, patient: c.patient, view: c.view, dt: c.dt, run: `${c.runRank}/${c.nRuns}`, status: c.status, message: c.message })),
};

if (!('showDirectoryPicker' in window)) el.unsupported.hidden = false;
if (!('gpu' in navigator)) el.backend.querySelector('option[value=webgpu]').disabled = true;
refreshButtons(); refreshOutInfo();
loadManifest();
refreshCacheInfo();
