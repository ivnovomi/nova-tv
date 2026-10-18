import { useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode } from "react";
import { motion } from "motion/react";
import {
  AppWindow,
  Bluetooth,
  Delete,
  Download,
  Gamepad2,
  LoaderCircle,
  Monitor,
  Palette,
  Power,
  Search as SearchIcon,
  Smartphone,
  Space,
  Volume2,
  Wifi,
  X,
  type LucideProps,
} from "lucide-react";
import { useNova } from "../app/context";
import { AppTile, MediaTile, PosterTile, StreamTile } from "../components/Tiles";
import { ContinueTile } from "../components/VideoTiles";
import { useToast } from "../components/Toasts";
import { useGameMeta } from "./gaming/useGameMeta";
import { api } from "../lib/api";
import type { Channel, FileHit, PluginResults, SettingsPage, Shortcut, YtResult } from "../lib/types";
import { PluginTile, useRunAction } from "./PluginRows";
import { ChannelLogo } from "./livetv/TvMode";
import { groupLabel, liveTv, useLiveTv } from "./livetv/store";

const RECENT_KEY = "nova.searches";

/** Lowercase without accents: "Canción" → "cancion". */
function fold(s: string) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function matches(text: string, words: string[]) {
  const t = fold(text);
  return words.every((w) => t.includes(w));
}

function readRecent(): string[] {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]").slice(0, 8);
  } catch {
    return [];
  }
}

