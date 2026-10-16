//! Live TV: free-to-air channels from TDTChannels (a public list of each
//! broadcaster's own official streams, with an EPG) plus the user's own M3U
//! playlists. Only HTTPS HLS streams are used. Everything is cached on disk so
//! the guide keeps working when the list server is down.

use crate::config::{new_id, now_secs, Playlist};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

pub(crate) const TDT_CHANNELS: &str = "https://www.tdtchannels.com/lists/tv.json";
pub(crate) const TDT_EPG: &str = "https://www.tdtchannels.com/epg/TV.json";
const CHANNELS_TTL: u64 = 12 * 3600;
const EPG_TTL: u64 = 3 * 3600;
const PLUTO_EPG_TTL: u64 = 30 * 60;
const CUSTOM_FIRST_NUMBER: u32 = 1001;
const WORLD_FIRST_NUMBER: u32 = 5001;
const WORLD_TTL: u64 = 24 * 3600;
pub(crate) const IPTV_ORG: &str = "https://iptv-org.github.io/api";

/// Where a channel comes from.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    /// TDTChannels: official Spanish free-to-air streams (with guide).
    #[default]
    Tdt,
    /// iptv-org: worldwide publicly available channels.
    World,
    /// The user's own M3U playlist.
    Playlist,
    /// Free ad-supported TV (Pluto TV).
    Fast,
    /// Twitch live streams for everyone.
    Twitch,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    #[serde(default)]
    pub source: Source,
    /// ISO-ish country code (iptv-org uses "UK" for the United Kingdom).
    #[serde(default)]
    pub country: Option<String>,
    /// Themes in Spanish ("Noticias", "Deportes"…), for browsing by topic.
    #[serde(default)]
    pub categories: Vec<String>,
    pub id: String,
    pub number: u32,
    pub name: String,
    pub logo: Option<String>,
    /// "Generalistas", "Deportivos", "Andalucía", or the playlist's group-title
    pub group: String,
    /// "España", "Internacional" or the playlist name
    pub region: String,
    /// HLS URLs, best first; the player falls back through them.
    pub streams: Vec<String>,
    pub epg_id: Option<String>,
    /// The broadcaster only allows viewers in Spain.
    pub geo: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Program {
    pub start: i64,
    pub end: i64,
    pub title: String,
    pub description: Option<String>,
    pub genre: Option<String>,
    pub image: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaylistInfo {
    id: String,
    name: String,
    url: String,
    channels: usize,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveTvData {
    channels: Vec<Channel>,
    favorites: Vec<String>,
    last_channel: Option<String>,
    playlists: Vec<PlaylistInfo>,
    /// Set when the free-to-air list couldn't be refreshed (cached copy in use, or none).
    tdt_error: Option<String>,
    /// Worldwide iptv-org catalogue switched on.
    world_enabled: bool,
    world_error: Option<String>,
    /// Pluto TV switched on.
    fast_enabled: bool,
    fast_error: Option<String>,
    /// Twitch live streams switched on.
    twitch_enabled: bool,
    twitch_error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
pub(crate) struct Cached<T> {
    pub fetched_at: u64,
    pub data: T,
}

pub struct LiveTv {
    dir: PathBuf,
    /// TDT guide only (3 h cache); Pluto and Twitch are added on each request.
    epg: Mutex<Option<(u64, HashMap<String, Vec<Program>>)>>,
    /// Pluto TV's guide (next 6 hours), cached for `PLUTO_EPG_TTL`.
    pluto_epg: Mutex<Option<(u64, HashMap<String, Vec<Program>>)>>,
    /// Last full channel list, for the phone remote.
    all: Mutex<Option<Vec<Channel>>>,
    /// Last error of each source ("tdt", "world", "pluto", "twitch", "epg"), for Ajustes → Estado de las fuentes.
    pub(crate) errors: Mutex<HashMap<&'static str, String>>,
}

impl LiveTv {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.join("livetv"),
            epg: Mutex::new(None),
            pluto_epg: Mutex::new(None),
            all: Mutex::new(None),
            errors: Mutex::new(HashMap::new()),
        }
    }

    /// When a cached list was last downloaded (Unix seconds), from the file itself.
    pub(crate) fn cached_at(&self, name: &str) -> Option<u64> {
        let modified = fs::metadata(self.dir.join(name)).ok()?.modified().ok()?;
        modified.duration_since(std::time::UNIX_EPOCH).ok().map(|d| d.as_secs())
    }

    fn note_error(&self, source: &'static str, error: &Option<String>) {
        if let Ok(mut e) = self.errors.lock() {
            match error {
                Some(msg) => e.insert(source, msg.clone()),
                None => e.remove(source),
            };
        }
    }

    pub(crate) fn channels_now(&self) -> Vec<Channel> {
        self.all.lock().ok().and_then(|a| a.clone()).unwrap_or_default()
    }

    pub(crate) fn read<T: for<'de> Deserialize<'de>>(&self, name: &str) -> Option<Cached<T>> {
        serde_json::from_str(&fs::read_to_string(self.dir.join(name)).ok()?).ok()
    }

    pub(crate) fn write<T: Serialize>(&self, name: &str, data: &T) {
        let _ = fs::create_dir_all(&self.dir);
        if let Ok(json) = serde_json::to_string(&Cached { fetched_at: now_secs(), data }) {
            let tmp = self.dir.join(format!("{name}.tmp"));
            if fs::write(&tmp, json).is_ok() {
                let _ = fs::rename(tmp, self.dir.join(name));
            }
        }
    }
}

fn get_text(url: &str) -> Result<String, String> {
    crate::net::agent()
        .get(url)
        .header("User-Agent", "NOVA-TV/0.1 (+https://github.com/LaQuay/TDTChannels)")
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(16 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())
}

fn usable_stream(url: &str) -> bool {
    url.starts_with("https://") && url.contains(".m3u8") && !url.contains('[') && !url.contains(' ') && url.len() < 1024
}

fn youtube_id(id: &str) -> bool {
    id.len() == 11 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// A broadcaster's official YouTube live stream → `youtube:<video>` or
/// `youtube:channel:<UC…>` (played with YouTube's own embedded player).
fn youtube_stream(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://www.youtube.com/").or_else(|| url.strip_prefix("https://youtube.com/"))?;
    let rest = rest.split(['?', '#']).next().unwrap_or(rest).trim_end_matches('/');
    if let Some(channel) = rest.strip_prefix("channel/").and_then(|c| c.strip_suffix("/live")) {
        return (channel.starts_with("UC") && channel.len() == 24 && channel.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .then(|| format!("youtube:channel:{channel}"));
    }
    if let Some(id) = rest.strip_prefix("live/") {
        return youtube_id(id).then(|| format!("youtube:{id}"));
    }
    let id = url.split("v=").nth(1)?.split('&').next()?;
    (rest == "watch" && youtube_id(id)).then(|| format!("youtube:{id}"))
}

fn slug(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

// ───────────────────────── TDTChannels ─────────────────────────

fn parse_tdt(json: &serde_json::Value) -> Vec<Channel> {
    let mut out = Vec::new();
    let mut number = 0;
    let countries = json.get("countries").and_then(|c| c.as_array()).cloned().unwrap_or_default();
    for country in &countries {
        let region = match country.get("name").and_then(|n| n.as_str()) {
            Some("Spain") => "España",
            _ => "Internacional",
        };
        for ambit in country.get("ambits").and_then(|a| a.as_array()).into_iter().flatten() {
            let group = ambit.get("name").and_then(|n| n.as_str()).unwrap_or("Otros").to_string();
            for ch in ambit.get("channels").and_then(|c| c.as_array()).into_iter().flatten() {
                let name = ch.get("name").and_then(|n| n.as_str()).unwrap_or_default().trim().to_string();
                let options = || ch.get("options").and_then(|o| o.as_array()).into_iter().flatten();
                let of = |format: &'static str| {
                    options().filter(move |o| o.get("format").and_then(|f| f.as_str()) == Some(format)).filter_map(|o| o.get("url")?.as_str())
                };
                // HLS first; official YouTube live streams as a fallback (or the only source).
                let streams: Vec<String> = of("m3u8")
                    .filter(|u| usable_stream(u))
                    .map(String::from)
                    .chain(of("youtube").filter_map(youtube_stream))
                    .collect();
                if name.is_empty() || streams.is_empty() {
                    continue;
                }
                number += 1;
                let extra = ch.get("extra_info").and_then(|e| e.as_array());
                out.push(Channel {
                    source: Source::Tdt,
                    country: (region == "España").then(|| "ES".to_string()),
                    categories: vec![],
                    id: format!("tdt:{}", slug(&format!("{group} {name}"))),
                    number,
                    logo: ch.get("logo").and_then(|l| l.as_str()).filter(|l| l.starts_with("https://")).map(String::from),
                    group: group.clone(),
                    region: region.into(),
                    streams,
                    epg_id: ch.get("epg_id").and_then(|e| e.as_str()).filter(|e| !e.is_empty()).map(String::from),
                    geo: extra.is_some_and(|e| e.iter().any(|x| x.as_str() == Some("GEO"))),
                    name,
                });
            }
        }
    }
    out
}

fn tdt_channels(tv: &LiveTv) -> (Vec<Channel>, Option<String>) {
    // v2: includes the official YouTube live streams.
    let cached = tv.read::<Vec<Channel>>("channels-v2.json");
    if let Some(c) = cached.as_ref().filter(|c| now_secs().saturating_sub(c.fetched_at) < CHANNELS_TTL) {
        return (c.data.clone(), None);
    }
    match get_text(TDT_CHANNELS).and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string())) {
        Ok(json) => {
            let channels = parse_tdt(&json);
            if !channels.is_empty() {
                tv.write("channels-v2.json", &channels);
            }
            (channels, None)
        }
        Err(e) => match cached {
            Some(c) => (c.data, Some(format!("Usando la lista guardada: {e}"))),
            None => (vec![], Some(format!("No se pudo descargar la lista de canales: {e}"))),
        },
    }
}

// ───────────────────────── M3U playlists ─────────────────────────

fn attr(line: &str, key: &str) -> Option<String> {
    let start = line.find(&format!("{key}=\""))? + key.len() + 2;
    let end = line[start..].find('"')? + start;
    Some(line[start..end].trim().to_string()).filter(|v| !v.is_empty())
}

pub fn parse_m3u(text: &str, playlist: &Playlist, first_number: u32) -> Vec<Channel> {
    let mut out = Vec::new();
    let mut pending: Option<String> = None;
    for line in text.lines().map(str::trim) {
        if line.starts_with("#EXTINF") {
            pending = Some(line.to_string());
        } else if !line.is_empty() && !line.starts_with('#') {
            let Some(info) = pending.take() else { continue };
            if !usable_stream(line) {
                continue;
            }
            let name = info.rsplit_once(',').map(|(_, n)| n.trim().to_string()).filter(|n| !n.is_empty()).unwrap_or_else(|| "Canal".into());
            let number = attr(&info, "tvg-chno").and_then(|n| n.parse().ok()).unwrap_or(first_number + out.len() as u32);
            out.push(Channel {
                source: Source::Playlist,
                country: None,
                categories: vec![],
                id: format!("m3u:{}:{}", playlist.id, out.len()),
                number,
                name,
                logo: attr(&info, "tvg-logo").filter(|l| l.starts_with("https://")),
                group: attr(&info, "group-title").unwrap_or_else(|| playlist.name.clone()),
                region: playlist.name.clone(),
                streams: vec![line.to_string()],
                epg_id: attr(&info, "tvg-id"),
                geo: false,
            });
        }
    }
    out
}

fn playlist_channels(tv: &LiveTv, playlist: &Playlist, first_number: u32) -> (Vec<Channel>, Option<String>) {
    let file = format!("m3u-{}.json", playlist.id);
    let cached = tv.read::<Vec<Channel>>(&file);
    if let Some(c) = cached.as_ref().filter(|c| now_secs().saturating_sub(c.fetched_at) < CHANNELS_TTL) {
        return (c.data.clone(), None);
    }
    match get_text(&playlist.url) {
        Ok(text) if text.trim_start().starts_with("#EXTM3U") => {
            let channels = parse_m3u(&text, playlist, first_number);
            tv.write(&file, &channels);
            (channels, None)
        }
        Ok(_) => (cached.map(|c| c.data).unwrap_or_default(), Some("La dirección no es una lista M3U.".into())),
        Err(e) => (cached.map(|c| c.data).unwrap_or_default(), Some(e)),
    }
}

// ───────────────────────── iptv-org (worldwide) ─────────────────────────

#[derive(Deserialize)]
struct IoStream {
    channel: Option<String>,
    url: String,
    #[serde(default)]
    quality: Option<String>,
    #[serde(default)]
    user_agent: Option<String>,
    #[serde(default)]
    referrer: Option<String>,
}

#[derive(Deserialize)]
struct IoChannel {
    id: String,
    name: String,
    #[serde(default)]
    country: Option<String>,
    #[serde(default)]
    categories: Vec<String>,
    #[serde(default)]
    is_nsfw: bool,
    #[serde(default)]
    closed: Option<String>,
}

#[derive(Deserialize)]
struct IoLogo {
    channel: String,
    url: String,
    #[serde(default)]
    in_use: bool,
}

#[derive(Deserialize)]
struct IoBlocked {
    channel: String,
}

fn category_es(id: &str) -> &'static str {
    match id {
        "news" => "Noticias",
        "sports" => "Deportes",
        "movies" => "Cine",
        "series" => "Series",
        "kids" | "family" | "animation" => "Infantil",
        "music" => "Música",
        "documentary" | "science" | "outdoor" => "Documentales",
        "entertainment" | "comedy" => "Entretenimiento",
        "classic" => "Clásicos",
        "culture" | "education" => "Cultura y educación",
        "lifestyle" | "cooking" | "travel" | "relax" | "auto" => "Estilo de vida",
        "business" | "weather" => "Economía y tiempo",
        "religious" => "Religión",
        "legislative" | "public" => "Institucional",
        "shop" => "Compras",
        _ => "General",
    }
}

