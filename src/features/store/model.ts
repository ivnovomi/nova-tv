import { useEffect, useSyncExternalStore } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Clapperboard,
  Gamepad2,
  Image as ImageIcon,
  KeyRound,
  LayoutGrid,
  LayoutList,
  ListVideo,
  Music,
  Newspaper,
  Radio,
  Search,
  Sparkles,
  Trophy,
  Tv,
  Wrench,
  Baby,
  type LucideIcon,
} from "lucide-react";
import { api, inTauri } from "../../lib/api";
import type { PluginPermissions, StoreEntry, StoreInfo, StoreProgress } from "../../lib/types";
import { PREVIEW } from "./preview";

// ───────────────────────── Categories ─────────────────────────

export const CATEGORIES: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "all", label: "Todo", icon: Sparkles },
  { id: "tv", label: "TV en directo", icon: Tv },
  { id: "sports", label: "Deportes", icon: Trophy },
  { id: "kids", label: "Infantil", icon: Baby },
  { id: "movies", label: "Cine y series", icon: Clapperboard },
  { id: "music", label: "Música y radio", icon: Music },
  { id: "news", label: "Noticias", icon: Newspaper },
  { id: "games", label: "Juegos", icon: Gamepad2 },
  { id: "tools", label: "Utilidades", icon: Wrench },
];

export const categoryLabel = (id: string) => CATEGORIES.find((c) => c.id === id)?.label ?? "Plugins";
export const categoryIcon = (id: string) => CATEGORIES.find((c) => c.id === id)?.icon ?? LayoutGrid;

/** What a plugin adds to NOVA, from its permissions. */
export function features(p: PluginPermissions): { icon: LucideIcon; title: string; text: string }[] {
  const out: { icon: LucideIcon; title: string; text: string }[] = [];
  if (p.channels) out.push({ icon: Tv, title: "Canales en directo", text: "Aparecen en la TV con su número, junto a la TDT." });
  if (p.guide) out.push({ icon: ListVideo, title: "Guía de programación", text: "Qué echan ahora y después, en la guía de NOVA." });
  if (p.rows) out.push({ icon: LayoutList, title: "Filas en «Para ti»", text: "Su contenido en tu pantalla de inicio." });
  if (p.search) out.push({ icon: Search, title: "Resultados en la búsqueda", text: "Lo encuentras desde el buscador de NOVA." });
  if (p.screensaver) out.push({ icon: ImageIcon, title: "Fondos de salvapantallas", text: "Imágenes cuando la tele descansa." });
  if (p.notify) out.push({ icon: Radio, title: "Avisos", text: "Te avisa de lo importante, como mucho 3 por minuto." });
  if (p.account) out.push({ icon: KeyRound, title: "Tu cuenta", text: "Inicias sesión con un código, desde el móvil." });
  return out;
}

// ───────────────────────── Formats ─────────────────────────

