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
const URI_SCHEMES: [&str; 4] = ["com.epicgames.launcher://", "uplay://", "modrinth://launch/instance/", "curseforge://launch-game?"];

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
    let group = group_for(&id);
    Shortcut {
        id,
        name,
        description: Some(description.into()),
        kind: ShortcutKind::Game,
        target,
        source,
        group,
    }
}

/// Minecraft's launcher (classic or Store) and every modpack are one game.
pub fn group_for(game_id: &str) -> Option<String> {
    let minecraft = is_modpack(game_id)
        || game_id == "launcher:minecraft"
        || game_id.strip_prefix("xbox:").and_then(known_by_aumid).is_some_and(|k| k.id == "launcher:minecraft");
    minecraft.then(|| "minecraft".to_string())
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

/// The Store product with this game's artwork, for launcher games and Xbox packages we know
/// (also a PC's game, by its id there; Minecraft modpacks show as Minecraft).
pub fn store_product_for(game_id: &str) -> Option<&'static str> {
    let game_id = game_id.strip_prefix("pc:").and_then(|rest| rest.split_once(':')).map(|(_, inner)| inner).unwrap_or(game_id);
    if is_modpack(game_id) {
        return known("launcher:minecraft").map(|k| k.store_product);
    }
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

// ───────────────────────── Minecraft modpacks ─────────────────────────
//
// Each modpack is its own game: its launcher opens that instance straight
// away (the same links their "desktop shortcut" option makes), no clicking
// "Play" with a mouse.

/// Minecraft's id at CurseForge (`gameId` in its links).
const CURSEFORGE_MINECRAFT: u32 = 432;

/// Modrinth App profiles: `%APPDATA%\ModrinthApp\profiles\<name>`, opened with
/// `modrinth://launch/instance/<name>` (Modrinth App 0.15+).
fn modrinth() -> Vec<Shortcut> {
    let Some(root) = env::var_os("APPDATA").map(|p| Path::new(&p).join(r"ModrinthApp\profiles")) else { return vec![] };
    let Ok(entries) = fs::read_dir(&root) else { return vec![] };
    entries
        .flatten()
        .filter(|e| e.path().join("mods").is_dir() || e.path().join("saves").is_dir())
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let id = format!("modrinth:{}", encode(&name));
            remember(&id, e.path());
            game(id, name.clone(), "Minecraft · Modrinth", Target::Uri { uri: format!("modrinth://launch/instance/{}", encode(&name)) }, ShortcutSource::Launcher)
        })
        .collect()
}

/// CurseForge instances (`~\curseforge\minecraft\Instances\*\minecraftinstance.json`),
/// opened with `curseforge://launch-game?instanceId=<guid>&gameId=432`.
fn curseforge() -> Vec<Shortcut> {
    let Some(root) = env::var_os("USERPROFILE").map(|p| Path::new(&p).join(r"curseforge\minecraft\Instances")) else { return vec![] };
    let Ok(entries) = fs::read_dir(&root) else { return vec![] };
    entries
        .flatten()
        .filter_map(|e| {
            let json: serde_json::Value = serde_json::from_str(&fs::read_to_string(e.path().join("minecraftinstance.json")).ok()?).ok()?;
            let guid = json.get("guid")?.as_str()?.to_string();
            // A guid is hex and dashes: nothing else may go into the link.
            if guid.is_empty() || !guid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
                return None;
            }
            let name = json.get("name").and_then(|n| n.as_str()).map(String::from).unwrap_or_else(|| e.file_name().to_string_lossy().into_owned());
            let version = json.get("gameVersion").and_then(|v| v.as_str()).unwrap_or_default();
            let id = format!("curseforge:{guid}");
            remember(&id, e.path());
            Some(game(
                id,
                name,
                &if version.is_empty() { "Minecraft · CurseForge".to_string() } else { format!("Minecraft {version} · CurseForge") },
                Target::Uri { uri: format!("curseforge://launch-game?instanceId={guid}&gameId={CURSEFORGE_MINECRAFT}") },
                ShortcutSource::Launcher,
            ))
        })
        .collect()
}