fn get_json<T: for<'de> Deserialize<'de>>(name: &str) -> Result<T, String> {
    serde_json::from_str(&get_text(&format!("{IPTV_ORG}/{name}.json"))?).map_err(|e| format!("{name}: {e}"))
}

fn fold(s: &str) -> String {
    s.to_lowercase().chars().filter(|c| c.is_alphanumeric()).collect()
}

/// Joins iptv-org streams with their channel, logo and themes. Only HTTPS HLS
/// streams that need no special headers; blocklisted (rights-removed), adult and
/// closed channels are excluded. Spanish channels already in the TDT list are skipped.
fn parse_world(streams: Vec<IoStream>, channels: Vec<IoChannel>, logos: Vec<IoLogo>, blocked: Vec<IoBlocked>, tdt: &[Channel]) -> Vec<Channel> {
    let blocked: std::collections::HashSet<String> = blocked.into_iter().map(|b| b.channel).collect();
    let mut logo: HashMap<String, String> = HashMap::new();
    for l in logos.into_iter().filter(|l| l.in_use && l.url.starts_with("https://")) {
        logo.entry(l.channel).or_insert(l.url);
    }
    let tdt_names: std::collections::HashSet<String> = tdt.iter().filter(|c| c.country.as_deref() == Some("ES")).map(|c| fold(&c.name)).collect();
    let info: HashMap<String, IoChannel> = channels.into_iter().map(|c| (c.id.clone(), c)).collect();

    // Group streams per channel, best quality first.
    let mut per_channel: HashMap<String, Vec<(u32, String)>> = HashMap::new();
    for s in streams {
        let Some(id) = s.channel else { continue };
        if !usable_stream(&s.url) || s.user_agent.is_some() || s.referrer.is_some() || blocked.contains(&id) {
            continue;
        }
        let q = s.quality.as_deref().and_then(|q| q.trim_end_matches(['p', 'i']).parse().ok()).unwrap_or(0);
        per_channel.entry(id).or_default().push((q, s.url));
    }

    let mut out: Vec<Channel> = per_channel
        .into_iter()
        .filter_map(|(id, mut urls)| {
            let c = info.get(&id)?;
            if c.is_nsfw || c.closed.is_some() {
                return None;
            }
            if c.country.as_deref() == Some("ES") && tdt_names.contains(&fold(&c.name)) {
                return None;
            }
            urls.sort_by(|a, b| b.0.cmp(&a.0));
            urls.dedup_by(|a, b| a.1 == b.1);
            let mut categories: Vec<String> = c.categories.iter().map(|k| category_es(k).to_string()).collect();
            categories.dedup();
            if categories.is_empty() {
                categories.push("General".into());
            }
            Some(Channel {
                source: Source::World,
                country: c.country.clone(),
                group: c.country.clone().unwrap_or_else(|| "INT".into()),
                region: "Mundo".into(),
                categories,
                id: format!("world:{id}"),
                number: 0,
                name: c.name.clone(),
                logo: logo.get(&id).cloned(),
                streams: urls.into_iter().map(|(_, u)| u).take(4).collect(),
                epg_id: None,
                geo: false,
            })
        })
        .collect();
    out.sort_by(|a, b| a.country.cmp(&b.country).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    for (i, ch) in out.iter_mut().enumerate() {
        ch.number = WORLD_FIRST_NUMBER + i as u32;
    }
    out
}

fn world_channels(tv: &LiveTv, tdt: &[Channel]) -> (Vec<Channel>, Option<String>) {
    let cached = tv.read::<Vec<Channel>>("world.json");
    if let Some(c) = cached.as_ref().filter(|c| now_secs().saturating_sub(c.fetched_at) < WORLD_TTL) {
        return (c.data.clone(), None);
    }
    let fetched = (|| {
        Ok::<_, String>(parse_world(get_json("streams")?, get_json("channels")?, get_json("logos")?, get_json("blocklist")?, tdt))
    })();
    match fetched {
        Ok(list) if !list.is_empty() => {
            tv.write("world.json", &list);
            (list, None)
        }
        Ok(_) => (cached.map(|c| c.data).unwrap_or_default(), Some("El catálogo mundial llegó vacío.".into())),
        Err(e) => (cached.map(|c| c.data).unwrap_or_default(), Some(format!("Catálogo mundial no disponible: {e}"))),
    }
}

// ───────────────────────── EPG ─────────────────────────

fn parse_epg(json: &serde_json::Value) -> HashMap<String, Vec<Program>> {
    let now = now_secs() as i64;
    let (from, to) = (now - 3 * 3600, now + 30 * 3600);
    let mut out = HashMap::new();
    for ch in json.as_array().into_iter().flatten() {
        let Some(id) = ch.get("name").and_then(|n| n.as_str()) else { continue };
        let programs: Vec<Program> = ch
            .get("events")
            .and_then(|e| e.as_array())
            .into_iter()
            .flatten()
            .filter_map(|e| {
                let (start, end) = (e.get("hi")?.as_i64()?, e.get("hf")?.as_i64()?);
                if end < from || start > to || end <= start {
                    return None;
                }
                let text = |k: &str| e.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty());
                Some(Program {
                    start,
                    end,
                    title: text("t")?.to_string(),
                    description: text("d").map(|d| d.chars().take(320).collect()),
                    genre: text("g").map(String::from),
                    image: text("c").filter(|c| c.starts_with("https://")).map(String::from),
                })
            })
            .collect();
        if !programs.is_empty() {
            out.insert(id.to_string(), programs);
        }
    }
    out
}

