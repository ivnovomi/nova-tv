import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { listen } from "@tauri-apps/api/event";
import { AnimatePresence, motion } from "motion/react";
import { Bluetooth, Dices, Gamepad2, Info, Joystick, Keyboard, Menu, MonitorPlay, Play, Plus, RefreshCw, Star, Trash2, type LucideProps } from "lucide-react";
import { byRecent, useNova } from "../../app/context";
import { useActiveProfile } from "../../app/profiles";
import { initials, posterBackground } from "../../components/art";
import { Modal } from "../../components/Modal";
import { Avatar } from "../../components/ProfilePicker";
import { useToast } from "../../components/Toasts";
import { useBackHandler, useHomeHandler } from "../../hooks/backStack";
import { formatPlaytime, usePlaytime } from "../../hooks/useLiveData";
import { formatTime, useClock } from "../../hooks/useClock";
import { api, inTauri, timeAgo } from "../../lib/api";
import { focusElement } from "../../lib/spatialNav";
import type { GameMeta, PlayStats, SettingsPage, Shortcut } from "../../lib/types";
import { ControllerArt } from "./ControllerArt";
import { favorites, useFavoriteGames } from "./favorites";
import { Glyph } from "./Glyphs";
import { Guide } from "./Guide";
import { PadPower, shortPadName } from "./PadStatus";
import { trailerPref } from "./prefs";
import { sfx } from "./sfx";
import { platformLabel, playable, useGameMeta } from "./useGameMeta";
import type { Pad } from "./useGamepads";

interface Props {
  pads: Pad[];
  /** The entrance animation has finished. */
  ready: boolean;
  onExit: () => void;
}

type View = "home" | "library";

// ───────────────────────── Artwork ─────────────────────────

/** <img> that walks a list of sources and finally renders `fallback`. */
function ImgChain({ sources, className, fallback, alt = "" }: { sources: (string | null | undefined)[]; className: string; fallback: ReactNode; alt?: string }) {
  const list = sources.filter((s): s is string => !!s);
  const [i, setI] = useState(0);
  if (i >= list.length) return <>{fallback}</>;
  return <img key={list[i]} src={list[i]} alt={alt} draggable={false} onError={() => setI(i + 1)} className={className} />;
}

function Poster({ game, className }: { game: Shortcut; className: string }) {
  return (
    <span className={`grid place-items-center ${className}`} style={{ background: posterBackground(game.id, game.name) }}>
      <span className="text-[2rem] font-black tracking-tight text-white/85">{initials(game.name)}</span>
    </span>
  );
}

const TRAILER_DELAY = 1500;

/**
 * Muted background trailer: starts after the game has been focused for a
 * moment, fades in only once frames play, falls back to 480p, and pauses
 * whenever NOVA isn't the foreground window (e.g. in-game).
 */
function Trailer({ src }: { src: string }) {
  const [armed, setArmed] = useState(false);
  const [source, setSource] = useState(src);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setArmed(true), TRAILER_DELAY);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    const sync = () => {
      const v = video.current;
      if (!v) return;
      if (document.hasFocus() && document.visibilityState === "visible") void v.play().catch(() => {});
      else v.pause();
    };
    window.addEventListener("focus", sync);
    window.addEventListener("blur", sync);
    document.addEventListener("visibilitychange", sync);
    return () => {
      window.removeEventListener("focus", sync);
      window.removeEventListener("blur", sync);
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  if (!armed || failed) return null;
  return (
    <motion.video
      ref={video}
      key={source}
      src={source}
      muted
      autoPlay
      loop
      playsInline
      preload="auto"
      aria-hidden
      onPlaying={() => setPlaying(true)}
      onError={() => {
        const low = source.replace("/movie_max.mp4", "/movie480.mp4");
        if (low !== source) setSource(low);
        else setFailed(true);
      }}
      className="absolute inset-0 size-full object-cover"
      initial={{ opacity: 0 }}
      animate={{ opacity: playing ? 1 : 0 }}
      transition={{ duration: 0.9 }}
    />
  );
}

