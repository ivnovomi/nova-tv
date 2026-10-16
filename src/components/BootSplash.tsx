import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { createBootSound, type BootSound } from "../app/bootSound";
import { liveTv, useLiveTv } from "../features/livetv/store";

/** Four lights that drift in and merge, like a TV waking up. */
const ORBS = [
  { color: "#6e6cff", from: [-38, -30] },
  { color: "#3fd5f2", from: [36, -26] },
  { color: "#b46bff", from: [-30, 32] },
  { color: "#ff5c9a", from: [34, 30] },
] as const;

const LETTERS = [
  "M3 37 V3 L31 37 V3",
  "M66 3 a17 17 0 1 0 0.01 0",
  "M96 3 L113 37 L130 3",
  "M140 37 L157 3 L174 37",
];

const INTRO_MS = 3000;
/** Never keep anyone waiting longer than this, whatever the network does. */
const MAX_MS = 14000;
/** Channels tried in a row when the last one has no signal. */
const MAX_RETUNES = 6;

type Phase = "dark" | "intro" | "hold";

interface Props {
  /** The library (apps, games, services) has loaded, or failed to. */
  libraryReady: boolean;
  /** NOVA starts on live TV, so the splash waits for a picture. */
  tv: boolean;
  onDone: () => void;
}

/**
 * NOVA's start-up. A synthesised signature sound plays in sync with the
 * lights and the wordmark; then the logo stays, breathing, while NOVA really
 * does its start-up work (finding channels, tuning one with signal — skipping
 * dead ones — and loading the library). No progress bars: just what's
 * happening, in a few words. It dissolves into the live picture with a chime.
 * Any key, click or controller button skips it.
 */
