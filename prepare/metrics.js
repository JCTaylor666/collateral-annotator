// metrics.js — per-segment geometry (geometry.json), a port of prepare_dataset/metrics.py.
//
//   radius_px      median Euclidean distance transform over the segment's own skeleton pixels
//   length_px      sum of the centreline steps (1 or sqrt 2), summed in numpy's pairwise order
//   area_px        pixel count of the segment
//   mean_width_px  area / length
//   tortuosity     length / straight-line distance between the chain's two ends (omitted for closed rings)
// Values are rounded like Python's round(x, 4) (correct rounding, ties to even). Metrics that cannot be defined
// are omitted, never written as NaN. The exact distance transform comes from partition.js and is passed in
// (no import here, so the page's ?v= release tag covers every module it loads).

const SQRT2 = Math.SQRT2;

// numpy's pairwise_sum for float64 (numpy/_core/src/umath/loops_utils.h.src), so sums match bit for bit.
function pairwiseSum(a, start, n) {
  if (n < 8) {
    let res = 0;
    for (let i = 0; i < n; i++) res += a[start + i];
    return res;
  }
  if (n <= 128) {
    const r = new Float64Array(8);
    for (let j = 0; j < 8; j++) r[j] = a[start + j];
    let i;
    for (i = 8; i < n - (n % 8); i += 8) for (let j = 0; j < 8; j++) r[j] += a[start + i + j];
    let res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for (; i < n; i++) res += a[start + i];
    return res;
  }
  let n2 = Math.floor(n / 2);
  n2 -= n2 % 8;
  return pairwiseSum(a, start, n2) + pairwiseSum(a, start + n2, n - n2);
}

// Python's round(x, nd): the decimal nearest to the exact binary value, ties to even.
// Number.prototype.toFixed is exact too but sends ties up, so exact ties are detected and decided here.
const bitsView = new DataView(new ArrayBuffer(8));
export function pyRound(x, nd) {
  if (!Number.isFinite(x) || x === 0) return x;
  const fixed = x.toFixed(nd);
  bitsView.setFloat64(0, Math.abs(x));
  const hi = bitsView.getUint32(0), lo = bitsView.getUint32(4);
  const expBits = (hi >>> 20) & 0x7ff;
  let mant = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (expBits === 0) e = -1074; else { mant |= 1n << 52n; e = expBits - 1075; }
  if (e >= 0) return parseFloat(fixed);                       // an integer: nothing to round
  const den = 1n << BigInt(-e);                               // |x| = mant / den exactly
  const num = mant * 10n ** BigInt(nd);
  const rem = num % den;
  if (rem * 2n !== den) return parseFloat(fixed);             // not an exact tie: toFixed is right
  let q = num / den;                                          // exact tie: round half to even
  if (q % 2n === 1n) q += 1n;
  const s = q.toString().padStart(nd + 1, '0');
  const v = parseFloat(s.slice(0, s.length - nd) + '.' + s.slice(s.length - nd));
  return x < 0 ? -v : v;
}

// scipy.ndimage.distance_transform_edt(bw): distance of each foreground pixel to the nearest background pixel.
export function edt(bw, H, W, nearestSite) {
  const bg = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) bg[i] = bw[i] ? 0 : 1;
  const { d2 } = nearestSite(bg, H, W);
  const out = new Float64Array(H * W);
  for (let i = 0; i < H * W; i++) out[i] = Math.sqrt(d2[i]);
  return out;
}

