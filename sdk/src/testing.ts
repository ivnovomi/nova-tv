/**
 * @novatv/sdk/testing: run and test a plugin in Node, without NOVA.
 *
 * A pretend NOVA that applies the same rules as the real one (HTTPS only to the
 * manifest's domains, no redirects, 5 MB, storage quota, permissions, 3
 * notices a minute) and checks what the plugin returns the way NOVA does.
 *
 * ```ts
 * import manifest from "../nova-plugin.json";
 * import plugin from "../src/index";
 * import { testPlugin } from "@novatv/sdk/testing";
 *
 * const nova = testPlugin(manifest, plugin, { offline: true, mock: { "https://api.ejemplo.es/canales": [...] } });
 * const canales = await nova.channels();
 * assert.deepEqual(nova.problems, []);
 * ```
 */
import type {
  AccountUser,
  SignInCode,
  SignInStatus,
  Channel,
  Context,
  HttpRequest,
  HttpResponse,
  Item,
  Location,
  Program,
  ProviderDefinition,
  Row,
  Stream,
} from "./types";
import type { Manifest } from "./manifest";
import type { NovaHost } from "./host";
// Node's own test runner and assertions (typed below, so no @types/node is needed).
// @ts-ignore: Node built-in
import { test as nodeTest } from "node:test";
// @ts-ignore: Node built-in
import nodeAssert from "node:assert/strict";

/** A test, run by `npm run plugin:test` (Node's test runner). */
export const test: (name: string, fn: () => unknown) => void = nodeTest;

/** Checks for tests; each one throws if it doesn't hold. */
export const assert: {
  (value: unknown, message?: string): asserts value;
  ok(value: unknown, message?: string): asserts value;
  equal<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
  notEqual(actual: unknown, expected: unknown, message?: string): void;
  deepEqual<T>(actual: unknown, expected: T, message?: string): asserts actual is T;
  match(value: string, pattern: RegExp, message?: string): void;
  throws(fn: () => unknown, expected?: RegExp | object, message?: string): void;
  rejects(promise: Promise<unknown> | (() => Promise<unknown>), expected?: RegExp | object, message?: string): Promise<void>;
} = nodeAssert;

