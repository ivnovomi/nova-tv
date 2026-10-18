//! Installed plugins: finding them, starting them only when needed, and the
//! rules around them. NOVA's commands for Ajustes → Plugins and "Para ti".
//!
//! A plugin runs only if: it's enabled, the permissions in its installed
//! manifest are exactly the ones the user approved, and (for a children's
//! profile) it's for everyone and a parent allowed it.

use super::manifest::{Audience, Kind, Manifest, Permissions, Setting};
use super::package;
use super::runtime::{Env, LogLine, Plugin};
use super::storage::Storage;
use crate::config::PluginState;
use crate::profiles::require_adult;
use crate::AppState;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager, State};

/// The parts a plugin can provide, and the permission each one needs.
const PARTS: &[&str] = &["channels", "guide", "rows", "search", "screensaver"];

fn has_permission(p: &Permissions, part: &str) -> bool {
    match part {
        "channels" => p.channels,
        "guide" => p.guide,
        "rows" => p.rows,
        "search" => p.search,
        "screensaver" => p.screensaver,
        _ => false,
    }
}

pub struct Registry {
    plugins_dir: PathBuf,
    data_dir: PathBuf,
    running: Mutex<HashMap<String, Arc<Plugin>>>,
    /// Last start or call error per plugin, for Ajustes.
    errors: Mutex<HashMap<String, String>>,
    /// Rows per (plugin, profile), with when they were loaded.
    rows: Mutex<HashMap<(String, String), (Instant, Vec<Row>)>>,
}

impl Registry {
    pub fn new(app: &AppHandle) -> Self {
        let base = app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("nova-tv"));
        let registry = Self {
            plugins_dir: base.join("plugins"),
            data_dir: base.join("plugin-data"),
            running: Mutex::new(HashMap::new()),
            errors: Mutex::new(HashMap::new()),
            rows: Mutex::new(HashMap::new()),
        };
        registry.clean_staging();
        registry
    }

    /// An install interrupted by a crash or a power cut leaves a staging folder: remove it.
    fn clean_staging(&self) {
        let Ok(entries) = std::fs::read_dir(&self.plugins_dir) else { return };
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(".staging-") {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }

    fn installed(&self) -> Vec<(Manifest, PathBuf)> {
        let Ok(entries) = std::fs::read_dir(&self.plugins_dir) else { return vec![] };
        let mut out: Vec<_> = entries
            .flatten()
            .filter_map(|e| {
                let id = e.file_name().to_string_lossy().into_owned();
                if id.starts_with('.') {
                    return None;
                }
                let (_, dir) = package::current(&self.plugins_dir, &id)?;
                let manifest = Manifest::read(&dir).ok().filter(|m| m.id == id)?;
                Some((manifest, dir))
            })
            .collect();
        out.sort_by(|a, b| a.0.name.to_lowercase().cmp(&b.0.name.to_lowercase()));
        out
    }

    fn find(&self, id: &str) -> Result<(Manifest, PathBuf), String> {
        self.installed().into_iter().find(|(m, _)| m.id == id).ok_or_else(|| "Ese plugin no está instalado".to_string())
    }

    fn stop(&self, id: &str) {
        if let Ok(mut running) = self.running.lock() {
            running.remove(id);
        }
        if let Ok(mut rows) = self.rows.lock() {
            rows.retain(|(plugin, _), _| plugin != id);
        }
        if let Ok(mut errors) = self.errors.lock() {
            errors.remove(id);
        }
    }

    fn note_error(&self, id: &str, error: &str) {
        if let Ok(mut errors) = self.errors.lock() {
            errors.insert(id.to_string(), error.to_string());
        }
    }

    /// The running plugin, started now if it wasn't.
    fn plugin(&self, id: &str, state: &PluginState) -> Result<Arc<Plugin>, String> {
        if let Some(p) = self.running.lock().ok().and_then(|r| r.get(id).cloned()) {
            return Ok(p);
        }
        let started = self.start(id, state);
        match &started {
            Ok(p) => {
                if let Ok(mut running) = self.running.lock() {
                    running.insert(id.to_string(), p.clone());
                }
            }
            Err(e) => self.note_error(id, e),
        }
        started
    }

    fn start(&self, id: &str, state: &PluginState) -> Result<Arc<Plugin>, String> {
        let (manifest, dir) = self.find(id)?;
        if !manifest.kind.contains(&Kind::Provider) {
            return Err("Este plugin no tiene código que ejecutar".into());
        }
        let source = std::fs::read_to_string(dir.join(&manifest.main)).map_err(|e| format!("No se pudo leer el código del plugin: {e}"))?;
        let env = Env::new(manifest.clone(), Storage::new(self.data_dir.join(id)));
        *env.settings.lock().map_err(|e| e.to_string())? = state.settings.clone();
        let plugin = Plugin::start(Arc::new(env), source)?;
        if let Some(part) = plugin.parts.keys().find(|p| PARTS.contains(&p.as_str()) && !has_permission(&manifest.permissions, p)) {
            return Err(format!("El plugin aporta «{part}» pero no pidió ese permiso en su manifiesto"));
        }
        Ok(Arc::new(plugin))
    }
}

