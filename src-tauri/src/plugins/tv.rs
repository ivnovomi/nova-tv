//! Plugins in live TV: their channels, guide and streams.
//!
//! A plugin's channels get the id `plugin:<plugin>:<channel>` and a block of
//! 500 numbers (5001–5500 for the first plugin with channels, 5501–6000 for the
//! next…), so they keep their numbers like any other source. A channel whose
//! stream is fixed and direct carries it as is; otherwise its stream is
//! `plugin:<plugin>:<channel>`, asked of the plugin right before playing
//! (`plugins_stream`). Playlists of proxied streams go through NOVA
//! (`plugins_playlist`), only to the plugin's domains and with the headers
//! its `stream()` gave.

use super::manifest::{Audience, Manifest};
use super::registry::{clean_stream, context, approved, Registry};
use crate::config::PluginState;
use crate::livetv::{Channel, Program, Source};
use crate::AppState;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const PREFIX: &str = "plugin:";
const FIRST: u32 = 5001;
const BLOCK: u32 = 500;
/// Blocks 5001–10000 (ten plugins); more plugins get 100001+, 101001+…
const LOW_BLOCKS: u32 = 10;
const CATEGORIES: &[&str] = &["Noticias", "Deportes", "Infantil", "Cine", "Series", "Música", "Documentales", "Entretenimiento", "Estilo de vida", "Religión", "Otros"];
const MAX_CHANNELS: usize = 500;

/// Plugins whose channels children's profiles may see (refreshed with each channel load).
static KIDS_VISIBLE: RwLock<Option<HashSet<String>>> = RwLock::new(None);

/// Per plugin: when its channels were loaded, the list, and each channel's fixed stream (if any).
type ChannelCache = HashMap<String, (Instant, Vec<Channel>, HashMap<String, serde_json::Value>)>;
static CHANNELS: LazyLock<Mutex<ChannelCache>> = LazyLock::new(Default::default);
/// Per plugin: when its guide was loaded, and the programmes by channel.
type GuideCache = HashMap<String, (Instant, HashMap<String, Vec<Program>>)>;
static GUIDE: LazyLock<Mutex<GuideCache>> = LazyLock::new(Default::default);
/// Headers the last `stream()` of each plugin asked for its proxied playlists.
static PROXY_HEADERS: LazyLock<Mutex<HashMap<String, HashMap<String, String>>>> = LazyLock::new(Default::default);

/// Numbers of plugin block `k`.
fn block(k: u32) -> (u32, u32) {
    if k < LOW_BLOCKS {
        let lo = FIRST + BLOCK * k;
        (lo, lo + BLOCK - 1)
    } else {
        let lo = 100_001 + 1000 * (k - LOW_BLOCKS);
        (lo, lo + BLOCK - 1)
    }
}

/// The block a plugin channel's number belongs to (for stable numbering).
pub fn block_of(number: u32) -> (u32, u32) {
    let k = if (FIRST..FIRST + BLOCK * LOW_BLOCKS).contains(&number) { (number - FIRST) / BLOCK } else { LOW_BLOCKS + number.saturating_sub(100_001) / 1000 };
    block(k)
}

/// `plugin:<plugin>:<channel>` → (plugin, channel).
pub fn split(id: &str) -> Option<(&str, &str)> {
    let rest = id.strip_prefix(PREFIX)?;
    let (plugin, channel) = rest.split_once(':')?;
    (!plugin.is_empty() && !channel.is_empty()).then_some((plugin, channel))
}

/// For children's profiles: may they see this plugin's channels?
pub fn kids_visible(channel_id: &str) -> bool {
    let Some((plugin, _)) = split(channel_id) else { return false };
    KIDS_VISIBLE.read().ok().and_then(|s| s.as_ref().map(|s| s.contains(plugin))).unwrap_or(false)
}

fn channel_id_ok(id: &str) -> bool {
    !id.is_empty() && id.len() <= 100 && !id.contains(char::is_control) && !id.contains(char::is_whitespace)
}

/// NOVA's stream string for a cleaned plugin stream, when it can go straight
/// into the channel (fixed and not proxied).
fn direct(stream: &serde_json::Value) -> Option<String> {
    match stream["type"].as_str()? {
        "hls" if !stream["proxy"].as_bool().unwrap_or(false) => stream["url"].as_str().map(String::from),
        "twitch" => stream["channel"].as_str().map(|c| format!("twitch:{c}")),
        "youtube" => stream["video"].as_str().map(|v| format!("youtube:{v}")).or_else(|| stream["channel"].as_str().map(|c| format!("youtube:channel:{c}"))),
        _ => None,
    }
}