function saveRecent(q: string) {
  const query = q.trim();
  if (query.length < 2) return;
  try {
    const next = [query, ...readRecent().filter((r) => fold(r) !== fold(query))].slice(0, 8);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {}
}

const KEYS = [
  ["a", "b", "c", "d", "e", "f", "g"],
  ["h", "i", "j", "k", "l", "m", "n"],
  ["ñ", "o", "p", "q", "r", "s", "t"],
  ["u", "v", "w", "x", "y", "z", "'"],
  ["1", "2", "3", "4", "5", "6", "7"],
  ["8", "9", "0", ".", "-", "&", "?"],
];

interface Shortcut2 {
  key: string;
  label: string;
  words: string;
  icon: ComponentType<LucideProps>;
  run: () => void;
}

function Group({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
  return (
    <section className="mt-8 first:mt-2">
      <h2 className="mb-3 flex items-baseline gap-3 px-2 text-[1.35rem] font-semibold">
        {title}
        {count != null && <span className="text-[1rem] font-normal text-ink-3">{count}</span>}
      </h2>
      <div className="row-scroller !px-2 ![scroll-padding-inline:0.5rem]">{children}</div>
    </section>
  );
}

function VideoResult({ r, onPlay }: { r: YtResult; onPlay: () => void }) {
  return (
    <button
      data-nav
      onClick={onPlay}
      aria-label={`Ver ${r.title}`}
      className="focus-lift relative flex w-[20.5rem] shrink-0 flex-col overflow-hidden rounded-[var(--radius-tile)] border border-line bg-surface-1 text-left shadow-[var(--shadow-tile)]"
    >
      <span className="relative block h-[11.5rem] w-full overflow-hidden bg-black">
        <img src={r.thumbnail} alt="" loading="lazy" className="size-full object-cover" />
        <span className={`badge absolute bottom-2 right-2 ${r.length ? "bg-black/80 text-white" : "bg-[#ff0033] text-white"}`}>
          {r.length ?? "En directo"}
        </span>
      </span>
      <span className="px-4 pb-3 pt-2.5">
        <span className="line-clamp-2 text-[1.05rem] font-semibold leading-snug">{r.title}</span>
        <span className="mt-1 block truncate text-[0.85rem] text-ink-3">{[r.channel, r.views, r.published].filter(Boolean).join(" · ")}</span>
      </span>
    </button>
  );
}

function SettingTile({ s }: { s: Shortcut2 }) {
  const Icon = s.icon;
  return (
    <button data-nav onClick={s.run} className="focus-lift surface flex h-[6.4rem] w-[17rem] shrink-0 items-center gap-4 rounded-[var(--radius-tile)] px-5 text-left">
      <span className="grid size-[3.2rem] place-items-center rounded-xl bg-white/8">
        <Icon className="size-6 text-focus" />
      </span>
      <span className="text-[1.15rem] font-medium">{s.label}</span>
    </button>
  );
}

function ChannelResult({ channel, onPlay }: { channel: Channel; onPlay: () => void }) {
  return (
    <button data-nav onClick={onPlay} aria-label={`Ver ${channel.name}`} className="focus-lift surface flex h-[6.4rem] w-[19rem] shrink-0 items-center gap-4 rounded-[var(--radius-tile)] px-4 text-left">
      <ChannelLogo channel={channel} className="size-14" />
      <span className="min-w-0">
        <span className="block truncate text-[1.1rem] font-semibold">{channel.name}</span>
        <span className="block truncate text-[0.85rem] text-ink-3">
          {channel.number} · {groupLabel(channel)}
        </span>
      </span>
    </button>
  );
}

export function SearchScreen() {
  const nova = useNova();
  const toast = useToast();
  const tv = useLiveTv();
  useEffect(() => void liveTv.load(), []);
  const meta = useGameMeta();
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState(readRecent);
  const [videos, setVideos] = useState<YtResult[] | null>(null);
  const [videosError, setVideosError] = useState<string | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [files, setFiles] = useState<FileHit[]>([]);
  const [pluginResults, setPluginResults] = useState<PluginResults[]>([]);
  const { run: runPluginItem, modal: pluginModal } = useRunAction();
  const request = useRef(0);

  const words = useMemo(() => fold(query).split(/\s+/).filter(Boolean), [query]);
  const active = words.length > 0;

  // Remote services: debounced, and stale responses are ignored.
  useEffect(() => {
    const id = ++request.current;
    setVideosError(null);
    if (!active) {
      setVideos(null);
      setFiles([]);
      setPluginResults([]);
      setLoadingVideos(false);
      return;
    }
    const filesTimer = window.setTimeout(() => {
      api.searchFiles(query).then((f) => id === request.current && setFiles(f), () => {});
    }, 250);
    // Plugins with `search` (NOVA waits at most 5 s for them).
    const pluginsTimer = window.setTimeout(() => {
      api.pluginsSearch(query).then((r) => id === request.current && setPluginResults(r), () => {});
    }, 500);
    setLoadingVideos(true);
    const ytTimer = window.setTimeout(() => {
      api.youtubeSearch(query).then(
        (v) => {
          if (id !== request.current) return;
          setVideos(v);
          setLoadingVideos(false);
        },
        (e: Error) => {
          if (id !== request.current) return;
          setVideosError(e.message);
          setLoadingVideos(false);
        },
      );
    }, 650);
    return () => {
      window.clearTimeout(filesTimer);
      window.clearTimeout(pluginsTimer);
      window.clearTimeout(ytTimer);
    };
  }, [query, active]);

  const settings = (page: SettingsPage) => () =>
    api.openSettings(page).catch((e: Error) => toast.show("error", "No se pudo abrir Configuración", e.message));

  const shortcuts: Shortcut2[] = [
    { key: "bt", label: "Bluetooth", words: "bluetooth mando auriculares", icon: Bluetooth, run: settings("bluetooth") },
    { key: "display", label: "Pantalla", words: "pantalla resolucion hdr brillo monitor", icon: Monitor, run: settings("display") },
    { key: "sound", label: "Sonido", words: "sonido audio volumen altavoces", icon: Volume2, run: settings("sound") },
    { key: "net", label: "Red e Internet", words: "red internet wifi ethernet", icon: Wifi, run: settings("network") },
    { key: "update", label: "Windows Update", words: "windows update actualizaciones", icon: Download, run: settings("update") },
    { key: "apps", label: "Aplicaciones", words: "aplicaciones apps desinstalar", icon: AppWindow, run: settings("apps") },
    { key: "theme", label: "Personalización", words: "personalizacion fondo tema colores", icon: Palette, run: settings("personalization") },
    { key: "power", label: "Inicio/apagado", words: "energia apagado suspension bateria", icon: Power, run: settings("power") },
    { key: "gaming", label: "Modo Juego", words: "modo juego nova play consola gaming", icon: Gamepad2, run: nova.enterGaming },
    { key: "remote", label: "Mando del móvil", words: "mando movil telefono remoto qr", icon: Smartphone, run: () => nova.navigate("system") },
  ];

  const lib = nova.library;
  const games = active ? (lib?.games ?? []).filter((g) => matches(`${g.name} ${meta[g.id]?.title ?? ""}`, words)) : [];
  const apps = active ? (lib?.apps ?? []).filter((a) => matches(`${a.name} ${a.description ?? ""}`, words)) : [];
  const streaming = active ? (lib?.streaming ?? []).filter((s) => matches(`${s.name} ${s.description ?? ""}`, words)) : [];
  const watched = active ? nova.history.filter((h) => matches(`${h.title} ${h.channel ?? ""}`, words)) : [];
  const matchingSettings = active ? shortcuts.filter((s) => matches(`${s.label} ${s.words}`, words)) : [];
  // Thousands of channels: match name first, then country/theme; show the best 40.
  const tvChannels = useMemo(() => {
    if (!active || !tv.data) return [];
    const byName = tv.data.channels.filter((c) => matches(c.name, words));
    const byGroup = byName.length >= 40 ? [] : tv.data.channels.filter((c) => !byName.includes(c) && matches(groupLabel(c), words));
    return [...byName, ...byGroup].slice(0, 40);
  }, [active, tv.data, words]);
  const nothing =
    active && !loadingVideos && !games.length && !apps.length && !streaming.length && !watched.length && !files.length && !matchingSettings.length && !videos?.length && !tvChannels.length && !pluginResults.length;

  const remember = () => {
    saveRecent(query);
    setRecent(readRecent());
  };
  const launch = (s: Shortcut) => {
    remember();
    nova.launch(s);
  };

  const type = (text: string) => setQuery((q) => (q + text).slice(0, 100));

  // Physical keyboard and phone typing work wherever focus is on this screen.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === "Backspace" && query) {
      e.preventDefault(); // don't go "back" while there is text to delete
      setQuery((q) => q.slice(0, -1));
    } else if (e.key.length === 1) {
      e.preventDefault();
      type(e.key);
    } else if (e.key === "Enter" && e.target === e.currentTarget) {
      remember();
    }
  };

  return (
    <div className="grid h-full grid-cols-[27rem_1fr] gap-10 px-[var(--gutter)] pb-10 pt-2" onKeyDown={onKeyDown}>
      {/* Query + on-screen keyboard */}
      <div className="flex flex-col">
        <label className="surface flex h-[4.6rem] items-center gap-4 rounded-2xl px-5 focus-within:border-focus">
          <SearchIcon className="size-7 shrink-0 text-ink-2" />
          <input
            data-nav
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 100))}
            onKeyDown={(e) => e.key === "Enter" && remember()}
            placeholder="Buscar en NOVA"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[1.6rem] font-medium outline-none placeholder:text-ink-3"
          />
          {query && (
            <button data-nav aria-label="Borrar búsqueda" onClick={() => setQuery("")} className="focus-ring grid size-10 place-items-center rounded-full">
              <X className="size-6" />
            </button>
          )}
        </label>

        <div className="mt-5 grid grid-cols-7 gap-2" role="group" aria-label="Teclado">
          {KEYS.flat().map((k, i) => (
            <button
              key={k}
              data-nav
              data-autofocus={i === 0 || undefined}
              onClick={() => type(k)}
              className="focus-lift grid h-[3.4rem] place-items-center rounded-xl bg-white/6 text-[1.35rem] font-medium uppercase"
            >
              {k}
            </button>
          ))}
          <button data-nav aria-label="Espacio" onClick={() => type(" ")} className="focus-lift col-span-3 grid h-[3.4rem] place-items-center rounded-xl bg-white/6">
            <Space className="size-6" />
          </button>
          <button data-nav aria-label="Borrar letra" onClick={() => setQuery((q) => q.slice(0, -1))} className="focus-lift col-span-2 grid h-[3.4rem] place-items-center rounded-xl bg-white/6">
            <Delete className="size-6" />
          </button>
          <button data-nav onClick={() => setQuery("")} className="focus-lift col-span-2 grid h-[3.4rem] place-items-center rounded-xl bg-white/6 text-[1rem] font-semibold">
            Borrar todo
          </button>
        </div>
        <p className="mt-4 text-[0.95rem] leading-relaxed text-ink-3">
          También puedes escribir con el teclado o desde el móvil («Escribir en la TV»).
        </p>
      </div>

      {/* Results */}
      <div className="min-w-0">
        {!active ? (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <h1 className="text-[2.4rem] font-semibold tracking-tight">Busca en todo NOVA</h1>
            <p className="mt-2 text-[1.15rem] text-ink-2">Juegos, aplicaciones, streaming, YouTube, lo que has visto, tus archivos y ajustes.</p>
            {recent.length > 0 && (
              <>
                <h2 className="mt-8 text-[1.2rem] font-semibold text-ink-2">Búsquedas recientes</h2>
                <div className="mt-3 flex flex-wrap gap-3">
                  {recent.map((r) => (
                    <button key={r} data-nav onClick={() => setQuery(r)} className="focus-ring rounded-full bg-white/8 px-5 py-2.5 text-[1.1rem]">
                      {r}
                    </button>
                  ))}
                </div>
              </>
            )}
          </motion.div>
        ) : (
          <>
            {games.length > 0 && (
              <Group title="Juegos" count={games.length}>
                {games.map((g) => (
                  <PosterTile key={g.id} item={g} busy={nova.launching === g.id} onActivate={launch} />
                ))}
              </Group>
            )}
            {tvChannels.length > 0 && (
              <Group title="Canales de TV" count={tvChannels.length}>
                {tvChannels.map((c) => (
                  <ChannelResult
                    key={c.id}
                    channel={c}
                    onPlay={() => {
                      remember();
                      liveTv.play(c.id);
                    }}
                  />
                ))}
              </Group>
            )}
            {streaming.length > 0 && (
              <Group title="Streaming" count={streaming.length}>
                {streaming.map((s) => (
                  <StreamTile key={s.id} item={s} busy={nova.launching === s.id} onActivate={launch} />
                ))}
              </Group>
            )}
            {apps.length > 0 && (
              <Group title="Aplicaciones" count={apps.length}>
                {apps.map((a) => (
                  <AppTile key={a.id} item={a} busy={nova.launching === a.id} onActivate={launch} />
                ))}
              </Group>
            )}
            {watched.length > 0 && (
              <Group title="Lo que has visto" count={watched.length}>
                {watched.map((h) => (
                  <ContinueTile key={h.key} entry={h} onActivate={(e) => { remember(); nova.playVideo(e.itemId, e.finished ? 0 : e.position); }} />
                ))}
              </Group>
            )}
            {pluginResults.map((r) => (
              <Group key={r.plugin} title={r.name} count={r.items.length}>
                {r.items.map((item) => (
                  <PluginTile key={item.id} item={item} style="landscape" onActivate={() => { remember(); runPluginItem(item); }} />
                ))}
              </Group>
            ))}
            <Group title="YouTube">
              {loadingVideos && !videos ? (
                <p className="flex items-center gap-3 py-6 text-[1.1rem] text-ink-3">
                  <LoaderCircle className="size-6 spin" /> Buscando en YouTube…
                </p>
              ) : videosError ? (
                <p className="py-6 text-[1.05rem] text-ink-3">YouTube no está disponible ahora mismo: {videosError}</p>
              ) : videos?.length ? (
                videos.map((v) => (
                  <VideoResult
                    key={v.videoId}
                    r={v}
                    onPlay={() => {
                      remember();
                      nova.playVideo(v.videoId);
                    }}
                  />
                ))
              ) : (
                <p className="py-6 text-[1.05rem] text-ink-3">Sin resultados en YouTube.</p>
              )}
            </Group>
            {files.length > 0 && (
              <Group title="Tus archivos" count={files.length}>
                {files.map((f) => (
                  <MediaTile
                    key={f.path}
                    item={{ ...f, openedAt: 0, exists: true }}
                    onActivate={() => {
                      remember();
                      nova.openMedia(f.path);
                    }}
                  />
                ))}
              </Group>
            )}
            {matchingSettings.length > 0 && (
              <Group title="Ajustes">
                {matchingSettings.map((s) => (
                  <SettingTile key={s.key} s={s} />
                ))}
              </Group>
            )}
            {nothing && (
              <p className="mt-10 flex items-center gap-3 text-[1.2rem] text-ink-2">
                <SearchIcon className="size-5" /> Nada coincide con «{query}».
              </p>
            )}
          </>
        )}
      </div>
      {pluginModal}
    </div>
  );
}
