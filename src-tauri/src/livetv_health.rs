//! Channel health: NOVA checks every channel the way the player would (master
//! playlist → first variant → real media segments) so dead or blocked streams can
//! be hidden. Runs in the background with a small worker pool; results are saved
//! and re-checked on a schedule (good: daily, dead: 6 h, blocked: hourly).

use crate::config::now_secs;
use crate::livetv::Channel;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const WORKERS: usize = 48;
const TIMEOUT: Duration = Duration::from_secs(5);
const FRESH_OK: u64 = 24 * 3600;
const FRESH_DEAD: u64 = 6 * 3600;
const FRESH_BLOCKED: u64 = 3600;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Health {
    Ok,
    Dead,
    /// 401/403/451: VPN, region or subscription. May work on another network.
    Blocked,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HealthEntry {
    pub status: Health,
    pub checked_at: u64,
    /// Index of the first stream that worked (the player starts there).
    pub stream: u8,
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub running: bool,
    pub done: usize,
    pub total: usize,
    pub ok: usize,
    pub dead: usize,
    pub blocked: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct HealthEvent {
    progress: Progress,
    updates: Vec<(String, HealthEntry)>,
}

pub struct HealthStore {
    path: PathBuf,
    map: Mutex<HashMap<String, HealthEntry>>,
    running: AtomicBool,
    progress: Mutex<Progress>,
}

impl HealthStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("livetv").join("health.json");
        let map = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, map: Mutex::new(map), running: AtomicBool::new(false), progress: Mutex::new(Progress::default()) }
    }

    fn save(&self) {
        let Ok(json) = self.map.lock().map(|m| serde_json::to_string(&*m).unwrap_or_default()) else { return };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    fn is_fresh(&self, id: &str, now: u64) -> bool {
        self.map.lock().ok().and_then(|m| m.get(id).cloned()).is_some_and(|e| {
            let ttl = match e.status {
                Health::Ok => FRESH_OK,
                Health::Dead => FRESH_DEAD,
                Health::Blocked => FRESH_BLOCKED,
            };
            now.saturating_sub(e.checked_at) < ttl
        })
    }

    pub fn status(&self, id: &str) -> Option<Health> {
        self.map.lock().ok()?.get(id).map(|e| e.status)
    }

    fn counts(&self) -> (usize, usize, usize) {
        let Ok(m) = self.map.lock() else { return (0, 0, 0) };
        m.values().fold((0, 0, 0), |(o, d, b), e| match e.status {
            Health::Ok => (o + 1, d, b),
            Health::Dead => (o, d + 1, b),
            Health::Blocked => (o, d, b + 1),
        })
    }
}

enum Probe {
    Ok,
    Dead,
    Blocked,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(TIMEOUT))
        .http_status_as_error(false)
        .build()
        .into()
}

fn fetch(agent: &ureq::Agent, url: &str) -> Result<String, Probe> {
    let mut res = agent
        .get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")
        .call()
        .map_err(|_| Probe::Dead)?;
    match res.status().as_u16() {
        200..=299 => res.body_mut().with_config().limit(512 * 1024).read_to_string().map_err(|_| Probe::Dead),
        401 | 403 | 451 => Err(Probe::Blocked),
        _ => Err(Probe::Dead),
    }
}

/// Resolves a playlist line against the playlist's own URL.
fn resolve(base: &str, line: &str) -> String {
    if line.starts_with("http://") || line.starts_with("https://") {
        return line.to_string();
    }
    let without_query = base.split('?').next().unwrap_or(base);
    if let Some(rest) = line.strip_prefix('/') {
        let origin_end = without_query.find("://").map(|i| i + 3).and_then(|i| without_query[i..].find('/').map(|j| i + j)).unwrap_or(without_query.len());
        return format!("{}/{}", &without_query[..origin_end], rest);
    }
    match without_query.rfind('/') {
        Some(i) => format!("{}/{}", &without_query[..i], line),
        None => line.to_string(),
    }
}

/// An official YouTube live stream: on air right now, and allowed in embedded players.
fn probe_youtube(agent: &ureq::Agent, stream: &str) -> Probe {
    let Some(rest) = stream.strip_prefix("youtube:") else { return Probe::Dead };
    let get = |url: &str| -> Option<String> {
        let mut res = agent
            .get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")
            .header("Accept-Language", "es-ES,es;q=0.9")
            // Embeds need a referrer (NOVA's own); SOCS skips the EU cookie page on watch pages.
            .header("Referer", "http://tauri.localhost/")
            .header("Cookie", "SOCS=CAI")
            .call()
            .ok()?;
        if res.status().as_u16() != 200 {
            return None;
        }
        res.body_mut().with_config().limit(6 * 1024 * 1024).read_to_string().ok()
    };
    // A channel: ask the embedded player what it would play now (the channel page needs cookie consent).
    if let Some(channel) = rest.strip_prefix("channel:") {
        let Some(page) = get(&format!("https://www.youtube.com/embed/live_stream?channel={channel}")) else { return Probe::Dead };
        let Some(i) = page.find("embedded_player_response") else { return Probe::Dead };
        let response = &page[i..page.len().min(i + 30_000)];
        if response.contains("reason\\\":") {
            return Probe::Dead;
        }
        let marker = "videoId\\\":\\\"";
        let live = response.match_indices(marker).any(|(at, _)| {
            let id = response.get(at + marker.len()..at + marker.len() + 11).unwrap_or("");
            id != "live_stream" && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        });
        return if live { Probe::Ok } else { Probe::Dead };
    }
    let Some(page) = get(&format!("https://www.youtube.com/watch?v={rest}")) else { return Probe::Dead };
    if page.contains("\"playableInEmbed\":false") {
        Probe::Blocked
    } else if page.contains("\"isLiveNow\":true") {
        Probe::Ok
    } else {
        Probe::Dead
    }
}

