// dicom.js — DICOM decoding and the 8-bit conversion / black-border crop of the Zurich DSA pipeline.
//
// Matches prepare_dataset/preprocess/preprocess_zurich_dsa_selected.py and crop_black_border.py:
//   * pixels are the stored sample values (no rescale), as pydicom's pixel_array returns them: only the
//     Bits Stored bits count, and signed samples are two's complement in those bits;
//   * window = first WindowCenter / WindowWidth value:
//       v = clip((x - (c - 0.5)) / (w - 1) + 0.5, 0, 1);  out = uint8(v * 255)   (truncation)
//     done in float32 like numpy (Math.fround after every step), min-max when the window is missing;
//   * MinIP = per-pixel minimum over the raw frames, then windowed;
//   * black border = everything outside the bounding box of pixels > 0.
// Works in a browser worker and in Node (no DOM use here).
import dicomParser from './vendor/dicom-parser-1.8.21.esm.js';
// "?p=1": this copy of the decoder carries corrections (see the top of the file). The tag gives the corrected
// file an address of its own, so a browser cannot pair this module with a cached copy of the uncorrected one.
import { Decoder as JpegLosslessDecoder } from './vendor/jpeg-lossless-decoder-2.1.2.js?p=2';

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

// A stored sample -> its value (DICOM PS3.5 §8.1.1). The sample occupies `stored` bits of its container, ending
// at High Bit. The other bits are not part of the pixel and may hold anything (old files kept overlays there,
// some writers leave junk), and a signed sample (Pixel Representation 1) is two's complement IN those `stored`
// bits — so 0x0FFF is -1 for 12 stored bits, whatever the 4 bits above it say.
// `u`: the raw containers (Uint8Array / Uint16Array, offset 0). `mask` = false leaves unsigned samples as they
// are (JPEG output is already right-aligned). Returns the values; `u` itself when nothing has to change.
function samplesToValues(u, containerBits, stored, highBit, signed, mask) {
  const shift = highBit - (stored - 1), full = stored === containerBits && shift === 0;
  if (!signed) {
    if (full || !mask) return u;
    const m = (1 << stored) - 1;
    for (let i = 0; i < u.length; i++) u[i] = (u[i] >> shift) & m;      // in place: an unsigned value fits its container
    return u;
  }
  if (full) return containerBits === 8 ? new Int8Array(u.buffer, u.byteOffset, u.length) : new Int16Array(u.buffer, u.byteOffset, u.length);
  const out = containerBits === 8 ? new Int8Array(u.length) : new Int16Array(u.length);
  const m = (1 << stored) - 1, sign = 1 << (stored - 1), span = 1 << stored;
  for (let i = 0; i < u.length; i++) { const v = (u[i] >> shift) & m; out[i] = (v & sign) ? v - span : v; }
  return out;
}

// What one JPEG Lossless frame says about itself (ITU-T T.81 Annex B), read before it is decoded. A stream the
// decoder cannot decode exactly is REFUSED here, with the reason: a file is read correctly or not at all, never
// as pixels that look plausible and are wrong. (A header that is cut off or not JPEG at all is damage, not a
// refusal: an ordinary error, which the caller treats like any other unreadable frame.)
// Returns what the frame says about itself: its precision P, rows, columns and point transform pt ("Al" in the
// scan header).
const refuse = (why) => Object.assign(new Error(why), { refused: true });
function checkLosslessFrame(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new Error('the frame is not a JPEG stream');
  let P = 0, cols = 0, rows = 0, ri = 0;
  for (let i = 2; i + 4 <= b.length;) {
    const m = b[i + 1], end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);          // every marker before the scan has a length
    if (b[i] === 0xff && m === 0xff) { i++; continue; }                      // a fill byte in front of a marker
    if (b[i] !== 0xff || end > b.length) break;                              // damaged or cut off
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {   // a frame header (SOF)
      if (m !== 0xc3) throw refuse(`the JPEG frame is not lossless Huffman-coded (SOF marker 0x${m.toString(16)})`);
      P = b[i + 4]; rows = (b[i + 5] << 8) | b[i + 6]; cols = (b[i + 7] << 8) | b[i + 8];
      if (b[i + 9] !== 1) throw refuse(`a lossless JPEG frame with ${b[i + 9]} components is not supported`);
      if (!(P >= 2 && P <= 16) || !cols) throw refuse(`a lossless JPEG frame of ${P}-bit samples and ${cols} columns is not valid`);
      // Zero lines in the frame header means "the number of lines follows the first scan" (a DNL marker, T.81
      // B.2.5). The decoder sizes its output from the header and would return nothing at all.
      if (!rows) throw refuse('the JPEG frame gives its number of lines in a DNL marker after the scan, which is not supported');
    } else if (m === 0xde) throw refuse('hierarchical JPEG is not supported');
    else if (m === 0xdd) ri = (b[i + 4] << 8) | b[i + 5];
    else if (m === 0xda) {                                                  // the scan header: the pixels follow
      const ns = b[i + 4], sel = b[i + 5 + 2 * ns], pt = b[i + 7 + 2 * ns] & 15;
      if (!P || end !== i + 8 + 2 * ns) break;                              // no frame header before it, or not a scan header
      if (!(sel >= 1 && sel <= 7)) throw refuse(`lossless JPEG predictor ${sel} is not valid`);
      if (!(pt < P)) throw refuse(`JPEG point transform ${pt} is not valid for ${P}-bit samples`);
      // T.81 Table B.7: in lossless mode a restart interval is a whole number of lines. GDCM refuses other
      // streams too, and the decoder's handling of an interval's first line relies on it.
      if (ri % cols) throw refuse(`a JPEG restart interval of ${ri} samples is not a whole number of rows (${cols} samples each)`);
      return { pt, P, rows, cols };
    }
    i = end;
  }
  throw new Error('the JPEG header is damaged or incomplete');
}

