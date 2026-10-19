import type { HttpRequest, HttpResponse, Location } from "./types";

/**
 * The bridge to NOVA. Inside NOVA, the plugin host (Rust) puts `__nova` on the
 * global object; these are the only ways a plugin can reach outside its
 * sandbox, and NOVA checks the plugin's permissions on every call.
 *
 * Values cross as JSON text. Anything that waits returns a Promise.
 */
export interface NovaHost {
  /** API version of the host (1). */
  readonly api: number;
  http(request: string): Promise<string>;
  /** null or undefined when there's nothing (hosts may return either). */
  storageGet(scope: "plugin" | "profile", key: string): string | null | undefined;
  storageSet(scope: "plugin" | "profile", key: string, value: string): void;
  storageDelete(scope: "plugin" | "profile", key: string): void;
  /** The profile's secrets (needs "account"). */
  secretGet(key: string): string | null | undefined;
  secretSet(key: string, value: string): void;
  secretDelete(key: string): void;
  setting(key: string): string | null | undefined;
  location(): string | null | undefined;
  notify(title: string, detail?: string): void;
  log(level: "info" | "warn" | "error", message: string): void;
}

declare global {
  // eslint-disable-next-line no-var
  var __nova: NovaHost | undefined;
}

function host(): NovaHost {
  const h = globalThis.__nova;
  if (!h) throw new Error("Este plugin se ejecuta dentro de NOVA TV (o de `nova dev`).");
  return h;
}

// ───────────────────────── http ─────────────────────────

/** A response that wasn't 2xx. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly response: HttpResponse,
  ) {
    super(`HTTP ${status}`);
    this.name = "HttpError";
  }
}

/** Query parameters: undefined and null are left out. */
export type Query = Record<string, string | number | boolean | undefined | null>;

/** Options for `http.json`, `http.text`… */
export type Options = Omit<HttpRequest, "url" | "body" | "method"> & { query?: Query };

/**
 * An address with its query parameters, properly encoded:
 * `url("https://a.es/buscar", { q: "fútbol", page: 2 })` → `https://a.es/buscar?q=f%C3%BAtbol&page=2`.
 * Adds to the parameters the address already has.
 */
export function url(base: string, query?: Query): string {
  const pairs = Object.entries(query ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  if (!pairs.length) return base;
  const [path, hash] = base.split("#");
  return `${path}${path.includes("?") ? "&" : "?"}${pairs.join("&")}${hash !== undefined ? `#${hash}` : ""}`;
}

/** Header names in lower case (so "User-Agent" and "user-agent" are the same one). */
const lower = (headers?: Record<string, string>) => Object.fromEntries(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));

/** What every request of the plugin carries unless it says otherwise. */
const defaults: { headers: Record<string, string>; timeout?: number } = { headers: {} };

function prepare(req: HttpRequest & { query?: Query }): HttpRequest {
  const { query, ...rest } = req;
  return { ...rest, url: url(rest.url, query), timeout: rest.timeout ?? defaults.timeout, headers: { ...defaults.headers, ...lower(rest.headers) } };
}

async function request(req: HttpRequest & { query?: Query }): Promise<HttpResponse> {
  const raw = await host().http(JSON.stringify(prepare(req)));
  return JSON.parse(raw) as HttpResponse;
}

async function ok(req: HttpRequest & { query?: Query }): Promise<HttpResponse> {
  const res = await request(req);
  if (res.status < 200 || res.status > 299) throw new HttpError(res.status, res);
  return res;
}

/** Browser identities for `http.setUserAgent`, for services that only answer to browsers. */
const agents = {
  chrome: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
  firefox: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
  safari: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  android: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
  smartTv: "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) 94.0.4606.31/7.0 TV Safari/537.36",
} as const;

// ───────────────────────── Clients ─────────────────────────

