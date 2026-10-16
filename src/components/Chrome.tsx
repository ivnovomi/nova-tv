import { CirclePlay, Gamepad2, House, Music, Pause, Play, RadioTower, Tv, LayoutGrid, Search, Settings, Activity, type LucideProps } from "lucide-react";
import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import type { Screen } from "../lib/types";
import { api } from "../lib/api";
import { formatDate, formatTime, useClock } from "../hooks/useClock";
import { useNowPlaying } from "../hooks/useLiveData";
import { useActiveProfile } from "../app/profiles";
import { Avatar } from "./ProfilePicker";
import { UpdateChip } from "../features/Updates";

export function Wordmark() {
  return (
    <div className="flex items-start gap-2" aria-label="NOVA TV">
      <svg viewBox="0 0 176 40" className="h-[2.1rem] w-auto" aria-hidden>
        <defs>
          <linearGradient id="wm-a" x1="0" y1="1" x2="1" y2="0">
            <stop offset="0" stopColor="#6e6cff" />
            <stop offset="1" stopColor="#3fd5f2" />
          </linearGradient>
        </defs>
        <g fill="none" strokeWidth="4.6" strokeLinejoin="miter" strokeLinecap="square">
          <path d="M3 37 V3 L31 37 V3" stroke="#f4f6ff" />
          <circle cx="66" cy="20" r="17" stroke="#f4f6ff" />
          <path d="M96 3 L113 37 L130 3" stroke="#f4f6ff" />
          <path d="M140 37 L157 3 L174 37" stroke="url(#wm-a)" />
        </g>
      </svg>
      <span className="-mt-1 text-[1.05rem] font-semibold tracking-[0.2em] text-ink-2">TV</span>
    </div>
  );
}

export const NAV_ITEMS: { id: Screen; label: string; icon: ComponentType<LucideProps> }[] = [
  { id: "home", label: "Para ti", icon: House },
  { id: "livetv", label: "En directo", icon: RadioTower },
  { id: "streaming", label: "Streaming", icon: Tv },
  { id: "games", label: "Juegos", icon: Gamepad2 },
  { id: "apps", label: "Apps", icon: LayoutGrid },
  { id: "media", label: "Multimedia", icon: CirclePlay },
];

let cachedUser: string | null = null;

function useUserName() {
  const [name, setName] = useState(cachedUser);
  useEffect(() => {
    if (cachedUser) return;
    api.systemInfo().then((i) => {
      cachedUser = i.userName ?? "Tú";
      setName(cachedUser);
    }, () => {});
  }, []);
  return name ?? "Tú";
}

/** Compact "now playing" from any Windows app; pressing it plays/pauses. */
function NowPlayingChip() {
  const now = useNowPlaying();
  if (!now) return null;
  return (
    <button
      data-nav
      onClick={() => void api.mediaControl("playpause").catch(() => {})}
      aria-label={`${now.playing ? "Pausar" : "Reproducir"} ${now.title}`}
      className="focus-ring flex h-[3.4rem] max-w-[22rem] items-center gap-3 rounded-full bg-white/8 py-1 pl-1 pr-5 backdrop-blur focus:bg-white/14"
    >
      <span className="grid size-[2.8rem] shrink-0 place-items-center overflow-hidden rounded-full bg-white/10">
        {now.artwork ? <img src={now.artwork} alt="" className="size-full object-cover" /> : <Music className="size-5" />}
      </span>
      {now.playing ? <Pause className="size-4 shrink-0" fill="currentColor" /> : <Play className="size-4 shrink-0" fill="currentColor" />}
      <span className="min-w-0 text-left leading-tight">
        <span className="block truncate text-[0.95rem] font-semibold">{now.title}</span>
        <span className="block truncate text-[0.8rem] text-ink-3">{now.artist ?? now.app}</span>
      </span>
    </button>
  );
}

