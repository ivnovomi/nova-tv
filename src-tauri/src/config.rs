//! Local configuration persisted as JSON in the app's config directory.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub const MAX_RECENT: usize = 12;
pub const MAX_RECENT_MEDIA: usize = 20;

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutKind {
    App,
    Game,
    Stream,
}

#[derive(Clone, Copy, Serialize, Deserialize, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutSource {
    /// Added by the user in NOVA TV.
    #[default]
    User,
    /// Found at a well-known install path on this PC.
    Detected,
    /// Read from the local Steam library manifests.
    Steam,
    /// Built-in streaming catalog entry.
    Builtin,
    /// Installed Microsoft Store app.
    Store,
    /// Games found in other launchers' install records.
    Epic,
    Gog,
    Ubisoft,
    Xbox,
    /// A game opened through its own launcher (Minecraft, Roblox, Riot…).
    Launcher,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Target {
    Executable {
        path: String,
        #[serde(default)]
        args: Vec<String>,
    },
    Steam {
        #[serde(rename = "appId")]
        app_id: u32,
    },
    /// HTTPS web app opened full screen in a browser app window.
    Web {
        url: String,
        /// Use the Smart TV browser identity (e.g. YouTube's TV interface).
        #[serde(default)]
        tv: bool,
    },
    /// Microsoft Store (packaged) app, launched by its AppUserModelID.
    Packaged { aumid: String },
    /// A launcher URI built by NOVA from install records (Epic, Ubisoft…).
    Uri { uri: String },
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Shortcut {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    pub kind: ShortcutKind,
    pub target: Target,
    #[serde(default)]
    pub source: ShortcutSource,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaEntry {
    pub path: String,
    pub name: String,
    pub category: String,
    pub opened_at: u64,
}

/// A phone paired as a remote. The token is a 256-bit random secret.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDevice {
    pub id: String,
    pub name: String,
    pub token: String,
    pub paired_at: u64,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConfig {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub devices: Vec<RemoteDevice>,
}

fn default_true() -> bool {
    true
}

impl Default for RemoteConfig {
    fn default() -> Self {
        Self { enabled: true, devices: Vec::new() }
    }
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default)]
    pub shortcuts: Vec<Shortcut>,
    /// Shortcut ids, most recently launched first.
    #[serde(default)]
    pub recent: Vec<String>,
    #[serde(default)]
    pub recent_media: Vec<MediaEntry>,
    #[serde(default)]
    pub remote: RemoteConfig,
    #[serde(default)]
    pub live_tv: LiveTvConfig,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub active_profile: Option<String>,
    #[serde(default)]
    pub parental: ParentalConfig,
    #[serde(default)]
    pub updates: UpdatesConfig,
    #[serde(default)]
    pub plugins: PluginsConfig,
}

/// Ajustes → Plugins: what the user decided about each installed plugin.
/// (The plugins themselves live in their own folders; see plugins/package.rs.)
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginsConfig {
    /// Allows installing packages the store hasn't reviewed (adults only).
    #[serde(default)]
    pub developer_mode: bool,
    #[serde(default)]
    pub installed: std::collections::BTreeMap<String, PluginState>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PluginState {
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// The permissions the user approved (the manifest's, at install). If the
    /// installed manifest asks for anything else, the plugin doesn't run.
    #[serde(default)]
    pub granted: serde_json::Value,
    /// Children's profiles see it (only for plugins for everyone).
    #[serde(default)]
    pub kids_allowed: bool,
    /// Its options, as chosen in Ajustes → Plugins.
    #[serde(default)]
    pub settings: serde_json::Map<String, serde_json::Value>,
}

/// Ajustes → Actualizaciones. NOVA looks for new versions by itself unless
/// turned off, but never installs one without being asked.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdatesConfig {
    #[serde(default)]
    pub auto_check_off: bool,
    /// "Omitir esta versión": not announced again (a newer one will be).
    #[serde(default)]
    pub skipped: Option<String>,
}