// ───────────────────────── Commands ─────────────────────────

// ───────────────────────── Stable channel numbers ─────────────────────────
// A channel keeps the number it first got, whatever happens to the lists later
// (iptv-org adding channels, Twitch's ranking, TDTChannels reordering…). Numbers
// of channels not seen for 90 days are freed.

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Slot {
    n: u32,
    seen: u64,
}

const FORGET_AFTER: u64 = 90 * 24 * 3600;
/// Twitch streams come and go daily: their numbers are freed much sooner.
const FORGET_TWITCH: u64 = 24 * 3600;

fn forget_after(id: &str) -> u64 {
    if id.starts_with("twitch:") { FORGET_TWITCH } else { FORGET_AFTER }
}

/// Number range of each source.
fn range(source: Source) -> (u32, u32) {
    match source {
        Source::Tdt => (1, 999),
        Source::Playlist => (CUSTOM_FIRST_NUMBER, 2999),
        Source::Fast => (3001, 3999),
        Source::Twitch => (crate::twitch::FIRST_NUMBER, 4999),
        Source::World => (WORLD_FIRST_NUMBER, 99_999),
    }
}

static NUMBERS_LOCK: Mutex<()> = Mutex::new(());

fn stable_numbers(tv: &LiveTv, channels: &mut [Channel]) {
    let Ok(_guard) = NUMBERS_LOCK.lock() else { return };
    let now = now_secs();
    let mut book: HashMap<String, Slot> = tv.read::<HashMap<String, Slot>>("numbers.json").map(|c| c.data).unwrap_or_default();
    let before = book.len();
    book.retain(|id, s| now.saturating_sub(s.seen) < forget_after(id));
    let mut changed = book.len() != before;
    let mut taken: std::collections::HashSet<u32> = book.values().map(|s| s.n).collect();
    let present: std::collections::HashSet<String> = channels.iter().map(|c| c.id.clone()).collect();
    let mut next: HashMap<(u32, u32), u32> = HashMap::new();
    for ch in channels.iter_mut() {
        if let Some(slot) = book.get_mut(&ch.id) {
            ch.number = slot.n;
            // Refreshing "seen" well before it would be forgotten is enough.
            if now.saturating_sub(slot.seen) > forget_after(&ch.id) / 8 {
                slot.seen = now;
                changed = true;
            }
            continue;
        }
        let (lo, hi) = range(ch.source);
        // Its natural number if free, else the next free one in its range.
        let n = if (lo..=hi).contains(&ch.number) && !taken.contains(&ch.number) {
            ch.number
        } else {
            let cursor = next.entry((lo, hi)).or_insert(lo);
            while *cursor <= hi && taken.contains(cursor) {
                *cursor += 1;
            }
            if *cursor <= hi {
                *cursor
            } else {
                // Range full: reuse the number of the channel seen longest ago (not on the lists now).
                let oldest = book
                    .iter()
                    .filter(|(id, s)| (lo..=hi).contains(&s.n) && !present.contains(id.as_str()))
                    .min_by_key(|(_, s)| s.seen)
                    .map(|(id, s)| (id.clone(), s.n));
                match oldest {
                    Some((id, n)) => {
                        book.remove(&id);
                        n
                    }
                    // More live channels than numbers in the range: nothing to free.
                    None => hi,
                }
            }
        };
        taken.insert(n);
        ch.number = n;
        book.insert(ch.id.clone(), Slot { n, seen: now });
        changed = true;
    }
    if changed {
        tv.write("numbers.json", &book);
    }
}