// Any marker may be preceded by any number of fill bytes X'FF' (ITU-T T.81 B.1.1.2). The decoder in ./vendor
// takes a fill byte for half of a marker: in front of SOF, DHT or SOS it gives up, and in front of a restart
// marker it goes on with the wrong bits — pixels that look plausible and are wrong. The frame is therefore handed
// to it without its fill bytes. Inside the header a fill byte can only stand where a marker is due; inside the
// scan X'FF' is followed by X'00' (a data byte FF), by a marker code, or by another X'FF' — and only then is it
// a fill byte. Returns `b` itself when there is nothing to drop, or when the stream is not laid out like a JPEG
// stream at all (the header check then says what is wrong with it).
function withoutFillBytes(b) {
  const n = b.length;
  let lead = 0; while (lead + 2 < n && b[lead] === 0xff && b[lead + 1] === 0xff) lead++;   // fill bytes in front of the first marker, too
  if (n - lead < 4 || b[lead] !== 0xff || b[lead + 1] !== 0xd8) return b;
  const out = new Uint8Array(n);
  let o = 2, i = lead + 2, dropped = lead;
  out[0] = 0xff; out[1] = 0xd8;
  const copy = (from, to) => { out.set(b.subarray(from, to), o); o += to - from; };
  while (i < n) {
    if (b[i] !== 0xff) return b;                                            // no marker where one is due
    let j = i; while (j + 1 < n && b[j + 1] === 0xff) j++;                  // b[j]: the last FF in front of the marker code
    if (j + 1 >= n) return b;
    dropped += j - i; i = j;
    const m = b[i + 1];
    if (m === 0xd9) { copy(i, n); break; }                                  // EOI: whatever follows it stays as it is
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) { copy(i, i + 2); i += 2; continue; }   // markers without a length
    if (i + 4 > n) return b;
    const end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    if (end > n) return b;
    copy(i, end); i = end;
    if (m !== 0xda) continue;
    for (;;) {                                                              // the scan, up to the marker that ends it
      let k = i; while (k < n && b[k] !== 0xff) k++;
      copy(i, k); i = k;
      if (i + 1 >= n) { copy(i, n); i = n; break; }
      const c = b[i + 1];
      if (c === 0x00 || (c >= 0xd0 && c <= 0xd7)) { copy(i, i + 2); i += 2; }   // a data byte FF, or a restart marker
      else if (c === 0xff) { i++; dropped++; }                                   // a fill byte
      else break;                                                                // another marker: back to the outer loop
    }
  }
  return dropped ? out.subarray(0, o) : b;
}

// Is the scan followed by a marker (normally the end-of-image marker)? `b` is a frame without fill bytes.
function scanIsClosed(b) {
  let i = 2;
  while (i + 4 <= b.length && b[i] === 0xff) {                              // the segments in front of the scan
    const m = b[i + 1], end = i + 2 + ((b[i + 2] << 8) | b[i + 3]);
    i = end;
    if (m === 0xda) break;
  }
  for (; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const c = b[i + 1];
    if (c === 0x00 || (c >= 0xd0 && c <= 0xd7)) { i++; continue; }          // a data byte FF, a restart marker
    return true;
  }
  return false;
}