/// Someone who watches NOVA: their favourites, last channel and, for children,
/// what they're allowed to see.
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    /// One emoji (or a letter).
    pub avatar: String,
    /// Avatar background, "#rrggbb".
    pub color: String,
    /// Children's profile: parental controls apply.
    #[serde(default)]
    pub kids: bool,
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub last_channel: Option<String>,
    /// Kids: apps, games and services they may open (shortcut ids).
    #[serde(default)]
    pub allowed: Vec<String>,
    /// Kids: Pluto TV's anime channels (Dragon Ball, One Piece…).
    #[serde(default = "default_true")]
    pub allow_anime: bool,
    /// Kids: worldwide "kids" channels from iptv-org (not reviewed by anyone).
    #[serde(default)]
    pub allow_world: bool,
}

/// The parental PIN, stored only as a salted, stretched SHA-256.
#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ParentalConfig {
    #[serde(default)]
    pub pin_hash: Option<String>,
    #[serde(default)]
    pub pin_salt: Option<String>,
    /// Wrong PINs since the last lockout (kept across restarts).
    #[serde(default)]
    pub fail_count: u32,
    /// Lockouts in a row: each one doubles the wait.
    #[serde(default)]
    pub lockouts: u32,
    /// Locked until this Unix time.
    #[serde(default)]
    pub locked_until: u64,
}

/// A user's own IPTV playlist (M3U).
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Playlist {
    pub id: String,
    pub name: String,
    pub url: String,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LiveTvConfig {
    #[serde(default)]
    pub favorites: Vec<String>,
    #[serde(default)]
    pub last_channel: Option<String>,
    #[serde(default)]
    pub playlists: Vec<Playlist>,
    /// The worldwide iptv-org catalogue is on unless the user turns it off.
    #[serde(default)]
    pub world_disabled: bool,
    /// Pluto TV is on unless the user turns it off.
    #[serde(default)]
    pub fast_disabled: bool,
    /// Twitch live streams (as TV channels) are on unless the user turns them off.
    #[serde(default)]
    pub twitch_disabled: bool,
}

pub struct ConfigStore {
    path: PathBuf,
    pub data: Mutex<Config>,
}

impl ConfigStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("config.json");
        let data = match fs::read_to_string(&path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|err| {
                // Keep the unreadable file instead of silently overwriting the user's data.
                eprintln!("NOVA TV: config.json is invalid ({err}); backing it up and starting fresh");
                let _ = fs::rename(&path, dir.join("config.invalid.json"));
                Config::default()
            }),
            Err(_) => Config::default(),
        };
        Self { path, data: Mutex::new(data) }
    }

    /// Writes atomically (temp file + rename) so a crash never leaves a half-written config.
    pub fn save(&self, config: &Config) -> Result<(), String> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("No se pudo crear la carpeta de configuración: {e}"))?;
        }
        let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, json).map_err(|e| format!("No se pudo guardar la configuración: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("No se pudo guardar la configuración: {e}"))
    }

    /// Mutates the config under the lock and persists it.
    pub fn update<T>(&self, f: impl FnOnce(&mut Config) -> Result<T, String>) -> Result<T, String> {
        let mut guard = self.data.lock().map_err(|_| "Configuración bloqueada".to_string())?;
        let mut next = guard.clone();
        let value = f(&mut next)?;
        self.save(&next)?;
        *guard = next;
        Ok(value)
    }

    pub fn snapshot(&self) -> Config {
        self.data.lock().map(|c| c.clone()).unwrap_or_default()
    }
}

/// Reads a JSON data file. An unreadable one is kept as `<name>.json.bak`
/// instead of being silently replaced by the next save.
pub fn load_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    let Ok(text) = fs::read_to_string(path) else { return T::default() };
    serde_json::from_str(&text).unwrap_or_else(|err| {
        eprintln!("NOVA TV: {} is invalid ({err}); keeping it as .bak", path.display());
        let _ = fs::rename(path, path.with_extension("json.bak"));
        T::default()
    })
}

/// Writes a data file atomically (temp + rename). Callers hold their store's
/// write lock across this call, so two writers never share the temp file.
pub fn write_atomic(path: &Path, contents: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)
}

pub fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn new_id(prefix: &str) -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("{prefix}-{nanos:x}")
}
