// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
// Checks the codec, the fake pedal and the MIDI link with no hardware.
//     node test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const R = require('./re202.js');
const FakePedal = require('./fake.js');
const Link = require('./midi.js');

const hex = a => a.map(b => b.toString(16).padStart(2, '0')).join(' ');
const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// ---- codec: the addresses in Boss's map
assert.equal(hex(R.slotAddress(0)), '20 10 00 00');
assert.equal(hex(R.slotAddress(1)), '20 20 00 00');
assert.equal(hex(R.slotAddress(8)), '21 10 00 00');
assert.equal(hex(R.slotAddress(127)), '30 00 00 00');
assert.deepEqual([0, 1, 64, 127].map(s => R.slotOf(R.slotAddress(s))), [0, 1, 64, 127]);
assert.equal(R.slotOf(R.CURRENT), null);
assert.equal(R.slotOf(R.SYSTEM), null);
assert.throws(() => R.slotAddress(128));

// ---- the parameter tables fill their blocks exactly
assert.equal(R.MEMORY.length, 31);
assert.equal(R.SYSTEM_PARAMS.length, 21);
assert.equal(Math.max(...R.MEMORY.map(p => p.off + p.width)), R.MEMORY_SIZE);
assert.equal(Math.max(...R.SYSTEM_PARAMS.map(p => p.off + p.width)), R.SYSTEM_SIZE);
assert.equal(new Set(R.MEMORY.flatMap(p => Array.from({ length: p.width }, (_, i) => p.off + i))).size, R.MEMORY_SIZE);
assert.deepEqual(R.MEMORY.filter(p => p.cc).map(p => p.cc), [17, 18, 19, 20, 21, 22, 23, 24]);

// ---- messages
assert.equal(hex(R.rq1(R.slotAddress(1), R.MEMORY_SIZE)), 'f0 41 7f 00 00 00 00 18 11 20 20 00 00 00 00 00 22 1e f7');
const mem = R.defaultMemory();
const bytes = R.encode(R.MEMORY, mem, R.MEMORY_SIZE);
assert.equal(bytes.length, 34);
assert.deepEqual(R.decode(R.MEMORY, bytes), mem);
const msg = R.dt1(R.slotAddress(5), bytes);
assert.deepEqual(R.parseDt1(msg), { addr: R.slotAddress(5), data: bytes, dev: 0x7F });
const bad = [...msg]; bad[bad.length - 2] ^= 1;
assert.throws(() => R.parseDt1(bad), /checksum/);
assert.equal(R.parseDt1([0xF0, 0x41, 0x10, 0, 0, 0, 0, 0x19, 0x12, 0, 0, 0, 0, 0, 0, 0xF7]), null);
assert.deepEqual(R.cc(3, 17, 99), [0xB2, 17, 99]);
assert.deepEqual(R.program(3, 20), [0xC2, 20]);
assert.throws(() => R.cc(0, 17, 1));
assert.throws(() => R.dt1(R.SYSTEM, [128]));
assert.equal(R.splitSysex([...msg, ...msg, 0x00]).length, 2);

// ---- tap time: an eighth note at 98 bpm is 306.12 ms = CC 16 34, CC 48 31 in Normal; the memory holds four nibbles
assert.deepEqual(R.tapCcs(3, R.noteMs(98, '1/8'), 0), [0xB2, 16, 34, 0xB2, 48, 31]);
assert.deepEqual(R.tapCcs(1, R.noteMs(98, '1/4'), 1), [0xB0, 16, 36, 0xB0, 48, 79]);
assert.deepEqual(R.tapBytes(2000), [0, 7, 13, 0]);
assert.equal(R.decode(R.MEMORY, R.encode(R.MEMORY, { ...mem, tap_time: 1999 }, R.MEMORY_SIZE)).tap_time, 1999);
assert.throws(() => R.noteMs(98, '1/3'));

// ---- the link against the fake pedal
const fake = new FakePedal();
const link = new Link({ wait: 200, gap: 0, quiet: 30 });
link.use(fake.output, fake.input);

const id = await link.identity();
assert.equal(id.dev, 0x10);
const m7 = R.decode(R.MEMORY, await link.request(R.slotAddress(7), R.MEMORY_SIZE));
assert.equal(m7.mode, 7);
const sys = R.decode(R.SYSTEM_PARAMS, await link.request(R.SYSTEM, R.SYSTEM_SIZE));
assert.equal(sys.rx_ch, 1);
assert.equal(sys.tx_ch, 17);

