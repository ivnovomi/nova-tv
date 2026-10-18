export type Screen = "home" | "search" | "settings" | "livetv" | "streaming" | "apps" | "games" | "media" | "system";

export type ShortcutKind = "app" | "game" | "stream";
export type ShortcutSource = "user" | "detected" | "steam" | "builtin" | "store" | "epic" | "gog" | "ubisoft" | "xbox" | "launcher";

export type Target =
  | { type: "executable"; path: string; args: string[] }
  | { type: "steam"; appId: number }
  | { type: "web"; url: string; tv: boolean }
  | { type: "packaged"; aumid: string }
  | { type: "uri"; uri: string };

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
  allowAnime: boolean;
  allowWorld: boolean;
}

export interface ProfilesInfo {
  profiles: Profile[];
  active: string;
  hasPin: boolean;
  /** Settings unlocked from a children's profile, until this Unix time. */
  unlockedUntil: number | null;
}

export type ProfileInput = Pick<Profile, "name" | "avatar" | "color" | "kids" | "allowed" | "allowAnime" | "allowWorld"> & { id?: string };

export interface Channel {
  /** "fast" = Pluto TV (free, with ads). */
  source: "tdt" | "world" | "playlist" | "fast" | "twitch";
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
  fastEnabled: boolean;
  fastError: string | null;
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
