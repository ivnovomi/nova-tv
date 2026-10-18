import { useEffect, useRef, useState, type RefObject } from "react";
import Hls, { type HlsConfig, type Loader, type LoaderCallbacks, type LoaderConfiguration, type PlaylistLoaderContext } from "hls.js";
import { api, inTauri } from "../../lib/api";
import { bufferedAhead, cushionLevel, knownBandwidth, MAX_LEVEL, PLANS, rememberBandwidth, setCushionLevel, startQuality } from "./cushion";

export type StreamStatus =
  | { kind: "idle" }
  /** `margin`: stopped on purpose to load a few seconds ahead (slow channel). */
  | { kind: "loading"; margin?: boolean }
  | { kind: "playing" }
  | { kind: "error"; message: string };

/** Two stalls this close together mean the channel needs more margin. */
const STALL_WINDOW_MS = 120_000;
/** This long without a stall and the channel earns a step of margin back. */
const SMOOTH_MS = 10 * 60_000;

/** A stream played by the platform's own embedded player (YouTube, Twitch). */
export interface Embed {
  kind: "youtube" | "twitch";
  src: string;
  /** The embedded player reports back: playing, or failed. */
  report: (ok: boolean) => void;
}

/** Turns HTTP failures into something a viewer can act on. */
function explain(code: number | undefined, youtube: boolean): string {
  if (youtube) return "Este canal no está emitiendo en directo ahora mismo. Prueba más tarde.";
  switch (code) {
    case 451:
      return "Este canal bloquea las conexiones con VPN o proxy. Desactiva la VPN para verlo.";
    case 403:
      return "El canal ha denegado el acceso (suele ser solo para España o requiere suscripción).";
    case 404:
      return "La emisión no está disponible ahora mismo.";
    default:
      return "Sin señal: no se pudo conectar con la emisión.";
  }
}

/** Pluto TV only lets its own website read its playlists: NOVA fetches (and signs) them. */
const proxied = (url: string) => {
  try {
    return inTauri && new URL(url).hostname.endsWith(".pluto.tv");
  } catch {
    return false;
  }
};

const Base = Hls.DefaultConfig.loader as unknown as new (config: HlsConfig) => Loader<PlaylistLoaderContext>;

/**
 * hls.js playlist loader that gets the playlists `through` matches from NOVA
 * (`fetchText`) and everything else as usual.
 */
function loaderThrough(through: (url: string) => boolean, fetchText: (url: string) => Promise<string>) {
  return class PlaylistLoader extends Base {
  private cancelled = false;

  load(context: PlaylistLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<PlaylistLoaderContext>) {
    if (!through(context.url)) return super.load(context, config, callbacks);
    const stats = this.stats;
    stats.loading.start = performance.now();
    fetchText(context.url).then(
      (text) => {
        if (this.cancelled) return;
        const now = performance.now();
        stats.loading.first = stats.loading.end = now;
        stats.loaded = stats.total = text.length;
        callbacks.onSuccess({ url: context.url, data: text, code: 200 }, stats, context, null);
      },
      (e) => {
        if (this.cancelled) return;
        const code = Number(/HTTP (\d+)/.exec(String(e))?.[1] ?? 0);
        callbacks.onError({ code, text: String(e) }, context, null, stats);
      },
    );
  }

  abort() {
    this.cancelled = true;
    super.abort();
  }

  destroy() {
    this.cancelled = true;
    super.destroy();
  }
  };
}

/** Pluto TV playlists through NOVA (signed there). */
const PlutoLoader = loaderThrough(proxied, (url) => api.livetvPlaylist(url));

/** A plugin stream that asked for the proxy: all its playlists through NOVA, as that plugin. */
const pluginLoaders = new Map<string, ReturnType<typeof loaderThrough>>();
function pluginLoader(plugin: string) {
  let loader = pluginLoaders.get(plugin);
  if (!loader) {
    loader = loaderThrough(() => inTauri, (url) => api.pluginsPlaylist(plugin, url));
    pluginLoaders.set(plugin, loader);
  }
  return loader;
}