/// A plugin's channel as NOVA's, or None if it isn't valid.
fn clean_channel(v: &serde_json::Value, manifest: &Manifest, block: (u32, u32), index: usize) -> Option<(Channel, Option<serde_json::Value>)> {
    let text = |key: &str, max: usize| v[key].as_str().map(|s| s.trim().chars().filter(|c| !c.is_control()).take(max).collect::<String>()).filter(|s| !s.is_empty());
    let local = text("id", 100).filter(|i| channel_id_ok(i))?;
    let name = text("name", 80)?;
    let id = format!("{PREFIX}{}:{local}", manifest.id);
    let stream = clean_stream(&v["stream"]);
    let streams = vec![stream.as_ref().and_then(direct).unwrap_or_else(|| id.clone())];
    let preferred = v["number"].as_u64().filter(|n| (1..=u64::from(BLOCK)).contains(n)).map(|n| n as u32 - 1).unwrap_or(index as u32);
    let mut categories: Vec<String> = v["categories"].as_array().into_iter().flatten().filter_map(|c| c.as_str()).filter(|c| CATEGORIES.contains(c)).map(String::from).collect();
    categories.dedup();
    let channel = Channel {
        source: Source::Plugin,
        country: text("country", 2).map(|c| c.to_uppercase()),
        categories,
        number: block.0 + preferred.min(BLOCK - 1),
        name,
        logo: text("logo", 2048).filter(|u| u.starts_with("https://")),
        group: text("group", 60).unwrap_or_else(|| manifest.name.clone()),
        region: manifest.name.clone(),
        streams,
        epg_id: Some(id.clone()),
        geo: false,
        id,
    };
    Some((channel, stream))
}

/// Picks (and remembers) each plugin's number block.
fn blocks(app: &AppHandle, ids: &[String]) -> HashMap<String, u32> {
    let state = app.state::<AppState>();
    let mut out = HashMap::new();
    let _ = state.config.update(|c| {
        let mut used: HashSet<u32> = c.plugins.installed.values().filter_map(|s| s.channel_block).collect();
        for id in ids {
            let Some(entry) = c.plugins.installed.get_mut(id) else { continue };
            let k = match entry.channel_block {
                Some(k) => k,
                None => {
                    let k = (0..).find(|k| !used.contains(k)).unwrap_or(0);
                    used.insert(k);
                    entry.channel_block = Some(k);
                    k
                }
            };
            out.insert(id.clone(), k);
        }
        Ok(())
    });
    out
}

fn ttl(plugin: &super::runtime::Plugin, part: &str, default: u64, minimum: u64) -> Duration {
    Duration::from_secs(super::registry::refresh_secs(plugin.refresh(part), default, minimum))
}

