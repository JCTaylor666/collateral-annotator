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
    const slice = arrayBuffer.slice(headerStart + headerLen);
    let data;
    switch (descr) {
      case '<u2': case '=u2': case '|u2': data = new Uint16Array(slice); break;
      case '|u1': case '<u1': case '=u1': case 'u1': case 'b1': case '|b1': data = new Uint8Array(slice); break;
      case '<i4': case '=i4': data = new Int32Array(slice); break;
      case '<u4': case '=u4': data = new Uint32Array(slice); break;
      default: throw new Error('unsupported .npy dtype: ' + descr);
    }
    return { data, shape, descr, fortranOrder: false };
  }

  const api = { parseNpy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.NPY = api;
})(typeof window !== 'undefined' ? window : globalThis);
