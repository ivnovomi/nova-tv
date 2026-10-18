//! `nova dev`: a plugin straight from the developer's folder, reloaded every
//! time it changes, with its log in the developer's terminal.
//!
//! The CLI (scripts/dev-plugin.mjs) writes a link, `plugins-dev/<id>.json`
//! (`{ "dir": "C:\\…\\mi-plugin" }`), and touches it every few seconds while it
//! runs. NOVA loads the linked plugins only in developer mode. When a link goes
//! away or stops being touched (the CLI was closed or crashed), everything it
//! brought is undone: its data, its log, and the plugin's state as it was before.

use super::manifest::Manifest;
use super::registry::{changed, Registry};
use crate::config::PluginState;
use crate::AppState;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Manager};

/// A link not touched for this long belongs to a CLI that's gone.
const STALE: Duration = Duration::from_secs(20);
const TICK: Duration = Duration::from_secs(1);

#[derive(Deserialize)]
struct Link {
    dir: PathBuf,
}

pub fn data_dir(dev_dir: &Path, id: &str) -> PathBuf {
    dev_dir.join(format!("{id}.data"))
}

pub fn log_file(dev_dir: &Path, id: &str) -> PathBuf {
    dev_dir.join(format!("{id}.log"))
}

/// The plugin's state before `nova dev` took it over, to put back afterwards.
fn saved_file(dev_dir: &Path, id: &str) -> PathBuf {
    dev_dir.join(format!("{id}.saved.json"))
}

/// A line for the developer's terminal.
pub fn append(dev_dir: &Path, id: &str, level: &str, message: &str) {
    append_to(&log_file(dev_dir, id), level, message);
}

/// Appends to a log the CLI created (never creates one: no CLI, no file).
pub fn append_to(path: &Path, level: &str, message: &str) {
    let line = serde_json::json!({ "at": crate::config::now_secs(), "level": level, "message": message });
    if let Ok(mut file) = std::fs::OpenOptions::new().append(true).open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// When the code or the manifest last changed.
type Stamp = Vec<Option<(SystemTime, u64)>>;

fn stamp(dir: &Path) -> Stamp {
    let of = |p: PathBuf| std::fs::metadata(p).ok().and_then(|m| Some((m.modified().ok()?, m.len())));
    let main = Manifest::read(dir).ok().map(|m| dir.join(m.main));
    vec![of(dir.join("nova-plugin.json")), main.and_then(of)]
}

/// The links whose CLI is alive. Links of CLIs that are gone are removed, with their log.
fn live_links(dev_dir: &Path) -> HashMap<String, PathBuf> {
    let mut out = HashMap::new();
    let Ok(entries) = std::fs::read_dir(dev_dir) else { return out };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json").filter(|id| !id.ends_with(".saved") && super::manifest::valid_id(id)) else { continue };
        let fresh = entry.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age < STALE);
        let link = std::fs::read_to_string(entry.path()).ok().and_then(|t| serde_json::from_str::<Link>(&t).ok());
        match link {
            Some(link) if fresh && link.dir.is_absolute() => {
                out.insert(id.to_string(), link.dir);
            }
            _ => {
                let _ = std::fs::remove_file(entry.path());
                let _ = std::fs::remove_file(log_file(dev_dir, id));
            }
        }
    }
    out
}

/// Loads (or reloads) a linked plugin.
fn load(app: &AppHandle, id: &str, dir: &Path) {
    let registry = app.state::<Registry>();
    let state = app.state::<AppState>();
    let manifest = match Manifest::read(dir) {
        Ok(m) if m.id == id => m,
        Ok(m) => {
            append(&registry.dev_dir, id, "error", &format!("El id del manifiesto ahora es «{}»: vuelve a lanzar nova dev", m.id));
            return unload(app, id);
        }
        Err(e) => {
            append(&registry.dev_dir, id, "error", &e);
            return unload(app, id);
        }
    };

    // The first time, remember the plugin's state as it was (installed or not).
    let saved = saved_file(&registry.dev_dir, id);
    if !saved.exists() {
        let before = state.config.snapshot().plugins.installed.get(id).cloned();
        let _ = std::fs::write(&saved, serde_json::to_string(&before).unwrap_or_default());
    }
    // A developer running their own plugin approves what it asks for.
    let _ = state.config.update(|c| {
        let entry = c.plugins.installed.entry(id.to_string()).or_insert_with(|| PluginState {
            enabled: true,
            granted: serde_json::Value::Null,
            kids_allowed: false,
            settings: Default::default(),
            channel_block: None,
        });
        entry.enabled = true;
        entry.granted = serde_json::to_value(&manifest.permissions).unwrap_or_default();
        entry.settings.retain(|k, _| manifest.settings.iter().any(|s| s.key == *k));
        Ok(())
    });
    if let Ok(mut dev) = registry.dev.lock() {
        dev.retain(|(m, _)| m.id != id);
        dev.push((manifest.clone(), dir.to_path_buf()));
    }
    registry.stop(id);

    // Started now, so a mistake shows in the terminal at once.
    if let Some(plugin_state) = state.config.snapshot().plugins.installed.get(id) {
        if let Ok(plugin) = registry.plugin(id, plugin_state) {
            let mut parts: Vec<&str> = plugin.parts.keys().map(String::as_str).collect();
            parts.sort_unstable();
            append(&registry.dev_dir, id, "nova", &format!("{} {} cargado en NOVA: {}", manifest.name, manifest.version, parts.join(", ")));
        }
    }
    changed(app, id);
}

