/**
 * What a NOVA TV plugin gives NOVA, and what NOVA gives it.
 *
 * Providers return data; NOVA draws it with its own interface, so every plugin
 * feels the same with the remote. Times are Unix seconds, durations are text
 * like "30m", "6h" or "1d".
 */

/** "15m", "6h", "1d"… (minimums are enforced by NOVA: 15 min, channels 1 h). */
export type Duration = `${number}${"m" | "h" | "d"}`;

/** NOVA's themes, shared by every source (TDT, Pluto TV, plugins…). */
export type Category =
  | "Noticias"
  | "Deportes"
  | "Infantil"
  | "Cine"
  | "Series"
  | "Música"
  | "Documentales"
  | "Entretenimiento"
  | "Estilo de vida"
  | "Religión"
  | "Otros";

/** Who is watching. The id is opaque and different for every plugin. */
export interface Profile {
  id: string;
  kids: boolean;
}

/** Given to every call NOVA makes into the plugin. */
export interface Context {
  profile: Profile;
  /** "es-ES"… */
  locale: string;
}

// ───────────────────────── Playback ─────────────────────────

/** How something plays. NOVA chooses the player; the plugin only describes the stream. */
export type Stream =
  | {
      type: "hls";
      /** HTTPS, on a domain listed in the plugin's `network` permission. */
      url: string;
      /**
       * Playlists are fetched through NOVA (for servers that block other
       * websites, or need the headers below). Video segments still load directly.
       */
      proxy?: boolean;
      /** Sent with proxied playlist requests (e.g. a session token). */
      headers?: Record<string, string>;
    }
  /** Twitch's official embedded player. */
  | { type: "twitch"; channel: string }
  /** YouTube's official embedded player: a video or a channel's live stream. */
  | { type: "youtube"; video: string }
  | { type: "youtube"; channel: string };

// ───────────────────────── Live TV ─────────────────────────

export interface Channel {
  /** Stable and unique within the plugin ("bob-esponja", a source's own id…). */
  id: string;
  name: string;
  /** Preferred position inside the plugin's channel range (NOVA keeps numbers stable). */
  number?: number;
  /** HTTPS image. */
  logo?: string;
  /** Shown as the channel's group in the guide ("Infantil", "Minecraft"…). */
  group?: string;
  categories?: Category[];
  /** ISO 3166 country, if the channel belongs to one ("ES"). */
  country?: string;
  /**
   * How it plays, if it never changes. Leave it out and implement
   * `channels.stream()` when the address has to be asked for at play time.
   */
  stream?: Stream;
}

export interface Program {
  start: number;
  end: number;
  title: string;
  description?: string;
  genre?: string;
  /** HTTPS image. */
  image?: string;
}

export interface ChannelsProvider {
  refresh?: Duration;
  /** The full list. NOVA keeps the last good one if this fails. */
  load(ctx: Context): Promise<Channel[]>;
  /**
   * The stream for a channel, right before it plays (for addresses that expire).
   * `retry` is true when the previous one was refused, to get a fresh one.
   */
  stream?(id: string, ctx: Context & { retry: boolean }): Promise<Stream>;
  /** Signal check: is this channel on air? Without it, NOVA checks the stream itself. */
  check?(id: string, ctx: Context): Promise<boolean>;
}

export interface GuideProvider {
  refresh?: Duration;
  /** Programmes for these channels between `from` and `to`, keyed by channel id. */
  load(ids: string[], range: { from: number; to: number }, ctx: Context): Promise<Record<string, Program[]>>;
}

// ───────────────────────── Home, search, screensaver ─────────────────────────

/** What happens when an item is chosen. A closed list: plugins can't open other programs or websites. */
export type Action =
  | { type: "play"; stream: Stream; title?: string }
  | { type: "tune"; channel: string }
  | { type: "detail"; title?: string; text: string; image?: string }
  | { type: "app"; path?: string };

export interface Item {
  id: string;
  title: string;
  subtitle?: string;
  /** HTTPS image. */
  image?: string;
  /** Short label on the tile ("EN DIRECTO", "Nuevo"…). */
  badge?: string;
  action: Action;
}

export interface Row {
  id?: string;
  title: string;
  /** Tile shape: 16:9, 2:3 or 1:1. */
  style?: "landscape" | "poster" | "square";
  items: Item[];
}

export interface RowsProvider {
  refresh?: Duration;
  load(ctx: Context): Promise<Row[]>;
}

export interface SearchProvider {
  search(query: string, ctx: Context): Promise<Item[]>;
}

export interface ScreensaverProvider {
  refresh?: Duration;
  /** HTTPS images. */
  load(ctx: Context): Promise<string[]>;
}

// ───────────────────────── Accounts ─────────────────────────

/** Who is signed in, as NOVA shows it ("Conectado como …"). */
export interface AccountUser {
  name: string;
  /** HTTPS image. */
  avatar?: string;
}

/** What NOVA shows to sign in: "Ve a <url> y escribe <code>", with a QR. */
export interface SignInCode {
  /** HTTPS, where to type the code ("https://www.twitch.tv/activate"). */
  url: string;
  code: string;
  /** The address with the code already in it, if the service has one (for the QR). */
  urlComplete?: string;
  /** Seconds the code lasts. */
  expiresIn: number;
  /** Seconds between `poll()` calls. */
  interval: number;
}

export type SignInStatus =
  | { status: "pending" }
  | { status: "done"; user: AccountUser }
  | { status: "denied" }
  | { status: "expired" };

/**
 * Signing in to the plugin's service, as on every TV: NOVA shows a code, the
 * user types it on their phone. `deviceLogin()` implements it for any OAuth
 * service; write your own only for services that do it differently.
 * Each NOVA profile has its own account.
 */
export interface AccountProvider {
  /** A new code to show. */
  start(ctx: Context): Promise<SignInCode>;
  /** Has the code been typed? NOVA asks every `interval` seconds while it's on screen. */
  poll(ctx: Context): Promise<SignInStatus>;
  /** Who is signed in now (undefined/null: nobody). */
  status(ctx: Context): Promise<AccountUser | null | undefined>;
  /** Tell the service (e.g. revoke the token). NOVA deletes the profile's `secrets` afterwards anyway. */
  signOut?(ctx: Context): Promise<void>;
}

/** Everything a provider can offer. Each part needs its permission in the manifest. */
export interface ProviderDefinition {
  channels?: ChannelsProvider;
  guide?: GuideProvider;
  rows?: RowsProvider;
  search?: SearchProvider;
  screensaver?: ScreensaverProvider;
  account?: AccountProvider;
}

// ───────────────────────── Host services ─────────────────────────

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "DELETE" | "HEAD";
  headers?: Record<string, string>;
  body?: string;
  /** Seconds (NOVA caps it at 20). */
  timeout?: number;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
}

export interface Location {
  city: string;
  country: string;
  /** Rounded to about 10 km. */
  latitude: number;
  longitude: number;
}
