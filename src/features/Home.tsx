import { useEffect, useMemo, useState, type ComponentType } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Clapperboard, FolderOpen, Gamepad2, Play, Plus, RadioTower, RotateCcw, Tv, type LucideProps } from "lucide-react";
import { AddTile, AppTile, Row, StreamTile, streamStyle } from "../components/Tiles";
import { posterBackground } from "../components/art";
import { ambient } from "../app/ambient";
import { byRecent, useNova } from "../app/context";
import { playtimeLabel, usePlaytime } from "../hooks/useLiveData";
import { remaining } from "../lib/api";
import type { Shortcut } from "../lib/types";
import { platformLabel, playable, useGameMeta } from "./gaming/useGameMeta";
import { LiveTvRow } from "./livetv/LiveTvRow";
import { isAvailable, liveTv, onAir, useLiveTv } from "./livetv/store";
import { preview, TWITCH_BG, TwitchTile, useTwitchLive, viewers } from "./TwitchRow";
import { PluginRowsSection } from "./PluginRows";
import type { TwitchLive } from "../lib/types";

/** What the top of Home shows (and the ambient backdrop uses) for the focused item. */
interface Feature {
  key: string;
  eyebrow: string;
  title: string;
  meta?: string;
  description?: string;
  images: string[];
  fallback?: string;
  progress?: number | null;
  primary: { label: string; icon: ComponentType<LucideProps>; run: () => void };
  secondary?: { label: string; icon: ComponentType<LucideProps>; run: () => void };
}

const yt = (id: string) => [`https://i.ytimg.com/vi/${id}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${id}/hqdefault.jpg`];

