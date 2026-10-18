/**
 * Generated artwork (SVG data URLs): icons, banners and NOVA-like
 * screenshots in a plugin's colour. Used when a store entry has no images of
 * its own, and for the development preview of the store.
 */

const svg = (w: number, h: number, body: string) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${body}</svg>`)}`;

/** Deterministic randomness from a string. */
function random(seed: string) {
  let h = 2166136261;
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

function hsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s * 100, l * 100];
}

/** The accent turned `deg` around the colour wheel, at a given lightness. */
const tone = (accent: string, deg = 0, light?: number, sat?: number) => {
  const [h, s, l] = hsl(accent);
  return `hsl(${(h + deg + 360) % 360} ${sat ?? Math.min(90, s)}% ${light ?? l}%)`;
};

const safeAccent = (a?: string | null) => (a && /^#[0-9a-f]{6}$/i.test(a) ? a : "#6e6cff");

// ───────────────────────── Icon ─────────────────────────

export function iconArt(accentIn: string | null | undefined, glyph: string) {
  const a = safeAccent(accentIn);
  return svg(
    256,
    256,
    `<defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone(a, -18, 62)}"/><stop offset="1" stop-color="${tone(a, 22, 34)}"/></linearGradient>
      <radialGradient id="s" cx=".3" cy=".2" r=".8"><stop offset="0" stop-color="#fff" stop-opacity=".45"/><stop offset=".6" stop-color="#fff" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="256" height="256" rx="58" fill="url(#g)"/>
    <rect width="256" height="256" rx="58" fill="url(#s)"/>
    <rect x="1.5" y="1.5" width="253" height="253" rx="57" fill="none" stroke="#fff" stroke-opacity=".22" stroke-width="3"/>
    <text x="128" y="128" dominant-baseline="central" text-anchor="middle" font-family="Segoe UI Emoji, Segoe UI, sans-serif" font-size="120" font-weight="700" fill="#fff">${glyph}</text>`,
  );
}

// ───────────────────────── Banner ─────────────────────────

export function bannerArt(accentIn: string | null | undefined, glyph: string, seed: string) {
  const a = safeAccent(accentIn);
  const r = random(seed);
  const streaks = Array.from({ length: 7 }, (_, i) => {
    const x = 200 + i * 230 + r() * 120;
    return `<rect x="${x}" y="-200" width="${30 + r() * 90}" height="1400" fill="#fff" opacity="${0.025 + r() * 0.04}" transform="rotate(28 ${x} 450)"/>`;
  }).join("");
  const dots = Array.from({ length: 60 }, () => `<circle cx="${r() * 1600}" cy="${r() * 900}" r="${1 + r() * 2.4}" fill="#fff" opacity="${0.15 + r() * 0.5}"/>`).join("");
  return svg(
    1600,
    900,
    `<defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone(a, -30, 12, 60)}"/><stop offset="1" stop-color="${tone(a, 30, 6, 50)}"/></linearGradient>
      <radialGradient id="b1"><stop offset="0" stop-color="${tone(a, 0, 58)}" stop-opacity=".9"/><stop offset="1" stop-color="${tone(a, 0, 58)}" stop-opacity="0"/></radialGradient>
      <radialGradient id="b2"><stop offset="0" stop-color="${tone(a, 50, 55)}" stop-opacity=".7"/><stop offset="1" stop-color="${tone(a, 50, 55)}" stop-opacity="0"/></radialGradient>
      <radialGradient id="b3"><stop offset="0" stop-color="${tone(a, -60, 60)}" stop-opacity=".55"/><stop offset="1" stop-color="${tone(a, -60, 60)}" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="1600" height="900" fill="url(#bg)"/>
    <circle cx="${1050 + r() * 200}" cy="${300 + r() * 120}" r="560" fill="url(#b1)"/>
    <circle cx="${1400 + r() * 100}" cy="${720 + r() * 80}" r="420" fill="url(#b2)"/>
    <circle cx="${300 + r() * 200}" cy="${820}" r="460" fill="url(#b3)"/>
    ${streaks}${dots}
    <text x="1180" y="470" dominant-baseline="central" text-anchor="middle" font-family="Segoe UI Emoji, Segoe UI, sans-serif" font-size="380" opacity=".9">${glyph}</text>`,
  );
}

// ───────────────────────── Screenshots ─────────────────────────

export type ShotKind = "home" | "guide" | "player" | "grid";

const bar = (x: number, y: number, w: number, h = 14, o = 0.85) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${h / 2}" fill="#fff" opacity="${o}"/>`;

/** A NOVA screen with the plugin's content, drawn in its colour. */
export function shotArt(accentIn: string | null | undefined, kind: ShotKind, seed: string, glyph = "") {
  const a = safeAccent(accentIn);
  const r = random(seed + kind);
  const tile = (x: number, y: number, w: number, h: number, i: number) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="18" fill="${tone(a, (i * 37) % 120 - 60, 28 + r() * 30)}"/>` +
    `<rect x="${x}" y="${y + h * 0.55}" width="${w}" height="${h * 0.45}" rx="18" fill="#000" opacity=".35"/>` +
    bar(x + 18, y + h - 34, w * (0.4 + r() * 0.4), 12, 0.8);
  const top =
    `<rect width="1600" height="900" fill="#05070f"/>` +
    `<rect width="1600" height="900" fill="url(#amb)"/>` +
    `<circle cx="96" cy="56" r="16" fill="${a}"/>${bar(124, 49, 90, 14, 0.9)}` +
    [0, 1, 2, 3, 4].map((i) => `<rect x="${300 + i * 130}" y="38" width="112" height="36" rx="18" fill="#fff" opacity="${i === 1 ? 0.95 : 0.08}"/>`).join("");
  const defs = `<defs><radialGradient id="amb" cx=".2" cy="0" r=".9"><stop offset="0" stop-color="${a}" stop-opacity=".28"/><stop offset="1" stop-color="${a}" stop-opacity="0"/></radialGradient>
    <linearGradient id="hero" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${tone(a, -20, 45)}"/><stop offset="1" stop-color="${tone(a, 40, 18)}"/></linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#05070f" stop-opacity=".95"/><stop offset=".6" stop-color="#05070f" stop-opacity="0"/></linearGradient>
    <linearGradient id="up" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity=".85"/><stop offset=".5" stop-color="#000" stop-opacity="0"/></linearGradient></defs>`;

  if (kind === "home") {
    const hero = `<rect x="70" y="120" width="1460" height="380" rx="34" fill="url(#hero)"/>
      <text x="1250" y="310" dominant-baseline="central" text-anchor="middle" font-family="Segoe UI Emoji, sans-serif" font-size="230">${glyph}</text>
      <rect x="70" y="120" width="1460" height="380" rx="34" fill="url(#fade)"/>
      ${bar(130, 200, 160, 12, 0.6)}${bar(130, 240, 520, 44, 0.95)}${bar(130, 306, 420, 16, 0.5)}${bar(130, 334, 360, 16, 0.5)}
      <rect x="130" y="390" width="190" height="56" rx="28" fill="#fff"/><rect x="340" y="390" width="170" height="56" rx="28" fill="#fff" opacity=".14"/>`;
    const rowTitle = bar(70, 545, 220, 22, 0.9);
    const tiles = Array.from({ length: 6 }, (_, i) => tile(70 + i * 250, 590, 230, 140, i)).join("");
    const rowTitle2 = bar(70, 770, 180, 22, 0.9);
    const tiles2 = Array.from({ length: 7 }, (_, i) => tile(70 + i * 215, 815, 195, 110, i + 3)).join("");
    return svg(1600, 900, defs + top + hero + rowTitle + tiles + rowTitle2 + tiles2);
  }

  if (kind === "guide") {
    const rows = Array.from({ length: 7 }, (_, i) => {
      const y = 330 + i * 78;
      let x = 330;
      let blocks = "";
      let j = 0;
      while (x < 1530) {
        const w = Math.min(1530 - x, 160 + r() * 320);
        const on = i === 2 && j === 1;
        blocks += `<rect x="${x}" y="${y}" width="${w - 10}" height="64" rx="12" fill="${on ? a : "#fff"}" opacity="${on ? 1 : 0.07}"/>${bar(x + 18, y + 20, Math.max(40, w * 0.5), 11, on ? 0.95 : 0.55)}${bar(x + 18, y + 40, Math.max(30, w * 0.3), 8, on ? 0.7 : 0.3)}`;
        x += w;
        j++;
      }
      return `<rect x="70" y="${y}" width="240" height="64" rx="12" fill="#fff" opacity=".06"/><circle cx="110" cy="${y + 32}" r="20" fill="${tone(a, i * 40, 55)}"/>${bar(145, y + 25, 120, 13, 0.8)}${blocks}`;
    }).join("");
    const preview = `<rect x="70" y="110" width="440" height="190" rx="22" fill="url(#hero)"/><text x="290" y="205" dominant-baseline="central" text-anchor="middle" font-family="Segoe UI Emoji, sans-serif" font-size="110">${glyph}</text>
      ${bar(550, 140, 120, 12, 0.6)}${bar(550, 170, 460, 34, 0.95)}${bar(550, 222, 640, 14, 0.5)}${bar(550, 248, 520, 14, 0.5)}`;
    const now = `<rect x="${720}" y="310" width="4" height="560" fill="${a}"/><circle cx="722" cy="310" r="9" fill="${a}"/>`;
    const hours = [0, 1, 2, 3].map((i) => bar(340 + i * 300, 300, 70, 10, 0.45)).join("");
    return svg(1600, 900, defs + top + preview + hours + rows + now);
  }

  if (kind === "player") {
    const hills = Array.from({ length: 4 }, (_, i) => {
      const y = 520 + i * 70;
      const pts = Array.from({ length: 9 }, (_, k) => `${k * 200},${y - r() * 160}`).join(" ");
      return `<polygon points="0,900 ${pts} 1600,900" fill="${tone(a, i * 15 - 20, 40 - i * 8)}" opacity=".95"/>`;
    }).join("");
    const sky = `<rect width="1600" height="900" fill="url(#hero)"/><circle cx="${1100 + r() * 200}" cy="${220 + r() * 80}" r="110" fill="#fff" opacity=".85"/>`;
    const ui = `<rect width="1600" height="900" fill="url(#up)"/>${bar(80, 690, 140, 14, 0.7)}${bar(80, 720, 560, 46, 0.95)}
      <rect x="80" y="810" width="1440" height="8" rx="4" fill="#fff" opacity=".25"/><rect x="80" y="810" width="${400 + r() * 700}" height="8" rx="4" fill="${a}"/>
      <rect x="1360" y="40" width="190" height="44" rx="22" fill="#e11d48"/>${bar(1400, 55, 110, 14, 0.95)}`;
    return svg(1600, 900, defs + sky + hills + ui);
  }

  // grid
  const posters = Array.from({ length: 12 }, (_, i) => tile(70 + (i % 6) * 245, 150 + Math.floor(i / 6) * 370, 225, 340, i)).join("");
  return svg(1600, 900, defs + top + bar(70, 110, 260, 22, 0.9) + posters);
}
