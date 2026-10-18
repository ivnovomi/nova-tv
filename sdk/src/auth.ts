/**
 * Signing in with a code on the TV (OAuth 2.0 Device Authorization Grant,
 * RFC 8628): what Twitch, Google/YouTube, Trakt, Microsoft… use for TVs.
 *
 * ```ts
 * const twitch = deviceLogin({
 *   deviceUrl: "https://id.twitch.tv/oauth2/device",
 *   tokenUrl: "https://id.twitch.tv/oauth2/token",
 *   clientId: "…",
 *   scopes: ["user:read:follows"],
 *   async user(token) {
 *     const me = await http.json<…>("https://api.twitch.tv/helix/users", { headers: { authorization: `Bearer ${token}`, "client-id": "…" } });
 *     return { name: me.data[0].display_name, avatar: me.data[0].profile_image_url };
 *   },
 * });
 *
 * export default defineProvider({
 *   account: twitch.account,
 *   rows: { async load() { const token = await twitch.token(); if (!token) return []; … } },
 * });
 * ```
 *
 * The session is kept in `secrets` (encrypted, one per NOVA profile) and the
 * access token is refreshed by itself when it's about to expire.
 */
import { formRequest, http, secrets } from "./host";
import type { AccountProvider, AccountUser, HttpResponse } from "./types";

export interface DeviceLoginOptions {
  /** The service's device authorization endpoint (where codes are asked for). */
  deviceUrl: string;
  /** The service's token endpoint. */
  tokenUrl: string;
  clientId: string;
  /**
   * Only for services that ask for it on TVs (Google). It ships inside the
   * plugin, so it isn't really secret: the service knows that for TV apps.
   */
  clientSecret?: string;
  scopes?: string[];
  /** Extra fields for the code request and for the token request, if the service wants more. */
  deviceFields?: Record<string, string>;
  tokenFields?: Record<string, string>;
  /** Who signed in, asked with the brand-new token (shown in NOVA as "Conectado como …"). */
  user(token: string): Promise<AccountUser>;
  /** Tells the service the token is no longer wanted, on sign-out (optional). */
  revoke?(token: string): Promise<void>;
  /** Where the session is kept in `secrets` (change it only to have two logins in one plugin). */
  key?: string;
}

export interface DeviceLogin {
  /** The `account` part for `defineProvider`. */
  account: AccountProvider;
  /**
   * A valid access token for the profile watching, refreshed if it was about
   * to expire. undefined if nobody is signed in (or the session ended).
   */
  token(): Promise<string | undefined>;
  /** Who is signed in, without asking the service. */
  user(): AccountUser | undefined;
  /** Forgets the session (e.g. the service says the token was revoked). */
  forget(): void;
}

interface Session {
  access: string;
  refresh?: string;
  /** ms. */
  expiresAt?: number;
  user: AccountUser;
}

interface Pending {
  deviceCode: string;
  /** ms. */
  expiresAt: number;
  interval: number;
  /** ms: don't ask the service before this (it asks for patience with "slow_down"). */
  nextAt: number;
}

interface TokenAnswer {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  /** Standard OAuth errors… */
  error?: string;
  /** …and Twitch's way of saying the same thing. */
  message?: string;
}

const parse = <T>(res: HttpResponse): T | undefined => {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    return undefined;
  }
};