// a write lands where it was sent, and two requests at once come back in order
link.send(R.dt1(R.offset(R.slotAddress(20), R.MEM.saturation.off), [111]));
const [a, b] = await Promise.all([link.request(R.slotAddress(20), R.MEMORY_SIZE), link.request(R.slotAddress(3), R.MEMORY_SIZE)]);
assert.equal(R.decode(R.MEMORY, a).saturation, 111);
assert.equal(R.decode(R.MEMORY, b).mode, 3);

// from the pedal: knob turns and memory presses arrive; clock and active sensing never do
const seen = [];
link.onCC = (ch, n, v) => seen.push(['cc', ch, n, v]);
link.onPC = (ch, p) => seen.push(['pc', ch, p]);
fake.clock(); fake.turn('intensity', 90); fake.clock(); fake.press(3);
await tick();
assert.deepEqual(seen, [['cc', 1, 18, 90], ['pc', 1, 3]]);

// a program change on the fake loads that memory as the one being played
fake.take();
link.send(R.program(1, 20));
assert.equal(R.decode(R.MEMORY, await link.request(R.CURRENT, R.MEMORY_SIZE)).saturation, 111);

// a bulk write sends every message, in order
const blocks = [0, 1, 2].map(s => R.dt1(R.slotAddress(s), bytes));
fake.take();
await link.bulk(blocks);
assert.deepEqual(fake.take(), blocks);

// an older system version answers with shorter blocks: the read returns what the pedal has, and decoding leaves the rest out
const older = new FakePedal({ old: true });
link.use(older.output, older.input);
const shortSys = await link.request(R.SYSTEM, R.SYSTEM_SIZE), shortMem = await link.request(R.slotAddress(2), R.MEMORY_SIZE);
assert.equal(shortSys.length, 18);
assert.equal(shortMem.length, 33);
assert.equal('tap_setting' in R.decode(R.SYSTEM_PARAMS, shortSys), false);
assert.equal(R.decode(R.SYSTEM_PARAMS, shortSys).thru, 0);
assert.equal('reverb_type' in R.decode(R.MEMORY, shortMem), false);
assert.equal(R.decode(R.MEMORY, shortMem).mode, 2);

// no cable back: a read says so instead of hanging, and the next request still runs
const deaf = new FakePedal({ answers: false });
link.use(deaf.output, deaf.input);
assert.equal(await link.identity(), null);
await assert.rejects(link.request(R.SYSTEM, R.SYSTEM_SIZE), /did not answer/);
link.use(deaf.output, null);
await assert.rejects(link.request(R.SYSTEM, R.SYSTEM_SIZE), /MIDI OUT/);
link.use(null, null);
assert.throws(() => link.send([0xB0, 17, 1]), /output/);

// ---- the editor against the fake pedal
const Editor = require('./editor.js');
const pedal = new FakePedal();
const elink = new Link({ wait: 200, gap: 0, quiet: 30 });
elink.use(pedal.output, pedal.input);
const ed = new Editor(elink);
ed.echo = 0;
assert.equal(await ed.connect(), true);
assert.equal(ed.known, true);
assert.equal(ed.sys.rx_ch, 1);
const cur = () => R.decode(R.MEMORY, pedal.read(R.CURRENT, R.MEMORY_SIZE));

// a knob goes by control change on the pedal's channel; the mode by a one-byte DT1 to the sound being played
pedal.take();
ed.set('repeat_rate', 99);
assert.deepEqual(pedal.take(), [[0xB0, 17, 99]]);
ed.set('mode', 6);
assert.deepEqual(pedal.take(), [R.dt1(R.offset(R.CURRENT, 1), [6])]);
assert.equal(cur().mode, 6);
assert.deepEqual(ed.heads().map(h => h.n), [1, 2, 3]);
assert.throws(() => ed.set('nope', 1));

// a tempo turns the tap time on and puts the longest head on the note: 98 bpm, dotted eighth = 459 ms on head 3, so 153 on head 1
assert.equal(ed.tempo(98, 'd1/8'), 153);
assert.equal(cur().tap_sw, 1);
assert.equal(cur().tap_time, 153);
assert.deepEqual(pedal.take().slice(-2), [[0xB0, 16, 13], [0xB0, 48, 100]]);
assert.deepEqual(ed.heads().map(h => h.ms), [153, 306, 459]);