/// Playable = a media playlist with segments is reachable (master → first variant).
fn probe_stream(agent: &ureq::Agent, url: &str) -> Probe {
    if url.starts_with("youtube:") {
        return probe_youtube(agent, url);
    }
    if let Some(login) = url.strip_prefix("twitch:") {
        return match crate::twitch::is_live(agent, login) {
            Some(true) => Probe::Ok,
            _ => Probe::Dead,
        };
    }
    let signed = crate::pluto::sign(url, false);
    let url = signed.as_deref().unwrap_or(url);
    let text = match fetch(agent, url) {
        Ok(t) => t,
        Err(p) => return p,
    };
    if !text.trim_start().starts_with("#EXTM3U") {
        return Probe::Dead;
    }
    if text.contains("#EXTINF") || text.contains("#EXT-X-TARGETDURATION") {
        return Probe::Ok;
    }
    let mut lines = text.lines().map(str::trim);
    let variant = loop {
        match lines.next() {
            Some(l) if l.starts_with("#EXT-X-STREAM-INF") => break lines.find(|l| !l.is_empty() && !l.starts_with('#')),
            Some(_) => continue,
            None => break None,
        }
    };
    let Some(variant) = variant else { return Probe::Dead };
    match fetch(agent, &resolve(url, variant)) {
        Ok(t) if t.contains("#EXTINF") || t.contains("#EXT-X-TARGETDURATION") => Probe::Ok,
        Ok(_) => Probe::Dead,
        Err(p) => p,
    }
}

#[cfg(test)]
pub fn probe_for_test(agent: &ureq::Agent, url: &str) -> &'static str {
    match probe_stream(agent, url) {
        Probe::Ok => "ok",
        Probe::Dead => "dead",
        Probe::Blocked => "blocked",
    }
}

fn probe_channel(agent: &ureq::Agent, channel: &Channel) -> HealthEntry {
    let mut blocked = false;
    for (i, url) in channel.streams.iter().enumerate() {
        match probe_stream(agent, url) {
            Probe::Ok => return HealthEntry { status: Health::Ok, checked_at: now_secs(), stream: i as u8 },
            Probe::Blocked => blocked = true,
            Probe::Dead => {}
        }
    }
    HealthEntry { status: if blocked { Health::Blocked } else { Health::Dead }, checked_at: now_secs(), stream: 0 }
}

