// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// The editor's state and what it can do to the pedal, with no screen attached. Knobs go by control change, everything
// else in the sound by one-byte DT1 to 20 00 00 00 (the sound being played), system settings by DT1 to 10 00 00 00.
// All of these take effect on the pedal at once.
(function (root) {
  const R = root.RE202 || require('./re202.js');
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const SWITCH_CC = { effect: R.CC.effect, tap: R.CC.tap, twist: R.CC.twist, warp: R.CC.warp };

  class Editor {
    constructor(link) {
      this.link = link;
      this.channel = 1;                 // the pedal's receive channel
      this.mem = R.defaultMemory();     // the sound on the screen
      this.memLen = R.MEMORY_SIZE;      // bytes in a memory on this pedal: 34, or 33 before system Ver. 1.10
      this.sys = null;                  // the system settings, once read
      this.id = null;                   // the pedal's Identity Reply
      this.reads = false;               // the pedal answers, so reading and backup work
      this.known = false;               // the screen shows what the pedal is playing
      this.slot = null;                 // the memory recalled: 0 MANUAL, 1..127, null when not known
      this.effect = true;
      this.held = { twist: false, warp: false };
      this.onChange = null;             // (what) after anything on the screen should redraw
      this.echo = 400;                  // ms after sending a value during which the same control coming back is ignored
      this.sentAt = {};
      this.touched = 0;                 // when the editor last changed the sound itself
      this.settle = 500;                // ms after that before the pedal's sound is read for what moved on it
      link.onCC = (ch, n, v) => this.heardCC(ch, n, v);
      link.onPC = (ch, p) => this.heardPC(ch, p);
    }

    changed(what) { if (this.onChange) this.onChange(what); }
    has(key) { const p = R.MEM[key]; return !!p && p.off + p.width <= this.memLen; }

    // ---- reading

    // find out whether the pedal answers, and if it does, read its settings and the sound it is playing
    async connect() {
      this.reads = false; this.sys = null; this.id = null; this.known = false; this.slot = null;
      if (this.link.canRead) {
        try {
          this.id = await this.link.identity();
          await this.readSystem();
          await this.readCurrent();
          this.reads = true;
        } catch (e) { this.reads = false; }
      }
      this.changed('connect');
      return this.reads;
    }
    async readSystem() {
      const data = await this.link.request(R.SYSTEM, R.SYSTEM_SIZE);
      this.sys = R.decode(R.SYSTEM_PARAMS, data);
      if (this.sys.rx_ch) this.channel = this.sys.rx_ch;
      this.changed('system');
    }
    async readCurrent() {
      const data = await this.link.request(R.CURRENT, R.MEMORY_SIZE);
      this.memLen = data.length;
      this.mem = { ...R.defaultMemory(), ...R.decode(R.MEMORY, data) };
      this.known = true;
      this.changed('memory');
    }
    async readSlot(slot) { return R.decode(R.MEMORY, await this.link.request(R.slotAddress(slot), R.MEMORY_SIZE)); }

    // ---- the sound

    set(key, value) {
      const p = R.MEM[key];
      if (!p) throw new Error(`no parameter called ${key}`);
      const v = p.width === 4 ? Math.max(0, Math.min(p.hi, Math.round(value))) : R.clamp(p, value);
      this.mem[key] = v;
      this.touched = Date.now();
      if (p.cc) { this.sentAt[p.cc] = Date.now(); this.link.send(R.cc(this.channel, p.cc, v)); }
      else if (this.has(key)) this.link.send(R.dt1(R.offset(R.CURRENT, p.off), R.paramBytes(p, v)));
      this.changed('memory');
    }

    // a whole sound at once: a preset, or a memory read from the pedal
    load(values) {
      const mem = R.defaultMemory();
      for (const p of R.MEMORY) if (values[p.key] !== undefined) mem[p.key] = p.width === 4 ? Math.max(0, Math.min(p.hi, Math.round(values[p.key]))) : R.clamp(p, values[p.key]);
      this.mem = mem;
      this.touched = Date.now();
      this.link.send(R.dt1(R.CURRENT, R.encode(R.MEMORY, mem, R.MEMORY_SIZE).slice(0, this.memLen)));
      for (const [key, , cc] of R.KNOBS) { this.sentAt[cc] = Date.now(); this.link.send(R.cc(this.channel, cc, mem[key])); }
      if (mem.tap_sw) this.link.send(R.tapCcs(this.channel, mem.tap_time, mem.time_mode));
      this.known = true;
      this.changed('memory');
    }

    // the reverb type heard: the memory's own when the pedal is set to keep one per memory, the system's otherwise
    get perMemoryReverb() { return !!this.sys && this.sys.reverb_pref === 1 && this.has('reverb_type'); }
    get reverbType() { return this.perMemoryReverb ? this.mem.reverb_type : this.sys ? this.sys.reverb_type : this.mem.reverb_type; }
    setReverbType(v) {
      if (this.perMemoryReverb) return this.set('reverb_type', v);
      if (this.sys) return this.setSystem('reverb_type', v);
      this.mem.reverb_type = R.clamp(R.MEM.reverb_type, v);     // nothing read: the system's type is the one that plays by default
      this.link.send(R.dt1(R.offset(R.SYSTEM, R.SYS.reverb_type.off), [this.mem.reverb_type]));
      this.changed('memory');
    }

    // ---- time

    // set the delay time from a tempo: the longest playing head lands on the note, so head 1 gets that time divided by
    // the head's number. Turns the memory's tap time on and sends it as CC 16 / 48; returns head 1's ms.
    tempo(bpm, note) {
      const longest = Math.max(...(R.HEADS[this.mem.mode] || [1]));
      const ms = Math.max(50, Math.min(R.MAX_TAP[this.mem.time_mode] || 1000, R.noteMs(bpm, note) / longest));
      this.set('tap_sw', 1);
      this.set('tap_time', ms);
      this.link.send(R.tapCcs(this.channel, ms, this.mem.time_mode));
      return Math.round(ms);
    }
    // each playing head's delay: ms when the tap time is on, otherwise its multiple of head 1 (the knob's time is not sent over MIDI)
    heads() {
      const active = R.HEADS[this.mem.mode] || [1];
      if (!this.mem.tap_sw) return active.map(n => ({ n, ms: null }));
      const ref = this.sys && this.sys.tap_setting !== undefined ? Math.floor(this.sys.tap_setting / 2) : 0;   // HEAD1, SHORT, LONG
      const unit = this.mem.tap_time / (ref === 1 ? Math.min(...active) : ref === 2 ? Math.max(...active) : 1);
      return active.map(n => ({ n, ms: Math.round(unit * n) }));
    }

    // ---- switches

    switch(name, on) {
      if (!(name in SWITCH_CC)) throw new Error(`no switch called ${name}`);
      if (name === 'effect') this.effect = !!on;
      if (name in this.held) this.held[name] = !!on;
      this.sentAt[SWITCH_CC[name]] = Date.now();
      this.link.send(R.cc(this.channel, SWITCH_CC[name], on ? 127 : 0));
      this.changed('switch');
    }
    // let go of Twist and Warp, whatever became of the pointer that held them
    release() { for (const name of Object.keys(this.held)) if (this.held[name]) { try { this.switch(name, false); } catch (e) { this.held[name] = false; } } }

    // ---- memories

    async recall(slot) {
      this.pcAt = this.touched = Date.now();
      this.link.send(R.program(this.channel, slot));
      this.slot = slot;
      if (this.reads) { await sleep(120); await this.readCurrent(); }
      else { this.known = false; this.changed('memory'); }
    }
    // store the sound on the screen in a memory of the pedal
    write(slot) {
      if (!Number.isInteger(slot) || slot < 1 || slot > 127) throw new Error('a memory to write is 1 to 127');
      if (!this.known) throw new Error('the screen does not show what the pedal is playing: read the pedal or load a preset first');
      this.link.send(R.dt1(R.slotAddress(slot), R.encode(R.MEMORY, this.mem, R.MEMORY_SIZE).slice(0, this.memLen)));
    }

    // ---- system settings

    setSystem(key, value) {
      const p = R.SYS[key];
      if (!p) throw new Error(`no system setting called ${key}`);
      if (this.sys && !(key in this.sys)) throw new Error(`this pedal's system version has no ${p.label} setting`);
      const v = R.clamp(p, value);
      this.touched = Date.now();
      this.link.send(R.dt1(R.offset(R.SYSTEM, p.off), [v]));
      if (this.sys) this.sys[key] = v;
      if (key === 'rx_ch' && v) this.channel = v;
      this.changed('system');
    }

    // ---- backup

    // the system block and every memory as one .syx: DT1 messages the pedal takes back as they are
    async backup(onStep) {
      const out = [];
      out.push(R.dt1(R.SYSTEM, await this.link.request(R.SYSTEM, R.SYSTEM_SIZE), 0x10));
      for (let s = 0; s < R.SLOTS; s++) {
        out.push(R.dt1(R.slotAddress(s), await this.link.request(R.slotAddress(s), R.MEMORY_SIZE), 0x10));
        if (onStep) onStep(s + 1, R.SLOTS);
      }
      return Uint8Array.from(out.flat());
    }
    // send a backup to the pedal: its memories, and its system settings only when asked
    async restore(bytes, { system = false } = {}, onStep) {
      const messages = [];
      for (const msg of R.splitSysex(Array.from(bytes))) {
        const dt = R.parseDt1(msg);
        if (!dt) continue;
        const isSystem = R.toInt(dt.addr) >= R.toInt(R.SYSTEM) && R.toInt(dt.addr) < R.toInt(R.CURRENT);
        if (isSystem ? system : R.slotOf(dt.addr) !== null) messages.push(R.dt1(dt.addr, dt.data));
      }
      if (!messages.length) throw new Error('that file holds no RE-202 memories');
      await this.link.bulk(messages, onStep);
      return messages.length;
    }

    // write a bank to the pedal's memories: [{ slot, values }]. The pedal is first set to keep a reverb type per memory
    // and to take a tap time as head 1's, the two settings the bank's names are true under.
    async loadBank(entries, onStep) {
      if (!this.reads) throw new Error('loading the bank needs the pedal to answer: connect its MIDI OUT and read it first');
      if ('reverb_pref' in this.sys) this.setSystem('reverb_pref', 1);
      if ('tap_setting' in this.sys) this.setSystem('tap_setting', 0);
      const messages = entries.map(({ slot, values }) => {
        if (!Number.isInteger(slot) || slot < 1 || slot > 127) throw new Error('a memory to write is 1 to 127');
        return R.dt1(R.slotAddress(slot), R.encode(R.MEMORY, values, R.MEMORY_SIZE).slice(0, this.memLen));
      });
      await this.link.bulk(messages, onStep);
      return messages.length;
    }

    // ---- from the pedal

    get txChannel() { return !this.sys || this.sys.tx_ch === 17 || !this.sys.tx_ch ? this.channel : this.sys.tx_ch; }
    heardCC(ch, n, v) {
      if (ch !== this.txChannel || Date.now() - (this.sentAt[n] || 0) < this.echo) return;
      const p = R.MEMORY.find(q => q.cc === n);
      if (p) { this.mem[p.key] = v; this.changed('memory'); }
      else if (n === R.CC.effect) { this.effect = v >= 64; this.changed('switch'); }
    }
    heardPC(ch, slot) {
      if (ch !== this.txChannel) return;
      if (Date.now() - (this.pcAt || 0) < this.echo && slot === this.slot) return;   // our own program change, passed back by MIDI Thru
      this.slot = slot;
      this.touched = Date.now();
      this.changed('memory');
      if (this.reads) sleep(120).then(() => this.readCurrent()).catch(() => {});
      else { this.known = false; this.changed('memory'); }
    }
    // The Mode Selector, the tape, input and reverb buttons and a tapped time have no control change, so the pedal says
    // nothing when they move. Read the sound being played and the system settings and take those from them; true when
    // one had moved.
    async follow() {
      const asked = Date.now();
      if (!this.reads || !this.known || this.link.pending || asked - this.touched < this.settle) return false;
      let data, system;
      try {
        data = await this.link.request(R.CURRENT, R.MEMORY_SIZE, true);
        system = await this.link.request(R.SYSTEM, R.SYSTEM_SIZE, true);
      } catch (e) { return false; }
      if (this.touched >= asked) return false;       // the editor changed something while the pedal answered
      const got = R.decode(R.MEMORY, data), sys = R.decode(R.SYSTEM_PARAMS, system);
      if (Object.keys(sys).some(k => sys[k] !== this.sys[k])) {
        this.sys = sys;
        if (sys.rx_ch) this.channel = sys.rx_ch;
        this.changed('system');
      }
      let moved = false;
      for (const p of R.MEMORY) {
        if (p.cc || p.group === 'exp' || got[p.key] === undefined || got[p.key] === this.mem[p.key]) continue;
        this.mem[p.key] = got[p.key]; moved = true;
      }
      if (moved) this.changed('memory');
      return moved;
    }
  }

  root.Editor = Editor;
  if (typeof module !== 'undefined' && module.exports) module.exports = Editor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