/// A Minecraft modpack (its art is Minecraft's).
pub fn is_modpack(game_id: &str) -> bool {
    game_id.starts_with("modrinth:") || game_id.starts_with("curseforge:")
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
    out.extend(modrinth());
    out.extend(curseforge());
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
    // Modrinth App and CurseForge only act on a link once their window is up:
    // a link that starts them gets lost. Start them first, then send it.
    #[cfg(windows)]
    if let Some(app) = cold_handler(uri) {
        let uri = uri.to_string();
        std::process::Command::new(&app).spawn().map_err(|e| format!("No se pudo abrir el lanzador: {e}"))?;
        std::thread::spawn(move || {
            wait_until_ready(&app);
            let _ = tauri_plugin_opener::open_url(&uri, None::<&str>);
        });
        return Ok(());
    }
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| format!("No se pudo abrir el lanzador: {e}"))
}

/// Seconds a launcher app needs after its process appears before it handles links.
#[cfg(windows)]
const LAUNCHER_WARMUP: Duration = Duration::from_secs(10);

/// The app behind a `modrinth://` / `curseforge://` link, when it isn't running yet.
#[cfg(windows)]
fn cold_handler(uri: &str) -> Option<PathBuf> {
    use winreg::{enums::HKEY_CLASSES_ROOT, RegKey};
    let scheme = ["modrinth", "curseforge"].into_iter().find(|s| uri.starts_with(&format!("{s}://")))?;
    // `"C:\...\Modrinth App.exe" "%1"`
    let command: String = RegKey::predef(HKEY_CLASSES_ROOT).open_subkey(format!(r"{scheme}\shell\open\command")).ok()?.get_value("").ok()?;
    let exe = PathBuf::from(command.trim_start().strip_prefix('"')?.split('"').next()?);
    if !exe.is_file() || process_running(&exe) {
        return None;
    }
    Some(exe)
}

#[cfg(windows)]
fn process_running(exe: &Path) -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
    sys.processes().values().any(|p| p.exe().is_some_and(|e| e.as_os_str().eq_ignore_ascii_case(exe.as_os_str())))
}

/// Waits for the launcher's process (up to 30 s), then for its window to load.
#[cfg(windows)]
fn wait_until_ready(exe: &Path) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !process_running(exe) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(500));
    }
    std::thread::sleep(LAUNCHER_WARMUP);
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
        assert!(valid_uri("modrinth://launch/instance/Fallout%20Craft%20-%20Alpha"));
        assert!(valid_uri("curseforge://launch-game?instanceId=931baf2e-3302-413a-ade4-3f2bb3dae8ca&gameId=432"));
        assert!(!valid_uri("modrinth://install/x"));
        assert!(!valid_uri("curseforge://install?addonId=1"));
    }

    #[test]
    fn minecraft_and_its_modpacks_are_one_game() {
        assert_eq!(group_for("launcher:minecraft").as_deref(), Some("minecraft"));
        assert_eq!(group_for("modrinth:Fallout%20Craft").as_deref(), Some("minecraft"));
        assert_eq!(group_for("curseforge:931baf2e").as_deref(), Some("minecraft"));
        assert_eq!(group_for("xbox:Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft").as_deref(), Some("minecraft"));
        assert_eq!(group_for("steam:730"), None);
    }

    #[test]
    fn modpacks_look_like_minecraft() {
        assert!(is_modpack("curseforge:931baf2e"));
        assert_eq!(store_product_for("modrinth:Fallout%20Craft"), store_product_for("launcher:minecraft"));
        assert_eq!(store_product_for("pc:ab12:curseforge:931baf2e"), store_product_for("launcher:minecraft"));
        assert_eq!(store_product_for("pc:ab12:riot:valorant"), store_product_for("riot:valorant"));
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
