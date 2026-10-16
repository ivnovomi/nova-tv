//! Real play time per game, measured by the game watcher (only time a game's
//! own processes were actually running). Stored locally in `playtime.json`.

use crate::config::now_secs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize, Default, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PlayStats {
    pub total_seconds: u64,
    /// Unix seconds of the last moment the game was seen running.
    pub last_played: u64,
    pub sessions: u32,
}

pub struct PlaytimeStore {
    path: PathBuf,
    data: Mutex<HashMap<String, PlayStats>>,
}

impl PlaytimeStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("playtime.json");
        let data = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, data: Mutex::new(data) }
    }

    fn save(&self, data: &HashMap<String, PlayStats>) {
        let Ok(json) = serde_json::to_string(data) else { return };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    /// Adds `seconds` to a game; `new_session` counts a fresh play session.
    pub fn add(&self, id: &str, seconds: u64, new_session: bool) {
        let Ok(mut data) = self.data.lock() else { return };
        let stats = data.entry(id.to_string()).or_default();
        stats.total_seconds += seconds;
        stats.last_played = now_secs();
        if new_session {
            stats.sessions += 1;
        }
        let snapshot = data.clone();
        drop(data);
        self.save(&snapshot);
    }
}

/// Records play time from the watcher thread and tells the UI.
pub fn record(app: &AppHandle, id: &str, seconds: u64, new_session: bool) {
    app.state::<PlaytimeStore>().add(id, seconds, new_session);
    let _ = app.emit("playtime-changed", ());
}

#[tauri::command]
pub fn playtime(store: State<'_, PlaytimeStore>) -> HashMap<String, PlayStats> {
    store.data.lock().map(|d| d.clone()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accumulates_and_persists() {
        let dir = std::env::temp_dir().join(format!("nova-playtime-{}", now_secs()));
        let store = PlaytimeStore::load(&dir);
        store.add("steam:1", 0, true);
        store.add("steam:1", 60, false);
        store.add("steam:1", 45, false);
        let reloaded = PlaytimeStore::load(&dir);
        let stats = reloaded.data.lock().unwrap().get("steam:1").cloned().unwrap();
        assert_eq!((stats.total_seconds, stats.sessions), (105, 1));
        let _ = fs::remove_dir_all(dir);
    }
}
