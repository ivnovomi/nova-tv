import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Music } from "lucide-react";
import { power } from "../app/power";
import { useNova } from "../app/context";
import { api } from "../lib/api";
import { formatDate, formatTime, useClock } from "../hooks/useClock";
import { useNowPlaying } from "../hooks/useLiveData";
import { liveTv, useLiveTv } from "./livetv/store";
import { Wordmark } from "../components/Chrome";

const SLIDE_MS = 14_000;
/** The clock moves to a new spot every minute, so nothing burns into the screen. */
const SPOTS = [
  "left-[8%] bottom-[12%]",
  "right-[8%] bottom-[12%] items-end text-right",
  "left-[8%] top-[14%]",
  "right-[8%] top-[14%] items-end text-right",
  "left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 items-center text-center",
];

/** Art from what's in NOVA: game backgrounds and your YouTube videos. */
function useArtwork(): string[] {
  const nova = useNova();
  const [games, setGames] = useState<string[]>([]);
  const [plugins, setPlugins] = useState<string[]>([]);
  useEffect(() => {
    api.gameMetadata().then(
      (meta) => setGames(Object.values(meta).flatMap((m) => (m.hero ? [m.hero] : []))),
      () => {},
    );
    // Plugins with `screensaver` add their own backgrounds.
    api.pluginsScreensaver().then(setPlugins, () => {});
  }, []);
  return useMemo(() => {
    const videos = nova.feed.map((f) => f.thumbnail).concat(nova.history.flatMap((h) => (h.thumbnail ? [h.thumbnail] : [])));
    const all = [...new Set([...plugins, ...games, ...videos])];
    // Shuffled once per screensaver.
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    return all.slice(0, 40);
  }, [plugins, games, nova.feed, nova.history]);
}

function Slides({ images }: { images: string[] }) {
  const [index, setIndex] = useState(0);
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const usable = images.filter((i) => !broken.has(i));
  useEffect(() => {
    if (usable.length < 2) return;
    const t = window.setInterval(() => setIndex((i) => i + 1), SLIDE_MS);
    return () => window.clearInterval(t);
  }, [usable.length]);
  const src = usable.length ? usable[index % usable.length] : null;
  return (
    <AnimatePresence>
      {src && (
        <motion.img
          key={src}
          src={src}
          alt=""
          onError={() => setBroken((b) => new Set(b).add(src))}
          className="absolute inset-0 size-full object-cover"
          initial={{ opacity: 0, scale: 1.02 }}
          animate={{ opacity: 0.55, scale: 1.12, transition: { opacity: { duration: 2.4 }, scale: { duration: SLIDE_MS / 1000 + 3, ease: "linear" } } }}
          exit={{ opacity: 0, transition: { duration: 2.4 } }}
        />
      )}
    </AnimatePresence>
  );
}

/** With nothing to show: slow aurora of NOVA's colours. */
function Aurora() {
  return (
    <div aria-hidden className="absolute inset-0 overflow-hidden">
      {[
        ["#6e6cff", "-10%", "-10%", 26],
        ["#3fd5f2", "50%", "40%", 32],
        ["#9a6bff", "20%", "60%", 38],
      ].map(([color, x, y, dur], i) => (
        <motion.span
          key={i}
          className="absolute size-[60vmax] rounded-full opacity-25 blur-[120px]"
          style={{ background: color as string, left: x as string, top: y as string }}
          animate={{ x: ["0vw", "18vw", "-8vw", "0vw"], y: ["0vh", "-12vh", "10vh", "0vh"] }}
          transition={{ duration: dur as number, repeat: Infinity, ease: "easeInOut" }}
        />
      ))}
    </div>
  );
}

/**
 * Turns the TV back on after the screensaver, as it was (full screen or in a
 * corner), once no power menu or countdown is in front. Never while turning off.
 */
function resumeTv(pip: boolean) {
  const tryNow = () => {
    if (power.isLeaving() || liveTv.isOpen()) return true; // turning off, or already back on
    if (power.isBusy() || power.isSaving()) return false;
    void liveTv.open();
    if (pip) liveTv.minimize();
    return true;
  };
  if (tryNow()) return;
  const off = power.subscribe(() => {
    if (tryNow()) off();
  });
}

/**
 * "Suspender": NOVA's screensaver. Clock, date and what's playing over slowly
 * moving art. Live TV stops while it's on (and comes back after). Any key,
 * click, controller button or the phone wakes it, and that press does nothing else.
 */