/// Whether the installed manifest asks for exactly what the user approved.
fn approved(manifest: &Manifest, state: &PluginState) -> bool {
    serde_json::to_value(&manifest.permissions).ok().as_ref() == Some(&state.granted)
}

/// Whether this profile gets the plugin at all.
fn visible(manifest: &Manifest, state: &PluginState, kids: bool) -> bool {
    state.enabled && approved(manifest, state) && (!kids || (manifest.audience == Audience::Everyone && state.kids_allowed))
}

/// The profile id a plugin sees: stable, but different for every plugin.
fn opaque(plugin: &str, profile: &str) -> String {
    let hash = Sha256::digest(format!("nova-plugin:{plugin}:{profile}").as_bytes());
    hash.iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn context(plugin: &str, profile: &crate::config::Profile) -> (serde_json::Value, String) {
    let id = opaque(plugin, &profile.id);
    (serde_json::json!({ "profile": { "id": id, "kids": profile.kids }, "locale": "es-ES" }), id)
}

/// "30m" → seconds, never under the minimum.
fn refresh_secs(value: Option<&str>, default: u64, minimum: u64) -> u64 {
    let parsed = value.and_then(|v| {
        let (n, unit) = v.split_at(v.len().checked_sub(1)?);
        let n: f64 = n.parse().ok()?;
        let mult = match unit {
            "m" => 60.0,
            "h" => 3600.0,
            "d" => 86400.0,
            _ => return None,
        };
        Some((n * mult) as u64)
    });
    parsed.unwrap_or(default).max(minimum)
}

// ───────────────────────── What plugins return, cleaned ─────────────────────────

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    title: String,
    style: &'static str,
    items: Vec<Item>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    id: String,
    title: String,
    subtitle: Option<String>,
    image: Option<String>,
    badge: Option<String>,
    action: serde_json::Value,
}

fn text(v: &serde_json::Value, max: usize) -> Option<String> {
    v.as_str().map(|s| s.trim().chars().filter(|c| !c.is_control()).take(max).collect::<String>()).filter(|s| !s.is_empty())
}

fn https(v: &serde_json::Value) -> Option<String> {
    text(v, 2048).filter(|u| u.starts_with("https://") && !u.contains(char::is_whitespace))
}

/// A playable stream as NOVA understands it, or None if it isn't valid.
fn stream(v: &serde_json::Value) -> Option<serde_json::Value> {
    let id = |s: &str| !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    match v["type"].as_str()? {
        "hls" => Some(serde_json::json!({ "type": "hls", "url": https(&v["url"])?, "proxy": v["proxy"].as_bool().unwrap_or(false) })),
        "twitch" => text(&v["channel"], 25).filter(|c| id(c)).map(|c| serde_json::json!({ "type": "twitch", "channel": c.to_lowercase() })),
        "youtube" => match (text(&v["video"], 20), text(&v["channel"], 40)) {
            (Some(video), _) if id(&video) => Some(serde_json::json!({ "type": "youtube", "video": video })),
            (None, Some(channel)) if id(&channel) => Some(serde_json::json!({ "type": "youtube", "channel": channel })),
            _ => None,
        },
        _ => None,
    }
}

