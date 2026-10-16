//! Phone remote, part 2: live TV, apps, "send to TV" and volume.
//!
//! Every route here requires a paired device (checked by the caller). Actions
//! that change what's on screen are forwarded to NOVA's UI as events, so they
//! go through the same code (and checks) as the TV interface itself.

use super::{error, json, read_json, respond};
use crate::commands::{applications, store, streaming, system::volume};
use crate::config::ShortcutKind;
use crate::livetv::{self, Channel};
use crate::livetv_health::{Health, HealthStore};
use crate::metadata::MetadataStore;
use crate::{session, AppState};
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::Request;

/// What the TV interface last published (channel, programme, mode).
static TV_STATE: Mutex<Option<serde_json::Value>> = Mutex::new(None);

pub fn published_tv() -> Option<serde_json::Value> {
    TV_STATE.lock().ok().and_then(|s| s.clone())
}

/// NOVA's UI tells the phone what's on (small JSON, replaced each time).
#[tauri::command]
pub fn remote_publish(state: serde_json::Value) -> Result<(), String> {
    if serde_json::to_string(&state).map(|s| s.len()).unwrap_or(usize::MAX) > 4096 {
        return Err("too large".into());
    }
    *TV_STATE.lock().map_err(|_| "busy")? = Some(state);
    Ok(())
}

// ───────────────────────── Helpers ─────────────────────────

fn query(url: &str, key: &str) -> Option<String> {
    let q = url.split_once('?')?.1;
    q.split('&').find_map(|pair| {
        let (k, v) = pair.split_once('=')?;
        (k == key).then(|| decode(v))
    })
}

fn decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                if let Ok(b) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                    out.push(b);
                    i += 2;
                } else {
                    out.push(b'%');
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn fold(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| match c {
            'á' => 'a',
            'é' => 'e',
            'í' => 'i',
            'ó' => 'o',
            'ú' | 'ü' => 'u',
            'ñ' => 'n',
            c => c,
        })
        .collect()
}

/// Brings NOVA to the front, leaving any streaming service first.
fn front(app: &AppHandle) {
    if session::is_active() {
        session::end(app, false);
    }
    session::focus_main(app);
}

// ───────────────────────── Channels ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteChannel {
    id: String,
    number: u32,
    name: String,
    logo: Option<String>,
    group: String,
    now: Option<String>,
}

const GROUPS: &[(&str, &str)] = &[
    ("fav", "Favoritos"),
    ("tdt:Generalistas", "Generalistas"),
    ("tdt:Informativos", "Informativos"),
    ("tdt:Deportivos", "Deportivos"),
    ("tdt:Infantiles", "Infantiles"),
    ("pluto", "Pluto TV"),
    ("pluto:Infantil", "Dibujos"),
    ("pluto:Anime", "Anime"),
    ("twitch", "Twitch"),
    ("cat:Noticias", "Noticias del mundo"),
    ("cat:Deportes", "Deportes del mundo"),
    ("cat:Cine", "Cine"),
    ("cat:Series", "Series"),
    ("cat:Infantil", "Infantil"),
    ("cat:Música", "Música"),
    ("cat:Documentales", "Documentales"),
];

fn in_group(c: &Channel, group: &str, favorites: &[String]) -> bool {
    match group.split_once(':') {
        _ if group == "fav" => favorites.contains(&c.id),
        _ if group == "pluto" => c.id.starts_with("pluto:"),
        _ if group == "twitch" => c.id.starts_with("twitch:"),
        Some(("pluto", g)) => c.id.starts_with("pluto:") && c.group == g,
        Some(("tdt", g)) => c.id.starts_with("tdt:") && c.country.as_deref() == Some("ES") && c.group == g,
        Some(("cat", g)) => c.categories.iter().any(|k| k == g),
        _ => true,
    }
}

/// `GET /api/channels?group=&q=` — channels with signal, best 80, with what's on.
pub fn channels(app: &AppHandle, request: Request) {
    let url = request.url().to_string();
    let group = query(&url, "group").unwrap_or_else(|| "tdt:Generalistas".into());
    let words: Vec<String> = query(&url, "q").map(|q| fold(&q)).unwrap_or_default().split_whitespace().map(String::from).collect();
    let favorites = crate::profiles::active(&app.state::<AppState>().config.snapshot()).favorites;
    let health = app.state::<HealthStore>();
    let mut list: Vec<Channel> = livetv::snapshot(app)
        .into_iter()
        .filter(|c| !matches!(health.status(&c.id), Some(Health::Dead | Health::Blocked)))
        .filter(|c| if words.is_empty() { in_group(c, &group, &favorites) } else { words.iter().all(|w| fold(&c.name).contains(w.as_str())) })
        .collect();
    list.sort_by_key(|c| c.number);
    let out: Vec<RemoteChannel> = list
        .into_iter()
        .take(80)
        .map(|c| RemoteChannel {
            now: c.epg_id.as_deref().and_then(|e| livetv::now_title(app, e)),
            group: c.group.clone(),
            id: c.id,
            number: c.number,
            name: c.name,
            logo: c.logo,
        })
        .collect();
    let groups: Vec<_> = GROUPS.iter().map(|(k, v)| serde_json::json!({ "key": k, "label": v })).collect();
    json(request, 200, &serde_json::json!({ "groups": groups, "group": group, "channels": out }));
}