struct Collected {
    channels: Vec<Channel>,
    playlists: Vec<PlaylistInfo>,
    tdt_error: Option<String>,
    world_error: Option<String>,
    fast_error: Option<String>,
    twitch_error: Option<String>,
}

/// Every source in channel-number order: TDT, playlists (1001+), Pluto TV (3001+),
/// Twitch (4001+), world (5001+).
fn collect(app: &AppHandle) -> Collected {
    let tv = app.state::<LiveTv>();
    let config = app.state::<AppState>().config.snapshot().live_tv;
    let (mut channels, tdt_error) = tdt_channels(&tv);
    let (world, world_error) = if config.world_disabled { (vec![], None) } else { world_channels(&tv, &channels) };
    let (fast, fast_error) = if config.fast_disabled { (vec![], None) } else { crate::pluto::channels(&tv) };
    let (twitch, twitch_error) = if config.twitch_disabled { (vec![], None) } else { crate::twitch::channels() };
    let mut playlists = Vec::new();
    let mut next = CUSTOM_FIRST_NUMBER;
    for p in &config.playlists {
        let (list, error) = playlist_channels(&tv, p, next);
        next += list.len() as u32 + 100;
        playlists.push(PlaylistInfo { id: p.id.clone(), name: p.name.clone(), url: p.url.clone(), channels: list.len(), error });
        channels.extend(list);
    }
    channels.extend(fast);
    channels.extend(twitch);
    channels.extend(world);
    stable_numbers(&tv, &mut channels);
    tv.note_error("tdt", &tdt_error);
    tv.note_error("world", &world_error);
    tv.note_error("pluto", &fast_error);
    tv.note_error("twitch", &twitch_error);
    if let Ok(mut all) = tv.all.lock() {
        *all = Some(channels.clone());
    }
    Collected { channels, playlists, tdt_error, world_error, fast_error, twitch_error }
}

