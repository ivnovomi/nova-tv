import { Gamepad2, MonitorPlay, Package, Star } from "lucide-react";
import { Modal } from "../../components/Modal";
import type { Shortcut } from "../../lib/types";
import { gameKey, lastVariant, rememberVariant } from "./groups";

function icon(g: Shortcut) {
  if (g.source === "pc") return <MonitorPlay className="size-7 text-[#5cff8f]" />;
  if (g.id.startsWith("modrinth:") || g.id.startsWith("curseforge:")) return <Package className="size-7 text-[#ffb547]" />;
  return <Gamepad2 className="size-7 text-cyan" />;
}

/** Where it runs and through what: "En esta tele · Minecraft Launcher", "En TORRE · Steam". */
function where(g: Shortcut) {
  if (g.source === "pc") return g.description ?? "En tu PC";
  return `En esta tele${g.description ? ` · ${g.description}` : ""}`;
}

/** Which way to open a game that has several (instances, launchers, this TV or a PC). */
export function GameVariantsDialog({ title, variants, onPick, onClose }: { title: string; variants: Shortcut[]; onPick: (g: Shortcut) => void; onClose: () => void }) {
  const key = gameKey(variants[0]);
  const last = lastVariant(key);
  return (
    <Modal title={`¿Cómo quieres jugar a ${title}?`} subtitle="NOVA recordará tu elección para la próxima vez." onClose={onClose} width="50rem">
      <div className="grid max-h-[60vh] gap-2 overflow-y-auto p-1">
        {variants.map((g, i) => (
          <button
            key={g.id}
            data-nav
            data-autofocus={i === 0 || undefined}
            onClick={() => {
              rememberVariant(key, g.id);
              onPick(g);
            }}
            className="focus-lift flex items-center gap-5 rounded-2xl bg-white/6 px-6 py-4 text-left"
          >
            {icon(g)}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[1.3rem] font-semibold">{g.name}</span>
              <span className="block truncate text-[1rem] text-ink-3">{where(g)}</span>
            </span>
            {g.id === last && (
              <span className="badge bg-white/10 text-ink-2">
                <Star className="size-3.5" fill="currentColor" /> La última vez
              </span>
            )}
          </button>
        ))}
      </div>
    </Modal>
  );
}
