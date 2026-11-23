// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// The screen: the pedal's face, the preset bar, the head readout and the drawer, wired to the Editor.
const R = RE202, Bank = RE202Bank, $ = id => document.getElementById(id);
const link = new Link(), ed = new Editor(link), lib = new Library(), builtIn = new FakePedal();

// the presets as memories: four spring echoes on 1 to 4 for the MEMORY switch, the 96 presets from 5 up
const bankEntries = () => [...Bank.foot().map((p, i) => ({ slot: 1 + i, name: p.name, values: p.values })),
  ...Bank.presets().map((p, i) => ({ slot: Bank.FIRST_SLOT + i, name: p.name, values: p.values, needsType: Bank.needsReverbType(p) }))];
// the built-in pedal, a stand-in with no hardware behind it, arrives with the bank loaded, and its memory names are its own: they are never saved over a real pedal's
const builtInNames = {};
for (const e of bankEntries()) { builtIn.write(R.slotAddress(e.slot), R.encode(R.MEMORY, e.values, R.MEMORY_SIZE)); builtInNames[e.slot] = e.name; }
builtIn.write(R.offset(R.SYSTEM, R.SYS.reverb_pref.off), [1]);
const onBuiltIn = () => link.output === builtIn.output;
const names = () => onBuiltIn() ? builtInNames : state.names;
const saveNames = () => onBuiltIn() ? Promise.resolve() : lib.saveNames(state.names);
const state = { access: null, presets: [], names: {}, sums: {}, backedUp: false, input: 1, log: [] };
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const sleep = ms => new Promise(r => setTimeout(r, ms));

