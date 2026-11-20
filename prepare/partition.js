// partition.js — binary vessel mask -> per-segment partition (the contents of label.npy).
//
// A step-by-step port of prepare_dataset/partition.py (and of scikit-image 0.25.2's 2-D Zhang skeletonize):
//   (1) skeleton          Zhang-Suen thinning with skimage's 256-entry lookup table
//   (2) degree map        number of 8-neighbours on the skeleton
//   (3) nodes             skeleton pixels with degree != 2
//   (4) chains            every degree-2 run between two nodes, traced in the same row-major order and
//                         neighbour order as the Python, so chains -- and therefore segment ids -- are identical
//   (5) rings             skeleton components without a node become one chain each
//   (6) assignment        every foreground pixel takes the id of the nearest centreline point
//   (7) fill              majority vote for anything left over (degenerate masks only)
//
// The one intended difference is step (6) when a pixel is exactly as far from two chains: scipy's KD-tree
// keeps whichever point its search reaches first (an implementation detail of how the tree was built); here
// a centreline pixel shared by several chains (a node) belongs to the earliest chain, and between equally
// distant different points the exact distance transform below prefers the upper / left one.
// Pixels are row-major flat indices: i = y * W + x.

const OFFS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

// skimage/morphology/_skeletonize_various_cy.pyx (v0.25.2), _fast_skeletonize: 1 = remove in the first
// sub-pass, 2 = remove in the second, 3 = remove in either.
const LUT = new Uint8Array([
  0, 0, 0, 1, 0, 0, 1, 3, 0, 0, 3, 1, 1, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 2, 0,
  3, 0, 3, 3, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 0, 0, 0, 3, 0, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0,
  3, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0, 0, 3, 0, 2, 0, 0, 0, 3, 1, 0, 0, 1, 3, 0, 0, 0, 0,
  0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 3, 1, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 3, 1, 3,
  0, 0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  2, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 0, 1, 0, 0, 0, 0, 2, 2, 0, 0,
  2, 0, 0, 0,
]);
if (LUT.length !== 256) throw new Error('skeletonize lookup table must have 256 entries');

// (1) skimage.morphology.skeletonize for 2-D boolean input (method 'zhang').
export function skeletonize(bw, H, W) {
  const H2 = H + 2, W2 = W + 2;
  const sk = new Uint8Array(H2 * W2);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (bw[y * W + x]) sk[(y + 1) * W2 + x + 1] = 1;
  // only ever-foreground pixels can change: iterate over that list instead of the whole image
  let idx = [];
  for (let i = 0; i < sk.length; i++) if (sk[i]) idx.push(i);
  const clean = sk.slice();
  let removed = true;
  while (removed) {
    removed = false;
    for (let pass = 0; pass < 2; pass++) {
      const first = pass === 0;
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k];
        if (!sk[i]) continue;
        const n = LUT[sk[i - W2 - 1] + 2 * sk[i - W2] + 4 * sk[i - W2 + 1] + 8 * sk[i + 1] +
          16 * sk[i + W2 + 1] + 32 * sk[i + W2] + 64 * sk[i + W2 - 1] + 128 * sk[i - 1]];
        if (n === 0) continue;
        if (n === 3 || (n === 1 && first) || (n === 2 && !first)) { clean[i] = 0; removed = true; }
      }
      // the whole sub-pass read the old state; now commit it (only listed pixels can have changed)
      for (let k = 0; k < idx.length; k++) sk[idx[k]] = clean[idx[k]];
    }
    if (removed) idx = idx.filter((i) => sk[i]);
  }
  const out = new Uint8Array(H * W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = sk[(y + 1) * W2 + x + 1];
  return out;
}

// (2)
export function degreeMap(skel, H, W) {
  const deg = new Uint8Array(H * W);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (!skel[i]) continue;
    let d = 0;
    for (const [dy, dx] of OFFS) {
      const ny = y + dy, nx = x + dx;
      if (ny >= 0 && ny < H && nx >= 0 && nx < W && skel[ny * W + nx]) d++;
    }
    deg[i] = d;
  }
  return deg;
}

