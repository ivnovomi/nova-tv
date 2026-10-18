//! Ajustes → "Estado de las fuentes": is each external source NOVA depends on
//! working? Shows real data (channels, signal, last download, last error) and
//! can check every server live, with its response time. Nothing here changes
//! any setting; it only reads and asks.

use crate::livetv::{LiveTv, Source, IPTV_ORG, TDT_CHANNELS, TDT_EPG};
use crate::livetv_health::{Health, HealthStore};
use crate::AppState;
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SourceStatus {
    key: &'static str,
    name: &'static str,
    /// What it brings to NOVA.
    role: &'static str,
    enabled: bool,
    channels: Option<usize>,
    ok: usize,
    dead: usize,
    blocked: usize,
    /// Last successful download (Unix seconds).
    updated_at: Option<u64>,
    error: Option<String>,
}

fn health_counts(tv: &LiveTv, health: &HealthStore, source: Source) -> (usize, usize, usize, usize) {
    let channels: Vec<_> = tv.channels_now().into_iter().filter(|c| c.source == source).collect();
    let mut counts = (channels.len(), 0, 0, 0);
    for c in &channels {
        match health.status(&c.id) {
            Some(Health::Ok) => counts.1 += 1,
            Some(Health::Dead) => counts.2 += 1,
            Some(Health::Blocked) => counts.3 += 1,
            None => {}
        }
    }
    counts
}

/// What NOVA knows about each source right now (no network).
#[tauri::command]
pub fn sources_status(app: AppHandle) -> Vec<SourceStatus> {
    let tv = app.state::<LiveTv>();
    let health = app.state::<HealthStore>();
    let config = app.state::<AppState>().config.snapshot().live_tv;
    let errors = tv.errors.lock().map(|e| e.clone()).unwrap_or_default();
    let error = |k: &str| errors.get(k).cloned();

    // `cache`: the file the list is saved in (Twitch lives in memory, playlists have one file each).
    let channel_source = |key: &'static str, name: &'static str, role: &'static str, source: Source, enabled: bool, cache: Option<&str>| {
        let (channels, ok, dead, blocked) = health_counts(&tv, &health, source);
        SourceStatus { key, name, role, enabled, channels: Some(channels), ok, dead, blocked, updated_at: cache.and_then(|c| tv.cached_at(c)), error: error(key) }
    };

    vec![
        channel_source("tdt", "TDTChannels", "TDT de España e internacional", Source::Tdt, true, Some("channels-v2.json")),
        SourceStatus { key: "epg", name: "Guía de TDTChannels", role: "Programación de la TDT", enabled: true, updated_at: tv.cached_at("epg.json"), error: error("epg"), ..Default::default() },
        channel_source("twitch", "Twitch", "Directos aptos para todos", Source::Twitch, !config.twitch_disabled, None),
        channel_source("world", "iptv-org", "Canales públicos del mundo", Source::World, !config.world_disabled, Some("world.json")),
        channel_source("playlist", "Tus listas M3U", "Listas añadidas por ti", Source::Playlist, !config.playlists.is_empty(), None),
        channel_source("plugins", "Plugins", "Canales de tus plugins (Pluto TV…)", Source::Plugin, true, None),
    ]
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    key: &'static str,
    name: &'static str,
    ok: bool,
    /// Response time in milliseconds.
    ms: u64,
    detail: String,
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(8))).http_status_as_error(false).build().into()
}

/// One HTTP check: reachable, and not refused.
fn http(key: &'static str, name: &'static str, url: &str, head: bool) -> Probe {
    let start = Instant::now();
    let agent = agent();
    let result = if head { agent.head(url).call() } else { agent.get(url).header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)").call() };
    let ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(res) => {
            let code = res.status().as_u16();
            let (ok, detail) = match code {
                200..=399 => (true, "Responde".to_string()),
                401 | 403 | 451 => (false, format!("Rechaza la conexión ({code}): ¿VPN o región?")),
                _ => (false, format!("Error del servidor ({code})")),
            };
            Probe { key, name, ok, ms, detail }
        }
        Err(e) => Probe { key, name, ok: false, ms, detail: format!("Sin conexión: {e}") },
    }
}

fn timed(key: &'static str, name: &'static str, f: impl FnOnce() -> Result<String, String>) -> Probe {
    let start = Instant::now();
    let result = f();
    let ms = start.elapsed().as_millis() as u64;
    match result {
        Ok(detail) => Probe { key, name, ok: true, ms, detail },
        Err(e) => Probe { key, name, ok: false, ms, detail: e },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "needs internet"]
    fn every_source_answers() {
        let world = format!("{IPTV_ORG}/streams.json");
        let probes = [
            http("tdt", "TDTChannels", TDT_CHANNELS, true),
            http("epg", "Guía", TDT_EPG, true),
            timed("twitch", "Twitch", || crate::twitch::probe().map(|_| "Responde".into())),
            http("world", "iptv-org", &world, true),
            http("youtube", "YouTube", "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&format=json", false),
            http("steam", "Steam", "https://store.steampowered.com/api/appdetails?appids=10&filters=basic", false),
        ];
        for p in &probes {
            println!("{:<12} {:>5} ms  {}  {}", p.name, p.ms, if p.ok { "OK " } else { "MAL" }, p.detail);
        }
    }
}

/// "Comprobar ahora": asks every server, in parallel, if it answers.
#[tauri::command]
pub async fn sources_probe() -> Vec<Probe> {
    tauri::async_runtime::spawn_blocking(|| {
        let world = format!("{IPTV_ORG}/streams.json");
        let checks: Vec<Box<dyn FnOnce() -> Probe + Send>> = vec![
            Box::new(|| http("tdt", "TDTChannels", TDT_CHANNELS, true)),
            Box::new(|| http("epg", "Guía de TDTChannels", TDT_EPG, true)),
            Box::new(|| timed("twitch", "Twitch", || crate::twitch::probe().map(|_| "Responde".to_string()))),
            Box::new(move || http("world", "iptv-org", &world, true)),
            Box::new(|| http("youtube", "YouTube", "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=jNQXAC9IVRw&format=json", false)),
            Box::new(|| http("steam", "Tienda de Steam", "https://store.steampowered.com/api/appdetails?appids=10&filters=basic", false)),
        ];
        let handles: Vec<_> = checks.into_iter().map(std::thread::spawn).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).collect()
    })
    .await
    .unwrap_or_default()
}
