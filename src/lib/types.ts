export type Screen = "home" | "search" | "settings" | "livetv" | "streaming" | "apps" | "games" | "media" | "system" | "store";

// ───────────────────────── Plugin store ─────────────────────────

export interface StoreScreenshot {
  url: string;
  caption?: string | null;
}

export interface StoreChange {
  version: string;
  date: number;
  notes: string[];
}

export interface StoreEntry {
  id: string;
  name: string;
  version: string;
  tagline: string;
  description: string;
  author: { name: string; verified: boolean; url?: string | null };
  category: string;
  audience: "everyone" | "adults";
  icon?: string | null;
  banner?: string | null;
  accent?: string | null;
  screenshots: StoreScreenshot[];
  permissions: PluginPermissions;
  changelog: StoreChange[];
  languages: string[];
  updatedAt: number;
  reviewedAt: number;
  tags: string[];
  package: { url: string; sha256: string; signature?: string | null; size: number };
}

export interface StoreCollection {
  id: string;
  title: string;
  subtitle?: string | null;
  style: "cards" | "wide" | "ranked" | "editorial" | string;
  ids: string[];
  accent?: string | null;
  image?: string | null;
}

export interface StoreCatalog {
  version: number;
  updatedAt: number;
  featured: string[];
  collections: StoreCollection[];
  plugins: StoreEntry[];
}

export interface StoreInfo {
  catalog: StoreCatalog | null;
  installed: Record<string, string>;
  error: string | null;
  fetchedAt: number | null;
  signed: boolean;
  developerMode: boolean;
}

export interface StoreProgress {
  id: string;
  phase: "download" | "verify" | "install" | "done";
  done: number;
  total: number;
}

export type ShortcutKind = "app" | "game" | "stream";
export type ShortcutSource = "user" | "detected" | "steam" | "builtin" | "store" | "epic" | "gog" | "ubisoft" | "xbox" | "launcher" | "pc";

export type Target =
  | { type: "executable"; path: string; args: string[] }
  | { type: "steam"; appId: number }
  | { type: "web"; url: string; tv: boolean }
  | { type: "packaged"; aumid: string }
  | { type: "uri"; uri: string }
  /** A game on a PC of the house, played through Moonlight. */
  | { type: "pc"; pc: string; game: string };

/** Ajustes → Estado de las fuentes: what NOVA knows about one source. */
export interface SourceStatus {
  key: string;
  name: string;
  role: string;
  enabled: boolean;
  channels: number | null;
  ok: number;
  dead: number;
  blocked: number;
  updatedAt: number | null;
  error: string | null;
}

/** A live check of one server. */
export interface SourceProbe {
  key: string;
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
}

/** A Twitch live stream suitable for everyone (no content labels). */
export interface TwitchLive {
  login: string;
  name: string;
  title: string;
  viewers: number;
  game: string | null;
  preview: string;
  avatar: string | null;
}

/** Someone who watches NOVA. Children's profiles have parental controls. */
export interface Profile {
  id: string;
  name: string;
  /** An emoji (or a letter). */
  avatar: string;
  color: string;
  kids: boolean;
  favorites: string[];
  lastChannel: string | null;
  /** Kids: shortcut ids they may open. */
  allowed: string[];
  allowWorld: boolean;
}

export interface ProfilesInfo {
  profiles: Profile[];
  active: string;
  hasPin: boolean;
  /** Settings unlocked from a children's profile, until this Unix time. */
  unlockedUntil: number | null;
}

export type ProfileInput = Pick<Profile, "name" | "avatar" | "color" | "kids" | "allowed" | "allowWorld"> & { id?: string };

export interface Channel {
  source: "tdt" | "world" | "playlist" | "twitch" | "plugin";
  country: string | null;
  categories: string[];
  id: string;
  number: number;
  name: string;
  logo: string | null;
  group: string;
  region: string;
  streams: string[];
  epgId: string | null;
  geo: boolean;
}

export interface Program {
  start: number;
  end: number;
  title: string;
  description: string | null;
  genre: string | null;
  image: string | null;
}

export interface HealthEntry {
  status: "ok" | "dead" | "blocked";
  checkedAt: number;
  stream: number;
}

export interface HealthProgress {
  running: boolean;
  done: number;
  total: number;
  ok: number;
  dead: number;
  blocked: number;
}

export interface PlaylistInfo {
  id: string;
  name: string;
  url: string;
  channels: number;
  error: string | null;
}

export interface LiveTvData {
  channels: Channel[];
  favorites: string[];
  lastChannel: string | null;
  playlists: PlaylistInfo[];
  tdtError: string | null;
  worldEnabled: boolean;
  worldError: string | null;
  twitchEnabled: boolean;
  twitchError: string | null;
}

