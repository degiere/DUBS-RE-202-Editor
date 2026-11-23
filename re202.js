// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// The Boss RE-202 Space Echo's MIDI: its parameters, control changes and Roland SysEx (RQ1 / DT1).
// Everything here comes from Boss's "RE-202 MIDI Implementation" v1.10 (Aug. 31, 2022). A memory is 34 bytes at
// 20 10 00 00 (MANUAL) to 30 00 00 00 (memory 127), 00 10 00 00 apart; the MEMORY block starts at 20 00 00 00 and
// the system settings at 10 00 00 00. Addresses and sizes are four 7-bit bytes.
// A plain script: the page gets the global RE202, node gets module.exports.
(function (root) {
  const MODEL = [0x00, 0x00, 0x00, 0x00, 0x18];
  const ROLAND = 0x41, RQ1 = 0x11, DT1 = 0x12;
  const BROADCAST = 0x7F;                    // the device ID every RE-202 answers to
  const SYSTEM = [0x10, 0, 0, 0];
  const CURRENT = [0x20, 0, 0, 0];           // the start of the MEMORY block
  const FIRST_SLOT = [0x20, 0x10, 0, 0], SLOT_STEP = [0, 0x10, 0, 0];
  const MEMORY_SIZE = 0x22, SYSTEM_SIZE = 0x15, SLOTS = 128;   // slot 0 = MANUAL, 1..127 = memories 1..127

  const OFF_ON = ['OFF', 'ON'];
  const REVERB_TYPES = ['SPRING', 'HALL', 'PLATE', 'ROOM', 'AMBIENCE'];
  const TIME_MODES = ['NORMAL', 'LONG'];
  const MAX_TAP = [1000, 2000];              // the longest tap time in ms, by time mode
  // the heads each mode plays; heads 2, 3 and 4 sit at 2x, 3x and 4x head 1's time (mode 12 spaces them for density)
  const HEADS = [[1], [2], [3], [1, 2], [2, 3], [1, 3], [1, 2, 3], [1, 4], [3, 4], [1, 3, 4], [1, 2, 4], [1, 2, 3, 4]];

  // one parameter: where it sits, its range, the names of its values and its control change, when it has one
  function P(key, off, label, o = {}) {
    const p = { key, off, label, lo: 0, hi: 127, names: null, cc: null, width: 1, show: 0, group: '', ...o };
    if (p.names) { p.lo = 0; p.hi = p.names.length - 1; }
    return p;
  }

  // the eight knobs on control changes (the Mode Selector has none); each has a Min and Max for the expression pedal after it
  const KNOBS = [['repeat_rate', 'Repeat Rate', 17], ['intensity', 'Intensity', 18], ['echo_vol', 'Echo Vol', 19],
    ['bass', 'Bass', 20], ['treble', 'Treble', 21], ['reverb_vol', 'Reverb Vol', 22],
    ['saturation', 'Saturation', 23], ['wow_flutter', 'Wow & Flutter', 24]];

  const MEMORY = [P('tape', 0x00, 'Tape', { names: ['NEW', 'AGED'], group: 'echo' }),
    P('mode', 0x01, 'Mode', { hi: 11, show: 1, group: 'echo' })];
  KNOBS.forEach(([k, label, cc], i) => {
    const off = 0x02 + 3 * i;
    MEMORY.push(P(k, off, label, { cc, group: 'knob' }),
      P(k + '_min', off + 1, label + ' Min', { group: 'exp' }),
      P(k + '_max', off + 2, label + ' Max', { group: 'exp' }));
  });
  MEMORY.push(P('reverb_sw', 0x1A, 'Reverb', { names: OFF_ON, group: 'echo' }),
    P('tap_sw', 0x1B, 'Tap Time On', { names: OFF_ON, group: 'time' }),
    P('tap_time', 0x1C, 'Tap Time ms', { hi: 2000, width: 4, group: 'time' }),
    P('time_mode', 0x20, 'Time Mode', { names: TIME_MODES, group: 'time' }),
    P('reverb_type', 0x21, 'Reverb Type', { names: REVERB_TYPES, group: 'echo' }));

  const CH = Array.from({ length: 16 }, (_, i) => String(i + 1));
  const SYSTEM_PARAMS = [
    P('input', 0x00, 'Input', { names: ['GUITAR', 'LINE'] }),
    P('ctl1', 0x01, 'CTL 1', { names: ['MEMORY UP', 'MEMORY DOWN', 'EFFECT ON/OFF', 'TAP', 'WARP'] }),
    P('ctl2', 0x02, 'CTL 2', { names: ['MEMORY UP', 'MEMORY DOWN', 'EFFECT ON/OFF', 'TAP', 'TWIST'] }),
    P('direct', 0x03, 'Direct Sound', { names: OFF_ON }),
    P('direct_mode', 0x04, 'Direct Mode', { names: ['ANALOG', 'RE-201 SIM 1', 'RE-201 SIM 2'] }),
    P('carryover', 0x05, 'Carryover', { names: OFF_ON }),
    P('time_mode', 0x06, 'Time Mode', { names: TIME_MODES }),
    P('reverb_type', 0x07, 'Reverb Type', { names: REVERB_TYPES }),
    P('memory_extent', 0x08, 'Memory Extent', { lo: 1, hi: 4 }),
    P('rx_ch', 0x09, 'MIDI Rx Ch', { names: ['OFF', ...CH] }),
    P('tx_ch', 0x0A, 'MIDI Tx Ch', { names: ['OFF', ...CH, 'RX'] }),
    P('pc_in', 0x0B, 'PC In', { names: OFF_ON }),
    P('pc_out', 0x0C, 'PC Out', { names: OFF_ON }),
    P('cc_in', 0x0D, 'CC In', { names: OFF_ON }),
    P('cc_out', 0x0E, 'CC Out', { names: OFF_ON }),
    P('sync', 0x0F, 'MIDI Sync', { names: ['INTERNAL', 'AUTO'] }),
    P('realtime', 0x10, 'Realtime Source', { names: ['INTERNAL', 'MIDI'] }),
    P('thru', 0x11, 'MIDI Thru', { names: OFF_ON }),
    P('twist_type', 0x12, 'Twist Type', { names: ['NORMAL', 'HARD', 'NATURAL'] }),
    P('tap_setting', 0x13, 'Tap Setting', { names: ['HEAD1 1/4', 'HEAD1 D1/8', 'SHORT 1/4', 'SHORT D1/8', 'LONG 1/4', 'LONG D1/8'] }),
    P('reverb_pref', 0x14, 'Reverb Type Per', { names: ['SYSTEM', 'MEMORY'] }),
  ];
  const MEM = Object.fromEntries(MEMORY.map(p => [p.key, p]));
  const SYS = Object.fromEntries(SYSTEM_PARAMS.map(p => [p.key, p]));

  // switches and the tap time on control changes, beside the knobs'
  const CC = { effect: 27, tapMsb: 16, tapLsb: 48, tap: 82, twist: 83, warp: 84 };

  // ---------------------------------------------------------------- addresses

  const toInt = b => (b[0] << 21) | (b[1] << 14) | (b[2] << 7) | b[3];       // 7-bit bytes as a number that adds like the pedal's addresses
  const fromInt = n => [(n >> 21) & 0x7F, (n >> 14) & 0x7F, (n >> 7) & 0x7F, n & 0x7F];
  const offset = (addr, n) => fromInt(toInt(addr) + n);
  function slotAddress(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error('a memory is 0 (MANUAL) to 127');
    return fromInt(toInt(FIRST_SLOT) + slot * toInt(SLOT_STEP));
  }
  function slotOf(addr) {       // the memory slot an address points into; null for the system or the block start
    const n = toInt(addr) - toInt(FIRST_SLOT), s = Math.floor(n / toInt(SLOT_STEP));
    return n < 0 || s >= SLOTS ? null : s;
  }

  // ---------------------------------------------------------------- messages

  const checksum = body => (128 - body.reduce((a, b) => a + b, 0) % 128) % 128;
  function frame(cmd, body, dev) {
    if (body.some(b => b < 0 || b > 0x7F)) throw new Error('SysEx data bytes are 0..127');
    return [0xF0, ROLAND, dev, ...MODEL, cmd, ...body, checksum(body), 0xF7];
  }
  const dt1 = (addr, data, dev = BROADCAST) => frame(DT1, [...addr, ...data], dev);          // write data starting at addr
  const rq1 = (addr, size, dev = BROADCAST) => frame(RQ1, [...addr, ...fromInt(size)], dev); // ask for size bytes from addr
  function isRE202(msg) {
    return msg.length >= 15 && msg[0] === 0xF0 && msg[msg.length - 1] === 0xF7 && msg[1] === ROLAND && MODEL.every((b, i) => msg[3 + i] === b);
  }
  function parseDt1(msg) {      // { addr, data, dev } of an RE-202 DT1, null for anything else; a bad checksum throws
    if (!isRE202(msg) || msg[8] !== DT1) return null;
    const body = Array.from(msg.slice(9, -2));
    if (checksum(body) !== msg[msg.length - 2]) throw new Error('a DT1 message from the RE-202 fails its checksum');
    return { addr: body.slice(0, 4), data: body.slice(4), dev: msg[2] };
  }
  function parseRq1(msg) {
    if (!isRE202(msg) || msg[8] !== RQ1) return null;
    const body = Array.from(msg.slice(9, -2));
    return { addr: body.slice(0, 4), size: toInt(body.slice(4, 8)) };
  }
  const IDENTITY_REQUEST = [0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7];
  function parseIdentity(msg) { // { dev, version } of the pedal's Identity Reply, null for anything else
    if (msg.length < 15 || msg[0] !== 0xF0 || msg[1] !== 0x7E || msg[3] !== 0x06 || msg[4] !== 0x02 || msg[5] !== ROLAND || msg[6] !== 0x18 || msg[7] !== 0x04) return null;
    return { dev: msg[2], version: Array.from(msg.slice(10, 14)) };
  }
  function channelByte(status, channel) {
    if (!Number.isInteger(channel) || channel < 1 || channel > 16) throw new Error('the MIDI channel is 1..16');
    return status | (channel - 1);
  }
  const cc = (channel, number, value) => [channelByte(0xB0, channel), number & 0x7F, Math.max(0, Math.min(127, Math.round(value)))];
  function program(channel, slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOTS) throw new Error('a memory is 0 (MANUAL) to 127');
    return [channelByte(0xC0, channel), slot];
  }
  function splitSysex(data) {   // the F0..F7 messages in a .syx file
    const out = []; let start = -1;
    data.forEach((b, i) => {
      if (b === 0xF0) start = i;
      else if (b === 0xF7 && start >= 0) { out.push(Array.from(data.slice(start, i + 1))); start = -1; }
    });
    return out;
  }

  // ---------------------------------------------------------------- memories and the system as values

  const clamp = (p, v) => Math.max(p.lo, Math.min(p.hi, Math.round(Number(v)) || 0));
  function tapBytes(ms) {       // the tap time's four nibbles (0000 0aaa, 0000 bbbb, 0000 cccc, 0000 dddd)
    ms = Math.max(0, Math.min(2000, Math.round(ms)));
    return [(ms >> 12) & 0x07, (ms >> 8) & 0x0F, (ms >> 4) & 0x0F, ms & 0x0F];
  }
  const paramBytes = (p, v) => p.width === 4 ? tapBytes(v) : [clamp(p, v)];
  function decode(params, data) {   // a block shorter than the map (an older system version) leaves its missing parameters out
    const out = {};
    for (const p of params) {
      if (p.off + p.width > data.length) continue;
      out[p.key] = p.width === 4
        ? ((data[p.off] & 7) << 12) | ((data[p.off + 1] & 15) << 8) | ((data[p.off + 2] & 15) << 4) | (data[p.off + 3] & 15)
        : data[p.off];
    }
    return out;
  }
  function encode(params, values, size) {
    const data = new Array(size).fill(0);
    for (const p of params) paramBytes(p, values[p.key] ?? p.lo).forEach((b, i) => { data[p.off + i] = b; });
    return data;
  }
  function defaultMemory() {    // a plain starting point: mode 4, the knobs at noon, the expression pedal spanning each knob
    const m = Object.fromEntries(MEMORY.map(p => [p.key, p.lo]));
    for (const [k] of KNOBS) { m[k] = 64; m[k + '_min'] = 0; m[k + '_max'] = 127; }
    return Object.assign(m, { mode: 3, reverb_sw: 1, tap_time: 500 });
  }

  // ---------------------------------------------------------------- tap time

  function tapCcValue(ms, timeMode) {    // the 14-bit value of CC 16 / 48: time = value * (MAX - 50) / 16256 + 50
    const top = MAX_TAP[timeMode] || 1000;
    ms = Math.max(50, Math.min(top, ms));
    return Math.max(0, Math.min(16256, Math.round((ms - 50) * 16256 / (top - 50))));
  }
  function tapCcs(channel, ms, timeMode) {   // CC 16 then CC 48: the pedal reads the LSB as 0 until the second arrives
    const v = tapCcValue(ms, timeMode);
    return [...cc(channel, CC.tapMsb, v >> 7), ...cc(channel, CC.tapLsb, v & 0x7F)];
  }
  const NOTES = { '1/16': .25, '1/8t': 1 / 3, 'd1/16': .375, '1/8': .5, '1/4t': 2 / 3, 'd1/8': .75, '1/4': 1, '5/16': 1.25, 'd1/4': 1.5, '1/2': 2 };   // in quarter notes
  function noteMs(bpm, note) {
    if (!(note in NOTES) || !(bpm > 0)) throw new Error(`a tempo and a note value: ${Object.keys(NOTES).join(', ')}`);
    return 60000 / bpm * NOTES[note];
  }

  const api = { MODEL, ROLAND, RQ1, DT1, BROADCAST, SYSTEM, CURRENT, MEMORY_SIZE, SYSTEM_SIZE, SLOTS, REVERB_TYPES, TIME_MODES,
    MAX_TAP, HEADS, KNOBS, MEMORY, SYSTEM_PARAMS, MEM, SYS, CC, NOTES, IDENTITY_REQUEST,
    toInt, fromInt, offset, slotAddress, slotOf, checksum, dt1, rq1, parseDt1, parseRq1, parseIdentity, cc, program, splitSysex,
    clamp, tapBytes, paramBytes, decode, encode, defaultMemory, tapCcValue, tapCcs, noteMs };
  root.RE202 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