#[derive(Deserialize)]
struct TvAction {
    action: String,
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    number: Option<u32>,
}

/// `POST /api/tv` — zap, tune, numbers, guide/info/menu, open/minimise/off.
pub fn tv(app: &AppHandle, mut request: Request) {
    let body = match read_json::<TvAction>(&mut request) {
        Ok(b) => b,
        Err(e) => return error(request, 400, e),
    };
    let ok = match body.action.as_str() {
        "up" | "down" | "guide" | "info" | "menu" | "list" | "open" | "minimize" | "off" => true,
        "tune" => body.id.as_deref().is_some_and(|id| id.len() < 200 && livetv::snapshot(app).iter().any(|c| c.id == id)),
        "number" => body.number.is_some_and(|n| n > 0 && n < 100_000),
        _ => false,
    };
    if !ok {
        return error(request, 400, "Acción de TV no válida");
    }
    if body.action != "off" && body.action != "minimize" {
        front(app);
    }
    let _ = app.emit("remote-tv", serde_json::json!({ "action": body.action, "id": body.id, "number": body.number }));
    respond(request, 204, "text/plain", String::new());
}

// ───────────────────────── Power ─────────────────────────

#[derive(Deserialize)]
struct PowerRequest {
    action: String,
    #[serde(default)]
    minutes: Option<u32>,
}

/// `POST /api/power` — the power button. Turning off, restarting or leaving
/// NOVA is shown on the TV as a countdown that anyone there can cancel.
pub fn power(app: &AppHandle, mut request: Request) {
    let body = match read_json::<PowerRequest>(&mut request) {
        Ok(b) => b,
        Err(e) => return error(request, 400, e),
    };
    let result = match body.action.as_str() {
        "display-off" => crate::power::run(app, "display-off"),
        "timer" => crate::power::set_timer(app, body.minutes).map(|_| ()),
        "exit" if crate::profiles::require_adult(&app.state::<AppState>()).is_err() => {
            Err("Para salir de NOVA en un perfil infantil hace falta el PIN, desde la tele.".into())
        }
        "menu" | "screensaver" | "cancel" | "shutdown" | "restart" | "exit" | "restart-nova" => {
            front(app);
            let _ = app.emit("remote-power", &body.action);
            Ok(())
        }
        _ => Err("Acción no válida".into()),
    };
    match result {
        Ok(()) => json(request, 200, &crate::power::info()),
        Err(e) => error(request, 400, &e),
    }
}

// ───────────────────────── Apps ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RemoteApp {
    id: String,
    name: String,
    kind: &'static str,
    image: Option<String>,
}

/// `GET /api/apps` — NOVA's own shortcuts (streaming, games, apps). Nothing else can be launched.
pub fn apps(app: &AppHandle, request: Request) {
    let meta = app.state::<MetadataStore>();
    let mut out: Vec<RemoteApp> = Vec::new();
    let user = app.state::<AppState>().config.snapshot().shortcuts;
    let streaming = streaming::catalog().into_iter().chain(store::installed_apps()).chain(user.iter().filter(|s| s.kind == ShortcutKind::Stream).cloned());
    out.extend(streaming.map(|s| RemoteApp { id: s.id, name: s.name, kind: "stream", image: None }));
    out.extend(
        applications::all_games(app)
            .into_iter()
            .filter(|g| meta.is_game(&g.id))
            .map(|g| RemoteApp { image: meta.cover(&g.id), id: g.id, name: g.name, kind: "game" }),
    );
    let apps = applications::detected_apps().into_iter().chain(user.into_iter().filter(|s| s.kind == ShortcutKind::App));
    out.extend(apps.map(|a| RemoteApp { id: a.id, name: a.name, kind: "app", image: None }));
    let profile = crate::profiles::active(&app.state::<AppState>().config.snapshot());
    out.retain(|a| crate::profiles::shortcut_allowed(&profile, &a.id));
    json(request, 200, &out);
}

#[derive(Deserialize)]
struct Launch {
    id: String,
}

/// `POST /api/launch` — opens a NOVA shortcut by id, through NOVA's UI (same checks as the TV).
pub fn launch(app: &AppHandle, mut request: Request) {
    match read_json::<Launch>(&mut request) {
        Ok(l) if !l.id.is_empty() && l.id.len() < 300 => {
            front(app);
            let _ = app.emit("remote-launch", serde_json::json!({ "id": l.id }));
            respond(request, 204, "text/plain", String::new());
        }
        Ok(_) => error(request, 400, "Id no válido"),
        Err(e) => error(request, 400, e),
    }
}

