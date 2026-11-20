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
      (toFetch.length ? `${fmtMB(toFetch.reduce((s, f) => s + f.size, 0))} to load (cached after the first download)` : 'loaded');
  refreshButtons();
}

// ---------------------------------------------------------------- model manifest + worker

async function loadManifest() {
  try {
    const res = await fetch(WEIGHTS + 'model.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    manifest = await res.json();
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
  } catch (e) {
    el.modelInfo.textContent = 'Model info unavailable';
    setStatus(`Could not read ${WEIGHTS}model.json (${e.message}).`, true);
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
  const models = folds.map((f) => ({ key: keyOf(f), url: WEIGHTS + f.file, size: f.size, sha256: f.sha256 }));
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
function acqDateTime(h) {
  for (const [d, t] of [[h.acqDate, h.acqTime], [h.contentDate, h.contentTime], [h.seriesDate, h.seriesTime], [h.studyDate, h.studyTime]])
    if (d) return fmtDateTime(d, t);
  return '';
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
    const h = e.header, patient = patientOf(e), dt = acqDateTime(h);
    return { e, patient, view: viewOf(e.name, h), dt, runKey: `${patient}|${h.studyUid}|${h.seriesNumber || (h.studyUid ? '' : e.path)}` };
  });
  const runs = new Map();                                    // runKey -> earliest time
  for (const i of infos) { const t = i.dt || '9999'; if (!runs.has(i.runKey) || t < runs.get(i.runKey)) runs.set(i.runKey, t); }
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

  let next = Math.max(0, parseInt(el.startNum.value, 10) || 0);
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
  setStatus(plan.length ? 'Ready. Check the cases below, then press “Prepare dataset”.' : 'Pick a folder that contains DICOM files.');
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
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return `${DATASET_PREFIX}${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
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
  let root = null, nDone = 0, nFail = 0, nUnits = 0, stopped = false;
  const unitTimes = [];
  try {
    const parent = outMode() === 'new' ? inputDir : outParent;
    if (!(await ensureWritable(parent))) throw new Error(`no permission to write into “${parent.name}”`);
    setStatus('Loading the vessel model…'); setProgress(0);
    await ensureLoaded(folds);
    root = await parent.getDirectoryHandle(stamp(), { create: true });

    await writeFile(root, 'classes.json', JSON.stringify({ classes: [{ index: 1, name: 'Collateral' }] }, null, 2));
    const params = {
      generator: GENERATOR, generator_release: V, created: new Date().toISOString(), input_folder: inputDir.name,
      settings: { remove_black_border: el.crop.checked, minip_unit: el.minip.checked, folds: folds.map((f) => f.fold), mirroring: el.mirror.checked,
        backend: runtimeLabel, seed_notes: el.seedNotes.checked, patient_from: 'file name up to the first "_"' },
      model: { name: manifest.name, weights: REPO_PAGE, files: folds.map((f) => ({ file: f.file, sha256: f.sha256 })), minip_mask: 'same nnU-Net as the frames' },
      formats: { case_fmt: 's_{}', frame_fmt: 'f_{}', label_dtype: '<u2', mask_dtype: '|u1', schema_version: 5, coord_order: 'xy', px: 1.0, py: 1.0, unit_suffix: 'px' },
      notes: [
        '8-bit conversion as preprocess_zurich_dsa_selected.py (first WindowCenter/Width, float32, truncation); MinIP = min over raw frames, then windowed.',
        'Black border: one crop box per DICOM, the bounding box of the windowed MinIP > 0.',
        'label.npy / geometry.json: JavaScript port of prepare_dataset partition.py / metrics.py; identical except where a pixel is exactly as far from two branches.',
      ],
    };
    await writeFile(root, 'build_params.json', JSON.stringify(params, null, 2));

    // the mapping is written first and rewritten after every case, so it always says what is in the folder
    const saveMapping = () => writeFile(root, 'case_mapping.csv', toCsv(plan.map(mappingRow), MAPPING_FIELDS));
    const manifestRows = [];
    const saveManifest = () => writeFile(root, 'manifest.csv', toCsv(manifestRows, MANIFEST_FIELDS));
    await saveMapping();

    const todo = plan, totalUnits = todo.reduce((s, c) => s + c.e.header.frames + (el.minip.checked && c.e.header.frames > 1 ? 1 : 0), 0);
    let unitsSoFar = 0;
    for (let ci = 0; ci < todo.length; ci++) {
      if (cancelRequested) { stopped = true; break; }
      const c = todo[ci];
      const tc = performance.now();
      setCaseState(c, 'working', 'decoding…');
      const caseDir = await root.getDirectoryHandle(c.case, { create: true });
      let writes = Promise.resolve(), units = 0, count = 0, info = null, warnings = [];
      const note = JSON.stringify({ schema_version: 1, coord_order: 'xy', text: `${c.patient} | ${c.view} | ${c.dt} | ${c.runRank}/${c.nRuns}`, markers: [] }, null, 2);
      try {
        const file = await c.e.handle.getFile();
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
            units++;
            if (m.warning) warnings.push(`${m.name}: ${m.warning}`);
            writes = writes.then(async () => {
              const u = await caseDir.getDirectoryHandle(m.name, { create: true });
              await writeFile(u, 'frames.png', m.framesPng);
              await writeFile(u, 'label.npy', m.labelNpy);
              await writeFile(u, 'mask.npy', m.maskNpy);
              await writeFile(u, 'geometry.json', m.geometry);
              if (el.seedNotes.checked) await writeFile(u, 'note.json', note);
            });
            manifestRows.push({ case: c.case, unit: m.name, sid: c.sid, fid: m.name === 'minip' ? MINIP_FID : parseInt(m.name.slice(2), 10),
              height: m.h, width: m.w, segments: m.segments, vessel_px: m.vessel, seconds: m.seconds.toFixed(3),
              patient_id: c.patient, view: c.view, acq_datetime: c.dt, run_rank: c.runRank, n_runs_patient: c.nRuns, run_label: c.runLabel,
              source_path: c.e.path, pixel_spacing_mm: c.e.header.pixelSpacing });
            preview = { w: m.w, h: m.h, gray: m.gray, label: m.label };
            el.previewInfo.textContent = `${c.case}/${m.name} · ${m.w}×${m.h} · ${plural(m.segments, 'segment')} · vessel ${(100 * m.vessel / (m.w * m.h)).toFixed(1)} %`;
            draw();
          }
        });
        await writes;
        unitsSoFar += count;
        c.status = 'done'; c.units = units; c.seconds = ((performance.now() - tc) / 1000).toFixed(1);
        c.message = `${plural(units, 'unit')} · ${c.w}×${c.h}${info && (info.w !== info.srcW || info.h !== info.srcH) ? ` (cropped from ${info.srcW}×${info.srcH})` : ''}` +
          (info && info.framesDecoded < info.framesHeader ? ` · ${info.framesHeader - info.framesDecoded} unreadable frame(s) at the end skipped` : '') +
          (warnings.length ? ` · ${warnings.join('; ')}` : '');
        setCaseState(c, 'done', c.message);
        nDone++; nUnits += units;
      } catch (err) {
        await writes.catch(() => {});
        if (err.message === 'cancelled') {
          c.status = 'partial'; c.message = 'stopped (this case is incomplete)';
          setCaseState(c, 'failed', c.message); stopped = true;
        } else {
          c.status = 'failed'; c.message = err.message; setCaseState(c, 'failed', err.message); nFail++;
        }
      }
      await saveMapping();
      await saveManifest();
      if (stopped) break;
    }
    const per = unitTimes.length ? ` · ${fmtS(unitTimes.reduce((a, b) => a + b, 0) / unitTimes.length)} per unit` : '';
    setStatus(`${stopped ? 'Stopped' : 'Done'}: ${plural(nDone, 'case')}${nFail ? `, ${nFail} failed` : ''}, ${plural(nUnits, 'unit')} in ${fmtS(performance.now() - t0)}${per}. ` +
      `Dataset: “${root.name}” — open it in the annotator with “Open data folder”.`, nFail > 0);
    setProgress(null);
  } catch (e) {
    setStatus(e.message, true); setProgress(null);
  } finally {
    busy = false; el.cancel.hidden = true;
    refreshButtons(); refreshCacheInfo();
  }
}

function cancelRun() {
  if (!busy) return;
  cancelRequested = true; el.cancel.disabled = true;
  if (worker) worker.postMessage({ type: 'cancel' });
  setStatus('Stopping…');
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
