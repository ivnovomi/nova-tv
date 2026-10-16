import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { Captions, Globe, ListPlus, LoaderCircle, Maximize2, Power, RefreshCw, Signal, Star, Trash2, TriangleAlert, Tv, Volume2, VolumeX, X } from "lucide-react";
import { useBackHandler, useHomeHandler } from "../../hooks/backStack";
import { formatTime, useClock } from "../../hooks/useClock";
import { focusFirst } from "../../lib/spatialNav";
import { api } from "../../lib/api";
import type { Channel } from "../../lib/types";
import { useToast } from "../../components/Toasts";
import { power, usePower } from "../../app/power";
import { ChannelGuide } from "./Guide";
import { groupLabel, hhmm, isAvailable, liveTv, onAir, orderedStreams, useLiveTv } from "./store";
import { useHlsStream } from "./useHlsStream";
import { TwitchPlayer, YouTubeLive } from "./YouTubeLive";

const BANNER_MS = 5000;
const DIGIT_MS = 1500;

type Overlay = "none" | "info" | "menu" | "guide";

export function ChannelLogo({ channel, className = "size-12" }: { channel: Channel; className?: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className={`grid shrink-0 place-items-center overflow-hidden rounded-lg bg-white/92 ${className}`}>
      {channel.logo && !failed ? (
        <img src={channel.logo} alt="" loading="lazy" onError={() => setFailed(true)} className="size-full object-contain p-1" />
      ) : (
        <span className="px-1 text-center text-[0.8rem] font-bold leading-tight text-black">{channel.name.slice(0, 6)}</span>
      )}
    </span>
  );
}

/** CRT-style power on/off: a bright line that opens (or collapses) the picture. */
function PowerFx({ off, onDone }: { off: boolean; onDone?: () => void }) {
  return (
    <motion.div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-black" initial={{ opacity: 1 }} animate={{ opacity: off ? 1 : 0 }} transition={{ delay: off ? 0 : 0.55, duration: 0.35 }}>
      <motion.div
        className="h-full w-full bg-white shadow-[0_0_80px_20px_rgb(180_200_255/0.8)]"
        initial={off ? { scaleX: 1, scaleY: 1, opacity: 0 } : { scaleX: 0, scaleY: 0.004, opacity: 1 }}
        animate={off ? { scaleX: [1, 1, 0], scaleY: [1, 0.004, 0.004], opacity: [0.15, 1, 0] } : { scaleX: [0, 1, 1], scaleY: [0.004, 0.004, 1], opacity: [1, 1, 0] }}
        transition={{ duration: off ? 0.55 : 0.6, times: [0, 0.45, 1], ease: "easeInOut" }}
        onAnimationComplete={onDone}
      />
    </motion.div>
  );
}

function Panel({ side, children, className = "" }: { side: "left" | "right" | "center"; children: ReactNode; className?: string }) {
  const pos = side === "left" ? "inset-y-0 left-0" : side === "right" ? "inset-y-0 right-0" : "inset-0 m-auto h-fit max-h-[86vh]";
  const from = side === "left" ? { x: "-100%" } : side === "right" ? { x: "100%" } : { opacity: 0, scale: 0.97 };
  const to = side === "center" ? { opacity: 1, scale: 1 } : { x: 0 };
  return (
    <motion.div
      data-nav-scope
      className={`absolute z-10 flex flex-col border-white/10 bg-[#05070d]/92 backdrop-blur-2xl ${pos} ${side === "left" ? "border-r" : side === "right" ? "border-l" : "rounded-[1.6rem] border"} ${className}`}
      initial={from}
      animate={to}
      exit={from}
      transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
      onClick={(e) => e.stopPropagation()}
    >
      {children}
    </motion.div>
  );
}