// switches, and Twist let go when the pointer is lost
ed.switch('twist', true);
ed.release();
assert.deepEqual(pedal.take(), [[0xB0, 83, 127], [0xB0, 83, 0]]);
assert.equal(ed.held.twist, false);

// write the sound to memory 9, recall memory 3, recall memory 9: the sound comes back
const mine = { ...ed.mem };
ed.write(9);
await ed.recall(3);
assert.equal(ed.mem.mode, 3);
assert.equal(ed.slot, 3);
await ed.recall(9);
assert.deepEqual(ed.mem, mine);
assert.deepEqual(await ed.readSlot(9), mine);
assert.throws(() => ed.write(0));

// the sound is marked edited from a change until its memory is recalled or written over
assert.equal(ed.edited, false);
ed.set('bass', 77);
assert.equal(ed.edited, true);
ed.write(8);
assert.equal(ed.edited, true);
ed.write(9);
assert.equal(ed.edited, false);
ed.set('bass', mine.bass);
await ed.recall(9);
assert.equal(ed.edited, false);

// a preset loads as one block plus the knobs
ed.load({ ...R.defaultMemory(), mode: 10, saturation: 5, tape: 1 });
assert.equal(cur().mode, 10);
assert.equal(cur().saturation, 5);
assert.equal(cur().tape, 1);
assert.equal(ed.edited, true);

// the reverb type is the system's until the pedal keeps one per memory
ed.setReverbType(2);
assert.equal(R.decode(R.SYSTEM_PARAMS, pedal.read(R.SYSTEM, R.SYSTEM_SIZE)).reverb_type, 2);
ed.setSystem('reverb_pref', 1);
ed.setReverbType(4);
assert.equal(cur().reverb_type, 4);
assert.equal(ed.reverbType, 4);

// a new receive channel moves the editor with it
ed.setSystem('rx_ch', 5);
assert.equal(ed.channel, 5);
pedal.take();
ed.set('bass', 1);
assert.deepEqual(pedal.take(), [[0xB4, 20, 1]]);

// from the pedal: a knob turn and a MEMORY press move the screen
pedal.turn('intensity', 33);
await tick();
assert.equal(ed.mem.intensity, 33);
pedal.receive(R.program(5, 4)); pedal.press(4);
await tick(200);
assert.equal(ed.slot, 4);
assert.equal(ed.mem.mode, 4);

// from the pedal: the Mode Selector, the TAPE button and a tapped time send nothing, and are read from the sound being played
ed.settle = 0;
await tick(5);
assert.equal(await ed.follow(), false);
pedal.turn('mode', 11); pedal.turn('tape', 1); pedal.turn('tap_sw', 1); pedal.turn('tap_time', 432); pedal.turn('bass', 3);
await tick(5);
const heard = []; elink.onLog = (dir, bytes) => heard.push(bytes);
assert.equal(await ed.follow(), true);
assert.deepEqual(heard, []);
elink.onLog = null;
assert.deepEqual([ed.mem.mode, ed.mem.tape, ed.mem.tap_sw, ed.mem.tap_time, ed.mem.bass], [11, 1, 1, 432, 3]);
// the INPUT button is a system setting
pedal.write(R.offset(R.SYSTEM, R.SYS.input.off), [0]);
assert.equal(ed.sys.input, 1);
await ed.follow();
assert.equal(ed.sys.input, 0);
// an edit made here while the pedal answers wins
pedal.turn('mode', 2);
const late = ed.follow();
await tick(1);
ed.set('mode', 7);
assert.equal(await late, false);
assert.equal(ed.mem.mode, 7);
// nothing is read while the editor has just changed the sound
ed.settle = 500;
pedal.turn('mode', 4);
assert.equal(await ed.follow(), false);
assert.equal(ed.mem.mode, 7);
ed.set('mode', 4);

// a backup holds the system block and 128 memories, and restores exactly; system settings only when asked
const saved = await ed.backup();
assert.equal(R.splitSysex(Array.from(saved)).length, 129);
const before = pedal.read(R.slotAddress(9), R.MEMORY_SIZE);
pedal.write(R.slotAddress(9), new Array(R.MEMORY_SIZE).fill(0));
pedal.write(R.offset(R.SYSTEM, R.SYS.carryover.off), [1]);
assert.equal(await ed.restore(saved), 128);
assert.deepEqual(pedal.read(R.slotAddress(9), R.MEMORY_SIZE), before);
assert.equal(pedal.read(R.offset(R.SYSTEM, R.SYS.carryover.off), 1)[0], 1);
assert.equal(await ed.restore(saved, { system: true }), 129);
assert.equal(pedal.read(R.offset(R.SYSTEM, R.SYS.carryover.off), 1)[0], 0);
await assert.rejects(ed.restore(Uint8Array.from([0xF0, 0x7E, 0xF7])), /no RE-202 memories/);

