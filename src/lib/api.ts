import { invoke, isTauri } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  Library,
  MediaEntry,
  RecentMedia,
  RemoteInfo,
  WatchEntry,
  PadInfo,
  ProfileInput,
  ProfilesInfo,
  TwitchLive,
  SourceProbe,
  SourceStatus,
  GameMeta,
  FeedItem,
  NowPlaying,
  PlayStats,
  YtResult,
  FileHit,
  LiveTvData,
  Program,
  HealthEntry,
  HealthProgress,
  SettingsPage,
  Shortcut,
  ShortcutKind,
  SystemInfo,
  SystemStats,
  PackageInfo,
  LocationInfo,
  NetStatus,
  WifiNetwork,
  FoundPc,
  PcsInfo,
  PluginAccountUser,
  PluginLogLine,
  PluginSignIn,
  PluginSignInPoll,
  Place,
  PluginResults,
  PluginRows,
  PluginsInfo,
  PowerAction,
  PowerInfo,
  StoreInfo,
  UpdateStatus,
  VolumeState,
} from "./types";

export const inTauri = isTauri();

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!inTauri) throw new Error("NOVA TV necesita ejecutarse como aplicación de escritorio (npm run tauri dev).");
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    throw new Error(typeof err === "string" ? err : err instanceof Error ? err.message : "Error desconocido");
  }
}