/// Every enabled plugin's channels (for live TV's channel list). Plugins are
/// asked in parallel; a plugin that fails keeps its last good list.
pub fn channels(app: &AppHandle) -> Vec<Channel> {
    let config = app.state::<AppState>().config.snapshot();
    let registry = app.state::<Registry>();
    let profile = crate::profiles::active(&config);
    let candidates: Vec<(Manifest, PluginState)> = registry
        .installed_manifests()
        .into_iter()
        .filter_map(|m| {
            let state = config.plugins.installed.get(&m.id)?.clone();
            (m.permissions.channels && state.enabled && approved(&m, &state)).then_some((m, state))
        })
        .collect();

    if let Ok(mut kids) = KIDS_VISIBLE.write() {
        *kids = Some(candidates.iter().filter(|(m, s)| m.audience == Audience::Everyone && s.kids_allowed).map(|(m, _)| m.id.clone()).collect());
    }
    let blocks = blocks(app, &candidates.iter().map(|(m, _)| m.id.clone()).collect::<Vec<_>>());

    let handles: Vec<_> = candidates
        .into_iter()
        .map(|(manifest, state)| {
            let app = app.clone();
            let profile = profile.clone();
            let block = block(blocks.get(&manifest.id).copied().unwrap_or(0));
            std::thread::spawn(move || {
                let registry = app.state::<Registry>();
                let cached = CHANNELS.lock().ok().and_then(|c| c.get(&manifest.id).cloned());
                let plugin = registry.plugin(&manifest.id, &state);
                let fresh_for = plugin.as_ref().map(|p| ttl(p, "channels", 6 * 3600, 3600)).unwrap_or(Duration::from_secs(6 * 3600));
                if let Some((at, list, _)) = &cached
                    && at.elapsed() < fresh_for
                {
                    return list.clone();
                }
                let (ctx, opaque) = context(&manifest.id, &profile);
                match plugin.and_then(|p| p.call("channels", "load", serde_json::json!([ctx]), Some(opaque))) {
                    Ok(value) => {
                        let mut seen = HashSet::new();
                        let mut list = Vec::new();
                        let mut fixed = HashMap::new();
                        for (i, v) in value.as_array().into_iter().flatten().take(MAX_CHANNELS).enumerate() {
                            let Some((channel, stream)) = clean_channel(v, &manifest, block, i) else { continue };
                            if !seen.insert(channel.id.clone()) {
                                continue;
                            }
                            if let Some(s) = stream {
                                fixed.insert(channel.id.clone(), s);
                            }
                            list.push(channel);
                        }
                        if let Ok(mut c) = CHANNELS.lock() {
                            c.insert(manifest.id.clone(), (Instant::now(), list.clone(), fixed));
                        }
                        list
                    }
                    Err(e) => {
                        registry.note_error(&manifest.id, &e);
                        cached.map(|(_, list, _)| list).unwrap_or_default()
                    }
                }
            })
        })
        .collect();
    handles.into_iter().filter_map(|h| h.join().ok()).flatten().collect()
}

/// What's on now on a plugin's channel, if its guide has been loaded.
pub fn now_title(epg_id: &str, now: i64) -> Option<String> {
    let (plugin, _) = split(epg_id)?;
    let guide = GUIDE.lock().ok()?;
    let (_, programs) = guide.get(plugin)?;
    programs.get(epg_id)?.iter().find(|p| p.start <= now && p.end > now).map(|p| p.title.clone())
}

/// Programmes from the plugins with `guide`, keyed by channel id.
pub fn guide(app: &AppHandle) -> HashMap<String, Vec<Program>> {
    let config = app.state::<AppState>().config.snapshot();
    let registry = app.state::<Registry>();
    let profile = crate::profiles::active(&config);
    let lists: Vec<(String, Vec<String>)> = CHANNELS
        .lock()
        .map(|c| c.iter().map(|(id, (_, list, _))| (id.clone(), list.iter().filter_map(|ch| split(&ch.id).map(|(_, local)| local.to_string())).collect())).collect())
        .unwrap_or_default();
    let mut out = HashMap::new();
    for (plugin_id, ids) in lists {
        let Some(manifest) = registry.installed_manifests().into_iter().find(|m| m.id == plugin_id) else { continue };
        let Some(state) = config.plugins.installed.get(&plugin_id) else { continue };
        if !manifest.permissions.guide || !state.enabled || !approved(&manifest, state) || ids.is_empty() {
            continue;
        }
        let Ok(plugin) = registry.plugin(&plugin_id, state) else { continue };
        let cached = GUIDE.lock().ok().and_then(|g| g.get(&plugin_id).cloned());
        if let Some((at, programs)) = &cached
            && at.elapsed() < ttl(&plugin, "guide", 3600, 15 * 60)
        {
            out.extend(programs.clone());
            continue;
        }
        let now = crate::config::now_secs() as i64;
        let (ctx, opaque) = context(&plugin_id, &profile);
        let range = serde_json::json!({ "from": now - 3600, "to": now + 12 * 3600 });
        let programs = match plugin.call("guide", "load", serde_json::json!([ids, range, ctx]), Some(opaque)) {
            Ok(value) => {
                let mut programs = HashMap::new();
                for (local, list) in value.as_object().into_iter().flatten() {
                    let cleaned: Vec<Program> = list
                        .as_array()
                        .into_iter()
                        .flatten()
                        .take(200)
                        .filter_map(|p| {
                            let text = |k: &str, max: usize| p[k].as_str().map(|s| s.trim().chars().take(max).collect::<String>()).filter(|s| !s.is_empty());
                            let (start, end) = (p["start"].as_i64()?, p["end"].as_i64()?);
                            (end > start).then_some(Program {
                                start,
                                end,
                                title: text("title", 120)?,
                                description: text("description", 400),
                                genre: text("genre", 40),
                                image: text("image", 2048).filter(|u| u.starts_with("https://")),
                            })
                        })
                        .collect();
                    if !cleaned.is_empty() {
                        programs.insert(format!("{PREFIX}{plugin_id}:{local}"), cleaned);
                    }
                }
                if let Ok(mut g) = GUIDE.lock() {
                    g.insert(plugin_id.clone(), (Instant::now(), programs.clone()));
                }
                programs
            }
            Err(e) => {
                registry.note_error(&plugin_id, &e);
                cached.map(|(_, p)| p).unwrap_or_default()
            }
        };
        out.extend(programs);
    }
    out
}

