import type { ComponentType, ReactNode } from "react";
import {
  AppWindow,
  Calculator,
  ChevronRight,
  Clapperboard,
  FileText,
  Folder,
  Gamepad2,
  Globe,
  ImageIcon,
  LoaderCircle,
  MessageCircle,
  Music,
  Plus,
  Trash2,
  Video,
  type LucideProps,
} from "lucide-react";
import type { RecentMedia, Shortcut } from "../lib/types";
import { initials, posterBackground, tileBackground } from "./art";

type Icon = ComponentType<LucideProps>;

const KNOWN_ICONS: Record<string, Icon> = {
  "detected:chrome": Globe,
  "detected:edge": Globe,
  "detected:firefox": Globe,
  "detected:vlc": Clapperboard,
  "detected:spotify": Music,
  "detected:discord": MessageCircle,
  "detected:steam": Gamepad2,
  "detected:epic": Gamepad2,
  "detected:obs": Video,
  "detected:explorer": Folder,
  "detected:notepad": FileText,
  "detected:calc": Calculator,
};

const SOURCE_LABEL: Record<Shortcut["source"], string> = {
  detected: "Detectada",
  steam: "Steam",
  user: "Añadida",
  builtin: "Streaming",
  store: "Store",
  epic: "Epic Games",
  gog: "GOG",
  ubisoft: "Ubisoft",
  xbox: "Xbox",
  launcher: "Lanzador",
  pc: "Desde tu PC",
};

interface ShortcutTileProps {
  item: Shortcut;
  busy?: boolean;
  editing?: boolean;
  autoFocus?: boolean;
  onActivate: (item: Shortcut) => void;
}

function EditOverlay({ removable }: { removable: boolean }) {
  return (
    <span
      className={`absolute inset-0 grid place-items-center rounded-[inherit] text-[1rem] font-semibold ${
        removable ? "bg-danger/25 text-white" : "bg-bg-0/60 text-ink-3"
      }`}
    >
      {removable ? (
        <span className="flex items-center gap-2">
          <Trash2 className="size-5" /> Quitar
        </span>
      ) : (
        "No editable"
      )}
    </span>
  );
}

function BusyOverlay() {
  return (
    <span className="absolute inset-0 grid place-items-center rounded-[inherit] bg-bg-0/55">
      <LoaderCircle className="size-9 spin text-white" />
    </span>
  );
}

/** Application tile: icon chip + name, like a TV app row. */
export function AppTile({ item, busy, editing, autoFocus, onActivate }: ShortcutTileProps) {
  const IconCmp = KNOWN_ICONS[item.id] ?? null;
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      onClick={() => onActivate(item)}
      aria-label={`${editing ? "Quitar" : "Abrir"} ${item.name}`}
      aria-busy={busy}
      className="focus-lift group flex h-[9.5rem] w-[14.5rem] shrink-0 flex-col items-center justify-center gap-3 overflow-hidden rounded-[var(--radius-tile)] border border-line text-center shadow-[var(--shadow-tile)]"
      style={{ background: tileBackground(item.id, item.name) }}
    >
      <span className="grid size-[4.2rem] place-items-center rounded-2xl bg-white/10 text-[1.5rem] font-bold tracking-tight ring-1 ring-white/15 backdrop-blur">
        {IconCmp ? <IconCmp className="size-9" strokeWidth={1.7} /> : initials(item.name)}
      </span>
      <span className="max-w-[90%] truncate text-[1.1rem] font-medium">{item.name}</span>
      {item.source !== "detected" && (
        <span className="badge absolute left-3 top-3 bg-black/35 text-[0.65rem] text-ink-2">{SOURCE_LABEL[item.source]}</span>
      )}
      {editing && <EditOverlay removable={item.source === "user"} />}
      {busy && <BusyOverlay />}
    </button>
  );
}

