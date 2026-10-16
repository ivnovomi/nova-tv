//! Read-only discovery of locally installed Steam games from library manifests.

use crate::config::{Shortcut, ShortcutKind, ShortcutSource, Target};
use std::{env, fs, path::{Path, PathBuf}};

pub fn steam_root() -> Option<PathBuf> {
    ["ProgramFiles(x86)", "ProgramFiles"]
        .iter()
        .filter_map(|v| env::var_os(v))
        .map(|base| Path::new(&base).join("Steam"))
        .find(|p| p.join("steam.exe").is_file())
}

/// Extracts `"key"  "value"` pairs from a Valve KeyValues line.
fn kv(line: &str) -> Option<(&str, String)> {
    let mut parts = line.trim().split('"').filter(|s| !s.trim().is_empty());
    let key = parts.next()?;
    let value = parts.next()?;
    Some((key, value.replace("\\\\", "\\")))
}

fn library_dirs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    if let Ok(text) = fs::read_to_string(root.join(r"steamapps\libraryfolders.vdf")) {
        for (key, value) in text.lines().filter_map(kv) {
            if key == "path" {
                let p = PathBuf::from(value);
                if !dirs.iter().any(|d| d.as_os_str().eq_ignore_ascii_case(p.as_os_str())) {
                    dirs.push(p);
                }
            }
        }
    }
    dirs
}

/// `steamapps\common\<installdir>` of an installed Steam game.
pub fn install_dir(app_id: u32) -> Option<PathBuf> {
    let root = steam_root()?;
    library_dirs(&root).into_iter().find_map(|lib| {
        let steamapps = lib.join("steamapps");
        let text = fs::read_to_string(steamapps.join(format!("appmanifest_{app_id}.acf"))).ok()?;
        let dir = text.lines().filter_map(kv).find(|(k, _)| *k == "installdir").map(|(_, v)| v)?;
        Some(steamapps.join("common").join(dir)).filter(|p| p.is_dir())
    })
}

fn is_tool(name: &str, app_id: u32) -> bool {
    const TOOL_IDS: [u32; 4] = [228980, 1070560, 1391110, 1628350];
    TOOL_IDS.contains(&app_id)
        || ["Redistributable", "Steam Linux Runtime", "Proton", "Steamworks"].iter().any(|t| name.contains(t))
}

pub fn installed_games() -> Vec<Shortcut> {
    let Some(root) = steam_root() else { return vec![] };
    let mut games = Vec::new();
    for lib in library_dirs(&root) {
        let Ok(entries) = fs::read_dir(lib.join("steamapps")) else { continue };
        for entry in entries.flatten() {
            let file_name = entry.file_name().to_string_lossy().into_owned();
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            let (mut app_id, mut name) = (None, None);
            for (key, value) in text.lines().filter_map(kv) {
                match key {
                    "appid" if app_id.is_none() => app_id = value.parse::<u32>().ok(),
                    "name" if name.is_none() => name = Some(value),
                    _ => {}
                }
            }
            if let (Some(app_id), Some(name)) = (app_id, name) {
                if !is_tool(&name, app_id) && !games.iter().any(|g: &Shortcut| g.id == format!("steam:{app_id}")) {
                    games.push(Shortcut {
                        id: format!("steam:{app_id}"),
                        name,
                        description: Some("Instalado en Steam".into()),
                        kind: ShortcutKind::Game,
                        target: Target::Steam { app_id },
                        source: ShortcutSource::Steam,
                    });
                }
            }
        }
    }
    games.sort_by_key(|g| g.name.to_lowercase());
    games
}

pub fn launch(app_id: u32) -> Result<(), String> {
    if steam_root().is_none() {
        return Err("Steam no está instalado en la ruta estándar de este PC.".into());
    }
    // app_id is a u32, so the URI cannot carry anything but digits.
    tauri_plugin_opener::open_url(format!("steam://rungameid/{app_id}"), None::<&str>)
        .map_err(|e| format!("No se pudo abrir Steam: {e}"))
}