// (4) port of _trace_chains
function traceChains(skel, node, H, W) {
  const consumed = new Uint8Array(H * W);
  const chains = [];
  for (let s = 0; s < H * W; s++) {
    if (!node[s]) continue;
    const y = (s / W) | 0, x = s - y * W;
    for (const [dy, dx] of OFFS) {
      const ny = y + dy, nx = x + dx;
      if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
      const n = ny * W + nx;
      if (!skel[n] || node[n] || consumed[n]) continue;
      const chain = [s, n];
      consumed[n] = 1;
      let prev = s, cur = n;
      for (;;) {
        let stepNode = -1, stepFree = -1;
        const cy = (cur / W) | 0, cx = cur - cy * W;
        for (const [ey, ex] of OFFS) {
          const qy = cy + ey, qx = cx + ex;
          if (qy < 0 || qy >= H || qx < 0 || qx >= W) continue;
          const q = qy * W + qx;
          if (q === prev || !skel[q]) continue;
          if (node[q]) { if (stepNode < 0) stepNode = q; }
          else if (!consumed[q] && stepFree < 0) stepFree = q;
        }
        // prefer continuing along the vessel; only close on a node when the chain has run out of degree-2 pixels
        if (stepFree >= 0) { consumed[stepFree] = 1; chain.push(stepFree); prev = cur; cur = stepFree; continue; }
        if (stepNode >= 0) chain.push(stepNode);
        break;
      }
      chains.push(Int32Array.from(chain));
    }
  }
  return chains;
}

// 8-connected components numbered in raster order of their first pixel (skimage.measure.label order).
// Returns { lab: Int32Array (0 = not in mask), count, members: Array<Int32Array of pixels in raster order> }
function components8(mask, H, W) {
  const lab = new Int32Array(H * W);
  const members = [];
  const stack = [];
  let count = 0;
  for (let s = 0; s < H * W; s++) {
    if (!mask[s] || lab[s]) continue;
    count++;
    lab[s] = count;
    const px = [s];
    stack.push(s);
    while (stack.length) {
      const p = stack.pop(), y = (p / W) | 0, x = p - y * W;
      for (const [dy, dx] of OFFS) {
        const ny = y + dy, nx = x + dx;
        if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
        const q = ny * W + nx;
        if (mask[q] && !lab[q]) { lab[q] = count; px.push(q); stack.push(q); }
      }
    }
    members.push(Int32Array.from(px).sort());
  }
  return { lab, count, members };
}

// (5) port of _trace_loops: components of the skeleton that no chain covers and that hold no node
function traceLoops(skel, node, chains, H, W) {
  const covered = new Uint8Array(H * W);
  for (const c of chains) for (const p of c) covered[p] = 1;
  const leftover = new Uint8Array(H * W);
  let any = false;
  for (let i = 0; i < H * W; i++) if (skel[i] && !covered[i] && !node[i]) { leftover[i] = 1; any = true; }
  if (!any) return [];
  const { lab, members } = components8(leftover, H, W);
  const out = [];
  for (let k = 0; k < members.length; k++) {
    const id = k + 1, start = members[k][0];             // min (y, x) = first pixel in raster order
    const seen = new Set([start]);
    const walk = [start];
    let cur = start;
    for (;;) {
      let nxt = -1;
      const cy = (cur / W) | 0, cx = cur - cy * W;
      for (const [dy, dx] of OFFS) {
        const ny = cy + dy, nx = cx + dx;
        if (ny < 0 || ny >= H || nx < 0 || nx >= W) continue;
        const q = ny * W + nx;
        if (lab[q] === id && !seen.has(q)) { nxt = q; break; }
      }
      if (nxt < 0) break;
      seen.add(nxt); walk.push(nxt); cur = nxt;
    }
    out.push(Int32Array.from(walk));
  }
  return out;
}

// port of _fallback_chains: one "chain" per skeleton component (pixels in raster order)
function fallbackChains(skel, H, W) {
  return components8(skel, H, W).members;
}

// 1-D squared distance transform (Felzenszwalb & Huttenlocher) with the index of the nearest site.
// f[q] = cost at q (Infinity = no site). Writes d[q] = min_p (q - p)^2 + f[p] and arg[q] = that p.
// Deterministic: a query exactly on the boundary between two parabolas keeps the earlier (smaller p) one.
function dt1d(f, n, d, arg, v, z) {
  let k = -1;
  for (let q = 0; q < n; q++) {
    if (f[q] === Infinity) continue;
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    let s;
    for (;;) {
      const p = v[k];
      s = ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
      if (s <= z[k]) { k--; if (k < 0) break; } else break;
    }
    if (k < 0) { k = 0; v[0] = q; z[0] = -Infinity; z[1] = Infinity; continue; }
    k++; v[k] = q; z[k] = s; z[k + 1] = Infinity;
  }
  if (k < 0) { for (let q = 0; q < n; q++) { d[q] = Infinity; arg[q] = -1; } return; }
  let j = 0;
  for (let q = 0; q < n; q++) {
    while (z[j + 1] < q) j++;
    const p = v[j];
    d[q] = (q - p) * (q - p) + f[p];
    arg[q] = p;
  }
}

