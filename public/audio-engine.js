// audio-engine.js — Worldsong's generative music engine (Web Audio API).
//
// Given a "genome" (one arm per musical dimension) and a seed, it composes a
// full ~2-3 minute piece with structure (intro, themes, variation, a bridge,
// an outro) that then loops — like a RuneScape area theme — entirely in the
// browser, no samples or external libs. The seed makes the composition
// deterministic, so two listeners in the same zone hear the same music.
//
// House aesthetic = calm medieval/fantasy: flute & recorder, harp, pizzicato
// strings, soft bells/glockenspiel, warm pads, light hand percussion, lush
// reverb, mid tempos. The older aggressive bass-music voices remain as arms a
// zone can still drift toward, but the style prior (bandit.js) leans fantasy.

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  harmonic_minor: [0, 2, 3, 5, 7, 8, 11],
};
const ROOT_MIDI = { C: 60, D: 62, Eb: 63, E: 64, F: 65, G: 67, A: 69, Bb: 70 };

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Drum patterns over a 16-step bar. Each entry: which 16th-steps fire.
// `soft: true` = light hand percussion (woody kick, gentle shaker/clap).
// `hard: true` = the aggressive bass-music kits (harder kick/snare).
const DRUMS = {
  none: { kick: [], hat: [], snare: [] },
  soft_kick: { kick: [0, 8], hat: [4, 12], snare: [], soft: true },
  four_floor: { kick: [0, 4, 8, 12], hat: [2, 6, 10, 14], snare: [4, 12] },
  downtempo: { kick: [0, 10], hat: [4, 7, 12, 14], snare: [8] },
  trip_hop: { kick: [0, 10], hat: [2, 6, 9, 12, 14], snare: [8] },
  // Light, organic hand percussion for the fantasy palette.
  hand_drum: { kick: [0, 6, 8, 14], snare: [], hat: [4, 12], soft: true },
  tambourine: { kick: [0, 8], snare: [], hat: [2, 4, 6, 10, 12, 14], soft: true },
  light_perc: { kick: [0, 8], snare: [4, 12], hat: [2, 6, 10, 14], soft: true },
  // Hard, fast bass-music kits.
  dnb: { kick: [0, 10], snare: [4, 12], hat: [0, 2, 4, 6, 8, 10, 12, 14], hard: true },
  breakbeat: { kick: [0, 6, 10], snare: [4, 12], hat: [2, 3, 7, 9, 11, 14, 15], hard: true },
  half_time: { kick: [0, 7], snare: [8], hat: [0, 2, 4, 6, 8, 10, 12, 14], hard: true },
};

