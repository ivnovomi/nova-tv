/** Original vector key art for the hero. Rendered locally, works offline. */

export type ArtVariant = "games" | "apps" | "media" | "system" | "stream";

function stars(seed: number, count: number, w: number, h: number) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  return Array.from({ length: count }, (_, i) => (
    <circle
      key={i}
      cx={rnd() * w}
      cy={rnd() * h}
      r={rnd() * 1.6 + 0.3}
      fill="white"
      opacity={rnd() * 0.6 + 0.2}
      className={i % 5 === 0 ? "twinkle" : undefined}
      style={i % 5 === 0 ? { animationDelay: `${(i % 7) * 0.6}s` } : undefined}
    />
  ));
}

function GamesArt() {
  return (
    <>
      <defs>
        <linearGradient id="g-sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#0a0f2b" />
          <stop offset="0.6" stopColor="#1a1440" />
          <stop offset="1" stopColor="#2a1b3d" />
        </linearGradient>
        <radialGradient id="g-sun" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffd28a" stopOpacity="0.95" />
          <stop offset="0.35" stopColor="#ff9d4d" stopOpacity="0.45" />
          <stop offset="1" stopColor="#ff7a3d" stopOpacity="0" />
        </radialGradient>
        <filter id="g-blur">
          <feGaussianBlur stdDeviation="3" />
        </filter>
      </defs>
      <rect width="1600" height="600" fill="url(#g-sky)" />
      {stars(7, 90, 1600, 330)}
      <circle cx="1060" cy="250" r="260" fill="url(#g-sun)" />
      <g stroke="#ffcf8a" fill="none" opacity="0.85" filter="url(#g-blur)">
        <circle cx="1060" cy="250" r="118" strokeWidth="2" />
      </g>
      <g stroke="#ffe0ad" fill="none">
        <circle cx="1060" cy="250" r="118" strokeWidth="1.5" opacity="0.9" />
        <circle cx="1060" cy="250" r="92" strokeWidth="1" strokeDasharray="3 9" opacity="0.8" className="orbit" />
        <circle cx="1060" cy="250" r="150" strokeWidth="0.8" strokeDasharray="1 14" opacity="0.6" />
        <path d="M1060 60 V440 M870 250 H1250 M926 116 L1194 384 M1194 116 L926 384" strokeWidth="0.8" opacity="0.35" />
        <path d="M1060 132 L1162 309 H958 Z" strokeWidth="1.2" opacity="0.7" />
      </g>
      <path d="M0 430 L120 360 L230 400 L360 300 L470 380 L600 330 L760 410 L900 340 L1040 400 L1180 320 L1330 390 L1460 330 L1600 370 V600 H0 Z" fill="#1c1838" />
      <path d="M0 480 L160 420 L300 460 L420 410 L560 470 L720 430 L860 480 L980 440 L1120 490 L1260 440 L1400 480 L1600 430 V600 H0 Z" fill="#120f26" />
      <g fill="#0b0919">
        <rect x="1180" y="400" width="26" height="90" />
        <rect x="1214" y="370" width="18" height="120" />
        <path d="M1214 370 L1223 340 L1232 370 Z" />
        <rect x="1240" y="420" width="40" height="70" />
        <rect x="1288" y="395" width="14" height="95" />
        <path d="M1288 395 L1295 372 L1302 395 Z" />
      </g>
      <path d="M0 540 Q400 500 800 530 T1600 520 V600 H0 Z" fill="#07060f" />
      <g fill="#07060f">
        <path d="M930 530 L944 470 L952 470 L956 452 L962 452 L966 470 L974 470 L986 530 Z" />
        <path d="M950 470 L940 520 L946 520 Z" opacity="0.8" />
      </g>
    </>
  );
}

