/** Deterministic, offline artwork generated from a name. No external images. */

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Brand-adjacent hues for detected apps (colour only, no logos). */
const KNOWN_HUES: Record<string, number> = {
  "detected:chrome": 205,
  "detected:edge": 188,
  "detected:firefox": 22,
  "detected:vlc": 28,
  "detected:spotify": 145,
  "detected:discord": 236,
  "detected:steam": 212,
  "detected:epic": 250,
  "detected:obs": 270,
  "detected:explorer": 45,
  "detected:notepad": 200,
  "detected:calc": 222,
};

export function hueFor(id: string, name: string): number {
  return KNOWN_HUES[id] ?? hashString(name) % 360;
}

export function tileBackground(id: string, name: string): string {
  const h = hueFor(id, name);
  const h2 = (h + 38) % 360;
  return [
    `radial-gradient(120% 90% at 50% -10%, hsl(${h} 70% 46% / 0.42), transparent 62%)`,
    `radial-gradient(80% 70% at 100% 110%, hsl(${h2} 75% 50% / 0.22), transparent 60%)`,
    `linear-gradient(160deg, hsl(${h} 45% 15%), hsl(${(h + 200) % 360} 40% 7%))`,
  ].join(",");
}

export function posterBackground(id: string, name: string): string {
  const n = hashString(name);
  const h = hueFor(id, name);
  const h2 = (h + 50 + (n % 60)) % 360;
  const variant = n % 3;
  const layers = [
    `radial-gradient(90% 120% at ${20 + (n % 60)}% 0%, hsl(${h} 80% 55% / 0.55), transparent 60%)`,
    `radial-gradient(70% 90% at 100% 100%, hsl(${h2} 85% 50% / 0.45), transparent 60%)`,
  ];
  if (variant === 0) layers.push(`repeating-linear-gradient(115deg, hsl(0 0% 100% / 0.04) 0 2px, transparent 2px 22px)`);
  if (variant === 1) layers.push(`repeating-radial-gradient(circle at 85% 30%, hsl(0 0% 100% / 0.05) 0 1px, transparent 1px 26px)`);
  if (variant === 2) layers.push(`conic-gradient(from ${n % 360}deg at 80% 40%, hsl(${h2} 80% 60% / 0.18), transparent 30%, hsl(${h} 80% 60% / 0.14), transparent 70%)`);
  layers.push(`linear-gradient(135deg, hsl(${h} 50% 14%), hsl(${h2} 45% 6%))`);
  return layers.join(",");
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
