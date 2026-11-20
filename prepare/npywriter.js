// npywriter.js — write a 2-D array as a .npy file exactly the way numpy.save does (format 1.0): the same
// header text, the same space padding (21-digit growth room, 64-byte alignment) and little-endian data.
// The annotator's npy.js reads '<u2' (label.npy) and '|u1' (mask.npy).

export function npyBytes(data, dtype, H, W) {
  const itemsize = { '<u2': 2, '|u1': 1 }[dtype];
  if (!itemsize) throw new Error(`npywriter: unsupported dtype ${dtype}`);
  if (data.length !== H * W || data.BYTES_PER_ELEMENT !== itemsize) throw new Error('npywriter: data does not match dtype / shape');
  let header = `{'descr': '${dtype}', 'fortran_order': False, 'shape': (${H}, ${W}), }`;
  header += ' '.repeat(21 - String(H).length);              // numpy's GROWTH_AXIS_MAX_DIGITS room
  const hlen = header.length + 1;                           // + the final newline
  const padlen = 64 - ((6 + 2 + 2 + hlen) % 64);            // numpy pads 1..64, never 0
  header += ' '.repeat(padlen) + '\n';
  const out = new Uint8Array(10 + header.length + data.byteLength);
  out.set([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0], 0);   // \x93NUMPY v1.0
  out[8] = header.length & 0xff; out[9] = header.length >> 8;
  for (let i = 0; i < header.length; i++) out[10 + i] = header.charCodeAt(i);
  out.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 10 + header.length);   // JS typed arrays are little-endian here
  return out;
}
