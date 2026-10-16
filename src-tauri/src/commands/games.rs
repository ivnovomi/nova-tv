//! Finds installed games beyond Steam by reading each launcher's own install
//! records (read-only). Every entry is verified against the disk.
//!
//! - Epic Games: `%ProgramData%\Epic\EpicGamesLauncher\Data\Manifests\*.item`
//! - GOG Galaxy: `HKLM\SOFTWARE\WOW6432Node\GOG.com\Games\*`
//! - Ubisoft Connect: `HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs\*`
//! - Xbox / Microsoft Store: packaged apps that ship a `MicrosoftGame.config`

use crate::config::{Shortcut, ShortcutKind, ShortcutSource, Target};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::{env, fs};

/// Launcher URI schemes NOVA may open; anything else is rejected at launch.
const URI_SCHEMES: [&str; 2] = ["com.epicgames.launcher://", "uplay://"];

pub fn valid_uri(uri: &str) -> bool {
    URI_SCHEMES.iter().any(|s| uri.starts_with(s))
        && uri.len() < 512
        && uri.chars().all(|c| c.is_ascii_alphanumeric() || "-_.~:/?=&%".contains(c))
}

/// Percent-encodes a URI component (RFC 3986 unreserved characters kept).
pub fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Install folder of each scanned game, so NOVA can tell when it is running.
static INSTALL_DIRS: Mutex<Option<std::collections::HashMap<String, PathBuf>>> = Mutex::new(None);

fn remember(id: &str, dir: impl Into<PathBuf>) {
    if let Ok(mut map) = INSTALL_DIRS.lock() {
        map.get_or_insert_with(Default::default).insert(id.to_string(), dir.into());
    }
}

/// Where a game found by these scanners is installed (after a scan).
pub fn install_dir(id: &str) -> Option<PathBuf> {
    if INSTALL_DIRS.lock().ok()?.as_ref().is_none_or(|m| !m.contains_key(id)) {
        installed_games(); // populate after a restart
    }
    INSTALL_DIRS.lock().ok()?.as_ref()?.get(id).cloned()
}

fn game(id: String, name: String, description: &str, target: Target, source: ShortcutSource) -> Shortcut {
    Shortcut {
        id,
        name,
        description: Some(description.into()),
        kind: ShortcutKind::Game,
        target,
        source,
    }
}

fn epic() -> Vec<Shortcut> {
    let base = env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    let Ok(entries) = fs::read_dir(base.join(r"Epic\EpicGamesLauncher\Data\Manifests")) else { return vec![] };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("item")))
        .filter_map(|e| {
            let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(e.path()).ok()?).ok()?;
            let s = |k: &str| json.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string();
            let (name, app, namespace, item, install) =
                (s("DisplayName"), s("AppName"), s("CatalogNamespace"), s("CatalogItemId"), s("InstallLocation"));
            let is_game = json
                .get("AppCategories")
                .and_then(|c| c.as_array())
                .is_none_or(|cats| cats.iter().any(|c| c.as_str() == Some("games")));
            if name.is_empty() || app.is_empty() || !is_game || !Path::new(&install).is_dir() {
                return None;
            }
            let id = if namespace.is_empty() || item.is_empty() {
                encode(&app)
            } else {
                format!("{}%3A{}%3A{}", encode(&namespace), encode(&item), encode(&app))
            };
            remember(&format!("epic:{}", encode(&app)), &install);
            Some(game(
                format!("epic:{}", encode(&app)),
                name,
                "Epic Games",
                Target::Uri { uri: format!("com.epicgames.launcher://apps/{id}?action=launch&silent=true") },
                ShortcutSource::Epic,
            ))
        })
        .collect()
}

#[cfg(windows)]
fn gog() -> Vec<Shortcut> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\GOG.com\Games") else {
        return vec![];
    };
    root.enum_keys()
        .flatten()
        .filter_map(|id| {
            let key = root.open_subkey(&id).ok()?;
            let name: String = key.get_value("gameName").ok()?;
            let exe: String = key.get_value("exe").ok()?;
            // DLCs and tools depend on a base game.
            let depends: String = key.get_value("dependsOn").unwrap_or_default();
            if !depends.trim().is_empty() || !Path::new(&exe).is_file() {
                return None;
            }
            Some(game(
                format!("gog:{id}"),
                name,
                "GOG",
                Target::Executable { path: exe, args: vec![] },
                ShortcutSource::Gog,
            ))
        })
        .collect()
}

