import { motion } from "motion/react";

/** Original controller illustration. `lit` switches it to the connected look. */
export function ControllerArt({ lit, className = "" }: { lit: boolean; className?: string }) {
  const stroke = lit ? "url(#pad-grad)" : "rgb(255 255 255 / 0.35)";
  return (
    <svg viewBox="0 0 240 180" className={className} aria-hidden>
      <defs>
        <linearGradient id="pad-grad" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#5cff8f" />
          <stop offset="1" stopColor="#3fd5f2" />
        </linearGradient>
        <filter id="pad-glow" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="5" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <g filter={lit ? "url(#pad-glow)" : undefined} fill="none" stroke={stroke} strokeWidth="4" strokeLinejoin="round">
        <path
          d="M62 34 C40 34 26 52 18 86 C10 122 14 156 38 160 C56 163 66 146 78 128 L162 128 C174 146 184 163 202 160 C226 156 230 122 222 86 C214 52 200 34 178 34 C160 34 152 44 120 44 C88 44 80 34 62 34 Z"
          fill={lit ? "rgb(92 255 143 / 0.06)" : "rgb(255 255 255 / 0.03)"}
        />
        <circle cx="72" cy="72" r="15" />
        <circle cx="146" cy="104" r="13" />
        <path d="M86 100 h8 v-8 h8 v8 h8 v8 h-8 v8 h-8 v-8 h-8 z" strokeWidth="3" />
      </g>
      {/* Face buttons keep their colours, dimmed until connected */}
      <g opacity={lit ? 1 : 0.35}>
        <circle cx="172" cy="84" r="7" fill="#5cff8f" />
        <circle cx="186" cy="70" r="7" fill="#ff5c7a" />
        <circle cx="158" cy="70" r="7" fill="#4fa8ff" />
        <circle cx="172" cy="56" r="7" fill="#ffd34f" />
      </g>
      <motion.circle
        cx="120"
        cy="62"
        r="9"
        fill={lit ? "#eafff2" : "rgb(255 255 255 / 0.25)"}
        animate={lit ? { opacity: [1, 0.5, 1] } : { opacity: 1 }}
        transition={lit ? { duration: 1.6, repeat: Infinity } : undefined}
      />
    </svg>
  );
}