function Backdrop({ game, meta, trailers }: { game?: Shortcut; meta?: GameMeta; trailers: boolean }) {
  const procedural = (
    <span
      className="absolute inset-0 blur-[60px] saturate-150"
      style={{ background: game ? posterBackground(game.id, game.name) : "radial-gradient(60rem 40rem at 70% 20%, rgb(92 255 143 / 0.18), transparent 70%)" }}
    />
  );
  return (
    <AnimatePresence initial={false}>
      <motion.div
        key={game?.id ?? "none"}
        className="absolute inset-0"
        initial={{ opacity: 0, scale: 1.04 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
      >
        {game ? <ImgChain sources={[meta?.hero, meta?.header]} className="absolute inset-0 size-full object-cover object-top" fallback={procedural} /> : procedural}
        {game && trailers && meta?.trailer && <Trailer src={meta.trailer} />}
      </motion.div>
    </AnimatePresence>
  );
}

// ───────────────────────── Tiles ─────────────────────────

interface TileProps {
  game: Shortcut;
  meta?: GameMeta;
  stats?: PlayStats;
  favorite: boolean;
  onFocus: () => void;
  onPlay: () => void;
  autoFocus?: boolean;
}

/** "Seguir jugando": wide store art, when you last played and for how long. */
function WideTile({ game, meta, stats, favorite, onFocus, onPlay, autoFocus }: TileProps) {
  const total = formatPlaytime(stats?.totalSeconds ?? 0);
  return (
    <button
      data-nav
      data-game-id={game.id}
      data-autofocus={autoFocus || undefined}
      onFocus={onFocus}
      onClick={onPlay}
      aria-label={`Jugar a ${meta?.title ?? game.name}`}
      className="focus-lift relative h-[12.5rem] w-[24rem] shrink-0 overflow-hidden rounded-[1.1rem] border border-white/12 text-left shadow-[0_1.2rem_2.4rem_-1rem_rgb(0_0_0/0.85)]"
    >
      <ImgChain sources={[meta?.header, meta?.hero]} className="absolute inset-0 size-full object-cover" fallback={<Poster game={game} className="absolute inset-0" />} />
      <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/25 to-transparent" />
      {favorite && <Star className="absolute right-3 top-3 size-5 text-[#ffd34f] drop-shadow" fill="currentColor" />}
      <span className="absolute inset-x-4 bottom-3">
        <span className="block truncate text-[1.2rem] font-semibold">{meta?.title ?? game.name}</span>
        <span className="block truncate text-[0.9rem] text-white/70">
          {[stats?.lastPlayed ? timeAgo(stats.lastPlayed) : platformLabel(game), total].filter(Boolean).join(" · ")}
        </span>
      </span>
    </button>
  );
}

/** Library cover (portrait). */
function CoverTile({ game, meta, favorite, onFocus, onPlay, autoFocus }: TileProps) {
  return (
    <button
      data-nav
      data-game-id={game.id}
      data-autofocus={autoFocus || undefined}
      onFocus={onFocus}
      onClick={onPlay}
      aria-label={`Jugar a ${meta?.title ?? game.name}`}
      className="focus-lift relative h-[15rem] w-[10rem] shrink-0 overflow-hidden rounded-[1rem] border border-white/12 shadow-[0_1rem_2rem_-0.8rem_rgb(0_0_0/0.8)]"
    >
      <ImgChain sources={[meta?.portrait, meta?.header]} className="absolute inset-0 size-full object-cover" fallback={<Poster game={game} className="absolute inset-0" />} />
      {favorite && <Star className="absolute right-2.5 top-2.5 size-5 text-[#ffd34f] drop-shadow" fill="currentColor" />}
      {!meta?.portrait && (
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 to-transparent px-3 pb-2.5 pt-8 text-left text-[0.95rem] font-semibold leading-tight">
          {meta?.title ?? game.name}
        </span>
      )}
    </button>
  );
}

function ActionTile({ icon: Icon, title, subtitle, onClick, onFocus }: { icon: ComponentType<LucideProps>; title: string; subtitle: string; onClick: () => void; onFocus: () => void }) {
  return (
    <button
      data-nav
      onFocus={onFocus}
      onClick={onClick}
      className="focus-lift flex h-[9rem] w-[15rem] shrink-0 flex-col justify-between rounded-[1rem] border border-white/12 bg-[linear-gradient(160deg,rgb(92_255_143/0.16),rgb(63_213_242/0.06)),rgb(10_14_20/0.75)] p-4 text-left backdrop-blur"
    >
      <Icon className="size-7 text-[#5cff8f]" strokeWidth={1.8} />
      <span>
        <span className="block text-[1.1rem] font-semibold">{title}</span>
        <span className="block truncate text-[0.85rem] text-white/60">{subtitle}</span>
      </span>
    </button>
  );
}

function Shelf({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-5 first:mt-0">
      <h2 className="mb-1 px-[var(--gutter)] text-[1.2rem] font-semibold text-white/85">{title}</h2>
      <div className="row-scroller !gap-4 items-end">{children}</div>
    </section>
  );
}

// ───────────────────────── Details ─────────────────────────

function GameInfo({ game, meta, stats, favorite, onPlay, onFavorite, onRemove, onClose }: { game: Shortcut; meta?: GameMeta; stats?: PlayStats; favorite: boolean; onPlay: () => void; onFavorite: () => void; onRemove?: () => void; onClose: () => void }) {
  const total = stats ? formatPlaytime(stats.totalSeconds) : null;
  return (
    <Modal title={meta?.title ?? game.name} subtitle={[platformLabel(game), meta?.developer, meta?.year].filter(Boolean).join(" · ")} onClose={onClose} width="58rem">
      <div className="flex gap-8">
        <ImgChain sources={[meta?.portrait, meta?.header]} className="h-[18rem] w-[12rem] shrink-0 rounded-xl object-cover" fallback={<Poster game={game} className="h-[18rem] w-[12rem] shrink-0 rounded-xl" />} />
        <div className="min-w-0">
          {meta?.genres.length ? (
            <div className="flex flex-wrap gap-2">
              {meta.genres.map((g) => (
                <span key={g} className="badge bg-white/10 text-ink-1">
                  {g}
                </span>
              ))}
              {meta.metacritic != null && <span className="badge bg-[#5cff8f]/20 text-[#5cff8f]">Metacritic {meta.metacritic}</span>}
            </div>
          ) : null}
          <p className="mt-4 text-[1.1rem] leading-relaxed text-ink-2">{meta?.description ?? "Sin descripción disponible para este juego."}</p>
          <dl className="mt-5 grid grid-cols-3 gap-3">
            {[
              ["Tiempo jugado", total ?? "Aún no"],
              ["Sesiones", stats?.sessions ? String(stats.sessions) : "0"],
              ["Última vez", stats?.lastPlayed ? timeAgo(stats.lastPlayed) : "—"],
            ].map(([k, v]) => (
              <div key={k} className="rounded-xl bg-white/6 px-4 py-3">
                <dt className="text-[0.85rem] text-ink-3">{k}</dt>
                <dd className="mt-0.5 text-[1.25rem] font-semibold">{v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-[0.85rem] text-ink-3">Tiempo medido por NOVA mientras el juego estaba abierto.</p>
          {meta?.source && <p className="mt-4 text-[0.9rem] text-ink-3">Información e imágenes: {meta.source === "microsoft" ? "Microsoft Store" : "tienda de Steam"}.</p>}
          <div className="mt-6 flex gap-3">
            <button data-nav data-autofocus onClick={onPlay} className="focus-lift btn bg-white text-black">
              <Play className="size-5" fill="currentColor" /> Jugar
            </button>
            <button data-nav onClick={onFavorite} className="focus-lift btn btn-ghost">
              <Star className={`size-5 ${favorite ? "text-[#ffd34f]" : ""}`} fill={favorite ? "currentColor" : "none"} /> {favorite ? "En favoritos" : "Añadir a favoritos"}
            </button>
            {onRemove && (
              <button data-nav onClick={onRemove} className="focus-lift btn btn-ghost ml-auto text-danger">
                <Trash2 className="size-5" /> Quitar de NOVA
              </button>
            )}
          </div>
          {onRemove && <p className="mt-3 text-[0.85rem] text-ink-3">Solo quita el acceso de NOVA; el juego sigue instalado.</p>}
          {game.source === "pc" && <KeyboardMode game={game} />}
        </div>
      </div>
    </Modal>
  );
}

/** A PC's game without controller support: NovaBridge turns the controller into keyboard and mouse. */
function KeyboardMode({ game }: { game: Shortcut }) {
  const toast = useToast();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    api.pcKeyboardGames().then((ids) => setOn(ids.includes(game.id)), () => setOn(false));
  }, [game.id]);
  const toggle = () => {
    const next = !on;
    setOn(next);
    api.pcGameKeyboard(game.id, next).catch((e: Error) => {
      setOn(!next);
      toast.show("error", "No se pudo cambiar", e.message);
    });
  };
  if (on === null) return null;
  return (
    <div className="mt-5 flex items-center gap-4 rounded-xl bg-white/6 px-4 py-3">
      <Keyboard className="size-6 shrink-0 text-ink-2" />
      <span className="min-w-0 flex-1">
        <span className="block text-[1.05rem] font-semibold">Mando como teclado y ratón</span>
        <span className="block text-[0.9rem] text-ink-3">Para juegos que no admiten mando: joystick izquierdo WASD, derecho el ratón, gatillos los clics.</span>
      </span>
      <button data-nav role="switch" aria-checked={on} onClick={toggle} className={`focus-lift btn shrink-0 ${on ? "btn-primary" : "btn-ghost"}`}>
        {on ? "Activado" : "Desactivado"}
      </button>
    </div>
  );
}

// ───────────────────────── Library tab ─────────────────────────

const FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "Todos" },
  { key: "fav", label: "Favoritos" },
  { key: "steam", label: "Steam" },
  { key: "epic", label: "Epic" },
  { key: "xbox", label: "Xbox" },
  { key: "gog", label: "GOG" },
  { key: "ubisoft", label: "Ubisoft" },
  { key: "launcher", label: "Lanzadores" },
  { key: "pc", label: "Desde tu PC" },
  { key: "user", label: "Añadidos" },
];

const SORTS = [
  { key: "recent", label: "Recientes" },
  { key: "played", label: "Más jugados" },
  { key: "az", label: "A-Z" },
] as const;

// ───────────────────────── Home ─────────────────────────

export function GamingHome({ pads, ready, onExit }: Props) {
  const nova = useNova();
  const toast = useToast();
  const now = useClock();
  const meta = useGameMeta();
  const playtime = usePlaytime();
  const profile = useActiveProfile();
  const favIds = useFavoriteGames();
  const [view, setView] = useState<View>("home");
  const [guide, setGuide] = useState(false);
  const [info, setInfo] = useState<Shortcut | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [trailers, setTrailers] = useState(trailerPref.get);
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<(typeof SORTS)[number]["key"]>("recent");
  const [welcome, setWelcome] = useState<{ name: string; seconds: number } | null>(null);
  const shelves = useRef<HTMLDivElement>(null);

  const games = useMemo(() => (nova.library ? playable(byRecent(nova.library.games, nova.library.recent), meta) : []), [nova.library, meta]);
  const byId = useMemo(() => new Map(games.map((g) => [g.id, g])), [games]);
  const title = (g: Shortcut) => meta[g.id]?.title ?? g.name;

  // "Seguir jugando": what NOVA saw you play, latest first (then recent launches).
  const continueList = useMemo(() => {
    const played = games.filter((g) => playtime[g.id]?.lastPlayed).sort((a, b) => (playtime[b.id]?.lastPlayed ?? 0) - (playtime[a.id]?.lastPlayed ?? 0));
    const recent = (nova.library?.recent ?? []).map((id) => byId.get(id)).filter((g): g is Shortcut => !!g);
    return [...new Set([...played, ...recent])].slice(0, 6);
  }, [games, playtime, nova.library, byId]);
  const favGames = useMemo(() => favIds.map((id) => byId.get(id)).filter((g): g is Shortcut => !!g), [favIds, byId]);

  const activity = useMemo(() => {
    const stats = games.map((g) => ({ g, s: playtime[g.id] })).filter((x) => x.s && x.s.totalSeconds > 0);
    const total = stats.reduce((n, x) => n + x.s!.totalSeconds, 0);
    const sessions = stats.reduce((n, x) => n + (x.s!.sessions ?? 0), 0);
    const top = stats.sort((a, b) => b.s!.totalSeconds - a.s!.totalSeconds)[0];
    return { total, sessions, top: top?.g };
  }, [games, playtime]);

  const focused = (focusId && byId.get(focusId)) || continueList[0] || favGames[0] || games[0];
  const focusedMeta = focused ? meta[focused.id] : undefined;
  const isFav = (id: string) => favIds.includes(id);

  // Library tab: filter + sort.
  const present = new Set<string>(games.map((g) => g.source));
  const libraryList = useMemo(() => {
    const list = filter === "all" ? games : filter === "fav" ? favGames : games.filter((g) => g.source === filter);
    if (sort === "played") return [...list].sort((a, b) => (playtime[b.id]?.totalSeconds ?? 0) - (playtime[a.id]?.totalSeconds ?? 0));
    if (sort === "az") return [...list].sort((a, b) => title(a).localeCompare(title(b), "es"));
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [games, favGames, filter, sort, playtime, meta]);

  const play = (g: Shortcut) => nova.launch(g);
  const toggleFavorite = (g: Shortcut) => {
    const on = favorites.toggle(g.id);
    sfx.select();
    toast.show("success", on ? `${title(g)} en favoritos` : `${title(g)} quitado de favoritos`);
  };
  const surprise = () => {
    if (!games.length) return;
    const pick = games[Math.floor(Math.random() * games.length)];
    setFocusId(pick.id);
    sfx.success();
    toast.show("info", "¿Qué tal este?", title(pick));
    requestAnimationFrame(() => {
      const tile = document.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(pick.id)}"]`);
      if (tile) focusElement(tile);
    });
  };
  const settings = (page: SettingsPage, label: string) => api.openSettings(page).catch((e: Error) => toast.show("error", `No se pudo abrir ${label}`, e.message));
  const rescan = () =>
    api.rescanGames().then(
      (n) => {
        nova.reload();
        toast.show("success", "Búsqueda completada", `${n} juegos encontrados. Las carátulas llegan en segundo plano.`);
      },
      (e: Error) => toast.show("error", "No se pudo buscar", e.message),
    );

  // Focus the first tile as soon as there's something to focus (no lost first key press).
  const focusedOnce = useRef(false);
  useEffect(() => {
    if (focusedOnce.current || !nova.library) return;
    const t = window.setTimeout(() => {
      const target = shelves.current?.querySelector<HTMLElement>("[data-game-id], [data-nav]");
      if (target) {
        focusedOnce.current = true;
        focusElement(target);
      }
    }, 40);
    return () => window.clearTimeout(t);
  }, [nova.library, view]);

  // Back from a game (NOVA watched its process): welcome back and refocus it.
  useEffect(() => {
    if (!inTauri) return;
    let timer: number | undefined;
    const off = listen<{ id: string; name: string; seconds: number }>("game-ended", ({ payload }) => {
      sfx.success();
      setWelcome(payload);
      setFocusId(payload.id);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setWelcome(null), 3600);
      requestAnimationFrame(() => {
        const tile = document.querySelector<HTMLElement>(`[data-game-id="${CSS.escape(payload.id)}"]`);
        if (tile) focusElement(tile);
      });
    });
    return () => {
      window.clearTimeout(timer);
      void off.then((f) => f());
    };
  }, []);

  // B / Esc: library → home → leave NOVA PLAY. Home key / ☰: the guide.
  useBackHandler(() => (view === "library" ? setView("home") : onExit()), !guide && !info);
  useHomeHandler(() => setGuide((g) => !g));

  // X / F: favourite · Y / I: details · View: guide.
  const onKeyDown = (e: KeyboardEvent) => {
    if (guide || info) return;
    const k = e.key;
    const gameId = (document.activeElement as HTMLElement | null)?.dataset.gameId;
    const g = gameId ? byId.get(gameId) : undefined;
    if ((k === "f" || k === "F" || k === "GamepadX") && g) toggleFavorite(g);
    else if ((k === "i" || k === "I" || k === "GamepadY") && g) setInfo(g);
    else if (k === "GamepadView" || k === "ContextMenu") setGuide(true);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const tile = (g: Shortcut, Kind: typeof WideTile, autoFocus?: boolean) => (
    <Kind
      key={g.id}
      game={g}
      meta={meta[g.id]}
      stats={playtime[g.id]}
      favorite={isFav(g.id)}
      autoFocus={autoFocus}
      onFocus={() => {
        setFocusId(g.id);
        sfx.move();
      }}
      onPlay={() => play(g)}
    />
  );

  const controller = pads.length > 0;

  return (
    <div className="fixed inset-0 z-30 overflow-hidden bg-[#03050a] text-white" onKeyDown={onKeyDown}>
      <Backdrop game={view === "home" ? focused : undefined} meta={view === "home" ? focusedMeta : undefined} trailers={trailers && ready} />
      <div className="absolute inset-0 bg-[linear-gradient(90deg,rgb(3_5_10/0.94)_0%,rgb(3_5_10/0.6)_42%,rgb(3_5_10/0.1)_75%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(0deg,#03050a_0%,rgb(3_5_10/0.85)_38%,transparent_62%,rgb(3_5_10/0.55)_100%)]" />

      <div className="relative z-10 flex h-full flex-col">
        {/* Top bar */}
        <header className="flex h-[5.5rem] shrink-0 items-center gap-6 px-[var(--gutter)]">
          <span className="mr-4 text-[1.35rem] font-semibold tracking-[0.3em]">
            NOVA <span className="bg-[linear-gradient(90deg,#5cff8f,#3fd5f2)] bg-clip-text text-transparent">PLAY</span>
          </span>
          {(["home", "library"] as const).map((v) => (
            <button
              key={v}
              data-nav
              onClick={() => setView(v)}
              className={`focus-ring rounded-full px-5 py-1.5 text-[1.15rem] font-semibold transition-colors ${view === v ? "bg-white text-black" : "text-white/60"}`}
            >
              {v === "home" ? "Inicio" : `Biblioteca · ${games.length}`}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-5 text-[1rem] text-white/80">
            <span className="flex items-center gap-2 rounded-full bg-black/35 px-4 py-2 backdrop-blur">
              {controller ? (
                <>
                  <Gamepad2 className="size-5 text-[#5cff8f]" /> {shortPadName(pads[0].name)}
                  <PadPower pad={pads[0]} />
                </>
              ) : (
                <>
                  <Keyboard className="size-5" /> Teclado y ratón
                </>
              )}
            </span>
            <button data-nav aria-label="Guía" onClick={() => setGuide(true)} className="focus-ring grid size-11 place-items-center rounded-full bg-black/35 backdrop-blur">
              <Menu className="size-6" />
            </button>
            {profile && <Avatar profile={profile} className="size-11 text-[1.4rem]" />}
            <span className="text-[1.5rem] font-semibold tabular-nums text-white">{formatTime(now)}</span>
          </div>
        </header>

        {view === "home" ? (
          <>
            {/* Hero: the focused game */}
            <div className="flex min-h-0 flex-1 items-end px-[var(--gutter)] pb-6">
              <AnimatePresence mode="wait">
                {focused ? (
                  <motion.div key={focused.id} className="max-w-[46rem]" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -6 }} transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}>
                    <p className="flex flex-wrap items-center gap-2 text-[1rem] text-white/75">
                      <span className="badge bg-white/15 text-white">{platformLabel(focused)}</span>
                      {playtime[focused.id]?.lastPlayed ? <span className="badge bg-[#5cff8f]/20 text-[#b9ffd1]">Jugado {timeAgo(playtime[focused.id].lastPlayed!)}</span> : <span className="badge bg-[#3fd5f2]/20 text-[#bdf3ff]">Sin estrenar</span>}
                      {isFav(focused.id) && (
                        <span className="badge bg-[#ffd34f]/20 text-[#ffe68a]">
                          <Star className="size-3.5" fill="currentColor" /> Favorito
                        </span>
                      )}
                    </p>
                    <ImgChain
                      sources={[focusedMeta?.logo]}
                      alt={title(focused)}
                      className="mt-4 max-h-[8rem] max-w-[28rem] object-contain object-left drop-shadow-[0_6px_24px_rgb(0_0_0/0.7)]"
                      fallback={<h1 className="mt-3 text-[3.4rem] font-bold leading-[1.02] tracking-tight [text-shadow:0_4px_24px_rgb(0_0_0/0.7)]">{title(focused)}</h1>}
                    />
                    <p className="mt-3 text-[1.05rem] text-white/75">
                      {[focusedMeta?.genres.slice(0, 2).join(", "), focusedMeta?.developer, focusedMeta?.year, formatPlaytime(playtime[focused.id]?.totalSeconds ?? 0) && `${formatPlaytime(playtime[focused.id]?.totalSeconds ?? 0)} jugadas`]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                    {focusedMeta?.description && <p className="mt-2 line-clamp-2 text-[1.1rem] leading-relaxed text-white/80">{focusedMeta.description}</p>}
                    <div className="mt-5 flex items-center gap-3">
                      <button data-nav onClick={() => play(focused)} className="focus-lift btn h-[3.6rem] min-w-[11rem] bg-white text-[1.15rem] text-black">
                        <Play className="size-5" fill="currentColor" /> {nova.launching === focused.id ? "Abriendo…" : "Jugar"}
                      </button>
                      <button data-nav aria-label={isFav(focused.id) ? "Quitar de favoritos" : "Añadir a favoritos"} onClick={() => toggleFavorite(focused)} className="focus-lift grid size-[3.6rem] place-items-center rounded-full bg-white/15 backdrop-blur">
                        <Star className={`size-6 ${isFav(focused.id) ? "text-[#ffd34f]" : ""}`} fill={isFav(focused.id) ? "currentColor" : "none"} />
                      </button>
                      <button data-nav aria-label="Detalles" onClick={() => setInfo(focused)} className="focus-lift grid size-[3.6rem] place-items-center rounded-full bg-white/15 backdrop-blur">
                        <Info className="size-6" />
                      </button>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div key="empty" className="max-w-[46rem]" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <ControllerArt lit className="h-[9rem] w-auto" />
                    <h1 className="mt-6 text-[3rem] font-bold tracking-tight">Aún no hay juegos</h1>
                    <p className="mt-2 text-[1.15rem] text-white/75">NOVA busca en Steam, Epic, GOG, Ubisoft, Xbox y tus lanzadores. También puedes añadir cualquier juego a mano.</p>
                  </motion.div>
                )}
              </AnimatePresence>
              {activity.total > 0 && (
                <div className="ml-auto hidden shrink-0 gap-6 rounded-2xl bg-black/40 px-6 py-4 backdrop-blur xl:flex">
                  {[
                    ["Jugado en total", formatPlaytime(activity.total) ?? "—"],
                    ["Sesiones", String(activity.sessions)],
                    ["Tu favorito", activity.top ? title(activity.top) : "—"],
                  ].map(([k, v]) => (
                    <div key={k} className="max-w-[14rem]">
                      <p className="text-[0.8rem] uppercase tracking-[0.14em] text-white/50">{k}</p>
                      <p className="truncate text-[1.25rem] font-semibold">{v}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Shelves */}
            <div ref={shelves} className="page-scroll max-h-[46vh] shrink-0 overflow-y-auto pb-4">
              {continueList.length > 0 && <Shelf title="Seguir jugando">{continueList.map((g, i) => tile(g, WideTile, i === 0))}</Shelf>}
              {favGames.length > 0 && <Shelf title="Favoritos">{favGames.map((g) => tile(g, CoverTile))}</Shelf>}
              {games.length > 0 && <Shelf title={`Todos tus juegos · ${games.length}`}>{games.map((g, i) => tile(g, CoverTile, !continueList.length && i === 0))}</Shelf>}
              <Shelf title="Más">
                <ActionTile icon={Dices} title="Sorpréndeme" subtitle="Un juego al azar de tu biblioteca" onClick={surprise} onFocus={() => sfx.move()} />
                <ActionTile
                  icon={MonitorPlay}
                  title="Juegos de tu PC"
                  subtitle={present.has("pc") ? "Tus PCs y Moonlight" : "Juega aquí a los de un PC potente"}
                  onClick={() => nova.openDialog({ type: "pc-games" })}
                  onFocus={() => sfx.move()}
                />
                <ActionTile icon={RefreshCw} title="Buscar juegos" subtitle="Steam, Epic, GOG, Ubisoft, Xbox…" onClick={rescan} onFocus={() => sfx.move()} />
                <ActionTile icon={Plus} title="Añadir juego" subtitle="Cualquier .exe del PC" onClick={() => nova.openDialog({ type: "add-exe", kind: "game" })} onFocus={() => sfx.move()} />
                <ActionTile icon={Gamepad2} title="Juego de Steam" subtitle="Por su App ID" onClick={() => nova.openDialog({ type: "add-steam" })} onFocus={() => sfx.move()} />
                <ActionTile icon={Bluetooth} title="Mandos" subtitle="Emparejar por Bluetooth" onClick={() => settings("bluetooth", "Bluetooth")} onFocus={() => sfx.move()} />
                <ActionTile icon={Joystick} title="Xbox Game Bar" subtitle="Capturas y rendimiento" onClick={() => settings("gamebar", "Game Bar")} onFocus={() => sfx.move()} />
              </Shelf>
            </div>
          </>
        ) : (
          /* Library */
          <div className="flex min-h-0 flex-1 flex-col bg-[#05070b]/80 backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-2 px-[var(--gutter)] pt-4">
              {FILTERS.filter((f) => f.key === "all" || (f.key === "fav" ? favGames.length > 0 : present.has(f.key))).map((f) => (
                <button key={f.key} data-nav onClick={() => setFilter(f.key)} className={`focus-ring rounded-full px-5 py-2 text-[1.05rem] font-medium ${filter === f.key ? "bg-white text-black" : "bg-white/8 text-white/80"}`}>
                  {f.label}
                </button>
              ))}
              <span className="mx-3 w-px self-stretch bg-white/15" aria-hidden />
              {SORTS.map((s) => (
                <button key={s.key} data-nav onClick={() => setSort(s.key)} className={`focus-ring rounded-full px-5 py-2 text-[1.05rem] font-medium ${sort === s.key ? "bg-[#5cff8f] text-[#04120a]" : "bg-white/8 text-white/80"}`}>
                  {s.label}
                </button>
              ))}
            </div>
            <div ref={view === "library" ? shelves : undefined} className="page-scroll mt-5 min-h-0 flex-1 overflow-y-auto px-[var(--gutter)] pb-10">
              <div className="flex flex-wrap gap-5 pt-2">
                {libraryList.map((g, i) => (
                  <div key={g.id} className="w-[10rem]">
                    {tile(g, CoverTile, i === 0)}
                    <p className="mt-2 truncate text-[0.95rem] font-medium">{title(g)}</p>
                    <p className="truncate text-[0.82rem] text-white/50">{[platformLabel(g), formatPlaytime(playtime[g.id]?.totalSeconds ?? 0)].filter(Boolean).join(" · ")}</p>
                  </div>
                ))}
                {!libraryList.length && <p className="py-10 text-[1.1rem] text-white/60">No hay juegos con este filtro.</p>}
              </div>
            </div>
          </div>
        )}

        <footer className="flex h-[3.6rem] shrink-0 items-center gap-7 px-[var(--gutter)] text-[0.95rem] text-white/70">
          {(controller
            ? [["A", "Jugar"], ["X", "Favorito"], ["Y", "Detalles"], ["B", view === "library" ? "Inicio" : "Salir"], ["☰", "Guía"]]
            : [["Enter", "Jugar"], ["F", "Favorito"], ["I", "Detalles"], ["Esc", view === "library" ? "Inicio" : "Salir"], ["Inicio", "Guía"]]
          ).map(([g, label]) => (
            <span key={g} className="flex items-center gap-2.5">
              <Glyph label={g} /> {label}
            </span>
          ))}
        </footer>
      </div>

      <AnimatePresence>
        {welcome && (
          <motion.div
            key="welcome"
            role="status"
            className="pointer-events-none absolute left-1/2 top-[6.5rem] z-30 flex -translate-x-1/2 items-center gap-4 rounded-full border border-white/15 bg-black/75 py-3 pl-3 pr-7 backdrop-blur-xl"
            initial={{ opacity: 0, y: -16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          >
            <span className="grid size-11 place-items-center rounded-full bg-[linear-gradient(135deg,#5cff8f,#3fd5f2)] text-[#04120a]">
              <Gamepad2 className="size-6" />
            </span>
            <span>
              <span className="block text-[1.15rem] font-semibold">Bienvenido de nuevo</span>
              <span className="block text-[0.95rem] text-white/70">
                {welcome.seconds >= 60 ? `Has jugado ${formatPlaytime(welcome.seconds)} a ${welcome.name}` : `Has salido de ${welcome.name}`}
              </span>
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {info && (
          <GameInfo
            game={info}
            meta={meta[info.id]}
            stats={playtime[info.id]}
            favorite={isFav(info.id)}
            onPlay={() => {
              setInfo(null);
              play(info);
            }}
            onFavorite={() => toggleFavorite(info)}
            onRemove={
              info.source === "user"
                ? () => {
                    setInfo(null);
                    nova.openDialog({ type: "confirm-remove", item: info });
                  }
                : undefined
            }
            onClose={() => setInfo(null)}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {guide && (
          <Guide
            userName={profile?.name ?? "Jugador"}
            pads={pads}
            onClose={() => setGuide(false)}
            onLibrary={() => {
              setGuide(false);
              setView("library");
            }}
            onAddGame={() => {
              setGuide(false);
              nova.openDialog({ type: "add-exe", kind: "game" });
            }}
            onGameBar={() => settings("gamebar", "Game Bar")}
            onBluetooth={() => settings("bluetooth", "Bluetooth")}
            trailers={trailers}
            onToggleTrailers={() => {
              trailerPref.set(!trailers);
              setTrailers(!trailers);
            }}
            onExit={onExit}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
