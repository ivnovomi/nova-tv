//! Game artwork and details from Steam's public store API (no account, no key).
//!
//! Steam games use their app id directly. Games from other launchers are looked
//! up by name and only accepted on an exact (normalised) title match, so a game
//! never gets someone else's artwork. Results are cached in `metadata.json`.

use crate::config::{now_secs, Shortcut, Target};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const FRESH: u64 = 14 * 24 * 3600;
const RETRY_MISS: u64 = 24 * 3600;
const ART: &str = "https://shared.steamstatic.com/store_item_assets/steam/apps";
/// Bump when lookup rules change so cached misses are retried.
const META_VERSION: u32 = 3;
const MS_CATALOG: &str = "https://displaycatalog.mp.microsoft.com/v7.0";

#[derive(Clone, Serialize, Deserialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GameMeta {
    pub steam_app_id: Option<u32>,
    pub title: Option<String>,
    /// Steam's type: "game", "application", "dlc"…
    pub kind: Option<String>,
    pub description: Option<String>,
    #[serde(default)]
    pub genres: Vec<String>,
    pub developer: Option<String>,
    pub year: Option<String>,
    pub metacritic: Option<u32>,
    /// 1920x620 key art
    pub hero: Option<String>,
    /// transparent logo
    pub logo: Option<String>,
    /// 600x900 cover
    pub portrait: Option<String>,
    /// 460x215 capsule
    pub header: Option<String>,
    /// "steam" | "microsoft"
    #[serde(default)]
    pub source: Option<String>,
    /// Muted background trailer (MP4), highest quality.
    #[serde(default)]
    pub trailer: Option<String>,
    pub fetched_at: u64,
    #[serde(default)]
    pub version: u32,
}

pub struct MetadataStore {
    path: PathBuf,
    data: Mutex<HashMap<String, GameMeta>>,
    running: AtomicBool,
}

impl MetadataStore {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("metadata.json");
        let data = fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Self { path, data: Mutex::new(data), running: AtomicBool::new(false) }
    }

    fn save(&self) {
        let Ok(json) = self.data.lock().map(|d| serde_json::to_string(&*d).unwrap_or_default()) else { return };
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        if fs::write(&tmp, json).is_ok() {
            let _ = fs::rename(&tmp, &self.path);
        }
    }

    /// Cover art for a game (portrait first), when metadata has been fetched.
    pub fn cover(&self, id: &str) -> Option<String> {
        let data = self.data.lock().ok()?;
        let m = data.get(id)?;
        m.portrait.clone().or_else(|| m.header.clone())
    }

    /// Steam marks tools (e.g. Blender) as non-games.
    pub fn is_game(&self, id: &str) -> bool {
        self.data.lock().ok().and_then(|d| d.get(id).and_then(|m| m.kind.clone())).is_none_or(|k| k == "game")
    }

    fn needs_fetch(&self, id: &str, now: u64) -> bool {
        let Ok(data) = self.data.lock() else { return false };
        match data.get(id) {
            None => true,
            Some(m) if m.version < META_VERSION => true,
            Some(m) if m.source.is_none() => now.saturating_sub(m.fetched_at) > RETRY_MISS,
            Some(m) => now.saturating_sub(m.fetched_at) > FRESH,
        }
    }
}

fn get_json(url: &str) -> Option<serde_json::Value> {
    let body = ureq::get(url)
        .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
        .call()
        .ok()?
        .body_mut()
        .with_config()
        .limit(4 * 1024 * 1024)
        .read_to_string()
        .ok()?;
    serde_json::from_str(&body).ok()
}

/// "Assassin's Creed® Valhalla" → "assassin s creed valhalla"
fn normalize(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn search_app_id(name: &str) -> Option<u32> {
    let url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        crate::commands::games::encode(name)
    );
    let wanted = normalize(name);
    get_json(&url)?
        .get("items")?
        .as_array()?
        .iter()
        .find(|item| item.get("name").and_then(|n| n.as_str()).is_some_and(|n| normalize(n) == wanted))?
        .get("id")?
        .as_u64()
        .and_then(|id| u32::try_from(id).ok())
}

