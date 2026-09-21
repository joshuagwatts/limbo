/* LIMBO — jam room core (build 13).
 *
 * Pure music math + DSP: tempo estimation, onset detection, note
 * scheduling helpers, and the pocket-synth voice. No DOM, no net —
 * game.js wires this into the UI and the Trystero jam actions.
 *
 * THE LATENCY TRICK (why this feels tight): instrument audio is NEVER
 * streamed. Tiny note/pad events ride the data channel and EVERY client
 * synthesizes the sound locally with WebAudio, scheduled against the
 * shared beat clock. Your own notes play instantly (zero latency for
 * you); everyone else's land quantized on the grid. ~500ms of network
 * jitter disappears into the quantization.
 */

export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/* Next grid line at or after `beat`. grid is in beats (0.25 = 16th). */
export function quantizeUp(beat, grid) {
  if (!Number.isFinite(beat) || !Number.isFinite(grid) || grid <= 0) return beat;
  return Math.ceil(beat / grid - 1e-9) * grid;
}

/* Tempo from onset times (seconds). Method: median inter-onset interval
 * of plausible beat IOIs, octave-snapped into 70–180 BPM. Dance music
 * onsets cluster on the beat grid, so the median IOI is usually a beat
 * (or a clean subdivision, which the snapping fixes). Returns null when
 * there isn't enough data to trust. Honest v1 — not a full beat tracker. */