/// Checks every channel that isn't fresh, priority ids first. No-op if running.
pub fn start(app: &AppHandle, channels: Vec<Channel>, priority: Vec<String>, force: bool) {
    let store = app.state::<HealthStore>();
    if store.running.swap(true, Ordering::AcqRel) {
        return;
    }
    let now = now_secs();
    let mut queue: Vec<Channel> = channels.into_iter().filter(|c| force || !store.is_fresh(&c.id, now)).collect();
    // Favourites/last first, then Spain's TDT, then Spanish-speaking world, then the rest.
    let rank = |c: &Channel| -> u8 {
        if priority.contains(&c.id) {
            0
        } else if (c.id.starts_with("tdt:") && c.country.as_deref() == Some("ES")) || c.id.starts_with("pluto:") {
            1
        } else if c.id.starts_with("m3u:") {
            2
        } else if matches!(c.country.as_deref(), Some("ES" | "MX" | "AR" | "CO" | "CL" | "PE" | "VE" | "EC" | "US")) {
            3
        } else {
            4
        }
    };
    queue.sort_by_key(rank);
    let total = queue.len();
    let (ok, dead, blocked) = store.counts();
    if let Ok(mut p) = store.progress.lock() {
        *p = Progress { running: total > 0, done: 0, total, ok, dead, blocked };
    }
    if total == 0 {
        store.running.store(false, Ordering::Release);
        return;
    }

    let queue = Arc::new(Mutex::new(VecDeque::from(queue)));
    let pending: Arc<Mutex<Vec<(String, HealthEntry)>>> = Arc::new(Mutex::new(Vec::new()));
    let done = Arc::new(std::sync::atomic::AtomicUsize::new(0));

    for _ in 0..WORKERS {
        let (queue, pending, done, app) = (queue.clone(), pending.clone(), done.clone(), app.clone());
        std::thread::spawn(move || {
            let agent = agent();
            loop {
                let Some(channel) = queue.lock().ok().and_then(|mut q| q.pop_front()) else { return };
                let entry = probe_channel(&agent, &channel);
                let store = app.state::<HealthStore>();
                if let Ok(mut m) = store.map.lock() {
                    m.insert(channel.id.clone(), entry.clone());
                }
                if let Ok(mut p) = pending.lock() {
                    p.push((channel.id, entry));
                }
                done.fetch_add(1, Ordering::AcqRel);
            }
        });
    }

    // Reporter: batches updates for the UI and saves progress periodically.
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<HealthStore>();
        let mut last_save = Instant::now();
        loop {
            std::thread::sleep(Duration::from_millis(1500));
            let finished = done.load(Ordering::Acquire);
            let updates = pending.lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default();
            let (ok, dead, blocked) = store.counts();
            let running = finished < total;
            let progress = Progress { running, done: finished, total, ok, dead, blocked };
            if let Ok(mut p) = store.progress.lock() {
                *p = progress.clone();
            }
            if !updates.is_empty() || !running {
                let _ = app.emit("livetv-health", HealthEvent { progress, updates });
            }
            if !running || last_save.elapsed() > Duration::from_secs(20) {
                store.save();
                last_save = Instant::now();
            }
            if !running {
                store.running.store(false, Ordering::Release);
                return;
            }
        }
    });
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthSnapshot {
    map: HashMap<String, HealthEntry>,
    progress: Progress,
}

#[tauri::command]
pub fn livetv_health(store: State<'_, HealthStore>) -> HealthSnapshot {
    let (ok, dead, blocked) = store.counts();
    let mut progress = store.progress.lock().map(|p| p.clone()).unwrap_or_default();
    progress.ok = ok;
    progress.dead = dead;
    progress.blocked = blocked;
    HealthSnapshot { map: store.map.lock().map(|m| m.clone()).unwrap_or_default(), progress }
}

/// The player saw a channel play (or fail): record it right away.
#[tauri::command]
pub fn livetv_report(id: String, ok: bool, blocked: bool, stream: u8, app: AppHandle) {
    let store = app.state::<HealthStore>();
    let entry = HealthEntry {
        status: if ok { Health::Ok } else if blocked { Health::Blocked } else { Health::Dead },
        checked_at: now_secs(),
        stream,
    };
    if let Ok(mut m) = store.map.lock() {
        m.insert(id.chars().take(200).collect(), entry);
    }
    store.save();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_relative_variants() {
        assert_eq!(resolve("https://a.tv/live/master.m3u8?t=1", "720p.m3u8"), "https://a.tv/live/720p.m3u8");
        assert_eq!(resolve("https://a.tv/live/master.m3u8", "/hls/720p.m3u8"), "https://a.tv/hls/720p.m3u8");
        assert_eq!(resolve("https://a.tv/x.m3u8", "https://cdn.tv/v.m3u8"), "https://cdn.tv/v.m3u8");
    }

    /// Real-world sample: how many channels actually have signal right now.
    #[test]
    #[ignore = "needs internet; slow"]
    fn sample_of_real_channels() {
        let channels = crate::livetv::sample_channels(300);
        let queue = Arc::new(Mutex::new(VecDeque::from(channels)));
        let results = Arc::new(Mutex::new((0, 0, 0)));
        let handles: Vec<_> = (0..WORKERS)
            .map(|_| {
                let (queue, results) = (queue.clone(), results.clone());
                std::thread::spawn(move || {
                    let agent = agent();
                    while let Some(c) = queue.lock().unwrap().pop_front() {
                        let e = probe_channel(&agent, &c);
                        let mut r = results.lock().unwrap();
                        match e.status {
                            Health::Ok => r.0 += 1,
                            Health::Dead => r.1 += 1,
                            Health::Blocked => r.2 += 1,
                        }
                    }
                })
            })
            .collect();
        let start = Instant::now();
        handles.into_iter().for_each(|h| h.join().unwrap());
        let (ok, dead, blocked) = *results.lock().unwrap();
        println!("con señal {ok} · sin señal {dead} · bloqueados {blocked} · {:.0?}", start.elapsed());
    }

    #[test]
    #[ignore = "needs internet"]
    fn probes_real_streams() {
        let agent = agent();
        let trece = probe_stream(&agent, "https://play.cdn.enetres.net/091DB7AFBD77442B9BA2F141DCC182F5021/021/playlist.m3u8");
        let missing = probe_stream(&agent, "https://example.com/nope.m3u8");
        assert!(matches!(trece, Probe::Ok), "TRECE should be live");
        assert!(matches!(missing, Probe::Dead));
    }
}
