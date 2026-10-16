import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Music, Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { api } from "../lib/api";
import { useNowPlaying } from "../hooks/useLiveData";
import { useToast } from "./Toasts";

function clock(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

/** "Now playing" from any Windows app, with real transport controls. */
export function NowPlayingCard() {
  const now = useNowPlaying();
  const toast = useToast();
  // Windows reports position every ~1.5 s; advance smoothly in between.
  const [position, setPosition] = useState<number | null>(null);

  useEffect(() => {
    setPosition(now?.position ?? null);
    if (!now?.playing || now.position == null) return;
    const start = performance.now();
    const base = now.position;
    const t = window.setInterval(() => {
      setPosition(Math.min(now.duration ?? Infinity, base + (performance.now() - start) / 1000));
    }, 500);
    return () => window.clearInterval(t);
  }, [now]);

  const control = (action: "playpause" | "next" | "prev") =>
    api.mediaControl(action).catch((e: Error) => toast.show("error", `${now?.app ?? "La app"} no aceptó la orden`, e.message));

  const pct = now?.duration && position != null ? Math.min(100, (position / now.duration) * 100) : null;

  return (
    <AnimatePresence initial={false}>
      {now && (
        <motion.section
          key="now-playing"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden px-[var(--gutter)]"
          aria-label="Ahora suena"
        >
          <div className="surface relative mt-8 flex items-center gap-6 overflow-hidden rounded-[var(--radius-card)] p-5 pr-7">
            {now.artwork && (
              <img src={now.artwork} alt="" aria-hidden className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-25 blur-3xl" />
            )}
            <span className="relative grid size-[6.5rem] shrink-0 place-items-center overflow-hidden rounded-2xl bg-white/8 shadow-[0_0.8rem_2rem_-0.8rem_rgb(0_0_0/0.8)]">
              {now.artwork ? <img src={now.artwork} alt="" className="size-full object-cover" /> : <Music className="size-10 text-ink-2" />}
            </span>
            <div className="relative min-w-0 flex-1">
              <p className="eyebrow flex items-center gap-2 text-cyan">
                {now.playing && (
                  <span className="flex h-3 items-end gap-[2px]" aria-hidden>
                    {[0, 1, 2].map((i) => (
                      <motion.span
                        key={i}
                        className="w-[3px] rounded-full bg-cyan"
                        animate={{ height: ["30%", "100%", "45%", "80%", "30%"] }}
                        transition={{ duration: 1.1, repeat: Infinity, delay: i * 0.18 }}
                      />
                    ))}
                  </span>
                )}
                {now.playing ? "Ahora suena" : "En pausa"} · {now.app}
              </p>
              <p className="mt-1.5 truncate text-[1.6rem] font-semibold">{now.title}</p>
              {(now.artist || now.album) && (
                <p className="truncate text-[1.05rem] text-ink-2">{[now.artist, now.album].filter(Boolean).join(" · ")}</p>
              )}
              {pct != null && position != null && now.duration != null && (
                <div className="mt-3 flex items-center gap-3 text-[0.85rem] tabular-nums text-ink-3">
                  <span>{clock(position)}</span>
                  <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-[linear-gradient(90deg,#6e6cff,#3fd5f2)]" style={{ width: `${pct}%` }} />
                  </span>
                  <span>{clock(now.duration)}</span>
                </div>
              )}
            </div>
            <div className="relative flex shrink-0 items-center gap-3">
              <button data-nav aria-label="Anterior" disabled={!now.canSkip} onClick={() => control("prev")} className="focus-lift grid size-[3.6rem] place-items-center rounded-full bg-white/8">
                <SkipBack className="size-6" fill="currentColor" />
              </button>
              <button data-nav aria-label={now.playing ? "Pausar" : "Reproducir"} onClick={() => control("playpause")} className="focus-lift grid size-[4.4rem] place-items-center rounded-full bg-white text-black">
                {now.playing ? <Pause className="size-7" fill="currentColor" /> : <Play className="size-7 translate-x-0.5" fill="currentColor" />}
              </button>
              <button data-nav aria-label="Siguiente" disabled={!now.canSkip} onClick={() => control("next")} className="focus-lift grid size-[3.6rem] place-items-center rounded-full bg-white/8">
                <SkipForward className="size-6" fill="currentColor" />
              </button>
            </div>
          </div>
        </motion.section>
      )}
    </AnimatePresence>
  );
}
