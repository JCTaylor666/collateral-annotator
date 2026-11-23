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

  // ---- the folders this browser has had open ------------------------------------------------------------
  // The app keeps unsaved work in the browser, filed under a key. The key used to be the id in the folder's
  // .annotator_dataset.json and nothing else — and a COPY of a folder carries the same id file: opened first
  // after a reload, the copy was shown the original's unsaved work, and the next save wrote it into the copy.
  // A file cannot say which folder it lies in. The browser can: a directory handle can be kept (IndexedDB)
  // and compared with the folder that is picked (isSameEntry — no permission needed). This is that book:
  //   key -> { key, base, handle, name, at, tok }   key: what the unsaved work is filed under · base: the id
  //                                                 it came from · at: last opened · tok: the folder's token —
  //                                                 unsaved work is stored with it, and only work that carries
  //                                                 it is taken for this folder's without asking
  //   key -> { key, gone: true, name, at }          a key a folder has left (its id file was replaced): it
  //                                                 stays taken, so what is still filed under it is never
  //                                                 handed to another folder
  // Any failure here means "no book" for that open: the app then files by the id alone, as it did before there
  // was a book — and nothing vouches for unsaved work that comes back that way: it is asked about first.
  const BOOK_DB = 'vessel_annotator_folders', BOOK_STORE = 'folders';
  // (Opened at whatever version it has. A database of this name that lacks the store — made by something else,
  // or left by an upgrade that did not finish — is given the store by one step up in version; it used to be
  // opened at version 1 and nothing else, and such a database switched the book off for good.)
  // (A request that was given up — "blocked": another tab still holds the database open at the old version — can
  // still succeed later, when that tab lets go. Nobody is waiting for that connection any more, so it is closed
  // at once: left open, it kept every later upgrade of the database waiting until this page was closed. And a
  // connection that is in use steps aside when another tab needs to upgrade the database.)
  const bookDb = () => new Promise((resolve, reject) => {
    let over = false;
    const shut = db => { try { db.close(); } catch (e) { } };
    const fail = e => { if (!over) { over = true; reject(e); } };
    const open = (version) => {
      const rq = version ? indexedDB.open(BOOK_DB, version) : indexedDB.open(BOOK_DB);
      rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains(BOOK_STORE)) rq.result.createObjectStore(BOOK_STORE, { keyPath: 'key' }); };
      rq.onsuccess = () => {
        const db = rq.result;
        if (over) { shut(db); return; }
        if (db.objectStoreNames.contains(BOOK_STORE)) { over = true; db.onversionchange = () => shut(db); resolve(db); return; }
        const next = db.version + 1;
        shut(db);
        if (version) fail(new Error('the folder book has no store')); else open(next);
      };
      rq.onerror = () => fail(rq.error || new Error('the folder book cannot be opened'));
      rq.onblocked = () => fail(new Error('the folder book is blocked'));
    };
    open(0);
  });
  const bookTx = (mode, fn) => bookDb().then(db => new Promise((resolve, reject) => {
    let out, rq;
    const done = (err) => { try { db.close(); } catch (e) { } if (err) reject(err); else resolve(out); };
    try {
      const tx = db.transaction(BOOK_STORE, mode);
      tx.oncomplete = () => done(null);
      tx.onerror = tx.onabort = () => done(tx.error || new Error('the folder book could not be ' + (mode === 'readonly' ? 'read' : 'written')));
      rq = fn(tx.objectStore(BOOK_STORE));
      if (rq) rq.onsuccess = () => { out = rq.result; };
    } catch (e) { done(e); }
  }));
  const folderBook = (typeof indexedDB !== 'undefined' && indexedDB) ? {
    all: () => bookTx('readonly', st => st.getAll()),
    put: rec => bookTx('readwrite', st => st.put(rec)),
    del: key => bookTx('readwrite', st => st.delete(key)),
  } : null;

  root.FS = { supported, pickDirectory, ensureReadWrite, writeText, folderBook };
})(typeof window !== 'undefined' ? window : globalThis);