#[tauri::command]
pub async fn livetv_channels(app: AppHandle) -> Result<LiveTvData, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let full = app.state::<AppState>().config.snapshot();
        let profile = crate::profiles::active(&full);
        let config = full.live_tv;
        let mut c = collect(&app);
        // Check signal in the background, favourites and the last channel first.
        let priority: Vec<String> = profile.favorites.iter().cloned().chain(profile.last_channel.clone()).collect();
        crate::livetv_health::start(&app, c.channels.clone(), priority, false);
        // Children's profile: the allow-list only (enforced here, not in the UI).
        c.channels.retain(|ch| crate::profiles::channel_allowed(&profile, ch));
        LiveTvData {
            channels: c.channels,
            favorites: profile.favorites,
            last_channel: profile.last_channel,
            playlists: c.playlists,
            tdt_error: c.tdt_error,
            world_enabled: !config.world_disabled,
            world_error: c.world_error,
            fast_enabled: !config.fast_disabled,
            fast_error: c.fast_error,
            twitch_enabled: !config.twitch_disabled,
            twitch_error: c.twitch_error,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

/// Every channel the active profile may watch (TDT, Pluto, world, playlists),
/// from memory when NOVA already loaded them.
pub fn snapshot(app: &AppHandle) -> Vec<Channel> {
    let all = match app.state::<LiveTv>().all.lock().ok().and_then(|a| a.clone()) {
        Some(all) => all,
        None => collect(app).channels,
    };
    let profile = crate::profiles::active(&app.state::<AppState>().config.snapshot());
    all.into_iter().filter(|c| crate::profiles::channel_allowed(&profile, c)).collect()
}

/// Title on air now on a channel, if the guide has been loaded.
pub fn now_title(app: &AppHandle, epg_id: &str) -> Option<String> {
    let now = now_secs() as i64;
    let tv = app.state::<LiveTv>();
    let on_air = |cache: &Mutex<Option<(u64, HashMap<String, Vec<Program>>)>>| {
        let guard = cache.lock().ok()?;
        let (_, epg) = guard.as_ref()?;
        epg.get(epg_id)?.iter().find(|p| p.start <= now && p.end > now).map(|p| p.title.clone())
    };
    on_air(&tv.epg).or_else(|| on_air(&tv.pluto_epg))
}

/// Pluto TV's guide for the loaded Pluto channels, refreshed every `PLUTO_EPG_TTL`.
fn pluto_guide(tv: &LiveTv) -> HashMap<String, Vec<Program>> {
    if let Some((at, epg)) = tv.pluto_epg.lock().ok().and_then(|g| g.clone()) {
        if now_secs().saturating_sub(at) < PLUTO_EPG_TTL {
            return epg;
        }
    }
    let pluto: Vec<Channel> = tv.all.lock().ok().and_then(|a| a.clone()).unwrap_or_default().into_iter().filter(|c| c.source == Source::Fast).collect();
    if pluto.is_empty() {
        return HashMap::new();
    }
    let epg = crate::pluto::guide(&pluto);
    if let Ok(mut g) = tv.pluto_epg.lock() {
        *g = Some((now_secs(), epg.clone()));
    }
    epg
}

/// "Comprobar ahora": re-checks every channel, ignoring saved results.
#[tauri::command]
pub async fn livetv_check_now(app: AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let profile = crate::profiles::active(&app.state::<AppState>().config.snapshot());
        let channels = collect(&app).channels;
        let priority: Vec<String> = profile.favorites.iter().cloned().chain(profile.last_channel.clone()).collect();
        crate::livetv_health::start(&app, channels, priority, true);
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn livetv_set_world(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.live_tv.world_disabled = !enabled;
        Ok(())
    })
}