#[cfg(windows)]
fn ubisoft() -> Vec<Shortcut> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let Ok(root) = RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs") else {
        return vec![];
    };
    root.enum_keys()
        .flatten()
        .filter(|id| id.chars().all(|c| c.is_ascii_digit()))
        .filter_map(|id| {
            let dir: String = root.open_subkey(&id).ok()?.get_value("InstallDir").ok()?;
            let path = Path::new(dir.trim_end_matches(['/', '\\']));
            if !path.is_dir() {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().into_owned();
            remember(&format!("ubisoft:{id}"), path);
            Some(game(
                format!("ubisoft:{id}"),
                name,
                "Ubisoft Connect",
                Target::Uri { uri: format!("uplay://launch/{id}/0") },
                ShortcutSource::Ubisoft,
            ))
        })
        .collect()
}

#[cfg(windows)]
fn xbox() -> Vec<Shortcut> {
    use windows::core::HSTRING;
    use windows::Management::Deployment::PackageManager;
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    fn scan() -> windows::core::Result<Vec<Shortcut>> {
        let mut out = Vec::new();
        for package in PackageManager::new()?.FindPackagesByUserSecurityId(&HSTRING::new())? {
            if package.IsFramework().unwrap_or(true) || package.IsResourcePackage().unwrap_or(true) {
                continue;
            }
            let Ok(location) = package.InstalledPath() else { continue };
            let dir = PathBuf::from(location.to_string());
            if !dir.join("MicrosoftGame.config").is_file() {
                continue;
            }
            let Ok(entries) = package.GetAppListEntries() else { continue };
            if let Some(entry) = entries.into_iter().next() {
                let aumid = entry.AppUserModelId()?.to_string();
                // A launcher package (e.g. "Minecraft Launcher") shows as the game it opens.
                let name = known_by_aumid(&aumid)
                    .map(|k| k.name.to_string())
                    .unwrap_or(entry.DisplayInfo()?.DisplayName()?.to_string());
                remember(&format!("xbox:{aumid}"), &dir);
                out.push(game(
                    format!("xbox:{aumid}"),
                    name,
                    "Xbox / Microsoft Store",
                    Target::Packaged { aumid },
                    ShortcutSource::Xbox,
                ));
            }
        }
        Ok(out)
    }

    std::thread::spawn(|| unsafe {
        let init = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
        let list = scan().unwrap_or_default();
        if init {
            CoUninitialize();
        }
        list
    })
    .join()
    .unwrap_or_default()
}

// ───────────────────────── Games behind their own launcher ─────────────────────────

/// A game that is installed as (or opened through) a launcher.
pub struct Known {
    /// Shortcut id for games found outside the Xbox scan.
    pub id: &'static str,
    pub name: &'static str,
    /// Package family name prefix when it also ships as a Store/Xbox package.
    pub package: Option<&'static str>,
    /// Microsoft Store product id with the game's own artwork and details.
    pub store_product: &'static str,
}

pub const KNOWN: &[Known] = &[
    Known { id: "launcher:minecraft", name: "Minecraft", package: Some("Microsoft.4297127D64EC6_"), store_product: "9NXP44L49SHJ" },
    Known { id: "launcher:roblox", name: "Roblox", package: Some("ROBLOXCORPORATION.ROBLOX_"), store_product: "9NBLGGGZM6WM" },
    Known { id: "riot:league_of_legends", name: "League of Legends", package: None, store_product: "9PB301R051CQ" },
    Known { id: "riot:valorant", name: "VALORANT", package: None, store_product: "9NKCCHCFTHV2" },
];

fn known(id: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.id == id)
}

fn known_by_aumid(aumid: &str) -> Option<&'static Known> {
    KNOWN.iter().find(|k| k.package.is_some_and(|p| aumid.starts_with(p)))
}

/// The Store product with this game's artwork, for launcher games and Xbox packages we know.
pub fn store_product_for(game_id: &str) -> Option<&'static str> {
    known(game_id)
        .or_else(|| game_id.strip_prefix("xbox:").and_then(known_by_aumid))
        .map(|k| k.store_product)
}

fn known_game(id: &str, target: Target, description: &str) -> Option<Shortcut> {
    let k = known(id)?;
    Some(game(k.id.into(), k.name.into(), description, target, ShortcutSource::Launcher))
}

/// Classic Minecraft Launcher (non-Store) install.
fn minecraft_legacy() -> Option<Shortcut> {
    let exe = env::var_os("ProgramFiles(x86)")
        .map(|p| Path::new(&p).join(r"Minecraft Launcher\MinecraftLauncher.exe"))
        .filter(|p| p.is_file())?;
    known_game("launcher:minecraft", Target::Executable { path: exe.to_string_lossy().into_owned(), args: vec![] }, "Minecraft Launcher")
}