export function TvMode() {
  const tv = useLiveTv();
  const { data, epg, health, playing, hideUnavailable, pip } = tv;
  const toast = useToast();
  const clock = useClock();
  const video = useRef<HTMLVideoElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const [overlay, setOverlay] = useState<Overlay>("none");
  const [banner, setBanner] = useState(true);
  const [digits, setDigits] = useState("");
  const [powering, setPowering] = useState<"on" | "off" | null>("on");
  const [muted, setMuted] = useState(false);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const bannerTimer = useRef<number | undefined>(undefined);
  const digitTimer = useRef<number | undefined>(undefined);

  const all = useMemo(() => [...(data?.channels ?? [])].sort((a, b) => a.number - b.number), [data]);
  const channel = all.find((c) => c.id === playing);
  /** What zapping and the list go through: channels with signal (or unchecked yet). */
  const visible = useMemo(() => all.filter((c) => c.id === playing || isAvailable(c, health, hideUnavailable)), [all, health, hideUnavailable, playing]);
  const streams = useMemo(() => (channel ? orderedStreams(channel, health) : undefined), [channel, health]);

  const { status, embed, margin } = useHlsStream(video, streams, channel?.id ?? "", (ok, blocked, i) => {
    if (!channel || !streams) return;
    liveTv.report(channel.id, ok, blocked, Math.max(0, channel.streams.indexOf(streams[i])));
  }, tv.subtitles);

  const toggleSubtitles = () => {
    liveTv.setSubtitles(!tv.subtitles);
    toast.show("info", tv.subtitles ? "Subtítulos desactivados" : "Subtítulos activados", tv.subtitles ? undefined : "Si el canal los emite. En español cuando los hay.");
  };

  const showBanner = useCallback(() => {
    setBanner(true);
    window.clearTimeout(bannerTimer.current);
    bannerTimer.current = window.setTimeout(() => setBanner(false), BANNER_MS);
  }, []);

  useEffect(() => showBanner(), [playing, showBanner]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now() / 1000), 15_000);
    return () => window.clearInterval(t);
  }, []);
  // The power menu, a countdown or the goodbye screen goes first: the TV keeps its hands off.
  const { menu: powerMenu, countdown, leaving } = usePower();
  const powerBusy = powerMenu || !!countdown || !!leaving;
  // Full screen, the TV owns the keyboard whenever no panel is open.
  useEffect(() => {
    if (overlay === "none" && !pip && !powerBusy) root.current?.focus({ preventScroll: true });
  }, [overlay, powering, pip, powerBusy]);
  useEffect(() => {
    if (pip) setOverlay("none");
    else showBanner();
  }, [pip, showBanner]);
  // A panel asked for from the phone, once the TV has finished turning on.
  useEffect(() => {
    if (!tv.panel || powering || pip || powerBusy || (tv.panel === "info" && !channel)) return;
    setOverlay(tv.panel);
    liveTv.panelShown();
  }, [tv.panel, powering, pip, powerBusy, channel]);
  // A channel number still being typed is dropped with the TV (or when it shrinks).
  useEffect(() => {
    return () => {
      window.clearTimeout(digitTimer.current);
      setDigits("");
    };
  }, [pip, overlay]);

  const powerOff = () => setPowering("off");
  // Power effects end on a timer too, so nothing can leave the TV stuck mid-animation.
  useEffect(() => {
    if (!powering) return;
    const t = window.setTimeout(() => (powering === "off" ? liveTv.close() : setPowering(null)), powering === "off" ? 700 : 1000);
    return () => window.clearTimeout(t);
  }, [powering]);
  // Back / Home: close the open panel, otherwise shrink the TV to a corner.
  useBackHandler(() => (overlay !== "none" ? setOverlay("none") : liveTv.minimize()), !pip && !powerBusy);
  useHomeHandler(() => (overlay !== "none" ? setOverlay("none") : liveTv.minimize()), !pip && !powerBusy);

  const zap = (delta: number) => liveTv.zap(delta);

  const favorite = async () => {
    if (!channel) return;
    const fav = await liveTv.toggleFavorite(channel.id);
    toast.show("success", fav ? `${channel.name} añadido a favoritos` : `${channel.name} quitado de favoritos`);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (overlay !== "none" || powering || pip) return;
    const k = e.key;
    if (k === "ArrowUp" || k === "PageUp" || k === "ChannelUp") zap(1);
    else if (k === "ArrowDown" || k === "PageDown" || k === "ChannelDown") zap(-1);
    else if (k === "ArrowLeft" || k === "Enter") setOverlay("guide");
    else if (k === "ArrowRight" || k === "Info") setOverlay("info");
    else if (k === "g" || k === "G" || k === "GamepadY" || k === "Guide") setOverlay("guide");
    else if (k === "m" || k === "M" || k === "ContextMenu" || k === "GamepadView") setOverlay("menu");
    else if (k === "f" || k === "F" || k === "GamepadX") void favorite();
    else if (k === "c" || k === "C" || k === "Subtitle") toggleSubtitles();
    else if (/^[0-9]$/.test(k)) {
      const next = (digits + k).slice(-4);
      setDigits(next);
      window.clearTimeout(digitTimer.current);
      digitTimer.current = window.setTimeout(() => {
        setDigits("");
        if (!liveTv.isOpen()) return; // the TV went off meanwhile: don't turn it back on
        if (!liveTv.tuneNumber(Number(next))) toast.show("info", `No hay canal ${next}`);
      }, DIGIT_MS);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const air = onAir(epg, channel, now);
  const isFav = !!channel && !!data?.favorites.includes(channel.id);

  return createPortal(
    <div
      ref={root}
      tabIndex={-1}
      data-nav-scope={pip || powerBusy ? undefined : true}
      onKeyDown={onKeyDown}
      onClick={() => (pip ? liveTv.expand() : overlay === "none" && showBanner())}
      className={`fixed overflow-hidden bg-black text-white outline-none transition-[inset,width,height,border-radius,box-shadow] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        pip
          ? "bottom-[5.5rem] right-[var(--gutter)] top-auto left-auto z-30 h-[13.5rem] w-[24rem] rounded-2xl shadow-[0_1.5rem_3rem_-1rem_rgb(0_0_0/0.9),0_0_0_1px_rgb(255_255_255/0.12)]"
          : "inset-0 z-50 h-full w-full rounded-none"
      }`}
      aria-label={channel ? `TV: ${channel.number} ${channel.name}` : "TV"}
    >
      <video ref={video} playsInline muted={muted || tv.hold} className={`absolute inset-0 size-full bg-black ${pip ? "object-cover" : "object-contain"}`} />
      {embed?.kind === "youtube" && <YouTubeLive embed={embed} muted={muted || tv.hold} className="absolute inset-0 size-full" />}
      {embed?.kind === "twitch" && <TwitchPlayer embed={embed} muted={muted || tv.hold} className="absolute inset-0 size-full" />}

      {/* Picture-in-picture controls */}
      {pip && channel && (
        <div className="absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/85 via-transparent to-black/40 p-3" onClick={(e) => e.stopPropagation()}>
          <span className="flex items-center gap-2 text-[0.9rem] font-semibold [text-shadow:0_1px_6px_rgb(0_0_0/0.8)]">
            <span className="badge bg-[#ff3b5c] text-white">● DIRECTO</span>
            <span className="truncate">
              {channel.number} · {channel.name}
            </span>
          </span>
          <span className="flex items-center gap-2">
            <button data-nav aria-label="Ampliar la TV" onClick={() => liveTv.expand()} className="focus-lift grid size-11 place-items-center rounded-full bg-white text-black">
              <Maximize2 className="size-5" />
            </button>
            <button data-nav aria-label={muted ? "Activar sonido" : "Silenciar"} onClick={() => setMuted((m) => !m)} className="focus-lift grid size-11 place-items-center rounded-full bg-white/20 backdrop-blur">
              {muted ? <VolumeX className="size-5" /> : <Volume2 className="size-5" />}
            </button>
            <button data-nav aria-label="Apagar la TV" onClick={() => liveTv.close()} className="focus-lift ml-auto grid size-11 place-items-center rounded-full bg-white/20 backdrop-blur">
              <X className="size-5" />
            </button>
          </span>
        </div>
      )}

      {/* Tuning / no signal */}
      <AnimatePresence>
        {(!channel || status.kind === "loading") && (
          <motion.div key="tuning" className="pointer-events-none absolute inset-0 grid place-items-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p className={`flex items-center gap-4 rounded-full bg-black/60 px-7 py-4 text-[1.4rem] backdrop-blur ${pip ? "hidden" : ""}`}>
              <LoaderCircle className="size-7 spin text-cyan" />{" "}
              {status.kind === "loading" && status.margin
                ? "Cargando unos segundos de margen para que no se corte…"
                : channel
                  ? `Sintonizando ${channel.name}…`
                  : tv.loading
                    ? "Buscando canales…"
                    : "Encendiendo…"}
            </p>
          </motion.div>
        )}
        {channel && status.kind === "error" && !pip && (
          <motion.div key="error" className="absolute inset-0 grid place-items-center bg-[radial-gradient(60rem_40rem_at_50%_40%,#141a33,#000)]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <div className="max-w-[46rem] text-center">
              <TriangleAlert className="mx-auto size-14 text-warn" />
              <p className="mt-5 text-[2.1rem] font-semibold">Sin señal en {channel.name}</p>
              <p className="mt-3 text-[1.25rem] text-ink-2">{status.message}</p>
              <p className="mt-6 text-[1.05rem] text-ink-3">NOVA lo ha anotado y lo ocultará de la lista · ↑ ↓ cambiar de canal</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {digits && <div className="absolute right-[var(--gutter)] top-14 rounded-2xl bg-black/70 px-7 py-3 text-[4rem] font-bold tabular-nums backdrop-blur">{digits}</div>}

      {/* Banner (and clock) */}
      <AnimatePresence>
        {channel && banner && overlay === "none" && !pip && (
          <motion.div key="banner" className="pointer-events-none absolute inset-0" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
            <p className="absolute right-[var(--gutter)] top-10 text-[2rem] font-semibold tabular-nums [text-shadow:0_2px_12px_rgb(0_0_0/0.8)]">{formatTime(clock)}</p>
            <motion.div
              className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/70 to-transparent px-[var(--gutter)] pb-10 pt-32"
              initial={{ y: 30 }}
              animate={{ y: 0 }}
              transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="flex items-end gap-7">
                <span className="text-[4.4rem] font-bold leading-none tabular-nums text-white/90">{channel.number}</span>
                <ChannelLogo channel={channel} className="size-[5.5rem] rounded-2xl" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-3 text-[1.1rem] text-ink-2">
                    {margin.level > 0 && margin.latency ? (
                      <span className="badge bg-[#ff8a3d] text-black" title="Este canal va lento: NOVA lo reproduce unos segundos por detrás para que no se corte.">
                        ● DIFERIDO · {margin.latency} s
                      </span>
                    ) : (
                      <span className="badge bg-[#ff3b5c] text-white">● EN DIRECTO</span>
                    )}
                    {channel.name} · {groupLabel(channel)}
                    {isFav && <Star className="size-5 text-warn" fill="currentColor" />}
                  </p>
                  <p className="mt-2 truncate text-[2.2rem] font-semibold leading-tight">{air.current?.title ?? channel.name}</p>
                  {air.current && (
                    <div className="mt-3 flex max-w-[48rem] items-center gap-4 text-[1rem] tabular-nums text-ink-2">
                      <span>{hhmm(air.current.start)}</span>
                      <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/20">
                        <span className="absolute inset-y-0 left-0 rounded-full bg-white" style={{ width: `${(air.progress ?? 0) * 100}%` }} />
                      </span>
                      <span>{hhmm(air.current.end)}</span>
                    </div>
                  )}
                  {air.next && <p className="mt-3 truncate text-[1.05rem] text-ink-3">A continuación · {hhmm(air.next.start)} {air.next.title}</p>}
                </div>
                <div className="hidden shrink-0 flex-col items-end gap-1.5 text-[0.95rem] text-ink-3 xl:flex">
                  <span>↑ ↓ Canal · 0-9 Número</span>
                  <span>← Lista · → Info · Y Guía</span>
                  <span>M / View Menú · C Subtítulos</span>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {overlay === "info" && channel && <InfoPanel key="info" channel={channel} isFav={isFav} onFavorite={favorite} onClose={() => setOverlay("none")} />}
        {overlay === "menu" && <TvMenu key="menu" onClose={() => setOverlay("none")} onPowerOff={powerOff} onSubtitles={toggleSubtitles} />}
        {overlay === "guide" && <ChannelGuide key="guide" channels={visible} currentId={channel?.id} onClose={() => setOverlay("none")} />}
      </AnimatePresence>

      <AnimatePresence>
        {powering && (
          <PowerFx
            key={powering}
            off={powering === "off"}
            onDone={() => {
              if (powering === "off") liveTv.close();
              else setPowering(null);
            }}
          />
        )}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

function InfoPanel({ channel, isFav, onFavorite, onClose }: { channel: Channel; isFav: boolean; onFavorite: () => void; onClose: () => void }) {
  const { epg } = useLiveTv();
  const ref = useRef<HTMLDivElement>(null);
  const air = onAir(epg, channel);
  const upcoming = air.list.filter((p) => p.start >= (air.current?.end ?? Date.now() / 1000)).slice(0, 4);
  useEffect(() => {
    const t = window.setTimeout(() => focusFirst(ref.current), 40);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <Panel side="right" className="w-[min(38rem,92vw)]">
      <div ref={ref} className="page-scroll flex min-h-0 flex-1 flex-col overflow-y-auto p-8">
        <div className="flex items-center gap-4">
          <ChannelLogo channel={channel} className="size-16 rounded-xl" />
          <div className="min-w-0">
            <p className="text-[1rem] text-ink-3">
              {channel.number} · {groupLabel(channel)}
            </p>
            <p className="truncate text-[1.6rem] font-semibold">{channel.name}</p>
          </div>
        </div>
        {air.current?.image && <img src={air.current.image} alt="" className="mt-6 aspect-video w-full rounded-xl object-cover" />}
        {air.current ? (
          <>
            <p className="mt-5 text-[1.7rem] font-semibold leading-tight">{air.current.title}</p>
            <p className="mt-1 text-[1rem] tabular-nums text-ink-3">
              {hhmm(air.current.start)} – {hhmm(air.current.end)}
              {air.current.genre ? ` · ${air.current.genre.toLowerCase()}` : ""}
            </p>
            {air.current.description && <p className="mt-3 text-[1.1rem] leading-relaxed text-ink-2">{air.current.description}</p>}
          </>
        ) : (
          <p className="mt-6 text-[1.1rem] text-ink-3">Este canal no publica su programación.</p>
        )}
        {upcoming.length > 0 && (
          <>
            <p className="eyebrow mt-7">Después</p>
            <ul className="mt-2 space-y-2">
              {upcoming.map((p) => (
                <li key={p.start} className="flex gap-4 text-[1.05rem]">
                  <span className="w-14 shrink-0 tabular-nums text-ink-3">{hhmm(p.start)}</span>
                  <span className="truncate">{p.title}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-auto flex gap-3 pt-8">
          <button data-nav onClick={onFavorite} className="focus-lift btn btn-ghost">
            <Star className={`size-5 ${isFav ? "text-warn" : ""}`} fill={isFav ? "currentColor" : "none"} /> {isFav ? "Favorito" : "Añadir a favoritos"}
          </button>
          <button data-nav onClick={onClose} className="focus-lift btn btn-primary">
            Volver a la TV
          </button>
        </div>
      </div>
    </Panel>
  );
}

function TvMenu({ onClose, onPowerOff, onSubtitles }: { onClose: () => void; onPowerOff: () => void; onSubtitles: () => void }) {
  const { data, progress, hideUnavailable, subtitles } = useLiveTv();
  const toast = useToast();
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("https://");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const total = data?.channels.length ?? 0;
  const unchecked = Math.max(0, total - (progress ? progress.ok + progress.dead + progress.blocked : 0));

  useEffect(() => {
    const t = window.setTimeout(() => focusFirst(ref.current), 40);
    return () => window.clearTimeout(t);
  }, []);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const n = await api.livetvAddPlaylist(name, url);
      toast.show("success", `Lista «${name}» añadida`, `${n} canales. NOVA comprobará su señal.`);
      setName("");
      setUrl("https://");
      await liveTv.load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const Stat = ({ value, label, tone }: { value: number; label: string; tone: string }) => (
    <div className="rounded-xl bg-white/6 px-4 py-3">
      <p className={`text-[1.8rem] font-semibold tabular-nums ${tone}`}>{value.toLocaleString("es-ES")}</p>
      <p className="text-[0.9rem] text-ink-3">{label}</p>
    </div>
  );

  return (
    <Panel side="center" className="w-[min(56rem,92vw)]">
      <div ref={ref} className="page-scroll overflow-y-auto p-9">
        <p className="text-[2rem] font-semibold">Menú de TV</p>

        <div className="mt-5 flex items-center gap-4 rounded-xl bg-white/5 px-5 py-4">
          <Captions className="size-6 shrink-0 text-ink-2" />
          <span className="min-w-0 flex-1">
            <span className="block text-[1.1rem] font-semibold">Subtítulos</span>
            <span className="block text-[0.95rem] text-ink-3">Una sola pista, en español cuando el canal la emite. Tecla C.</span>
          </span>
          <button data-nav aria-pressed={subtitles} onClick={onSubtitles} className={`focus-lift btn shrink-0 ${subtitles ? "btn-primary" : "btn-ghost"}`}>
            {subtitles ? "Activados" : "Desactivados"}
          </button>
        </div>
        <div className="mt-3 flex items-center gap-4 rounded-xl bg-white/5 px-5 py-4">
          <Power className="size-6 shrink-0 text-ink-2" />
          <span className="min-w-0 flex-1">
            <span className="block text-[1.1rem] font-semibold">Encendido</span>
            <span className="block text-[0.95rem] text-ink-3">Apagar o reiniciar el equipo, suspender, temporizador de apagado.</span>
          </span>
          <button data-nav onClick={power.openMenu} className="focus-lift btn btn-ghost shrink-0">
            Abrir
          </button>
        </div>

        <p className="eyebrow mt-6 flex items-center gap-2">
          <Signal className="size-4" /> Señal de los canales
        </p>
        <div className="mt-3 grid grid-cols-4 gap-3">
          <Stat value={progress?.ok ?? 0} label="Con señal" tone="text-ok" />
          <Stat value={progress?.dead ?? 0} label="Sin señal" tone="text-danger" />
          <Stat value={progress?.blocked ?? 0} label="Bloqueados (VPN/región)" tone="text-warn" />
          <Stat value={unchecked} label="Sin comprobar" tone="text-ink-2" />
        </div>
        {progress?.running && (
          <div className="mt-4">
            <p className="flex items-center gap-3 text-[1rem] text-ink-2">
              <LoaderCircle className="size-5 spin" /> Comprobando canales: {progress.done.toLocaleString("es-ES")} de {progress.total.toLocaleString("es-ES")}
            </p>
            <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-white/10">
              <span className="block h-full rounded-full bg-cyan transition-[width] duration-700" style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }} />
            </span>
          </div>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            data-nav
            disabled={progress?.running}
            onClick={() => liveTv.checkNow().then(() => toast.show("info", "Comprobando todos los canales", "Puedes seguir viendo la TV mientras tanto."))}
            className="focus-lift btn btn-ghost"
          >
            <RefreshCw className="size-5" /> Comprobar ahora
          </button>
          <button data-nav aria-pressed={hideUnavailable} onClick={() => liveTv.setHideUnavailable(!hideUnavailable)} className={`focus-lift btn ${hideUnavailable ? "btn-primary" : "btn-ghost"}`}>
            {hideUnavailable ? "Ocultando canales sin señal" : "Mostrando todos los canales"}
          </button>
        </div>

        <p className="eyebrow mt-8 flex items-center gap-2">
          <Globe className="size-4" /> Fuentes
        </p>
        <div className="mt-3 flex items-center gap-4 rounded-xl bg-white/5 px-5 py-4">
          <span className="min-w-0 flex-1">
            <span className="block text-[1.1rem] font-semibold">Catálogo mundial (iptv-org)</span>
            <span className="block text-[0.95rem] text-ink-3">Miles de canales públicos de todo el mundo por país y temática.</span>
          </span>
          <button
            data-nav
            aria-pressed={data?.worldEnabled}
            onClick={async () => {
              await api.livetvSetWorld(!data?.worldEnabled);
              await liveTv.load(true);
            }}
            className={`focus-lift btn shrink-0 ${data?.worldEnabled ? "btn-primary" : "btn-ghost"}`}
          >
            {data?.worldEnabled ? "Activado" : "Desactivado"}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-4 rounded-xl bg-white/5 px-5 py-4">
          <span className="min-w-0 flex-1">
            <span className="block text-[1.1rem] font-semibold">Pluto TV</span>
            <span className={`block text-[0.95rem] ${data?.fastError ? "text-danger" : "text-ink-3"}`}>
              {data?.fastError ?? "Canales gratis con anuncios: dibujos, anime, MTV, cine y series, con guía. Del 3001 en adelante."}
            </span>
          </span>
          <button
            data-nav
            aria-pressed={data?.fastEnabled}
            onClick={async () => {
              await api.livetvSetFast(!data?.fastEnabled);
              await liveTv.load(true);
            }}
            className={`focus-lift btn shrink-0 ${data?.fastEnabled ? "btn-primary" : "btn-ghost"}`}
          >
            {data?.fastEnabled ? "Activado" : "Desactivado"}
          </button>
        </div>
        <div className="mt-2 flex items-center gap-4 rounded-xl bg-white/5 px-5 py-4">
          <span className="min-w-0 flex-1">
            <span className="block text-[1.1rem] font-semibold">Twitch en directo</span>
            <span className={`block text-[0.95rem] ${data?.twitchError ? "text-danger" : "text-ink-3"}`}>
              {data?.twitchError ?? "Directos en español aptos para todos. Del 4001 en adelante."}
            </span>
          </span>
          <button
            data-nav
            aria-pressed={data?.twitchEnabled}
            onClick={async () => {
              await api.livetvSetTwitch(!data?.twitchEnabled);
              await liveTv.load(true);
            }}
            className={`focus-lift btn shrink-0 ${data?.twitchEnabled ? "btn-primary" : "btn-ghost"}`}
          >
            {data?.twitchEnabled ? "Activado" : "Desactivado"}
          </button>
        </div>
        {data?.playlists.map((p) => (
          <div key={p.id} className="mt-2 flex items-center gap-4 rounded-xl bg-white/5 py-2 pl-5 pr-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[1.1rem] font-medium">{p.name}</span>
              <span className={`block truncate text-[0.9rem] ${p.error ? "text-danger" : "text-ink-3"}`}>{p.error ?? `${p.channels} canales`}</span>
            </span>
            <button
              data-nav
              aria-label={`Quitar ${p.name}`}
              onClick={async () => {
                await api.livetvRemovePlaylist(p.id);
                await liveTv.load(true);
              }}
              className="focus-ring grid size-11 place-items-center rounded-lg text-ink-3 focus:bg-danger/20 focus:text-danger"
            >
              <Trash2 className="size-5" />
            </button>
          </div>
        ))}
        <form onSubmit={add} className="mt-3 grid grid-cols-[1fr_1.6fr_auto] gap-3">
          <input data-nav className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Mi lista IPTV" maxLength={40} />
          <input data-nav className="field" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} inputMode="url" />
          <button type="submit" data-nav disabled={busy} className="focus-lift btn btn-ghost">
            {busy ? <LoaderCircle className="size-5 spin" /> : <ListPlus className="size-5" />} Añadir M3U
          </button>
        </form>
        {error && <p className="mt-2 text-[1rem] text-danger">{error}</p>}

        <div className="mt-8 flex justify-between gap-3 border-t border-white/10 pt-6">
          <button data-nav onClick={onPowerOff} className="focus-lift btn btn-danger">
            <Power className="size-5" /> Apagar la TV
          </button>
          <button data-nav onClick={onClose} className="focus-lift btn btn-primary">
            <Tv className="size-5" /> Volver a la TV
          </button>
        </div>
      </div>
    </Panel>
  );
}