export function BootSplash({ libraryReady, tv, onDone }: Props) {
  const reduce = useReducedMotion();
  const [phase, setPhase] = useState<Phase>("dark");
  const [introDone, setIntroDone] = useState(false);
  const [gaveUp, setGaveUp] = useState(false);
  const sound = useRef<BootSound | null>(null);
  const done = useRef(false);
  const retunes = useRef(0);
  const finishRef = useRef<() => void>(() => {});

  const tvState = useLiveTv();
  const channel = tvState.data?.channels.find((c) => c.id === tvState.playing);
  const signal = tvState.signal;
  const noChannels = !!tvState.error || (!!tvState.data && tvState.data.channels.length === 0);
  const tuned = !tv || noChannels || gaveUp || (!!channel && signal?.id === channel.id && signal.ok);
  const ready = libraryReady && tuned;

  finishRef.current = () => {
    if (done.current) return;
    done.current = true;
    sound.current?.chime();
    sound.current?.dispose();
    liveTv.setHold(false);
    onDone();
  };

  // Dark → intro: wait (briefly) for the audio engine so sound and picture start together.
  useEffect(() => {
    liveTv.setHold(true);
    let cancelled = false;
    let started = false;
    const start = () => {
      if (cancelled || started) return;
      started = true;
      // Skipped before the intro began: the splash is fading out, so no sound at all.
      if (done.current) {
        sound.current?.dispose();
        sound.current = null;
        return;
      }
      sound.current?.play();
      setPhase("intro");
    };
    void createBootSound().then((s) => {
      if (cancelled || started || done.current) return s?.dispose();
      sound.current = s;
      start();
    });
    const fallback = window.setTimeout(start, 700);
    const cap = window.setTimeout(() => finishRef.current(), MAX_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(fallback);
      window.clearTimeout(cap);
      liveTv.setHold(false);
    };
  }, []);

  useEffect(() => {
    if (phase !== "intro") return;
    const t = window.setTimeout(() => {
      setIntroDone(true);
      setPhase("hold");
    }, reduce ? 700 : INTRO_MS);
    return () => window.clearTimeout(t);
  }, [phase, reduce]);

  // Real auto-tuning: a channel without signal is skipped for the next one that has it.
  useEffect(() => {
    if (!tv || done.current || !signal || signal.ok || signal.id !== tvState.playing) return;
    if (retunes.current >= MAX_RETUNES) {
      setGaveUp(true); // the TV shows its own "no signal" screen from here
      return;
    }
    retunes.current += 1;
    liveTv.zap(1);
  }, [tv, signal, tvState.playing]);

  useEffect(() => {
    if (introDone && ready) finishRef.current();
  }, [introDone, ready]);

  // Skipping: keys never reach the TV underneath while the splash is up.
  useEffect(() => {
    const armAt = performance.now() + 400;
    const skip = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (performance.now() > armAt) finishRef.current();
    };
    window.addEventListener("keydown", skip, true);
    window.addEventListener("pointerdown", skip, true);
    let raf = 0;
    const poll = () => {
      raf = requestAnimationFrame(poll);
      if (performance.now() > armAt && (navigator.getGamepads?.() ?? []).some((p) => p?.buttons.some((b) => b.pressed))) finishRef.current();
    };
    raf = requestAnimationFrame(poll);
    return () => {
      window.removeEventListener("keydown", skip, true);
      window.removeEventListener("pointerdown", skip, true);
      cancelAnimationFrame(raf);
    };
  }, []);

  // What NOVA is doing right now, in plain words.
  const status = !tv
    ? libraryReady
      ? "Listo"
      : "Preparando tu biblioteca"
    : !tvState.data && !noChannels
      ? "Buscando canales"
      : channel && !tuned
        ? retunes.current > 0
          ? `Sin señal · probando ${channel.number} ${channel.name}`
          : `Sintonizando ${channel.number} · ${channel.name}`
        : !libraryReady
          ? "Preparando tu biblioteca"
          : "Listo";

  return (
    <motion.div
      className="fixed inset-0 z-[80] grid place-items-center overflow-hidden bg-[#020309]"
      exit={{ opacity: 0, scale: 1.04, transition: { duration: 0.7, ease: [0.22, 1, 0.36, 1] } }}
      aria-label="Iniciando NOVA TV"
      role="status"
    >
      {phase !== "dark" && (
        <>
          {!reduce &&
            ORBS.map((o, i) => (
              <motion.span
                key={o.color}
                className="absolute size-[38vmin] rounded-full blur-[70px]"
                style={{ background: o.color }}
                initial={{ x: `${o.from[0]}vw`, y: `${o.from[1]}vh`, opacity: 0, scale: 0.6 }}
                animate={{ x: [`${o.from[0]}vw`, "0vw", "0vw"], y: [`${o.from[1]}vh`, "0vh", "0vh"], opacity: [0, 0.75, 0], scale: [0.6, 1, 2.4] }}
                transition={{ duration: 2.4, delay: i * 0.08, times: [0, 0.55, 1], ease: [0.65, 0, 0.35, 1] }}
              />
            ))}

          {/* While NOVA works: a slow aura behind the logo, like a standby light. */}
          <AnimatePresence>
            {phase === "hold" && !reduce && (
              <motion.span
                key="aura"
                aria-hidden
                className="absolute size-[56vmin] rounded-full bg-[conic-gradient(from_0deg,#6e6cff,#3fd5f2,#b46bff,#ff5c9a,#6e6cff)] blur-[90px]"
                initial={{ opacity: 0, scale: 0.7, rotate: 0 }}
                animate={{ opacity: [0.1, 0.24, 0.1], scale: [0.85, 1, 0.85], rotate: 360 }}
                exit={{ opacity: 0 }}
                transition={{ opacity: { duration: 3.2, repeat: Infinity, ease: "easeInOut" }, scale: { duration: 3.2, repeat: Infinity, ease: "easeInOut" }, rotate: { duration: 12, repeat: Infinity, ease: "linear" } }}
              />
            )}
          </AnimatePresence>

          <motion.div
            className="relative flex items-start gap-[1.4vmin]"
            animate={phase === "hold" && !reduce ? { scale: [1, 1.015, 1] } : { scale: 1 }}
            transition={phase === "hold" ? { duration: 3.2, repeat: Infinity, ease: "easeInOut" } : undefined}
          >
            <svg viewBox="0 0 176 40" className="h-[9vmin] w-auto overflow-visible" aria-hidden>
              <defs>
                <linearGradient id="boot-wm" x1="0" y1="1" x2="1" y2="0">
                  <stop offset="0" stopColor="#6e6cff" />
                  <stop offset="1" stopColor="#3fd5f2" />
                </linearGradient>
                <filter id="boot-wm-glow" x="-20%" y="-60%" width="140%" height="220%">
                  <feGaussianBlur stdDeviation="2.4" result="b" />
                  <feMerge>
                    <feMergeNode in="b" />
                    <feMergeNode in="SourceGraphic" />
                  </feMerge>
                </filter>
              </defs>
              {LETTERS.map((d, i) => (
                <motion.path
                  key={d}
                  d={d}
                  fill="none"
                  stroke={i === 3 ? "url(#boot-wm)" : "#f4f6ff"}
                  strokeWidth="4.6"
                  strokeLinecap="square"
                  filter="url(#boot-wm-glow)"
                  initial={{ pathLength: 0, opacity: 0 }}
                  animate={{ pathLength: 1, opacity: 1 }}
                  transition={{ duration: reduce ? 0.2 : 0.7, delay: reduce ? 0 : 0.7 + i * 0.16, ease: [0.65, 0, 0.35, 1] }}
                />
              ))}
            </svg>
            <motion.span
              className="text-[3.2vmin] font-semibold tracking-[0.25em] text-white/70"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: reduce ? 0.1 : 1.6, duration: 0.5 }}
            >
              TV
            </motion.span>
          </motion.div>

          {/* Light sweep across the logo */}
          {!reduce && (
            <motion.span
              aria-hidden
              className="pointer-events-none absolute h-[30vmin] w-[16vmin] rotate-12 bg-[linear-gradient(90deg,transparent,rgb(255_255_255/0.35),transparent)] blur-md"
              initial={{ x: "-40vw", opacity: 0 }}
              animate={{ x: "40vw", opacity: [0, 1, 0] }}
              transition={{ delay: 1.9, duration: 0.9, ease: "easeInOut" }}
            />
          )}

          <div className="absolute bottom-[10vh] h-[3vmin] text-[2.2vmin] tracking-[0.3em] text-white/40">
            <AnimatePresence mode="wait">
              <motion.p
                key={phase === "hold" ? status : "tagline"}
                className="whitespace-nowrap uppercase"
                initial={{ opacity: 0, y: 6, filter: "blur(4px)" }}
                animate={phase === "hold" ? { opacity: [0.35, 0.75, 0.35], y: 0, filter: "blur(0px)" } : { opacity: 1, y: 0, filter: "blur(0px)" }}
                exit={{ opacity: 0, y: -6, filter: "blur(4px)" }}
                transition={
                  phase === "hold"
                    ? { opacity: { duration: 2.4, repeat: Infinity, ease: "easeInOut" }, default: { duration: 0.35 } }
                    : { delay: reduce ? 0.1 : 2, duration: 0.5 }
                }
              >
                {phase === "hold" ? status : "Tu PC, como una Smart TV"}
              </motion.p>
            </AnimatePresence>
          </div>
        </>
      )}
    </motion.div>
  );
}
