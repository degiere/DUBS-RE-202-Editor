// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// Presets, backups and memory names as files in a folder the user grants through Chrome's folder picker:
//   Presets/<name>.json   Backups/<name>.syx   memories.json   Trash/
// Until a folder is granted, presets and names live in the browser's storage and a backup downloads as a file.
(function (root) {
  const clean = name => String(name).replace(/[\/\\:*?"<>|]/g, '-').trim();
  const DB = 're202-editor', STORE = 'handles';

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(STORE, mode), req = fn(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = () => reject(tx.error);
      };
    });
  }
  const local = {
    get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch (e) { return fallback; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage is a convenience here */ } },
  };

  class Library {
    constructor() { this.dir = null; this.waiting = false; }   // waiting: a folder was granted before and needs one click to reopen
    get name() { return this.dir ? this.dir.name : null; }

    // reopen the folder granted in an earlier visit; Chrome asks again only from a click (ask = true)
    async reopen(ask) {
      let handle = null;
      try { handle = await idb('readonly', s => s.get('library')); } catch (e) { return false; }
      if (!handle) return false;
      let state = await handle.queryPermission({ mode: 'readwrite' });
      if (state !== 'granted' && ask) state = await handle.requestPermission({ mode: 'readwrite' });
      this.waiting = state !== 'granted';
      if (state === 'granted') this.dir = handle;
      return state === 'granted';
    }
    async choose() {
      const handle = await showDirectoryPicker({ id: 're202-library', mode: 'readwrite' });
      await idb('readwrite', s => s.put(handle, 'library'));
      this.dir = handle; this.waiting = false;
    }

    sub(name) { return this.dir.getDirectoryHandle(name, { create: true }); }
    static async write(dir, name, data) {
      const file = await dir.getFileHandle(name, { create: true }), w = await file.createWritable();
      await w.write(data); await w.close();
    }
    static async text(dir, name) {
      try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { return null; }
    }

    // ---- presets: [{ name, values }], by name
    async presets() {
      const out = [];
      if (this.dir) {
        const dir = await this.sub('Presets');
        for await (const [file, handle] of dir.entries()) {
          if (handle.kind !== 'file' || !file.endsWith('.json')) continue;
          try { const p = JSON.parse(await (await handle.getFile()).text()); out.push({ name: file.slice(0, -5), values: p.values || {} }); } catch (e) { /* not a preset */ }
        }
      } else {
        for (const [name, values] of Object.entries(local.get('re202.presets', {}))) out.push({ name, values });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    async savePreset(name, values) {
      name = clean(name);
      if (!name) throw new Error('give the preset a name');
      if (this.dir) await Library.write(await this.sub('Presets'), `${name}.json`, JSON.stringify({ name, saved: new Date().toISOString(), values }, null, 2));
      else local.set('re202.presets', { ...local.get('re202.presets', {}), [name]: values });
      return name;
    }
    // a deleted preset moves to the library's Trash folder
    async trashPreset(name) {
      if (this.dir) {
        const dir = await this.sub('Presets'), text = await Library.text(dir, `${name}.json`);
        if (text === null) return;
        await Library.write(await this.sub('Trash'), `${name} ${new Date().toISOString().replace(/[:.]/g, '-')}.json`, text);
        await dir.removeEntry(`${name}.json`);
      } else {
        const all = local.get('re202.presets', {}), gone = local.get('re202.trash', {});
        if (!(name in all)) return;
        gone[`${name} ${new Date().toISOString()}`] = all[name]; delete all[name];
        local.set('re202.trash', gone); local.set('re202.presets', all);
      }
    }

    // ---- names of the pedal's memories: { "5": "Dub throw", ... }
    async names() {
      if (!this.dir) return local.get('re202.names', {});
      try { return JSON.parse(await Library.text(this.dir, 'memories.json')) || {}; } catch (e) { return {}; }
    }
    // the names as they stand, kept in the Trash before something replaces many of them
    async keepNames(names) {
      const name = `memories ${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      if (this.dir) await Library.write(await this.sub('Trash'), name, JSON.stringify(names, null, 2));
      else local.set('re202.trash', { ...local.get('re202.trash', {}), [name]: names });
    }
    async saveNames(names) {
      if (this.dir) await Library.write(this.dir, 'memories.json', JSON.stringify(names, null, 2));
      else local.set('re202.names', names);
    }

    // ---- backups
    async saveBackup(name, bytes) {
      name = `${clean(name)}.syx`;
      if (this.dir) { await Library.write(await this.sub('Backups'), name, bytes); return `Backups/${name} in ${this.dir.name}`; }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      a.download = name; document.body.append(a); a.click(); a.remove();
      return `${name} in Downloads`;
    }
  }

  root.Library = Library;
})(typeof globalThis !== 'undefined' ? globalThis : this);