export function estimateBpm(onsets, min = 70, max = 180) {
  if (!onsets || onsets.length < 8) return null;
  const iois = [];
  for (let i = 1; i < onsets.length; i++) {
    const d = onsets[i] - onsets[i - 1];
    if (d > 0.15 && d < 1.2) iois.push(d);
  }
  if (iois.length < 6) return null;
  iois.sort((a, b) => a - b);
  const med = iois[Math.floor(iois.length / 2)];
  let bpm = 60 / med;
  while (bpm < min) bpm *= 2;
  while (bpm > max) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

/* Energy-flux onset detector. Feed it the DJ stream's analyser once a
 * second (or so); it keeps a sliding ~12s window of onset times for
 * estimateBpm(). Works with any object exposing getByteFrequencyData()
 * and frequencyBinCount — which is also what makes it unit-testable
 * with a fake analyser. */
export class OnsetDetector {
  constructor() {
    this.buf = null;
    this.prev = null;
    this.onsets = [];
    this.avg = 0;
  }
  reset() {
    this.onsets = [];
    this.avg = 0;
    this.prev = null;
  }
  process(analyser) {
    try {
      const n = analyser.frequencyBinCount;
      if (!this.buf || this.buf.length !== n) {
        this.buf = new Uint8Array(n);
        this.prev = new Float32Array(n);
      }
      analyser.getByteFrequencyData(this.buf);
      // Spectral flux over the low-mid bins — kicks and bass live here.
      // (The game's analyser runs fftSize 64 = 32 coarse bins; good
      // enough for v1, not a studio detector.)
      let flux = 0;
      const K = Math.min(n, 24);
      for (let i = 1; i < K; i++) {
        const d = this.buf[i] - this.prev[i];
        if (d > 0) flux += d;
        this.prev[i] = this.buf[i];
      }
      this.avg = this.avg * 0.92 + flux * 0.08;
      const now = performance.now() / 1000;
      const last = this.onsets.length ? this.onsets[this.onsets.length - 1] : -10;
      if (flux > Math.max(18, this.avg * 1.9) && now - last > 0.09) {
        this.onsets.push(now);
      }
      while (this.onsets.length && now - this.onsets[0] > 12) this.onsets.shift();
    } catch (e) {
      /* detection must never break the game */
    }
    return this.onsets;
  }
}

/* The pocket synth voice (build 39: deeper).
 * Two detuned oscillators (waveform selectable) + an optional sine sub an
 * octave down, through a lowpass filter with its own envelope (cutoff +
 * env amount + decay), a shaping amp envelope (attack/decay), optional
 * portamento glide for mono-style leads, and per-voice echo sends that tap
 * the game's delay + reverb directly (the dotted-eighth psy-lead sound).
 * Every note spawns fresh nodes — no voice stealing, so overlapping notes
 * from several jammers just layer. `time` is an AudioContext timestamp.
 * All new opts are optional with musical defaults, so older {w,c,r} patches
 * from the room render exactly as before. */
/* ---------------- polyphony guard (build 39) ----------------
 * The lead is a real instrument now: many fingers at once, chord pads,
 * stacked notes from the whole room. Cap simultaneous voices so a phone
 * never chokes — when the cap is hit, the oldest already-sounding voice
 * is gently released to make space. */
const MAX_VOICES = 12;
const liveVoices = []; // {oscs, g, t, life}
let voiceCtx = null;
function pruneVoices(ctx) {
  const now = ctx.currentTime;
  for (let i = liveVoices.length - 1; i >= 0; i--) {
    if (now > liveVoices[i].life) liveVoices.splice(i, 1);
  }
}
function stealVoice(ctx) {
  const now = ctx.currentTime;
  // Never steal a voice that hasn't started sounding yet (a remote note
  // quantized into the future) — take the oldest live one instead.
  const victim = liveVoices.find((v) => v.t <= now + 0.05);
  if (!victim) return;
  try {
    victim.g.gain.cancelScheduledValues(now);
    victim.g.gain.setTargetAtTime(0.0001, now, 0.03);
    for (const o of victim.oscs) { try { o.stop(now + 0.25); } catch (e) {} }
  } catch (e) {}
  const i = liveVoices.indexOf(victim);
  if (i >= 0) liveVoices.splice(i, 1);
}
/* Diagnostic: how many synth voices are alive right now. */
export function synthVoiceCount() {
  if (voiceCtx) { try { pruneVoices(voiceCtx); } catch (e) {} }
  return liveVoices.length;
}

export function playSynthNote(ctx, dest, opts) {
  const {
    midi = 60,
    vel = 0.9,
    time = 0,
    wave = 'sawtooth',
    cutoff = 1800,
    resonance = 5,
    env = 0.35, // 0..1 — filter envelope amount (fraction of 6kHz added at peak)
    decay = 0.4, // s — filter + amp decay
    attack = 0.008, // s — amp attack
    sub = 0, // 0..1 — sine sub-oscillator one octave down
    spread = 12, // cents — detune spread of the osc pair
    glide = 0, // s — portamento from fromFreq (local performance only)
    fromFreq = 0, // Hz — glide start; ignored unless glide > 0
    echo = 0, // 0..1 — per-voice delay/reverb send amount
    sends = null, // [{node, gain}] — echo destinations (game's delay + conv)
  } = opts || {};
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const f = midiToFreq(midi);
    const atk = Math.max(0.002, Math.min(0.6, Number(attack) || 0.008));
    const dec = Math.max(0.08, Math.min(2.5, Number(decay) || 0.4));
    const envAmt = Math.max(0, Math.min(1, Number(env) || 0)) * 6000;
    const cut = Math.max(80, Math.min(12000, cutoff));
    // Filter with its own envelope: opens by envAmt, settles back to cutoff.
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.setValueAtTime(Math.min(14000, cut + envAmt), t);
    flt.frequency.exponentialRampToValueAtTime(cut, t + Math.max(0.05, dec * 1.4));
    flt.Q.value = Math.max(0, Math.min(15, resonance));
    // Amp: quick attack, decay to a soft sustain, gentle release.
    const g = ctx.createGain();
    const peak = 0.32 * Math.max(0.05, Math.min(1.2, vel));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak + 0.001, t + atk);
    g.gain.exponentialRampToValueAtTime(peak * 0.55 + 0.001, t + atk + dec);
    g.gain.setTargetAtTime(0.0001, t + atk + dec, Math.max(0.06, dec * 0.3));
    const life = t + atk + dec * 3 + 0.6; // nodes live past the tail
    const spr = Math.max(0, Math.min(50, Number(spread) || 0));
    const oscs = []; // every live osc, for the polyphony guard
    const mk = (type, detune, freqMul = 1, gainMul = 1, dur = life) => {
      const o = ctx.createOscillator();
      o.type = type;
      const ff = f * freqMul;
      if (glide > 0.005 && fromFreq > 20 && freqMul === 1) {
        // portamento: slide from the last note into this one
        o.frequency.setValueAtTime(Math.min(12000, fromFreq), t);
        o.frequency.exponentialRampToValueAtTime(Math.min(12000, ff), t + glide);
      } else {
        o.frequency.value = ff;
      }
      o.detune.value = detune;
      if (gainMul !== 1) {
        const og = ctx.createGain();
        og.gain.value = gainMul;
        o.connect(og);
        og.connect(flt);
      } else {
        o.connect(flt);
      }
      o.start(t);
      o.stop(dur);
      oscs.push(o);
      return o;
    };
    if (wave === 'square') {
      mk('square', -spr / 2);
      mk('square', spr / 2);
    } else if (wave === 'mix') {
      mk('sawtooth', -spr / 2);
      mk('square', spr / 2);
    } else {
      mk('sawtooth', -spr / 2);
      mk('sawtooth', spr / 2);
    }
    const subAmt = Math.max(0, Math.min(1, Number(sub) || 0));
    if (subAmt > 0.01) mk('sine', 0, 0.5, subAmt * 0.5); // weight underneath
    flt.connect(g);
    g.connect(dest);
    // Per-voice echo: tap the voice into the game's delay + reverb sends.
    const echoAmt = Math.max(0, Math.min(1, Number(echo) || 0));
    if (echoAmt > 0.01 && Array.isArray(sends)) {
      for (const s of sends) {
        if (!s || !s.node) continue;
        const sg = ctx.createGain();
        sg.gain.value = echoAmt * Math.max(0, Math.min(1, Number(s.gain) || 0.5));
        g.connect(sg);
        try { sg.connect(s.node); } catch (e) { try { sg.disconnect(); } catch (e2) {} }
      }
    }
    // Polyphony guard: cap simultaneous voices, stealing the oldest live
    // one when a new note needs the space. Keeps chords + fast fingers
    // smooth on a phone.
    pruneVoices(ctx);
    if (liveVoices.length >= MAX_VOICES) stealVoice(ctx);
    liveVoices.push({ oscs, g, t, life });
    voiceCtx = ctx;
  } catch (e) {
    /* a missed note is better than a crashed frame */
  }
}