function median(vals) {
  const a = Float64Array.from(vals).sort();
  const n = a.length, m = n >> 1;
  return n % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// Returns { "<id>": { radius_px, length_px, area_px, mean_width_px?, tortuosity? } } for every segment that
// owns at least one pixel, plus the list of warnings (empty unless a chain was discontinuous).
export function segmentMetrics(label, bw, skel, chains, H, W, { nearestSite, checkSteps = true }) {
  const out = {};
  if (!chains.length) return out;
  const dist = edt(bw, H, W, nearestSite);
  const counts = new Int32Array(chains.length + 1);
  const skelVals = Array.from({ length: chains.length + 1 }, () => []);
  for (let i = 0; i < H * W; i++) {
    const l = label[i];
    if (l <= chains.length) counts[l]++;
    if (skel[i] && l) skelVals[l].push(dist[i]);
  }
  for (let c = 1; c <= chains.length; c++) {
    const area = counts[c];
    if (area === 0) continue;                                 // centreline exists but owns no pixel
    const chain = chains[c - 1];
    const steps = new Float64Array(Math.max(0, chain.length - 1));
    let maxStep = 0;
    for (let k = 1; k < chain.length; k++) {
      const y0 = (chain[k - 1] / W) | 0, x0 = chain[k - 1] - y0 * W, y1 = (chain[k] / W) | 0, x1 = chain[k] - y1 * W;
      const dy = y1 - y0, dx = x1 - x0;
      const st = Math.sqrt(dy * dy + dx * dx);                // np.hypot of small integers
      steps[k - 1] = st;
      if (st > maxStep) maxStep = st;
    }
    if (checkSteps && steps.length && maxStep > SQRT2 + 1e-9)
      throw new Error(`segment ${c}: centreline step ${maxStep.toFixed(3)} exceeds sqrt(2) -- the chain is discontinuous`);
    const length = pairwiseSum(steps, 0, steps.length);
    let vals = skelVals[c];
    if (!vals.length) vals = Array.from(chain, (p) => dist[p]);
    const radius = vals.length ? median(vals) : 0;
    const entry = { radius_px: pyRound(radius, 4), length_px: pyRound(length, 4), area_px: area };
    if (length > 0) {
      entry.mean_width_px = pyRound(area / length, 4);
      const ya = (chain[0] / W) | 0, xa = chain[0] - ya * W;
      const yb = (chain[chain.length - 1] / W) | 0, xb = chain[chain.length - 1] - yb * W;
      const chord = Math.sqrt((yb - ya) * (yb - ya) + (xb - xa) * (xb - xa));
      if (chord > 0) entry.tortuosity = pyRound(length / chord, 4);   // a closed ring has none
    }
    for (const k of Object.keys(entry)) if (!Number.isFinite(entry[k])) delete entry[k];
    out[String(c)] = entry;
  }
  return out;
}

// metrics.default_filter: a full-range window over radius, so the filter starts by hiding nothing.
export function defaultFilter(seg, metric = 'radius_px') {
  const vals = Object.values(seg).filter((m) => metric in m).map((m) => m[metric]);
  if (!vals.length) return null;
  return { metric, min: pyRound(Math.min(...vals), 4), max: pyRound(Math.max(...vals), 4) };
}

// json.dumps(doc, indent=2) as Python writes it: floats keep their ".0", so the file matches the pipeline's
// byte for byte when the values match.
const FLOAT_KEYS = new Set(['radius_px', 'length_px', 'mean_width_px', 'tortuosity', 'min', 'max']);
export function geometryJson(seg, filter) {
  const num = (k, v) => (FLOAT_KEYS.has(k) && Number.isInteger(v) ? v.toFixed(1) : String(v));
  const ids = Object.keys(seg);
  const lines = ['{', '  "segments": ' + (ids.length ? '{' : '{}')];
  ids.forEach((id, i) => {
    const e = seg[id], keys = Object.keys(e);
    lines.push(`    "${id}": {`);
    keys.forEach((k, j) => lines.push(`      "${k}": ${num(k, e[k])}${j < keys.length - 1 ? ',' : ''}`));
    lines.push(`    }${i < ids.length - 1 ? ',' : ''}`);
  });
  if (ids.length) lines.push('  }' + (filter ? ',' : ''));
  else if (filter) lines[1] += ',';
  if (filter) {
    lines.push('  "filter": {');
    lines.push(`    "metric": "${filter.metric}",`);
    lines.push(`    "min": ${num('min', filter.min)},`);
    lines.push(`    "max": ${num('max', filter.max)}`);
    lines.push('  }');
  }
  lines.push('}');
  return lines.join('\n');
}