export function TopBar({ screen, onNavigate, onProfiles }: { screen: Screen; onNavigate: (s: Screen) => void; onProfiles: () => void }) {
  const now = useClock();
  const user = useUserName();
  const profile = useActiveProfile();
  // Children's profile: no PC files ("Multimedia").
  const items = profile?.kids ? NAV_ITEMS.filter((i) => i.id !== "media") : NAV_ITEMS;
  const iconButton = (active: boolean) =>
    `focus-ring grid size-[3.4rem] place-items-center rounded-full ${
      active ? "bg-white text-black" : "bg-white/8 text-ink-2 backdrop-blur focus:bg-white/14 focus:text-ink-1"
    }`;
  return (
    <header className="relative z-10 flex h-[6.6rem] shrink-0 items-center gap-10 px-[var(--gutter)]">
      <Wordmark />
      <nav className="flex items-center gap-1" aria-label="Principal">
        {items.map(({ id, label }) => {
          const active = screen === id;
          return (
            <button
              key={id}
              data-nav
              data-nav-tab={id}
              aria-current={active ? "page" : undefined}
              onClick={() => onNavigate(id)}
              className={`focus-ring relative h-[3.2rem] rounded-full px-5 text-[1.2rem] font-semibold transition-colors ${
                active ? "bg-white text-black" : "text-ink-2 focus:bg-white/12 focus:text-ink-1"
              }`}
            >
              {label}
            </button>
          );
        })}
      </nav>
      <div className="ml-auto flex items-center gap-4">
        <NowPlayingChip />
        <UpdateChip />
        <button
          data-nav
          data-nav-tab="search"
          aria-label="Buscar"
          aria-current={screen === "search" ? "page" : undefined}
          onClick={() => onNavigate("search")}
          className={iconButton(screen === "search")}
        >
          <Search className="size-6" />
        </button>
        <button
          data-nav
          data-nav-tab="settings"
          aria-label="Ajustes de NOVA"
          aria-current={screen === "settings" ? "page" : undefined}
          onClick={() => onNavigate("settings")}
          className={iconButton(screen === "settings")}
        >
          <Settings className="size-6" />
        </button>
        <button
          data-nav
          onClick={onProfiles}
          aria-label={profile ? `Perfil: ${profile.name}. Cambiar de perfil` : "Cambiar de perfil"}
          title={profile?.name ?? user}
          className="focus-ring relative rounded-full"
        >
          {profile ? (
            <Avatar profile={profile} />
          ) : (
            <span className="grid size-[3.4rem] place-items-center rounded-full bg-[linear-gradient(135deg,#7c7aff,#3fd5f2)] text-[1.3rem] font-bold text-white">{user.charAt(0).toUpperCase()}</span>
          )}
          {profile?.kids && <span className="badge absolute -bottom-2 left-1/2 -translate-x-1/2 bg-[#ffb547] px-1.5 text-[0.6rem] text-black">NIÑOS</span>}
        </button>
        <p className="ml-2 text-[1.9rem] font-semibold tabular-nums" title={formatDate(now)}>
          {formatTime(now)}
        </p>
      </div>
    </header>
  );
}

function Key({ children }: { children: string }) {
  return (
    <kbd className="inline-grid h-[1.9rem] min-w-[1.9rem] place-items-center rounded-md border border-line-strong bg-surface-2/80 px-2 font-sans text-[0.85rem] font-semibold text-ink-1">
      {children}
    </kbd>
  );
}

export function Footer({ gamepad }: { gamepad: string | null }) {
  const hints: [string[], string][] = gamepad
    ? [
        [["✚"], "Mover"],
        [["A"], "Seleccionar"],
        [["B"], "Volver"],
        [["☰"], "Inicio"],
      ]
    : [
        [["←", "↑", "↓", "→"], "Mover"],
        [["Enter"], "Seleccionar"],
        [["Esc"], "Volver"],
        [["Inicio"], "Inicio"],
        [["F11"], "Pantalla completa"],
      ];
  return (
    <footer className="relative z-10 flex h-[4.2rem] shrink-0 items-center gap-9 border-t border-line bg-bg-0/70 px-[var(--gutter)] text-[1rem] text-ink-2 backdrop-blur">
      {hints.map(([keys, label]) => (
        <span key={label} className="flex items-center gap-2.5">
          <span className="flex gap-1">
            {keys.map((k) => (
              <Key key={k}>{k}</Key>
            ))}
          </span>
          {label}
        </span>
      ))}
      <span className="ml-auto flex items-center gap-2.5 text-ink-3">
        {gamepad ? (
          <>
            <Gamepad2 className="size-5 text-ok" /> {gamepad}
          </>
        ) : (
          <>
            <Activity className="size-5 text-accent" /> Tu PC, como una Smart TV
          </>
        )}
      </span>
    </footer>
  );
}

export function PageHeader({
  eyebrow,
  title,
  description,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-end justify-between gap-8 px-[var(--gutter)] pt-4">
      <div className="min-w-0">
        <p className="eyebrow text-cyan">{eyebrow}</p>
        <h1 className="mt-2 text-[3rem] font-semibold leading-tight tracking-[-0.02em]">{title}</h1>
        {description && <p className="mt-2 max-w-[52rem] text-[1.2rem] text-ink-2">{description}</p>}
      </div>
      {children && <div className="flex shrink-0 items-center gap-3">{children}</div>}
    </div>
  );
}
