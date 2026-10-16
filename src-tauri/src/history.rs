//! Watch history ("Seguir viendo") and "new from your channels".
//!
//! Progress arrives from NOVA's player window (see `player_report`). Entries are
//! provider-agnostic so other services can plug in later; YouTube is the first.
//! Everything stays on this PC in `history.json`.

use crate::commands::player;
use crate::config::now_secs;
use crate::session;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State, Webview};

const MAX_ENTRIES: usize = 200;
const FEED_CHANNELS: usize = 8;
const FEED_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    /// "<provider>:<item id>", e.g. "youtube:jNQXAC9IVRw"
    pub key: String,
    pub provider: String,
    pub item_id: String,
    pub title: String,
    #[serde(default)]
    pub channel: Option<String>,
    #[serde(default)]
    pub channel_url: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    pub position: f64,
    pub duration: f64,
    pub updated_at: u64,
    #[serde(default)]
    pub finished: bool,
    /// Whose history it is (entries from before profiles belong to the main one).
    #[serde(default)]
    pub profile: Option<String>,
}

impl WatchEntry {
    fn owned_by(&self, profile: &str) -> bool {
        self.profile.as_deref().unwrap_or("principal") == profile
    }
}

fn active_profile(app: &AppHandle) -> String {
    crate::profiles::active(&app.state::<crate::AppState>().config.snapshot()).id
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryFile {
    #[serde(default)]
    entries: Vec<WatchEntry>,
    /// channel URL (https://www.youtube.com/@handle) -> channel id (UC…)
    #[serde(default)]
    channels: HashMap<String, String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    video_id: String,
    title: String,
    channel: String,
    published: String,
    thumbnail: String,
}

pub struct HistoryStore {
    path: PathBuf,
    data: Mutex<HistoryFile>,
    dirty: AtomicBool,
    /// (built at, for profile, items)
    feed: Mutex<Option<(Instant, String, Vec<FeedItem>)>>,
}

impl HistoryStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("history.json");
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self { path, data: Mutex::new(data), dirty: AtomicBool::new(false), feed: Mutex::new(None) }
    }

    /// Writes to disk if anything changed (atomic temp + rename).
    pub fn flush(&self) {
        if !self.dirty.swap(false, Ordering::AcqRel) {
            return;
        }
        let Ok(data) = self.data.lock() else { return };
        let Ok(json) = serde_json::to_string(&*data) else { return };
        drop(data);
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &self.path)).is_err() {
            self.dirty.store(true, Ordering::Release);
        }
    }

    fn sorted(&self, profile: &str) -> Vec<WatchEntry> {
        let mut list: Vec<WatchEntry> = self.data.lock().map(|d| d.entries.iter().filter(|e| e.owned_by(profile)).cloned().collect()).unwrap_or_default();
        list.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        list
    }
}

/// Persists periodically so frequent progress reports don't hammer the disk.
pub fn spawn_flusher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(10));
        app.state::<HistoryStore>().flush();
    });
}

// ───────────────────────── Validation ─────────────────────────

pub fn valid_video_id(id: &str) -> bool {
    id.len() == 11 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn clean_text(s: Option<String>, max: usize) -> Option<String> {
    s.map(|t| t.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string())
        .filter(|t| !t.is_empty())
}

fn https_prefix(s: Option<String>, prefix: &str) -> Option<String> {
    s.filter(|u| u.starts_with(prefix) && u.len() < 300 && !u.contains(['"', '\'', ' ', '<', '>']))
}

// ───────────────────────── Player bridge ─────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerReport {
    video_id: String,
    position: f64,
    duration: f64,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    channel_url: Option<String>,
    #[serde(default)]
    thumbnail: Option<String>,
}

