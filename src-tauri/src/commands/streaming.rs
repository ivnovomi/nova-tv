//! Streaming services opened as full-screen browser "app" windows.
//!
//! DRM-protected services (Netflix, Prime Video, Disney+…) cannot play inside the
//! Tauri WebView, so they are opened in Microsoft Edge (or Chrome) with `--app`,
//! using dedicated NOVA TV browser profiles so sign-ins persist and the flags
//! always apply. Only `https://` URLs are accepted.

use crate::config::{Shortcut, ShortcutKind, ShortcutSource, Target};
use std::{
    env,
    path::{Path, PathBuf},
    process::{Child, Command},
};

struct Service {
    key: &'static str,
    name: &'static str,
    description: &'static str,
    url: &'static str,
    tv: bool,
}

const CATALOG: &[Service] = &[
    Service { key: "youtube", name: "YouTube", description: "Interfaz de TV, dentro de NOVA", url: "https://www.youtube.com/tv", tv: true },
    Service { key: "netflix", name: "Netflix", description: "Series y películas", url: "https://www.netflix.com/browse", tv: false },
    Service { key: "prime", name: "Prime Video", description: "Amazon Prime Video", url: "https://www.primevideo.com", tv: false },
    Service { key: "disney", name: "Disney+", description: "Disney, Pixar, Marvel, Star Wars", url: "https://www.disneyplus.com", tv: false },
    Service { key: "max", name: "Max", description: "Series y películas", url: "https://play.max.com", tv: false },
    Service { key: "movistar", name: "Movistar Plus+", description: "TV, deportes y series", url: "https://ver.movistarplus.es", tv: false },
    Service { key: "twitch", name: "Twitch", description: "Directos", url: "https://www.twitch.tv", tv: false },
    Service { key: "crunchyroll", name: "Crunchyroll", description: "Anime", url: "https://www.crunchyroll.com", tv: false },
    Service { key: "appletv", name: "Apple TV+", description: "Originales de Apple", url: "https://tv.apple.com", tv: false },
    Service { key: "rtve", name: "RTVE Play", description: "Televisión pública", url: "https://www.rtve.es/play/", tv: false },
    Service { key: "atresplayer", name: "atresplayer", description: "Antena 3, laSexta y más", url: "https://www.atresplayer.com", tv: false },
    Service { key: "ytmusic", name: "YouTube Music", description: "Música", url: "https://music.youtube.com", tv: false },
    Service { key: "youtubekids", name: "YouTube Kids", description: "Vídeos para niños, con control parental de Google", url: "https://www.youtubekids.com", tv: false },
];

pub fn catalog() -> Vec<Shortcut> {
    CATALOG
        .iter()
        .map(|s| Shortcut {
            id: format!("stream:{}", s.key),
            name: s.name.into(),
            description: Some(s.description.into()),
            kind: ShortcutKind::Stream,
            target: Target::Web { url: s.url.into(), tv: s.tv },
            source: ShortcutSource::Builtin,
        })
        .collect()
}

/// Edge first (ships with Windows and has PlayReady for premium streaming), then Chrome.
pub fn find_browser() -> Option<PathBuf> {
    let rels = [r"Microsoft\Edge\Application\msedge.exe", r"Google\Chrome\Application\chrome.exe"];
    rels.iter()
        .flat_map(|rel| {
            ["ProgramFiles(x86)", "ProgramFiles", "LOCALAPPDATA"]
                .iter()
                .filter_map(|v| env::var_os(v))
                .map(move |base| Path::new(&base).join(rel))
        })
        .find(|p| p.is_file())
}

pub fn validate_url(url: &str) -> Result<String, String> {
    let url = url.trim();
    let rest = url
        .strip_prefix("https://")
        .ok_or("La dirección debe empezar por https://")?;
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host_ok = !host.is_empty()
        && host.contains('.')
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == ':');
    if !host_ok {
        return Err("La dirección no tiene un dominio válido.".into());
    }
    if url.len() > 2048 || url.chars().any(|c| c.is_whitespace() || c.is_control() || c == '"') {
        return Err("La dirección contiene caracteres no válidos.".into());
    }
    Ok(url.to_string())
}

pub fn launch(url: &str, profiles_dir: &Path) -> Result<Child, String> {
    let url = validate_url(url)?;
    let browser = find_browser()
        .ok_or("Se necesita Microsoft Edge o Google Chrome para abrir servicios de streaming.")?;
    let profile = profiles_dir.join("web");
    std::fs::create_dir_all(&profile).map_err(|e| format!("No se pudo preparar el perfil del navegador: {e}"))?;

    let mut cmd = Command::new(&browser);
    cmd.arg(format!("--app={url}"))
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--start-fullscreen")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--autoplay-policy=no-user-gesture-required");
    cmd.spawn()
        .map_err(|e| format!("No se pudo abrir el navegador: {e}"))
}
