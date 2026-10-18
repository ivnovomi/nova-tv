//! Twitch: live channels in Spanish suitable for everyone, played in Twitch's
//! own official player (ads and all) in NOVA's full-screen player window.
//!
//! "Suitable for everyone" is Twitch's own data: streams carrying any content
//! classification label (mature game, gambling, profanity, sexual themes,
//! violence, drugs…) are left out, as are gambling/ASMR categories and titles
//! that say +18. The list is varied: at most two streams per game.
//!
//! The same streams are also live TV channels (4001+), played inside the TV
//! with Twitch's embedded player.

use crate::livetv::{Channel, Program, Source};
use crate::AppState;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};

const GQL: &str = "https://gql.twitch.tv/gql";
/// The public id twitch.tv's own website uses for anonymous browsing (not a secret).
const WEB_CLIENT_ID: &str = "kimne78kx3ncx6brgo4mv6wki5h1ko";
const TTL: Duration = Duration::from_secs(5 * 60);
const SHOWN: usize = 18;
const PER_GAME: usize = 2;
const SKIP_GAMES: &[&str] = &["slots", "casino", "virtual casino", "poker", "asmr", "pools, hot tubs, and beaches", "gambling", "irl"];
const SKIP_TITLES: &[&str] = &["+18", "18+", "nsfw", "casino", "apuestas", "slots", "asmr"];

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TwitchLive {
    login: String,
    name: String,
    title: String,
    viewers: u64,
    game: Option<String>,
    preview: String,
    avatar: Option<String>,
    /// When the stream started (ISO 8601).
    started_at: Option<String>,
}

/// TV channel numbers for Twitch: the most watched is 4001.
pub const FIRST_NUMBER: u32 = 4001;

static CACHE: Mutex<Option<(Instant, Vec<TwitchLive>)>> = Mutex::new(None);