// Soft-clip waveshaper curve. Higher k = more grit/saturation. Reused across
// voices (the same Float32Array can back many WaveShaperNodes) so distorted
// bass and screeching leads cost no per-note allocation.
function makeDistCurve(k) {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / n - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

export class WorldsongEngine {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.genome = null;
    this.seed = 1;
    this.analyser = null;
    this._timer = null;
    this._pos = 0;          // absolute 16th-note position within the composition
    this._comp = null;      // the built composition (array of bars)
    this._compSteps = 0;    // total 16th steps in the loop
    this._bpm = 96;
    this._nextTime = 0;
    this.onStep = null;     // optional callback(stepWithinBar) for visuals
  }

  async ensureCtx() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this._buildGraph();
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  _buildGraph() {
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;

    this.bright = ctx.createBiquadFilter();
    this.bright.type = 'lowpass';
    this.bright.frequency.value = 2500;
    this.bright.Q.value = 0.7;

    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    this.wet.gain.value = 0.25;
    this.conv = ctx.createConvolver();
    this.conv.buffer = this._impulse(1.6, 2.5);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.8;

    // Gentle output limiter: most fantasy material sits well below it, but the
    // aggressive arms (if a zone drifts there) still stack up, so we tame peaks.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 12;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.18;

    // melodic bus -> brightness filter -> dry + reverb -> master -> limiter -> analyser -> out
    this.bus = ctx.createGain();
    this.bus.connect(this.bright);
    this.bright.connect(this.dry);
    this.dry.connect(this.master);
    this.bright.connect(this.conv);
    this.conv.connect(this.wet);
    this.wet.connect(this.master);

    this.master.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);

    // Precomputed saturation curves, shared by every distorted voice.
    this._curves = {
      reese: makeDistCurve(14),
      bass: makeDistCurve(22),
      growl: makeDistCurve(20),
      saw: makeDistCurve(16),
      screech: makeDistCurve(30),
      stab: makeDistCurve(10),
    };

    this.noise = this._noiseBuffer();
  }

  _noiseBuffer() {
    const ctx = this.ctx;
    const buf = ctx.createBuffer(1, ctx.sampleRate * 1, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  _impulse(seconds, decay) {
    const ctx = this.ctx;
    const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  load(genome, seed) {
    this.genome = genome;
    this.seed = (seed >>> 0) || 1;
    this._buildComposition();
    if (this.ctx) this._applyGenome();
  }

  _applyGenome() {
    const g = this.genome;
    const ctx = this.ctx;
    const now = ctx.currentTime;
    // brightness -> master lowpass cutoff
    const cut = { dark: 700, neutral: 2600, bright: 8000 }[g.brightness] ?? 2600;
    this.bright.frequency.setTargetAtTime(cut, now, 0.3);
    // reverb size + wet
    const rev = {
      dry: { s: 0.3, d: 3, wet: 0.0 },
      room: { s: 0.9, d: 2.5, wet: 0.18 },
      hall: { s: 2.2, d: 2.2, wet: 0.32 },
      cathedral: { s: 4.0, d: 1.8, wet: 0.5 },
    }[g.reverb] || { s: 1.0, d: 2.2, wet: 0.2 };
    this.conv.buffer = this._impulse(rev.s, rev.d);
    this.wet.gain.setTargetAtTime(rev.wet, now, 0.2);
  }

  async start() {
    await this.ensureCtx();
    this._applyGenome();
    if (this.playing) return;
    this.playing = true;
    const ctx = this.ctx;
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.setValueAtTime(Math.max(0.0001, this.master.gain.value), ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.85, ctx.currentTime + 1.2);
    if (!this._comp) this._buildComposition();
    this._pos = 0;
    this._nextTime = ctx.currentTime + 0.12;
    this._timer = setInterval(() => this._scheduler(), 25);
  }

  stop() {
    if (!this.playing) return;
    this.playing = false;
    clearInterval(this._timer);
    this._timer = null;
    if (this.ctx) {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setValueAtTime(this.master.gain.value, t);
      this.master.gain.linearRampToValueAtTime(0, t + 0.4);
    }
  }

  // Recompose for a brand-new track without tearing down the context.
  swap(genome, seed) {
    this.load(genome, seed);
    if (this.ctx) {
      this._pos = 0;
      this._applyGenome();
    }
  }

  // Smoothly cross-fade into a new zone's track while audio keeps playing:
  // dip the master gain, swap the genome at the quietest point, then rise again.
  // Falls back to a plain swap if we're not currently playing.
  transition(genome, seed) {
    if (!this.ctx || !this.playing) {
      this.swap(genome, seed);
      return;
    }
    const g = this.master.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(Math.max(0.0001, g.value), t);
    g.linearRampToValueAtTime(0.04, t + 0.45);
    clearTimeout(this._transTimer);
    this._transTimer = setTimeout(() => {
      this.swap(genome, seed);
      const t2 = this.ctx.currentTime;
      const g2 = this.master.gain;
      g2.cancelScheduledValues(t2);
      g2.setValueAtTime(0.04, t2);
      g2.linearRampToValueAtTime(0.85, t2 + 0.95);
    }, 460);
  }

  _scaleNote(degree) {
    const g = this.genome;
    const sc = SCALES[g.scale] || SCALES.minor;
    const base = ROOT_MIDI[g.root] ?? 60;
    const oct = Math.floor(degree / sc.length);
    const idx = ((degree % sc.length) + sc.length) % sc.length;
    return base + sc[idx] + 12 * oct;
  }

  // ---------------------------------------------------------------------------
  // Composition. Instead of looping a single 4-bar phrase forever, we build a
  // full piece up-front from the seed: a main theme (A), a contrasting theme
  // (B), and a form that states them, varies them with ornamentation, drops to
  // a sparse bridge, and resolves — ~2-3 minutes that then loops seamlessly.
  // The whole melody is pregenerated as note events so it's a real, repeatable,
  // hummable tune (not a fresh random arpeggio each bar), and so the loop point
  // is identical every time round.
  // ---------------------------------------------------------------------------
  _buildComposition() {
    const rng = mulberry32((this.seed ^ 0x9e3779b9) >>> 0);
    const clampDeg = (d) => Math.max(0, Math.min(9, d));
    const nearestDeg = (cur, tones) => {
      let best = tones[0], bd = Infinity;
      for (const t of tones) { const dd = Math.abs(t - cur); if (dd < bd) { bd = dd; best = t; } }
      return clampDeg(best);
    };

    // Chord progressions as scale-degree roots (diatonic, pleasant cadences).
    const PROGS = [
      [0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 4],
      [5, 3, 0, 4], [0, 2, 5, 4], [0, 4, 1, 5],
    ];
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const progA = pick(PROGS);
    let progB = pick(PROGS);
    if (progB === progA) progB = PROGS[(PROGS.indexOf(progA) + 3) % PROGS.length];

    // Melodic rhythms over a 16-step bar (which steps a note can land on).
    const RHYTHMS = [
      [0, 4, 8, 12],
      [0, 4, 6, 8, 12],
      [0, 3, 6, 8, 12, 14],
      [0, 4, 8, 10, 12],
      [0, 2, 4, 8, 12],
    ];

    // Generate an 8-bar singable phrase against a 4-chord progression. Strong
    // beats snap to chord tones; weaker beats step gently through the scale;
    // the final bar resolves to the tonic so the loop feels complete.
    const genTheme = (prog, rhythmIdx, startDeg) => {
      const bars = [];
      let deg = startDeg;
      for (let b = 0; b < 8; b++) {
        const chord = prog[b % prog.length];
        const rhythm = RHYTHMS[rhythmIdx % RHYTHMS.length];
        const notes = [];
        for (let i = 0; i < rhythm.length; i++) {
          const step = rhythm[i];
          const strong = step === 0 || step === 8 || i === 0;
          if (strong) {
            deg = nearestDeg(deg, [chord, chord + 2, chord + 4]);
          } else {
            const moves = [-2, -1, -1, 0, 1, 1, 2];
            deg = clampDeg(deg + moves[Math.floor(rng() * moves.length)]);
          }
          notes.push({ step, deg });
        }
        if (b === 7 && notes.length) notes[notes.length - 1].deg = prog[0]; // cadence
        bars.push(notes);
      }
      return bars;
    };

    // Variation: weave passing notes between wider melodic leaps.
    const ornament = (theme) => theme.map((bar) => {
      const out = [];
      for (let i = 0; i < bar.length; i++) {
        out.push(bar[i]);
        const next = bar[i + 1];
        if (next && next.step - bar[i].step >= 3 && rng() < 0.5) {
          out.push({
            step: bar[i].step + Math.floor((next.step - bar[i].step) / 2),
            deg: clampDeg(bar[i].deg + (next.deg >= bar[i].deg ? 1 : -1)),
          });
        }
      }
      return out;
    });

    const slice = (theme, start, count) => theme.slice(start, start + count);

    const themeA = genTheme(progA, Math.floor(rng() * RHYTHMS.length), 4);
    const themeB = genTheme(progB, Math.floor(rng() * RHYTHMS.length), 5);

    // The form: intro · A · A(ornamented) · B · A · bridge · B(ornamented) · A(ornamented) · outro.
    // Sparse sections (intro/bridge/outro) drop the drums and use a sparkling
    // override instrument (harp / glockenspiel) so the piece breathes.
    const sections = [
      { theme: slice(themeA, 0, 4), prog: progA, drums: false, octave: 0,  lead: 'harp',         pad: true, soft: true },
      { theme: themeA,              prog: progA, drums: true,  octave: 0,  lead: null,           pad: true, soft: false },
      { theme: ornament(themeA),    prog: progA, drums: true,  octave: 0,  lead: null,           pad: true, soft: false },
      { theme: themeB,              prog: progB, drums: true,  octave: 0,  lead: null,           pad: true, soft: false },
      { theme: themeA,              prog: progA, drums: true,  octave: 0,  lead: null,           pad: true, soft: false },
      { theme: slice(themeB, 0, 4), prog: progB, drums: false, octave: 12, lead: 'glockenspiel', pad: true, soft: true },
      { theme: ornament(themeB),    prog: progB, drums: true,  octave: 0,  lead: null,           pad: true, soft: false },
      { theme: ornament(themeA),    prog: progA, drums: true,  octave: 0,  lead: null,           pad: true, soft: false },
      { theme: slice(themeA, 0, 4), prog: progA, drums: false, octave: 0,  lead: 'harp',         pad: true, soft: true },
    ];

    const flat = [];
    for (const sec of sections) {
      for (let b = 0; b < sec.theme.length; b++) {
        flat.push({
          chord: sec.prog[b % sec.prog.length],
          notes: sec.theme[b],
          drums: sec.drums,
          octave: sec.octave,
          lead: sec.lead,
          pad: sec.pad,
          soft: sec.soft,
        });
      }
    }
    this._comp = flat;        // 60 bars
    this._compSteps = flat.length * 16;
  }

  _scheduler() {
    const ctx = this.ctx;
    const bpm = parseInt(this.genome.tempo, 10) || 96;
    this._bpm = bpm; // voices read this to tempo-sync the wobble LFO
    const stepDur = (60 / bpm) / 4; // 16th note
    if (!this._comp) this._buildComposition();
    while (this._nextTime < ctx.currentTime + 0.14) {
      this._playStep(this._pos, this._nextTime, stepDur);
      if (this.onStep) try { this.onStep(this._pos % 16); } catch {}
      this._nextTime += stepDur;
      this._pos++;
      if (this._pos >= this._compSteps) this._pos = 0; // loop the whole piece
    }
  }

  _playStep(pos, time, stepDur) {
    const g = this.genome;
    if (!this._comp || !this._comp.length) return;
    const bar = this._comp[Math.floor(pos / 16) % this._comp.length];
    const s = pos % 16;
    const chordDeg = bar.chord;

    // ---- pad: sustain a chord across the bar ----
    if (s === 0 && g.pad !== 'none' && bar.pad) {
      const chord = [chordDeg, chordDeg + 2, chordDeg + 4].map((d) => this._scaleNote(d));
      this._pad(chord, time, stepDur * 16 * 1.05);
    }

    // ---- drums (only in the sections that carry them) ----
    const pat = DRUMS[g.drums] || DRUMS.none;
    if (bar.drums) {
      const hard = !!pat.hard;
      const soft = !!pat.soft;
      if (pat.kick.includes(s)) this._kick(time, hard, soft);
      if (pat.hat.includes(s)) this._hat(time, soft);
      if (pat.snare.includes(s)) this._snare(time, hard, soft);
    }

    // ---- bass: on the kick beats while drumming, else a gentle root per bar ----
    if (g.bass !== 'none') {
      const beats = bar.drums && pat.kick.length ? pat.kick : [0];
      if (beats.includes(s)) {
        const note = this._scaleNote(chordDeg) - 24; // two octaves down
        const aggressive = g.bass === 'wobble_bass' || g.bass === 'growl_bass' || g.bass === 'reese_bass';
        // Aggressive basses sustain longer so the LFO has room to wobble/growl;
        // gentle basses are shorter so they don't muddy the melody.
        const mult = aggressive ? 6 : g.bass === 'sub' ? 4 : 3;
        this._bass(note, time, stepDur * mult);
      }
    }

    // ---- lead: play the pregenerated melodic line for this bar ----
    if (g.lead !== 'none') {
      const inst = bar.lead || g.lead;
      for (const no of bar.notes) {
        if (no.step === s) {
          const midi = this._scaleNote(no.deg) + 12 + bar.octave; // lead register
          const dur = stepDur * (bar.soft ? 3.2 : 2.0);
          this._lead(mtof(midi), time, dur, inst);
        }
      }
    }
  }

  // ---------------- voices ----------------

  _env(g, time, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + a);
    g.gain.exponentialRampToValueAtTime(0.0008, time + dur);
  }

  _lead(freq, time, dur, inst) {
    const ctx = this.ctx;
    const lead = inst || this.genome.lead;

    // ---- aggressive saw leads: a detuned stack through a waveshaper, into the
    // bright bus. super_saw = wide screaming chord-of-one-note; screech adds a
    // resonant bandpass + a quick upward pitch bite (the classic squeal).
    if (lead === 'super_saw' || lead === 'screech') {
      const g = ctx.createGain();
      this._env(g, time, 0.008, 0.2, dur);
      const shaper = ctx.createWaveShaper();
      shaper.curve = lead === 'screech' ? this._curves.screech : this._curves.saw;
      shaper.oversample = '2x';
      const tone = ctx.createBiquadFilter();
      tone.type = lead === 'screech' ? 'bandpass' : 'lowpass';
      tone.frequency.value = lead === 'screech' ? Math.min(freq * 3, 9000) : 3500;
      tone.Q.value = lead === 'screech' ? 6 : 1;
      for (const det of [-16, 0, 16]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = freq;
        o.detune.value = det;
        if (lead === 'screech') {
          o.frequency.setValueAtTime(freq * 0.92, time);
          o.frequency.linearRampToValueAtTime(freq, time + Math.min(0.12, dur));
        }
        o.connect(shaper);
        o.start(time); o.stop(time + dur + 0.1);
      }
      shaper.connect(tone).connect(g).connect(this.bus);
      return;
    }

    // ---- flute / recorder: breathy sustained wind with gentle vibrato ----
    if (lead === 'flute' || lead === 'recorder') {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.linearRampToValueAtTime(0.2, time + 0.05);
      g.gain.setValueAtTime(0.2, time + dur * 0.6);
      g.gain.exponentialRampToValueAtTime(0.0008, time + dur);
      const o = ctx.createOscillator();
      o.type = lead === 'recorder' ? 'triangle' : 'sine';
      o.frequency.value = freq;
      const vib = ctx.createOscillator();
      const vg = ctx.createGain();
      vib.type = 'sine'; vib.frequency.value = 5; vg.gain.value = freq * 0.006;
      vib.connect(vg).connect(o.frequency);
      vib.start(time); vib.stop(time + dur + 0.1);
      if (lead === 'flute') {
        // a whisper of breath gives the flute its air
        const br = ctx.createBufferSource();
        br.buffer = this.noise;
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass'; bp.frequency.value = Math.min(freq * 2, 6000); bp.Q.value = 1;
        const bg = ctx.createGain(); bg.gain.value = 0.012;
        br.connect(bp).connect(bg).connect(this.bus);
        br.start(time); br.stop(time + dur);
      }
      o.connect(g).connect(this.bus);
      o.start(time); o.stop(time + dur + 0.1);
      return;
    }

    // ---- harp / pizzicato: plucked strings ----
    if (lead === 'harp' || lead === 'pizzicato') {
      const g = ctx.createGain();
      const peak = lead === 'harp' ? 0.26 : 0.22;
      const dec = lead === 'harp' ? Math.min(dur, 0.9) : 0.2;
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(peak, time + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0006, time + dec);
      const o = ctx.createOscillator();
      o.type = lead === 'harp' ? 'triangle' : 'sawtooth';
      o.frequency.value = freq;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lead === 'harp' ? 3500 : 2200;
      lp.Q.value = lead === 'pizzicato' ? 2 : 0.7;
      o.connect(lp).connect(g).connect(this.bus);
      o.start(time); o.stop(time + dec + 0.1);
      return;
    }

    // ---- glockenspiel: a bright, shimmering bell (inharmonic partials) ----
    if (lead === 'glockenspiel') {
      const g = ctx.createGain();
      const dec = Math.min(dur, 1.0);
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.22, time + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0006, time + dec);
      for (const [mult, amp] of [[1, 1], [3.01, 0.4], [5.4, 0.18]]) {
        const o = ctx.createOscillator();
        const og = ctx.createGain();
        o.type = 'sine'; o.frequency.value = freq * mult; og.gain.value = amp;
        o.connect(og).connect(g);
        o.start(time); o.stop(time + dec + 0.1);
      }
      g.connect(this.bus);
      return;
    }

    // ---- bells + simple oscillator leads ----
    const g = ctx.createGain();
    const o = ctx.createOscillator();
    if (lead === 'bell' || lead === 'fm_bell') {
      o.type = 'sine';
      const mod = ctx.createOscillator();
      const mg = ctx.createGain();
      mod.type = 'sine';
      mod.frequency.value = freq * (lead === 'fm_bell' ? 3.5 : 2.0);
      mg.gain.value = freq * (lead === 'fm_bell' ? 4 : 2.5);
      mod.connect(mg).connect(o.frequency);
      mod.start(time); mod.stop(time + dur + 0.3);
    } else {
      o.type = { sine_pluck: 'sine', triangle_lead: 'triangle', saw_lead: 'sawtooth', square_arp: 'square' }[lead] || 'triangle';
    }
    o.frequency.value = freq;
    this._env(g, time, 0.012, 0.26, dur);
    o.connect(g).connect(this.bus);
    o.start(time); o.stop(time + dur + 0.1);
  }

  _pad(midis, time, dur) {
    const ctx = this.ctx;

    // ---- stab: a short, distorted saw chord accent (not a sustained pad) ----
    if (this.genome.pad === 'stab') {
      const stabDur = Math.min(dur, 0.18);
      const shaper = ctx.createWaveShaper();
      shaper.curve = this._curves.stab; shaper.oversample = '2x';
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 2600; lp.Q.value = 2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, time);
      g.gain.exponentialRampToValueAtTime(0.16, time + 0.006);
      g.gain.exponentialRampToValueAtTime(0.001, time + stabDur);
      for (const m of midis) {
        for (const det of [-7, 7]) {
          const o = ctx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.value = mtof(m);
          o.detune.value = det;
          o.connect(lp);
          o.start(time); o.stop(time + stabDur + 0.05);
        }
      }
      lp.connect(shaper).connect(g).connect(this.bus);
      return;
    }

    const padType = { warm_pad: 'sawtooth', glass_pad: 'triangle', strings: 'sawtooth', choir: 'sine' }[this.genome.pad] || 'sawtooth';
    for (const m of midis) {
      for (const det of [-5, 5]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = padType;
        o.frequency.value = mtof(m);
        o.detune.value = det;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1800;
        g.gain.setValueAtTime(0.0001, time);
        g.gain.linearRampToValueAtTime(0.09, time + dur * 0.4);
        g.gain.linearRampToValueAtTime(0.0001, time + dur);
        o.connect(lp).connect(g).connect(this.bus);
        o.start(time); o.stop(time + dur + 0.05);
      }
    }
  }

  _bass(midi, time, dur) {
    const ctx = this.ctx;
    const kind = this.genome.bass;
    const f0 = mtof(midi);
    const g = ctx.createGain();
    this._env(g, time, 0.02, 0.34, dur);

    // ---- aggressive bass family: detuned saws -> resonant lowpass swept by an
    // LFO (the "wub"/"growl") -> waveshaper grit. The DnB/Skrillex core.
    if (kind === 'wobble_bass' || kind === 'growl_bass' || kind === 'reese_bass') {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = kind === 'reese_bass' ? 6 : 11;
      lp.frequency.value = kind === 'reese_bass' ? 900 : 240;

      const beat = 60 / (this._bpm || 150);
      const cyclesPerBeat = kind === 'wobble_bass' ? 1 : kind === 'growl_bass' ? 3 : 0;
      if (cyclesPerBeat > 0) {
        const lfo = ctx.createOscillator();
        const ld = ctx.createGain();
        lfo.type = 'sine';
        lfo.frequency.value = cyclesPerBeat / beat;
        ld.gain.value = kind === 'growl_bass' ? 1100 : 1500;
        lfo.connect(ld).connect(lp.frequency);
        lfo.start(time); lfo.stop(time + dur + 0.05);
      }

      const shaper = ctx.createWaveShaper();
      shaper.curve = kind === 'reese_bass' ? this._curves.reese
        : kind === 'growl_bass' ? this._curves.growl : this._curves.bass;
      shaper.oversample = '2x';

      const dets = kind === 'reese_bass' ? [-14, -7, 7, 14] : [-8, 8];
      for (const det of dets) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f0;
        o.detune.value = det;
        o.connect(lp);
        o.start(time); o.stop(time + dur + 0.05);
      }

      const sub = ctx.createOscillator();
      const subg = ctx.createGain();
      sub.type = 'sine'; sub.frequency.value = f0 / 2; subg.gain.value = 0.6;
      sub.connect(subg).connect(g);
      sub.start(time); sub.stop(time + dur + 0.05);

      lp.connect(shaper).connect(g).connect(this.master);
      return;
    }

    // ---- clean basses: sub sine, saw, pulse, or a soft plucked finger-bass ----
    const type = { sub: 'sine', saw_bass: 'sawtooth', pulse_bass: 'square', pluck_bass: 'triangle' }[kind] || 'sine';
    const o = ctx.createOscillator();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = kind === 'pluck_bass' ? 700 : 400;
    o.type = type;
    o.frequency.value = f0;
    o.connect(lp).connect(g).connect(this.master); // bass goes mostly dry for punch
    o.start(time); o.stop(time + dur + 0.05);
  }

  _kick(time, hard, soft) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    if (soft) {
      // woody hand-drum / soft tom thump
      o.frequency.setValueAtTime(190, time);
      o.frequency.exponentialRampToValueAtTime(90, time + 0.09);
      g.gain.setValueAtTime(0.5, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    } else {
      o.frequency.setValueAtTime(hard ? 165 : 120, time);
      o.frequency.exponentialRampToValueAtTime(hard ? 42 : 45, time + (hard ? 0.1 : 0.12));
      g.gain.setValueAtTime(hard ? 1.0 : 0.9, time);
      g.gain.exponentialRampToValueAtTime(0.001, time + (hard ? 0.22 : 0.25));
    }
    o.connect(g).connect(this.master);
    o.start(time); o.stop(time + 0.3);
    // Hard kicks get a high-passed noise click on the attack for punch.
    if (hard) {
      const c = ctx.createBufferSource();
      c.buffer = this.noise;
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass'; hp.frequency.value = 1200;
      const cg = ctx.createGain();
      cg.gain.setValueAtTime(0.5, time);
      cg.gain.exponentialRampToValueAtTime(0.001, time + 0.02);
      c.connect(hp).connect(cg).connect(this.master);
      c.start(time); c.stop(time + 0.03);
    }
  }

  _hat(time, soft) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = soft ? 6000 : 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(soft ? 0.1 : 0.22, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0006, time + (soft ? 0.05 : 0.06));
    src.connect(hp).connect(g).connect(this.master);
    src.start(time); src.stop(time + 0.08);
  }

  _snare(time, hard, soft) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hard ? 2200 : soft ? 1600 : 1800;
    bp.Q.value = hard ? 0.6 : 0.8;
    const g = ctx.createGain();
    const peak = hard ? 0.6 : soft ? 0.16 : 0.4;
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + (hard ? 0.003 : 0.005));
    g.gain.exponentialRampToValueAtTime(0.001, time + (hard ? 0.15 : 0.18));
    src.connect(bp).connect(g).connect(this.master);
    src.start(time); src.stop(time + 0.2);
    // Hard snares add a quick tonal body so they crack instead of just hiss.
    if (hard) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.type = 'triangle';
      o.frequency.setValueAtTime(330, time);
      o.frequency.exponentialRampToValueAtTime(180, time + 0.08);
      og.gain.setValueAtTime(0.3, time);
      og.gain.exponentialRampToValueAtTime(0.001, time + 0.1);
      o.connect(og).connect(this.master);
      o.start(time); o.stop(time + 0.12);
    }
  }
}