// one status line: the standing state of the link, with a passing message shown in its place for seven seconds
let toastTimer = null, standing = '', warned = false, passing = null;
function paintStatus() {
  const el = $('status');
  el.textContent = passing ? passing.text : standing;
  el.classList.toggle('note', !!passing && !passing.bad); el.classList.toggle('bad', !!passing && passing.bad);
  el.classList.toggle('warn', !passing && warned);
  el.title = el.textContent;
}
function toast(text, bad) {
  passing = text ? { text, bad: !!bad } : null; paintStatus();
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { passing = null; paintStatus(); }, 7000);
}
// run an action; whatever goes wrong is said on the screen
const run = fn => async (...args) => { try { await fn(...args); } catch (e) { if (e.name !== 'AbortError') toast(e.message, true); } };
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}${p(d.getMinutes())}`; };
const summary = m => `Mode ${m.mode + 1} · ${m.tape ? 'AGED' : 'NEW'} · RATE ${m.repeat_rate} INT ${m.intensity} ECHO ${m.echo_vol} · B ${m.bass} T ${m.treble} · REV ${m.reverb_vol}${m.reverb_sw ? '' : ' off'} · SAT ${m.saturation} W&F ${m.wow_flutter}${m.tap_sw ? ` · ${m.tap_time} ms` : ''}`;

// ---------------------------------------------------------------- knobs

// drag up and down, wheel, arrow keys; perPixel is how far one pixel of drag moves the value
function turnable(el, get, set, perPixel) {
  el.addEventListener('pointerdown', e => {
    e.preventDefault(); el.focus(); el.setPointerCapture(e.pointerId);
    const y0 = e.clientY, v0 = get();
    const move = ev => set(v0 + (y0 - ev.clientY) * (ev.shiftKey ? perPixel / 4 : perPixel));
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  });
  el.addEventListener('wheel', e => { e.preventDefault(); set(get() + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  el.addEventListener('keydown', e => {
    const d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (d) { e.preventDefault(); set(get() + d * (e.shiftKey ? 10 : 1)); }
  });
}
function knobElement(title) {
  const el = document.createElement('div');
  el.className = 'knob'; el.tabIndex = 0; el.title = title;
  el.innerHTML = '<div class="skirt"></div><div class="cap"><i></i></div>';
  return el;
}
const knobs = {};
for (const holder of document.querySelectorAll('[data-knob]')) {
  const key = holder.dataset.knob, p = R.MEM[key];
  const el = knobElement(`${p.label}: drag, scroll or arrow keys. Double-click to type a value`), out = document.createElement('output');
  const set = run(v => { v = clamp(v, 0, 127); if (v !== ed.mem[key]) ed.set(key, v); });
  turnable(el, () => ed.mem[key], set, 0.6);
  el.addEventListener('dblclick', () => { const v = prompt(`${p.label} (0 to 127)`, ed.mem[key]); if (v !== null && v.trim() !== '' && !isNaN(v)) set(Number(v)); });
  holder.append(el, out);
  knobs[key] = { el, out };
}

// the Mode Selector: twelve segments around a stepped knob
const ring = $('ring'), NS = 'http://www.w3.org/2000/svg', SEG = 25;
const at = (r, a) => [100 + r * Math.sin(a * Math.PI / 180), 100 - r * Math.cos(a * Math.PI / 180)].map(n => n.toFixed(2)).join(' ');
const svg = document.createElementNS(NS, 'svg');
svg.setAttribute('viewBox', '0 0 200 200');
R.HEADS.forEach((heads, i) => {
  const a0 = -150 + SEG * i + 1.5, a1 = a0 + SEG - 3;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', `M ${at(56, a0)} L ${at(70, a0)} A 70 70 0 0 1 ${at(70, a1)} L ${at(56, a1)} A 56 56 0 0 0 ${at(56, a0)} Z`);
  path.dataset.mode = i;
  const tip = document.createElementNS(NS, 'title');
  tip.textContent = `Mode ${i + 1}: head${heads.length > 1 ? 's' : ''} ${heads.join(' + ')}`;
  path.append(tip);
  const text = document.createElementNS(NS, 'text'), [x, y] = at(80, a0 + (SEG - 3) / 2).split(' ');
  text.setAttribute('x', x); text.setAttribute('y', y); text.textContent = i + 1;
  svg.append(path, text);
});
// the thin white bracket around modes 8 to 12, hooked in at both ends
const bracket = document.createElementNS(NS, 'path'), b0 = -150 + SEG * 7 + 1.5, b1 = -150 + SEG * 11 + SEG - 1.5;
bracket.setAttribute('class', 'arc');
bracket.setAttribute('d', `M ${at(75, b0)} L ${at(90, b0)} A 90 90 0 0 1 ${at(90, b1)} L ${at(75, b1)}`);
svg.append(bracket);
ring.append(svg);
const setMode = run(v => { v = clamp(v, 0, 11); if (v !== ed.mem.mode) ed.set('mode', v); });
svg.addEventListener('click', e => { if (e.target.dataset.mode !== undefined) setMode(Number(e.target.dataset.mode)); });
const modeKnob = knobElement('Mode Selector: drag, scroll or arrow keys');
turnable(modeKnob, () => ed.mem.mode, setMode, 1 / 14);
ring.append(modeKnob);

// reverb type lamps
const types = $('types');
types.innerHTML = R.REVERB_TYPES.map((name, i) => `<button data-type="${i}"><i class="lamp red"></i>${name}</button>`).join('');
types.addEventListener('click', run(e => { const b = e.target.closest('button'); if (b) ed.setReverbType(Number(b.dataset.type)); }));

// ---------------------------------------------------------------- buttons and footswitches

// a button with a click and a hold: holdStart fires after ms held, holdEnd when it is let go or the pointer is lost
function press(btn, ms, { click, holdStart, holdEnd }) {
  let timer = null, held = false;
  const end = fire => {
    if (!btn.classList.contains('down')) return;
    btn.classList.remove('down'); clearTimeout(timer);
    if (held) { held = false; if (holdEnd) run(holdEnd)(); } else if (fire) run(click)();
  };
  btn.addEventListener('pointerdown', e => {
    btn.setPointerCapture(e.pointerId); btn.classList.add('down'); held = false;
    timer = setTimeout(() => { held = true; run(holdStart)(); }, ms);
  });
  btn.addEventListener('pointerup', () => end(true));
  btn.addEventListener('pointercancel', () => end(false));
  btn.addEventListener('lostpointercapture', () => end(false));
}
const footButton = name => document.querySelector(`[data-foot=${name}] button`);

function nextMemory() {
  const extent = ed.sys && ed.sys.memory_extent ? ed.sys.memory_extent : 4;
  return ed.recall(ed.slot === null || ed.slot >= extent ? 0 : ed.slot + 1);
}
// take a backup before the first write or restore of a visit, when the pedal can be read
async function ensureBackup() {
  if (!ed.reads || state.backedUp) return;
  toast('Backing up the pedal first…');
  const bytes = await ed.backup((n, of) => toast(`Backing up the pedal first: ${n} of ${of}`));
  const where = await lib.saveBackup(`${stamp()} before writing`, bytes);
  state.backedUp = true;
  toast(`Backup saved: ${where}`);
}
async function writeHere(slot) {
  if (!slot) {
    const v = prompt('Write this sound to which memory? (1 to 127)');
    if (v === null) return;
    slot = Number(v);
  }
  await ensureBackup();
  ed.write(slot);
  state.sums[slot] = summary(ed.mem);
  ed.slot = slot;
  renderMemories(); render();
  toast(`Written to memory ${slot}`);
}

$('memory').addEventListener('click', run(nextMemory));
$('tape').addEventListener('click', run(() => ed.set('tape', ed.mem.tape ? 0 : 1)));
$('input').addEventListener('click', run(() => {
  state.input = (ed.sys ? ed.sys.input : state.input) ? 0 : 1;
  ed.setSystem('input', state.input);
  render();
}));
press(footButton('effect'), 400, { click: () => ed.switch('effect', !ed.effect), holdStart: () => ed.switch('warp', true), holdEnd: () => ed.switch('warp', false) });
press(footButton('memory'), 400, { click: nextMemory, holdStart: () => ed.set('reverb_sw', ed.mem.reverb_sw ? 0 : 1) });
press(footButton('tap'), 400, {
  click: async () => { ed.switch('tap', true); await sleep(30); ed.switch('tap', false); },
  holdStart: () => ed.switch('twist', true), holdEnd: () => ed.switch('twist', false),
});
// Twist and Warp never stay stuck on
for (const [target, event] of [[window, 'blur'], [window, 'pagehide'], [document, 'visibilitychange']]) target.addEventListener(event, () => ed.release());

// ---------------------------------------------------------------- time

for (const [note, label] of [['1/4', '1/4'], ['d1/8', 'dotted 1/8'], ['1/8', '1/8'], ['1/16', '1/16'], ['1/4t', '1/4 triplet'], ['1/8t', '1/8 triplet'], ['d1/16', 'dotted 1/16'], ['5/16', '5/16'], ['d1/4', 'dotted 1/4'], ['1/2', '1/2']]) $('note').add(new Option(label, note));
// a preset made for a tempo shows it: the note is where its longest head lands
function showTempo(p) { if (p && p.bpm) { $('bpm').value = p.bpm; $('note').value = p.note; } }
$('settempo').addEventListener('click', run(() => {
  const ms = ed.tempo(Number($('bpm').value), $('note').value);
  toast(`Head 1 at ${ms} ms`);
}));
$('tapsw').addEventListener('click', run(() => ed.set('tap_sw', ed.mem.tap_sw ? 0 : 1)));
$('timemode').addEventListener('click', run(() => ed.set('time_mode', ed.mem.time_mode ? 0 : 1)));
(function blink() {      // the TAP lamp blinks at the tap time
  const on = ed.known && ed.mem.tap_sw && ed.mem.tap_time >= 50;
  if (on) { $('lamp-tap').classList.add('on'); setTimeout(() => $('lamp-tap').classList.remove('on'), 70); }
  setTimeout(blink, on ? ed.mem.tap_time : 300);
})();

// ---------------------------------------------------------------- presets

async function refreshPresets() {
  // the user's presets, then the presets; a pedal with no reverb type per memory leaves out the presets that need one
  const bank = Bank.presets().filter(p => !(ed.reads && !ed.has('reverb_type') && Bank.needsReverbType(p)));
  state.presets = [...await lib.presets(), ...bank];
  fillList();
}
function loadPreset(p) {
  ed.load(p.values);
  // a preset is named for its reverb: on a pedal that plays one type for every memory, set that type
  if (p.fromBank && p.values.reverb_sw && p.values.reverb_vol >= 50 && !ed.perMemoryReverb) ed.setReverbType(p.values.reverb_type);
  $('name').value = p.name; showTempo(p); toast(`Loaded ${p.name}`);
}
const inBank = name => state.presets.some(p => p.fromBank && p.name === name);
// the list of every preset: the user's, then each family of the presets
function fillList() {
  const list = $('plist'); list.innerHTML = '';
  let group = null;
  for (const p of state.presets) {
    const g = p.fromBank ? `${p.family} · ${p.genre} · ${p.rig}` : 'Yours';
    if (g !== group) { group = g; const h = document.createElement('h4'); h.textContent = g; list.append(h); }
    const b = document.createElement('button'); b.textContent = p.name; b.dataset.name = p.name; list.append(b);
  }
}
function showList(on) {
  const list = $('plist');
  list.hidden = !on;
  if (!on) return;
  let now = null;
  for (const b of list.querySelectorAll('button')) { b.classList.toggle('now', b.dataset.name === $('name').value); if (b.classList.contains('now')) now = b; }
  if (now) now.scrollIntoView({ block: 'nearest' }); else list.scrollTop = 0;
}
$('browse').addEventListener('click', e => { e.stopPropagation(); showList($('plist').hidden); });
$('plist').addEventListener('click', run(e => {
  const p = state.presets.find(q => q.name === e.target.dataset.name);
  if (p) { loadPreset(p); showList(false); }
}));
document.addEventListener('click', e => { if (!e.target.closest('#plist')) showList(false); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') showList(false); });
function stepPreset(d) {
  if (!state.presets.length) return toast('No presets saved yet');
  const i = state.presets.findIndex(p => p.name === $('name').value);
  loadPreset(state.presets[(i + d + state.presets.length) % state.presets.length] || state.presets[0]);
}
$('prev').addEventListener('click', run(() => stepPreset(-1)));
$('next').addEventListener('click', run(() => stepPreset(1)));
$('name').addEventListener('change', run(() => { const p = state.presets.find(q => q.name === $('name').value); if (p) loadPreset(p); }));
$('save').addEventListener('click', run(async () => {
  if (inBank($('name').value.trim())) return toast('That preset comes with DUBS: save under another name', true);
  const name = await lib.savePreset($('name').value, { ...ed.mem });
  $('name').value = name;
  await refreshPresets();
  toast(`Saved ${name}${lib.dir ? '' : ' in this browser; choose a library folder on the MIDI tab to keep presets as files'}`);
}));
$('new').addEventListener('click', () => { $('name').value = ''; $('name').focus(); });
$('delete').addEventListener('click', run(async () => {
  const name = $('name').value;
  if (inBank(name)) return toast(`${name} comes with DUBS and stays`);
  if (!state.presets.some(p => p.name === name)) return toast('No preset by that name');
  if (!confirm(`Move the preset "${name}" to the library's Trash?`)) return;
  await lib.trashPreset(name);
  $('name').value = '';
  await refreshPresets();
  toast(`${name} moved to Trash`);
}));