export function deviceLogin(options: DeviceLoginOptions): DeviceLogin {
  const sessionKey = `${options.key ?? "deviceLogin"}.session`;
  const pendingKey = `${options.key ?? "deviceLogin"}.pending`;
  const secret = options.clientSecret;

  const save = (answer: TokenAnswer, user: AccountUser, previous?: Session): Session => {
    const session: Session = {
      access: answer.access_token!,
      // Some services only send a refresh token the first time.
      refresh: answer.refresh_token ?? previous?.refresh,
      expiresAt: answer.expires_in ? Date.now() + answer.expires_in * 1000 : undefined,
      user,
    };
    secrets.set(sessionKey, session);
    return session;
  };

  const forget = () => {
    secrets.remove(sessionKey);
    secrets.remove(pendingKey);
  };

  const account: AccountProvider = {
    async start() {
      const res = await http.request(
        formRequest(options.deviceUrl, { client_id: options.clientId, scope: options.scopes?.join(" "), ...options.deviceFields }),
      );
      const answer = parse<Record<string, string | number | undefined>>(res);
      if (res.status < 200 || res.status > 299 || !answer?.device_code || !answer.user_code) {
        throw new Error(`El servicio no dio un código para iniciar sesión (HTTP ${res.status}): ${res.body.slice(0, 200)}`);
      }
      const expiresIn = Number(answer.expires_in ?? 600);
      const interval = Number(answer.interval ?? 5);
      secrets.set(pendingKey, { deviceCode: String(answer.device_code), expiresAt: Date.now() + expiresIn * 1000, interval, nextAt: 0 } satisfies Pending);
      return {
        // Google calls it verification_url.
        url: String(answer.verification_uri ?? answer.verification_url),
        code: String(answer.user_code),
        urlComplete: answer.verification_uri_complete ? String(answer.verification_uri_complete) : undefined,
        expiresIn,
        interval,
      };
    },

    async poll() {
      const pending = secrets.get<Pending>(pendingKey);
      if (!pending || Date.now() > pending.expiresAt) {
        secrets.remove(pendingKey);
        return { status: "expired" };
      }
      if (Date.now() < pending.nextAt) return { status: "pending" };

      const res = await http.request(
        formRequest(options.tokenUrl, {
          client_id: options.clientId,
          client_secret: secret,
          device_code: pending.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          ...options.tokenFields,
        }),
      );
      const answer = parse<TokenAnswer>(res) ?? {};
      if (res.status >= 200 && res.status < 300 && answer.access_token) {
        const user = await options.user(answer.access_token);
        save(answer, user);
        secrets.remove(pendingKey);
        return { status: "done", user };
      }
      switch (answer.error ?? answer.message) {
        case "authorization_pending":
          secrets.set(pendingKey, { ...pending, nextAt: Date.now() + pending.interval * 1000 - 500 });
          return { status: "pending" };
        case "slow_down": {
          const interval = pending.interval + 5;
          secrets.set(pendingKey, { ...pending, interval, nextAt: Date.now() + interval * 1000 });
          return { status: "pending" };
        }
        case "access_denied":
          secrets.remove(pendingKey);
          return { status: "denied" };
        case "expired_token":
        case "invalid device code":
          secrets.remove(pendingKey);
          return { status: "expired" };
        default:
          throw new Error(`El servicio respondió al iniciar sesión: ${answer.error ?? answer.message ?? `HTTP ${res.status}`}`);
      }
    },

    async status() {
      return secrets.get<Session>(sessionKey)?.user ?? null;
    },

    async signOut() {
      const session = secrets.get<Session>(sessionKey);
      if (session && options.revoke) {
        try {
          await options.revoke(session.access);
        } catch {
          /* signed out here either way */
        }
      }
      forget();
    },
  };

  return {
    account,
    user: () => secrets.get<Session>(sessionKey)?.user,
    forget,
    async token() {
      const session = secrets.get<Session>(sessionKey);
      if (!session) return undefined;
      // A minute of margin, so it doesn't expire halfway through a request.
      if (!session.expiresAt || Date.now() < session.expiresAt - 60_000) return session.access;
      if (!session.refresh) {
        forget();
        return undefined;
      }
      const res = await http.request(
        formRequest(options.tokenUrl, { client_id: options.clientId, client_secret: secret, grant_type: "refresh_token", refresh_token: session.refresh }),
      );
      const answer = parse<TokenAnswer>(res);
      if (res.status >= 200 && res.status < 300 && answer?.access_token) return save(answer, session.user, session).access;
      // The service no longer accepts the session (revoked, password changed…): signed out.
      if (res.status === 400 || res.status === 401) {
        forget();
        return undefined;
      }
      throw new Error(`No se pudo renovar la sesión (HTTP ${res.status})`);
    },
  };
}