/** A "Para ti" card: artwork, what it is, and progress when there is any. */
function ForYouTile({ f, onFocus }: { f: Feature; onFocus: () => void }) {
  const [i, setI] = useState(0);
  const src = f.images[i];
  return (
    <button
      data-nav
      onFocus={onFocus}
      onClick={f.primary.run}
      aria-label={`${f.eyebrow}: ${f.title}`}
      className="focus-lift relative flex h-[12.5rem] w-[22rem] shrink-0 flex-col justify-end overflow-hidden rounded-[var(--radius-tile)] border border-white/10 text-left shadow-[var(--shadow-tile)]"
      style={{ background: f.fallback ?? "linear-gradient(135deg,#1b2350,#0a0f24)" }}
    >
      {src && (
        <img
          src={src}
          alt=""
          loading="lazy"
          draggable={false}
          onError={() => setI((n) => n + 1)}
          onLoad={(e) => e.currentTarget.naturalWidth <= 120 && setI((n) => n + 1)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />
      <span className="relative px-4 pb-3">
        <span className="block truncate text-[0.8rem] font-semibold uppercase tracking-[0.12em] text-white/70">{f.eyebrow}</span>
        <span className="mt-0.5 line-clamp-2 text-[1.15rem] font-semibold leading-snug [text-shadow:0_1px_8px_rgb(0_0_0/0.8)]">{f.title}</span>
      </span>
      {f.progress != null && (
        <span className="relative block h-1 w-full bg-white/15">
          <span className="block h-full bg-white" style={{ width: `${Math.min(100, f.progress * 100)}%` }} />
        </span>
      )}
    </button>
  );
}

function FeatureArea({ f }: { f: Feature | undefined }) {
  return (
    <div className="flex min-h-[clamp(17rem,36vh,24rem)] items-end px-[var(--gutter)] pb-2">
      <AnimatePresence mode="wait" initial={false}>
        {f && (
          <motion.div
            key={f.key}
            className="max-w-[48rem]"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
          >
            <p className="text-[1rem] font-semibold uppercase tracking-[0.16em] text-white/75">{f.eyebrow}</p>
            <h1 className="mt-2 line-clamp-2 text-[clamp(2.6rem,4vw,4.2rem)] font-bold leading-[1.02] tracking-[-0.02em] [text-shadow:0_4px_30px_rgb(0_0_0/0.6)]">{f.title}</h1>
            {f.meta && <p className="mt-3 text-[1.15rem] text-white/80">{f.meta}</p>}
            {f.description && <p className="mt-2 line-clamp-2 max-w-[42rem] text-[1.1rem] leading-relaxed text-white/70">{f.description}</p>}
            <div className="mt-5 flex items-center gap-3">
              <button data-nav onClick={f.primary.run} className="focus-lift btn h-[3.6rem] bg-white text-[1.15rem] text-black">
                <f.primary.icon className="size-5" fill={f.primary.icon === Play ? "currentColor" : "none"} /> {f.primary.label}
              </button>
              {f.secondary && (
                <button data-nav onClick={f.secondary.run} className="focus-lift btn btn-ghost h-[3.6rem]">
                  <f.secondary.icon className="size-5" /> {f.secondary.label}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Interleaves sources so "Para ti" mixes kinds instead of listing them in blocks. */
function interleave<T>(...lists: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) lists.forEach((l) => i < l.length && out.push(l[i]));
  return out;
}

export function HomeScreen() {
  const nova = useNova();
  const playtime = usePlaytime();
  const meta = useGameMeta();
  const tv = useLiveTv();
  const { library, recentMedia, launching } = nova;
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const twitch = useTwitchLive();

  useEffect(() => void liveTv.load(), []);

  const twitchFeature = (s: TwitchLive): Feature => ({
    key: `twitch:${s.login}`,
    eyebrow: `Twitch en directo${s.game ? ` · ${s.game}` : ""}`,
    title: s.title,
    meta: `${s.name} · ${viewers(s.viewers)} espectadores`,
    images: [preview(s)].filter(Boolean),
    fallback: TWITCH_BG,
    primary: { label: "Ver en directo", icon: Play, run: () => nova.playTwitch(s.login, s.name) },
  });

  const apps = useMemo(() => (library ? byRecent(library.apps, library.recent) : []), [library]);
  const streaming = useMemo(() => (library ? byRecent(library.streaming, library.recent) : []), [library]);
  const games = useMemo(() => (library ? playable(byRecent(library.games, library.recent), meta) : []), [library, meta]);
  const youtube = streaming.find((s) => s.id === "stream:youtube");

  const gameFeature = (g: Shortcut, eyebrow?: string): Feature => {
    const m = meta[g.id];
    return {
      key: `game:${g.id}`,
      eyebrow: eyebrow ?? `Juego · ${platformLabel(g)}`,
      title: m?.title ?? g.name,
      meta: [playtimeLabel(playtime[g.id]), m?.genres.slice(0, 2).join(", "), m?.year].filter(Boolean).join(" · ") || undefined,
      description: m?.description ?? undefined,
      images: [m?.hero, m?.header].filter((x): x is string => !!x),
      fallback: posterBackground(g.id, g.name),
      primary: { label: "Jugar", icon: Play, run: () => nova.launch(g) },
      secondary: { label: "NOVA PLAY", icon: Gamepad2, run: nova.enterGaming },
    };
  };

  const appFeature = (s: Shortcut): Feature => ({
    key: `app:${s.id}`,
    eyebrow: s.kind === "stream" ? "Streaming" : "Aplicación",
    title: s.name,
    description: s.description ?? undefined,
    images: [],
    fallback: s.kind === "stream" ? streamStyle(s).bg : posterBackground(s.id, s.name),
    primary: { label: "Abrir", icon: Play, run: () => nova.launch(s) },
  });

  // ── "Para ti": real things, mixed ──
  const forYou = useMemo<Feature[]>(() => {
    const resume = nova.history
      .filter((e) => !e.finished && e.position > 15)
      .slice(0, 4)
      .map<Feature>((e) => ({
        key: `yt:${e.key}`,
        eyebrow: "Seguir viendo · YouTube",
        title: e.title,
        meta: [e.channel, remaining(e.position, e.duration)].filter(Boolean).join(" · "),
        images: [...yt(e.itemId), e.thumbnail ?? ""].filter(Boolean),
        progress: e.duration ? e.position / e.duration : null,
        primary: { label: "Seguir viendo", icon: Play, run: () => nova.playVideo(e.itemId, e.position) },
        secondary: { label: "Desde el principio", icon: RotateCcw, run: () => nova.playVideo(e.itemId, 0) },
      }));

    const channels = tv.data?.channels ?? [];
    const liveIds = [tv.data?.lastChannel, ...(tv.data?.favorites ?? [])].filter((x): x is string => !!x);
    const live = [...new Set(liveIds)]
      .map((id) => channels.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c && isAvailable(c, tv.health, true))
      .slice(0, 2)
      .map<Feature>((c) => {
        const air = onAir(tv.epg, c);
        return {
          key: `tv:${c.id}`,
          eyebrow: `En directo · ${c.name}`,
          title: air.current?.title ?? c.name,
          meta: air.next ? `A continuación: ${air.next.title}` : undefined,
          description: air.current?.description ?? undefined,
          images: [air.current?.image ?? ""].filter(Boolean),
          fallback: "radial-gradient(80% 120% at 80% 0%, rgb(255 59 92 / 0.45), transparent 60%), linear-gradient(135deg,#1a0b14,#06070d)",
          progress: air.progress,
          primary: { label: "Ver en directo", icon: RadioTower, run: () => liveTv.play(c.id) },
          secondary: { label: "Encender la TV", icon: Tv, run: () => void liveTv.open() },
        };
      });

    const recentIds = new Set(library?.recent ?? []);
    const played = games.filter((g) => recentIds.has(g.id) || playtime[g.id]).slice(0, 3).map((g) => gameFeature(g, `Seguir jugando · ${platformLabel(g)}`));

    const feed = nova.feed.slice(0, 4).map<Feature>((f) => ({
      key: `feed:${f.videoId}`,
      eyebrow: `Nuevo · ${f.channel}`,
      title: f.title,
      images: [...yt(f.videoId), f.thumbnail],
      primary: { label: "Ver", icon: Play, run: () => nova.playVideo(f.videoId) },
    }));

    const media = recentMedia
      .filter((m) => m.exists)
      .slice(0, 1)
      .map<Feature>((m) => ({
        key: `media:${m.path}`,
        eyebrow: "Multimedia · último archivo",
        title: m.name,
        meta: m.path.replace(/[\\/][^\\/]*$/, ""),
        images: [],
        fallback: "radial-gradient(100% 120% at 100% 0%, rgb(255 79 154 / 0.4), transparent 60%), linear-gradient(140deg,#1a0f2e,#090b1c)",
        primary: { label: "Reproducir", icon: Play, run: () => nova.openMedia(m.path) },
        secondary: { label: "Abrir otro", icon: FolderOpen, run: nova.pickAndOpenMedia },
      }));

    const streams = twitch.slice(0, 2).map(twitchFeature);
    const mixed = interleave(resume, live, played, feed, streams, media);
    if (mixed.length >= 3) return mixed;
    // Little history yet: offer the best starting points.
    const starters: Feature[] = [
      {
        key: "start:tv",
        eyebrow: "TV en directo",
        title: "Enciende la tele",
        description: "Canales de la TDT y de todo el mundo, con guía y zapping.",
        images: [],
        fallback: "radial-gradient(80% 120% at 80% 0%, rgb(63 213 242 / 0.4), transparent 60%), linear-gradient(135deg,#071b24,#05070d)",
        primary: { label: "Encender la TV", icon: Tv, run: () => void liveTv.open() },
      },
      ...(youtube ? [{ ...appFeature(youtube), key: "start:yt", eyebrow: "Streaming", title: "YouTube, como en la tele", description: "La interfaz de TV de YouTube, dentro de NOVA." }] : []),
      {
        key: "start:play",
        eyebrow: "Modo Juego",
        title: "NOVA PLAY",
        description: "Tu biblioteca de juegos como una consola.",
        images: [],
        fallback: "radial-gradient(80% 120% at 20% 0%, rgb(92 255 143 / 0.35), transparent 60%), linear-gradient(135deg,#0d1f18,#05080c)",
        primary: { label: "Entrar", icon: Gamepad2, run: nova.enterGaming },
      },
    ];
    return [...mixed, ...starters];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nova.history, nova.feed, tv.data, tv.epg, tv.health, games, playtime, recentMedia, library, youtube, twitch]);

  const features = useMemo(() => {
    const map = new Map<string, Feature>();
    forYou.forEach((f) => map.set(f.key, f));
    twitch.forEach((s) => map.set(`twitch:${s.login}`, twitchFeature(s)));
    games.forEach((g) => map.set(`game:${g.id}`, gameFeature(g)));
    [...streaming, ...apps].forEach((s) => map.set(`app:${s.id}`, appFeature(s)));
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forYou, games, streaming, apps, meta, playtime, twitch]);

  const feature = (focusKey && features.get(focusKey)) || forYou[0];

  // The focused item becomes the app's backdrop.
  useEffect(() => {
    if (!feature) return;
    ambient.set({ key: feature.key, images: feature.images, fallback: feature.fallback });
  }, [feature]);
  useEffect(() => () => ambient.set(null), []);

  const focus = (key: string) => () => setFocusKey(key);

  return (
    <div className="pb-14">
      <FeatureArea f={feature} />

      <section className="mt-6">
        <h2 className="mb-3 px-[var(--gutter)] text-[1.4rem] font-semibold">Para ti</h2>
        <div className="row-scroller">
          {forYou.map((f) => (
            <ForYouTile key={f.key} f={f} onFocus={focus(f.key)} />
          ))}
        </div>
      </section>

      <LiveTvRow onSeeAll={() => void liveTv.open()} />

      {twitch.length > 0 && (
        <Row title="Twitch en directo">
          {twitch.map((s) => (
            <TwitchTile key={s.login} s={s} onFocus={focus(`twitch:${s.login}`)} onPlay={() => nova.playTwitch(s.login, s.name)} />
          ))}
        </Row>
      )}

      <PluginRowsSection />

      <Row title="Streaming" action={{ label: "Ver todo", onClick: () => nova.navigate("streaming") }}>
        {streaming.slice(0, 12).map((s) => (
          <div key={s.id} onFocus={focus(`app:${s.id}`)}>
            <StreamTile item={s} busy={launching === s.id} onActivate={nova.launch} />
          </div>
        ))}
      </Row>

      <Row title="Juegos" action={{ label: "NOVA PLAY", onClick: nova.enterGaming }}>
        {games.slice(0, 12).map((g) => {
          const m = meta[g.id];
          return (
            <GameTile key={g.id} game={g} art={m?.header ?? m?.hero ?? null} label={playtimeLabel(playtime[g.id])} busy={launching === g.id} onFocus={focus(`game:${g.id}`)} onPlay={() => nova.launch(g)} />
          );
        })}
        <AddTile wide icon={Plus} title="Añadir juego" subtitle="Ejecutable .exe o App ID de Steam" onClick={() => nova.navigate("games")} />
      </Row>

      <Row title="Apps" action={{ label: "Ver todas", onClick: () => nova.navigate("apps") }}>
        {apps.slice(0, 12).map((a) => (
          <div key={a.id} onFocus={focus(`app:${a.id}`)}>
            <AppTile item={a} busy={launching === a.id} onActivate={nova.launch} />
          </div>
        ))}
        <AddTile title="Añadir app" icon={Clapperboard} onClick={() => nova.openDialog({ type: "add-exe", kind: "app" })} />
      </Row>
    </div>
  );
}

/** Game card with its real store art (falls back to typographic key art). */
function GameTile({ game, art, label, busy, onFocus, onPlay }: { game: Shortcut; art: string | null; label: string | null; busy: boolean; onFocus: () => void; onPlay: () => void }) {
  const [failed, setFailed] = useState(false);
  return (
    <button
      data-nav
      onFocus={onFocus}
      onClick={onPlay}
      aria-label={`Jugar a ${game.name}`}
      aria-busy={busy}
      className="focus-lift relative flex h-[11.5rem] w-[20.5rem] shrink-0 flex-col justify-end overflow-hidden rounded-[var(--radius-tile)] border border-white/10 text-left shadow-[var(--shadow-tile)]"
      style={{ background: posterBackground(game.id, game.name) }}
    >
      {art && !failed && <img src={art} alt="" loading="lazy" onError={() => setFailed(true)} className="absolute inset-0 size-full object-cover" />}
      <span className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/20 to-transparent" />
      <span className="relative px-4 pb-3">
        {(failed || !art) && <span className="block truncate text-[1.25rem] font-bold uppercase tracking-wide">{game.name}</span>}
        {label && <span className="block truncate text-[0.85rem] text-white/75">{label}</span>}
      </span>
    </button>
  );
}
