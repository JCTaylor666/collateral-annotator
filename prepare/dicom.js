// dicom.js — DICOM decoding and the 8-bit conversion / black-border crop of the Zurich DSA pipeline.
//
// Matches prepare_dataset/preprocess/preprocess_zurich_dsa_selected.py and crop_black_border.py:
//   * pixels are the raw stored values (no rescale), as pydicom's pixel_array returns them;
//   * window = first WindowCenter / WindowWidth value:
//       v = clip((x - (c - 0.5)) / (w - 1) + 0.5, 0, 1);  out = uint8(v * 255)   (truncation)
//     done in float32 like numpy (Math.fround after every step), min-max when the window is missing;
//   * MinIP = per-pixel minimum over the raw frames, then windowed;
//   * black border = everything outside the bounding box of pixels > 0.
// Works in a browser worker and in Node (no DOM use here).
import dicomParser from './vendor/dicom-parser-1.8.21.esm.js';
import { Decoder as JpegLosslessDecoder } from './vendor/jpeg-lossless-decoder-2.1.2.js';

const TS = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.4.57': 'JPEG Lossless (Process 14)',
  '1.2.840.10008.1.2.4.70': 'JPEG Lossless (Process 14, SV1)',
  '1.2.840.10008.1.2.4.50': 'JPEG Baseline (8-bit)',
};
const UNCOMPRESSED = new Set(['1.2.840.10008.1.2', '1.2.840.10008.1.2.1']);
const JPEG_LOSSLESS = new Set(['1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70']);
const JPEG_BASELINE = '1.2.840.10008.1.2.4.50';

export function isDicomBytes(head) {      // head: Uint8Array of at least 132 bytes
  return head.length >= 132 && head[128] === 0x44 && head[129] === 0x49 && head[130] === 0x43 && head[131] === 0x4d;
}

const firstNumber = (ds, tag) => {
  const s = ds.string(tag);
  if (s == null || s === '') return null;
  const v = parseFloat(String(s).split('\\')[0]);
  return Number.isFinite(v) ? v : null;
};

// Returns { rows, cols, frames: [TypedArray rows*cols], wc, ww, transferSyntax, tsName, info }
// jpegBaselineDecode(bytes) -> Promise<Uint8Array> is only needed for JPEG Baseline files (browser-only).
export async function decodeDicom(arrayBuffer, { jpegBaselineDecode } = {}) {
  const bytes = new Uint8Array(arrayBuffer);
  let ds;
  try { ds = dicomParser.parseDicom(bytes); }
  catch (e) { throw new Error('Not a readable DICOM file (' + ((e && e.exception) || e.message || e) + ')'); }
  const ts = (ds.string('x00020010') || '1.2.840.10008.1.2').replace(/\0/g, '').trim();
  const rows = ds.uint16('x00280010'), cols = ds.uint16('x00280011');
  const nFrames = Math.max(1, parseInt(ds.string('x00280008') || '1', 10) || 1);
  const bitsAllocated = ds.uint16('x00280100') || 16;
  const pixelRep = ds.uint16('x00280103') || 0;
  const spp = ds.uint16('x00280002') || 1;
  const photometric = (ds.string('x00280004') || '').trim();
  const px = ds.elements.x7fe00010;
  if (!rows || !cols) throw new Error('DICOM has no image size (Rows/Columns)');
  if (!px) throw new Error('DICOM has no pixel data');
  if (spp !== 1) throw new Error(`Colour DICOM (${spp} samples per pixel) is not supported`);
  const wc = firstNumber(ds, 'x00281050'), ww = firstNumber(ds, 'x00281051');
  const N = rows * cols, frames = [];

  if (UNCOMPRESSED.has(ts)) {
    const bpp = bitsAllocated / 8, frameBytes = N * bpp;
    if (bitsAllocated !== 8 && bitsAllocated !== 16) throw new Error(`BitsAllocated ${bitsAllocated} is not supported`);
    const available = Math.floor(Math.min(px.length, bytes.length - px.dataOffset) / frameBytes);
    for (let f = 0; f < Math.min(nFrames, available); f++) {
      const start = px.dataOffset + f * frameBytes;
      const slice = arrayBuffer.slice(start, start + frameBytes);         // copy: keeps 16-bit views aligned
      frames.push(bitsAllocated === 8 ? new Uint8Array(slice) : pixelRep ? new Int16Array(slice) : new Uint16Array(slice));
    }
  } else if (JPEG_LOSSLESS.has(ts) || ts === JPEG_BASELINE) {
    if (!px.encapsulatedPixelData) throw new Error('Compressed DICOM without encapsulated pixel data');
    let bot = px.basicOffsetTable;
    if (nFrames > 1 && (!bot || bot.length === 0)) bot = dicomParser.createJPEGBasicOffsetTable(ds, px);
    for (let f = 0; f < nFrames; f++) {
      let enc;
      try {
        enc = nFrames === 1 && (!bot || bot.length === 0)
          ? dicomParser.readEncapsulatedPixelDataFromFragments(ds, px, 0, px.fragments.length)
          : dicomParser.readEncapsulatedImageFrame(ds, px, f, bot);
      } catch (e) { break; }                                              // truncated file: keep the frames before the cut
      let out;
      try {
        if (ts === JPEG_BASELINE) {
          if (!jpegBaselineDecode) throw new Error('JPEG Baseline decoding is only available in the browser');
          out = await jpegBaselineDecode(enc);
        } else {
          const dec = new JpegLosslessDecoder();
          const raw = dec.decompress(enc.buffer, enc.byteOffset, enc.length);
          const per = raw.byteLength / N;
          out = per === 1 ? new Uint8Array(raw) : pixelRep ? new Int16Array(raw) : new Uint16Array(raw);
          // The decoder reads the point transform (Pt, "al") but never applies it. Some Siemens frames (blank
          // subtraction-reference frames) use Pt = 1. Shift back by Pt in a 32-bit array so values above the
          // nominal bit depth saturate in the window instead of wrapping; this reproduces pydicom bit for bit.
          const pt = (dec.scan && dec.scan.al) || 0;
          if (pt) { const wide = new Int32Array(out.length); for (let i = 0; i < out.length; i++) wide[i] = out[i] << pt; out = wide; }
        }
      } catch (e) {
        if (frames.length) break;                                         // a damaged last frame: keep the rest
        throw new Error('Could not decode the first frame: ' + (e.message || e));
      }
      if (out.length !== N) { if (frames.length) break; throw new Error(`Decoded frame has ${out.length} pixels, expected ${N}`); }
      frames.push(out);
    }
  } else {
    throw new Error(`Unsupported DICOM compression: ${TS[ts] || ts}`);
  }
  if (!frames.length) throw new Error('No decodable frames in this DICOM');
  return {
    rows, cols, frames, wc, ww, transferSyntax: ts, tsName: TS[ts] || ts,
    info: { nFramesHeader: nFrames, bitsAllocated, pixelRep, photometric },
  };
}