/// Only the actions NOVA allows, with only the fields it uses.
fn action(v: &serde_json::Value) -> Option<serde_json::Value> {
    match v["type"].as_str()? {
        "detail" => Some(serde_json::json!({ "type": "detail", "title": text(&v["title"], 120), "text": text(&v["text"], 2000)?, "image": https(&v["image"]) })),
        "play" => Some(serde_json::json!({ "type": "play", "stream": stream(&v["stream"])?, "title": text(&v["title"], 120) })),
        "tune" => Some(serde_json::json!({ "type": "tune", "channel": text(&v["channel"], 200)? })),
        "app" => Some(serde_json::json!({ "type": "app", "path": text(&v["path"], 200) })),
        _ => None,
    }
}

/// A plugin's rows, keeping only what's valid (and within sensible sizes).
fn clean_rows(value: &serde_json::Value) -> Vec<Row> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .take(5)
        .filter_map(|row| {
            let items: Vec<Item> = row["items"]
                .as_array()
                .into_iter()
                .flatten()
                .take(40)
                .filter_map(|item| {
                    Some(Item {
                        id: text(&item["id"], 100)?,
                        title: text(&item["title"], 120)?,
                        subtitle: text(&item["subtitle"], 120),
                        image: https(&item["image"]),
                        badge: text(&item["badge"], 20),
                        action: action(&item["action"])?,
                    })
                })
                .collect();
            let style = match row["style"].as_str() {
                Some("poster") => "poster",
                Some("square") => "square",
                _ => "landscape",
            };
            (!items.is_empty()).then(|| Row { title: text(&row["title"], 80).unwrap_or_else(|| "Plugin".into()), style, items })
        })
        .collect()
}

// ───────────────────────── "Para ti" ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRows {
    plugin: String,
    name: String,
    rows: Vec<Row>,
}

