// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// A stand-in RE-202 for the tests and the page's built-in pedal: keeps its memories as bytes, answers RQ1 and the
// Identity Request, takes DT1, control changes and program changes. `output` and `input` look like Web MIDI ports.
(function (root) {
  const R = root.RE202 || require('./re202.js');

  class FakePedal {
    constructor({ answers = true, old = false } = {}) {
      this.answers = answers;          // false: a pedal whose MIDI OUT is not cabled back
      this.old = old;                  // true: an older system version, with 18 system bytes and 33 memory bytes
      this.store = new Map();          // address as a number -> byte
      this.channel = 1;
      this.slot = 0;
      this.log = [];                   // every message received, as arrays
      for (let s = 0; s < R.SLOTS; s++) {
        const mem = R.defaultMemory(); mem.mode = s % 12;
        this.write(R.slotAddress(s), R.encode(R.MEMORY, mem, R.MEMORY_SIZE));
      }
      this.write(R.CURRENT, R.encode(R.MEMORY, R.defaultMemory(), R.MEMORY_SIZE));
      const sys = Object.fromEntries(R.SYSTEM_PARAMS.map(p => [p.key, p.lo]));
      Object.assign(sys, { input: 1, direct: 1, rx_ch: 1, tx_ch: 17, pc_in: 1, pc_out: 1, cc_in: 1, cc_out: 1, memory_extent: 4 });
      this.write(R.SYSTEM, R.encode(R.SYSTEM_PARAMS, sys, R.SYSTEM_SIZE));
      const self = this;
      this.output = { id: 'builtin-out', name: 'Built-in pedal (no hardware)', send(data) { self.receive(Array.from(data)); } };
      this.input = { id: 'builtin-in', name: 'Built-in pedal (no hardware)', onmidimessage: null };
    }

    write(addr, data) { data.forEach((b, i) => this.store.set(R.toInt(addr) + i, b)); }
    read(addr, size) { return Array.from({ length: size }, (_, i) => this.store.get(R.toInt(addr) + i) ?? 0); }
    take() { const out = this.log; this.log = []; return out; }

    // what the pedal sends back, a moment later, as one Web MIDI message
    emit(msg) {
      if (!this.answers) return;
      setTimeout(() => { if (this.input.onmidimessage) this.input.onmidimessage({ data: Uint8Array.from(msg) }); }, 0);
    }

    static messages(data) {    // one send's messages: SysEx whole, program changes as 2 bytes, the rest as 3
      const out = []; let i = 0;
      while (i < data.length) {
        if (data[i] === 0xF0) { const end = data.indexOf(0xF7, i); out.push(data.slice(i, end + 1)); i = end + 1; }
        else { const n = (data[i] & 0xF0) === 0xC0 ? 2 : 3; out.push(data.slice(i, i + n)); i += n; }
      }
      return out;
    }

    receive(data) {
      for (const msg of FakePedal.messages(data)) {
        this.log.push(msg);
        if (msg[0] === 0xF0) this.sysex(msg);
        else if ((msg[0] & 0x0F) !== this.channel - 1) continue;
        else if ((msg[0] & 0xF0) === 0xC0) { this.slot = msg[1]; this.write(R.CURRENT, this.read(R.slotAddress(msg[1]), R.MEMORY_SIZE)); }
        else if ((msg[0] & 0xF0) === 0xB0) {
          const p = R.MEMORY.find(q => q.cc === msg[1]);
          if (p) this.write(R.offset(R.CURRENT, p.off), [msg[2]]);
        }
      }
    }

    sysex(msg) {
      if (msg.length === 6 && msg[1] === 0x7E && msg[3] === 0x06 && msg[4] === 0x01) {
        return this.emit([0xF0, 0x7E, 0x10, 0x06, 0x02, 0x41, 0x18, 0x04, 0x00, 0x00, 0x00, 0x01, 0x01, 0x00, 0xF7]);
      }
      const rq = R.parseRq1(msg);
      if (rq) {
        const most = !this.old ? rq.size : R.toInt(rq.addr) < R.toInt(R.CURRENT) ? 18 : 33;
        return this.emit(R.dt1(rq.addr, this.read(rq.addr, Math.min(rq.size, most)), 0x10));
      }
      const dt = R.parseDt1(msg);
      if (dt) {
        this.write(dt.addr, dt.data);
        if (R.toInt(dt.addr) >= R.toInt(R.SYSTEM) && R.toInt(dt.addr) < R.toInt(R.SYSTEM) + R.SYSTEM_SIZE) {
          const rx = this.read(R.offset(R.SYSTEM, R.SYS.rx_ch.off), 1)[0];
          if (rx) this.channel = rx;
        }
      }
    }

    // the player turns a knob or presses MEMORY on the pedal: it tells the editor, as CC OUT and PC OUT do
    // A control with no control change (the Mode Selector, the buttons, a tapped time) changes the sound and says nothing.
    turn(key, value) {
      const p = R.MEM[key];
      this.write(R.offset(R.CURRENT, p.off), R.paramBytes(p, value));
      if (p.cc) this.emit(R.cc(this.channel, p.cc, value));
    }
    press(slot) { this.slot = slot; this.emit(R.program(this.channel, slot)); }
    clock() { this.emit([0xF8]); this.emit([0xFE]); }
  }

  root.FakePedal = FakePedal;
  if (typeof module !== 'undefined' && module.exports) module.exports = FakePedal;
})(typeof globalThis !== 'undefined' ? globalThis : this);