export function Screensaver({ tvWasOn }: { tvWasOn: boolean }) {
  const now = useClock();
  const images = useArtwork();
  const playing = useNowPlaying();
  const { pip } = useLiveTv();
  const resume = useRef({ on: tvWasOn, pip });
  const [spot, setSpot] = useState(0);
  const [hint, setHint] = useState(true);

  useEffect(() => {
    if (resume.current.on) liveTv.close();
    const started = Date.now();
    const start = { x: -1, y: -1 };
    const wake = (e: Event) => {
      // The click or key that started it shouldn't end it.
      if (Date.now() - started < 800) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      power.screensaver(false);
    };
    const move = (e: PointerEvent) => {
      if (start.x < 0) {
        start.x = e.clientX;
        start.y = e.clientY;
      } else if (Math.hypot(e.clientX - start.x, e.clientY - start.y) > 40) wake(e);
    };
    window.addEventListener("keydown", wake, { capture: true });
    window.addEventListener("pointerdown", wake, { capture: true });
    window.addEventListener("wheel", wake, { capture: true });
    window.addEventListener("pointermove", move, { capture: true });
    const hintTimer = window.setTimeout(() => setHint(false), 5000);
    const spotTimer = window.setInterval(() => setSpot((s) => (s + 1 + Math.floor(Math.random() * (SPOTS.length - 1))) % SPOTS.length), 60_000);
    (document.activeElement as HTMLElement | null)?.blur();
    return () => {
      window.removeEventListener("keydown", wake, { capture: true });
      window.removeEventListener("pointerdown", wake, { capture: true });
      window.removeEventListener("wheel", wake, { capture: true });
      window.removeEventListener("pointermove", move, { capture: true });
      window.clearTimeout(hintTimer);
      window.clearInterval(spotTimer);
      if (resume.current.on) resumeTv(resume.current.pip);
    };
  }, []);

  return createPortal(
    <motion.div
      role="dialog"
      aria-label="Salvapantallas"
      className="fixed inset-0 z-[92] cursor-none overflow-hidden bg-black"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1, transition: { duration: 1.2 } }}
      exit={{ opacity: 0, transition: { duration: 0.45 } }}
    >
      {images.length ? <Slides images={images} /> : <Aurora />}
      <span aria-hidden className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_30%,rgb(0_0_0/0.75)_100%),linear-gradient(to_top,rgb(0_0_0/0.7),transparent_55%)]" />

      <AnimatePresence mode="wait">
        <motion.div
          key={spot}
          className={`absolute flex flex-col ${SPOTS[spot]}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1, transition: { duration: 1.6 } }}
          exit={{ opacity: 0, transition: { duration: 1.2 } }}
        >
          <p className="text-[8.5rem] font-light leading-none tracking-tight tabular-nums text-white/95 [text-shadow:0_0.4rem_3rem_rgb(0_0_0/0.6)]">{formatTime(now)}</p>
          <p className="mt-3 text-[1.7rem] font-medium capitalize text-white/75">{formatDate(now)}</p>
          {playing && (
            <div className="mt-7 flex items-center gap-4 rounded-full bg-black/35 py-2 pl-2 pr-6 backdrop-blur">
              <span className="grid size-[3.2rem] place-items-center overflow-hidden rounded-full bg-white/10">
                {playing.artwork ? <img src={playing.artwork} alt="" className="size-full object-cover" /> : <Music className="size-5" />}
              </span>
              <span className="min-w-0 text-left leading-tight">
                <span className="block max-w-[24rem] truncate text-[1.15rem] font-semibold">{playing.title}</span>
                <span className="block max-w-[24rem] truncate text-[0.95rem] text-white/60">{playing.artist ?? playing.app}</span>
              </span>
            </div>
          )}
        </motion.div>
      </AnimatePresence>

      <div className="absolute bottom-[5%] left-1/2 -translate-x-1/2 opacity-60">
        <Wordmark />
      </div>
      <AnimatePresence>
        {hint && (
          <motion.p className="absolute left-1/2 top-[6%] -translate-x-1/2 rounded-full bg-black/40 px-5 py-2 text-[1.05rem] text-white/80 backdrop-blur" initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            Pulsa cualquier botón para volver
          </motion.p>
        )}
      </AnimatePresence>
    </motion.div>,
    document.body,
  );
}
