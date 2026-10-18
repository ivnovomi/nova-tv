/**
 * @novatv/sdk: build plugins for NOVA TV.
 *
 * ```ts
 * import { defineProvider, http } from "@novatv/sdk";
 *
 * export default defineProvider({
 *   rows: {
 *     refresh: "30m",
 *     async load() {
 *       const news = await http.json<News[]>("https://api.ejemplo.es/noticias");
 *       return [{ title: "Últimas noticias", items: news.map(toItem) }];
 *     },
 *   },
 * });
 * ```
 */
import type { Duration, ProviderDefinition } from "./types";

export * from "./types";
export type { Manifest, Permissions, Setting } from "./manifest";
export { http, HttpError, storage, settings, location, log, notify } from "./host";
export type { NovaHost } from "./host";

/** API version this SDK speaks. Goes in the manifest as `"api": 1`. */
export const API_VERSION = 1;

declare global {
  // eslint-disable-next-line no-var
  var __novaPlugin: ProviderDefinition | undefined;
}

const PARTS = ["channels", "guide", "rows", "search", "screensaver"] as const;

/**
 * Declares what the plugin provides. Checks the shape right away, so mistakes
 * show up in `nova dev` and not on someone's TV.
 */
export function defineProvider<T extends ProviderDefinition>(definition: T): T {
  const unknown = Object.keys(definition).filter((k) => !(PARTS as readonly string[]).includes(k));
  if (unknown.length) throw new Error(`defineProvider: no existe ${unknown.map((k) => `"${k}"`).join(", ")}. Puede ser: ${PARTS.join(", ")}.`);
  if (!PARTS.some((p) => definition[p])) throw new Error("defineProvider: el plugin no aporta nada (channels, guide, rows, search o screensaver).");

  const need = (part: string, fn: string) => {
    const value = (definition as unknown as Record<string, Record<string, unknown> | undefined>)[part];
    if (value && typeof value[fn] !== "function") throw new Error(`defineProvider: falta ${part}.${fn}().`);
  };
  need("channels", "load");
  need("guide", "load");
  need("rows", "load");
  need("search", "search");
  need("screensaver", "load");

  for (const part of PARTS) {
    const refresh = (definition[part] as { refresh?: string } | undefined)?.refresh;
    if (refresh !== undefined && parseDuration(refresh) === null) throw new Error(`defineProvider: ${part}.refresh "${refresh}" no es válido (usa "30m", "6h", "1d"…).`);
  }

  // The host picks the plugin up from here.
  globalThis.__novaPlugin = definition;
  return definition;
}

/** "30m" → 1800 seconds; null if it isn't a duration. */
export function parseDuration(value: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(m|h|d)$/.exec(value);
  if (!m) return null;
  return Math.round(Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as "m" | "h" | "d"]);
}

/**
 * Remembers a function's result for a while (per argument list), in memory.
 * Handy for sessions and lists that many calls share.
 *
 * ```ts
 * const session = memo("8h", () => http.json<Session>(BOOT_URL));
 * ```
 */
export function memo<A extends unknown[], R>(ttl: Duration, fn: (...args: A) => Promise<R>): ((...args: A) => Promise<R>) & { clear(): void } {
  const seconds = parseDuration(ttl);
  if (seconds === null) throw new Error(`memo: "${ttl}" no es una duración.`);
  const cache = new Map<string, { at: number; value: Promise<R> }>();
  const wrapped = (...args: A) => {
    const key = JSON.stringify(args);
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < seconds * 1000) return hit.value;
    const value = fn(...args);
    cache.set(key, { at: Date.now(), value });
    // A failure isn't remembered: the next call tries again.
    value.catch(() => cache.delete(key));
    return value;
  };
  return Object.assign(wrapped, { clear: () => cache.clear() });
}