/** Game poster: typographic key art generated from the title. */
export function PosterTile({ item, busy, editing, autoFocus, onActivate }: ShortcutTileProps) {
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      onClick={() => onActivate(item)}
      aria-label={`${editing ? "Quitar" : "Jugar a"} ${item.name}`}
      aria-busy={busy}
      className="focus-lift relative flex h-[11.5rem] w-[20.5rem] shrink-0 flex-col justify-end overflow-hidden rounded-[var(--radius-tile)] border border-line p-5 text-left shadow-[var(--shadow-tile)]"
      style={{ background: posterBackground(item.id, item.name) }}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute -right-3 -top-6 select-none text-[7.5rem] font-black leading-none tracking-tighter text-white/[0.07]"
      >
        {initials(item.name)}
      </span>
      <span className="badge absolute left-4 top-4 bg-black/35 text-[0.65rem] text-ink-2">
        {item.target.type === "steam" ? <Gamepad2 className="size-3.5" /> : <AppWindow className="size-3.5" />}
        {SOURCE_LABEL[item.source]}
      </span>
      <span className="line-clamp-2 text-[1.45rem] font-bold uppercase leading-[1.05] tracking-wide [text-shadow:0_2px_12px_rgb(0_0_0/0.6)]">
        {item.name}
      </span>
      {item.description && <span className="mt-1 truncate text-[0.9rem] text-ink-2">{item.description}</span>}
      {editing && <EditOverlay removable={item.source === "user"} />}
      {busy && <BusyOverlay />}
    </button>
  );
}

interface CtaProps {
  title: string;
  subtitle?: string;
  icon?: Icon;
  onClick: () => void;
  wide?: boolean;
  autoFocus?: boolean;
}

/** Dashed "add" tile used for empty states and registration actions. */
export function AddTile({ title, subtitle, icon: IconCmp = Plus, onClick, wide, autoFocus }: CtaProps) {
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      onClick={onClick}
      className={`focus-lift flex shrink-0 flex-col items-center justify-center gap-2 rounded-[var(--radius-tile)] border-2 border-dashed border-line-strong bg-surface-1/50 px-6 text-center ${
        wide ? "h-[11.5rem] w-[20.5rem]" : "h-[9.5rem] w-[14.5rem]"
      }`}
    >
      <IconCmp className="size-8 text-focus" strokeWidth={1.8} />
      <span className="text-[1.1rem] font-semibold">{title}</span>
      {subtitle && <span className="text-[0.9rem] leading-tight text-ink-3">{subtitle}</span>}
    </button>
  );
}

/** Visual sample, explicitly not an installed game. */
export function SampleTile({ title, genre, hue, onClick }: { title: string; genre: string; hue: number; onClick: () => void }) {
  return (
    <button
      data-nav
      onClick={onClick}
      aria-label={`Muestra ${title}: añadir un juego`}
      className="focus-lift relative flex h-[11.5rem] w-[20.5rem] shrink-0 flex-col justify-end overflow-hidden rounded-[var(--radius-tile)] border-2 border-dashed border-white/20 p-5 text-left opacity-80"
      style={{
        background: `radial-gradient(90% 120% at 30% 0%, hsl(${hue} 80% 55% / 0.4), transparent 60%), repeating-linear-gradient(135deg, hsl(0 0% 100% / 0.035) 0 2px, transparent 2px 18px), linear-gradient(135deg, hsl(${hue} 40% 14%), hsl(${hue + 40} 40% 6%))`,
      }}
    >
      <span className="badge absolute left-4 top-4 bg-warn/20 text-warn">Muestra · no instalado</span>
      <span className="text-[1.4rem] font-bold uppercase leading-tight tracking-wide">{title}</span>
      <span className="mt-1 text-[0.9rem] text-ink-2">{genre} · Pulsa para añadir un juego real</span>
    </button>
  );
}

interface ActionCardProps {
  title: string;
  subtitle: string;
  icon: Icon;
  tint: string;
  onClick: () => void;
}

export function ActionCard({ title, subtitle, icon: IconCmp, tint, onClick }: ActionCardProps) {
  return (
    <button
      data-nav
      onClick={onClick}
      className="focus-lift flex h-[7.6rem] min-w-0 flex-1 items-center gap-5 overflow-hidden rounded-[var(--radius-card)] border border-white/12 px-7 text-left"
      style={{ background: tint }}
    >
      <span className="grid size-[3.8rem] shrink-0 place-items-center rounded-2xl bg-white/12 ring-1 ring-white/15">
        <IconCmp className="size-8" strokeWidth={1.8} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[1.35rem] font-semibold">{title}</span>
        <span className="block truncate text-[1rem] text-white/70">{subtitle}</span>
      </span>
      <ChevronRight className="size-6 shrink-0 text-white/70" />
    </button>
  );
}