function AppsArt() {
  const tiles = [
    [980, 120, 150, 205],
    [1150, 90, 150, 255],
    [1320, 140, 150, 190],
    [900, 290, 150, 280],
    [1070, 270, 150, 170],
    [1240, 320, 150, 225],
    [1410, 300, 150, 260],
    [1000, 460, 150, 300],
    [1180, 450, 150, 200],
  ] as const;
  return (
    <>
      <defs>
        <linearGradient id="a-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#080d26" />
          <stop offset="1" stopColor="#131a4a" />
        </linearGradient>
        <filter id="a-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="22" />
        </filter>
      </defs>
      <rect width="1600" height="600" fill="url(#a-bg)" />
      {stars(21, 50, 1600, 600)}
      <g transform="skewY(-8) translate(0 120)">
        {tiles.map(([x, y, s, hue], i) => (
          <g key={i}>
            <rect x={x} y={y} width={s} height={s * 0.62} rx="18" fill={`hsl(${hue} 85% 60%)`} opacity="0.35" filter="url(#a-glow)" />
            <rect
              x={x}
              y={y}
              width={s}
              height={s * 0.62}
              rx="18"
              fill={`hsl(${hue} 60% 22% / 0.85)`}
              stroke={`hsl(${hue} 90% 72% / 0.6)`}
              strokeWidth="1.5"
            />
            <rect x={x + s / 2 - 18} y={y + s * 0.31 - 18} width="36" height="36" rx="9" fill={`hsl(${hue} 90% 75% / 0.8)`} />
          </g>
        ))}
      </g>
    </>
  );
}

function MediaArt() {
  return (
    <>
      <defs>
        <linearGradient id="m-bg" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0a0820" />
          <stop offset="1" stopColor="#1d0b2e" />
        </linearGradient>
        <filter id="m-blur" x="-20%" y="-50%" width="140%" height="200%">
          <feGaussianBlur stdDeviation="18" />
        </filter>
        <linearGradient id="m-band1" x1="0" x2="1">
          <stop offset="0" stopColor="#ff4f9a" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ff4f9a" />
          <stop offset="1" stopColor="#ff9b5a" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="m-band2" x1="0" x2="1">
          <stop offset="0" stopColor="#7c6cff" stopOpacity="0" />
          <stop offset="0.6" stopColor="#7c6cff" />
          <stop offset="1" stopColor="#3fd5f2" stopOpacity="0.4" />
        </linearGradient>
      </defs>
      <rect width="1600" height="600" fill="url(#m-bg)" />
      {stars(42, 40, 1600, 600)}
      <g filter="url(#m-blur)" opacity="0.85">
        <path d="M500 380 C760 220 980 470 1240 300 S1560 200 1650 260 V340 C1500 300 1400 380 1240 400 S760 340 500 460 Z" fill="url(#m-band1)" />
        <path d="M600 240 C850 120 1050 330 1300 190 S1550 120 1650 160 V230 C1520 200 1420 270 1290 290 S840 220 600 320 Z" fill="url(#m-band2)" />
      </g>
      <g fill="none" stroke="#ffd1e6" strokeOpacity="0.5">
        {[70, 120, 175, 235].map((r, i) => (
          <circle key={r} cx="1180" cy="300" r={r} strokeWidth={1.2 - i * 0.2} strokeDasharray={i % 2 ? "2 10" : undefined} />
        ))}
      </g>
      <path d="M1160 268 L1212 300 L1160 332 Z" fill="#fff" opacity="0.9" />
      <g fill="#ffffff" opacity="0.55">
        {Array.from({ length: 28 }, (_, i) => {
          const h = 18 + Math.abs(Math.sin(i * 1.7)) * 70;
          return <rect key={i} x={760 + i * 28} y={540 - h} width="10" height={h} rx="5" opacity={0.25 + (i % 4) * 0.12} />;
        })}
      </g>
    </>
  );
}