export interface YtResult {
  videoId: string;
  title: string;
  channel: string | null;
  length: string | null;
  views: string | null;
  published: string | null;
  thumbnail: string;
}

export interface FileHit {
  path: string;
  name: string;
  folder: string;
  category: MediaCategory;
}

/** Real play time measured while the game's processes were running. */
export interface PlayStats {
  totalSeconds: number;
  lastPlayed: number;
  sessions: number;
}

/** Whatever Windows reports as playing (any app). */
export interface NowPlaying {
  title: string;
  artist: string | null;
  album: string | null;
  app: string;
  playing: boolean;
  position: number | null;
  duration: number | null;
  artwork: string | null;
  canSkip: boolean;
}

/** Artwork and details from Steam's public store. */
export interface GameMeta {
  steamAppId: number | null;
  title: string | null;
  kind: string | null;
  description: string | null;
  genres: string[];
  developer: string | null;
  year: string | null;
  metacritic: number | null;
  hero: string | null;
  logo: string | null;
  portrait: string | null;
  header: string | null;
  /** Where the details come from: "steam" | "microsoft" */
  source: string | null;
  /** Muted background trailer (MP4). */
  trailer: string | null;
  fetchedAt: number;
}

export interface Shortcut {
  id: string;
  name: string;
  description?: string | null;
  kind: ShortcutKind;
  target: Target;
  source: ShortcutSource;
  /** Several ways to open one game (Minecraft and its modpacks). */
  group?: string | null;
}

export interface Library {
  apps: Shortcut[];
  games: Shortcut[];
  streaming: Shortcut[];
  recent: string[];
  steamInstalled: boolean;
  browserAvailable: boolean;
}

export type MediaCategory = "video" | "audio" | "image";

export interface MediaEntry {
  path: string;
  name: string;
  category: MediaCategory;
  openedAt: number;
}

export interface RecentMedia extends MediaEntry {
  exists: boolean;
}

export interface SystemInfo {
  osName: string | null;
  osVersion: string | null;
  longOsVersion: string | null;
  kernelVersion: string | null;
  hostName: string | null;
  arch: string;
  cpuBrand: string | null;
  logicalCores: number;
  physicalCores: number | null;
  totalMemory: number;
  uptimeSecs: number;
  appVersion: string;
  userName: string | null;
}

export interface SystemStats {
  cpuUsage: number | null;
  usedMemory: number;
  totalMemory: number;
}

export interface VolumeState {
  level: number;
  muted: boolean;
}

export type SettingsPage =
  | "home"
  | "display"
  | "sound"
  | "bluetooth"
  | "network"
  | "apps"
  | "personalization"
  | "update"
  | "power"
  | "gaming"
  | "gamebar";

/** The first-run assistant's view of the connection. */
export interface NetStatus {
  internet: boolean;
  kind: "wifi" | "ethernet" | null;
  ssid: string | null;
  /** The network's name in Windows. */
  network: string | null;
  /** Private network (null: unknown). NOVA's phone remote and NovaBridge need it. */
  private: boolean | null;
  /** This computer has Wi-Fi. */
  wifi: boolean;
}

export interface WifiNetwork {
  ssid: string;
  /** 0-100 */
  signal: number;
  secured: boolean;
  connected: boolean;
  /** Windows already knows it (no password needed). */
  saved: boolean;
}

export interface RemoteDevice {
  id: string;
  name: string;
  pairedAt: number;
}

export interface RemoteInfo {
  enabled: boolean;
  running: boolean;
  urls: string[];
  pin: string;
  pairUrl: string | null;
  qrSvg: string | null;
  locked: boolean;
  devices: RemoteDevice[];
  error: string | null;
}

export interface WatchEntry {
  key: string;
  provider: "youtube" | string;
  itemId: string;
  title: string;
  channel?: string | null;
  channelUrl?: string | null;
  thumbnail?: string | null;
  position: number;
  duration: number;
  updatedAt: number;
  finished: boolean;
}

export interface FeedItem {
  videoId: string;
  title: string;
  channel: string;
  published: string;
  thumbnail: string;
}

// ───────────────────────── Plugins ─────────────────────────

export interface PluginPermissions {
  network?: string[];
  channels?: boolean;
  guide?: boolean;
  rows?: boolean;
  search?: boolean;
  screensaver?: boolean;
  notify?: boolean;
  location?: boolean;
  account?: boolean;
}

/** Who is signed in with a plugin, for the profile watching. */
export interface PluginAccountUser {
  name: string;
  avatar: string | null;
}

/** "Ve a <url> y escribe <code>". */
export interface PluginSignIn {
  url: string;
  code: string;
  qrSvg: string | null;
  expiresIn: number;
  interval: number;
}