const MEDIA_ICON = { video: Clapperboard, audio: Music, image: ImageIcon } as const;
const MEDIA_HUE = { video: 265, audio: 330, image: 190 } as const;
const MEDIA_LABEL = { video: "Vídeo", audio: "Audio", image: "Imagen" } as const;

export function MediaTile({
  item,
  editing,
  onActivate,
}: {
  item: RecentMedia;
  editing?: boolean;
  onActivate: (m: RecentMedia) => void;
}) {
  const IconCmp = MEDIA_ICON[item.category] ?? Clapperboard;
  const hue = MEDIA_HUE[item.category] ?? 265;
  const folder = item.path.replace(/[\\/][^\\/]*$/, "");
  return (
    <button
      data-nav
      onClick={() => onActivate(item)}
      aria-label={`${editing ? "Olvidar" : "Abrir"} ${item.name}`}
      className={`focus-lift relative flex h-[11.5rem] w-[20.5rem] shrink-0 flex-col justify-between overflow-hidden rounded-[var(--radius-tile)] border border-line p-5 text-left ${
        item.exists ? "" : "opacity-60"
      }`}
      style={{
        background: `radial-gradient(100% 120% at 100% 0%, hsl(${hue} 80% 55% / 0.35), transparent 60%), linear-gradient(150deg, hsl(${hue} 40% 14%), hsl(${hue + 30} 35% 6%))`,
      }}
    >
      <span className="flex items-center justify-between">
        <span className="badge bg-black/35 text-ink-2">
          <IconCmp className="size-3.5" /> {MEDIA_LABEL[item.category]}
        </span>
        {!item.exists && <span className="badge bg-danger/20 text-danger">No disponible</span>}
      </span>
      <span className="min-w-0">
        <span className="line-clamp-2 break-all text-[1.2rem] font-semibold leading-snug">{item.name}</span>
        <span className="mt-1 block truncate text-[0.85rem] text-ink-3">{folder}</span>
      </span>
      {editing && (
        <span className="absolute inset-0 grid place-items-center bg-danger/25 font-semibold">
          <span className="flex items-center gap-2">
            <Trash2 className="size-5" /> Olvidar
          </span>
        </span>
      )}
    </button>
  );
}

export function Row({
  title,
  action,
  children,
}: {
  title: string;
  action?: { label: string; onClick: () => void };
  children: ReactNode;
}) {
  return (
    <section className="mt-10">
      <div className="mb-4 flex items-end justify-between px-[var(--gutter)]">
        <h2 className="text-[1.55rem] font-semibold tracking-tight">{title}</h2>
        {action && (
          <button
            data-nav
            onClick={action.onClick}
            className="focus-ring flex items-center gap-1 rounded-full px-4 py-1.5 text-[1rem] text-ink-2"
          >
            {action.label} <ChevronRight className="size-5" />
          </button>
        )}
      </div>
      <div className="row-scroller">{children}</div>
    </section>
  );
}

