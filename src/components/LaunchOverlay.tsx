import { motion } from "motion/react";
import type { Shortcut } from "../lib/types";
import { streamStyle } from "./Tiles";

export type OverlayState = { phase: "opening" | "returning"; item?: Shortcut; name: string } | null;

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-grid h-[2.2rem] min-w-[2.2rem] place-items-center rounded-lg border border-white/25 bg-white/10 px-2.5 font-sans text-[1rem] font-semibold text-white">
      {children}
    </kbd>
  );
}

/** Full-screen brand transition shown while NOVA hands off to a streaming service and back. */
export function LaunchOverlay({ state }: { state: NonNullable<OverlayState> }) {
  const style = state.item ? streamStyle(state.item) : null;
  const opening = state.phase === "opening";
  return (
    <motion.div
      className="fixed inset-0 z-[60] grid place-items-center"
      style={{ background: opening && style ? style.bg : "var(--color-bg-0)" }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.45 } }}
      transition={{ duration: 0.3 }}
      aria-live="polite"
    >
      <div className="ambient opacity-60" />
      <div className="relative flex flex-col items-center text-center">
        <motion.p
          initial={{ scale: 0.92, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className={`text-[6rem] leading-none ${opening && style ? `${style.text} ${style.font ?? ""}` : "font-light tracking-[0.3em] text-white"}`}
        >
          {opening ? state.name : "NOVA TV"}
        </motion.p>
        <div className="mt-10 h-1 w-[18rem] overflow-hidden rounded-full bg-white/15">
          <motion.div
            className="h-full w-1/3 rounded-full bg-white/80"
            initial={{ x: "-100%" }}
            animate={{ x: "300%" }}
            transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
        <p className="mt-6 text-[1.3rem] text-white/75">
          {opening ? `Abriendo ${state.name}…` : `Has salido de ${state.name}`}
        </p>
        {opening && (
          <p className="mt-12 flex flex-wrap items-center justify-center gap-3 text-[1.1rem] text-white/70">
            Para volver a NOVA TV: <Key>View</Key> + <Key>Menu</Key> en el mando · tecla <Key>Inicio</Key>
          </p>
        )}
      </div>
    </motion.div>
  );
}