/// Forget a plugin's channels and guide (it was updated, disabled or removed).
pub fn forget(plugin: &str) {
    if let Ok(mut c) = CHANNELS.lock() {
        c.remove(plugin);
    }
    if let Ok(mut g) = GUIDE.lock() {
        g.remove(plugin);
    }
    if let Ok(mut h) = PROXY_HEADERS.lock() {
        h.remove(plugin);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Resolved {
    /// NOVA's stream string: an https HLS URL, `twitch:<login>` or `youtube:…`.
    stream: String,
    /// Fetch its playlists through `plugins_playlist`.
    proxy: bool,
    plugin: String,
}

/// The stream of a plugin channel, right now. `retry` asks the plugin for a fresh one.
pub fn resolve(app: &AppHandle, channel_id: &str, retry: bool) -> Result<Resolved, String> {
    let (plugin_id, local) = split(channel_id).ok_or("Canal de plugin no válido")?;
    let config = app.state::<AppState>().config.snapshot();
    let profile = crate::profiles::active(&config);
    let state = config.plugins.installed.get(plugin_id).ok_or("Ese plugin no está instalado")?;
    let registry = app.state::<Registry>();
    let manifest = registry.installed_manifests().into_iter().find(|m| m.id == plugin_id).ok_or("Ese plugin no está instalado")?;
    if !manifest.permissions.channels || !state.enabled || !approved(&manifest, state) {
        return Err("Este plugin está desactivado".into());
    }
    // Children: the same rule as the channel list (plugin allowed, channel "Infantil"),
    // checked here too so a channel id asked for directly gets nothing more.
    if profile.kids {
        let listed = CHANNELS.lock().ok().and_then(|c| c.get(plugin_id).and_then(|(_, list, _)| list.iter().find(|ch| ch.id == channel_id).cloned()));
        if !listed.is_some_and(|ch| crate::profiles::channel_allowed(&profile, &ch)) {
            return Err(crate::profiles::BLOCKED.into());
        }
    }
    let plugin = registry.plugin(plugin_id, state)?;
    let fixed = CHANNELS.lock().ok().and_then(|c| c.get(plugin_id).and_then(|(_, _, f)| f.get(channel_id).cloned()));
    let raw = if plugin.has("channels", "stream") {
        let (ctx, opaque) = context(plugin_id, &profile);
        let mut ctx = ctx;
        ctx["retry"] = serde_json::Value::Bool(retry);
        plugin.call("channels", "stream", serde_json::json!([local, ctx]), Some(opaque))?
    } else {
        fixed.ok_or("Este canal no tiene emisión")?
    };
    let stream = clean_stream(&raw).ok_or("El plugin devolvió una emisión no válida")?;
    let proxy = stream["type"] == "hls" && stream["proxy"].as_bool().unwrap_or(false);
    if proxy {
        let headers: HashMap<String, String> = raw["headers"]
            .as_object()
            .into_iter()
            .flatten()
            .take(20)
            .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
            .filter(|(k, v)| k.len() <= 100 && v.len() <= 4096)
            .collect();
        if let Ok(mut h) = PROXY_HEADERS.lock() {
            h.insert(plugin_id.to_string(), headers);
        }
    }
    let url = match stream["type"].as_str() {
        Some("hls") => stream["url"].as_str().unwrap_or_default().to_string(),
        _ => direct(&stream).ok_or("Emisión no válida")?,
    };
    if stream["type"] == "hls" {
        super::http::check_url(&manifest, &url)?;
    }
    Ok(Resolved { stream: url, proxy, plugin: plugin_id.to_string() })
}

/// A proxied playlist for the player: only the plugin's domains, with its headers.
pub fn playlist(app: &AppHandle, plugin_id: &str, url: &str) -> Result<String, String> {
    let registry = app.state::<Registry>();
    let manifest = registry.installed_manifests().into_iter().find(|m| m.id == plugin_id).ok_or("Ese plugin no está instalado")?;
    // Only for a plugin that's on, with the domains the user approved.
    let config = app.state::<AppState>().config.snapshot();
    if !config.plugins.installed.get(plugin_id).is_some_and(|s| s.enabled && approved(&manifest, s)) {
        return Err("Este plugin está desactivado".into());
    }
    let headers = PROXY_HEADERS.lock().ok().and_then(|h| h.get(plugin_id).cloned()).unwrap_or_default();
    let response = super::http::fetch(&manifest, super::http::Request { url: url.to_string(), method: None, headers, body: None, timeout: Some(15) })?;
    if response.status != 200 {
        return Err(format!("HTTP {}", response.status));
    }
    if !response.body.trim_start().starts_with("#EXTM3U") {
        return Err("HTTP 404".into());
    }
    Ok(response.body)
}

/// Signal check for a plugin channel: the plugin's `check()` if it has one,
/// else None (live TV then checks the resolved stream like any other).
pub fn check(app: &AppHandle, channel_id: &str) -> Option<bool> {
    let (plugin_id, local) = split(channel_id)?;
    let config = app.state::<AppState>().config.snapshot();
    let state = config.plugins.installed.get(plugin_id)?;
    let registry = app.state::<Registry>();
    let plugin = registry.plugin(plugin_id, state).ok()?;
    if !plugin.has("channels", "check") {
        return None;
    }
    let (ctx, opaque) = context(plugin_id, &crate::profiles::active(&config));
    plugin.call("channels", "check", serde_json::json!([local, ctx]), Some(opaque)).ok()?.as_bool()
}

/// For live TV's signal checker, which has no AppHandle of its own.
static APP: std::sync::OnceLock<AppHandle> = std::sync::OnceLock::new();

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

/// NOVA, for plugin services that need it (notices, location).
pub fn app() -> Option<&'static AppHandle> {
    APP.get()
}

pub enum Probe {
    /// The plugin answered (its `check()`, or its proxied playlist loaded or not).
    Answer(bool),
    /// Check this stream like any other.
    Stream(String),
}

/// Signal check of a `plugin:` stream.
pub fn probe(stream: &str) -> Probe {
    let Some(app) = APP.get() else { return Probe::Answer(false) };
    if let Some(answer) = check(app, stream) {
        return Probe::Answer(answer);
    }
    match resolve(app, stream, false) {
        Ok(r) if r.proxy => Probe::Answer(playlist(app, &r.plugin, &r.stream).is_ok()),
        Ok(r) => Probe::Stream(r.stream),
        Err(_) => Probe::Answer(false),
    }
}

#[tauri::command]
pub async fn plugins_stream(stream: String, retry: bool, app: AppHandle) -> Result<Resolved, String> {
    tauri::async_runtime::spawn_blocking(move || resolve(&app, &stream, retry)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugins_playlist(plugin: String, url: String, app: AppHandle) -> Result<String, String> {
    if url.len() > 4096 {
        return Err("Lista no permitida".into());
    }
    tauri::async_runtime::spawn_blocking(move || playlist(&app, &plugin, &url)).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_blocks() {
        assert_eq!(block(0), (5001, 5500));
        assert_eq!(block(9), (9501, 10000));
        assert_eq!(block(10), (100_001, 100_500));
        assert_eq!(block_of(5001), (5001, 5500));
        assert_eq!(block_of(5742), (5501, 6000));
        assert_eq!(block_of(10000), (9501, 10000));
        assert_eq!(block_of(101_003), (101_001, 101_500));
    }

    #[test]
    fn ids() {
        assert_eq!(split("plugin:es.yo.twitch:ibai"), Some(("es.yo.twitch", "ibai")));
        assert_eq!(split("plugin:es.yo.pluto:canal:con:dos"), Some(("es.yo.pluto", "canal:con:dos")));
        assert_eq!(split("plugin::x"), None);
        assert_eq!(split("twitch:ibai"), None);
    }

    /// plugins/canales-prueba, packed with npm, against the real test streams.
    #[test]
    #[ignore = "needs internet and the test-channels plugin built with npm"]
    fn test_channels_plugin_end_to_end() {
        use super::super::runtime::{Env, Plugin};
        use super::super::storage::Storage;
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/canales-prueba");
        let manifest = Manifest::read(&dir).unwrap();
        let source = std::fs::read_to_string(dir.join(&manifest.main)).unwrap();
        let data = std::env::temp_dir().join(format!("nova-tv-canales-{}", std::process::id()));
        let plugin = Plugin::start(std::sync::Arc::new(Env::new(manifest.clone(), Storage::new(data.clone()))), source).unwrap();
        assert!(plugin.has("channels", "stream") && plugin.has("channels", "check"));
        let ctx = serde_json::json!({ "profile": { "id": "p", "kids": false }, "locale": "es-ES" });

        let list = plugin.call("channels", "load", serde_json::json!([ctx]), None).unwrap();
        let channels: Vec<Channel> = list.as_array().unwrap().iter().enumerate().filter_map(|(i, v)| clean_channel(v, &manifest, block(0), i).map(|c| c.0)).collect();
        assert_eq!(channels[0].streams[0], "https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8");
        assert_eq!(channels[1].streams[0], "plugin:es.novatv.canales-prueba:mux");
        assert_eq!((channels[0].number, channels[1].number), (5001, 5002));

        let mut retry = ctx.clone();
        retry["retry"] = serde_json::Value::Bool(false);
        let stream = clean_stream(&plugin.call("channels", "stream", serde_json::json!(["mux", retry]), None).unwrap()).unwrap();
        assert_eq!(stream["proxy"], true);
        let body = super::super::http::fetch(&manifest, super::super::http::Request { url: stream["url"].as_str().unwrap().into(), method: None, headers: Default::default(), body: None, timeout: None }).unwrap();
        assert!(body.body.starts_with("#EXTM3U"));

        for id in ["bipbop", "mux"] {
            assert_eq!(plugin.call("channels", "check", serde_json::json!([id, ctx]), None).unwrap(), true, "{id}");
        }
        let guide = plugin.call("guide", "load", serde_json::json!([["bipbop"], { "from": 1_800_000_000, "to": 1_800_003_600 }, ctx]), None).unwrap();
        assert_eq!(guide["bipbop"].as_array().unwrap().len(), 2);
        let _ = std::fs::remove_dir_all(data);
    }

    #[test]
    fn channels_are_cleaned() {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "id": "es.yo.tele", "name": "Mi tele", "version": "1.0.0", "api": 1, "kind": ["provider"], "main": "dist/index.js",
            "description": "Un plugin de prueba.", "author": { "name": "Yo" }, "audience": "everyone", "permissions": { "channels": true }
        }))
        .unwrap();
        let v = serde_json::json!({ "id": "noticias", "name": "Noticias 24h", "number": 3, "categories": ["Noticias", "Inventada"],
            "logo": "http://x/logo.png", "stream": { "type": "hls", "url": "https://cdn.x.es/a.m3u8" } });
        let (ch, stream) = clean_channel(&v, &manifest, block(1), 0).unwrap();
        assert_eq!(ch.id, "plugin:es.yo.tele:noticias");
        assert_eq!(ch.number, 5503);
        assert_eq!(ch.categories, ["Noticias"]);
        assert_eq!(ch.logo, None);
        assert_eq!(ch.streams, ["https://cdn.x.es/a.m3u8"]);
        assert!(stream.is_some());
        // Proxied or without a fixed stream: resolved at play time.
        let v = serde_json::json!({ "id": "pluto", "name": "Pluto", "stream": { "type": "hls", "url": "https://a.pluto.tv/m.m3u8", "proxy": true } });
        assert_eq!(clean_channel(&v, &manifest, block(0), 4).unwrap().0.streams, ["plugin:es.yo.tele:pluto"]);
        assert_eq!(clean_channel(&v, &manifest, block(0), 4).unwrap().0.number, 5005);
        let v = serde_json::json!({ "id": "con espacio", "name": "x" });
        assert!(clean_channel(&v, &manifest, block(0), 0).is_none());
    }
}
