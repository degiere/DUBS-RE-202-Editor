// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// The cable to the pedal: one output port and, when the pedal's MIDI OUT comes back, one input port. Ports are Web MIDI
// MIDIOutput / MIDIInput objects or anything shaped like them (the fake pedal's). Requests run one at a time.
(function (root) {
  const R = root.RE202 || require('./re202.js');

  class Link {
    constructor({ wait = 1500, gap = 30, quiet = 150 } = {}) {
      this.wait = wait;                // ms to wait for the pedal's answer
      this.quiet = quiet;              // ms of silence after a short answer before taking it as the whole answer
      this.gap = gap;                  // ms between messages of a bulk write
      this.output = null; this.input = null;
      this.onCC = null;                // (channel 1..16, number, value)
      this.onPC = null;                // (channel 1..16, program)
      this.onLog = null;               // ('out' | 'in', bytes)
      this.sysexWaiters = new Set();   // functions offered each incoming SysEx message
      this.queue = Promise.resolve();
      this.pending = 0;                // requests waiting or in flight
      this.hush = false;               // a request kept out of the log is in flight
    }

    use(output, input) {
      if (this.input) this.input.onmidimessage = null;
      this.output = output || null; this.input = input || null;
      if (this.input) this.input.onmidimessage = e => this.receive(e.data);
    }
    get canRead() { return !!(this.output && this.input); }

    send(bytes, quiet = false) {
      if (!this.output) throw new Error('pick the MIDI output the RE-202 is on');
      this.output.send(bytes);
      if (this.onLog && !quiet) this.onLog('out', Array.from(bytes));
    }

    // one Web MIDI message: realtime bytes (the pedal's clock and active sensing) go first, then SysEx, CC and PC
    receive(data) {
      const s = data[0];
      if (s === undefined || s >= 0xF8) return;
      if (this.onLog && !(this.hush && s === 0xF0)) this.onLog('in', Array.from(data));
      if (s === 0xF0) { for (const w of [...this.sysexWaiters]) w(data); return; }
      const ch = (s & 0x0F) + 1;
      if ((s & 0xF0) === 0xB0 && data.length >= 3 && this.onCC) this.onCC(ch, data[1], data[2]);
      else if ((s & 0xF0) === 0xC0 && data.length >= 2 && this.onPC) this.onPC(ch, data[1]);
    }

    // run fn after the requests before it, whatever became of them
    serial(fn) {
      this.pending++;
      const run = this.queue.then(fn, fn).finally(() => { this.pending--; });
      this.queue = run.catch(() => {});
      return run;
    }

    // send a request and collect answers until take(msg, done) returns something other than undefined, calls done(value)
    // later, or time runs out (null). A quiet request stays out of the log, with its answer.
    ask(bytes, take, quiet = false) {
      return this.serial(() => new Promise((resolve, reject) => {
        if (!this.input) return reject(new Error('reading needs the RE-202\'s MIDI OUT cabled back to a MIDI input here'));
        let timer = null;
        const end = () => { clearTimeout(timer); this.sysexWaiters.delete(waiter); this.hush = false; };
        const done = v => { end(); resolve(v); };
        const waiter = msg => {
          let v;
          try { v = take(msg, done); } catch (e) { end(); return reject(e); }
          if (v !== undefined) done(v);
        };
        this.sysexWaiters.add(waiter);
        this.hush = quiet;
        timer = setTimeout(() => done(null), this.wait);
        try { this.send(bytes, quiet); } catch (e) { end(); reject(e); }
      }));
    }

    // the pedal's Identity Reply { dev, version }, or null when nothing answers
    identity() { return this.ask(R.IDENTITY_REQUEST, msg => R.parseIdentity(msg) || undefined); }

    // up to size bytes from addr, gathered from the DT1 answers. Older system versions hold shorter blocks than Boss's
    // v1.10 map and answer with fewer bytes: the answer is whatever arrived from addr onward once the pedal goes quiet.
    async request(addr, size, quiet = false) {
      const start = R.toInt(addr), got = new Map();
      let lull = null;
      const prefix = () => { const out = []; for (let i = 0; i < size && got.has(i); i++) out.push(got.get(i)); return out; };
      const data = await this.ask(R.rq1(addr, size), (msg, done) => {
        const dt = R.parseDt1(msg);
        if (!dt) return undefined;
        dt.data.forEach((b, i) => { const n = R.toInt(dt.addr) + i - start; if (n >= 0 && n < size) got.set(n, b); });
        clearTimeout(lull);
        if (got.size === size) return prefix();
        lull = setTimeout(() => done(prefix()), this.quiet);
        return undefined;
      }, quiet);
      clearTimeout(lull);
      if (!data || !data.length) throw new Error('the RE-202 did not answer. Check that its MIDI OUT reaches the input picked here');
      return data;
    }

    // messages one after another with room between them, for restoring a backup
    bulk(messages, onStep) {
      return this.serial(async () => {
        for (let i = 0; i < messages.length; i++) {
          this.send(messages[i]);
          if (onStep) onStep(i + 1, messages.length);
          await new Promise(r => setTimeout(r, this.gap));
        }
      });
    }
  }

  root.Link = Link;
  if (typeof module !== 'undefined' && module.exports) module.exports = Link;
})(typeof globalThis !== 'undefined' ? globalThis : this);
