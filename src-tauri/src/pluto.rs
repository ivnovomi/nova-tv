//! Pluto TV: free, ad-supported channels (Bob Esponja, iCarly, Dragon Ball,
//! MTV, cine, series…), legal and gratis, in the viewer's own region. NOVA uses
//! the same public web API as pluto.tv.
//!
//! Pluto only lets its own website read its playlists (CORS), so playlists go
//! through `livetv_playlist`, which also signs them with the current session.
//! The session token never leaves Rust and is never cached on disk; the video
//! segments themselves are loaded directly by the player.

use crate::config::now_secs;
use crate::livetv::{Channel, LiveTv, Program, Source};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const BOOT: &str = "https://boot.pluto.tv/v4/start";
const GUIDE: &str = "https://service-channels.clusters.pluto.tv/v2/guide";
/// Pluto channel 220 becomes NOVA channel 3220.
pub const FIRST_NUMBER: u32 = 3000;
const CHANNELS_TTL: u64 = 12 * 3600;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

#[derive(Clone)]
struct Session {
    token: String,
    params: String,
    stitcher: String,
    region: String,
    expires: u64,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// One anonymous device id per run, like a browser tab.
fn client_id() -> &'static str {
    static ID: OnceLock<String> = OnceLock::new();
    ID.get_or_init(|| {
        let mut b = [0u8; 16];
        let _ = getrandom::fill(&mut b);
        let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
        format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
    })
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(12)))
        .http_status_as_error(false)
        .build()
        .into()
}

/// GET → (status, body).
fn get(url: &str, token: Option<&str>) -> Result<(u16, String), String> {
    let mut req = agent().get(url).header("User-Agent", UA);
    if let Some(t) = token {
        req = req.header("Authorization", &format!("Bearer {t}"));
    }
    let mut res = req.call().map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let body = res.body_mut().with_config().limit(16 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
    Ok((status, body))
}

fn session(force: bool) -> Result<Session, String> {
    if !force {
        if let Some(s) = SESSION.lock().ok().and_then(|s| s.clone()).filter(|s| now_secs() < s.expires) {
            return Ok(s);
        }
    }
    let url = format!(
        "{BOOT}?appName=web&appVersion=9.0.0&deviceVersion=140.0.0&deviceModel=web&deviceMake=chrome&deviceType=web&clientID={}&clientModelNumber=1.0.0&serverSideAds=false",
        client_id()
    );
    let (status, body) = get(&url, None)?;
    if status != 200 {
        return Err(format!("Pluto TV no responde (HTTP {status})"));
    }
    let json: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    let text = |v: &Value| v.as_str().map(String::from);
    let s = Session {
        token: text(&json["sessionToken"]).ok_or("Pluto TV no dio sesión")?,
        params: text(&json["stitcherParams"]).unwrap_or_default(),
        stitcher: text(&json["servers"]["stitcher"]).filter(|s| s.starts_with("https://")).ok_or("Pluto TV sin servidor de emisión")?,
        region: text(&json["session"]["activeRegion"]).unwrap_or_else(|| "ES".into()),
        expires: now_secs() + json["refreshInSec"].as_u64().unwrap_or(8 * 3600).saturating_sub(600),
    };
    if let Ok(mut slot) = SESSION.lock() {
        *slot = Some(s.clone());
    }
    Ok(s)
}

fn api(path: &str) -> Result<Value, String> {
    let s = session(false)?;
    let (mut status, mut body) = get(&format!("{GUIDE}/{path}"), Some(&s.token))?;
    if status == 401 || status == 403 {
        let s = session(true)?;
        (status, body) = get(&format!("{GUIDE}/{path}"), Some(&s.token))?;
    }
    if status != 200 {
        return Err(format!("Pluto TV: HTTP {status}"));
    }
    serde_json::from_str(&body).map_err(|e| e.to_string())
}

/// Pluto's own categories → NOVA's themes (for "Infantil", "Cine"… across sources).
fn theme(category: &str) -> &'static str {
    let c = category.to_lowercase();
    if c.contains("infantil") || c.contains("anime") || c.contains("kids") {
        "Infantil"
    } else if c.contains("cine") || c.contains("ficción") || c.contains("terror") || c.contains("pelí") {
        "Cine"
    } else if c.contains("noticia") {
        "Noticias"
    } else if c.contains("deporte") {
        "Deportes"
    } else if c.contains("música") {
        "Música"
    } else if c.contains("cultura") || c.contains("document") || c.contains("natural") {
        "Documentales"
    } else if c.contains("series") || c.contains("polic") || c.contains("crimen") {
        "Series"
    } else {
        "Entretenimiento"
    }
}