export interface HttpClientOptions {
  /** Prefix for relative paths ("https://api.ejemplo.es/v2"). Full https:// addresses are used as they are. */
  base?: string;
  /** Headers for every request; a function is called each time (e.g. a token that changes). */
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  /** Query parameters for every request. */
  query?: Query;
  userAgent?: string;
  /** Seconds (NOVA caps it at 20). */
  timeout?: number;
}

/** `http`, bound to one service: its base address, headers and parameters. */
export interface HttpClient {
  request(req: Omit<HttpRequest, "url"> & { url: string; query?: Query }): Promise<HttpResponse>;
  text(path: string, options?: Options): Promise<string>;
  json<T = unknown>(path: string, options?: Options): Promise<T>;
  postJson<T = unknown>(path: string, body: unknown, options?: Options): Promise<T>;
  postForm<T = unknown>(path: string, fields: Record<string, string | number | undefined>, options?: Options): Promise<T>;
}

function create(client: HttpClientOptions = {}): HttpClient {
  const full = (path: string) => (/^https?:\/\//.test(path) || !client.base ? path : `${client.base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`);
  const with_ = async <R extends { url: string; headers?: Record<string, string>; query?: Query; timeout?: number }>(req: R): Promise<R> => {
    const own = typeof client.headers === "function" ? await client.headers() : client.headers;
    const ua = client.userAgent ? { "user-agent": client.userAgent } : {};
    return {
      ...req,
      url: full(req.url),
      query: { ...client.query, ...req.query },
      timeout: req.timeout ?? client.timeout,
      headers: { ...ua, ...lower(own), ...lower(req.headers) },
    };
  };
  return {
    request: async (req) => request(await with_(req)),
    async text(path, options) {
      return (await ok(await with_({ ...options, url: path }))).body;
    },
    async json<T>(path: string, options?: Options) {
      return JSON.parse((await ok(await with_({ ...options, url: path }))).body) as T;
    },
    async postJson<T>(path: string, body: unknown, options?: Options) {
      const headers = { "content-type": "application/json", ...options?.headers };
      return JSON.parse((await ok(await with_({ ...options, url: path, method: "POST" as const, headers, body: JSON.stringify(body) }))).body) as T;
    },
    async postForm<T>(path: string, fields: Record<string, string | number | undefined>, options?: Options) {
      return JSON.parse((await ok(await with_(formRequest(path, fields, options)))).body) as T;
    },
  };
}

/**
 * HTTPS requests, only to the domains in the plugin's `network` permission.
 * Responses are capped at 5 MB.
 */
export const http = {
  /** Any request; never throws for an HTTP status. */
  request,
  /**
   * The browser identity of every request of the plugin (services that only
   * answer to browsers): `http.setUserAgent(http.agents.chrome)`.
   */
  setUserAgent(userAgent: string) {
    defaults.headers["user-agent"] = userAgent;
  },
  /** Headers for every request of the plugin (`undefined` removes one). */
  setHeaders(headers: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined) delete defaults.headers[k.toLowerCase()];
      else defaults.headers[k.toLowerCase()] = v;
    }
  },
  /** Seconds every request may take (NOVA caps it at 20). */
  setTimeout(seconds: number) {
    defaults.timeout = seconds;
  },
  /** Browser identities: chrome, firefox, safari, android, smartTv. */
  agents,
  /**
   * A client for one service:
   * ```ts
   * const api = http.create({ base: "https://api.ejemplo.es/v2", headers: () => ({ authorization: `Bearer ${token}` }) });
   * await api.json("/canales", { query: { limit: 100 } });
   * ```
   */
  create,
  /** GET, body as text (throws `HttpError` if not 2xx). */
  async text(url: string, options?: Options): Promise<string> {
    return (await ok({ ...options, url })).body;
  },
  /** GET, body parsed as JSON (throws `HttpError` if not 2xx). */
  async json<T = unknown>(url: string, options?: Options): Promise<T> {
    return JSON.parse((await ok({ ...options, url })).body) as T;
  },
  /** POST a JSON body, response parsed as JSON (throws `HttpError` if not 2xx). */
  async postJson<T = unknown>(url: string, body: unknown, options?: Options): Promise<T> {
    const headers = { "content-type": "application/json", ...options?.headers };
    const res = await ok({ ...options, url, method: "POST", headers, body: JSON.stringify(body) });
    return JSON.parse(res.body) as T;
  },
  /**
   * POST a form (`a=1&b=2`, what OAuth servers expect), response parsed as
   * JSON (throws `HttpError` if not 2xx). Fields left undefined aren't sent.
   */
  async postForm<T = unknown>(url: string, fields: Record<string, string | number | undefined>, options?: Options): Promise<T> {
    const res = await ok(formRequest(url, fields, options));
    return JSON.parse(res.body) as T;
  },
};

