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

  async function writeText(dirHandle, name, text) {
    const fh = await dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }

  root.FS = { supported, pickDirectory, ensureReadWrite, writeText };
})(typeof window !== 'undefined' ? window : globalThis);