/// The only command the player window (youtube.com) may call.
#[tauri::command]
pub fn player_report(webview: Webview, report: PlayerReport, app: AppHandle) -> Result<(), String> {
    if !webview.label().starts_with(player::LABEL_PREFIX) {
        return Err("forbidden".into());
    }
    if !valid_video_id(&report.video_id)
        || !report.position.is_finite()
        || !report.duration.is_finite()
        || report.position < 0.0
        || report.duration <= 0.0
        || report.duration > 86_400.0 * 2.0
    {
        return Err("invalid report".into());
    }
    let position = report.position.min(report.duration);
    let store = app.state::<HistoryStore>();
    let profile = active_profile(&app);
    let key = format!("youtube:{}", report.video_id);
    let title = clean_text(report.title, 200);
    let channel = clean_text(report.channel, 100);
    let channel_url = https_prefix(report.channel_url, "https://www.youtube.com/");
    let thumbnail = https_prefix(report.thumbnail, "https://i.ytimg.com/");
    let finished = position >= report.duration - 20.0 || position / report.duration > 0.95;

    let mut new_channel = None;
    {
        let mut data = store.data.lock().map_err(|_| "busy")?;
        let channel_known = channel_url.as_ref().is_some_and(|u| data.channels.contains_key(u));
        let entry = match data.entries.iter_mut().position(|e| e.key == key && e.owned_by(&profile)) {
            Some(i) => &mut data.entries[i],
            None => {
                data.entries.push(WatchEntry {
                    key: key.clone(),
                    provider: "youtube".into(),
                    item_id: report.video_id.clone(),
                    title: "Vídeo de YouTube".into(),
                    channel: None,
                    channel_url: None,
                    thumbnail: Some(format!("https://i.ytimg.com/vi/{}/hqdefault.jpg", report.video_id)),
                    position: 0.0,
                    duration: report.duration,
                    updated_at: 0,
                    finished: false,
                    profile: Some(profile.clone()),
                });
                data.entries.last_mut().unwrap()
            }
        };
        entry.position = position;
        entry.duration = report.duration;
        entry.updated_at = now_secs();
        entry.finished = finished;
        if let Some(t) = title {
            entry.title = t;
        }
        if channel.is_some() {
            entry.channel = channel;
        }
        if thumbnail.is_some() {
            entry.thumbnail = thumbnail;
        }
        if let Some(url) = channel_url {
            entry.channel_url = Some(url.clone());
            if !channel_known {
                new_channel = Some(url);
            }
        }
        let now_playing = entry.title.clone();
        session::set_now_playing(Some(now_playing));
        // Keep the most recent entries only.
        if data.entries.len() > MAX_ENTRIES {
            data.entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
            data.entries.truncate(MAX_ENTRIES);
        }
    }
    store.dirty.store(true, Ordering::Release);
    if let Some(url) = new_channel {
        resolve_channel_later(app.clone(), url);
    }
    let _ = app.emit("history-changed", ());
    Ok(())
}

// ───────────────────────── YouTube public data (no API key) ─────────────────────────

fn http_get(url: &str) -> Result<String, String> {
    ureq::get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .header("Accept-Language", "es-ES,es;q=0.9")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())
}

/// Finds the UC… channel id behind a channel URL (canonical link of its page).
fn resolve_channel_later(app: AppHandle, url: String) {
    std::thread::spawn(move || {
        let Ok(html) = http_get(&url) else { return };
        let marker = "https://www.youtube.com/channel/";
        let id = html.match_indices(marker).find_map(|(i, _)| {
            let id: String = html[i + marker.len()..].chars().take(24).collect();
            (id.starts_with("UC") && id.len() == 24 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
                .then_some(id)
        });
        if let Some(id) = id {
            let store = app.state::<HistoryStore>();
            if let Ok(mut data) = store.data.lock() {
                data.channels.insert(url, id);
            }
            store.dirty.store(true, Ordering::Release);
            if let Ok(mut feed) = store.feed.lock() {
                *feed = None; // new channel: rebuild the feed next time
            }
        }
    });
}

fn tag<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&format!("</{name}>"))? + start;
    Some(&xml[start..end])
}

fn unescape(s: &str) -> String {
    s.replace("&amp;", "&").replace("&quot;", "\"").replace("&#39;", "'").replace("&lt;", "<").replace("&gt;", ">")
}

fn channel_feed(channel_id: &str) -> Vec<FeedItem> {
    let Ok(xml) = http_get(&format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}")) else {
        return vec![];
    };
    let channel = tag(&xml, "title").map(unescape).unwrap_or_default();
    xml.split("<entry>")
        .skip(1)
        .take(6)
        .filter_map(|e| {
            let video_id = tag(e, "yt:videoId")?.to_string();
            if !valid_video_id(&video_id) || e.contains("/shorts/") {
                return None;
            }
            Some(FeedItem {
                title: unescape(tag(e, "title")?),
                channel: channel.clone(),
                published: tag(e, "published").unwrap_or_default().to_string(),
                thumbnail: format!("https://i.ytimg.com/vi/{video_id}/mqdefault.jpg"),
                video_id,
            })
        })
        .collect()
}

// ───────────────────────── Commands for NOVA's UI ─────────────────────────

#[tauri::command]
pub fn history_list(store: State<'_, HistoryStore>, app: AppHandle) -> Vec<WatchEntry> {
    store.sorted(&active_profile(&app))
}