fn rows_for(app: &AppHandle) -> Vec<PluginRows> {
    let config = app.state::<AppState>().config.snapshot();
    let profile = crate::profiles::active(&config);
    let registry = app.state::<Registry>();
    let candidates: Vec<(Manifest, PluginState)> = registry
        .installed()
        .into_iter()
        .filter_map(|(m, _)| {
            let state = config.plugins.installed.get(&m.id)?.clone();
            (m.permissions.rows && visible(&m, &state, profile.kids)).then_some((m, state))
        })
        .collect();

    // Each plugin in parallel: a slow one doesn't hold the others back.
    let handles: Vec<_> = candidates
        .into_iter()
        .map(|(manifest, state)| {
            let app = app.clone();
            let profile = profile.clone();
            std::thread::spawn(move || {
                let registry = app.state::<Registry>();
                let (ctx, opaque_id) = context(&manifest.id, &profile);
                let key = (manifest.id.clone(), opaque_id.clone());
                let cached = registry.rows.lock().ok().and_then(|r| r.get(&key).cloned());
                let plugin = registry.plugin(&manifest.id, &state);
                let ttl = plugin.as_ref().ok().map(|p| refresh_secs(p.parts.get("rows").and_then(|r| r.as_deref()), 30 * 60, 15 * 60)).unwrap_or(30 * 60);
                if let Some((at, rows)) = &cached {
                    if at.elapsed() < Duration::from_secs(ttl) {
                        return PluginRows { plugin: manifest.id, name: manifest.name, rows: rows.clone() };
                    }
                }
                let fresh = plugin.and_then(|p| p.call("rows", "load", serde_json::json!([ctx]), Some(opaque_id)));
                let rows = match fresh {
                    Ok(value) => {
                        let rows = clean_rows(&value);
                        if let Ok(mut cache) = registry.rows.lock() {
                            cache.insert(key, (Instant::now(), rows.clone()));
                        }
                        rows
                    }
                    Err(e) => {
                        registry.note_error(&manifest.id, &e);
                        // NOVA keeps the last good rows.
                        cached.map(|(_, r)| r).unwrap_or_default()
                    }
                };
                PluginRows { plugin: manifest.id, name: manifest.name, rows }
            })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).filter(|r| !r.rows.is_empty()).collect()
}

/// Rows from plugins for "Para ti", for the profile watching.
#[tauri::command]
pub async fn plugins_rows(app: AppHandle) -> Vec<PluginRows> {
    tauri::async_runtime::spawn_blocking(move || rows_for(&app)).await.unwrap_or_default()
}

// ───────────────────────── Ajustes → Plugins ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    name: String,
    version: String,
    /// The version installed before this one (to go back to).
    previous: Option<String>,
    description: String,
    author: String,
    audience: Audience,
    kind: Vec<Kind>,
    permissions: Permissions,
    settings: Vec<Setting>,
    values: serde_json::Map<String, serde_json::Value>,
    enabled: bool,
    kids_allowed: bool,
    /// The installed version asks for permissions the user hasn't approved.
    needs_approval: bool,
    icon: Option<String>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginsInfo {
    developer_mode: bool,
    plugins: Vec<PluginInfo>,
}

fn icon(dir: &Path, manifest: &Manifest) -> Option<String> {
    let path = dir.join(manifest.icon.as_deref()?);
    let bytes = std::fs::read(path).ok().filter(|b| b.len() <= 512 * 1024)?;
    let mime = if bytes.starts_with(b"\x89PNG") {
        "image/png"
    } else if bytes.starts_with(b"RIFF") {
        "image/webp"
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        "image/jpeg"
    } else {
        return None;
    };
    Some(format!("data:{mime};base64,{}", crate::nowplaying::base64(&bytes)))
}

fn previous_version(plugins: &Path, id: &str, current: &str) -> Option<String> {
    std::fs::read_dir(plugins.join(id))
        .ok()?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| n != current && !n.starts_with('.') && n != "current" && plugins.join(id).join(n).join("nova-plugin.json").is_file())
}

fn info(registry: &Registry, config: &crate::config::Config) -> PluginsInfo {
    let errors = registry.errors.lock().map(|e| e.clone()).unwrap_or_default();
    let plugins = registry
        .installed()
        .into_iter()
        .map(|(m, dir)| {
            let state = config.plugins.installed.get(&m.id).cloned();
            PluginInfo {
                previous: previous_version(&registry.plugins_dir, &m.id, &m.version),
                icon: icon(&dir, &m),
                error: errors.get(&m.id).cloned(),
                needs_approval: !state.as_ref().is_some_and(|s| approved(&m, s)),
                enabled: state.as_ref().is_some_and(|s| s.enabled),
                kids_allowed: state.as_ref().is_some_and(|s| s.kids_allowed),
                values: state.map(|s| s.settings).unwrap_or_default(),
                id: m.id,
                name: m.name,
                version: m.version,
                description: m.description,
                author: m.author.name,
                audience: m.audience,
                kind: m.kind,
                permissions: m.permissions,
                settings: m.settings,
            }
        })
        .collect();
    PluginsInfo { developer_mode: config.plugins.developer_mode, plugins }
}

#[tauri::command]
pub async fn plugins_list(app: AppHandle) -> PluginsInfo {
    tauri::async_runtime::spawn_blocking(move || info(&app.state::<Registry>(), &app.state::<AppState>().config.snapshot())).await.unwrap_or(PluginsInfo { developer_mode: false, plugins: vec![] })
}

/// Modo desarrollador: install packages the store hasn't reviewed.
#[tauri::command]
pub fn plugins_set_developer(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    require_adult(&state)?;
    state.config.update(|c| {
        c.plugins.developer_mode = enabled;
        Ok(())
    })
}

