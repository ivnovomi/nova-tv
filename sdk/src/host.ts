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
  storageGet(scope: "plugin" | "profile", key: string): string | null;
  storageSet(scope: "plugin" | "profile", key: string, value: string): void;
  storageDelete(scope: "plugin" | "profile", key: string): void;
  setting(key: string): string | null;
  location(): string | null;
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
};

// ───────────────────────── storage ─────────────────────────

function scoped(scope: "plugin" | "profile") {
  return {
    get<T = unknown>(key: string): T | undefined {
      const raw = host().storageGet(scope, key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
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

// ───────────────────────── settings, location, log ─────────────────────────

/** The plugin's options, as declared in its manifest and set by the user in Ajustes → Plugins. */
export const settings = {
  get<T = string>(key: string): T | undefined {
    const raw = host().setting(key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  },
};

/** Approximate location (needs the `location` permission; undefined if the user hasn't set a city). */
export const location = {
  get(): Location | undefined {
    const raw = host().location();
    return raw === null ? undefined : (JSON.parse(raw) as Location);
  },
};

const text = (parts: unknown[]) => parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join(" ");

/** Shown in `nova dev` and in Ajustes → Plugins → Registro. */
export const log = {
  info: (...parts: unknown[]) => host().log("info", text(parts)),
  warn: (...parts: unknown[]) => host().log("warn", text(parts)),
  error: (...parts: unknown[]) => host().log("error", text(parts)),
};