#[tauri::command]
pub fn livetv_set_twitch(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.live_tv.twitch_disabled = !enabled;
        Ok(())
    })
}

#[tauri::command]
pub fn livetv_set_fast(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.live_tv.fast_disabled = !enabled;
        Ok(())
    })
}

#[tauri::command]
pub async fn livetv_epg(app: AppHandle) -> Result<HashMap<String, Vec<Program>>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let tv = app.state::<LiveTv>();
        let cached = tv.epg.lock().ok().and_then(|g| g.clone()).filter(|(at, _)| now_secs().saturating_sub(*at) < EPG_TTL);
        let mut epg = match cached {
            Some((_, epg)) => epg,
            None => {
                let fresh = get_text(TDT_EPG)
                    .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).map_err(|e| e.to_string()))
                    .map(|json| parse_epg(&json));
                tv.note_error("epg", &fresh.as_ref().err().cloned());
                let tdt = match fresh {
                    Ok(epg) => {
                        tv.write("epg.json", &epg);
                        epg
                    }
                    // Offline: the saved guide is still right for the next day or so.
                    Err(e) => tv.read::<HashMap<String, Vec<Program>>>("epg.json").map(|c| c.data).ok_or(format!("Guía no disponible: {e}"))?,
                };
                // Only the TDT guide is cached for hours; live sources change faster.
                if let Ok(mut g) = tv.epg.lock() {
                    *g = Some((now_secs(), tdt.clone()));
                }
                tdt
            }
        };
        // Pluto TV's own guide (its own short cache) and Twitch (from its live list), live only.
        epg.extend(pluto_guide(&tv));
        epg.extend(crate::twitch::guide());
        Ok(epg)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn livetv_set_favorite(id: String, favorite: bool, state: State<'_, AppState>) -> Result<(), String> {
    state.config.update(|c| {
        let p = crate::profiles::active_mut(c).ok_or("Sin perfil")?;
        p.favorites.retain(|f| f != &id);
        if favorite {
            p.favorites.push(id.chars().take(200).collect());
        }
        Ok(())
    })
}

