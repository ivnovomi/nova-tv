/**
 * "Margin" per channel. Some broadcasts come from slow servers: played right
 * at the live edge, the picture keeps stopping to load. Like a real set-top box,
 * NOVA then plays them a little behind live ("en diferido") with seconds of
 * picture already loaded, and starts them in a lower quality that climbs as
 * the connection allows. It learns which channels need it: a channel that
 * stalls gets more margin next time; one that plays smoothly for a while
 * gets it back down.
 */

export interface Plan {
  /** Seconds behind the live edge (undefined: the engine's default, ~3 segments). */
  behind?: number;
  /** Seconds of picture loaded before playback starts (or resumes after a stall). */
  prebuffer: number;
  /** Start at the lowest quality and let it climb. */
  lowStart: boolean;
  /** Be more careful when picking a quality. */
  carefulAbr: boolean;
}

export const PLANS: Plan[] = [
  { prebuffer: 0, lowStart: false, carefulAbr: false },
  { behind: 20, prebuffer: 6, lowStart: false, carefulAbr: true },
  { behind: 30, prebuffer: 10, lowStart: true, carefulAbr: true },
  { behind: 45, prebuffer: 16, lowStart: true, carefulAbr: true },
];

export const MAX_LEVEL = PLANS.length - 1;
const KEY = "nova.tv.cushion";
const MAX_ENTRIES = 400;

type Memory = Record<string, { level: number; at: number }>;

function read(): Memory {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Memory;
  } catch {
    return {};
  }
}

export function cushionLevel(channel: string): number {
  const level = read()[channel]?.level ?? 0;
  return Math.max(0, Math.min(MAX_LEVEL, level));
}

export function setCushionLevel(channel: string, level: number) {
  const memory = read();
  if (level <= 0) delete memory[channel];
  else memory[channel] = { level: Math.min(MAX_LEVEL, level), at: Date.now() };
  // Keep the most recent entries only.
  const entries = Object.entries(memory).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_ENTRIES);
  try {
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

// ── Connection speed, remembered between channels and sessions ──
// Without it the player assumes a slow line and starts every channel blurry,
// climbing for several seconds. With it, it starts at the quality it can hold.

const BW_KEY = "nova.tv.bandwidth";

/** Last measured download speed (bits/s), or the system's estimate, or a safe 3 Mbps. */
export function knownBandwidth(): number {
  try {
    const saved = Number(localStorage.getItem(BW_KEY));
    if (saved > 0) return saved;
  } catch {}
  const downlink = (navigator as Navigator & { connection?: { downlink?: number } }).connection?.downlink;
  return downlink && downlink > 0 ? downlink * 1e6 * 0.8 : 3e6;
}

export function rememberBandwidth(bps: number) {
  if (!Number.isFinite(bps) || bps < 100_000) return;
  try {
    // Smoothed, so one slow channel doesn't drag every other one down.
    const prev = Number(localStorage.getItem(BW_KEY)) || bps;
    localStorage.setItem(BW_KEY, String(Math.round(prev * 0.7 + bps * 0.3)));
  } catch {}
}

/**
 * Best quality the connection can sustain from the first second (and no bigger
 * than the screen it's shown on). `levels` as hls.js gives them.
 */
export function startQuality(levels: { bitrate: number; height: number }[], bandwidth: number, careful: boolean, screenHeight: number): number {
  const budget = bandwidth * (careful ? 0.6 : 0.8);
  let best = 0;
  levels.forEach((l, i) => {
    const fits = l.bitrate <= budget && (!l.height || l.height <= screenHeight * 1.25);
    if (fits && l.bitrate >= levels[best].bitrate) best = i;
  });
  return best;
}

/** Seconds of picture loaded ahead of the playhead. */
export function bufferedAhead(el: HTMLVideoElement): number {
  const b = el.buffered;
  for (let i = 0; i < b.length; i++) {
    if (b.start(i) <= el.currentTime + 0.5 && b.end(i) > el.currentTime) return b.end(i) - el.currentTime;
  }
  return 0;
}
