/**
 * NOVA's start-up sound: synthesised live with Tone.js (no audio files) and
 * timed beat for beat to the boot animation in BootSplash:
 *
 *   0.00 s  the four lights drift in       → a breath of noise rising, a sub swell
 *   0.70 s  N · O · V · A draw themselves   → four FM plucks, one per letter
 *   1.32 s  the lights merge                → a wide D-major-9 bloom over a soft thump
 *   1.90 s  the light sweeps the logo       → airy shimmer and two glints
 *   ready   the picture comes in            → a two-note chime
 */
import type * as ToneLib from "tone";

export const BOOT_SOUND_PREF = "nova.bootSound";

export function bootSoundOn() {
  try {
    return localStorage.getItem(BOOT_SOUND_PREF) !== "off";
  } catch {
    return true;
  }
}

export interface BootSound {
  /** The signature, in sync with the animation started at the same moment. */
  play(): void;
  /** "Ready": played as the splash dissolves into the TV. */
  chime(): void;
  /** Frees the audio graph once the tails have rung out. */
  dispose(): void;
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/** Builds the synths; null when audio can't start (muted pref, autoplay blocked…). */
export async function createBootSound(): Promise<BootSound | null> {
  if (!bootSoundOn()) return null;
  try {
    const Tone: typeof ToneLib = await import("tone");
    const ctx = Tone.getContext();
    ctx.lookAhead = 0; // events land exactly when the animation frames do
    await Promise.race([Tone.start(), wait(600)]);
    if (ctx.state !== "running") return null;

    // ── Bus: delay → reverb → volume → limiter ──
    const limiter = new Tone.Limiter(-1).toDestination();
    const master = new Tone.Volume(-5).connect(limiter);
    const reverb = new Tone.Reverb({ decay: 5.5, preDelay: 0.02, wet: 0.4 }).connect(master);
    const delay = new Tone.FeedbackDelay({ delayTime: 0.23, feedback: 0.34, wet: 0.24 }).connect(reverb);
    await Promise.race([reverb.ready, wait(500)]);

    // ── Voices ──
    const subGain = new Tone.Gain(0).connect(master);
    const sub = new Tone.Oscillator(36.71, "sine").connect(subGain); // D1

    const riserGain = new Tone.Gain(0).connect(reverb);
    const riserFilter = new Tone.Filter({ type: "bandpass", frequency: 220, Q: 1.4 }).connect(riserGain);
    const riser = new Tone.Noise("pink").connect(riserFilter);

    const pluck = new Tone.PolySynth(Tone.FMSynth, {
      harmonicity: 3.01,
      modulationIndex: 7,
      oscillator: { type: "sine" },
      modulation: { type: "sine" },
      envelope: { attack: 0.004, decay: 0.55, sustain: 0, release: 1 },
      modulationEnvelope: { attack: 0.002, decay: 0.22, sustain: 0, release: 0.3 },
      volume: -13,
    }).connect(delay);

    const padFilter = new Tone.Filter({ type: "lowpass", frequency: 260, rolloff: -24, Q: 0.7 }).connect(reverb);
    const pad = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "fatsawtooth", count: 3, spread: 26 },
      envelope: { attack: 0.05, decay: 0.9, sustain: 0.35, release: 2.8 },
      volume: -25,
    }).connect(padFilter);

    const thump = new Tone.MembraneSynth({
      pitchDecay: 0.09,
      octaves: 5,
      envelope: { attack: 0.001, decay: 0.8, sustain: 0, release: 0.4 },
      volume: -9,
    }).connect(master);

    const airGain = new Tone.Gain(0).connect(reverb);
    const airFilter = new Tone.Filter({ type: "highpass", frequency: 2500, Q: 0.8 }).connect(airGain);
    const air = new Tone.Noise("white").connect(airFilter);

    const glint = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sine" },
      envelope: { attack: 0.002, decay: 0.45, sustain: 0, release: 0.7 },
      volume: -21,
    }).connect(delay);

    const nodes = [sub, subGain, riser, riserFilter, riserGain, pluck, pad, padFilter, thump, air, airFilter, airGain, glint, delay, reverb, master, limiter];

    return {
      play() {
        const t = Tone.now() + 0.02;
        // 1 · lights converging
        riser.start(t).stop(t + 1.6);
        riserFilter.frequency.setValueAtTime(220, t);
        riserFilter.frequency.exponentialRampToValueAtTime(5200, t + 1.3);
        riserGain.gain.setValueAtTime(0, t);
        riserGain.gain.linearRampToValueAtTime(0.2, t + 1.22);
        riserGain.gain.linearRampToValueAtTime(0, t + 1.42);
        sub.start(t).stop(t + 4.5);
        subGain.gain.setValueAtTime(0, t);
        subGain.gain.linearRampToValueAtTime(0.06, t + 0.9);
        subGain.gain.linearRampToValueAtTime(0.32, t + 1.32);
        subGain.gain.setTargetAtTime(0, t + 1.45, 0.7);

        // 2 · one pluck per letter, rising
        ["A4", "E5", "F#5", "C#6"].forEach((note, i) => pluck.triggerAttackRelease(note, 0.25, t + 0.7 + i * 0.16, 0.55));

        // 3 · the merge
        thump.triggerAttackRelease("D1", 0.5, t + 1.32, 0.85);
        pad.triggerAttackRelease(["D3", "A3", "E4", "F#4", "C#5"], 1.5, t + 1.3, 0.6);
        padFilter.frequency.setValueAtTime(260, t + 1.3);
        padFilter.frequency.exponentialRampToValueAtTime(4200, t + 2.3);
        padFilter.frequency.exponentialRampToValueAtTime(800, t + 4.4);

        // 4 · the light sweep
        air.start(t + 1.85).stop(t + 3);
        airFilter.frequency.setValueAtTime(2500, t + 1.85);
        airFilter.frequency.exponentialRampToValueAtTime(11000, t + 2.8);
        airGain.gain.setValueAtTime(0, t + 1.85);
        airGain.gain.linearRampToValueAtTime(0.05, t + 2.3);
        airGain.gain.linearRampToValueAtTime(0, t + 2.9);
        glint.triggerAttackRelease("A6", 0.1, t + 2.25, 0.45);
        glint.triggerAttackRelease("E7", 0.1, t + 2.38, 0.3);
      },
      chime() {
        const t = Tone.now() + 0.01;
        pluck.triggerAttackRelease("D6", 0.2, t, 0.38);
        pluck.triggerAttackRelease("A6", 0.3, t + 0.11, 0.3);
      },
      dispose() {
        window.setTimeout(() => nodes.forEach((n) => n.dispose()), 6000);
      },
    };
  } catch {
    return null; // sound is a nicety: the boot never waits on it
  }
}