#[tauri::command]
pub fn history_remove(key: String, store: State<'_, HistoryStore>, app: AppHandle) {
    let profile = active_profile(&app);
    if let Ok(mut data) = store.data.lock() {
        data.entries.retain(|e| !(e.key == key && e.owned_by(&profile)));
    }
    store.dirty.store(true, Ordering::Release);
    store.flush();
    let _ = app.emit("history-changed", ());
}

#[tauri::command]
pub fn history_clear(store: State<'_, HistoryStore>, app: AppHandle) {
    // Only the active profile's history.
    let profile = active_profile(&app);
    if let Ok(mut data) = store.data.lock() {
        data.entries.retain(|e| !e.owned_by(&profile));
    }
    if let Ok(mut feed) = store.feed.lock() {
        *feed = None;
    }
    store.dirty.store(true, Ordering::Release);
    store.flush();
    let _ = app.emit("history-changed", ());
}

/// Latest uploads from the channels you watch most recently.
#[tauri::command]
pub async fn youtube_feed(app: AppHandle) -> Result<Vec<FeedItem>, String> {
    let store = app.state::<HistoryStore>();
    let profile = active_profile(&app);
    if let Ok(feed) = store.feed.lock() {
        if let Some((at, owner, items)) = feed.as_ref() {
            if at.elapsed() < FEED_TTL && owner == &profile {
                return Ok(items.clone());
            }
        }
    }
    let (channel_ids, watched): (Vec<String>, Vec<String>) = {
        let data = store.data.lock().map_err(|_| "busy")?;
        let mut entries: Vec<WatchEntry> = data.entries.iter().filter(|e| e.owned_by(&profile)).cloned().collect();
        entries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        let mut ids: Vec<String> = Vec::new();
        for e in &entries {
            if let Some(id) = e.channel_url.as_ref().and_then(|u| data.channels.get(u)) {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
            if ids.len() >= FEED_CHANNELS {
                break;
            }
        }
        (ids, entries.into_iter().map(|e| e.item_id).collect())
    };
    if channel_ids.is_empty() {
        return Ok(vec![]);
    }
    let items = tauri::async_runtime::spawn_blocking(move || {
        let handles: Vec<_> = channel_ids
            .into_iter()
            .map(|id| std::thread::spawn(move || channel_feed(&id)))
            .collect();
        let mut all: Vec<FeedItem> = handles.into_iter().flat_map(|h| h.join().unwrap_or_default()).collect();
        all.retain(|i| !watched.contains(&i.video_id));
        all.sort_by(|a, b| b.published.cmp(&a.published));
        all.truncate(24);
        all
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Ok(mut feed) = store.feed.lock() {
        *feed = Some((Instant::now(), profile, items.clone()));
    }
    Ok(items)
}

/// Opens a YouTube video in NOVA's TV player, optionally resuming at `position`.
#[tauri::command]
pub async fn play_youtube(video_id: String, position: Option<f64>, app: AppHandle) -> Result<(), String> {
    crate::profiles::require_youtube(&app.state::<crate::AppState>())?;
    if !valid_video_id(&video_id) {
        return Err("Vídeo no válido.".into());
    }
    let resume = position.filter(|p| p.is_finite() && *p > 5.0).map(|p| (p - 3.0).max(0.0));
    session::end(&app, false);
    let url = format!("https://www.youtube.com/tv#/watch?v={video_id}");
    let label = player::open_with_resume(&app, "YouTube", &url, Some((&video_id, resume.unwrap_or(0.0))))?;
    session::start(&app, "YouTube", session::Kind::Player(label));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn video_ids() {
        assert!(valid_video_id("jNQXAC9IVRw"));
        assert!(!valid_video_id("jNQXAC9IVR"));
        assert!(!valid_video_id("jNQXAC9IV<w"));
    }

    /// Network: public RSS of a known channel and @handle → channel id.
    #[test]
    #[ignore = "needs internet"]
    fn youtube_public_data() {
        let items = channel_feed("UC4QobU6STFB0P71PMvOGN5A");
        println!("feed: {:?}", items.iter().map(|i| (&i.video_id, &i.title, &i.channel)).collect::<Vec<_>>());
        assert!(items.iter().any(|i| i.video_id == "jNQXAC9IVRw"));
        let html = http_get("https://www.youtube.com/@jawed").unwrap();
        assert!(html.contains("https://www.youtube.com/channel/UC4QobU6STFB0P71PMvOGN5A"));
    }
}