export const api = {
  listLibrary: () => call<Library>("list_library"),
  addExecutable: (input: { name: string; description?: string; kind: ShortcutKind; path: string; args: string[] }) =>
    call<Shortcut>("add_executable", { input }),
  addSteamGame: (name: string, appId: number) => call<Shortcut>("add_steam_game", { name, appId }),
  addWebApp: (name: string, url: string) => call<Shortcut>("add_web_app", { name, url }),
  removeShortcut: (id: string) => call<void>("remove_shortcut", { id }),
  launch: (id: string) => call<string>("launch_shortcut", { id }),

  openMedia: (path: string) => call<MediaEntry>("open_media", { path }),
  recentMedia: () => call<RecentMedia[]>("list_recent_media"),
  forgetMedia: (path: string) => call<void>("forget_media", { path }),
  mediaExtensions: () => call<string[]>("media_extensions"),

  systemInfo: () => call<SystemInfo>("get_system_info"),
  systemStats: () => call<SystemStats>("get_system_stats"),
  openSettings: (page: SettingsPage) => call<void>("open_windows_settings", { page }),
  getVolume: () => call<VolumeState>("get_volume"),
  setVolume: (level: number) => call<VolumeState>("set_volume", { level }),
  setMute: (muted: boolean) => call<VolumeState>("set_mute", { muted }),

  remoteInfo: () => call<RemoteInfo>("remote_info"),
  remoteSetEnabled: (enabled: boolean) => call<void>("remote_set_enabled", { enabled }),
  remoteRevoke: (id: string) => call<void>("remote_revoke", { id }),
  remoteNewPin: () => call<void>("remote_new_pin"),
  remotePublish: (state: unknown) => call<void>("remote_publish", { state }),

  historyList: () => call<WatchEntry[]>("history_list"),
  historyRemove: (key: string) => call<void>("history_remove", { key }),
  historyClear: () => call<void>("history_clear"),
  youtubeFeed: () => call<FeedItem[]>("youtube_feed"),
  listGamepads: () => call<PadInfo[]>("list_gamepads"),
  gameMetadata: () => call<Record<string, GameMeta>>("game_metadata"),
  rescanGames: () => call<number>("rescan_games"),
  playtime: () => call<Record<string, PlayStats>>("playtime"),
  nowPlaying: () => call<NowPlaying | null>("now_playing"),
  mediaControl: (action: "playpause" | "next" | "prev") => call<void>("media_control", { action }),
  searchFiles: (query: string) => call<FileHit[]>("search_files", { query }),
  youtubeSearch: (query: string) => call<YtResult[]>("youtube_search", { query }),
  livetvChannels: () => call<LiveTvData>("livetv_channels"),
  livetvEpg: () => call<Record<string, Program[]>>("livetv_epg"),
  livetvSetFavorite: (id: string, favorite: boolean) => call<void>("livetv_set_favorite", { id, favorite }),
  livetvSetLast: (id: string) => call<void>("livetv_set_last", { id }),
  livetvAddPlaylist: (name: string, url: string) => call<number>("livetv_add_playlist", { name, url }),
  livetvRemovePlaylist: (id: string) => call<void>("livetv_remove_playlist", { id }),
  livetvSetWorld: (enabled: boolean) => call<void>("livetv_set_world", { enabled }),
  livetvSetTwitch: (enabled: boolean) => call<void>("livetv_set_twitch", { enabled }),
  livetvCheckNow: () => call<void>("livetv_check_now"),
  livetvHealth: () => call<{ map: Record<string, HealthEntry>; progress: HealthProgress }>("livetv_health"),
  livetvReport: (id: string, ok: boolean, blocked: boolean, stream: number) => call<void>("livetv_report", { id, ok, blocked, stream }),
  playYoutube: (videoId: string, position?: number) => call<void>("play_youtube", { videoId, position }),
  sourcesStatus: () => call<SourceStatus[]>("sources_status"),
  sourcesProbe: () => call<SourceProbe[]>("sources_probe"),
  twitchLive: () => call<TwitchLive[]>("twitch_live"),
  twitchPlay: (login: string, name: string) => call<void>("twitch_play", { login, name }),

  pluginsList: () => call<PluginsInfo>("plugins_list"),
  pluginsRows: () => call<PluginRows[]>("plugins_rows"),
  pluginsSetDeveloper: (enabled: boolean) => call<void>("plugins_set_developer", { enabled }),
  /** What a .novapkg is and asks for, before installing it. */
  pluginsInspect: (path: string) => call<PackageInfo>("plugins_inspect", { path }),
  pluginsInstall: (path: string) => call<void>("plugins_install", { path }),
  pluginsUninstall: (id: string, deleteData: boolean) => call<void>("plugins_uninstall", { id, deleteData }),
  pluginsSetEnabled: (id: string, enabled: boolean) => call<void>("plugins_set_enabled", { id, enabled }),
  pluginsSetKids: (id: string, allowed: boolean) => call<void>("plugins_set_kids", { id, allowed }),
  pluginsSetSetting: (id: string, key: string, value: unknown) => call<void>("plugins_set_setting", { id, key, value }),
  pluginsRollback: (id: string) => call<void>("plugins_rollback", { id }),
  pluginsLog: (id: string) => call<PluginLogLine[]>("plugins_log", { id }),
  /** The plugin store's catalogue (the saved one if recent, unless `refresh`) and what's installed. */
  storeCatalog: (refresh: boolean) => call<StoreInfo>("store_catalog", { refresh }),
  /** Downloads, verifies and installs a plugin from the store (progress: "store-progress"). */
  storeInstall: (id: string) => call<void>("store_install", { id }),
  /** Who is signed in with the plugin, for the profile watching (null: nobody). */
  pluginsAccount: (id: string) => call<PluginAccountUser | null>("plugins_account", { id }),
  /** Starts signing in: the code to show. Then poll every `interval` seconds. */
  pluginsAccountStart: (id: string) => call<PluginSignIn>("plugins_account_start", { id }),
  pluginsAccountPoll: (id: string) => call<PluginSignInPoll>("plugins_account_poll", { id }),
  pluginsAccountSignOut: (id: string) => call<void>("plugins_account_sign_out", { id }),
  /** Results from plugins with `search` (whatever answers within 5 s). */
  pluginsSearch: (query: string) => call<PluginResults[]>("plugins_search", { query }),
  /** Background images from plugins with `screensaver`. */
  pluginsScreensaver: () => call<string[]>("plugins_screensaver"),
  // First-run assistant.
  setupNeeded: () => call<boolean>("setup_needed"),
  setupFinish: () => call<void>("setup_finish"),
  setupRestart: () => call<void>("setup_restart"),
  netStatus: () => call<NetStatus>("net_status"),
  /** Scans (a few seconds). */
  wifiNetworks: () => call<WifiNetwork[]>("wifi_networks"),
  /** Joins it and waits (up to ~25 s); no password for saved or open networks. */
  wifiConnect: (ssid: string, password?: string) => call<void>("wifi_connect", { ssid, password: password ?? null }),
  locationSearch: (query: string) => call<Place[]>("location_search", { query }),
  locationGet: () => call<LocationInfo>("location_get"),
  locationSet: (place: Place | null) => call<void>("location_set", { place }),
  /** The connection's approximate place, saved (replaces a chosen city). */
  locationDetect: () => call<Place>("location_detect"),
  /** Detection from the connection on/off (off forgets a detected place). */
  locationSetDetect: (enabled: boolean) => call<void>("location_set_detect", { enabled }),
  // Games from a PC of the house (NovaBridge + Moonlight).
  pcList: () => call<PcsInfo>("pc_list"),
  pcDiscover: () => call<FoundPc[]>("pc_discover"),
  /** Waits until the user answers on the PC (up to 90 s). Returns the PC's id. */
  pcPair: (host: string) => call<string>("pc_pair", { host }),
  /** Waits until the PIN is typed into Sunshine on the PC. */
  pcLinkMoonlight: (id: string, pin: string) => call<void>("pc_link_moonlight", { id, pin }),
  pcForget: (id: string) => call<void>("pc_forget", { id }),
  /** NovaBridge on that PC installs its newer NOVA Host (Windows asks there). Returns the version. */
  pcUpdateBridge: (id: string) => call<string>("pc_update_bridge", { id }),
  /** Portable Moonlight in NOVA's folder; progress in "moonlight-install" events. */
  pcInstallMoonlight: () => call<void>("pc_install_moonlight"),
  /** NOVA ids of the PC games played with the controller as keyboard and mouse. */
  pcKeyboardGames: () => call<string[]>("pc_keyboard_games"),
  pcGameKeyboard: (id: string, on: boolean) => call<void>("pc_game_keyboard", { id, on }),
  /** A plugin channel's stream, right before playing (`retry` asks for a fresh one). */
  pluginsStream: (stream: string, retry: boolean) => call<{ stream: string; proxy: boolean; plugin: string }>("plugins_stream", { stream, retry }),
  /** A proxied playlist of a plugin stream (only its domains, with its headers). */
  pluginsPlaylist: (plugin: string, url: string) => call<string>("plugins_playlist", { plugin, url }),

  /** Start-up window: one step ("profiles" | "channels" | "library"), then open NOVA. */
  splashStep: (step: string) => call<string>("splash_step", { step }),
  splashDone: () => call<void>("splash_done"),

  powerInfo: () => call<PowerInfo>("power_info"),
  powerAction: (action: PowerAction) => call<void>("power_action", { action }),
  /** Sleep timer in minutes (1–240), or null to cancel. */
  powerTimer: (minutes: number | null) => call<PowerInfo>("power_timer", { minutes }),

  updatesStatus: () => call<UpdateStatus>("updates_status"),
  updatesCheck: () => call<UpdateStatus>("updates_check"),
  updatesSetAuto: (enabled: boolean) => call<UpdateStatus>("updates_set_auto", { enabled }),
  updatesSkip: (version: string | null) => call<UpdateStatus>("updates_skip", { version }),
  /** Downloads, verifies and runs the installer (NOVA closes and reopens updated). */
  updatesInstall: () => call<void>("updates_install"),

  profilesGet: () => call<ProfilesInfo>("profiles_get"),
  profileSave: (input: ProfileInput) => call<ProfilesInfo>("profile_save", { input }),
  profileDelete: (id: string) => call<ProfilesInfo>("profile_delete", { id }),
  profileSwitch: (id: string, pin?: string) => call<ProfilesInfo>("profile_switch", { id, pin }),
  parentalSetPin: (pin: string, current?: string) => call<ProfilesInfo>("parental_set_pin", { pin, current }),
  parentalRemovePin: (current: string) => call<ProfilesInfo>("parental_remove_pin", { current }),
  parentalUnlock: (pin: string) => call<ProfilesInfo>("parental_unlock", { pin }),
  parentalLock: () => call<ProfilesInfo>("parental_lock"),
  /** Everything that can be opened (for a children's profile allow-list). */
  parentalCatalog: () => call<Shortcut[]>("parental_catalog"),
};