fn details(app_id: u32) -> Option<GameMeta> {
    let json = get_json(&format!("https://store.steampowered.com/api/appdetails?appids={app_id}&l=spanish&cc=ES"))?;
    let entry = json.get(app_id.to_string())?;
    if entry.get("success").and_then(|s| s.as_bool()) != Some(true) {
        return None;
    }
    let d = entry.get("data")?;
    let text = |k: &str| d.get(k).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let year = d
        .pointer("/release_date/date")
        .and_then(|v| v.as_str())
        .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).find(|p| p.len() == 4).map(String::from));
    Some(GameMeta {
        steam_app_id: Some(app_id),
        title: text("name"),
        kind: text("type"),
        description: text("short_description").map(|s| s.replace("&quot;", "\"").replace("&amp;", "&")),
        genres: d
            .get("genres")
            .and_then(|g| g.as_array())
            .map(|g| g.iter().filter_map(|x| x.get("description")?.as_str().map(String::from)).take(3).collect())
            .unwrap_or_default(),
        developer: d.pointer("/developers/0").and_then(|v| v.as_str()).map(String::from),
        year,
        metacritic: d.pointer("/metacritic/score").and_then(|v| v.as_u64()).map(|v| v as u32),
        hero: Some(format!("{ART}/{app_id}/library_hero.jpg")),
        logo: Some(format!("{ART}/{app_id}/logo.png")),
        portrait: Some(format!("{ART}/{app_id}/library_600x900.jpg")),
        header: Some(format!("{ART}/{app_id}/header.jpg")),
        // Steam lists HLS/DASH streams, but every movie id also has plain MP4s.
        trailer: d
            .get("movies")
            .and_then(|m| m.as_array())
            .and_then(|movies| {
                movies
                    .iter()
                    .find(|m| m.get("highlight").and_then(|h| h.as_bool()) == Some(true))
                    .or_else(|| movies.first())
            })
            .and_then(|m| m.get("id")?.as_u64())
            .map(|id| format!("https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/{id}/movie_max.mp4")),
        source: Some("steam".into()),
        fetched_at: now_secs(),
        version: META_VERSION,
    })
}

// ───────────────────────── Microsoft Store catalog (public, no key) ─────────────────────────

fn genre_es(category: &str) -> String {
    match category {
        "Action & adventure" => "Acción y aventura",
        "Shooter" => "Disparos",
        "Racing & flying" => "Carreras y vuelo",
        "Role playing" => "Rol",
        "Strategy" => "Estrategia",
        "Sports" => "Deportes",
        "Puzzle & trivia" => "Puzles",
        "Family & kids" => "Familiar",
        "Platformer" => "Plataformas",
        "Simulation" => "Simulación",
        "Fighting" => "Lucha",
        "Multi-Player Online Battle Arena" => "MOBA",
        other => other,
    }
    .to_string()
}

/// Parses one product from the display catalog into NOVA's metadata.
fn ms_product(product: &serde_json::Value, title_override: Option<&str>) -> Option<GameMeta> {
    let local = product.pointer("/LocalizedProperties/0")?;
    let text = |k: &str| local.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    let image = |purposes: &[&str], wide_only: bool| {
        purposes.iter().find_map(|purpose| {
            local.get("Images")?.as_array()?.iter().find_map(|img| {
                let ok = img.get("ImagePurpose")?.as_str()? == *purpose;
                let (w, h) = (img.get("Width")?.as_f64()?, img.get("Height")?.as_f64()?);
                let uri = img.get("Uri")?.as_str()?;
                (ok && (!wide_only || w / h >= 1.6) && uri.starts_with("//store-images.s-microsoft.com/"))
                    .then(|| format!("https:{uri}"))
            })
        })
    };
    // Real paragraphs of the long description (skipping "CREA"-style headings), TV length.
    let description = text("ShortDescription").or_else(|| {
        text("ProductDescription").map(|d| {
            let body = d.lines().map(str::trim).filter(|p| p.chars().count() > 40).take(2).collect::<Vec<_>>().join(" ");
            let body = if body.is_empty() { d.trim().to_string() } else { body };
            if body.chars().count() > 320 { format!("{}…", body.chars().take(317).collect::<String>().trim_end()) } else { body }
        })
    });
    let year = product
        .pointer("/MarketProperties/0/OriginalReleaseDate")
        .and_then(|v| v.as_str())
        .map(|d| d.chars().take(4).collect::<String>())
        .filter(|y| y.len() == 4 && y != "0001");
    let kind = product.get("ProductType").and_then(|v| v.as_str()).map(|t| if t == "Game" { "game" } else { "application" }.to_string());
    Some(GameMeta {
        steam_app_id: None,
        title: title_override.map(String::from).or_else(|| text("ProductTitle")),
        kind,
        description,
        genres: product.pointer("/Properties/Category").and_then(|v| v.as_str()).map(|c| vec![genre_es(c)]).unwrap_or_default(),
        developer: text("DeveloperName").or_else(|| text("PublisherName")),
        year,
        metacritic: None,
        hero: image(&["SuperHeroArt", "TitledHeroArt"], false),
        logo: image(&["Logo"], true),
        portrait: image(&["Poster", "BoxArt"], false),
        header: image(&["BoxArt", "Poster"], false),
        trailer: None,
        source: Some("microsoft".into()),
        fetched_at: now_secs(),
        version: META_VERSION,
    })
}

fn ms_by_id(product_id: &str, title: Option<&str>) -> Option<GameMeta> {
    let json = get_json(&format!("{MS_CATALOG}/products?bigIds={product_id}&market=ES&languages=es-ES&fieldsTemplate=details"))?;
    ms_product(json.pointer("/Products/0")?, title)
}