// Header only (no pixel decoding), for planning a dataset: reads the first part of the file and widens the
// read if the header does not fit. `file` is a File/Blob.
export async function readDicomHeader(file) {
  let ds = null, lastErr = null;
  for (const n of [262144, 4194304, Infinity]) {
    const bytes = new Uint8Array(await file.slice(0, Math.min(n, file.size)).arrayBuffer());
    try { ds = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' }); break; }
    catch (e) { lastErr = e; if (n >= file.size) break; }
  }
  if (!ds) throw new Error('Not a readable DICOM header (' + ((lastErr && (lastErr.exception || lastErr.message)) || lastErr) + ')');
  const str = (t) => { const s = ds.string(t); return s == null ? '' : String(s).replace(/\0/g, '').trim(); };
  const ts = str('x00020010') || '1.2.840.10008.1.2';
  const spacing = str('x00181164') || str('x00280030');
  return {
    patientId: str('x00100020'),
    studyUid: str('x0020000d'),
    seriesNumber: str('x00200011'),
    acqDate: str('x00080022'), acqTime: str('x00080032'),
    contentDate: str('x00080023'), contentTime: str('x00080033'),
    seriesDate: str('x00080021'), seriesTime: str('x00080031'),
    studyDate: str('x00080020'), studyTime: str('x00080030'),
    primaryAngle: firstNumber(ds, 'x00181510'),
    pixelSpacing: spacing ? spacing.split('\\').map((v) => parseFloat(v)).filter(Number.isFinite).join(', ') : '',
    frames: Math.max(1, parseInt(str('x00280008') || '1', 10) || 1),
    rows: ds.uint16('x00280010') || 0, cols: ds.uint16('x00280011') || 0,
    transferSyntax: ts, tsName: TS[ts] || ts,
    supported: UNCOMPRESSED.has(ts) || JPEG_LOSSLESS.has(ts) || ts === JPEG_BASELINE,
    manufacturer: str('x00080070'),
  };
}

// numpy float32 windowing, bit-for-bit (see header). Returns Uint8Array.
export function windowTo8bit(raw, wc, ww) {
  const n = raw.length, out = new Uint8Array(n), f = Math.fround;
  if (wc == null || ww == null) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < n; i++) { const v = raw[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (!(mx > mn)) return out;                       // constant image -> all 0, like img * 0
    const fmn = f(mn), d = f(f(mx) - fmn);
    for (let i = 0; i < n; i++) {
      const v = f(f(f(raw[i]) - fmn) / d);
      const s = f(v * 255);
      out[i] = s <= 0 ? 0 : s >= 255 ? 255 : Math.floor(s);
    }
    return out;
  }
  const lo = f(wc - 0.5), den = f(ww - 1.0);
  for (let i = 0; i < n; i++) {
    let v = f(f(f(raw[i]) - lo) / den);
    v = f(v + 0.5);
    v = v < 0 ? 0 : v > 1 ? 1 : v;
    const s = f(v * 255);
    out[i] = s <= 0 ? 0 : s >= 255 ? 255 : Math.floor(s);
  }
  return out;
}

export function minOverFrames(frames) {
  const out = frames[0].slice();
  for (let k = 1; k < frames.length; k++) {
    const fr = frames[k];
    for (let i = 0; i < out.length; i++) if (fr[i] < out[i]) out[i] = fr[i];
  }
  return out;
}

// Bounding box [y0, y1, x0, x1) of pixels > 0, or null when everything is 0 (the image is then kept as is).
export function positiveBox(gray, w, h) {
  let y0 = h, y1 = -1, x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) if (gray[row + x] > 0) {
      if (y < y0) y0 = y; if (y > y1) y1 = y; if (x < x0) x0 = x; if (x > x1) x1 = x;
    }
  }
  return y1 < 0 ? null : [y0, y1 + 1, x0, x1 + 1];
}

export function cropGray(gray, w, box) {
  const [y0, y1, x0, x1] = box, cw = x1 - x0, out = new Uint8Array((y1 - y0) * cw);
  for (let y = y0; y < y1; y++) out.set(gray.subarray(y * w + x0, y * w + x1), (y - y0) * cw);
  return out;
}