fn package_path(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path);
    let is_pkg = path.extension().and_then(|e| e.to_str()).is_some_and(|e| e.eq_ignore_ascii_case("novapkg"));
    if !is_pkg || !path.is_file() {
        return Err("Elige un archivo .novapkg".into());
    }
    Ok(path)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    author: String,
    audience: Audience,
    permissions: Permissions,
    files: usize,
    /// Bytes once installed.
    size: u64,
    /// Already installed: which version.
    installed: Option<String>,
    /// It asks for different permissions than the installed version had.
    permissions_changed: bool,
}

/// What a package is and asks for, before installing it (the permissions screen).
#[tauri::command]
pub async fn plugins_inspect(path: String, app: AppHandle) -> Result<PackageInfo, String> {
    require_adult(&app.state::<AppState>())?;
    let path = package_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        let inspected = package::inspect(&path)?;
        let m = inspected.manifest.clone();
        let config = app.state::<AppState>().config.snapshot();
        let installed = package::current(&app.state::<Registry>().plugins_dir, &m.id).map(|(v, _)| v);
        let permissions_changed = config.plugins.installed.get(&m.id).is_some_and(|s| !approved(&m, s));
        Ok(PackageInfo {
            files: inspected.file_count(),
            size: inspected.unpacked,
            installed,
            permissions_changed,
            id: m.id,
            name: m.name,
            version: m.version,
            description: m.description,
            author: m.author.name,
            audience: m.audience,
            permissions: m.permissions,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Installs (or updates) a package. The user approved its permissions on the
/// screen shown from `plugins_inspect`; they're recorded as granted.
#[tauri::command]
pub async fn plugins_install(path: String, app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    require_adult(&state)?;
    if !state.config.snapshot().plugins.developer_mode {
        return Err("Para instalar paquetes que la tienda no ha revisado, activa el modo desarrollador".into());
    }
    let path = package_path(&path)?;
    let handle = app.clone();
    let installed = tauri::async_runtime::spawn_blocking(move || {
        let registry = handle.state::<Registry>();
        let manifest = package::inspect(&path)?.manifest;
        registry.stop(&manifest.id);
        package::install(&path, &registry.plugins_dir).map(|i| (i, manifest))
    })
    .await
    .map_err(|e| e.to_string())??;
    let (_, manifest) = installed;
    state.config.update(|c| {
        let entry = c.plugins.installed.entry(manifest.id.clone()).or_insert_with(|| PluginState {
            enabled: true,
            granted: serde_json::Value::Null,
            kids_allowed: false,
            settings: Default::default(),
        });
        entry.granted = serde_json::to_value(&manifest.permissions).unwrap_or_default();
        // Options the new version no longer has are forgotten.
        entry.settings.retain(|k, _| manifest.settings.iter().any(|s| s.key == *k));
        Ok(())
    })
}

#[tauri::command]
pub async fn plugins_uninstall(id: String, delete_data: bool, app: AppHandle) -> Result<(), String> {
    let state = app.state::<AppState>();
    require_adult(&state)?;
    let registry = app.state::<Registry>();
    registry.stop(&id);
    package::uninstall(&registry.plugins_dir, &registry.data_dir, &id, delete_data)?;
    state.config.update(|c| {
        if delete_data {
            c.plugins.installed.remove(&id);
        }
        Ok(())
    })
}

fn update_state(app: &AppHandle, id: &str, change: impl FnOnce(&mut PluginState)) -> Result<(), String> {
    let state = app.state::<AppState>();
    require_adult(&state)?;
    state.config.update(|c| {
        let entry = c.plugins.installed.get_mut(id).ok_or("Ese plugin no está instalado")?;
        change(entry);
        Ok(())
    })?;
    app.state::<Registry>().stop(id);
    Ok(())
}

#[tauri::command]
pub fn plugins_set_enabled(id: String, enabled: bool, app: AppHandle) -> Result<(), String> {
    update_state(&app, &id, |s| s.enabled = enabled)
}

#[tauri::command]
pub fn plugins_set_kids(id: String, allowed: bool, app: AppHandle) -> Result<(), String> {
    let (manifest, _) = app.state::<Registry>().find(&id)?;
    if allowed && manifest.audience != Audience::Everyone {
        return Err("Este plugin es solo para adultos".into());
    }
    update_state(&app, &id, |s| s.kids_allowed = allowed)
}

/// One of the plugin's options (as declared in its manifest).
#[tauri::command]
pub fn plugins_set_setting(id: String, key: String, value: serde_json::Value, app: AppHandle) -> Result<(), String> {
    let (manifest, _) = app.state::<Registry>().find(&id)?;
    let setting = manifest.settings.iter().find(|s| s.key == key).ok_or("Esa opción no existe")?;
    let ok = match setting.kind.as_str() {
        "text" => value.as_str().is_some_and(|s| s.chars().count() <= 500),
        "toggle" => value.is_boolean(),
        "number" => value.is_number(),
        "choice" => value.as_str().is_some_and(|v| setting.options.iter().any(|o| o["value"].as_str() == Some(v))),
        _ => false,
    };
    if !ok {
        return Err("Valor no válido para esa opción".into());
    }
    update_state(&app, &id, |s| {
        s.settings.insert(key, value);
    })
}

/// Back to the version installed before the current one.
#[tauri::command]
pub fn plugins_rollback(id: String, app: AppHandle) -> Result<(), String> {
    require_adult(&app.state::<AppState>())?;
    let registry = app.state::<Registry>();
    registry.stop(&id);
    package::rollback(&registry.plugins_dir, &id)?;
    let (manifest, _) = registry.find(&id)?;
    // It was approved when it was installed.
    update_state(&app, &id, |s| s.granted = serde_json::to_value(&manifest.permissions).unwrap_or_default())
}

/// What the plugin has written to its log (while it's been running).
#[tauri::command]
pub fn plugins_log(id: String, app: AppHandle) -> Vec<LogLine> {
    let registry = app.state::<Registry>();
    let plugin = registry.running.lock().ok().and_then(|r| r.get(&id).cloned());
    plugin.map(|p| p.env.log.lock().map(|l| l.iter().cloned().collect()).unwrap_or_default()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_are_cleaned() {
        let raw = serde_json::json!([
            { "title": "Fila", "style": "poster", "items": [
                { "id": "1", "title": "Bien", "image": "https://x.es/a.jpg", "action": { "type": "detail", "text": "Hola" } },
                { "id": "2", "title": "Imagen local", "image": "file:///C:/x.jpg", "action": { "type": "detail", "text": "x" } },
                { "id": "3", "title": "Acción rara", "action": { "type": "exec", "cmd": "calc" } },
                { "id": "4", "title": "HLS http", "action": { "type": "play", "stream": { "type": "hls", "url": "http://x.es/a.m3u8" } } },
                { "id": "5", "title": "Twitch", "action": { "type": "play", "stream": { "type": "twitch", "channel": "Ibai" } } },
                { "title": "Sin id", "action": { "type": "detail", "text": "x" } }
            ] },
            { "title": "Vacía", "items": [] }
        ]);
        let rows = clean_rows(&raw);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].style, "poster");
        let ids: Vec<&str> = rows[0].items.iter().map(|i| i.id.as_str()).collect();
        assert_eq!(ids, ["1", "2", "5"]);
        assert_eq!(rows[0].items[1].image, None);
        assert_eq!(rows[0].items[2].action["stream"]["channel"], "ibai");
    }

    #[test]
    fn profile_ids_differ_per_plugin() {
        assert_eq!(opaque("a.b.c", "p1"), opaque("a.b.c", "p1"));
        assert_ne!(opaque("a.b.c", "p1"), opaque("x.y.z", "p1"));
        assert_ne!(opaque("a.b.c", "p1"), "p1");
    }

    #[test]
    fn refresh_has_a_minimum() {
        assert_eq!(refresh_secs(Some("30m"), 60, 900), 1800);
        assert_eq!(refresh_secs(Some("1m"), 60, 900), 900);
        assert_eq!(refresh_secs(Some("2h"), 60, 900), 7200);
        assert_eq!(refresh_secs(Some("raro"), 1800, 900), 1800);
        assert_eq!(refresh_secs(None, 1800, 900), 1800);
    }
}