fn ms_by_package(family: &str) -> Option<GameMeta> {
    let json = get_json(&format!(
        "{MS_CATALOG}/products/lookup?alternateId=PackageFamilyName&value={}&market=ES&languages=es-ES&fieldsTemplate=details",
        crate::commands::games::encode(family)
    ))?;
    ms_product(json.pointer("/Products/0")?, None)
}

/// Exact-title search in the Store (it's fuzzy, so only identical names are accepted).
fn ms_search(name: &str) -> Option<GameMeta> {
    let json = get_json(&format!(
        "{MS_CATALOG}/productFamilies/autosuggest?market=ES&languages=es-ES&query={}&productFamilyNames=Games",
        crate::commands::games::encode(name)
    ))?;
    let wanted = normalize(name);
    let id = json.get("Results")?.as_array()?.iter().find_map(|family| {
        family.get("Products")?.as_array()?.iter().find_map(|p| {
            let title = p.get("Title")?.as_str()?;
            (normalize(title) == wanted).then(|| p.get("ProductId")?.as_str().map(String::from)).flatten()
        })
    })?;
    ms_by_id(&id, None)
}

fn fetch_one(game: &Shortcut) -> GameMeta {
    use crate::commands::games::store_product_for;
    let miss = || GameMeta { fetched_at: now_secs(), version: META_VERSION, ..Default::default() };
    // Games behind a launcher (Minecraft, Roblox, Riot…) use the game's own Store page.
    if let Some(product) = store_product_for(&game.id) {
        return ms_by_id(product, Some(&game.name)).unwrap_or_else(miss);
    }
    match &game.target {
        Target::Steam { app_id } => details(*app_id).unwrap_or_else(miss),
        Target::Packaged { aumid } => {
            let family = aumid.split('!').next().unwrap_or(aumid);
            ms_by_package(family).or_else(|| search_app_id(&game.name).and_then(details)).unwrap_or_else(miss)
        }
        _ => search_app_id(&game.name)
            .and_then(details)
            .or_else(|| ms_search(&game.name))
            .unwrap_or_else(miss),
    }
}

/// Fetches missing/stale metadata for `games` in the background, one request at a
/// time (Steam rate-limits), emitting `metadata-changed` as results arrive.
pub fn refresh(app: &AppHandle, games: Vec<Shortcut>) {
    let store = app.state::<MetadataStore>();
    if store.running.swap(true, Ordering::AcqRel) {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let store = app.state::<MetadataStore>();
        let now = now_secs();
        for game in games.iter().filter(|g| store.needs_fetch(&g.id, now)) {
            let meta = fetch_one(game);
            if let Ok(mut data) = store.data.lock() {
                data.insert(game.id.clone(), meta);
            }
            store.save();
            let _ = app.emit("metadata-changed", ());
            std::thread::sleep(Duration::from_millis(350));
        }
        store.running.store(false, Ordering::Release);
    });
}

#[tauri::command]
pub fn game_metadata(store: tauri::State<'_, MetadataStore>) -> HashMap<String, GameMeta> {
    store.data.lock().map(|d| d.clone()).unwrap_or_default()
}

/// Rescans every launcher and refreshes artwork for anything new.
#[tauri::command]
pub async fn rescan_games(app: AppHandle) -> Result<usize, String> {
    crate::commands::games::invalidate();
    let games = crate::commands::applications::all_games(&app);
    let count = games.len();
    refresh(&app, games);
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(normalize("Assassin's Creed® Valhalla"), "assassin s creed valhalla");
        assert_eq!(normalize("  DOOM  Eternal "), "doom eternal");
    }

    #[test]
    #[ignore = "needs internet"]
    fn microsoft_store_catalog() {
        let mc = ms_by_id("9NXP44L49SHJ", Some("Minecraft")).unwrap();
        println!("{mc:?}");
        assert_eq!(mc.title.as_deref(), Some("Minecraft"));
        assert!(mc.hero.is_some() && mc.portrait.is_some());
        assert!(mc.logo.is_none(), "square store logos are not used as wordmarks");
        let launcher = ms_by_package("Microsoft.4297127D64EC6_8wekyb3d8bbwe").unwrap();
        assert!(launcher.hero.is_some());
        assert_eq!(ms_search("VALORANT").and_then(|m| m.title), Some("VALORANT".into()));
    }

    #[test]
    #[ignore = "needs internet"]
    fn steam_public_store() {
        assert_eq!(search_app_id("Celeste"), Some(504230));
        let meta = details(504230).unwrap();
        println!("{meta:?}");
        assert_eq!(meta.kind.as_deref(), Some("game"));
        assert!(meta.year.is_some());
        assert!(meta.trailer.as_deref().is_some_and(|t| t.ends_with("/movie_max.mp4")));
    }
}