// ---------------------------------------------------------------- drawer: memories

const memBody = document.querySelector('#memtable tbody');
function buildMemories() {
  memBody.innerHTML = '';
  for (let s = 0; s < R.SLOTS; s++) {
    const tr = document.createElement('tr');
    tr.dataset.slot = s;
    tr.innerHTML = `<td>${s ? s : 'MANUAL'}</td><td>${s ? '<input placeholder="name" spellcheck="false">' : ''}</td>`
      + `<td><button data-act="recall">Recall</button> <button data-act="read">Read</button>${s ? ' <button data-act="write">Write here</button>' : ''}</td>`;
    memBody.append(tr);
  }
}
function renderMemories() {
  for (const tr of memBody.children) {
    const s = Number(tr.dataset.slot), input = tr.querySelector('input');
    tr.classList.toggle('now', s === ed.slot);
    if (input && document.activeElement !== input) input.value = names()[s] || '';
    tr.title = state.sums[s] || '';     // a memory's settings, once read, show on hover
    tr.querySelector('[data-act=read]').disabled = !ed.reads;
  }
  $('readall').disabled = !ed.reads; $('loadbank').disabled = !ed.reads;
  // a real pedal with no memory named here yet: Load bank glows as the place to start
  $('loadbank').classList.toggle('start', ed.reads && !onBuiltIn() && !Object.keys(state.names).length);
}
let namesTimer = null;
memBody.addEventListener('input', e => {
  const s = e.target.closest('tr').dataset.slot;
  if (e.target.value) names()[s] = e.target.value; else delete names()[s];
  clearTimeout(namesTimer); namesTimer = setTimeout(run(saveNames), 600);
});
memBody.addEventListener('click', run(async e => {
  const act = e.target.dataset.act;
  if (!act) return;
  const slot = Number(e.target.closest('tr').dataset.slot);
  if (act === 'recall') await ed.recall(slot);
  else if (act === 'read') { state.sums[slot] = summary(await ed.readSlot(slot)); renderMemories(); toast(`${slot ? `Memory ${slot}` : 'MANUAL'}: ${state.sums[slot]}`); }
  else if (act === 'write') await writeHere(slot);
}));
$('readall').addEventListener('click', run(async () => {
  for (let s = 0; s < R.SLOTS; s++) {
    state.sums[s] = summary(await ed.readSlot(s));
    if (s % 8 === 7) { renderMemories(); toast(`Read ${s + 1} of ${R.SLOTS}`); }
  }
  renderMemories(); toast('All memories read');
}));

