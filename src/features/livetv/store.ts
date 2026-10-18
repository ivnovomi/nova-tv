import { useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, inTauri } from "../../lib/api";
import type { Channel, HealthEntry, HealthProgress, LiveTvData, Program } from "../../lib/types";
import { activeProfile } from "../../app/profiles";

/**
 * Shared live-TV state: channels, guide, signal health, favourites and the TV
 * mode itself (on/off and what's tuned).
 */
interface State {
  data: LiveTvData | null;
  epg: Record<string, Program[]>;
  health: Record<string, HealthEntry>;
  progress: HealthProgress | null;
  loading: boolean;
  error: string | null;
  /** TV mode is on (full-screen, a world apart). */
  open: boolean;
  /** Channel tuned in TV mode. */
  playing: string | null;
  /** Hide channels without signal / blocked (per device). */
  hideUnavailable: boolean;
  /** TV shrunk to a corner (picture-in-picture) while you browse NOVA. */
  pip: boolean;
  /** The start-up splash is up: the TV tunes in silence behind it. */
  hold: boolean;
  /** Last tuning result from the player (did the picture come in?). */
  signal: { id: string; ok: boolean } | null;
  /** Subtitles on (one track only, Spanish first). Off by default. */
  subtitles: boolean;
  /** A panel asked for from the phone, shown once the TV has turned on. */
  panel: "guide" | "info" | "menu" | null;
}

// ── Recently watched channels (per profile), for the guide's "Para ti" ──
const recentKey = () => `nova.tv.recent.${activeProfile()?.id ?? "principal"}`;

export function recentChannels(): string[] {
  try {
    return JSON.parse(localStorage.getItem(recentKey()) ?? "[]") as string[];
  } catch {
    return [];
  }
}

function rememberRecent(id: string) {
  try {
    localStorage.setItem(recentKey(), JSON.stringify([id, ...recentChannels().filter((r) => r !== id)].slice(0, 24)));
  } catch {}
}

const SUBS_KEY = "nova.tv.subtitles";
const readSubs = () => {
  try {
    return localStorage.getItem(SUBS_KEY) === "on";
  } catch {
    return false;
  }
};

const HIDE_KEY = "nova.tv.hideUnavailable";
const readHide = () => {
  try {
    return localStorage.getItem(HIDE_KEY) !== "off";
  } catch {
    return true;
  }
};

let state: State = {
  data: null,
  epg: {},
  health: {},
  progress: null,
  loading: false,
  error: null,
  open: false,
  playing: null,
  hideUnavailable: readHide(),
  pip: false,
  hold: false,
  signal: null,
  subtitles: readSubs(),
  panel: null,
};
const listeners = new Set<() => void>();
let epgTimer: number | undefined;
let healthListening = false;
/** A forced reload asked for while another load was running (e.g. a profile switch). */
let reloadPending = false;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function useLiveTv(): State {
  return useSyncExternalStore(subscribe, () => state);
}

async function loadEpg() {
  try {
    set({ epg: await api.livetvEpg() });
  } catch {
    // The guide is optional: channels still play without it.
  }
}

async function loadHealth() {
  try {
    const h = await api.livetvHealth();
    set({ health: h.map, progress: h.progress });
  } catch {}
  if (healthListening || !inTauri) return;
  healthListening = true;
  // Live updates while NOVA checks channels in the background.
  void listen<{ progress: HealthProgress; updates: [string, HealthEntry][] }>("livetv-health", ({ payload }) => {
    const health = { ...state.health };
    for (const [id, entry] of payload.updates) health[id] = entry;
    set({ health, progress: payload.progress });
  });
}

/** Channels you can actually watch (unless the user wants to see everything). */
export function isAvailable(c: Channel, health: Record<string, HealthEntry>, hide: boolean) {
  if (!hide) return true;
  const s = health[c.id]?.status;
  return s !== "dead" && s !== "blocked";
}

/** Channels zapping goes through, in number order (the tuned one is always kept). */
export function zappable(): Channel[] {
  const all = [...(state.data?.channels ?? [])].sort((a, b) => a.number - b.number);
  return all.filter((c) => c.id === state.playing || isAvailable(c, state.health, state.hideUnavailable));
}

function firstChannel(): string | null {
  const d = state.data;
  if (!d) return null;
  const ok = (c: Channel) => isAvailable(c, state.health, true);
  const last = d.channels.find((c) => c.id === d.lastChannel);
  if (last && ok(last)) return last.id;
  const fav = d.channels.find((c) => d.favorites.includes(c.id) && ok(c));
  if (fav) return fav.id;
  const sorted = [...d.channels].sort((a, b) => a.number - b.number);
  return (sorted.find((c) => state.health[c.id]?.status === "ok") ?? sorted.find(ok) ?? sorted[0])?.id ?? null;
}

