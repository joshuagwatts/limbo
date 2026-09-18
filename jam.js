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

/* The pocket synth voice. Two detuned oscillators (waveform selectable)
 * through a lowpass filter with a short plucky envelope. Every note
 * spawns fresh nodes — no voice stealing, so overlapping notes from
 * several jammers just layer. `time` is an AudioContext timestamp. */
export function playSynthNote(ctx, dest, opts) {
  const {
    midi = 60,
    vel = 0.9,
    time = 0,
    wave = 'sawtooth',
    cutoff = 1800,
    resonance = 5,
  } = opts || {};
  try {
    const t = Math.max(time || 0, ctx.currentTime);
    const f = midiToFreq(midi);
    const flt = ctx.createBiquadFilter();
    flt.type = 'lowpass';
    flt.frequency.value = Math.max(80, Math.min(12000, cutoff));
    flt.Q.value = Math.max(0, Math.min(15, resonance));
    const g = ctx.createGain();
    const peak = 0.32 * Math.max(0.05, Math.min(1.2, vel));
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak + 0.001, t + 0.008);
    g.gain.exponentialRampToValueAtTime(peak * 0.55 + 0.001, t + 0.18);
    g.gain.setTargetAtTime(0.0001, t + 0.35, 0.12);
    const mk = (type, detune) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      o.detune.value = detune;
      o.connect(flt);
      o.start(t);
      o.stop(t + 1.0);
    };
    if (wave === 'square') {
      mk('square', -4);
      mk('square', 4);
    } else if (wave === 'mix') {
      mk('sawtooth', -5);
      mk('square', 5);
    } else {
      mk('sawtooth', -5);
      mk('sawtooth', 6);
    }
    flt.connect(g);
    g.connect(dest);
  } catch (e) {
    /* a missed note is better than a crashed frame */
  }
}