// the presets into memories 5 to 100, with its names
$('loadbank').addEventListener('click', run(async () => {
  const last = Bank.FIRST_SLOT + 95;
  const entries = bankEntries().filter(e => !(e.needsType && !ed.has('reverb_type')));
  if (!confirm(`Load the presets? This replaces memories 1 to ${last} on the pedal and their names: four spring echoes on 1 to 4 for the MEMORY switch, the 96 presets on ${Bank.FIRST_SLOT} to ${last}. It also sets the pedal to keep a reverb type for each memory and to take a tap time as head 1's. The pedal is backed up first.`)) return;
  await ensureBackup();
  if (!onBuiltIn()) await lib.keepNames(state.names);
  await ed.loadBank(entries, (n, of) => { if (n % 8 === 0 || n === of) toast(`Loading the bank: ${n} of ${of}`); });
  for (let s = 1; s <= last; s++) { delete names()[s]; delete state.sums[s]; }
  for (const e of entries) { names()[e.slot] = e.name; state.sums[e.slot] = summary(e.values); }
  await saveNames();
  renderMemories();
  toast(`Presets loaded into memories 1 to ${last}`);
}));

// ---------------------------------------------------------------- drawer: settings

const RISKY = { rx_ch: 'MIDI Rx Ch', cc_in: 'CC In', pc_in: 'PC In' };
function renderSettings() {
  const grid = $('sysgrid');
  grid.innerHTML = '';
  $('settings-note').textContent = ed.sys ? '' : 'The pedal\'s settings show here once it has been read. Cable its MIDI OUT back to the computer and press Connect and read on the MIDI tab.';
  if (!ed.sys) return;
  for (const p of R.SYSTEM_PARAMS) {
    if (!(p.key in ed.sys)) continue;
    const label = document.createElement('label'), sel = document.createElement('select');
    for (let v = p.lo; v <= p.hi; v++) sel.add(new Option(p.names ? p.names[v] : v, v));
    sel.value = ed.sys[p.key];
    sel.addEventListener('change', run(() => {
      if (RISKY[p.key] && !confirm(`Changing ${RISKY[p.key]} can stop the pedal hearing this editor. Change it?`)) { sel.value = ed.sys[p.key]; return; }
      ed.setSystem(p.key, Number(sel.value));
    }));
    label.append(p.label, sel);
    grid.append(label);
  }
}
const expGrid = $('expgrid');
for (const [key, name] of R.KNOBS) {
  const label = document.createElement('label');
  label.append(name);
  const box = document.createElement('span');
  for (const end of ['min', 'max']) {
    const input = document.createElement('input');
    input.type = 'number'; input.min = 0; input.max = 127; input.dataset.key = `${key}_${end}`; input.title = `${name} at the expression pedal's ${end === 'min' ? 'heel' : 'toe'}`;
    input.addEventListener('change', run(() => ed.set(input.dataset.key, clamp(Number(input.value), 0, 127))));
    box.append(input, ' ');
  }
  label.append(box);
  expGrid.append(label);
}