// an older system version: 33-byte memories are read and written at their own length, and the missing setting is refused
const oldPedal = new FakePedal({ old: true });
elink.use(oldPedal.output, oldPedal.input);
const edOld = new Editor(elink);
await edOld.connect();
assert.equal(edOld.memLen, 33);
assert.equal(edOld.has('reverb_type'), false);
oldPedal.take();
edOld.write(2);
assert.equal(R.parseDt1(oldPedal.take()[0]).data.length, 33);
assert.throws(() => edOld.setSystem('twist_type', 1), /system version/);

// send only: edits still go out, a recall leaves the screen unknown, and a write is refused until a preset is loaded
const mute = new FakePedal({ answers: false });
elink.use(mute.output, null);
const edMute = new Editor(elink);
assert.equal(await edMute.connect(), false);
edMute.set('echo_vol', 10);
assert.deepEqual(mute.take(), [[0xB0, 19, 10]]);
await edMute.recall(2);
assert.equal(edMute.known, false);
assert.throws(() => edMute.write(2), /read the pedal or load a preset/);
edMute.load(R.defaultMemory());
edMute.write(2);

// ---- the presets
const Bank = require('./bank.js');
const bank = Bank.presets();
assert.equal(bank.length, 96);
assert.equal(bank.filter(p => Bank.LINE.includes(p.family)).length, 48);
assert.equal(bank.filter(p => p.rig === 'guitar').length, 48);
for (const f of Bank.FAMILIES) assert.equal(bank.filter(p => p.family === f).length, 8, f);
assert.equal(new Set(bank.map(p => p.name)).size, 96);
const LEADS = new Set(bank.map(p => p.lead));
const TRAITS = ['Old', 'Dry', 'Wet', 'Single', 'Trail', 'Edge', 'Dark', 'Bright', 'Thin', 'Fat', 'Clean', 'Hot', 'Steady', 'Wobble', 'Spring', 'Hall', 'Plate', 'Room', 'Ambience', 'Drip', 'Only', 'Tight', 'Slow'];
assert.deepEqual(TRAITS.filter(t => LEADS.has(t)), []);
for (const p of bank) {
  const v = p.values;
  assert.equal(p.name, Bank.nameOf(v, p.lead, p.bpm), p.name);
  if (p.bpm) assert.ok(Math.abs(R.noteMs(p.bpm, p.note) - Bank.longestMs(v)) <= 2.5, p.name);   // the tempo boxes show the same time as the name            // a name is rebuilt from its settings
  assert.ok(p.name.length <= Bank.MAX_NAME, p.name);
  assert.ok(!/[\/\\:*?"<>|]/.test(p.name), p.name);
  for (const q of R.MEMORY) assert.ok(Number.isInteger(v[q.key]) && v[q.key] >= q.lo && v[q.key] <= q.hi, `${p.name} ${q.key}`);
  assert.deepEqual(R.decode(R.MEMORY, R.encode(R.MEMORY, v, R.MEMORY_SIZE)), v, p.name);
  if (v.tap_sw) {
    assert.ok(v.tap_time >= 50, p.name);                                   // the pedal's shortest tap time
    assert.ok(Bank.longestMs(v) <= R.MAX_TAP[v.time_mode], p.name);        // no head past the time mode's longest
  }
  if (v.tape) assert.ok(p.name.split(' ').includes('Old'), p.name);
  assert.ok(v.intensity <= Bank.ceiling(v) && v.intensity <= 78 && v.intensity_max <= 78, p.name);   // no preset stores runaway feedback
  for (const [k] of R.KNOBS) assert.ok(v[k + '_min'] <= v[k] && v[k] <= v[k + '_max'], `${p.name} ${k}`);
}
// the names in the README's examples stay true
for (const name of ['Throw 8d-140 H2 Dark', 'Waterhouse 4t-150 H3 Old Hot', 'Steppers 8d-140 H123 Wet', 'Crash 8d-140 H13 Old Drip',
  'Detroit 5x16-124 H3 Old Dark Trail', 'Slap 110ms H1 Single Bright', 'Gardens Spring Only Fat Hot', 'Wash 1s H1 Hall Dark', 'Oxford R40 H1234 Edge']) assert.ok(bank.some(p => p.name === name), name);
// coverage: every mode, both tapes, every reverb type, each knob low, middle and high, the LONG time mode
const count = f => bank.filter(p => f(p.values)).length;
for (let m = 0; m < 12; m++) assert.ok(count(v => v.mode === m) >= 4, `mode ${m + 1}`);
assert.ok(count(v => v.tape === 1) >= 30);
for (let t = 1; t < 5; t++) assert.ok(count(v => v.reverb_sw && v.reverb_vol >= 50 && v.reverb_type === t) >= 4, R.REVERB_TYPES[t]);
for (const k of ['intensity', 'echo_vol', 'bass', 'treble', 'reverb_vol', 'saturation', 'wow_flutter']) {
  const [lo, hi] = k === 'intensity' ? [26, 52] : [42, 85];    // Intensity's travel ends at its ceiling
  assert.ok(count(v => v[k] <= lo) >= 6 && count(v => v[k] > lo && v[k] < hi) >= 6 && count(v => v[k] >= hi) >= 6, k);
}
assert.ok(count(v => v.time_mode === 1) >= 14);
assert.equal(count(v => v.tap_sw === 0), 6);
// no two presets are near copies: a different mode, tape, time mode or reverb type counts 1, a knob its travel, time its octaves
const apart = (a, b) => {
  const time = a.tap_sw && b.tap_sw ? Math.min(1, Math.abs(Math.log2(a.tap_time / b.tap_time)) / 2) : a.tap_sw === b.tap_sw ? Math.abs(a.repeat_rate - b.repeat_rate) / 127 : 1;
  return (a.mode !== b.mode) + (a.tape !== b.tape) + (a.time_mode !== b.time_mode) + (a.reverb_type !== b.reverb_type) + (a.reverb_sw !== b.reverb_sw) + time
    + ['intensity', 'echo_vol', 'bass', 'treble', 'reverb_vol', 'saturation', 'wow_flutter'].reduce((s, k) => s + Math.abs(a[k] - b[k]) / 127, 0);
};
for (let i = 0; i < 96; i++) for (let j = i + 1; j < 96; j++) assert.ok(apart(bank[i].values, bank[j].values) >= 0.3, `${bank[i].name} / ${bank[j].name}`);

// loading the bank: the pedal is set to a reverb type per memory and HEAD1 tap, then each preset lands in its memory
const bp = new FakePedal();
bp.write(R.offset(R.SYSTEM, R.SYS.tap_setting.off), [3]);
elink.use(bp.output, bp.input);
const edBank = new Editor(elink);
await edBank.connect();
bp.take();
// the four for the MEMORY switch are tape echo with spring reverb, all different
const foot = Bank.foot();
assert.equal(new Set(foot.map(p => p.name)).size, 4);
for (const p of foot) assert.ok(p.values.echo_vol > 0 && p.values.reverb_sw === 1 && p.values.reverb_type === 0 && p.values.reverb_vol >= 50, p.name);
const entries = [...foot.map((p, i) => ({ slot: 1 + i, values: p.values })), ...bank.map((p, i) => ({ slot: Bank.FIRST_SLOT + i, values: p.values }))];
assert.equal(await edBank.loadBank(entries), 100);
const sent = bp.take();
assert.deepEqual(sent.slice(0, 2), [R.dt1(R.offset(R.SYSTEM, R.SYS.reverb_pref.off), [1]), R.dt1(R.offset(R.SYSTEM, R.SYS.tap_setting.off), [0])]);
assert.equal(sent.length, 102);
assert.deepEqual(await edBank.readSlot(5), bank[0].values);
assert.deepEqual(await edBank.readSlot(100), bank[95].values);
assert.deepEqual(await edBank.readSlot(4), foot[3].values);
assert.equal((await edBank.readSlot(0)).mode, 0);
assert.equal((await edBank.readSlot(101)).mode, 101 % 12);
// an older pedal takes 33-byte memories and no system writes it does not have; with no cable back the bank is refused
const bo = new FakePedal({ old: true });
elink.use(bo.output, bo.input);
const edBo = new Editor(elink);
await edBo.connect();
bo.take();
await edBo.loadBank(entries.filter(e => !Bank.needsReverbType({ values: e.values })));
assert.ok(bo.take().every(m => R.parseDt1(m).data.length === 33));
await assert.rejects(edMute.loadBank(entries), /needs the pedal to answer/);

console.log('ok: codec, fake pedal, link, editor, bank');