/* ---------------- build 20: instruments, space, metronome ----------------
 * Four instruments share the jam bus: LEAD (the pocket synth above),
 * BASS (sub), DRUMS (synthesized kit), PAD (chord stabs). Plus a generated
 * impulse response for the room reverb and a metronome click. All pure
 * DSP — game.js owns the bus graph, UI, and net. */

function clampVel(v) {
  return Math.max(0.05, Math.min(1.2, Number(v) || 0.9));
}

/* Cached 1s white-noise buffer (shared by every drum hit — cheap). */
let _noiseBuf = null;
let _noiseRate = 0;
export function getNoiseBuffer(ctx) {
  if (_noiseBuf && _noiseRate === ctx.sampleRate) return _noiseBuf;
  const len = ctx.sampleRate;
  _noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = _noiseBuf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  _noiseRate = ctx.sampleRate;
  return _noiseBuf;
}

/* Generated stereo impulse response: decaying noise, no audio files. */
export function makeImpulseResponse(ctx, seconds = 1.9, decay = 2.4) {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * Math.max(0.2, seconds)));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

/* BASS: sine + triangle, one octave below the played key, through a
 * lowpass with a punchy pluck envelope. Sub you feel in your chest. */
export function playBassNote(ctx, dest, opts) {
  const { midi = 48, vel = 0.9, time = 0 } = opts || {};
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const f = midiToFreq(Math.max(0, Math.min(127, Math.round(midi))) - 12);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = 520;
    flt.Q.value = 2;
    const g = ctx.createGain();
    const peak = 0.5 * clampVel(vel);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak + 0.001, t + 0.012);
    g.gain.exponentialRampToValueAtTime(peak * 0.6 + 0.001, t + 0.14);
    g.gain.setTargetAtTime(0.0001, t + 0.32, 0.09);
    for (const [type, detune] of [['sine', 0], ['triangle', 5]]) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(flt);
      o.start(t);
      o.stop(t + 1.0);
    }
    flt.connect(g);
    g.connect(dest);
  } catch (e) { /* a missed note is better than a crashed frame */ }
}

/* DRUMS: fully synthesized kit. kick = sine pitch drop, snare/clap =
 * filtered noise + body, hats/shaker = highpassed noise. */