/** Brand colours and wordmark styling only: no third-party logos are bundled. */
const STREAM_STYLE: Record<string, { bg: string; text: string; font?: string }> = {
  "stream:youtube": { bg: "radial-gradient(90% 120% at 80% 0%, #ff0033aa, transparent 60%), linear-gradient(135deg,#2a0008,#0b0204)", text: "text-white", font: "font-bold tracking-[-0.03em]" },
  "stream:netflix": { bg: "radial-gradient(80% 110% at 50% 120%, #e5091488, transparent 65%), linear-gradient(160deg,#141414,#000)", text: "text-[#e50914]", font: "font-black uppercase tracking-[0.02em] [transform:scaleY(1.15)]" },
  "stream:prime": { bg: "radial-gradient(90% 120% at 20% 0%, #00a8e199, transparent 60%), linear-gradient(135deg,#0b1d2e,#050b14)", text: "text-white", font: "font-semibold lowercase tracking-[-0.01em]" },
  "stream:disney": { bg: "radial-gradient(100% 120% at 50% 110%, #2b7bffaa, transparent 60%), linear-gradient(170deg,#040b2c,#0a1a5c)", text: "text-white", font: "font-semibold italic" },
  "stream:max": { bg: "radial-gradient(100% 120% at 0% 0%, #4b2bff, transparent 60%), linear-gradient(135deg,#1a0a8c,#05022a)", text: "text-white", font: "font-black uppercase tracking-[0.04em]" },
  "stream:movistar": { bg: "radial-gradient(100% 120% at 100% 0%, #019df499, transparent 60%), linear-gradient(135deg,#00243f,#000d18)", text: "text-white", font: "font-semibold" },
  "stream:twitch": { bg: "radial-gradient(100% 120% at 0% 100%, #9146ffcc, transparent 60%), linear-gradient(135deg,#1f0f3d,#0e0619)", text: "text-white", font: "font-black tracking-[-0.02em]" },
  "stream:crunchyroll": { bg: "radial-gradient(100% 120% at 100% 100%, #f47521cc, transparent 60%), linear-gradient(135deg,#2a1205,#100602)", text: "text-[#ffb27a]", font: "font-bold lowercase" },
  "stream:appletv": { bg: "radial-gradient(100% 110% at 50% 0%, #ffffff33, transparent 60%), linear-gradient(160deg,#1c1c1e,#000)", text: "text-white", font: "font-semibold tracking-[-0.02em]" },
  "stream:rtve": { bg: "radial-gradient(100% 120% at 0% 0%, #e85a2acc, transparent 60%), linear-gradient(135deg,#2c0d06,#0f0402)", text: "text-white", font: "font-bold" },
  "stream:atresplayer": { bg: "radial-gradient(100% 120% at 100% 0%, #ff7a00cc, transparent 60%), linear-gradient(135deg,#2d1300,#0e0600)", text: "text-white", font: "font-bold lowercase" },
  "stream:ytmusic": { bg: "radial-gradient(90% 120% at 50% 0%, #ff0033aa, transparent 55%), radial-gradient(60% 80% at 50% 100%, #ffffff22, transparent 60%), linear-gradient(135deg,#1a0006,#030303)", text: "text-white", font: "font-semibold" },
};

/** Store apps reuse the brand styling of the matching web service. */
const STORE_BRAND: Record<string, string> = {
  Netflix: "stream:netflix",
  "Prime Video": "stream:prime",
  "Disney+": "stream:disney",
  "Apple TV": "stream:appletv",
  Twitch: "stream:twitch",
  Crunchyroll: "stream:crunchyroll",
  "Movistar Plus+": "stream:movistar",
};

export function streamStyle(item: Shortcut) {
  return (
    STREAM_STYLE[item.id] ??
    STREAM_STYLE[STORE_BRAND[item.name] ?? ""] ?? { bg: posterBackground(item.id, item.name), text: "text-white", font: "font-bold" }
  );
}

export function StreamTile({ item, busy, editing, autoFocus, onActivate }: ShortcutTileProps) {
  const style = streamStyle(item);
  const tv = item.target.type === "web" && item.target.tv;
  return (
    <button
      data-nav
      data-autofocus={autoFocus || undefined}
      onClick={() => onActivate(item)}
      aria-label={`${editing ? "Quitar" : "Abrir"} ${item.name}`}
      aria-busy={busy}
      className="focus-lift relative flex h-[11.5rem] w-[20.5rem] shrink-0 flex-col items-center justify-center overflow-hidden rounded-[var(--radius-tile)] border border-white/10 px-5 text-center shadow-[var(--shadow-tile)]"
      style={{ background: style.bg }}
    >
      {tv && <span className="badge absolute left-4 top-4 bg-white/15 text-white">Modo TV</span>}
      {item.source === "user" && <span className="badge absolute left-4 top-4 bg-black/40 text-ink-2">Añadida</span>}
      {item.source === "store" && <span className="badge absolute left-4 top-4 bg-white/15 text-white">App · Store</span>}
      <span className={`line-clamp-2 text-[2.2rem] leading-none ${style.text} ${style.font ?? ""}`}>{item.name}</span>
      {item.description && <span className="absolute bottom-4 inset-x-4 truncate text-[0.9rem] text-white/60">{item.description}</span>}
      {editing && <EditOverlay removable={item.source === "user"} />}
      {busy && <BusyOverlay />}
    </button>
  );
}
