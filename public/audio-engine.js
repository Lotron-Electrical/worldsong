// audio-engine.js — Worldsong's generative music engine (Web Audio API).
//
// Given a "genome" (one arm per musical dimension) and a seed, it synthesises an
// endless, evolving piece entirely in the browser — no samples, no external libs.
// The seed makes the melody deterministic, so two listeners in the same zone hear
// the same music. Drums, bass, pads and lead are all built from oscillators/noise.

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
const DRUMS = {
  none: { kick: [], hat: [], snare: [] },
  soft_kick: { kick: [0, 8], hat: [4, 12], snare: [] },
  four_floor: { kick: [0, 4, 8, 12], hat: [2, 6, 10, 14], snare: [4, 12] },
  downtempo: { kick: [0, 10], hat: [4, 7, 12, 14], snare: [8] },
  trip_hop: { kick: [0, 10], hat: [2, 6, 9, 12, 14], snare: [8] },
};

export class WorldsongEngine {
  constructor() {
    this.ctx = null;
    this.playing = false;
    this.genome = null;
    this.seed = 1;
    this.analyser = null;
    this._timer = null;
    this._step = 0;
    this._nextTime = 0;
    this.onStep = null; // optional callback(step) for visuals
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

    // melodic bus -> brightness filter -> dry + reverb -> master -> analyser -> out
    this.bus = ctx.createGain();
    this.bus.connect(this.bright);
    this.bright.connect(this.dry);
    this.dry.connect(this.master);
    this.bright.connect(this.conv);
    this.conv.connect(this.wet);
    this.wet.connect(this.master);

    this.master.connect(this.analyser);
    this.analyser.connect(ctx.destination);

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
    this._rng = mulberry32(this.seed);
    this._step = 0;
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

  // Reseed melody/voices for a brand-new track without tearing down the context.
  swap(genome, seed) {
    this.load(genome, seed);
    if (this.ctx) {
      this._rng = mulberry32(this.seed);
      this._step = 0;
      this._applyGenome();
    }
  }

  _scaleNote(degree) {
    const g = this.genome;
    const sc = SCALES[g.scale] || SCALES.minor;
    const base = ROOT_MIDI[g.root] ?? 60;
    const oct = Math.floor(degree / sc.length);
    const idx = ((degree % sc.length) + sc.length) % sc.length;
    return base + sc[idx] + 12 * oct;
  }

  _scheduler() {
    const ctx = this.ctx;
    const bpm = parseInt(this.genome.tempo, 10) || 96;
    const stepDur = (60 / bpm) / 4; // 16th note
    while (this._nextTime < ctx.currentTime + 0.14) {
      this._playStep(this._step, this._nextTime, stepDur);
      if (this.onStep) try { this.onStep(this._step); } catch {}
      this._nextTime += stepDur;
      this._step = (this._step + 1) % 64; // 4-bar loop
    }
  }

  _playStep(step, time, stepDur) {
    const g = this.genome;
    const bar = Math.floor(step / 16);
    const s = step % 16;

    // Chord root degree per bar — a simple, pleasant progression.
    const prog = [0, 5, 3, 4];
    const chordDeg = prog[bar % 4];

    // ---- pad: sustain a chord at the top of each bar ----
    if (s === 0 && g.pad !== 'none') {
      const chord = [chordDeg, chordDeg + 2, chordDeg + 4].map((d) => this._scaleNote(d));
      this._pad(chord, time, stepDur * 16 * 1.05);
    }

    // ---- drums ----
    const pat = DRUMS[g.drums] || DRUMS.none;
    if (pat.kick.includes(s)) this._kick(time);
    if (pat.hat.includes(s)) this._hat(time);
    if (pat.snare.includes(s)) this._snare(time);

    // ---- bass: on kick hits (or beat 0/8) ----
    if (g.bass !== 'none') {
      const beats = pat.kick.length ? pat.kick : [0, 8];
      if (beats.includes(s)) {
        const note = this._scaleNote(chordDeg) - 24; // two octaves down
        this._bass(note, time, stepDur * 3.5);
      }
    }

    // ---- lead: arpeggio / melody from the chord + scale ----
    if (g.lead !== 'none') {
      const densityEvery = { sparse: 4, medium: 2, busy: 1 }[g.density] || 2;
      const prob = { sparse: 0.5, medium: 0.7, busy: 0.92 }[g.density] || 0.7;
      if (s % densityEvery === 0 && this._rng() < prob) {
        const tones = [chordDeg, chordDeg + 2, chordDeg + 4, chordDeg + 7, chordDeg + 1];
        const deg = tones[Math.floor(this._rng() * tones.length)];
        const midi = this._scaleNote(deg + 7); // up an octave for the lead range
        const dur = stepDur * (g.density === 'busy' ? 1.3 : 2.2);
        this._lead(mtof(midi), time, dur);
      }
    }
  }

  // ---------------- voices ----------------

  _env(g, time, a, peak, dur) {
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(peak, time + a);
    g.gain.exponentialRampToValueAtTime(0.0008, time + dur);
  }

  _lead(freq, time, dur) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const o = ctx.createOscillator();
    const lead = this.genome.lead;
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
    const type = { sub: 'sine', saw_bass: 'sawtooth', pulse_bass: 'square' }[this.genome.bass] || 'sine';
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400;
    o.type = type;
    o.frequency.value = mtof(midi);
    this._env(g, time, 0.02, 0.34, dur);
    o.connect(lp).connect(g).connect(this.master); // bass goes mostly dry for punch
    o.start(time); o.stop(time + dur + 0.05);
  }

  _kick(time) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, time);
    o.frequency.exponentialRampToValueAtTime(45, time + 0.12);
    g.gain.setValueAtTime(0.9, time);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.25);
    o.connect(g).connect(this.master);
    o.start(time); o.stop(time + 0.3);
  }

  _hat(time) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.22, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0006, time + 0.06);
    src.connect(hp).connect(g).connect(this.master);
    src.start(time); src.stop(time + 0.08);
  }

  _snare(time) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.frequency.value = 1800; bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, time);
    g.gain.exponentialRampToValueAtTime(0.4, time + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, time + 0.18);
    src.connect(bp).connect(g).connect(this.master);
    src.start(time); src.stop(time + 0.2);
  }
}
