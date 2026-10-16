import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import {
  Bluetooth,
  Clapperboard,
  Gamepad2,
  House,
  LayoutGrid,
  LogOut,
  Minus,
  Plus,
  Volume2,
  VolumeX,
  Plus as Add,
  Music4,
} from "lucide-react";
import type { ComponentType } from "react";
import type { LucideProps } from "lucide-react";
import { useBackHandler } from "../../hooks/backStack";
import { focusFirst } from "../../lib/spatialNav";
import { api } from "../../lib/api";
import { formatTime, useClock } from "../../hooks/useClock";
import type { VolumeState } from "../../lib/types";
import { PadPower } from "./PadStatus";
import type { Pad } from "./useGamepads";
import { sfx } from "./sfx";

interface Props {
  userName: string;
  pads: Pad[];
  onClose: () => void;
  onLibrary: () => void;
  onAddGame: () => void;
  onGameBar: () => void;
  onBluetooth: () => void;
  trailers: boolean;
  onToggleTrailers: () => void;
  onExit: () => void;
}

function Item({
  icon: Icon,
  label,
  hint,
  danger,
  onClick,
  autoFocus,
}: {
  icon: ComponentType<LucideProps>;
  label: string;
  hint?: string;
  danger?: boolean;
  onClick: () => void;
  autoFocus?: boolean;
}) {
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      onClick={onClick}
      className={`focus-ring flex w-full items-center gap-4 rounded-xl px-4 py-3.5 text-left text-[1.15rem] focus:bg-white/10 ${
        danger ? "text-[#ff8a9d]" : "text-white"
      }`}
    >
      <Icon className="size-6 shrink-0" strokeWidth={1.8} />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[0.95rem] text-white/50">{hint}</span>}
    </button>
  );
}

/** Xbox-style guide: slides in from the left, traps focus, Back closes it. */
export function Guide({ userName, pads, onClose, onLibrary, onAddGame, onGameBar, onBluetooth, trailers, onToggleTrailers, onExit }: Props) {
  const panel = useRef<HTMLDivElement>(null);
  const now = useClock();
  const [vol, setVol] = useState<VolumeState | null>(null);
  const [sounds, setSounds] = useState(sfx.enabled);
  useBackHandler(() => {
    sfx.back();
    onClose();
  });

  useEffect(() => {
    sfx.open();
    api.getVolume().then(setVol, () => setVol(null));
    const t = window.setTimeout(() => focusFirst(panel.current), 40);
    return () => window.clearTimeout(t);
  }, []);

  const step = (delta: number) => {
    if (!vol) return;
    api.setVolume(Math.max(0, Math.min(100, vol.level + delta))).then(setVol, () => {});
  };

  return (
    <motion.div className="fixed inset-0 z-[35]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <button aria-label="Cerrar guía" tabIndex={-1} onClick={onClose} className="absolute inset-0 bg-black/55" />
      <motion.aside
        ref={panel}
        data-nav-scope
        role="dialog"
        aria-label="Guía"
        className="absolute inset-y-0 left-0 flex w-[30rem] flex-col border-r border-white/10 bg-[#070b10]/95 px-6 py-8 backdrop-blur-xl"
        initial={{ x: "-100%" }}
        animate={{ x: 0 }}
        exit={{ x: "-100%" }}
        transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      >
        <div className="flex items-center gap-4 px-2">
          <span className="grid size-[3.6rem] place-items-center rounded-full bg-[linear-gradient(135deg,#5cff8f,#3fd5f2)] text-[1.6rem] font-bold text-[#04120a]">
            {userName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <p className="truncate text-[1.3rem] font-semibold">{userName}</p>
            <p className="text-[0.95rem] text-white/55">{formatTime(now)} · NOVA PLAY</p>
          </div>
        </div>

        <div className="mt-6 rounded-xl bg-white/5 px-4 py-3 text-[1rem] text-white/75">
          {pads.length ? (
            pads.map((p) => (
              <div key={`${p.source}-${p.id}`} className="flex items-center gap-3 py-1">
                <Gamepad2 className="size-5 text-[#5cff8f]" />
                <span className="min-w-0 flex-1 truncate">{p.name}</span>
                <PadPower pad={p} />
              </div>
            ))
          ) : (
            <div className="flex items-center gap-3 py-1">
              <Gamepad2 className="size-5 text-white/40" /> Sin mando · teclado y ratón
            </div>
          )}
        </div>

        <nav className="mt-5 flex-1 space-y-1 overflow-y-auto">
          <Item icon={House} label="Inicio de NOVA PLAY" onClick={onClose} autoFocus />
          <Item icon={LayoutGrid} label="Mi biblioteca" onClick={onLibrary} />
          <Item icon={Add} label="Añadir juego" onClick={onAddGame} />
          <Item icon={Gamepad2} label="Xbox Game Bar" hint="Win + G" onClick={onGameBar} />
          <Item icon={Bluetooth} label="Mandos y Bluetooth" onClick={onBluetooth} />
          <Item icon={Clapperboard} label="Tráileres de fondo" hint={trailers ? "Activados" : "Desactivados"} onClick={onToggleTrailers} />
          <Item
            icon={Music4}
            label="Sonidos de la interfaz"
            hint={sounds ? "Activados" : "Desactivados"}
            onClick={() => {
              sfx.setEnabled(!sounds);
              setSounds(!sounds);
            }}
          />

          <div className="flex items-center gap-2 px-2 py-2">
            {vol?.muted || vol?.level === 0 ? <VolumeX className="size-6 text-white/70" /> : <Volume2 className="size-6 text-white/70" />}
            <span className="flex-1 text-[1.15rem]">Volumen {vol ? `${vol.muted ? "silencio" : `${vol.level}%`}` : "no disponible"}</span>
            <button data-nav aria-label="Bajar volumen" disabled={!vol} onClick={() => step(-10)} className="focus-lift grid size-11 place-items-center rounded-full bg-white/8">
              <Minus className="size-5" />
            </button>
            <button data-nav aria-label="Subir volumen" disabled={!vol} onClick={() => step(10)} className="focus-lift grid size-11 place-items-center rounded-full bg-white/8">
              <Plus className="size-5" />
            </button>
          </div>
        </nav>

        <div className="border-t border-white/10 pt-3">
          <Item icon={LogOut} label="Salir del Modo Juego" danger onClick={onExit} />
        </div>
      </motion.aside>
    </motion.div>
  );
}
