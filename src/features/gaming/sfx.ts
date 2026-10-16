/**
 * Console-style UI sounds synthesised with Web Audio: no audio files, works offline.
 * Kept quiet on purpose; can be turned off from the Guide.
 */

const KEY = "nova.sfx";
let ctx: AudioContext | null = null;
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
})();

function audio(): AudioContext | null {
  if (!enabled) return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, dur: number, opts: { type?: OscillatorType; gain?: number; delay?: number; to?: number } = {}) {
  const a = audio();
  if (!a) return;
  const { type = "sine", gain = 0.04, delay = 0, to } = opts;
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const amp = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(amp).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

let lastMove = 0;

export const sfx = {
  get enabled() {
    return enabled;
  },
  setEnabled(on: boolean) {
    enabled = on;
    try {
      localStorage.setItem(KEY, on ? "on" : "off");
    } catch {}
  },
  move() {
    const now = performance.now();
    if (now - lastMove < 45) return; // held D-pad: don't machine-gun
    lastMove = now;
    tone(1240, 0.035, { gain: 0.018 });
  },
  select() {
    tone(740, 0.07, { type: "triangle", gain: 0.05 });
    tone(1110, 0.09, { type: "triangle", gain: 0.04, delay: 0.045 });
  },
  back() {
    tone(620, 0.09, { gain: 0.04, to: 420 });
  },
  open() {
    tone(520, 0.12, { type: "triangle", gain: 0.035, to: 880 });
  },
  success() {
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.16, { type: "triangle", gain: 0.035, delay: i * 0.07 }));
  },
  boot() {
    // Low swell + rising shimmer.
    tone(110, 1.4, { type: "sine", gain: 0.06, to: 220 });
    tone(220, 1.2, { type: "triangle", gain: 0.025, delay: 0.25, to: 440 });
    [659, 880, 1175, 1568].forEach((f, i) => tone(f, 0.5, { type: "sine", gain: 0.02, delay: 0.9 + i * 0.09 }));
  },
};