export const JAM_DRUMS = ['kick', 'snare', 'clap', 'chat', 'ohat', 'shaker'];
export function playDrum(ctx, dest, opts) {
  const { drum = 'kick', vel = 0.9, time = 0 } = opts || {};
  if (!JAM_DRUMS.includes(drum)) return;
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const v = clampVel(vel);
    const noise = getNoiseBuffer(ctx);
    const noiseHit = (t0, dur, fType, freq, q, peak, attack = 0.002) => {
      const src = ctx.createBufferSource();
      src.buffer = noise;
      src.loop = true;
      const flt = ctx.createBiquadFilter();
      flt.type = fType;
      flt.frequency.value = freq;
      flt.Q.value = q;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0011, peak * v), t0 + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(flt); flt.connect(g); g.connect(dest);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    };
    const toneHit = (t0, dur, type, f0, f1, peak) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.setValueAtTime(Math.max(20, f0), t0);
      o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0011, peak * v), t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(dest);
      o.start(t0);
      o.stop(t0 + dur + 0.05);
    };
    switch (drum) {
      case 'kick':
        toneHit(t, 0.26, 'sine', 155, 44, 0.95);
        noiseHit(t, 0.03, 'highpass', 4000, 0.7, 0.25);
        break;
      case 'snare':
        noiseHit(t, 0.17, 'bandpass', 1900, 0.9, 0.6);
        toneHit(t, 0.11, 'triangle', 196, 150, 0.35);
        break;
      case 'clap':
        noiseHit(t, 0.09, 'bandpass', 1300, 1.4, 0.5);
        noiseHit(t + 0.014, 0.09, 'bandpass', 1300, 1.4, 0.5);
        noiseHit(t + 0.028, 0.2, 'bandpass', 1300, 1.4, 0.55);
        break;
      case 'chat': // closed hat
        noiseHit(t, 0.05, 'highpass', 8200, 0.7, 0.32);
        break;
      case 'ohat': // open hat
        noiseHit(t, 0.32, 'highpass', 7600, 0.7, 0.3);
        break;
      case 'shaker':
        noiseHit(t, 0.11, 'highpass', 6200, 0.8, 0.22, 0.012);
        break;
    }
  } catch (e) { /* ignore */ }
}

/* PAD: i–VI–III–VII triads in A minor. Detuned saws, slow attack,
 * per-note stereo spread — wide and weightless. */
export const JAM_CHORDS = [
  { name: 'Am', numeral: 'i', midi: [57, 60, 64] },
  { name: 'F', numeral: 'VI', midi: [53, 57, 60] },
  { name: 'C', numeral: 'III', midi: [55, 60, 64] },
  { name: 'G', numeral: 'VII', midi: [55, 59, 62] },
];
export function playPadChord(ctx, dest, opts) {
  const { chord = 0, vel = 0.8, time = 0 } = opts || {};
  const ch = JAM_CHORDS[chord] || JAM_CHORDS[0];
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const v = clampVel(vel);
    ch.midi.forEach((m, i) => {
      const f = midiToFreq(m);
      const flt = ctx.createBiquadFilter();
      flt.type = 'lowpass';
      flt.frequency.value = 950;
      flt.Q.value = 0.7;
      const g = ctx.createGain();
      const peak = 0.15 * v;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak + 0.001, t + 0.7); // slow bloom
      g.gain.setValueAtTime(peak + 0.001, t + 1.6);
      g.gain.setTargetAtTime(0.0001, t + 1.7, 0.5);
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.pan.value = i % 2 ? 0.28 : -0.28; // subtle width
      for (const detune of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = detune;
        o.connect(flt);
        o.start(t);
        o.stop(t + 3.4);
      }
      flt.connect(g);
      if (pan) { g.connect(pan); pan.connect(dest); }
      else g.connect(dest);
    });
  } catch (e) { /* ignore */ }
}

/* Personal metronome click: accented on beat 1. Short square blip,
 * local-only — game.js never broadcasts it. */
export function jamMetroClick(ctx, dest, opts) {
  const { time = 0, accent = false, vol = 0.5 } = opts || {};
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = accent ? 1568 : 1046;
    const g = ctx.createGain();
    const peak = Math.max(0.0011, (accent ? 0.32 : 0.2) * Math.max(0, Math.min(1, vol)));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    o.connect(g);
    g.connect(dest);
    o.start(t);
    o.stop(t + 0.09);
  } catch (e) { /* ignore */ }
}