function SystemArt() {
  return (
    <>
      <defs>
        <radialGradient id="s-core" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#7ef0ff" stopOpacity="0.9" />
          <stop offset="0.4" stopColor="#3fd5f2" stopOpacity="0.3" />
          <stop offset="1" stopColor="#3fd5f2" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="s-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#050b1e" />
          <stop offset="1" stopColor="#0b1d33" />
        </linearGradient>
      </defs>
      <rect width="1600" height="600" fill="url(#s-bg)" />
      <g stroke="#3fd5f2" strokeOpacity="0.09">
        {Array.from({ length: 24 }, (_, i) => (
          <path key={`v${i}`} d={`M${600 + i * 44} 0 V600`} />
        ))}
        {Array.from({ length: 14 }, (_, i) => (
          <path key={`h${i}`} d={`M600 ${i * 44} H1600`} />
        ))}
      </g>
      <circle cx="1150" cy="300" r="220" fill="url(#s-core)" />
      <g fill="none" stroke="#9feaff">
        <ellipse cx="1150" cy="300" rx="260" ry="90" strokeOpacity="0.45" transform="rotate(-18 1150 300)" />
        <ellipse cx="1150" cy="300" rx="200" ry="60" strokeOpacity="0.35" transform="rotate(24 1150 300)" />
        <circle cx="1150" cy="300" r="140" strokeOpacity="0.3" strokeDasharray="2 8" className="orbit" />
        <circle cx="1150" cy="300" r="56" strokeOpacity="0.8" strokeWidth="1.5" />
      </g>
      <circle cx="1150" cy="300" r="20" fill="#e5fbff" />
      <g fill="#9feaff">
        <circle cx="1398" cy="222" r="6" />
        <circle cx="955" cy="360" r="4" />
        <circle cx="1300" cy="420" r="5" />
      </g>
    </>
  );
}

function StreamArt() {
  const beams = ["#ff2a55", "#7c6cff", "#3fd5f2", "#ffb04a"];
  return (
    <>
      <defs>
        <linearGradient id="t-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#07081a" />
          <stop offset="1" stopColor="#140a24" />
        </linearGradient>
        <linearGradient id="t-screen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2a1650" />
          <stop offset="0.5" stopColor="#5a1838" />
          <stop offset="1" stopColor="#0c2a4a" />
        </linearGradient>
        <filter id="t-blur" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="30" />
        </filter>
      </defs>
      <rect width="1600" height="600" fill="url(#t-bg)" />
      {stars(77, 40, 1600, 600)}
      <g filter="url(#t-blur)" opacity="0.7">
        {beams.map((c, i) => (
          <path key={c} d={`M1150 300 L${1600} ${i * 170 - 60} L1600 ${i * 170 + 40} Z`} fill={c} opacity="0.5" />
        ))}
        <rect x="860" y="110" width="580" height="330" rx="24" fill="#7c6cff" opacity="0.5" />
      </g>
      <rect x="860" y="110" width="580" height="330" rx="24" fill="url(#t-screen)" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="2" />
      <g opacity="0.35" fill="#fff">
        {[0, 1, 2].map((i) => (
          <rect key={i} x={900 + i * 175} y="350" width="155" height="56" rx="10" opacity={0.5 - i * 0.1} />
        ))}
      </g>
      <circle cx="1150" cy="245" r="58" fill="#ffffff" opacity="0.14" />
      <path d="M1130 212 L1182 245 L1130 278 Z" fill="#fff" />
      <rect x="1060" y="440" width="180" height="10" rx="5" fill="#ffffff" opacity="0.2" />
      <rect x="1000" y="470" width="300" height="6" rx="3" fill="#ffffff" opacity="0.1" />
    </>
  );
}

export function HeroArt({ variant }: { variant: ArtVariant }) {
  return (
    <svg
      viewBox="0 0 1600 600"
      preserveAspectRatio="xMidYMid slice"
      className="kenburns absolute inset-0 size-full"
      aria-hidden
    >
      {variant === "games" && <GamesArt />}
      {variant === "apps" && <AppsArt />}
      {variant === "media" && <MediaArt />}
      {variant === "system" && <SystemArt />}
      {variant === "stream" && <StreamArt />}
    </svg>
  );
}