/** `youtube:<video>` / `youtube:channel:<UC…>` → embed URL (muted on our side, no controls). */
function embedUrl(stream: string) {
  const id = stream.slice("youtube:".length);
  const params = new URLSearchParams({ autoplay: "1", controls: "0", disablekb: "1", enablejsapi: "1", rel: "0", playsinline: "1", iv_load_policy: "3", origin: location.origin });
  if (id.startsWith("channel:")) {
    params.set("channel", id.slice("channel:".length));
    return `https://www.youtube.com/embed/live_stream?${params}`;
  }
  return `https://www.youtube.com/embed/${id}?${params}`;
}

/**
 * `twitch:<login>` → Twitch's embedded player. Twitch only allows it inside
 * https pages (NOVA serves itself as https://tauri.localhost) or localhost.
 */
function twitchUrl(stream: string) {
  const login = stream.slice("twitch:".length);
  const params = new URLSearchParams({ channel: login, parent: location.hostname, autoplay: "true" });
  return `https://player.twitch.tv/?${params}`;
}

const spanish = (lang?: string, name?: string) => /^(es|spa)\b/i.test(lang ?? "") || /espa|spanish|castellano/i.test(name ?? "");

/**
 * Subtitles, one track at most. Broadcasts often carry several at once (captions
 * inside the video plus separate English/Spanish tracks) and the engine would
 * draw them all on top of each other. Off: none. On: Spanish first, else the
 * first subtitle track, else the captions.
 */
function applySubtitles(el: HTMLVideoElement, hls: Hls | null, on: boolean) {
  if (hls) {
    const tracks = hls.subtitleTracks;
    const index = on ? Math.max(tracks.findIndex((t) => spanish(t.lang, t.name)), tracks.length ? 0 : -1) : -1;
    if (hls.subtitleTrack !== index) hls.subtitleTrack = index;
  }
  const text = Array.from(el.textTracks).filter((t) => t.kind === "subtitles" || t.kind === "captions");
  const pick = on ? (text.find((t) => spanish(t.language, t.label)) ?? text.find((t) => t.kind === "subtitles") ?? text[0]) : undefined;
  for (const t of text) {
    const mode: TextTrackMode = t === pick ? "showing" : "disabled";
    if (t.mode !== mode) t.mode = mode;
  }
}

/**
 * Plays the first working stream of `streams`, falling back to the next one on
 * fatal errors: HLS in `video` (native HLS where the engine has it), or an
 * official YouTube live stream through `embed`.
 */
