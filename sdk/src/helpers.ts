/**
 * Small helpers for what most plugins end up writing: a device id, requests
 * in batches, retries, NOVA's themes from a service's categories, and times.
 */
import { log, storage } from "./host";
import type { Category } from "./types";

// ───────────────────────── Ids ─────────────────────────

/** A random UUID (v4). */
export function uuid(): string {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => (c === "x" ? hex() : ((Math.random() * 4) | 8).toString(16)));
}

export const device = {
  /**
   * An anonymous id for this NOVA, the same every time (saved in the plugin's
   * storage; a new one if the plugin is reinstalled without its data). For
   * services that ask for a device or client id.
   */
  id(): string {
    let id = storage.get<string>("nova.deviceId");
    if (!id) {
      id = uuid();
      storage.set("nova.deviceId", id);
    }
    return id;
  },
};

// ───────────────────────── Batches and retries ─────────────────────────

/** [1,2,3,4,5] in 2 → [[1,2],[3,4],[5]]. */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)));
  return out;
}

/**
 * Runs `fn` on `items` in batches of `size`, one after another. A batch that
 * fails is logged and skipped, so one bad batch doesn't lose the rest.
 * Returns the results of the batches that worked, in order.
 *
 * ```ts
 * const guides = await batch(ids, 60, (lote) => api.json(`/timelines`, { query: { ids: lote.join(",") } }), { label: "guía" });
 * ```
 */
export async function batch<T, R>(items: T[], size: number, fn: (chunk: T[], index: number) => Promise<R>, options: { label?: string } = {}): Promise<R[]> {
  const chunks = chunk(items, size);
  const results: R[] = [];
  for (let i = 0; i < chunks.length; i++) {
    try {
      results.push(await fn(chunks[i], i));
    } catch (e) {
      log.warn(`${options.label ?? "tanda"} ${i + 1}/${chunks.length} falló (${chunks[i].length} elementos): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return results;
}

/**
 * Tries `fn` again when it fails, up to `times` attempts in all. Retries right
 * away (plugins have no timers). `when` decides which errors are worth another
 * try (default: all).
 *
 * ```ts
 * await retry(() => api.json("/canales"), { times: 3, when: (e) => e instanceof HttpError && e.status >= 500 });
 * ```
 */
export async function retry<T>(fn: (attempt: number) => Promise<T>, options: { times?: number; when?: (error: unknown) => boolean } = {}): Promise<T> {
  const times = Math.max(1, options.times ?? 3);
  let last: unknown;
  for (let attempt = 1; attempt <= times; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      last = e;
      if (attempt === times || (options.when && !options.when(e))) break;
      log.warn(`intento ${attempt}/${times} falló, otra vez: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw last;
}

// ───────────────────────── Categories ─────────────────────────

/** Words (Spanish and English) that point to each of NOVA's themes, checked in this order. */
const THEMES: [Category, string[]][] = [
  ["Infantil", ["infantil", "kids", "niños", "children", "dibujos", "cartoon", "familia", "family", "junior"]],
  ["Noticias", ["noticia", "news", "informativ", "actualidad"]],
  ["Deportes", ["deporte", "sport", "fútbol", "futbol", "football", "soccer", "nba", "motor"]],
  ["Música", ["música", "musica", "music", "radio", "videoclip", "concierto"]],
  ["Documentales", ["document", "cultura", "natural", "nature", "history", "historia", "science", "ciencia", "viajes", "travel"]],
  ["Cine", ["cine", "pelí", "peli", "movie", "film", "terror", "horror", "western", "sci-fi", "ciencia ficción", "acción"]],
  ["Series", ["series", "serie", "polic", "crimen", "crime", "drama", "classic tv", "sitcom", "comedia", "comedy"]],
  ["Religión", ["religi", "faith", "iglesia", "church"]],
  ["Estilo de vida", ["cocina", "food", "home", "hogar", "estilo de vida", "lifestyle", "moda", "fashion"]],
];

export const categories = {
  /** Every theme NOVA has. */
  all: ["Noticias", "Deportes", "Infantil", "Cine", "Series", "Música", "Documentales", "Entretenimiento", "Estilo de vida", "Religión", "Otros"] as Category[],
  /**
   * NOVA's theme for a service's category ("Películas de terror" → "Cine",
   * "Kids" → "Infantil"…). Anything else is "Entretenimiento".
   * `anime` says what anime is (it's "Entretenimiento" unless you say "Infantil").
   */
  guess(text: string, options: { anime?: Category } = {}): Category {
    const t = text.toLowerCase();
    if (t.includes("anime")) return options.anime ?? "Entretenimiento";
    for (const [theme, words] of THEMES) if (words.some((w) => t.includes(w))) return theme;
    return "Entretenimiento";
  },
  /** Seasonal or promotional categories ("Nuevo", "Halloween", "Trending"…): not a channel's real home. */
  isPromo(text: string): boolean {
    const t = text.toLowerCase();
    return ["nuevo", "new", "novedad", "halloween", "navidad", "christmas", "holiday", "destacado", "featured", "trending", "popular", "verano", "summer"].some((w) => t.includes(w));
  },
};

// ───────────────────────── Times ─────────────────────────

/** Times in Unix seconds, the way NOVA's guide wants them. */
export const time = {
  /** Now. */
  now: (): number => Math.floor(Date.now() / 1000),
  /** The start of the hour of `at` (default now). */
  hourStart: (at: number = Math.floor(Date.now() / 1000)): number => at - (at % 3600),
  /** "2026-10-18T16:00:00.000Z" → seconds (NaN if it isn't a date). */
  fromIso: (iso: string): number => Math.floor(Date.parse(iso) / 1000),
  /** Seconds → "2026-10-18T16:00:00.000Z". */
  toIso: (at: number): string => new Date(at * 1000).toISOString(),
  minutes: (n: number): number => n * 60,
  hours: (n: number): number => n * 3600,
  days: (n: number): number => n * 86400,
};