export interface PluginSignInPoll {
  status: "pending" | "done" | "denied" | "expired";
  user: PluginAccountUser | null;
}

export interface PluginSetting {
  key: string;
  type: "text" | "toggle" | "number" | "choice";
  label: string;
  help?: string | null;
  default?: unknown;
  options?: { value: string; label: string }[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  /** The version installed before (to go back to). */
  previous: string | null;
  description: string;
  author: string;
  audience: "everyone" | "adults";
  kind: ("provider" | "app")[];
  permissions: PluginPermissions;
  settings: PluginSetting[];
  values: Record<string, unknown>;
  enabled: boolean;
  kidsAllowed: boolean;
  needsApproval: boolean;
  /** data: URL. */
  icon: string | null;
  error: string | null;
  /** Loaded by `nova dev` from the developer's folder (not installed). */
  dev: boolean;
}

export interface PluginsInfo {
  developerMode: boolean;
  plugins: PluginInfo[];
}

/** A .novapkg before installing it (the permissions screen). */
export interface PackageInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  audience: "everyone" | "adults";
  permissions: PluginPermissions;
  files: number;
  size: number;
  installed: string | null;
  permissionsChanged: boolean;
}

export type PluginStream =
  | { type: "hls"; url: string; proxy: boolean }
  | { type: "twitch"; channel: string }
  | { type: "youtube"; video: string }
  | { type: "youtube"; channel: string };

export type PluginAction =
  | { type: "detail"; title: string | null; text: string; image: string | null }
  | { type: "play"; stream: PluginStream; title: string | null }
  | { type: "tune"; channel: string }
  | { type: "app"; path: string | null };

export interface PluginItem {
  id: string;
  title: string;
  subtitle: string | null;
  image: string | null;
  badge: string | null;
  action: PluginAction;
}

export interface PluginRow {
  title: string;
  style: "landscape" | "poster" | "square";
  items: PluginItem[];
}

export interface PluginRows {
  plugin: string;
  name: string;
  rows: PluginRow[];
}

export interface PluginResults {
  plugin: string;
  name: string;
  items: PluginItem[];
}

/** Where NOVA is (Ajustes → Privacidad y datos), for plugins with `location`. */
export interface Place {
  city: string;
  country: string;
  region?: string | null;
  latitude: number;
  longitude: number;
  /** ISO 3166 ("ES"). */
  countryCode?: string | null;
  /** IANA ("Europe/Madrid"). */
  timezone?: string | null;
  /** Chosen by the user, or detected from the connection. */
  source?: "user" | "auto";
  detectedAt?: number | null;
}

export interface LocationInfo {
  place: Place | null;
  /** Detection from the connection is on. */
  detect: boolean;
}

/** A PC with NovaBridge answering on the home network. */
export interface FoundPc {
  id: string;
  name: string;
  host: string;
  sunshine: boolean;
  paired: boolean;
  /** It is this computer: its games already open here, without Moonlight. */
  thisPc: boolean;
}

/** A paired PC, and whether it answers right now. */
export interface PcInfo {
  id: string;
  name: string;
  host: string;
  /** Moonlight on this box is paired with its Sunshine. */
  moonlight: boolean;
  games: number;
  online: boolean;
  sunshine: boolean;
  sunshineRunning: boolean;
  /** NovaBridge's version there (when it answers). */
  bridgeVersion: string | null;
  /** A newer NOVA Host it can install. */
  bridgeUpdate: string | null;
  /** It is this computer: its games open here directly. */
  thisPc: boolean;
}

export interface PcsInfo {
  /** Moonlight is installed on this box. */
  moonlight: boolean;
  /** The version NOVA installs. */
  moonlightVersion: string;
  pcs: PcInfo[];
}

export interface MoonlightProgress {
  stage: "download" | "unpack" | "done";
  done: number;
  total: number;
}

export interface PluginLogLine {
  at: number;
  level: "info" | "warn" | "error";
  message: string;
}

export interface PowerInfo {
  /** "Windows" | "macOS" | "Linux": for "Salir a …". */
  os: string;
  /** Sleep timer end, Unix seconds. */
  timerUntil: number | null;
}

export type PowerAction = "shutdown" | "restart" | "exit" | "restart-nova" | "display-off";

export interface UpdateInfo {
  version: string;
  /** Release notes (Markdown). */
  notes: string | null;
  /** ISO 8601. */
  date: string | null;
}

export interface UpdateStatus {
  current: string;
  available: UpdateInfo | null;
  /** Unix seconds of the last check that got an answer. */
  checkedAt: number | null;
  error: string | null;
  checking: boolean;
  installing: boolean;
  autoCheck: boolean;
  skipped: string | null;
}

export interface PadInfo {
  id: number;
  name: string;
  battery: number | null;
  charging: boolean;
  wired: boolean;
}