/// Promotional or seasonal rows: not a channel's real home.
fn promo(category: &str) -> bool {
    let c = category.to_lowercase();
    ["nuevo", "halloween", "navidad", "destacado", "verano"].iter().any(|p| c.contains(p))
}

fn fetch_channels() -> Result<Vec<Channel>, String> {
    let s = session(false)?;
    let channels = api("channels?channelIds=&offset=0&limit=1000&sort=number:asc")?;
    let categories = api("categories")?;
    let mut cats: HashMap<String, Vec<String>> = HashMap::new();
    for cat in categories["data"].as_array().into_iter().flatten() {
        let Some(name) = cat["name"].as_str() else { continue };
        for id in cat["channelIDs"].as_array().into_iter().flatten().filter_map(|v| v.as_str()) {
            cats.entry(id.to_string()).or_default().push(name.to_string());
        }
    }
    let mut out = Vec::new();
    for ch in channels["data"].as_array().into_iter().flatten() {
        let (Some(id), Some(name), Some(number)) = (ch["id"].as_str(), ch["name"].as_str(), ch["number"].as_u64()) else { continue };
        if ch["plutoOfficeOnly"].as_bool() == Some(true) || ch["isStitched"].as_bool() == Some(false) || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let names = cats.get(id).cloned().unwrap_or_default();
        let group = names.iter().find(|n| !promo(n)).or(names.first()).cloned().unwrap_or_else(|| "Pluto TV".into());
        let mut categories: Vec<String> = names.iter().filter(|n| !promo(n)).map(|n| theme(n).to_string()).collect();
        categories.dedup();
        if categories.is_empty() {
            categories.push(theme(&group).to_string());
        }
        let logo = ch["images"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|i| i["type"].as_str() == Some("colorLogoPNG"))
            .and_then(|i| i["url"].as_str())
            .filter(|u| u.starts_with("https://"))
            .map(String::from);
        out.push(Channel {
            source: Source::Fast,
            country: Some(s.region.clone()),
            categories,
            id: format!("pluto:{id}"),
            number: FIRST_NUMBER + number as u32,
            name: name.trim().to_string(),
            logo,
            group,
            region: "Pluto TV".into(),
            streams: vec![format!("{}/v2/stitch/hls/channel/{id}/master.m3u8", s.stitcher)],
            epg_id: Some(format!("pluto:{id}")),
            geo: false,
        });
    }
    Ok(out)
}

/// Pluto channels, cached on disk for 12 h (without any session data).
pub fn channels(tv: &LiveTv) -> (Vec<Channel>, Option<String>) {
    let cached = tv.read::<Vec<Channel>>("pluto.json");
    if let Some(c) = cached.as_ref().filter(|c| now_secs().saturating_sub(c.fetched_at) < CHANNELS_TTL) {
        return (c.data.clone(), None);
    }
    match fetch_channels() {
        Ok(list) if !list.is_empty() => {
            tv.write("pluto.json", &list);
            (list, None)
        }
        Ok(_) => (cached.map(|c| c.data).unwrap_or_default(), Some("Pluto TV no tiene canales en tu región.".into())),
        Err(e) => (cached.map(|c| c.data).unwrap_or_default(), Some(e)),
    }
}

// ───────────────────────── Guide ─────────────────────────

/// Days since 1970-01-01 for a civil date (Howard Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// "2026-10-15T23:37:01.000Z" → Unix seconds.
pub(crate) fn iso_secs(s: &str) -> Option<i64> {
    let n = |r: std::ops::Range<usize>| s.get(r)?.parse::<i64>().ok();
    if s.len() < 19 {
        return None;
    }
    Some(days_from_civil(n(0..4)?, n(5..7)?, n(8..10)?) * 86400 + n(11..13)? * 3600 + n(14..16)? * 60 + n(17..19)?)
}

fn iso_hour(secs: i64) -> String {
    let (y, m, d) = civil_from_days(secs.div_euclid(86400));
    format!("{y:04}-{m:02}-{d:02}T{:02}:00:00.000Z", secs.rem_euclid(86400) / 3600)
}