// ---------------------------------------------------------------- drawer: MIDI

for (let c = 1; c <= 16; c++) $('channel').add(new Option(c, c));
$('channel').addEventListener('change', () => { ed.channel = Number($('channel').value); render(); });
// the ports asked for, by name: picked here, found by Find my pedal, or remembered from the last visit. When one is not
// plugged in the built-in pedal stands in, and the port is taken up again as soon as it appears.
let wanted = (() => { try { return JSON.parse(localStorage.getItem('re202.wanted')) || {}; } catch (e) { return {}; } })();
function want(out, input) {
  wanted = { out, in: input };
  try { localStorage.setItem('re202.wanted', JSON.stringify(wanted)); } catch (e) { /* a convenience */ }
}
const missing = () => onBuiltIn() && wanted.out && wanted.out !== builtIn.output.name ? wanted.out : '';
function fillPorts() {
  for (const [sel, ports, fake, was] of [[$('out'), state.access && state.access.outputs, builtIn.output, wanted.out], [$('in'), state.access && state.access.inputs, builtIn.input, wanted.in]]) {
    sel.length = 0;
    sel.add(new Option('none', ''));
    sel.add(new Option(fake.name, fake.id));
    if (ports) for (const p of ports.values()) sel.add(new Option(p.name, p.id));
    const keep = [...sel.options].find(o => o.text === was);
    sel.value = keep ? keep.value : fake.id;
  }
}
function pick() {
  const o = $('out').value, i = $('in').value;
  const output = o === builtIn.output.id ? builtIn.output : state.access ? state.access.outputs.get(o) : null;
  const input = i === builtIn.input.id ? builtIn.input : state.access ? state.access.inputs.get(i) : null;
  link.use(output, input);
}
async function connect() {
  pick();
  const reads = await ed.connect();
  await refreshPresets();
  $('channel').value = ed.channel;
  state.sums = {};
  if (onBuiltIn() && reads) await ed.recall(Bank.FIRST_SLOT);     // the built-in pedal opens on the first preset
  renderMemories();
  if (!link.output) toast('Pick the MIDI output the pedal is on', true);
  else if (onBuiltIn()) toast(missing() ? `${missing()} is not connected` : 'No pedal connected', !!missing());
  else toast(reads ? `Reading the pedal on ${link.output.name}` : `Sending only on ${link.output.name}: the pedal does not answer. Cable its MIDI OUT back to read it`, !reads);
}
$('connect').addEventListener('click', run(connect));
const chosen = () => { want($('out').selectedOptions[0] ? $('out').selectedOptions[0].text : '', $('in').selectedOptions[0] ? $('in').selectedOptions[0].text : ''); return connect(); };
$('out').addEventListener('change', run(chosen));
$('in').addEventListener('change', run(chosen));

