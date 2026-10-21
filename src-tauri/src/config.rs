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
    /// A game on another PC of the house, played over Moonlight (NovaBridge).
    Pc,
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
    /// A game on a paired PC (NovaBridge id + the game's id on that PC).
    Pc { pc: String, game: String },
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
    /// Where NOVA is (Ajustes → Privacidad y datos): chosen by the user, or
    /// detected from the connection. For plugins with `location`.
    #[serde(default)]
    pub location: Option<Place>,
    /// The user turned off detecting the approximate location from the
    /// connection (it's on while they haven't chosen a city).
    #[serde(default)]
    pub location_detect_disabled: bool,
    /// PCs of the house paired through NovaBridge, to play their games here.
    #[serde(default)]
    pub pcs: Vec<PairedPc>,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PairedPc {
    /// NovaBridge's own id (stable across IP changes).
    pub id: String,
    pub name: String,
    /// Last address it answered from.
    pub host: String,
    /// Network cards, to wake it up (Wake-on-LAN).
    #[serde(default)]
    pub macs: Vec<String>,
    /// Token NovaBridge gave NOVA when the user accepted it on the PC.
    pub token: String,
    /// Moonlight on this box is paired with the PC's Sunshine.
    #[serde(default)]
    pub moonlight: bool,
    /// Its games, kept so they show (and wake the PC) while it sleeps.
    #[serde(default)]
    pub games: Vec<PcGame>,
    /// Games (ids on the PC) played with the controller as keyboard and mouse.
    #[serde(default)]
    pub keyboard: Vec<String>,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PcGame {
    /// The game's id on the PC (`steam:730`, `epic:…`).
    pub id: String,
    pub name: String,
    /// Where it comes from on the PC ("Steam", "Epic Games"…).
    #[serde(default)]
    pub store: String,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub city: String,
    /// "España"…
    pub country: String,
    /// Region or province, to tell places with the same name apart.
    #[serde(default)]
    pub region: Option<String>,
    pub latitude: f64,
    pub longitude: f64,
    /// ISO 3166 ("ES").
    #[serde(default)]
    pub country_code: Option<String>,
    /// IANA ("Europe/Madrid").
    #[serde(default)]
    pub timezone: Option<String>,
    /// Chosen by the user, or detected from the connection.
    #[serde(default)]
    pub source: PlaceSource,
    /// When it was detected (Unix seconds), for detected places.
    #[serde(default)]
    pub detected_at: Option<u64>,
}

#[derive(Clone, Copy, Serialize, Deserialize, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PlaceSource {
    #[default]
    User,
    Auto,
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
    /// Its block of live TV numbers (see plugins/tv.rs), once it has channels.
    #[serde(default)]
    pub channel_block: Option<u32>,
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
    /// Twitch live streams (as TV channels) are on unless the user turns them off.
    #[serde(default)]
    pub twitch_disabled: bool,
}

pub struct ConfigStore {
    path: PathBuf,
    pub data: Mutex<Config>,
}

/// Who to tell when the config can't be saved (NOVA's interface, once it's up).
type Report = Box<dyn Fn(&str) + Send + Sync>;
static SAVE_ERROR: std::sync::OnceLock<Report> = std::sync::OnceLock::new();

pub fn on_save_error(report: impl Fn(&str) + Send + Sync + 'static) {
    let _ = SAVE_ERROR.set(Box::new(report));
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
    /// If Windows won't let the old file be replaced, it's overwritten in place.
    /// Any failure is told to the user (see `on_save_error`): settings that
    /// silently stop being saved are lost at the next restart.
    pub fn save(&self, config: &Config) -> Result<(), String> {
        let result = self.write(config);
        if let Err(e) = &result {
            eprintln!("NOVA TV: {e}");
            if let Some(report) = SAVE_ERROR.get() {
                report(e);
            }
        }
        result
    }

    fn write(&self, config: &Config) -> Result<(), String> {
        let fail = |what: &str, e: std::io::Error| format!("No se pudo guardar la configuración ({what} {}): {e}", self.path.display());
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent).map_err(|e| fail("creando la carpeta de", e))?;
        }
        let json = serde_json::to_string_pretty(config).map_err(|e| format!("No se pudo guardar la configuración: {e}"))?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, &json).map_err(|e| fail("escribiendo junto a", e))?;
        match fs::rename(&tmp, &self.path) {
            Ok(()) => Ok(()),
            Err(rename) => {
                // Not atomic (a crash in this very moment could cut the file), but far
                // better than settings that are never saved.
                let _ = fs::remove_file(&tmp);
                fs::write(&self.path, &json).map_err(|e| fail(&format!("reemplazando ({rename}) y sobrescribiendo"), e))
            }
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// A config like a real one (profiles, plugins, settings, location) is saved and read back.
    #[test]
    fn a_full_config_saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("nova-config-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let store = ConfigStore::load(&dir);
        let result = store.update(|c| {
            c.live_tv.favorites.push("tdt:la1".into());
            c.plugins.developer_mode = true;
            c.plugins.installed.insert(
                "es.novatv.pluto-tv".into(),
                PluginState { enabled: true, granted: serde_json::json!({ "network": ["*.pluto.tv"], "channels": true }), kids_allowed: false, settings: Default::default(), channel_block: Some(0) },
            );
            Ok(())
        });
        assert!(result.is_ok(), "{result:?}");
        let again = ConfigStore::load(&dir).snapshot();
        assert!(again.plugins.installed.contains_key("es.novatv.pluto-tv"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The real config.json of this computer (if there is one) can be saved.
    #[test]
    #[ignore = "reads this computer's NOVA config"]
    fn this_computers_config_saves() {
        let dir = std::path::PathBuf::from(std::env::var("APPDATA").unwrap()).join("com.ivnov.novatv");
        let store = ConfigStore::load(&dir);
        let config = store.snapshot();
        println!("{}", serde_json::to_string(&config).map(|t| format!("OK, {} bytes", t.len())).unwrap_or_else(|e| format!("ERROR {e}")));
        println!("perfiles {} · plugins {} · activo {:?}", config.profiles.len(), config.plugins.installed.len(), config.active_profile);
        if std::env::var("NOVA_SAVE_TEST").is_ok() {
            println!("guardar: {:?}", store.update(|_| Ok(())));
        }
    }
}
