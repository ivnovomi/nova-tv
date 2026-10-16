import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { LockKeyhole, Settings2 } from "lucide-react";
import { focusElement, focusFirst } from "../lib/spatialNav";
import { useBackHandler } from "../hooks/backStack";
import type { Profile } from "../lib/types";
import { profiles, useProfiles } from "../app/profiles";
import { PinPad } from "./PinPad";

export function Avatar({ profile, className = "size-[3.4rem] text-[1.6rem]" }: { profile: Pick<Profile, "avatar" | "color">; className?: string }) {
  return (
    <span
      className={`grid shrink-0 place-items-center rounded-full leading-none ${className}`}
      style={{ background: `radial-gradient(circle at 30% 25%, ${profile.color}, ${profile.color}99 60%, ${profile.color}55)` }}
      aria-hidden
    >
      {profile.avatar}
    </span>
  );
}

interface Props {
  /** A profile was chosen (or the picker was dismissed, when it can be). */
  onDone: () => void;
  /** At start-up someone has to choose; from the top bar it can be dismissed. */
  dismissable: boolean;
  onManage?: () => void;
}

/** "¿Quién está viendo?" — leaving a children's profile asks for the parental PIN. */
export function ProfilePicker({ onDone, dismissable, onManage }: Props) {
  const info = useProfiles();
  const [asking, setAsking] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  useBackHandler(() => dismissable && onDone(), dismissable && !asking);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const current = root.current?.querySelector<HTMLElement>(`[data-profile="${info?.active}"]`);
      if (current) focusElement(current);
      else focusFirst(root.current);
    }, 60);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!info) return null;
  const active = info.profiles.find((p) => p.id === info.active);

  const choose = async (p: Profile, pin?: string) => {
    if (!pin && profiles.needsPin(p)) {
      setAsking(p);
      return;
    }
    try {
      await profiles.switchTo(p.id, pin);
      setAsking(null);
      onDone();
    } catch (e) {
      if (pin) throw e; // the PIN pad shows it
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return createPortal(
    <motion.div
      ref={root}
      data-nav-scope
      className="fixed inset-0 z-[85] grid place-items-center overflow-hidden bg-[#03050c]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, scale: 1.03, transition: { duration: 0.4 } }}
      role="dialog"
      aria-label="¿Quién está viendo?"
    >
      <span aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(50rem_30rem_at_50%_0%,rgb(110_108_255/0.22),transparent_70%),radial-gradient(40rem_30rem_at_50%_110%,rgb(63_213_242/0.12),transparent_70%)]" />
      <div className="relative text-center">
        <motion.h1 className="text-[3rem] font-semibold tracking-tight" initial={{ y: 12, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: 0.05 }}>
          ¿Quién está viendo?
        </motion.h1>
        <div className="mt-14 flex flex-wrap justify-center gap-10">
          {info.profiles.map((p, i) => (
            <motion.button
              key={p.id}
              data-nav
              data-profile={p.id}
              onClick={() => void choose(p)}
              className="group flex w-[11rem] flex-col items-center gap-4 rounded-3xl p-3 outline-none"
              initial={{ y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.08 + i * 0.05, ease: [0.22, 1, 0.36, 1] }}
            >
              <span className="relative transition-transform duration-200 group-focus:scale-110">
                <Avatar profile={p} className="size-[8.5rem] text-[4rem] ring-0 ring-white/90 ring-offset-4 ring-offset-[#03050c] transition-[box-shadow] group-focus:ring-4" />
                {profiles.needsPin(p) && (
                  <span className="absolute -bottom-1 -right-1 grid size-9 place-items-center rounded-full bg-black/80 ring-2 ring-[#03050c]">
                    <LockKeyhole className="size-4" />
                  </span>
                )}
              </span>
              <span className="text-[1.35rem] font-semibold text-ink-2 group-focus:text-white">{p.name}</span>
              {p.kids && <span className="badge -mt-2 bg-[#ffb547]/20 text-[#ffd48a]">Infantil</span>}
            </motion.button>
          ))}
        </div>
        <p className="mt-6 min-h-[1.5rem] text-[1.05rem] text-danger" role="alert">
          {error}
        </p>
        {onManage && active && !active.kids && (
          <button data-nav onClick={onManage} className="focus-lift btn btn-ghost mt-4">
            <Settings2 className="size-5" /> Gestionar perfiles
          </button>
        )}
      </div>

      <AnimatePresence>
        {asking && (
          <PinPad
            key="pin"
            title={`Entrar como ${asking.name}`}
            subtitle="Para salir de un perfil infantil hace falta el PIN parental."
            onSubmit={(pin) => choose(asking, pin)}
            onClose={() => setAsking(null)}
          />
        )}
      </AnimatePresence>
    </motion.div>,
    document.body,
  );
}
