import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "@tauri-apps/api/core";
import { Volume, Volume1, Volume2, VolumeX } from "lucide-react";

/**
 * NOVA's volume bar, like a TV's: its own transparent window at the right edge
 * of the screen (osd.rs shows and hides it). It only shows what it's told.
 */

interface VolumeState {
  level: number;
  muted: boolean;
}

const EASE = [0.22, 1, 0.36, 1] as const;
const FONT = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';

function Icon({ level, muted }: VolumeState) {
  const props = { size: 26, strokeWidth: 2.2, color: muted ? "#ff8aa0" : "#f4f6ff" };
  if (muted || level === 0) return <VolumeX {...props} />;
  if (level < 34) return <Volume {...props} />;
  if (level < 67) return <Volume1 {...props} />;
  return <Volume2 {...props} />;
}

function Bar() {
  // Outside NOVA (a browser, to work on the design): an example bar.
  const [state, setState] = useState<VolumeState | null>(isTauri() ? null : { level: 62, muted: false });
  const [visible, setVisible] = useState(!isTauri());

  useEffect(() => {
    if (!isTauri()) return;
    const offs = [
      listen<VolumeState>("volume-osd", ({ payload }) => {
        setState(payload);
        setVisible(true);
      }),
      listen("volume-osd-hide", () => setVisible(false)),
    ];
    return () => offs.forEach((o) => void o.then((f) => f()));
  }, []);

  const level = state?.level ?? 0;
  const muted = state?.muted ?? false;
  const fill = muted ? 0 : level;

  return (
    <div style={{ height: "100vh", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 16, fontFamily: FONT }}>
      <AnimatePresence>
        {visible && state && (
          <motion.div
            key="bar"
            initial={{ opacity: 0, x: 40, scale: 0.96 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 40, scale: 0.96, transition: { duration: 0.3 } }}
            transition={{ duration: 0.35, ease: EASE }}
            role="status"
            aria-label={muted ? "Sonido silenciado" : `Volumen ${level}`}
            style={{
              width: 76,
              height: 380,
              borderRadius: 38,
              padding: "18px 0 20px",
              boxSizing: "border-box",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 14,
              background: "linear-gradient(170deg, rgba(24,34,77,0.92), rgba(8,12,28,0.94))",
              border: "1px solid rgba(148,163,255,0.22)",
              boxShadow: "0 18px 50px -12px rgba(0,0,0,0.85), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}
          >
            {/* The number, ticking as it changes */}
            <div style={{ height: 30, overflow: "hidden", position: "relative", width: "100%", textAlign: "center" }}>
              <AnimatePresence mode="popLayout" initial={false}>
                <motion.span
                  key={muted ? "mute" : level}
                  initial={{ y: 14, opacity: 0 }}
                  animate={{ y: 0, opacity: 1 }}
                  exit={{ y: -14, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  style={{ display: "block", color: muted ? "#ff8aa0" : "#f4f6ff", fontSize: muted ? 13 : 24, fontWeight: 650, lineHeight: "30px", fontVariantNumeric: "tabular-nums", letterSpacing: muted ? "0.08em" : 0 }}
                >
                  {muted ? "MUTE" : level}
                </motion.span>
              </AnimatePresence>
            </div>

            {/* The track, filling from the bottom */}
            <div style={{ position: "relative", flex: 1, width: 12, borderRadius: 6, background: "rgba(255,255,255,0.12)", overflow: "hidden" }}>
              <motion.div
                initial={false}
                animate={{ height: `${fill}%` }}
                transition={{ type: "spring", stiffness: 420, damping: 38 }}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  bottom: 0,
                  borderRadius: 6,
                  background: "linear-gradient(0deg, #6e6cff, #3fd5f2)",
                  boxShadow: "0 0 18px rgba(63,213,242,0.65)",
                }}
              />
            </div>

            <Icon level={level} muted={muted} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <MotionConfig reducedMotion="user">
      <Bar />
    </MotionConfig>
  </React.StrictMode>,
);