// Find my pedal: ask each output who is there, and connect to the one an RE-202 answers on
async function findPedal() {
  if (!state.access) throw new Error('Chrome has not allowed MIDI here, so only the built-in pedal is available');
  toast('Looking for the pedal');
  const heard = [];
  const ears = [...state.access.inputs.values()].map(input => {
    const fn = e => { if (R.parseIdentity(e.data)) heard.push(input); };
    input.addEventListener('midimessage', fn);
    return [input, fn];
  });
  let found = null;
  try {
    await Promise.all(ears.map(([input]) => input.open().catch(() => {})));
    for (const output of state.access.outputs.values()) {
      heard.length = 0;
      try { await output.open(); output.send(R.IDENTITY_REQUEST); } catch (e) { continue; }
      await sleep(500);
      if (heard.length) { found = { output, input: heard[0] }; break; }
    }
  } finally { for (const [input, fn] of ears) input.removeEventListener('midimessage', fn); }
  if (!found) throw new Error('No RE-202 answered. Check the cable back from the pedal (TRS Type A) and its MIDI settings');
  want(found.output.name, found.input.name);
  fillPorts();
  await connect();
}
for (const b of document.querySelectorAll('.find')) b.addEventListener('click', run(findPedal));

$('backup').addEventListener('click', run(async () => {
  if (!ed.reads) throw new Error('A backup needs the pedal\'s MIDI OUT cabled back to the computer');
  const bytes = await ed.backup((n, of) => toast(`Backing up: ${n} of ${of}`));
  state.backedUp = true;
  toast(`Backup saved: ${await lib.saveBackup(stamp(), bytes)}`);
}));
$('restore').addEventListener('click', () => $('restore-file').click());
$('restore-file').addEventListener('change', run(async () => {
  const file = $('restore-file').files[0];
  $('restore-file').value = '';
  if (!file) return;
  const system = $('restore-system').checked;
  if (!confirm(`Send "${file.name}" to the pedal? This replaces its memories${system ? ' and its system settings' : ''}.`)) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  await ensureBackup();
  const count = await ed.restore(bytes, { system }, (n, of) => toast(`Restoring: ${n} of ${of}`));
  toast(`Restored ${count} blocks from ${file.name}`);
  if (ed.reads) { if (system) await ed.readSystem(); await ed.recall(ed.slot || 0); }
}));