fn valid_login(login: &str) -> bool {
    (3..=25).contains(&login.len()) && login.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

/// Besides the most watched, categories that tend to suit everyone (each stream
/// is still checked against Twitch's content labels). Unknown names just return nothing.
const FAMILY_GAMES: &[&str] = &[
    "Minecraft",
    "Fortnite",
    "Roblox",
    "Rocket League",
    "Art",
    "Music",
    "Chess",
    "Sports",
    "Food & Drink",
    "Science & Technology",
    "Travel & Outdoors",
    "Animal Crossing: New Horizons",
    "Stardew Valley",
    "Software and Game Development",
];

/// One request (Twitch only allows the first page anonymously): the top 30 in
/// Spanish plus the top 10 of each family category.
fn fetch() -> Result<Vec<TwitchLive>, String> {
    let fields = "edges{node{title viewersCount createdAt previewImageURL(width:640,height:360) \
                  broadcaster{login displayName profileImageURL(width:70)} game{displayName} contentClassificationLabels{id}}}";
    let mut query = format!("query{{top:streams(first:30,options:{{languages:[ES]}}){{{fields}}}");
    for (i, game) in FAMILY_GAMES.iter().enumerate() {
        query.push_str(&format!(" g{i}:game(name:{}){{streams(first:10,options:{{broadcasterLanguages:[ES]}}){{{fields}}}}}", serde_json::Value::from(*game)));
    }
    query.push('}');
    let json = request(&query)?;
    let data = &json["data"];
    let mut edges: Vec<serde_json::Value> = data["top"]["edges"].as_array().cloned().unwrap_or_default();
    for i in 0..FAMILY_GAMES.len() {
        edges.extend(data[format!("g{i}")]["streams"]["edges"].as_array().cloned().unwrap_or_default());
    }
    // Most watched first; duplicates (top + category) are dropped in `pick`.
    edges.sort_by_key(|e| std::cmp::Reverse(e["node"]["viewersCount"].as_u64().unwrap_or(0)));
    Ok(pick(&serde_json::json!({ "data": { "streams": { "edges": edges } } })))
}

fn request(query: &str) -> Result<serde_json::Value, String> {
    let body = serde_json::json!({ "query": query }).to_string();
    let text = crate::net::agent()
        .post(GQL)
        .header("Client-Id", WEB_CLIENT_ID)
        .header("Content-Type", "application/json")
        .send(body.as_bytes())
        .map_err(|e| format!("Twitch no responde: {e}"))?
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    // Partial data is fine (e.g. a renamed category); only fail when nothing came back.
    if json["data"].is_null() {
        return Err(format!("Twitch: {}", json["errors"][0]["message"].as_str().unwrap_or("sin datos")));
    }
    Ok(json)
}

/// Everyone-friendly, varied, most watched first.
fn pick(json: &serde_json::Value) -> Vec<TwitchLive> {
    let mut per_game: std::collections::HashMap<String, usize> = Default::default();
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for edge in json["data"]["streams"]["edges"].as_array().into_iter().flatten() {
        let n = &edge["node"];
        let s = |v: &serde_json::Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
        let (Some(login), Some(title)) = (s(&n["broadcaster"]["login"]), s(&n["title"])) else { continue };
        // No labels at all, or the labels weren't sent: only an explicit empty list counts as "for everyone".
        if !valid_login(&login) || !n["contentClassificationLabels"].as_array().is_some_and(|l| l.is_empty()) || !seen.insert(login.clone()) {
            continue;
        }
        let game = s(&n["game"]["displayName"]);
        let game_key = game.as_deref().unwrap_or("").to_lowercase();
        let lower_title = title.to_lowercase();
        if SKIP_GAMES.contains(&game_key.as_str()) || SKIP_TITLES.iter().any(|w| lower_title.contains(w)) || login.contains("asmr") {
            continue;
        }
        let count = per_game.entry(game_key).or_default();
        if *count >= PER_GAME {
            continue;
        }
        *count += 1;
        let preview = s(&n["previewImageURL"]).filter(|u| u.starts_with("https://static-cdn.jtvnw.net/")).unwrap_or_default();
        out.push(TwitchLive {
            name: s(&n["broadcaster"]["displayName"]).unwrap_or_else(|| login.clone()),
            avatar: s(&n["broadcaster"]["profileImageURL"]).filter(|u| u.starts_with("https://static-cdn.jtvnw.net/")),
            viewers: n["viewersCount"].as_u64().unwrap_or(0),
            title: title.chars().take(140).collect(),
            started_at: s(&n["createdAt"]),
            game,
            preview,
            login,
        });
        if out.len() >= SHOWN {
            break;
        }
    }
    out
}

/// A children's profile only gets Twitch if a parent allowed the Twitch service.
fn allowed(state: &AppState) -> bool {
    match crate::profiles::kids(state) {
        Some(p) => crate::profiles::shortcut_allowed(&p, "stream:twitch"),
        None => true,
    }
}

/// The current list (cached for a few minutes). Blocking.
fn live_list() -> Result<Vec<TwitchLive>, String> {
    if let Some((at, list)) = CACHE.lock().ok().and_then(|c| c.clone()) {
        if at.elapsed() < TTL {
            return Ok(list);
        }
    }
    let list = fetch()?;
    if let Ok(mut c) = CACHE.lock() {
        *c = Some((Instant::now(), list.clone()));
    }
    Ok(list)
}

#[tauri::command]
pub async fn twitch_live(state: State<'_, AppState>) -> Result<Vec<TwitchLive>, String> {
    if !allowed(&state) {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(live_list).await.map_err(|e| e.to_string())?
}

// ───────────────────────── As live TV channels ─────────────────────────

/// Twitch's live streams as TV channels ("twitch:<login>" streams play in the TV's embedded player).
pub fn channels() -> (Vec<Channel>, Option<String>) {
    match live_list() {
        Ok(list) => (
            list.into_iter()
                .enumerate()
                .map(|(i, s)| Channel {
                    source: Source::Twitch,
                    country: Some("ES".into()),
                    categories: vec!["Entretenimiento".into()],
                    id: format!("twitch:{}", s.login),
                    number: FIRST_NUMBER + i as u32,
                    name: s.name,
                    logo: s.avatar,
                    group: s.game.unwrap_or_else(|| "Twitch".into()),
                    region: "Twitch".into(),
                    streams: vec![format!("twitch:{}", s.login)],
                    epg_id: Some(format!("twitch:{}", s.login)),
                    geo: false,
                })
                .collect(),
            None,
        ),
        Err(e) => (vec![], Some(e)),
    }
}

/// "What's on": each stream's title, from when it started until (at least) the next hour.
pub fn guide() -> HashMap<String, Vec<Program>> {
    let now = crate::config::now_secs() as i64;
    let list = CACHE.lock().ok().and_then(|c| c.clone()).map(|(_, l)| l).unwrap_or_default();
    list.into_iter()
        .map(|s| {
            let start = s.started_at.as_deref().and_then(iso_secs).filter(|t| *t <= now).unwrap_or(now);
            let program = Program {
                start,
                end: (now / 3600 + 1) * 3600 + 3600,
                title: s.title,
                description: Some(format!("{} en directo{} · {} espectadores", s.name, s.game.as_deref().map(|g| format!(" · {g}")).unwrap_or_default(), s.viewers)),
                genre: s.game,
                image: Some(s.preview).filter(|p| !p.is_empty()),
            };
            (format!("twitch:{}", s.login), vec![program])
        })
        .collect()
}

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// "2026-10-15T23:37:01Z" (when a stream started) → Unix seconds.
fn iso_secs(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    if s.len() < 19 {
        return None;
    }
    Some(days_from_civil(n(0..4)?, n(5..7)?, n(8..10)?) * 86400 + n(11..13)? * 3600 + n(14..16)? * 60 + n(17..19)?)
}

/// "Estado de las fuentes": does Twitch's public API answer right now?
pub fn probe() -> Result<(), String> {
    request("query{streams(first:1){edges{node{id}}}}").map(|_| ())
}

/// Signal check for a Twitch channel: is the stream still live?
pub fn is_live(agent: &ureq::Agent, login: &str) -> Option<bool> {
    if !valid_login(login) {
        return Some(false);
    }
    let body = serde_json::json!({ "query": format!("query{{user(login:{}){{stream{{id}}}}}}", serde_json::Value::from(login)) }).to_string();
    let text = agent
        .post(GQL)
        .header("Client-Id", WEB_CLIENT_ID)
        .header("Content-Type", "application/json")
        .send(body.as_bytes())
        .ok()?
        .body_mut()
        .read_to_string()
        .ok()?;
    let json: serde_json::Value = serde_json::from_str(&text).ok()?;
    Some(!json["data"]["user"]["stream"].is_null())
}

/// Opens a live channel in Twitch's official player, full screen.
#[tauri::command]
pub async fn twitch_play(login: String, name: Option<String>, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    if !allowed(&state) {
        return Err(crate::profiles::BLOCKED.into());
    }
    let login = login.trim().to_lowercase();
    if !valid_login(&login) {
        return Err("Canal de Twitch no válido.".into());
    }
    let name: String = name.unwrap_or_else(|| login.clone()).chars().filter(|c| !c.is_control()).take(40).collect();
    let url = format!("https://player.twitch.tv/?channel={login}&parent=player.twitch.tv&autoplay=true&muted=false");
    crate::session::end_blocking(&app).await;
    let label = crate::commands::player::open_plain(&app, &format!("Twitch · {name}"), &url)?;
    crate::session::start(&app, &format!("Twitch · {name}"), crate::session::Kind::Player(label));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(iso_secs("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_secs("2026-10-15T23:37:01.000Z"), Some(1792107421));
        assert_eq!(iso_secs("ayer"), None);
    }

    #[test]
    fn filters_for_everyone() {
        let node = |login: &str, game: &str, title: &str, labels: &[&str]| {
            serde_json::json!({ "node": {
                "title": title, "viewersCount": 10, "previewImageURL": "https://static-cdn.jtvnw.net/x.jpg",
                "broadcaster": { "login": login, "displayName": login }, "game": { "displayName": game },
                "contentClassificationLabels": labels.iter().map(|l| serde_json::json!({ "id": l })).collect::<Vec<_>>()
            }})
        };
        let json = serde_json::json!({ "data": { "streams": { "edges": [
            node("ok_one", "Minecraft", "Construyendo", &[]),
            node("mature", "Warzone", "Partidas", &["MatureGame"]),
            node("slots", "Slots", "Tiradas", &[]),
            node("adult", "Just Chatting", "Directo +18", &[]),
            node("ok_two", "Minecraft", "Survival", &[]),
            node("ok_three", "Minecraft", "Tercero del mismo juego", &[]),
            node("Bad-Login", "Art", "Dibujo", &[]),
            node("artist", "Art", "Dibujo", &[]),
        ]}}});
        let logins: Vec<String> = pick(&json).into_iter().map(|s| s.login).collect();
        assert_eq!(logins, ["ok_one", "ok_two", "artist"]);
    }

    #[test]
    #[ignore = "needs internet"]
    fn twitch_live_spanish() {
        let list = fetch().unwrap();
        for s in &list {
            println!("{:>6} · {} · {:?} · {}", s.viewers, s.name, s.game, s.title);
        }
        assert!(!list.is_empty());
    }
}