#[tauri::command]
pub fn livetv_set_last(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.config.update(|c| {
        let p = crate::profiles::active_mut(c).ok_or("Sin perfil")?;
        p.last_channel = Some(id.chars().take(200).collect());
        Ok(())
    })
}

#[tauri::command]
pub async fn livetv_add_playlist(name: String, url: String, app: AppHandle) -> Result<usize, String> {
    crate::profiles::require_adult(&app.state::<AppState>())?;
    let name: String = name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    let url = url.trim().to_string();
    if name.is_empty() {
        return Err("Pon un nombre a la lista.".into());
    }
    if !url.starts_with("https://") || url.len() > 2048 || url.contains(char::is_whitespace) {
        return Err("La dirección debe empezar por https://".into());
    }
    let playlist = Playlist { id: new_id("pl"), name, url };
    // Validate before saving: it must download and contain playable channels.
    let check = playlist.clone();
    let count = tauri::async_runtime::spawn_blocking(move || {
        let text = get_text(&check.url)?;
        if !text.trim_start().starts_with("#EXTM3U") {
            return Err("La dirección no es una lista M3U.".to_string());
        }
        let n = parse_m3u(&text, &check, CUSTOM_FIRST_NUMBER).len();
        if n == 0 {
            return Err("La lista no tiene canales HLS https:// reproducibles.".to_string());
        }
        Ok(n)
    })
    .await
    .map_err(|e| e.to_string())??;
    app.state::<AppState>().config.update(move |c| {
        c.live_tv.playlists.push(playlist);
        Ok(())
    })?;
    Ok(count)
}

#[tauri::command]
pub fn livetv_remove_playlist(id: String, app: AppHandle) -> Result<(), String> {
    crate::profiles::require_adult(&app.state::<AppState>())?;
    let tv = app.state::<LiveTv>();
    let _ = fs::remove_file(tv.dir.join(format!("m3u-{id}.json")));
    app.state::<AppState>().config.update(|c| {
        c.live_tv.playlists.retain(|p| p.id != id);
        let prefix = format!("m3u:{id}:");
        for p in &mut c.profiles {
            p.favorites.retain(|f| !f.starts_with(&prefix));
        }
        Ok(())
    })
}