// ───────────────────────── Send to TV ─────────────────────────

/// YouTube link (watch, youtu.be, shorts, embed, live) or bare id → (id, seconds).
pub fn parse_youtube(input: &str) -> Option<(String, u32)> {
    let s = input.trim();
    let valid = |id: &str| crate::history::valid_video_id(id);
    if valid(s) {
        return Some((s.to_string(), 0));
    }
    let rest = s.split_once("://").map(|(_, r)| r).unwrap_or(s);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let host = host.trim_start_matches("www.").trim_start_matches("m.").trim_start_matches("music.");
    let (path, query_str) = path.split_once('?').unwrap_or((path, ""));
    let param = |k: &str| query_str.split('&').find_map(|p| p.split_once('=').filter(|(a, _)| *a == k).map(|(_, v)| v.to_string()));
    let id = match host {
        "youtu.be" => path.split('/').next().map(String::from),
        "youtube.com" => {
            if path == "watch" {
                param("v")
            } else {
                ["shorts/", "embed/", "live/", "v/"].iter().find_map(|p| path.strip_prefix(p)).map(|r| r.split('/').next().unwrap_or("").to_string())
            }
        }
        _ => None,
    }?;
    if !valid(&id) {
        return None;
    }
    let t = param("t").or_else(|| param("start")).map(|t| {
        // "90", "90s" or "1m30s"
        let (mut total, mut num) = (0u32, 0u32);
        for ch in t.chars() {
            match ch {
                '0'..='9' => num = num * 10 + ch.to_digit(10).unwrap_or(0),
                'h' => (total, num) = (total + num * 3600, 0),
                'm' => (total, num) = (total + num * 60, 0),
                _ => (total, num) = (total + num, 0),
            }
        }
        total + num
    });
    Some((id, t.unwrap_or(0)))
}

#[derive(Deserialize)]
struct Cast {
    url: String,
}

/// `POST /api/cast` — plays a YouTube link on the TV, in NOVA's YouTube TV player.
pub fn cast(app: &AppHandle, mut request: Request) {
    if let Err(e) = crate::profiles::require_youtube(&app.state::<AppState>()) {
        return error(request, 403, &e);
    }
    match read_json::<Cast>(&mut request) {
        Ok(c) => match parse_youtube(&c.url) {
            Some((id, t)) => {
                front(app);
                let _ = app.emit("remote-cast", serde_json::json!({ "videoId": id, "position": t }));
                json(request, 200, &serde_json::json!({ "videoId": id }));
            }
            None => error(request, 400, "No es un enlace de YouTube"),
        },
        Err(e) => error(request, 400, e),
    }
}

/// `GET /api/artwork` — cover of what Windows is playing (fetched once per track by the phone).
pub fn artwork(request: Request) {
    let art = crate::nowplaying::now_playing().and_then(|n| n.artwork);
    json(request, 200, &serde_json::json!({ "artwork": art }));
}

// ───────────────────────── Volume ─────────────────────────

#[derive(Deserialize)]
struct Volume {
    #[serde(default)]
    level: Option<u32>,
    #[serde(default)]
    muted: Option<bool>,
}

/// `POST /api/volume` — exact system volume (0-100) and mute.
pub fn set_volume(mut request: Request) {
    let body = match read_json::<Volume>(&mut request) {
        Ok(b) => b,
        Err(e) => return error(request, 400, e),
    };
    let result = match (body.level, body.muted) {
        (Some(level), _) => volume::set_level(level.min(100)),
        (None, Some(muted)) => volume::set_mute(muted),
        (None, None) => volume::get(),
    };
    match result {
        Ok(v) => json(request, 200, &v),
        Err(e) => error(request, 500, &e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_links() {
        let id = "dQw4w9WgXcQ";
        assert_eq!(parse_youtube(id), Some((id.into(), 0)));
        assert_eq!(parse_youtube(&format!("https://www.youtube.com/watch?v={id}&t=90s")), Some((id.into(), 90)));
        assert_eq!(parse_youtube(&format!("https://youtu.be/{id}?t=1m30s")), Some((id.into(), 90)));
        assert_eq!(parse_youtube(&format!("https://youtube.com/shorts/{id}?feature=share")), Some((id.into(), 0)));
        assert_eq!(parse_youtube(&format!("https://m.youtube.com/watch?app=desktop&v={id}")), Some((id.into(), 0)));
        assert_eq!(parse_youtube("https://evil.com/watch?v=dQw4w9WgXcQ"), None);
        assert_eq!(parse_youtube("hola"), None);
    }

    #[test]
    fn query_decoding() {
        assert_eq!(query("/api/channels?q=la%20sexta&group=fav", "q").as_deref(), Some("la sexta"));
        assert_eq!(query("/api/channels?q=m%C3%BAsica", "q").as_deref(), Some("música"));
    }
}