export async function pickExecutable(): Promise<string | null> {
  if (!inTauri) return null;
  const picked = await open({ multiple: false, directory: false, filters: [{ name: "Programas", extensions: ["exe"] }] });
  return typeof picked === "string" ? picked : null;
}

export async function pickPluginPackage(): Promise<string | null> {
  if (!inTauri) return null;
  const picked = await open({ multiple: false, directory: false, filters: [{ name: "Plugin de NOVA", extensions: ["novapkg"] }] });
  return typeof picked === "string" ? picked : null;
}

export async function pickMediaFile(extensions: string[]): Promise<string | null> {
  if (!inTauri) return null;
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Multimedia", extensions }],
  });
  return typeof picked === "string" ? picked : null;
}

/** Splits an argument line into structured args, honouring double quotes. Never passed to a shell. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let has = false;
  for (const ch of line) {
    if (ch === '"') {
      quoted = !quoted;
      has = true;
    } else if (/\s/.test(ch) && !quoted) {
      if (has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (has) out.push(cur);
  return out;
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / 1024 ** 2).toFixed(0)} MB`;
}

export function fileNameFromPath(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** "12 min restantes", "1 h 5 min restantes" */
export function remaining(position: number, duration: number): string {
  const left = Math.max(0, Math.round((duration - position) / 60));
  if (left < 1) return "Casi terminado";
  return left >= 60 ? `${Math.floor(left / 60)} h ${left % 60} min restantes` : `${left} min restantes`;
}

const rtf = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
/** Relative time from a unix-seconds timestamp or an ISO date. */
export function timeAgo(when: number | string): string {
  const ms = typeof when === "number" ? when * 1000 : Date.parse(when);
  if (!Number.isFinite(ms)) return "";
  const s = Math.round((ms - Date.now()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, secs] of steps) if (Math.abs(s) >= secs) return rtf.format(Math.round(s / secs), unit);
  return "ahora mismo";
}
