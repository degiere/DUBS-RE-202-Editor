// Copyright (c) 2026, Chris De Giere <https://chrisdegiere.com>
// Licensed under CC BY-NC-SA 4.0. See LICENSE.
'use strict';
// The presets: 96 presets in 12 families of 8, each family the echo of one music that used the Space Echo, and the rule that names them.
// A name is Lead Time Heads Traits. Only the lead word is chosen by hand; nameOf builds the rest from the preset's
// own values, so a name always says what its settings are.
//   Time    the longest playing head's interval: 8d-140 is a dotted 1/8 at 140 bpm, 110ms and 1.4s are free times,
//           R40 is the Repeat Rate knob's value with the tap time off (R40x2 in the LONG time mode)
//   Heads   H1, H13, H1234
//   Traits  Old for aged tape, then at most two more, the ones furthest from the knob's centre
// A plain script: the page gets the global RE202Bank, node gets module.exports.
(function (root) {
  const R = root.RE202 || require('./re202.js');

  const MAX_NAME = 34;
  // The highest Intensity a preset stores. Past about two o'clock the repeats feed themselves into noise, and every
  // playing head feeds back, so more heads get a lower ceiling.
  const CEILING = [0, 78, 72, 66, 60];       // by the number of heads playing
  const ceiling = v => CEILING[R.HEADS[v.mode].length];
  const NOTES = [['16', .25], ['8t', 1 / 3], ['16d', .375], ['8', .5], ['4t', 2 / 3], ['8d', .75], ['4', 1], ['5x16', 1.25]];   // in quarter notes
  const BEATS = Object.fromEntries(NOTES);
  const TEMPO_NOTE = { '16': '1/16', '8t': '1/8t', '16d': 'd1/16', '8': '1/8', '4t': '1/4t', '8d': 'd1/8', '4': '1/4', '5x16': '5/16' };   // the editor's note values
  const REVERB_WORDS = ['Spring', 'Hall', 'Plate', 'Room', 'Ambience'];
  const FAMILIES = ['Throw', 'Steppers', 'Four', 'Crash', 'Brink', 'Chord', 'Slap', 'Drive', 'Chop', 'Trip', 'Swell', 'Wash'];
  // the first six are for a line input (synths, a mixer's send), the rest for guitar; and the music each comes from
  const GENRES = { Throw: 'dub', Steppers: 'dub', Four: 'dub', Crash: 'dub', Brink: 'dub', Chord: 'dub techno', Slap: 'rockabilly', Drive: 'the preamp', Chop: 'reggae', Trip: 'trip hop', Swell: '1990s alternative', Wash: 'long mode' };
  const LINE = FAMILIES.slice(0, 6);

  const longestHead = v => Math.max(...R.HEADS[v.mode]);
  const longestMs = v => v.tap_time * longestHead(v);
  const showMs = ms => ms >= 1000 ? `${Math.round(ms / 100) / 10}s` : `${Math.round(ms)}ms`;

  function timeWord(v, bpm) {
    if (!v.tap_sw) return `R${v.repeat_rate}${v.time_mode ? 'x2' : ''}`;
    const ms = longestMs(v);
    if (bpm) for (const [note, beats] of NOTES) if (Math.abs(60000 / bpm * beats - ms) <= 2.5) return `${note}-${bpm}`;
    return showMs(ms);
  }

  // the trait words a preset has earned, each with how far its value sits from centre
  function traits(v) {
    const out = [], far = x => Math.abs(x - 64) / 64, echoOff = v.echo_vol === 0;
    const add = (word, rank) => out.push({ word, rank });
    if (v.reverb_sw && v.reverb_vol >= 50) {
      const word = v.reverb_type === 0 && v.reverb_vol > 100 && !echoOff ? 'Drip' : REVERB_WORDS[v.reverb_type];
      add(echoOff ? `${word} Only` : word, echoOff ? 2 : v.reverb_vol / 127);
    }
    if (!echoOff) {
      if (v.echo_vol < 45) add('Dry', far(v.echo_vol)); else if (v.echo_vol > 95) add('Wet', far(v.echo_vol));
      if (v.intensity < 25) add('Single', far(v.intensity));
      else if (v.intensity >= ceiling(v)) add('Edge', .6);
      else if (v.intensity >= ceiling(v) - 4) add('Trail', far(v.intensity));
    }
    if (v.treble < 40) add('Dark', far(v.treble)); else if (v.treble > 90) add('Bright', far(v.treble));
    if (v.bass < 35) add('Thin', far(v.bass)); else if (v.bass > 90) add('Fat', far(v.bass));
    if (v.saturation < 25) add('Clean', far(v.saturation)); else if (v.saturation > 90) add('Hot', far(v.saturation));
    if (!echoOff) {
      if (v.wow_flutter < 15) add('Steady', far(v.wow_flutter)); else if (v.wow_flutter > 80) add('Wobble', far(v.wow_flutter));
      if (v.tap_sw) { if (longestMs(v) < 120) add('Tight', .3); else if (longestMs(v) > 700) add('Slow', .3); }
    }
    return out.sort((a, b) => b.rank - a.rank);    // a stable sort: ties stay in the order above
  }

  function nameOf(v, lead, bpm) {
    const words = [lead];
    if (v.echo_vol !== 0) words.push(timeWord(v, bpm), 'H' + R.HEADS[v.mode].join(''));
    const ranked = traits(v), only = ranked.find(t => t.rank === 2);
    if (only) words.push(only.word);
    if (v.tape) words.push('Old');
    let room = 2;
    for (const t of ranked) {
      if (t === only) continue;
      if (!room || [...words, t.word].join(' ').length > MAX_NAME) break;
      words.push(t.word); room--;
    }
    return words.join(' ');
  }

  // ---------------------------------------------------------------- the bank

  // a time: n('8d', 140) puts the longest head on a dotted 1/8 at 140 bpm, ms(110) sets head 1, rate(40) leaves it to the knob
  const n = (note, bpm) => ({ note, bpm });
  const ms = head1 => ({ head1 });
  const rate = value => ({ rate: value });

  function build(family, base, lead, mode, time, over = {}) {
    const v = { ...R.defaultMemory(), ...base, ...over, mode: mode - 1 };
    v.intensity = v.intensity === 127 ? ceiling(v) : Math.min(v.intensity, ceiling(v) - 3);    // 127 in a table asks for the ceiling
    if (time.rate !== undefined) { v.tap_sw = 0; v.repeat_rate = time.rate; }
    else {
      v.tap_sw = 1;
      v.tap_time = Math.round(time.head1 !== undefined ? time.head1 : 60000 / time.bpm * BEATS[time.note] / longestHead(v));
    }
    // the expression pedal: Echo Vol from nothing up to the preset's value; Intensity too in Brink; Repeat Rate alone on a rate preset
    for (const [k] of R.KNOBS) { v[k + '_min'] = v[k]; v[k + '_max'] = v[k]; }
    if (time.rate !== undefined) { v.repeat_rate_min = 0; v.repeat_rate_max = 127; }
    else {
      v.echo_vol_min = 0;
      if (family === 'Brink') v.intensity_min = Math.min(60, v.intensity);
    }
    const bpm = time.bpm || null;
    return { name: nameOf(v, lead, bpm), family, rig: LINE.includes(family) ? 'line' : 'guitar', genre: GENRES[family], lead, bpm, note: bpm ? TEMPO_NOTE[time.note] : null, fromBank: true, values: v };
  }

  const SPR = 0, HALL = 1, PLATE = 2, ROOM = 3, AMB = 4;
  const rev = (type, vol) => ({ reverb_sw: 1, reverb_type: type, reverb_vol: vol });
  const DUB = { tape: 0, intensity: 64, echo_vol: 88, bass: 40, treble: 72, reverb_sw: 1, reverb_type: SPR, reverb_vol: 0, saturation: 50, wow_flutter: 30, time_mode: 0 };

  function families() {
    const out = [];
    const fam = (family, base, rows) => rows.forEach(r => out.push(build(family, { ...DUB, ...base }, ...r)));

    // ---- line: synths, drum machines and a mixer's send. Dub and dub techno.

    // one head, four or five repeats, bass cut
    fam('Throw', {}, [
      ['Throw', 2, n('8d', 140), { treble: 30 }],
      ['Waterhouse', 3, n('4t', 150), { tape: 1, saturation: 100 }],
      ['Throw', 3, n('4', 75), { treble: 100 }],
      ['Throw', 1, n('8d', 150), { bass: 20 }],
      ['Kingston', 2, n('4t', 72), { tape: 1, wow_flutter: 95 }],
      ['Throw', 2, ms(750), { time_mode: 1, intensity: 127, echo_vol: 104 }],
      ['Throw', 1, rate(90), { saturation: 10 }],
      ['Throw', 3, rate(30), { time_mode: 1, tape: 1, treble: 30 }],
    ]);
    // two and three heads on the grid
    fam('Steppers', { intensity: 55, echo_vol: 85, wow_flutter: 50 }, [
      ['Steppers', 7, n('8d', 140), { echo_vol: 106 }],
      ['Steppers', 4, n('8', 140), { intensity: 86 }],
      ['Steppers', 5, n('4', 150), { treble: 30 }],
      ['Gardens', 6, n('8d', 130), { tape: 1, saturation: 96 }],
      ['Steppers', 7, n('4', 140), { treble: 100 }],
      ['Steppers', 4, n('4t', 75), { bass: 20, echo_vol: 40 }],
      ['Kingston', 6, n('8d', 150), { bass: 100 }],
      ['Steppers', 5, n('8d', 126), { intensity: 20 }],
    ]);
    // the fourth head
    fam('Four', { intensity: 58, wow_flutter: 60 }, [
      ['Four', 8, n('4', 140), { echo_vol: 35 }],
      ['Four', 9, n('4', 140), { echo_vol: 110 }],
      ['Four', 10, n('4', 150), { tape: 1, treble: 30 }],
      ['Four', 11, n('4', 130), { intensity: 86 }],
      ['Four', 12, n('4', 140), { saturation: 100 }],
      ['Gardens', 12, n('4', 80), { tape: 1, wow_flutter: 92 }],
      ['Four', 9, ms(450), { time_mode: 1, treble: 100 }],
      ['Four', 10, n('4', 126), { bass: 20, echo_vol: 35 }],
    ]);
    // spring forward
    fam('Crash', { intensity: 60 }, [
      ['Crash', 6, n('8d', 140), { tape: 1, ...rev(SPR, 110) }],
      ['Crash', 6, n('8d', 150), { ...rev(SPR, 96), bass: 100 }],
      ['Crash', 1, n('16d', 140), { ...rev(SPR, 120), intensity: 20 }],
      ['Crash', 7, n('8d', 130), { tape: 1, wow_flutter: 90, ...rev(SPR, 100) }],
      ['Crash', 2, n('8d', 140), { ...rev(SPR, 127), echo_vol: 40 }],
      ['Crash', 4, n('8', 140), { ...rev(SPR, 96), treble: 104 }],
      ['Crash', 5, n('4t', 75), { ...rev(SPR, 96), treble: 30 }],
      ['Waterhouse', 3, n('4', 75), { tape: 1, ...rev(SPR, 115) }],
    ]);
    // Intensity at its ceiling: the longest trails the bank stores
    fam('Brink', { intensity: 127, echo_vol: 80 }, [
      ['Brink', 1, n('8', 140), {}],
      ['Brink', 8, n('4', 150), { tape: 1 }],
      ['Brink', 6, n('8d', 140), {}],
      ['Brink', 7, n('8d', 126), { tape: 1 }],
      ['Brink', 12, n('4', 140), { treble: 30 }],
      ['Waterhouse', 10, n('4', 130), { tape: 1 }],
      ['Brink', 3, n('4t', 150), { saturation: 104 }],
      ['Kingston', 4, n('8', 150), { tape: 1, wow_flutter: 90 }],
    ]);
    // dub techno: dark, old, long trails under a chord
    fam('Chord', { tape: 1, intensity: 88, echo_vol: 85, bass: 36, treble: 30, saturation: 80 }, [
      ['Chord', 2, n('8d', 122), { saturation: 60 }],
      ['Detroit', 3, n('5x16', 124), {}],
      ['Chord', 6, n('8d', 126), { saturation: 110 }],
      ['Chord', 2, n('8d', 130), { ...rev(HALL, 80) }],
      ['Detroit', 5, n('5x16', 128), { saturation: 100 }],
      ['Chord', 1, n('8d', 145), { ...rev(AMB, 70) }],
      ['Detroit', 11, ms(450), { time_mode: 1, saturation: 30, wow_flutter: 70 }],
      ['Chord', 4, ms(700), { time_mode: 1, saturation: 120, ...rev(HALL, 100) }],
    ]);

    // ---- guitar: the echo set against the dry signal

    // slapback as rockabilly players keep a Space Echo for: one bright repeat, bass cut, a little reverb
    fam('Slap', { intensity: 15, echo_vol: 70, bass: 44, treble: 92, saturation: 30, wow_flutter: 20 }, [
      ['Slap', 1, ms(110), { echo_vol: 44 }],
      ['Slap', 1, ms(85), { tape: 1, saturation: 100 }],
      ['Slap', 1, ms(140), { intensity: 36, ...rev(SPR, 60) }],
      ['Slap', 1, ms(95), { ...rev(SPR, 90) }],
      ['Slap', 1, ms(125), { tape: 1, intensity: 30, bass: 70, ...rev(ROOM, 80) }],
      ['Slap', 4, ms(65), { intensity: 25, ...rev(SPR, 70) }],
      ['Slap', 2, ms(60), { echo_vol: 100, saturation: 96 }],
      ['Slap', 1, ms(170), { intensity: 45, treble: 64, ...rev(PLATE, 70) }],
    ]);
    // the machine as a preamp, echo off or barely on
    fam('Drive', { intensity: 0, echo_vol: 0, bass: 64, treble: 64, reverb_sw: 0, wow_flutter: 20 }, [
      ['Drive', 1, ms(100), { saturation: 127, treble: 100 }],
      ['Drive', 1, ms(100), { tape: 1, saturation: 127, treble: 30 }],
      ['Gardens', 1, ms(100), { saturation: 100, bass: 100, ...rev(SPR, 90) }],
      ['Drive', 1, ms(100), { saturation: 90, bass: 110, ...rev(ROOM, 70) }],
      ['Drive', 2, ms(90), { tape: 1, echo_vol: 50, intensity: 20, saturation: 110 }],
      ['Gardens', 1, ms(100), { tape: 1, saturation: 110, ...rev(SPR, 120) }],
      ['Drive', 1, ms(60), { echo_vol: 40, intensity: 10, saturation: 120 }],
      ['Drive', 1, ms(100), { saturation: 127, bass: 104 }],
    ]);
    // reggae rhythm guitar: the offbeat chop into the spring, then a short echo on the grid
    fam('Chop', { intensity: 35, echo_vol: 60, bass: 40, treble: 84, ...rev(SPR, 70) }, [
      ['Chop', 1, n('8', 140), {}],
      ['Gardens', 2, n('8d', 140), { tape: 1 }],
      ['Chop', 4, n('8', 150), { ...rev(SPR, 110) }],
      ['Kingston', 3, n('4t', 146), { saturation: 100 }],
      ['Chop', 1, n('16d', 140), { intensity: 15, echo_vol: 90 }],
      ['Chop', 6, n('8d', 130), { treble: 40 }],
      ['Gardens', 5, n('4', 150), { tape: 1, wow_flutter: 90, ...rev(SPR, 100) }],
      ['Chop', 2, n('4', 72), { intensity: 127, echo_vol: 50 }],
    ]);
    // trip hop: worn tape at 70 to 90 bpm, dark, hot and wobbling
    fam('Trip', { tape: 1, intensity: 50, echo_vol: 80, bass: 88, treble: 30, saturation: 100, wow_flutter: 90 }, [
      ['Bristol', 2, n('8d', 80), {}],
      ['Trip', 3, n('4', 85), { ...rev(SPR, 80) }],
      ['Trip', 1, ms(1700), { time_mode: 1, saturation: 127, bass: 104 }],
      ['Bristol', 6, n('4', 90), { wow_flutter: 120, ...rev(ROOM, 80) }],
      ['Trip', 2, ms(800), { time_mode: 1, intensity: 70, ...rev(PLATE, 90) }],
      ['Bristol', 8, n('4', 76), { echo_vol: 50, ...rev(SPR, 100) }],
      ['Trip', 11, n('4', 80), { tape: 0, echo_vol: 36, treble: 56, saturation: 40, wow_flutter: 40 }],
      ['Trip', 9, ms(480), { time_mode: 1, intensity: 127, ...rev(ROOM, 90) }],
    ]);
    // 1990s alternative: the feedback ridden at its ceiling and the Repeat Rate knob played from the expression pedal
    fam('Swell', { intensity: 127, echo_vol: 70, bass: 56, treble: 70, saturation: 60, wow_flutter: 50 }, [
      ['Swell', 1, rate(64), {}],
      ['Oxford', 12, rate(40), {}],
      ['Swell', 8, rate(30), { time_mode: 1, tape: 1, ...rev(AMB, 90) }],
      ['Oxford', 3, rate(90), { saturation: 110 }],
      ['Swell', 3, ms(160), { ...rev(SPR, 80) }],
      ['Oxford', 10, ms(450), { time_mode: 1, ...rev(HALL, 90) }],
      ['Swell', 3, ms(600), { time_mode: 1, intensity: 60, treble: 30, saturation: 100 }],
      ['Oxford', 2, n('8d', 120), { tape: 1, intensity: 50, wow_flutter: 104 }],
    ]);
    // the LONG time mode: 1 to 2 s, treble and bass rolled off, into the reverbs the RE-202 adds
    fam('Wash', { time_mode: 1, intensity: 60, echo_vol: 80, bass: 36, treble: 36, saturation: 60, wow_flutter: 60 }, [
      ['Wash', 1, ms(1000), { ...rev(HALL, 100) }],
      ['Wash', 2, ms(700), { tape: 1, wow_flutter: 112, ...rev(AMB, 100) }],
      ['Wash', 3, ms(600), { saturation: 110, ...rev(PLATE, 100) }],
      ['Wash', 9, ms(500), { tape: 1, treble: 60, ...rev(HALL, 115) }],
      ['Wash', 6, ms(500), { bass: 70, ...rev(SPR, 100) }],
      ['Wash', 1, ms(2000), { intensity: 127, ...rev(HALL, 80) }],
      ['Wash', 11, ms(480), { echo_vol: 50, ...rev(AMB, 110) }],
      ['Wash', 4, ms(900), { intensity: 30, ...rev(PLATE, 90) }],
    ]);
    return out;
  }

  let made = null;
  const presets = () => (made || (made = families())).map(p => ({ ...p, values: { ...p.values } }));
  // the four for the pedal's own MEMORY switch, memories 1 to 4: tape echo with spring reverb, as unlike each other as the bank gets
  const FOOT = ['Crash 8d-140 H13 Old Drip', 'Crash 4t-75 H23 Spring Dark', 'Slap 95ms H1 Single Spring', 'Wash 1.5s H13 Spring Dark'];
  const foot = () => FOOT.map(name => presets().find(p => p.name === name));
  // true when a preset needs the reverb type each memory keeps from system Ver. 1.10 on
  const needsReverbType = p => p.values.reverb_sw === 1 && p.values.reverb_vol >= 50 && p.values.reverb_type !== 0;

  const api = { MAX_NAME, CEILING, ceiling, NOTES, FAMILIES, GENRES, LINE, FIRST_SLOT: 5, presets, foot, nameOf, traits, timeWord, longestMs, needsReverbType };
  root.RE202Bank = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