// The lossless decoder in ./vendor is the published one plus five corrections (see the top of that file). Each of
// them changes pixels only in streams the published decoder gets wrong, so a copy without them would pass every
// ordinary test and still mis-read some files. Before the first frame is decoded, two small streams that need
// them are decoded and every sample compared; each correction, taken out alone, fails one of the two:
//   * 12-bit, 4 x 3, predictor 7, point transform 1, a restart interval of two lines, no padding bit before the
//     restart marker                                                                        (PATCH 1, 2 and 3)
//   * 16-bit, 2 x 3, predictor 7, samples at both ends of the range                                    (PATCH 4)
// …and the second stream without its last byte of pixel data, with and without the end marker after it, has to
// come back INCOMPLETE (PATCH 5): the published decoder returns all six samples, the last one made up.
// `values` is what the decoder itself has to return (before the point transform is undone).
const SELF_TEST = [
  { jpeg: 'ffd8ffc3000b0c0004000301011100ffc4001900000203010000000000000000000000000a0b02070809ffdd00040006ffda0008010100070001198a29d53c84db13ffd03a8535e8b58cb5d013bfffd9',
    values: [409, 292, 1997, 30, 377, 1190, 1960, 532, 671, 706, 2015, 398] },
  { jpeg: 'ffd8ffc3000b100002000301011100ffc400160001010100000000000000000000000000020110ffda0008010100070000cc2a3fffd9',
    values: [0, 3, 0, 2, 3, 65534] },
];
let losslessChecked = false;
function checkLosslessDecoder() {
  if (losslessChecked) return;
  for (const t of SELF_TEST) {
    const jpg = Uint8Array.from(t.jpeg.match(/../g), (h) => parseInt(h, 16));
    const got = new Uint16Array(new JpegLosslessDecoder().decompress(jpg.buffer, 0, jpg.length));
    if (got.length !== t.values.length || t.values.some((v, i) => got[i] !== v))
      throw refuse('the JPEG Lossless decoder failed its self-test (prepare/vendor/jpeg-lossless-decoder-2.1.2.js is not the corrected copy)');
  }
  for (const tail of ['ffd9', '']) {
    const cut = Uint8Array.from((SELF_TEST[1].jpeg.slice(0, -6) + tail).match(/../g), (h) => parseInt(h, 16));
    let complete = true;
    try { const d = new JpegLosslessDecoder(); d.decompress(cut.buffer, 0, cut.length); complete = d.yLoc >= d.yDim; } catch (e) { complete = false; }
    if (complete) throw refuse('the JPEG Lossless decoder failed its self-test (prepare/vendor/jpeg-lossless-decoder-2.1.2.js takes a scan that is cut short for a whole one)');
  }
  // …and a fill byte put in front of a restart marker of the first stream is taken out again
  const jpg = Uint8Array.from(SELF_TEST[0].jpeg.match(/../g), (h) => parseInt(h, 16));
  let at = -1;
  for (let i = jpg.length - 3; i > 2 && at < 0; i--) if (jpg[i] === 0xff && jpg[i + 1] >= 0xd0 && jpg[i + 1] <= 0xd7) at = i;
  const filled = new Uint8Array(jpg.length + 2);
  filled.set(jpg.subarray(0, at)); filled[at] = 0xff; filled[at + 1] = 0xff; filled.set(jpg.subarray(at), at + 2);
  const back = withoutFillBytes(filled);
  if (at < 0 || back.length !== jpg.length || back.some((v, i) => v !== jpg[i])) throw refuse('the JPEG fill-byte handling failed its self-test');
  losslessChecked = true;
}

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
  let bitsStored = ds.uint16('x00280101') || bitsAllocated;
  if (bitsStored > bitsAllocated) bitsStored = bitsAllocated;
  let highBit = ds.uint16('x00280102');
  if (highBit == null || highBit < bitsStored - 1 || highBit >= bitsAllocated) highBit = bitsStored - 1;   // absent or impossible: the usual layout
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
      frames.push(samplesToValues(bitsAllocated === 8 ? new Uint8Array(slice) : new Uint16Array(slice), bitsAllocated, bitsStored, highBit, !!pixelRep, true));
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
          const jpg = withoutFillBytes(enc);
          const h = checkLosslessFrame(jpg), pt = h.pt;                     // refuses what cannot be decoded exactly
          // The frame carries its own size. A file whose DICOM header says something else contradicts itself, and
          // read by the header's numbers the samples come out in the wrong shape or even the wrong width (a
          // 12-bit 17 x 13 frame under "Rows = 26" was returned as 442 8-bit values). Such a file is refused.
          if (h.cols !== cols || h.rows !== rows) throw refuse(`the JPEG frame is ${h.cols} columns x ${h.rows} rows, but the DICOM header says ${cols} x ${rows}`);
          // …and so does one whose samples are wider than the container the header declares.
          if (h.P > bitsAllocated) throw refuse(`the JPEG frame has ${h.P}-bit samples, but the DICOM header says Bits Allocated ${bitsAllocated}`);
          checkLosslessDecoder();
          const dec = new JpegLosslessDecoder();
          const raw = dec.decompress(jpg.buffer, jpg.byteOffset, jpg.length);
          // A scan that is cut off leaves the rest of the frame as it was allocated — zeros, and no error. (A
          // frame that only lacks its end marker can be complete: what counts first is that every row was written.)
          if (!(dec.yLoc >= dec.yDim)) throw new Error(`the JPEG data ends after ${dec.yLoc} of ${dec.yDim} rows`);
          // A scan that no marker closes has to show that it is whole another way: a complete scan fills its last
          // byte with 1-bits. Where the data was cut and the fragment padded to an even length, the last sample
          // took its bits from the pad byte (zero) — and the bits after it are then not that padding. When it took
          // ALL of a final zero byte there is nothing left to look at: that cannot be told from a cut, and is not
          // taken for a whole frame either. (What remains undetected: data cut so that what is left is itself a
          // whole scan — nothing in the bytes says so.)
          if (!scanIsClosed(jpg) && dec.tailPad) {
            const tp = dec.tailPad;
            if (!tp.ones) throw new Error('the JPEG data has no end marker and does not end the way a complete frame does (it is probably cut short)');
            if (tp.bits === 0 && tp.used >= jpg.length && jpg[jpg.length - 1] === 0) throw new Error('the JPEG data has no end marker, and its last byte cannot be told from padding: the frame may be cut short');
          }
          const per = h.P <= 8 ? 1 : 2;
          if (raw.byteLength !== N * per) throw new Error(`the JPEG frame decoded to ${raw.byteLength} bytes instead of ${N * per}`);
          const u = per === 1 ? new Uint8Array(raw) : new Uint16Array(raw);
          // Point transform (Pt, "Al" in the scan header): the encoder dropped the Pt low bits of every sample,
          // so the decoded values are shifted back by Pt. (Some Siemens runs have single frames with Pt = 1.)
          // GDCM, libjpeg-turbo and FFmpeg decode such frames the same way; pylibjpeg-libjpeg does not: it
          // returns them 2^(P+Pt-1) - 2^(P-1) too bright and clipped, so a dataset built through it shows such
          // a frame washed out where this page shows it like its neighbours.
          if (pt) for (let i = 0; i < u.length; i++) u[i] <<= pt;
          const sBits = Math.min(bitsStored, per * 8);
          // A JPEG frame may be coded wider than Bits Stored (16-bit coding of 12-bit pixels is common) as long as
          // its VALUES fit: the bits above are zero, or — signed pixels — repeat the sign. Values that need more
          // bits than the header declares contradict it: they were passed on as they came (4094 under "8 bits
          // stored"), and the windowing after this takes Bits Stored at its word.
          if (h.P > sBits) {
            // (The bits to look at are those the JPEG frame codes — P of them — not those of the array the
            // samples sit in: -1 in 10 stored bits is 0xFFF in a 12-bit frame, and bits 12-15 are not part of it.)
            const top = 1 << sBits, upper = ((1 << h.P) - 1) & ~(top - 1), sign = top >> 1;
            for (let i = 0; i < u.length; i++) {
              const x = u[i] & upper;
              if (x !== 0 && !(pixelRep && x === upper && (u[i] & sign))) throw refuse(`the JPEG frame (${h.P}-bit samples) holds values that do not fit the Bits Stored ${bitsStored} of the DICOM header`);
            }
          }
          out = samplesToValues(u, per * 8, sBits, sBits - 1, !!pixelRep, false);
        }
      } catch (e) {
        // a stream that was refused (see checkLosslessFrame) fails the whole file, wherever the frame is
        if (e && e.refused) throw new Error(`Frame ${f + 1} cannot be decoded: ${e.message}`);
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
    info: { nFramesHeader: nFrames, bitsAllocated, bitsStored, highBit, pixelRep, photometric },
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
  const out = Int32Array.from(frames[0]);          // wide and signed: the smallest value survives whatever the frames' own types are
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
