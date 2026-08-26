// npy.js — minimal .npy parser for the browser (also loadable in Node for tests).
// Supports little-endian uint16 (<u2), uint8 (|u1/<u1), int32 (<i4), uint32 (<u4).
// Errors on fortran_order=True or any dtype it does not recognise, rather than
// silently mis-decoding. Browsers run little-endian, matching numpy's '<' dtypes.
(function (root) {
  'use strict';

  function parseNpy(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5]);
    if (magic !== '\x93NUMPY') throw new Error('not a .npy file (bad magic)');
    const major = bytes[6];
    let headerLen, headerStart;
    if (major === 1) {
      headerLen = bytes[8] | (bytes[9] << 8);
      headerStart = 10;
    } else if (major === 2 || major === 3) {
      headerLen = bytes[8] | (bytes[9] << 8) | (bytes[10] << 16) | (bytes[11] * 0x1000000);
      headerStart = 12;
    } else {
      throw new Error('unsupported .npy version ' + major);
    }
    const header = new TextDecoder('latin1').decode(bytes.subarray(headerStart, headerStart + headerLen));
    const descrM = header.match(/'descr'\s*:\s*'([^']+)'/);
    const fortM = header.match(/'fortran_order'\s*:\s*(True|False)/);
    const shapeM = header.match(/'shape'\s*:\s*\(([^)]*)\)/);
    if (!descrM || !fortM || !shapeM) throw new Error('cannot parse .npy header');
    if (fortM[1] === 'True') throw new Error('.npy fortran_order=True not supported');
    const descr = descrM[1];
    const shape = shapeM[1].split(',').map(s => s.trim()).filter(s => s.length).map(Number);
    // sp-9: a VIEW over the file buffer, not a copy — .slice() duplicated the whole payload (~6 MB per
    // 1432² label read, on every unit load). The .npy spec pads the header so data starts 64-byte
    // aligned, satisfying every element size here; the element COUNT comes from the shape so trailing
    // bytes (or a truncated file) can never mis-size the array — a short file throws, as the copy did.
    // Nothing in the app writes into parsed arrays (checked: label/mask are read-only downstream), and
    // the view pins only the file's own buffer (header + payload), so memory footprint is unchanged.
    const off = headerStart + headerLen;
    const count = shape.length ? shape.reduce((a, b) => a * b, 1) : 0;
    const mk = (T) => {
      if (off % T.BYTES_PER_ELEMENT !== 0) return new T(arrayBuffer.slice(off), 0, count);   // misaligned header (non-spec file): fall back to a copy
      if (off + count * T.BYTES_PER_ELEMENT > arrayBuffer.byteLength) throw new Error('.npy payload shorter than its shape');
      return new T(arrayBuffer, off, count);
    };
    let data;
    switch (descr) {
      case '<u2': case '=u2': case '|u2': data = mk(Uint16Array); break;
      case '|u1': case '<u1': case '=u1': case 'u1': case 'b1': case '|b1': data = mk(Uint8Array); break;
      case '<i4': case '=i4': data = mk(Int32Array); break;
      case '<u4': case '=u4': data = mk(Uint32Array); break;
      default: throw new Error('unsupported .npy dtype: ' + descr);
    }
    return { data, shape, descr, fortranOrder: false };
  }

  const api = { parseNpy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NPY = api;
})(typeof window !== 'undefined' ? window : globalThis);