/// What's on the next 6 hours, keyed by `pluto:<id>` (the channels' epg_id).
pub fn guide(channels: &[Channel]) -> HashMap<String, Vec<Program>> {
    let ids: Vec<&str> = channels.iter().filter_map(|c| c.id.strip_prefix("pluto:")).collect();
    let start = iso_hour(now_secs() as i64);
    let mut out = HashMap::new();
    for batch in ids.chunks(60) {
        let Ok(json) = api(&format!("timelines?start={start}&channelIds={}&duration=360", batch.join(","))) else { continue };
        for ch in json["data"].as_array().into_iter().flatten() {
            let Some(id) = ch["channelId"].as_str() else { continue };
            let programs: Vec<Program> = ch["timelines"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|t| {
                    let ep = &t["episode"];
                    let text = |v: &Value| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(String::from);
                    Some(Program {
                        start: iso_secs(t["start"].as_str()?)?,
                        end: iso_secs(t["stop"].as_str()?)?,
                        title: text(&t["title"])?,
                        description: text(&ep["description"]).map(|d| d.chars().take(320).collect()),
                        genre: text(&ep["genre"]),
                        image: text(&ep["thumbnail"]["path"]).filter(|u| u.starts_with("https://")),
                    })
                })
                .collect();
            if !programs.is_empty() {
                out.insert(format!("pluto:{id}"), programs);
            }
        }
    }
    out
}

// ───────────────────────── Playlists ─────────────────────────

fn host(url: &str) -> Option<&str> {
    url.strip_prefix("https://")?.split(['/', '?']).next()
}

/// Pluto's own playlist servers (the only ones the proxy will fetch).
pub fn is_pluto(url: &str) -> bool {
    host(url).is_some_and(|h| h.ends_with(".pluto.tv") && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-'))
}

/// A channel's master playlist with the current session attached.
pub fn sign(url: &str, force: bool) -> Option<String> {
    if !is_pluto(url) || url.contains('?') || !url.ends_with("/master.m3u8") {
        return None;
    }
    let s = session(force).ok()?;
    Some(format!("{url}?{}&jwt={}&masterJWTPassthrough=true", s.params, s.token))
}

/// Fetches a Pluto playlist for the player (signing master playlists).
#[tauri::command]
pub async fn livetv_playlist(url: String) -> Result<String, String> {
    if url.len() > 4096 || !is_pluto(&url) || url.contains(char::is_whitespace) {
        return Err("Lista no permitida".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let attempt = |force: bool| get(&sign(&url, force).unwrap_or_else(|| url.clone()), None);
        let (mut status, mut body) = attempt(false)?;
        if matches!(status, 401 | 403) && url.ends_with("/master.m3u8") {
            (status, body) = attempt(true)?;
        }
        if status != 200 {
            return Err(format!("HTTP {status}"));
        }
        if !body.trim_start().starts_with("#EXTM3U") {
            return Err("HTTP 404".into());
        }
        Ok(body)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(iso_secs("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(iso_secs("2026-10-15T23:37:01.000Z"), Some(1792107421));
        assert_eq!(iso_hour(1792107421), "2026-10-15T23:00:00.000Z");
    }

    #[test]
    fn only_pluto_hosts() {
        assert!(is_pluto("https://cfd-v4-service-channel-stitcher-use1-1.prd.pluto.tv/v2/stitch/hls/channel/abc/master.m3u8"));
        assert!(!is_pluto("https://evil.com/?x=.pluto.tv"));
        assert!(!is_pluto("https://pluto.tv.evil.com/x.m3u8"));
        assert!(!is_pluto("http://a.pluto.tv/x.m3u8"));
    }

    #[test]
    #[ignore = "needs internet"]
    fn pluto_live() {
        let list = fetch_channels().unwrap();
        let kids: Vec<_> = list.iter().filter(|c| c.categories.iter().any(|k| k == "Infantil")).map(|c| format!("{} {}", c.number, c.name)).collect();
        println!("{} canales Pluto; infantiles: {kids:?}", list.len());
        assert!(list.len() > 50);
        let g = guide(&list[..5]);
        println!("guía para {} canales: {:?}", g.len(), g.values().next().and_then(|p| p.first()).map(|p| &p.title));
        let agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(10))).build().into();
        let ok = list.iter().take(8).filter(|c| crate::livetv_health::probe_for_test(&agent, &c.streams[0]) == "ok").count();
        println!("{ok}/8 con señal");
        assert!(ok > 0);
    }
}
