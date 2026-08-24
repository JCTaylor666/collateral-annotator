// fs.js — File System Access API wrapper. Lets the app read a user-picked folder
// and write annotation.json back into it, entirely on the user's machine.
(function (root) {
  'use strict';

  const supported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

  async function pickDirectory() {
    return await window.showDirectoryPicker({ id: 'annotatorData', mode: 'readwrite' });
  }

  async function ensureReadWrite(handle) {
    const opts = { mode: 'readwrite' };
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    return (await handle.requestPermission(opts)) === 'granted';
  }

  // Write (create or replace) one text file. A failure MUST NOT leave a brand-new EMPTY file behind:
  // getFileHandle(name, {create:true}) materialises the file immediately, so when createWritable/write/close
  // then failed (permission revoked, disk or Drive error) the folder was left holding a 0-byte
  // annotation.json — which every later read classifies as "unreadable" instead of "never saved", and which
  // hides the frame's real state behind a per-frame warning. An EXISTING file is safe either way: the
  // writable operates on a swap file that only replaces the original at close().
  async function writeText(dirHandle, name, text) {
    let fh = null;
    try { fh = await dirHandle.getFileHandle(name); }                    // probe WITHOUT create: no extra cost when the file is already there
    catch (e) { if (!(e && e.name === 'NotFoundError')) throw e; }       // permission / I-O failure: fail now, before creating anything
    const created = !fh;
    if (!fh) fh = await dirHandle.getFileHandle(name, { create: true });
    let w = null;
    try {
      w = await fh.createWritable();
      await w.write(text);
      const wc = w; w = null;                                            // close() failing must not be followed by abort() on the same writable
      await wc.close();
    } catch (e) {
      if (w) { try { await w.abort(); } catch (e2) { } }                 // discard the swap file; an existing file keeps its previous contents
      if (created) { try { await dirHandle.removeEntry(name); } catch (e2) { } }   // we created it and never filled it
      throw e;
    }
  }

  root.FS = { supported, pickDirectory, ensureReadWrite, writeText };
})(typeof window !== 'undefined' ? window : globalThis);