/// Takes a plugin out of NOVA without undoing anything (bad manifest, for now).
fn unload(app: &AppHandle, id: &str) {
    let registry = app.state::<Registry>();
    if let Ok(mut dev) = registry.dev.lock() {
        dev.retain(|(m, _)| m.id != id);
    }
    registry.stop(id);
    changed(app, id);
}

/// `nova dev` is over for this plugin: undo everything it brought.
fn finish(app: &AppHandle, id: &str) {
    let registry = app.state::<Registry>();
    unload(app, id);
    let saved = saved_file(&registry.dev_dir, id);
    let before: Option<Option<PluginState>> = std::fs::read_to_string(&saved).ok().and_then(|t| serde_json::from_str(&t).ok());
    let installed = registry.installed_manifests().iter().any(|m| m.id == id);
    let _ = app.state::<AppState>().config.update(|c| {
        match before {
            Some(Some(state)) => {
                c.plugins.installed.insert(id.to_string(), state);
            }
            _ if !installed => {
                c.plugins.installed.remove(id);
            }
            _ => {}
        }
        Ok(())
    });
    let _ = std::fs::remove_file(saved);
    let _ = std::fs::remove_dir_all(data_dir(&registry.dev_dir, id));
    // Nothing left of `nova dev`: not even the folder.
    let _ = std::fs::remove_dir(&registry.dev_dir);
    changed(app, id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn links_of_gone_clis_are_removed() {
        let dir = std::env::temp_dir().join(format!("nova-dev-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let plugin = if cfg!(windows) { "C:\\plugins\\mi-plugin" } else { "/plugins/mi-plugin" };
        let link = serde_json::json!({ "dir": plugin }).to_string();

        std::fs::write(dir.join("es.ejemplo.vivo.json"), &link).unwrap();
        std::fs::write(dir.join("es.ejemplo.viejo.json"), &link).unwrap();
        std::fs::write(dir.join("es.ejemplo.viejo.log"), "").unwrap();
        let old = SystemTime::now() - Duration::from_secs(60);
        std::fs::File::options().write(true).open(dir.join("es.ejemplo.viejo.json")).unwrap().set_modified(old).unwrap();
        std::fs::write(dir.join("es.ejemplo.roto.json"), "no es json").unwrap();
        std::fs::write(dir.join("es.ejemplo.relativo.json"), r#"{ "dir": "plugins/x" }"#).unwrap();
        std::fs::write(dir.join("es.ejemplo.vivo.saved.json"), "null").unwrap();

        let live = live_links(&dir);
        assert_eq!(live.keys().collect::<Vec<_>>(), ["es.ejemplo.vivo"]);
        assert!(!dir.join("es.ejemplo.viejo.json").exists());
        assert!(!dir.join("es.ejemplo.viejo.log").exists());
        assert!(!dir.join("es.ejemplo.roto.json").exists());
        assert!(!dir.join("es.ejemplo.relativo.json").exists());
        // What NOVA saved to restore later isn't a link.
        assert!(dir.join("es.ejemplo.vivo.saved.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_log_is_never_created_by_nova() {
        let path = std::env::temp_dir().join(format!("nova-dev-log-{}.log", std::process::id()));
        let _ = std::fs::remove_file(&path);
        append_to(&path, "info", "hola");
        assert!(!path.exists());
        std::fs::write(&path, "").unwrap();
        append_to(&path, "info", "hola");
        let line: serde_json::Value = serde_json::from_str(std::fs::read_to_string(&path).unwrap().trim()).unwrap();
        assert_eq!(line["message"], "hola");
        let _ = std::fs::remove_file(&path);
    }
}

/// Watches the links: loads new plugins, reloads changed ones and undoes the ones that ended.
pub fn spawn(app: AppHandle) {
    std::thread::Builder::new()
        .name("nova dev".into())
        .spawn(move || {
            let dev_dir = app.state::<Registry>().dev_dir.clone();
            let mut loaded: HashMap<String, Stamp> = HashMap::new();
            let mut warned: HashSet<String> = HashSet::new();

            // Left over from a session NOVA didn't see end (closed, crashed, power cut).
            let links = live_links(&dev_dir);
            let leftovers: Vec<String> = std::fs::read_dir(&dev_dir)
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| e.file_name().to_string_lossy().strip_suffix(".saved.json").map(String::from))
                .filter(|id| !links.contains_key(id))
                .collect();
            for id in leftovers {
                finish(&app, &id);
            }

            loop {
                std::thread::sleep(TICK);
                let links = live_links(&dev_dir);
                if loaded.is_empty() && links.is_empty() {
                    continue;
                }
                let developer = app.state::<AppState>().config.snapshot().plugins.developer_mode;
                let active: HashMap<String, PathBuf> = if developer { links.clone() } else { HashMap::new() };

                for id in links.keys().filter(|id| !developer && !warned.contains(*id)).cloned().collect::<Vec<_>>() {
                    append(&dev_dir, &id, "nova", "NOVA está abierto, pero sin el modo desarrollador: actívalo en Ajustes → Plugins");
                    warned.insert(id);
                }
                warned.retain(|id| links.contains_key(id) && !developer);

                for id in loaded.keys().filter(|id| !active.contains_key(*id)).cloned().collect::<Vec<_>>() {
                    loaded.remove(&id);
                    finish(&app, &id);
                }
                for (id, dir) in active {
                    let now = stamp(&dir);
                    if loaded.get(&id) != Some(&now) {
                        load(&app, &id, &dir);
                        loaded.insert(id, now);
                    }
                }
            }
        })
        .ok();
}
