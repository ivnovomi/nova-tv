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

async function request(req: HttpRequest): Promise<HttpResponse> {
  const raw = await host().http(JSON.stringify(req));
  return JSON.parse(raw) as HttpResponse;
}

async function ok(req: HttpRequest): Promise<HttpResponse> {
  const res = await request(req);
  if (res.status < 200 || res.status > 299) throw new HttpError(res.status, res);
  return res;
}

type Options = Omit<HttpRequest, "url" | "body" | "method">;

/**
 * HTTPS requests, only to the domains in the plugin's `network` permission.
 * Responses are capped at 5 MB.
 */
export const http = {
  /** Any request; never throws for an HTTP status. */
  request,
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
};