/// Roblox installs its player under a versioned folder; use the newest that has it.
fn roblox() -> Option<Shortcut> {
    let versions = env::var_os("LOCALAPPDATA").map(|p| Path::new(&p).join(r"Roblox\Versions"))?;
    let exe = fs::read_dir(versions)
        .ok()?
        .flatten()
        .map(|d| d.path().join("RobloxPlayerBeta.exe"))
        .filter(|p| p.is_file())
        .max_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok())?;
    known_game("launcher:roblox", Target::Executable { path: exe.to_string_lossy().into_owned(), args: vec![] }, "Roblox")
}

/// Riot games open through Riot Client with `--launch-product`.
fn riot() -> Vec<Shortcut> {
    let base = env::var_os("ProgramData").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData")).join("Riot Games");
    let client = fs::read_to_string(base.join("RiotClientInstalls.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .and_then(|j| ["rc_live", "rc_default"].iter().find_map(|k| j.get(*k)?.as_str().map(PathBuf::from)))
        .filter(|p| p.is_file());
    let Some(client) = client else { return vec![] };
    ["league_of_legends", "valorant"]
        .iter()
        .filter_map(|product| {
            let settings = fs::read_to_string(base.join(format!(r"Metadata\{product}.live\{product}.live.product_settings.yaml"))).ok()?;
            // `product_install_full_path: "C:/Riot Games/League of Legends"`
            if let Some(dir) = settings
                .lines()
                .find_map(|l| l.trim().strip_prefix("product_install_full_path:"))
                .map(|v| v.trim().trim_matches('"').replace('/', "\\"))
            {
                remember(&format!("riot:{product}"), dir);
            }
            known_game(
                &format!("riot:{product}"),
                Target::Executable {
                    path: client.to_string_lossy().into_owned(),
                    args: vec![format!("--launch-product={product}"), "--launch-patchline=live".into()],
                },
                "Riot Games",
            )
        })
        .collect()
}

fn launcher_games(already: &[Shortcut]) -> Vec<Shortcut> {
    let has = |name: &str| already.iter().any(|g| g.name == name);
    let mut out = Vec::new();
    // The Store edition of the Minecraft Launcher (found by the Xbox scan) wins over the classic one.
    if !has("Minecraft") {
        out.extend(minecraft_legacy());
    }
    if !has("Roblox") {
        out.extend(roblox());
    }
    out.extend(riot());
    out
}

#[cfg(not(windows))]
fn gog() -> Vec<Shortcut> {
    vec![]
}
#[cfg(not(windows))]
fn ubisoft() -> Vec<Shortcut> {
    vec![]
}
#[cfg(not(windows))]
fn xbox() -> Vec<Shortcut> {
    vec![]
}

static CACHE: Mutex<Option<(Instant, Vec<Shortcut>)>> = Mutex::new(None);
const TTL: Duration = Duration::from_secs(60);

/// Every game found in other launchers (cached for a minute; package scans are slow).
pub fn installed_games() -> Vec<Shortcut> {
    if let Ok(cache) = CACHE.lock() {
        if let Some((at, list)) = cache.as_ref().filter(|(at, _)| at.elapsed() < TTL) {
            let _ = at;
            return list.clone();
        }
    }
    let mut list: Vec<Shortcut> = [epic(), gog(), ubisoft(), xbox()].into_iter().flatten().collect();
    let extra = launcher_games(&list);
    list.extend(extra);
    list.sort_by_key(|g| g.name.to_lowercase());
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), list.clone()));
    }
    list
}

pub fn invalidate() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

pub fn launch_uri(uri: &str) -> Result<(), String> {
    if !valid_uri(uri) {
        return Err("Enlace de lanzador no permitido.".into());
    }
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| format!("No se pudo abrir el lanzador: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uri_whitelist() {
        assert!(valid_uri("uplay://launch/635/0"));
        assert!(valid_uri("com.epicgames.launcher://apps/Fortnite?action=launch&silent=true"));
        assert!(!valid_uri("https://example.com"));
        assert!(!valid_uri("uplay://launch/1/0 & calc"));
    }

    /// Lists what this PC has (read-only).
    #[test]
    #[ignore = "depends on the local machine"]
    fn scan_this_pc() {
        for g in installed_games() {
            println!("{:?} {} -> {:?}", g.source, g.name, g.target);
        }
    }
}