export function formatSize(bytes: number) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} MB`;
}

export function formatDay(secs: number) {
  if (!secs) return "—";
  return new Date(secs * 1000).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
}

const LANGUAGES: Record<string, string> = { es: "Español", en: "Inglés", ca: "Catalán", eu: "Euskera", gl: "Gallego", pt: "Portugués", fr: "Francés" };
export const languageName = (code: string) => LANGUAGES[code] ?? code.toUpperCase();

/** "#6e6cff" → "110 108 255" (for rgb(var / alpha)). */
export function rgb(hex: string | null | undefined, fallback = "110 108 255") {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return fallback;
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Compares "1.2.10" and "1.10.0" as versions. */
export function newer(a: string, b: string) {
  const parse = (v: string) => v.split("-")[0].split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
}

// ───────────────────────── The catalogue ─────────────────────────

export interface StoreData extends StoreInfo {
  /** The catalogue shown is the built-in example (development only). */
  preview: boolean;
}

let data: StoreData | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

async function load(refresh: boolean) {
  let info: StoreInfo;
  try {
    info = inTauri ? await api.storeCatalog(refresh) : { catalog: null, installed: {}, error: "Fuera de NOVA", fetchedAt: null, signed: false, developerMode: true };
  } catch (e) {
    info = { catalog: null, installed: {}, error: String(e), fetchedAt: null, signed: false, developerMode: false };
  }
  // In development the store can be designed before the official catalogue exists.
  const preview = !info.catalog && import.meta.env.DEV;
  data = { ...info, catalog: info.catalog ?? (preview ? PREVIEW : null), preview, installed: preview ? { ...previewInstalled, ...info.installed } : info.installed };
  emit();
}

export const store = {
  /** Loads once (and again with `refresh`). */
  load(refresh = false) {
    if (refresh || !loading) loading = load(refresh).finally(() => (loading = refresh ? null : loading));
    return loading;
  },
  find(id: string): StoreEntry | undefined {
    return data?.catalog?.plugins.find((p) => p.id === id);
  },
};

/** The store's data, loaded on first use; it refreshes when plugins change. */
export function useStore(): StoreData | null {
  const snapshot = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => data,
  );
  useEffect(() => {
    void store.load();
    if (!inTauri) return;
    const off = listen("plugins-changed", () => void load(false));
    return () => void off.then((f) => f());
  }, []);
  return snapshot;
}

// ───────────────────────── Installing ─────────────────────────

export type Phase = "idle" | "download" | "verify" | "install" | "done" | "error";
export interface InstallState {
  phase: Phase;
  /** 0–1 while downloading. */
  progress: number;
  error?: string;
}

const installs = new Map<string, InstallState>();
const installListeners = new Set<() => void>();
const IDLE: InstallState = { phase: "idle", progress: 0 };
const setInstall = (id: string, s: InstallState) => {
  installs.set(id, s);
  installListeners.forEach((l) => l());
};

let progressHooked = false;
function hookProgress() {
  if (progressHooked || !inTauri) return;
  progressHooked = true;
  void listen<StoreProgress>("store-progress", ({ payload: p }) => {
    const progress = p.phase === "download" ? Math.min(1, p.done / Math.max(1, p.total)) : 1;
    if (p.phase !== "done") setInstall(p.id, { phase: p.phase, progress });
  });
}

// Preview only: what's "installed" in the example catalogue.
const previewInstalled: Record<string, string> = {};

/** Installs (or updates) from the store; resolves when it's done (or failed). */
export async function install(entry: StoreEntry): Promise<boolean> {
  hookProgress();
  setInstall(entry.id, { phase: "download", progress: 0 });
  try {
    if (inTauri && !data?.preview) {
      await api.storeInstall(entry.id);
    } else {
      // Preview: the same steps, pretended.
      for (let i = 1; i <= 25; i++) {
        await new Promise((r) => setTimeout(r, 70));
        setInstall(entry.id, { phase: "download", progress: i / 25 });
      }
      setInstall(entry.id, { phase: "verify", progress: 1 });
      await new Promise((r) => setTimeout(r, 900));
      setInstall(entry.id, { phase: "install", progress: 1 });
      await new Promise((r) => setTimeout(r, 700));
      previewInstalled[entry.id] = entry.version;
      if (data) data = { ...data, installed: { ...data.installed, [entry.id]: entry.version } };
      emit();
    }
    setInstall(entry.id, { phase: "done", progress: 1 });
    void load(false);
    return true;
  } catch (e) {
    setInstall(entry.id, { phase: "error", progress: 0, error: e instanceof Error ? e.message : String(e) });
    return false;
  }
}

export function useInstall(id: string): InstallState {
  return useSyncExternalStore(
    (l) => {
      installListeners.add(l);
      return () => installListeners.delete(l);
    },
    () => installs.get(id) ?? IDLE,
  );
}

export function resetInstall(id: string) {
  setInstall(id, IDLE);
}