export const liveTv = {
  loaded: () => !!state.data,
  /** Loads channels once (plus guide every 30 min and signal health). */
  async load(force = false) {
    if (!inTauri || (state.data && !force)) return;
    if (state.loading) {
      // The running load may be for the old list: run again when it ends.
      if (force) reloadPending = true;
      return;
    }
    set({ loading: true, error: null });
    try {
      const data = await api.livetvChannels();
      set({ data, loading: false });
      // Another profile: what was on may not be in its list (e.g. a children's profile).
      if (state.playing && !data.channels.some((c) => c.id === state.playing)) set({ playing: state.open ? firstChannel() : null });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
    void loadHealth();
    void loadEpg();
    window.clearInterval(epgTimer);
    epgTimer = window.setInterval(loadEpg, 30 * 60 * 1000);
    if (state.open && !state.playing) set({ playing: firstChannel() });
    if (reloadPending) {
      reloadPending = false;
      await liveTv.load(true);
    }
  },
  /** Turn the TV on: last channel, a favourite, or the first with signal. */
  async open() {
    set({ open: true, pip: false, playing: state.playing ?? firstChannel() });
    await liveTv.load();
    if (!state.playing) set({ playing: firstChannel() });
  },
  play(id: string) {
    rememberRecent(id);
    set({ open: true, pip: false, playing: id });
    if (state.data) set({ data: { ...state.data, lastChannel: id } });
    void api.livetvSetLast(id).catch(() => {});
  },
  close() {
    set({ open: false, pip: false, playing: null, panel: null });
  },
  isOpen: () => state.open,
  /** Turns the TV on (if needed) and opens one of its panels as soon as it's ready. */
  showPanel(panel: NonNullable<State["panel"]>) {
    set({ panel });
    void liveTv.open();
  },
  panelShown() {
    if (state.panel) set({ panel: null });
  },
  /** Channel up/down through what you can actually watch (works from the phone remote too). */
  zap(delta: number) {
    const list = zappable();
    if (!list.length) return;
    const i = list.findIndex((c) => c.id === state.playing);
    liveTv.play(list[(i + delta + list.length) % list.length].id);
  },
  /** Tune by channel number; returns false when there's no such channel. */
  tuneNumber(n: number) {
    const target = state.data?.channels.find((c) => c.number === n);
    if (target) liveTv.play(target.id);
    return !!target;
  },
  /** Keep watching in a corner while browsing NOVA. */
  minimize() {
    if (state.open) set({ pip: true });
  },
  expand() {
    if (state.open) set({ pip: false });
  },
  async toggleFavorite(id: string) {
    if (!state.data) return;
    const fav = !state.data.favorites.includes(id);
    const favorites = fav ? [...state.data.favorites, id] : state.data.favorites.filter((f) => f !== id);
    set({ data: { ...state.data, favorites } });
    await api.livetvSetFavorite(id, fav);
    return fav;
  },
  setHideUnavailable(hide: boolean) {
    try {
      localStorage.setItem(HIDE_KEY, hide ? "on" : "off");
    } catch {}
    set({ hideUnavailable: hide });
  },
  /** What the player saw: recorded immediately so the list stays honest. */
  report(id: string, ok: boolean, blocked: boolean, stream: number) {
    const entry: HealthEntry = { status: ok ? "ok" : blocked ? "blocked" : "dead", checkedAt: Date.now() / 1000, stream };
    set({ health: { ...state.health, [id]: entry }, signal: { id, ok } });
    void api.livetvReport(id, ok, blocked, stream).catch(() => {});
  },
  setSubtitles(on: boolean) {
    try {
      localStorage.setItem(SUBS_KEY, on ? "on" : "off");
    } catch {}
    set({ subtitles: on });
  },
  setHold(hold: boolean) {
    set({ hold });
  },
  async checkNow() {
    await api.livetvCheckNow();
    void loadHealth();
  },
};

/** Streams in the order to try: the one that last worked first. */
export function orderedStreams(c: Channel, health: Record<string, HealthEntry>): string[] {
  const i = health[c.id]?.stream ?? 0;
  return i > 0 && i < c.streams.length ? [c.streams[i], ...c.streams.filter((_, j) => j !== i)] : c.streams;
}

/** What's on now and next on a channel. */
export function onAir(epg: Record<string, Program[]>, channel: Channel | undefined, now = Date.now() / 1000) {
  const list = channel?.epgId ? epg[channel.epgId] ?? [] : [];
  const index = list.findIndex((p) => p.start <= now && p.end > now);
  const current = index >= 0 ? list[index] : undefined;
  const next = index >= 0 ? list[index + 1] : list.find((p) => p.start > now);
  const progress = current ? Math.min(1, (now - current.start) / (current.end - current.start)) : null;
  return { current, next, progress, list };
}

export function hhmm(unix: number) {
  return new Date(unix * 1000).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
}

/** Display order of Spain's main TDT categories. */
export const GROUP_ORDER = ["Generalistas", "Informativos", "Deportivos", "Infantiles", "Eventuales", "Streaming"];

const regionNames = new Intl.DisplayNames(["es"], { type: "region" });

/** iptv-org uses "UK"; everything else is ISO 3166. */
function iso(code: string) {
  return code.toUpperCase() === "UK" ? "GB" : code.toUpperCase();
}

export function countryName(code: string | null | undefined): string {
  if (!code || code === "INT") return "Internacional";
  try {
    return regionNames.of(iso(code)) ?? code;
  } catch {
    return code;
  }
}

export function flag(code: string | null | undefined): string {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return "🌐";
  return String.fromCodePoint(...[...iso(code)].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** "Generalistas", "🇲🇽 México · Noticias", or the playlist group. */
export function groupLabel(c: Channel): string {
  if (c.source === "world") return `${countryName(c.country)}${c.categories[0] ? ` · ${c.categories[0]}` : ""}`;
  if (c.source === "fast") return `Pluto TV · ${c.group}`;
  if (c.source === "twitch") return `Twitch · ${c.group}`;
  if (c.source === "plugin") return c.group === c.region ? c.region : `${c.region} · ${c.group}`;
  return c.group;
}

const THEMES = [
  "Noticias", "Deportes", "Cine", "Series", "Infantil", "Documentales", "Música", "Entretenimiento", "Clásicos",
  "Cultura y educación", "Estilo de vida", "Economía y tiempo", "Institucional", "Religión", "Compras", "General",
];

export interface Group {
  key: string;
  label: string;
  section: string;
  channels: Channel[];
}

/** Channel-list categories: favourites, Spain's TDT, world themes, countries, TDT international, playlists. */
export function buildGroups(channels: Channel[], favorites: string[]): Group[] {
  const out: Group[] = [];
  const push = (key: string, label: string, section: string, list: Channel[]) => {
    if (list.length) out.push({ key, label, section, channels: list });
  };
  push("fav", "★ Favoritos", "Favoritos", channels.filter((c) => favorites.includes(c.id)));

  const tdtSpain = channels.filter((c) => c.source === "tdt" && c.region === "España");
  const spainGroups = [...new Set(tdtSpain.map((c) => c.group))];
  [...GROUP_ORDER.filter((g) => spainGroups.includes(g)), ...spainGroups.filter((g) => !GROUP_ORDER.includes(g)).sort((a, b) => a.localeCompare(b, "es"))].forEach((g) =>
    push(`tdt:${g}`, g, "España · TDT", tdtSpain.filter((c) => c.group === g)),
  );

  // Pluto TV: free channels with ads, in Pluto's own categories.
  const fast = channels.filter((c) => c.source === "fast");
  [...new Set(fast.map((c) => c.group))].forEach((g) => push(`fast:${g}`, g, "Pluto TV · gratis", fast.filter((c) => c.group === g)));

  // Twitch: what's live right now, for everyone.
  push("twitch", "En directo ahora", "Twitch", channels.filter((c) => c.source === "twitch"));

  const world = channels.filter((c) => c.source === "world");
  const themed = [...fast, ...world];
  THEMES.forEach((t) => push(`cat:${t}`, t, "Temáticas", themed.filter((c) => c.categories.includes(t))));

  const byCountry = new Map<string, Channel[]>();
  world.forEach((c) => byCountry.set(c.country ?? "INT", [...(byCountry.get(c.country ?? "INT") ?? []), c]));
  [...byCountry.entries()]
    .sort((a, b) => (a[0] === "ES" ? -1 : b[0] === "ES" ? 1 : b[1].length - a[1].length))
    .forEach(([code, list]) => push(`country:${code}`, `${flag(code)} ${countryName(code)}`, "Países", list));

  const tdtWorld = channels.filter((c) => c.source === "tdt" && c.region !== "España");
  [...new Set(tdtWorld.map((c) => c.group))].forEach((g) => push(`tdti:${g}`, g, "TDT internacional", tdtWorld.filter((c) => c.group === g)));

  const playlists = channels.filter((c) => c.source === "playlist");
  [...new Set(playlists.map((c) => `${c.region}\u0000${c.group}`))].forEach((k) => {
    const [region, group] = k.split("\u0000");
    push(`pl:${k}`, group, `Mis listas · ${region}`, playlists.filter((c) => c.region === region && c.group === group));
  });
  return out;
}