/// Test helper: TDT plus the first Spanish-speaking world channels.
#[cfg(test)]
pub fn sample_channels(n: usize) -> Vec<Channel> {
    let tdt = parse_tdt(&serde_json::from_str(&get_text(TDT_CHANNELS).unwrap()).unwrap());
    let world = parse_world(
        get_json("streams").unwrap(),
        get_json("channels").unwrap(),
        get_json("logos").unwrap(),
        get_json("blocklist").unwrap(),
        &tdt,
    );
    tdt.into_iter()
        .take(n / 2)
        .chain(world.into_iter().filter(|c| matches!(c.country.as_deref(), Some("ES" | "MX" | "AR"))).take(n / 2))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn m3u_parsing() {
        let pl = Playlist { id: "x".into(), name: "Mi IPTV".into(), url: "https://example.com/l.m3u".into() };
        let text = "#EXTM3U\n#EXTINF:-1 tvg-id=\"La1.TV\" tvg-logo=\"https://img/l1.png\" group-title=\"Nacionales\" tvg-chno=\"1\",La 1 HD\nhttps://cdn.example/la1.m3u8\n#EXTINF:-1,Sin HLS\nhttps://cdn.example/x.mp4\n#EXTINF:-1,Inseguro\nhttp://cdn.example/y.m3u8\n";
        let ch = parse_m3u(text, &pl, 1001);
        assert_eq!(ch.len(), 1);
        assert_eq!((ch[0].number, ch[0].name.as_str(), ch[0].group.as_str()), (1, "La 1 HD", "Nacionales"));
        assert_eq!(ch[0].epg_id.as_deref(), Some("La1.TV"));
    }

    #[test]
    fn numbers_stay_put() {
        let dir = std::env::temp_dir().join(format!("nova-numbers-{}", now_secs()));
        let tv = LiveTv::new(&dir);
        let ch = |id: &str, n: u32| Channel {
            source: Source::World,
            country: None,
            categories: vec![],
            id: id.into(),
            number: n,
            name: id.into(),
            logo: None,
            group: String::new(),
            region: String::new(),
            streams: vec![],
            epg_id: None,
            geo: false,
        };
        let mut first = vec![ch("b", 5001), ch("c", 5002)];
        stable_numbers(&tv, &mut first);
        // A new channel sorts first: by position it would take 5001 and push the others along.
        let mut second = vec![ch("a", 5001), ch("b", 5002), ch("c", 5003)];
        stable_numbers(&tv, &mut second);
        let n: Vec<u32> = second.iter().map(|c| c.number).collect();
        assert_eq!(n, [5003, 5001, 5002], "b and c keep their numbers; a gets a free one");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn full_range_reuses_oldest_number() {
        let dir = std::env::temp_dir().join(format!("nova-numbers-full-{}", now_secs()));
        let tv = LiveTv::new(&dir);
        let ch = |id: String, n: u32| Channel {
            source: Source::Tdt,
            country: None,
            categories: vec![],
            id,
            number: n,
            name: String::new(),
            logo: None,
            group: String::new(),
            region: String::new(),
            streams: vec![],
            epg_id: None,
            geo: false,
        };
        // Fill the whole TDT range (1-999).
        let mut all: Vec<Channel> = (1..=999).map(|n| ch(format!("tdt:{n}"), n)).collect();
        stable_numbers(&tv, &mut all);
        let mut book = tv.read::<HashMap<String, Slot>>("numbers.json").map(|c| c.data).unwrap_or_default();
        if let Some(s) = book.get_mut("tdt:6") {
            s.seen -= 100; // seen longest ago
        }
        tv.write("numbers.json", &book);
        // A new channel plus one that's still on the list.
        let mut next = vec![ch("tdt:new".into(), 1), ch("tdt:1".into(), 1)];
        stable_numbers(&tv, &mut next);
        let n: Vec<u32> = next.iter().map(|c| c.number).collect();
        assert_eq!(n, [6, 1], "takes the number of the channel seen longest ago, no duplicate");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn youtube_streams() {
        assert_eq!(youtube_stream("https://www.youtube.com/channel/UCQySZQ6rrgJXRuonMwIIGMA/live").as_deref(), Some("youtube:channel:UCQySZQ6rrgJXRuonMwIIGMA"));
        assert_eq!(youtube_stream("https://www.youtube.com/live/U_6EPiZncIA").as_deref(), Some("youtube:U_6EPiZncIA"));
        assert_eq!(youtube_stream("https://www.youtube.com/watch?v=U_6EPiZncIA&t=3").as_deref(), Some("youtube:U_6EPiZncIA"));
        assert_eq!(youtube_stream("https://evil.com/live/U_6EPiZncIA"), None);
        assert_eq!(youtube_stream("https://www.youtube.com/live/bad\"id"), None);
    }

    /// Kids channels that TDTChannels only lists as YouTube live streams.
    #[test]
    #[ignore = "needs internet"]
    fn tdt_youtube_kids() {
        let json: serde_json::Value = serde_json::from_str(&get_text(TDT_CHANNELS).unwrap()).unwrap();
        let agent = ureq::Agent::config_builder().timeout_global(Some(std::time::Duration::from_secs(10))).build().into();
        for c in parse_tdt(&json).iter().filter(|c| c.group == "Infantiles") {
            let live: Vec<_> = c.streams.iter().filter(|s| s.starts_with("youtube:")).map(|s| (s.clone(), crate::livetv_health::probe_for_test(&agent, s))).collect();
            println!("{} #{}: {} HLS, YouTube {live:?}", c.name, c.number, c.streams.iter().filter(|s| !s.starts_with("youtube:")).count());
        }
    }

    #[test]
    #[ignore = "needs internet"]
    fn iptv_org_world() {
        let json: serde_json::Value = serde_json::from_str(&get_text(TDT_CHANNELS).unwrap()).unwrap();
        let tdt = parse_tdt(&json);
        let world = parse_world(
            get_json("streams").unwrap(),
            get_json("channels").unwrap(),
            get_json("logos").unwrap(),
            get_json("blocklist").unwrap(),
            &tdt,
        );
        let mut by_cat: HashMap<&str, usize> = HashMap::new();
        for c in &world {
            for k in &c.categories {
                *by_cat.entry(k.as_str()).or_default() += 1;
            }
        }
        let with_logo = world.iter().filter(|c| c.logo.is_some()).count();
        println!("{} canales mundiales ({} con logo); temáticas: {:?}", world.len(), with_logo, by_cat);
        assert!(world.len() > 3000);
        assert!(!world.iter().any(|c| c.country.as_deref() == Some("ES") && c.name == "La 1"), "TDT duplicates are skipped");
    }

    #[test]
    #[ignore = "needs internet"]
    fn tdtchannels_live() {
        let json: serde_json::Value = serde_json::from_str(&get_text(TDT_CHANNELS).unwrap()).unwrap();
        let channels = parse_tdt(&json);
        let la1 = channels.iter().find(|c| c.name == "La 1").unwrap();
        println!("{} canales; La 1 = #{} {:?}", channels.len(), la1.number, la1.streams);
        assert!(channels.len() > 200);
        let epg = parse_epg(&serde_json::from_str(&get_text(TDT_EPG).unwrap()).unwrap());
        let now = now_secs() as i64;
        let on_now = epg.get("La1.TV").and_then(|p| p.iter().find(|p| p.start <= now && p.end > now)).map(|p| p.title.clone());
        println!("{} canales con guía; ahora en La 1: {on_now:?}", epg.len());
        assert!(epg.len() > 50);
    }
}