async function openLibrary(ask) {
  if (ask && !lib.dir && !lib.waiting) await lib.choose(); else await lib.reopen(ask);
  $('folder').textContent = lib.waiting ? 'Reopen library folder' : lib.dir ? 'Change library folder' : 'Choose library folder';
  $('folder-note').textContent = lib.dir ? `Presets, backups and memory names are files in "${lib.name}"` : 'Presets and memory names are kept in this browser, and backups download, until a folder is chosen';
  state.names = await lib.names();
  await refreshPresets();
  renderMemories();
}
$('folder').addEventListener('click', run(async () => { if (lib.dir) await lib.choose(); await openLibrary(true); }));

// follow what is moved on the pedal and sends nothing: the Mode Selector, the buttons, a tapped time
setInterval(() => { if (!document.hidden) ed.follow().catch(() => {}); }, 250);

link.onLog = (dir, bytes) => {
  state.log.push(`${dir === 'out' ? '>' : '<'} ${bytes.map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
  if (state.log.length > 300) state.log.shift();
  if ($('tab-midi').classList.contains('on')) $('log').textContent = state.log.join('\n');
};

$('tabs').addEventListener('click', e => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  for (const b of $('tabs').querySelectorAll('button')) b.classList.toggle('on', b === e.target);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('on', t.id === `tab-${tab}`);
  if (tab === 'midi') $('log').textContent = state.log.join('\n');
});
$('clearlog').addEventListener('click', () => { state.log = []; $('log').textContent = ''; });

// ---------------------------------------------------------------- drawing

const lamp = (el, on) => el.classList.toggle('on', !!on);
function render() {
  const m = ed.mem;
  for (const [key, k] of Object.entries(knobs)) { k.el.style.setProperty('--a', `${-150 + m[key] / 127 * 300}deg`); k.out.textContent = m[key]; }
  modeKnob.style.setProperty('--a', `${-137.5 + SEG * m.mode}deg`);
  for (const path of svg.querySelectorAll('path')) path.classList.toggle('on', Number(path.dataset.mode) === m.mode);
  const playing = R.HEADS[m.mode] || [];
  [...$('heads').querySelectorAll('.lamp')].forEach((l, i) => lamp(l, playing.includes(i + 1)));
  for (const l of $('memrow').querySelectorAll('.lamp')) lamp(l, Number(l.dataset.slot) === ed.slot);
  const input = ed.sys ? ed.sys.input : state.input;
  lamp($('in-guitar'), input === 0); lamp($('in-line'), input === 1);
  lamp($('tape-new'), m.tape === 0); lamp($('tape-aged'), m.tape === 1);
  lamp($('lamp-effect'), ed.effect); lamp($('lamp-memory'), m.reverb_sw);
  [...types.querySelectorAll('.lamp')].forEach((l, i) => lamp(l, i === ed.reverbType));

  $('pedal').classList.toggle('unread', !ed.known);
  const where = ed.slot === null ? '' : ed.slot === 0 ? 'MANUAL' : `MEMORY ${ed.slot}`;
  // a memory recalled, from the screen or the pedal, shows its own name in the preset box
  if (ed.slot !== state.shownSlot) { state.shownSlot = ed.slot; if (ed.slot !== null && document.activeElement !== $('name')) { $('name').value = names()[ed.slot] || ''; showTempo(state.presets.find(p => p.fromBank && p.name === $('name').value)); } }
  $('badge').textContent = onBuiltIn() ? 'NO PEDAL' : ed.known ? where || 'pedal' : `${where ? `${where} · ` : ''}not read`;
  $('badge').classList.toggle('off', onBuiltIn() || !ed.known);
  $('badge').title = $('badge').textContent;
  // with no pedal connected the status line says so, and Find my pedal shows at the right of the time row
  warned = !link.output || onBuiltIn();
  $('find').classList.toggle('clear', !warned);
  standing = onBuiltIn() ? `${missing() ? `${missing()} is not connected` : 'No pedal connected'} · nothing is sent to hardware` : link.output ? `${link.output.name} · channel ${ed.channel} · ${ed.reads ? 'reading the pedal' : 'send only'}` : 'no MIDI output'; paintStatus();

  const heads = ed.heads();
  $('lcd').innerHTML = heads.map(h => `<span class="h${h.n}">H${h.n} <b>${h.ms === null ? `×${h.n}` : `${h.ms} ms`}</b></span>`).join('');
  $('tapsw').textContent = m.tap_sw ? 'Tap time' : 'Rate knob'; $('tapsw').classList.toggle('on', !!m.tap_sw);
  $('timemode').textContent = m.time_mode ? 'Long' : 'Normal';
  for (const inputEl of expGrid.querySelectorAll('input')) if (document.activeElement !== inputEl) inputEl.value = m[inputEl.dataset.key];
  for (const tr of memBody.children) tr.classList.toggle('now', Number(tr.dataset.slot) === ed.slot);
}
ed.onChange = what => { render(); if (what === 'system' || what === 'connect') renderSettings(); };

// the pedal is drawn 1000 px wide and scales to its column; the drawer sits under it in a narrow window and beside it in a wide one
function fit() { $('pedal').style.zoom = Math.max(0.4, Math.min(1.7, document.querySelector('.main').clientWidth / 1000)); }
window.addEventListener('resize', fit);
fit();

// ---------------------------------------------------------------- start

(async function start() {
  buildMemories(); renderSettings(); render();
  await run(() => openLibrary(false))();
  try {
    state.access = await navigator.requestMIDIAccess({ sysex: true });
    // a port plugged in or pulled: redraw the lists, and move to the port asked for when it has just appeared or gone
    state.access.onstatechange = () => {
      fillPorts();
      if ($('out').value !== (link.output ? link.output.id : '') || $('in').value !== (link.input ? link.input.id : '')) run(connect)();
    };
  } catch (e) { toast(`Chrome refused MIDI with SysEx (${e.message}). The built-in pedal still works`, true); }
  fillPorts();
  await run(connect)();
})();
