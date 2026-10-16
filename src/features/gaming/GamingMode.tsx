import { Component, useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { BatteryLow, Gamepad2 } from "lucide-react";
import { inTauri } from "../../lib/api";
import { GamingHome } from "./GamingHome";
import { shortPadName } from "./PadStatus";
import { sfx } from "./sfx";
import { useGamepads, type Pad } from "./useGamepads";

/** NOVA PLAY accent: the focus ring turns green inside Gaming Mode. */
const THEME = {
  "--color-focus": "#5cff8f",
  "--shadow-focus": "0 0 0 0.2rem #020407, 0 0 0 0.42rem #5cff8f, 0 1.4rem 3.2rem -0.8rem rgb(92 255 143 / 0.45)",
} as CSSProperties;

const INTRO_MS = 900;
const LOW_BATTERY = 15;

/** If anything inside Gaming Mode throws, leave it instead of showing a black screen. */
class Guard extends Component<{ onCrash: (e: Error) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    this.props.onCrash(error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** A short, non-blocking entrance: the home is already there underneath. */
function Intro() {
  const reduce = useReducedMotion();
  return (
    <motion.div
      className="pointer-events-none fixed inset-0 z-[70] grid place-items-center bg-[#020407]"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.45 } }}
      aria-hidden
    >
      <motion.span
        className="absolute size-[40rem] rounded-full"
        style={{ background: "radial-gradient(circle, rgb(92 255 143 / 0.35), rgb(63 213 242 / 0.12) 45%, transparent 70%)" }}
        initial={{ scale: 0.3, opacity: 0 }}
        animate={{ scale: reduce ? 1 : 1.6, opacity: [0, 1, 0.6] }}
        transition={{ duration: INTRO_MS / 1000, ease: "easeOut" }}
      />
      <motion.p
        className="relative text-[3.4rem] font-semibold text-white"
        initial={{ opacity: 0, letterSpacing: "0.9em" }}
        animate={{ opacity: 1, letterSpacing: "0.38em" }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        NOVA <span className="bg-[linear-gradient(90deg,#5cff8f,#3fd5f2)] bg-clip-text text-transparent">PLAY</span>
      </motion.p>
    </motion.div>
  );
}

type Notice = { key: number; tone: "ok" | "warn"; title: string; detail?: string };

/** Controller connected / disconnected / low battery: a small pill, never a blocking screen. */
function usePadNotices(pads: Pad[]) {
  const [notice, setNotice] = useState<Notice | null>(null);
  const prev = useRef<Pad[] | null>(null);
  const warned = useRef(new Set<string>());
  useEffect(() => {
    const before = prev.current;
    prev.current = pads;
    const show = (n: Omit<Notice, "key">) => setNotice({ ...n, key: Date.now() });
    if (before) {
      const added = pads.find((p) => !before.some((b) => b.source === p.source && b.id === p.id));
      const removed = before.find((b) => !pads.some((p) => p.source === b.source && p.id === b.id));
      if (added) {
        sfx.success();
        show({ tone: "ok", title: `${shortPadName(added.name)} conectado` });
      } else if (removed) {
        show({ tone: "warn", title: `${shortPadName(removed.name)} desconectado`, detail: pads.length ? undefined : "Puedes seguir con teclado y ratón." });
      }
    }
    for (const p of pads) {
      const id = `${p.source}-${p.id}`;
      if (p.battery != null && p.battery <= LOW_BATTERY && !p.charging && !p.wired && !warned.current.has(id)) {
        warned.current.add(id);
        show({ tone: "warn", title: "Batería baja", detail: `${shortPadName(p.name)} · ${p.battery}%` });
      }
    }
  }, [pads]);
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 3200);
    return () => window.clearTimeout(t);
  }, [notice]);
  return notice;
}

function GamingFlow({ onExit }: { onExit: () => void }) {
  const pads = useGamepads();
  const notice = usePadNotices(pads);
  const [intro, setIntro] = useState(true);
  const [leaving, setLeaving] = useState(false);
  const exiting = useRef(false);

  // Console feel: full screen while in Gaming Mode, restored on the way out.
  useEffect(() => {
    sfx.boot();
    const t = window.setTimeout(() => setIntro(false), INTRO_MS);
    if (!inTauri) return () => window.clearTimeout(t);
    const win = getCurrentWindow();
    let wasFullscreen = true;
    win.isFullscreen().then(
      (fs) => {
        wasFullscreen = fs;
        if (!fs) void win.setFullscreen(true).catch(() => {});
      },
      () => {},
    );
    return () => {
      window.clearTimeout(t);
      if (!wasFullscreen) void win.setFullscreen(false).catch(() => {});
    };
  }, []);

  const exit = useCallback(() => {
    if (exiting.current) return;
    exiting.current = true;
    sfx.back();
    setLeaving(true);
    window.setTimeout(onExit, 450);
  }, [onExit]);

  return (
    <div className="nova-play" style={THEME} onClickCapture={() => sfx.select()}>
      <GamingHome pads={pads} ready={!intro} onExit={exit} />

      <AnimatePresence>{intro && <Intro key="intro" />}</AnimatePresence>

      <AnimatePresence>
        {notice && (
          <motion.div
            key={notice.key}
            role="status"
            className="pointer-events-none fixed left-1/2 top-[1.4rem] z-[60] flex -translate-x-1/2 items-center gap-3 rounded-full border border-white/15 bg-black/75 py-2.5 pl-2.5 pr-6 text-white backdrop-blur-xl"
            initial={{ opacity: 0, y: -14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
          >
            <span className={`grid size-9 place-items-center rounded-full ${notice.tone === "ok" ? "bg-[#5cff8f] text-[#04120a]" : "bg-[#ffb547] text-[#2a1a04]"}`}>
              {notice.title === "Batería baja" ? <BatteryLow className="size-5" /> : <Gamepad2 className="size-5" />}
            </span>
            <span>
              <span className="block text-[1.05rem] font-semibold">{notice.title}</span>
              {notice.detail && <span className="block text-[0.9rem] text-white/65">{notice.detail}</span>}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {leaving && (
          <motion.div key="leave" className="fixed inset-0 z-[70] bg-black" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} />
        )}
      </AnimatePresence>
    </div>
  );
}

export function GamingMode({ onExit, onCrash }: { onExit: () => void; onCrash: (e: Error) => void }) {
  return (
    <Guard onCrash={onCrash}>
      <GamingFlow onExit={onExit} />
    </Guard>
  );
}