/** The request `postForm` sends (also for `http.request`, which never throws for a status). */
export function formRequest(url: string, fields: Record<string, string | number | undefined>, options?: Options): HttpRequest {
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const headers = { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...options?.headers };
  return { ...options, url, method: "POST", headers, body };
}

// ───────────────────────── storage ─────────────────────────

function scoped(scope: "plugin" | "profile") {
  return {
    get<T = unknown>(key: string): T | undefined {
      const raw = host().storageGet(scope, key);
      return raw == null ? undefined : (JSON.parse(raw) as T);
    },
    set(key: string, value: unknown): void {
      host().storageSet(scope, key, JSON.stringify(value));
    },
    remove(key: string): void {
      host().storageDelete(scope, key);
    },
  };
}

/**
 * Small saved values (JSON), 5 MB in all. `storage` is shared by the whole
 * plugin; `storage.profile` is separate for each NOVA profile. All of it is
 * deleted when the plugin is uninstalled.
 */
export const storage = Object.assign(scoped("plugin"), { profile: scoped("profile") });

/**
 * Account sessions (tokens) of the profile watching, encrypted on the TV
 * (needs the `account` permission). Separate from `storage`, 64 KB per
 * profile, deleted when the user signs out. `deviceLogin()` uses it for you.
 */
export const secrets = {
  get<T = unknown>(key: string): T | undefined {
    const raw = host().secretGet(key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  },
  set(key: string, value: unknown): void {
    host().secretSet(key, JSON.stringify(value));
  },
  remove(key: string): void {
    host().secretDelete(key);
  },
};

// ───────────────────────── settings, location, log ─────────────────────────

/** The plugin's options, as declared in its manifest and set by the user in Ajustes → Plugins. */
export const settings = {
  get<T = string>(key: string): T | undefined {
    const raw = host().setting(key);
    return raw == null ? undefined : (JSON.parse(raw) as T);
  },
};

/** Approximate location (needs the `location` permission; undefined if the user hasn't set a city). */
export const location = {
  get(): Location | undefined {
    const raw = host().location();
    return raw == null ? undefined : (JSON.parse(raw) as Location);
  },
};

/**
 * A short notice in NOVA, with the plugin's name (needs the `notify` permission).
 * At most 3 a minute: more are dropped. For things that matter now
 * ("Empieza el partido"), not for every refresh.
 */
export function notify(title: string, detail?: string): void {
  host().notify(title, detail);
}

const text = (parts: unknown[]) => parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");

/** Shown in `nova dev` and in Ajustes → Plugins → Registro. */
export const log = {
  info: (...parts: unknown[]) => host().log("info", text(parts)),
  warn: (...parts: unknown[]) => host().log("warn", text(parts)),
  error: (...parts: unknown[]) => host().log("error", text(parts)),
  /**
   * How long something takes: `const done = log.time("canales"); …; done("145 canales")`
   * writes "canales: 812 ms · 145 canales".
   */
  time(label: string) {
    const started = Date.now();
    return (...detail: unknown[]) => host().log("info", `${label}: ${Date.now() - started} ms${detail.length ? ` · ${text(detail)}` : ""}`);
  },
};