// Node's fetch, without needing @types/node.
declare const fetch: (url: string, init: Record<string, unknown>) => Promise<{
  status: number;
  headers: { forEach(cb: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}>;
declare class TextDecoder {
  decode(input: ArrayBuffer): string;
}
declare class AbortController {
  readonly signal: unknown;
  abort(): void;
}
declare function setTimeout(fn: () => void, ms: number): unknown;
declare function clearTimeout(id: unknown): void;
declare class URL {
  constructor(url: string);
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
}
declare const console: { log(...a: unknown[]): void; warn(...a: unknown[]): void };

const MAX_BODY = 5 * 1024 * 1024;
const QUOTA = 5 * 1024 * 1024;
const RESERVED = ["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "keep-alive"];
const CATEGORIES = ["Noticias", "Deportes", "Infantil", "Cine", "Series", "Música", "Documentales", "Entretenimiento", "Estilo de vida", "Religión", "Otros"];

/** A fake answer for a URL. Return undefined to let the request through. */
export type MockFetch = (request: HttpRequest) => Partial<HttpResponse> | string | object | undefined | Promise<Partial<HttpResponse> | string | object | undefined>;

export interface TestOptions {
  /** The user's values for the manifest's `settings` (the rest take their default). */
  settings?: Record<string, unknown>;
  /** The city chosen in Ajustes → Privacidad (undefined: none). */
  location?: Omit<Location, "source"> & { source?: Location["source"] };
  /** `ctx.country` (default: the location's `countryCode`). */
  country?: string;
  /** Who is watching. Default: an adult profile "perfil-1". */
  profile?: { id?: string; kids?: boolean };
  locale?: string;
  /**
   * Fake answers by URL (exact, or a prefix ending in "*"), or a function.
   * Strings are the body; objects are sent as JSON. Unmatched requests go to
   * the real network unless `offline` is true.
   */
  mock?: Record<string, Partial<HttpResponse> | string | object> | MockFetch;
  /** Fail any request without a mock (for tests that must not touch the network). */
  offline?: boolean;
  /** Print the plugin's log lines (default: true). */
  print?: boolean;
}

export interface LogLine {
  level: "info" | "warn" | "error";
  message: string;
}

/** What NOVA would do with each part, plus what happened on the way. */
export interface TestNova {
  /** Every request the plugin made (after the permission check). */
  readonly requests: HttpRequest[];
  readonly logs: LogLine[];
  readonly notices: { title: string; detail?: string }[];
  /** Saved values: "plugin" and one map per profile id. */
  readonly storage: Map<string, Map<string, string>>;
  /** Account sessions (`secrets`), one map per profile id. */
  readonly secrets: Map<string, Map<string, string>>;
  /** Things NOVA would drop or complain about in the last answers. */
  readonly problems: string[];
  /** Change who is watching for the next calls. */
  setProfile(profile: { id?: string; kids?: boolean }): void;
  /** Change a setting for the next calls. */
  setSetting(key: string, value: unknown): void;

  channels(): Promise<Channel[]>;
  stream(id: string, options?: { retry?: boolean }): Promise<Stream>;
  /** What NOVA's proxy would fetch for this playlist: the plugin's `channels.sign()` (or the address as is). */
  sign(url: string, options?: { retry?: boolean }): Promise<{ url: string; headers?: Record<string, string> }>;
  check(id: string): Promise<boolean>;
  guide(ids?: string[], range?: { from: number; to: number }): Promise<Record<string, Program[]>>;
  rows(): Promise<Row[]>;
  search(query: string): Promise<Item[]>;
  screensaver(): Promise<string[]>;

  /** Signing in, as NOVA does it: the code, the polls, who is signed in, signing out. */
  account: {
    start(): Promise<SignInCode>;
    poll(): Promise<SignInStatus>;
    status(): Promise<AccountUser | null | undefined>;
    /** Also deletes the profile's secrets, as NOVA does. */
    signOut(): Promise<void>;
  };

  /**
   * Moves the clock forward (Date.now() for the whole test file), to test
   * what expires: sign-in codes, tokens, `memo`… without waiting.
   */
  advance(seconds: number): void;
}

// ───────────────────────── rules shared with NOVA ─────────────────────────

/** Whether a plugin with this manifest may call `host` (same rule as NOVA). */
export function allowsHost(manifest: Manifest, host: string): boolean {
  const h = host.toLowerCase();
  return (manifest.permissions.network ?? []).some((d) => {
    if (!d.startsWith("*.")) return h === d;
    const parent = d.slice(2);
    return h.length > parent.length + 1 && h.endsWith("." + parent);
  });
}

function checkUrl(manifest: Manifest, raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Dirección no válida: ${raw}`);
  }
  if (url.protocol !== "https:") throw new Error(`Solo se permite HTTPS: ${raw}`);
  if (url.username || url.password || (url.port && url.port !== "443")) throw new Error(`Dirección no permitida: ${raw}`);
  if (!allowsHost(manifest, url.hostname)) throw new Error(`El plugin no tiene permiso para conectarse a ${url.hostname} (añádelo a permissions.network)`);
  return url;
}

const isHttps = (v: unknown): v is string => typeof v === "string" && v.startsWith("https://") && !/\s/.test(v);
const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const plainId = (s: unknown, max: number) => typeof s === "string" && s.length > 0 && s.length <= max && /^[A-Za-z0-9_-]+$/.test(s);

function streamProblem(s: unknown): string | undefined {
  const v = s as Record<string, unknown> | undefined;
  switch (v?.type) {
    case "hls":
      return isHttps(v.url) ? undefined : `la emisión HLS necesita una dirección https:// (${String(v.url)})`;
    case "twitch":
      return plainId(v.channel, 25) ? undefined : `canal de Twitch no válido (${String(v.channel)})`;
    case "youtube":
      return plainId(v.video, 20) || plainId(v.channel, 40) ? undefined : "YouTube necesita «video» o «channel» válidos";
    default:
      return `tipo de emisión desconocido (${String(v?.type)})`;
  }
}

function itemProblems(item: Item, where: string): string[] {
  const out: string[] = [];
  if (!text(item.id)) out.push(`${where}: falta «id»`);
  if (!text(item.title)) out.push(`${where}: falta «title»`);
  if (item.image !== undefined && !isHttps(item.image)) out.push(`${where}: «image» tiene que ser https:// (NOVA no la mostrará)`);
  const a = item.action as Record<string, unknown> | undefined;
  switch (a?.type) {
    case "play": {
      const p = streamProblem(a.stream);
      if (p) out.push(`${where}: ${p}`);
      break;
    }
    case "tune":
      if (!text(a.channel)) out.push(`${where}: «tune» necesita «channel»`);
      break;
    case "detail":
      if (!text(a.text)) out.push(`${where}: «detail» necesita «text»`);
      break;
    case "app":
      break;
    default:
      out.push(`${where}: acción desconocida (${String(a?.type)}); NOVA descarta el elemento`);
  }
  return out;
}

// ───────────────────────── the clock ─────────────────────────

const realNow = Date.now;
let offset = 0;
/** Moves Date.now() forward for everything in this test file. */
function shift(ms: number) {
  offset += ms;
  Date.now = () => realNow() + offset;
}

// ───────────────────────── the pretend NOVA ─────────────────────────

/**
 * Loads the plugin against a pretend NOVA. `plugin` is its default export, or
 * `() => import("../src/index")` if its top-level code already uses the SDK
 * (then it's imported once the pretend NOVA is in place).
 */
export function testPlugin(json: object, plugin: ProviderDefinition | (() => Promise<unknown>), options: TestOptions = {}): TestNova {
  // Typed loosely so `import manifest from "../nova-plugin.json"` fits as is.
  const manifest = json as Manifest;
  if (typeof manifest.id !== "string" || typeof manifest.permissions !== "object") throw new Error("testPlugin: el primer argumento es el contenido de nova-plugin.json");
  const requests: HttpRequest[] = [];
  const logs: LogLine[] = [];
  const notices: { title: string; detail?: string }[] = [];
  const sentAt: number[] = [];
  const storage = new Map<string, Map<string, string>>();
  const secretMaps = new Map<string, Map<string, string>>();
  const problems: string[] = [];
  const userSettings: Record<string, unknown> = { ...options.settings };
  let profile = { id: "perfil-1", kids: false, ...options.profile };
  const print = options.print ?? true;

  const bucket = (scope: "plugin" | "profile") => {
    const key = scope === "plugin" ? "plugin" : `profile:${profile.id}`;
    let map = storage.get(key);
    if (!map) storage.set(key, (map = new Map()));
    return map;
  };
  /** The profile's secrets (only with the "account" permission, as in NOVA). */
  const vault = () => {
    if (!manifest.permissions.account) throw new Error("El plugin no tiene el permiso «account»");
    let map = secretMaps.get(profile.id);
    if (!map) secretMaps.set(profile.id, (map = new Map()));
    return map;
  };
  const used = () => [...storage.values()].reduce((n, m) => n + [...m].reduce((k, [a, b]) => k + a.length + b.length, 0), 0);

  async function mocked(req: HttpRequest): Promise<HttpResponse | undefined> {
    const { mock } = options;
    if (!mock) return undefined;
    let answer: Partial<HttpResponse> | string | object | undefined;
    if (typeof mock === "function") answer = await mock(req);
    else {
      const key = Object.keys(mock).find((k) => (k.endsWith("*") ? req.url.startsWith(k.slice(0, -1)) : k === req.url));
      answer = key === undefined ? undefined : mock[key];
    }
    if (answer === undefined) return undefined;
    if (typeof answer === "string") return { status: 200, headers: {}, body: answer };
    const r = answer as Partial<HttpResponse>;
    if ("status" in r || "body" in r) return { status: r.status ?? 200, headers: r.headers ?? {}, body: r.body ?? "" };
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(answer) };
  }

  async function http(raw: string): Promise<string> {
    const req = JSON.parse(raw) as HttpRequest;
    checkUrl(manifest, req.url);
    const method = (req.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "DELETE"].includes(method)) throw new Error(`Método HTTP no permitido: ${method}`);
    if ((req.body ?? "").length > MAX_BODY) throw new Error("El cuerpo de la petición supera 5 MB");
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!RESERVED.includes(k.toLowerCase()) && !/[\r\n]/.test(v) && !/[\r\n:]/.test(k)) headers[k] = v;
    }
    requests.push({ ...req, method: method as HttpRequest["method"], headers });

    const fake = await mocked(req);
    if (fake) return JSON.stringify(fake);
    if (options.offline) throw new Error(`Sin conexión en esta prueba (no hay mock para ${req.url})`);

    const timeout = Math.min(Math.max(req.timeout ?? 20, 1), 20);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeout * 1000);
    try {
      const res = await fetch(req.url, {
        method,
        headers: { "user-agent": `NOVA-TV-Plugin/1 (${manifest.id})`, ...headers },
        body: method === "POST" || method === "PUT" ? req.body ?? "" : undefined,
        redirect: "manual",
        signal: abort.signal,
      });
      const out: Record<string, string> = {};
      res.headers.forEach((value, key) => (out[key.toLowerCase()] = value));
      const bytes = method === "HEAD" ? new ArrayBuffer(0) : await res.arrayBuffer();
      if (bytes.byteLength > MAX_BODY) throw new Error("Respuesta de más de 5 MB");
      return JSON.stringify({ status: res.status, headers: out, body: new TextDecoder().decode(bytes) });
    } catch (e) {
      throw new Error(`${new URL(req.url).hostname}: ${(e as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  const host: NovaHost = {
    api: 1,
    http,
    storageGet: (scope, key) => bucket(scope).get(key),
    storageSet(scope, key, value) {
      if (key.length > 200) throw new Error("Clave demasiado larga (máximo 200)");
      const map = bucket(scope);
      const before = map.has(key) ? key.length + map.get(key)!.length : 0;
      if (used() - before + key.length + value.length > QUOTA) throw new Error("El plugin ha llenado sus 5 MB de almacenamiento");
      map.set(key, value);
    },
    storageDelete: (scope, key) => void bucket(scope).delete(key),
    secretGet: (key) => vault().get(key),
    secretSet(key, value) {
      const map = vault();
      if (!key || key.length > 100) throw new Error("La clave tiene que tener entre 1 y 100 caracteres");
      const size = [...map].reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), key.length + value.length);
      if (size > 64 * 1024) throw new Error("Los secretos son para sesiones (64 KB por perfil), no para datos: usa storage");
      map.set(key, value);
    },
    secretDelete: (key) => void vault().delete(key),
    setting(key) {
      const value = key in userSettings ? userSettings[key] : manifest.settings?.find((s) => s.key === key)?.default;
      return value === undefined ? undefined : JSON.stringify(value);
    },
    location() {
      if (!manifest.permissions.location) throw new Error("El plugin no tiene el permiso «location»");
      return options.location ? JSON.stringify({ source: "user", ...options.location }) : undefined;
    },
    notify(title, detail) {
      if (!manifest.permissions.notify) throw new Error("El plugin no tiene el permiso «notify»");
      const now = Date.now();
      while (sentAt.length && now - sentAt[0] >= 60_000) sentAt.shift();
      if (sentAt.length >= 3) {
        logs.push({ level: "warn", message: `Aviso descartado (máximo 3 por minuto): ${title}` });
        return;
      }
      sentAt.push(now);
      notices.push(detail === undefined ? { title } : { title, detail });
      if (print) console.log(`[aviso] ${title}${detail ? ` · ${detail}` : ""}`);
    },
    log(level, message) {
      logs.push({ level, message });
      if (print) console.log(`[${manifest.id}] ${level === "info" ? "" : level + ": "}${message}`);
    },
  };

  globalThis.__nova = host;
  let loaded: Promise<ProviderDefinition> | undefined;
  const ready = () =>
    (loaded ??= (async () => {
      if (typeof plugin !== "function") return plugin;
      globalThis.__nova = host;
      globalThis.__novaPlugin = undefined;
      const mod = (await plugin()) as { default?: ProviderDefinition } | undefined;
      const def = globalThis.__novaPlugin ?? mod?.default;
      if (!def) throw new Error("El plugin no llamó a defineProvider()");
      return def;
    })());

  const ctx = (): Context => ({
    profile: { id: profile.id, kids: profile.kids },
    locale: options.locale ?? "es-ES",
    country: options.country ?? options.location?.countryCode ?? null,
  });

  /** Calls a part the way NOVA does: permission first, then the function. */
  async function call<T>(part: keyof ProviderDefinition, fn: string, args: unknown[]): Promise<T> {
    if (!manifest.permissions[part]) throw new Error(`El manifiesto no pide el permiso «${part}»: NOVA no llamaría a ${part}.${fn}()`);
    const def = await ready();
    const target = def[part] as Record<string, unknown> | undefined;
    if (!target || typeof target[fn] !== "function") throw new Error(`El plugin no tiene ${part}.${fn}()`);
    globalThis.__nova = host;
    // Values cross as JSON in NOVA: anything that doesn't survive that, doesn't arrive.
    const result = await (target[fn] as (...a: unknown[]) => Promise<unknown>)(...args);
    return (result === undefined ? undefined : JSON.parse(JSON.stringify(result))) as T;
  }

  const report = (found: string[]) => {
    problems.length = 0;
    problems.push(...found);
    for (const p of found) if (print) console.warn(`[NOVA] ${p}`);
  };

  const signInProblems = (code: SignInCode) => {
    const found: string[] = [];
    if (!isHttps(code?.url)) found.push(`account.start(): «url» tiene que ser https:// (${String(code?.url)})`);
    if (!text(code?.code) || code.code.length > 20) found.push("account.start(): falta «code» (o pasa de 20 caracteres)");
    if (code?.urlComplete !== undefined && !isHttps(code.urlComplete)) found.push("account.start(): «urlComplete» tiene que ser https://");
    if (!(code?.expiresIn > 0) || !(code?.interval > 0)) found.push("account.start(): «expiresIn» e «interval» son segundos (> 0)");
    return found;
  };

  return {
    requests,
    logs,
    notices,
    storage,
    secrets: secretMaps,
    problems,
    account: {
      async start() {
        const code = await call<SignInCode>("account", "start", [ctx()]);
        report(signInProblems(code));
        return code;
      },
      async poll() {
        const answer = await call<SignInStatus>("account", "poll", [ctx()]);
        const ok = ["pending", "done", "denied", "expired"].includes(answer?.status);
        const found = ok ? [] : [`account.poll(): «status» desconocido (${String(answer?.status)}); NOVA lo toma como "pending"`];
        if (answer?.status === "done" && !text(answer.user?.name)) found.push("account.poll(): con «done» va el usuario ({ name })");
        report(found);
        return answer;
      },
      async status() {
        return call<AccountUser | null | undefined>("account", "status", [ctx()]);
      },
      async signOut() {
        const def = await ready();
        if (typeof def.account?.signOut === "function") await call("account", "signOut", [ctx()]);
        secretMaps.delete(profile.id);
      },
    },
    advance(seconds) {
      shift(seconds * 1000);
    },
    setProfile(p) {
      profile = { ...profile, ...p };
    },
    setSetting(key, value) {
      userSettings[key] = value;
    },

    async channels() {
      const list = await call<Channel[]>("channels", "load", [ctx()]);
      if (!Array.isArray(list)) throw new Error("channels.load() tiene que devolver una lista");
      const found: string[] = [];
      const seen = new Set<string>();
      const def = await ready();
      list.forEach((c, i) => {
        const where = `canal ${i + 1} (${c?.id ?? "sin id"})`;
        if (typeof c?.id !== "string" || !c.id || c.id.length > 100 || /\s/.test(c.id)) found.push(`${where}: «id» vacío, con espacios o de más de 100 caracteres; NOVA lo descarta`);
        else if (seen.has(c.id)) found.push(`${where}: «id» repetido`);
        else seen.add(c.id);
        if (!text(c?.name)) found.push(`${where}: falta «name»; NOVA lo descarta`);
        if (c.logo !== undefined && !isHttps(c.logo)) found.push(`${where}: «logo» tiene que ser https://`);
        if (c.number !== undefined && (!Number.isInteger(c.number) || c.number < 1 || c.number > 500)) found.push(`${where}: «number» va de 1 a 500 (tu bloque de canales)`);
        for (const cat of c.categories ?? []) if (!CATEGORIES.includes(cat)) found.push(`${where}: categoría «${cat}» desconocida; NOVA la ignora`);
        if (c.stream) {
          const p = streamProblem(c.stream);
          if (p) found.push(`${where}: ${p}`);
          else if (c.stream.type === "hls") {
            if (c.stream.proxy) {
              try {
                checkUrl(manifest, c.stream.url);
              } catch (e) {
                found.push(`${where}: ${(e as Error).message}`);
              }
            }
          }
        } else if (typeof def.channels?.stream !== "function") found.push(`${where}: sin «stream» y sin channels.stream(): no se podrá ver`);
      });
      if (list.length > 500) found.push(`${list.length} canales: NOVA usa los primeros 500 de tu bloque`);
      report(found);
      return list;
    },

    async stream(id, { retry = false } = {}) {
      const s = await call<Stream>("channels", "stream", [id, { ...ctx(), retry }]);
      const p = streamProblem(s);
      report(p ? [`stream(${id}): ${p}`] : []);
      return s;
    },

    async sign(url, { retry = false } = {}) {
      const def = await ready();
      if (typeof def.channels?.sign !== "function") return { url };
      const answer = await call<string | { url: string; headers?: Record<string, string> }>("channels", "sign", [url, { ...ctx(), retry }]);
      const signed = typeof answer === "string" ? { url: answer } : answer;
      const found: string[] = [];
      if (!isHttps(signed?.url)) found.push(`sign(): tiene que devolver una dirección https:// (${String(signed?.url)})`);
      else if (signed.url.length > 8192) found.push(`sign(): la dirección mide ${signed.url.length} caracteres (NOVA admite 8192)`);
      else {
        try {
          checkUrl(manifest, signed.url);
        } catch (e) {
          found.push(`sign(): ${(e as Error).message}`);
        }
      }
      report(found);
      return signed;
    },

    async check(id) {
      const on = await call<boolean>("channels", "check", [id, ctx()]);
      report(typeof on === "boolean" ? [] : [`check(${id}) tiene que devolver true o false`]);
      return on;
    },

    async guide(ids, range) {
      const now = Math.floor(Date.now() / 1000);
      const wanted = ids ?? (manifest.permissions.channels ? (await call<Channel[]>("channels", "load", [ctx()])).map((c) => c.id) : []);
      const r = range ?? { from: now, to: now + 6 * 3600 };
      const guide = await call<Record<string, Program[]>>("guide", "load", [wanted, r, ctx()]);
      const found: string[] = [];
      for (const [id, programs] of Object.entries(guide ?? {})) {
        if (!wanted.includes(id)) found.push(`guía: «${id}» no es uno de los canales pedidos`);
        (programs ?? []).forEach((p, i) => {
          const where = `guía ${id} #${i + 1}`;
          if (!text(p.title)) found.push(`${where}: falta «title»`);
          if (!(p.end > p.start)) found.push(`${where}: «end» tiene que ser después de «start»`);
          if (p.start > 1e11) found.push(`${where}: las horas van en segundos, no milisegundos`);
          if (p.image !== undefined && !isHttps(p.image)) found.push(`${where}: «image» tiene que ser https://`);
        });
      }
      report(found);
      return guide;
    },

    async rows() {
      const rows = await call<Row[]>("rows", "load", [ctx()]);
      const found: string[] = [];
      if (rows.length > 5) found.push(`${rows.length} filas: NOVA muestra las 5 primeras`);
      rows.forEach((row, r) => {
        if (row.items.length > 40) found.push(`fila «${row.title}»: NOVA muestra 40 elementos como mucho`);
        if (!row.items.length) found.push(`fila «${row.title}»: vacía; NOVA no la muestra`);
        row.items.forEach((item, i) => found.push(...itemProblems(item, `fila ${r + 1}, elemento ${i + 1}`)));
      });
      report(found);
      return rows;
    },

    async search(query) {
      const items = await call<Item[]>("search", "search", [query, ctx()]);
      report(items.flatMap((item, i) => itemProblems(item, `resultado ${i + 1}`)));
      return items;
    },

    async screensaver() {
      const images = await call<string[]>("screensaver", "load", [ctx()]);
      report(images.filter((u) => !isHttps(u)).map((u) => `salvapantallas: «${u}» no es https://`));
      return images;
    },
  };
}
