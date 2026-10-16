//! Opens validated local media files with the Windows default application.

use crate::config::{now_secs, MediaEntry, MAX_RECENT_MEDIA};
use crate::AppState;
use serde::Serialize;
use std::path::PathBuf;
use tauri::State;

pub const VIDEO_EXT: &[&str] = &["mp4", "mkv", "avi", "mov", "wmv", "webm", "m4v", "flv", "ts", "mpg", "mpeg"];
pub const AUDIO_EXT: &[&str] = &["mp3", "flac", "wav", "aac", "ogg", "m4a", "wma", "opus"];
pub const IMAGE_EXT: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "bmp"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentMedia {
    #[serde(flatten)]
    pub entry: MediaEntry,
    pub exists: bool,
}

fn category(path: &PathBuf) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if VIDEO_EXT.contains(&ext.as_str()) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext.as_str()) {
        Some("audio")
    } else if IMAGE_EXT.contains(&ext.as_str()) {
        Some("image")
    } else {
        None
    }
}

#[tauri::command]
pub async fn open_media(path: String, state: State<'_, AppState>) -> Result<MediaEntry, String> {
    crate::profiles::deny_kids(&state)?;
    if path.is_empty() || path.len() > 1024 || path.contains('\0') {
        return Err("Ruta de archivo no válida.".into());
    }
    let p = PathBuf::from(&path);
    if !p.is_absolute() {
        return Err("La ruta debe ser absoluta.".into());
    }
    let cat = category(&p).ok_or("Formato no compatible. Usa vídeo, audio o imagen.")?;
    if !p.is_file() {
        return Err(format!("El archivo ya no está disponible: {}", p.display()));
    }
    tauri_plugin_opener::open_path(&p, None::<&str>)
        .map_err(|e| format!("Windows no pudo abrir el archivo: {e}"))?;

    let entry = MediaEntry {
        name: p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| path.clone()),
        path: path.clone(),
        category: cat.into(),
        opened_at: now_secs(),
    };
    let saved = entry.clone();
    let _ = state.config.update(move |c| {
        c.recent_media.retain(|m| !m.path.eq_ignore_ascii_case(&entry.path));
        c.recent_media.insert(0, entry);
        c.recent_media.truncate(MAX_RECENT_MEDIA);
        Ok(())
    });
    Ok(saved)
}

#[tauri::command]
pub async fn list_recent_media(state: State<'_, AppState>) -> Result<Vec<RecentMedia>, String> {
    if crate::profiles::kids(&state).is_some() {
        return Ok(vec![]);
    }
    Ok(state
        .config
        .snapshot()
        .recent_media
        .into_iter()
        .map(|entry| RecentMedia { exists: PathBuf::from(&entry.path).is_file(), entry })
        .collect())
}

#[tauri::command]
pub async fn forget_media(path: String, state: State<'_, AppState>) -> Result<(), String> {
    state.config.update(|c| {
        c.recent_media.retain(|m| m.path != path);
        Ok(())
    })
}

#[tauri::command]
pub fn media_extensions() -> Vec<&'static str> {
    VIDEO_EXT.iter().chain(AUDIO_EXT).chain(IMAGE_EXT).copied().collect()
}