export function useHlsStream(
  video: RefObject<HTMLVideoElement | null>,
  streams: string[] | undefined,
  key: string,
  /** Called once per tune: played (with the index of the stream that worked) or failed. */
  onResult?: (ok: boolean, blocked: boolean, streamIndex: number) => void,
  subtitles = false,
) {
  const [status, setStatus] = useState<StreamStatus>({ kind: "idle" });
  const [embed, setEmbed] = useState<Embed | null>(null);
  /** Margin level in use (0 = at the live edge) and how far behind live, in seconds. */
  const [margin, setMargin] = useState<{ level: number; latency: number | null }>({ level: 0, latency: null });
  const report = useRef(onResult);
  report.current = onResult;
  const subs = useRef(subtitles);
  subs.current = subtitles;
  const hlsRef = useRef<Hls | null>(null);

  // Turning subtitles on/off applies right away, without retuning.
  useEffect(() => {
    if (video.current) applySubtitles(video.current, hlsRef.current, subtitles);
  }, [subtitles, video]);

  useEffect(() => {
    const el = video.current;
    setEmbed(null);
    if (!el || !streams?.length) {
      setStatus({ kind: "idle" });
      return;
    }
    let hls: Hls | null = null;
    let index = 0;
    let lastCode: number | undefined;
    let cancelled = false;
    setStatus({ kind: "loading" });

    // ── Margin ("en diferido") for channels that stall ──
    let level = cushionLevel(key);
    setMargin({ level, latency: null });
    /** Seconds of picture wanted before (re)starting; undefined = not holding. */
    let gate: number | undefined;
    let gateDeadline = 0;
    let stalls: number[] = [];
    let lastStall = 0;
    let lastRaise = 0;
    let earnedBack = false;

    const hold = (seconds: number, reason: "start" | "stall") => {
      gate = seconds;
      gateDeadline = performance.now() + seconds * 1000 + 8000; // never wait forever
      if (reason === "stall") {
        el.pause();
        setStatus({ kind: "loading", margin: true });
      }
    };
    const release = () => {
      if (gate === undefined || cancelled) return;
      if (bufferedAhead(el) >= gate || performance.now() > gateDeadline) {
        gate = undefined;
        void el.play().catch(() => {});
      }
    };

    let reported = false;
    const onPlaying = () => {
      if (cancelled) return;
      setStatus({ kind: "playing" });
      if (!reported) {
        reported = true;
        report.current?.(true, false, index);
      }
    };
    const onWaiting = () => {
      if (cancelled) return;
      setStatus((s) => (s.kind === "playing" ? { kind: "loading" } : s));
      if (!reported || gate !== undefined) return; // still starting up
      // A stall while watching: two close together → more margin, now and next time.
      const now = performance.now();
      lastStall = now;
      stalls = [...stalls.filter((t) => now - t < STALL_WINDOW_MS), now];
      if (stalls.length >= 2 && now - lastRaise > 60_000 && level < MAX_LEVEL) {
        lastRaise = now;
        stalls = [];
        level += 1;
        setCushionLevel(key, level);
        setMargin((m) => ({ ...m, level }));
        // One quality step down for the rest of this viewing.
        if (hls && hls.levels.length > 1) hls.autoLevelCapping = Math.max(0, (hls.currentLevel >= 0 ? hls.currentLevel : hls.levels.length - 1) - 1);
        hold(PLANS[level].prebuffer, "stall");
      }
    };
    el.addEventListener("playing", onPlaying);
    el.addEventListener("waiting", onWaiting);
    el.addEventListener("progress", release);
    const startedAt = performance.now();
    const ticker = window.setInterval(() => {
      if (cancelled) return;
      release();
      if (hls && !el.paused) setMargin((m) => (m.latency === Math.round(hls?.latency ?? 0) ? m : { ...m, latency: Math.round(hls?.latency ?? 0) }));
      // Smooth for a long while: the channel earns a step of margin back (once per viewing).
      const since = performance.now() - Math.max(lastStall, startedAt);
      if (!earnedBack && level > 0 && reported && !el.paused && since > SMOOTH_MS) {
        earnedBack = true;
        setCushionLevel(key, level - 1);
      }
    }, 1000);
    // New tracks keep appearing as the stream plays (and the engine re-enables
    // its own): every time, keep exactly the one we want.
    const enforce = () => !cancelled && applySubtitles(el, hls, subs.current);
    el.textTracks.addEventListener("addtrack", enforce);
    el.textTracks.addEventListener("change", enforce);

    // A plugin stream refused (401/403): ask the plugin once for a fresh one.
    let pluginRetried = false;
    const fail = () => {
      hls?.destroy();
      hls = null;
      setEmbed(null);
      if (streams[index]?.startsWith("plugin:") && !pluginRetried && (lastCode === 401 || lastCode === 403)) {
        pluginRetried = true;
        start();
        return;
      }
      pluginRetried = false;
      index += 1;
      if (index < streams.length) start();
      else if (!cancelled) {
        setStatus({ kind: "error", message: explain(lastCode, streams.every((s) => s.startsWith("youtube:") || s.startsWith("twitch:"))) });
        report.current?.(false, lastCode === 401 || lastCode === 403 || lastCode === 451, 0);
      }
    };

    const start = () => {
      if (cancelled) return;
      const url = streams[index];
      // A plugin's channel: the plugin says what plays, right now.
      if (url.startsWith("plugin:")) {
        api.pluginsStream(url, pluginRetried).then(
          (r) => !cancelled && begin(r.stream, r.proxy ? r.plugin : null),
          (e) => {
            if (cancelled) return;
            lastCode = Number(/HTTP (\d+)/.exec(String(e))?.[1] ?? 0);
            fail();
          },
        );
        return;
      }
      begin(url, null);
    };

    /** Plays one stream; `viaPlugin` routes its playlists through that plugin's proxy. */
    const begin = (url: string, viaPlugin: string | null) => {
      if (cancelled) return;
      if (url.startsWith("youtube:") || url.startsWith("twitch:")) {
        el.removeAttribute("src");
        let settled = false;
        const twitch = url.startsWith("twitch:");
        setEmbed({
          kind: twitch ? "twitch" : "youtube",
          src: twitch ? twitchUrl(url) : embedUrl(url),
          report: (ok) => {
            if (settled || cancelled) return;
            settled = true;
            if (ok) onPlaying();
            else fail();
          },
        });
        return;
      }
      const plan = PLANS[level];
      if (Hls.isSupported()) {
        hls = new Hls({
          // Loading starts once NOVA has picked the starting quality (below).
          autoStartLoad: false,
          abrEwmaDefaultEstimate: knownBandwidth(),
          backBufferLength: 30,
          maxBufferLength: 30,
          maxMaxBufferLength: 60,
          manifestLoadingMaxRetry: 1,
          levelLoadingMaxRetry: 2,
          // Starts downloading the first piece while the playlist is still being read.
          startFragPrefetch: true,
          // No 1080p for the small picture-in-picture window.
          capLevelToPlayerSize: true,
          pLoader: viaPlugin ? pluginLoader(viaPlugin) : PlutoLoader,
          ...(plan.behind ? { liveSyncDuration: plan.behind, liveMaxLatencyDuration: plan.behind + 120 } : {}),
          ...(plan.lowStart ? { startLevel: 0 } : {}),
          ...(plan.carefulAbr ? { abrBandWidthFactor: 0.75, abrBandWidthUpFactor: 0.5 } : {}),
        });
        hlsRef.current = hls;
        hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, enforce);
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, data) => {
          enforce();
          // Good picture from the first second: start at the quality this
          // connection holds (slow channels start low and climb).
          const screen = Math.max(el.clientHeight, 360) * (window.devicePixelRatio || 1);
          const levels = data.levels.map((l) => ({ bitrate: l.bitrate, height: l.height }));
          if (hls && levels.length) hls.startLevel = plan.lowStart ? 0 : startQuality(levels, knownBandwidth(), plan.carefulAbr, screen);
          hls?.startLoad(-1);
        });
        // What the downloads actually measured, for the next channel.
        hls.on(Hls.Events.FRAG_LOADED, () => hls && rememberBandwidth(hls.bandwidthEstimate));
        hls.on(Hls.Events.FRAG_BUFFERED, release);
        // Broken media on this stream: recover, then recover swapping the audio codec, then move on.
        let mediaErrors = 0;
        hls.on(Hls.Events.ERROR, (_e, data) => {
          lastCode = (data.response as { code?: number } | undefined)?.code ?? lastCode;
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaErrors < 2) {
            mediaErrors += 1;
            if (mediaErrors === 2) hls?.swapAudioCodec();
            hls?.recoverMediaError();
          } else fail();
        });
        hls.loadSource(url);
        hls.attachMedia(el);
      } else if (el.canPlayType("application/vnd.apple.mpegurl")) {
        el.src = url;
        el.onerror = fail;
      } else {
        setStatus({ kind: "error", message: "Este equipo no puede reproducir emisiones HLS." });
        return;
      }
      // Slow channel: load a few seconds first, then play without stopping.
      if (plan.prebuffer > 0) hold(plan.prebuffer, "start");
      else void el.play().catch(() => {});
    };

    start();
    return () => {
      cancelled = true;
      hlsRef.current = null;
      window.clearInterval(ticker);
      el.removeEventListener("playing", onPlaying);
      el.removeEventListener("waiting", onWaiting);
      el.removeEventListener("progress", release);
      el.textTracks.removeEventListener("addtrack", enforce);
      el.textTracks.removeEventListener("change", enforce);
      el.onerror = null;
      hls?.destroy();
      el.removeAttribute("src");
      el.load();
    };
    // `key` changes when the channel changes; streams is derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return { status, embed, margin };
}