// Exact Euclidean nearest-site transform. site: Uint8Array (1 = site). Returns { d2: Float64Array squared
// distance, near: Int32Array flat index of the nearest site (-1 if there is none) }.
export function nearestSite(site, H, W) {
  const n = Math.max(H, W);
  const f = new Float64Array(n), d = new Float64Array(n), arg = new Int32Array(n), v = new Int32Array(n), z = new Float64Array(n + 1);
  // pass 1: down every column -> squared vertical distance to the nearest site in that column, and its row
  const g = new Float64Array(H * W), gRow = new Int32Array(H * W);
  for (let x = 0; x < W; x++) {
    for (let y = 0; y < H; y++) f[y] = site[y * W + x] ? 0 : Infinity;
    dt1d(f, H, d, arg, v, z);
    for (let y = 0; y < H; y++) { g[y * W + x] = d[y]; gRow[y * W + x] = arg[y]; }
  }
  // pass 2: along every row over those column results
  const d2 = new Float64Array(H * W), near = new Int32Array(H * W);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) f[x] = g[y * W + x];
    dt1d(f, W, d, arg, v, z);
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      d2[i] = d[x];
      const sx = arg[x];
      near[i] = sx < 0 ? -1 : gRow[y * W + sx] * W + sx;
    }
  }
  return { d2, near };
}

// (6) every foreground pixel inherits the id of the nearest centreline point (see the header for ties)
function assign(bw, chains, H, W) {
  const label = new Uint16Array(H * W);
  if (!chains.length) return label;
  const owner = new Int32Array(H * W);           // chain id stored at each centreline position (0 = none)
  const site = new Uint8Array(H * W);
  for (let c = 0; c < chains.length; c++) for (const p of chains[c]) if (!owner[p]) { owner[p] = c + 1; site[p] = 1; }
  const { near } = nearestSite(site, H, W);
  for (let i = 0; i < H * W; i++) if (bw[i] && near[i] >= 0) label[i] = owner[near[i]];
  return label;
}

// (7) port of _fill: majority-vote 3x3, in place, raster order, smallest id wins a tie (np.bincount.argmax)
function fill(label, bw, H, W, maxIters) {
  for (let it = 0; it < maxIters; it++) {
    const todo = [];
    for (let i = 0; i < H * W; i++) if (bw[i] && !label[i]) todo.push(i);
    if (!todo.length) break;
    let changed = false;
    for (const i of todo) {
      const y = (i / W) | 0, x = i - y * W;
      const counts = new Map();
      for (let yy = Math.max(0, y - 1); yy < Math.min(H, y + 2); yy++)
        for (let xx = Math.max(0, x - 1); xx < Math.min(W, x + 2); xx++) {
          const v = label[yy * W + xx];
          if (v > 0) counts.set(v, (counts.get(v) || 0) + 1);
        }
      if (!counts.size) continue;
      let best = 0, bestN = -1;
      for (const [v, c] of counts) if (c > bestN || (c === bestN && v < best)) { best = v; bestN = c; }
      label[i] = best;
      changed = true;
    }
    if (!changed) break;
  }
  return label;
}

// Public entry point, same contract as partition.partition():
//   label  Uint16Array H*W, 0 = background, 1..N = segment id; label > 0 equals bw
//   skel   Uint8Array  H*W skeleton (reused by metrics)
//   chains Array<Int32Array> ordered centreline pixels of segment i at index i-1
export function partition(bw, H, W, { fillMaxIters = 100 } = {}) {
  let anyFg = false;
  for (let i = 0; i < H * W; i++) if (bw[i]) { anyFg = true; break; }
  if (!anyFg) return { label: new Uint16Array(H * W), skel: new Uint8Array(H * W), chains: [] };
  const skel = skeletonize(bw, H, W);
  const deg = degreeMap(skel, H, W);
  const node = new Uint8Array(H * W);
  for (let i = 0; i < H * W; i++) node[i] = skel[i] && deg[i] !== 2 ? 1 : 0;
  let chains = traceChains(skel, node, H, W);
  chains = chains.concat(traceLoops(skel, node, chains, H, W));
  if (!chains.length) chains = fallbackChains(skel, H, W);
  if (chains.length > 65535) throw new Error(`${chains.length} segments do not fit in uint16`);
  const label = assign(bw, chains, H, W);
  let left = false;
  for (let i = 0; i < H * W; i++) if (bw[i] && !label[i]) { left = true; break; }
  if (left) fill(label, bw, H, W, fillMaxIters);
  return { label, skel, chains };
}
