//! Global search backends that need Rust: YouTube results (public search page,
//! no API key) and the user's own media files (Videos, Music, Pictures,
//! Downloads). Games, apps, streaming and history are searched in the UI.

use crate::commands::games::encode;
use crate::commands::media::{AUDIO_EXT, IMAGE_EXT, VIDEO_EXT};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

const MAX_FILES: usize = 20_000;
const MAX_DEPTH: usize = 6;
const INDEX_TTL: Duration = Duration::from_secs(5 * 60);

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct YtResult {
    video_id: String,
    title: String,
    channel: Option<String>,
    /// "12:34", None for live streams
    length: Option<String>,
    views: Option<String>,
    published: Option<String>,
    thumbnail: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileHit {
    path: String,
    name: String,
    folder: String,
    category: &'static str,
}

/// Lowercase, accents and punctuation removed: "Canción_Final" → "cancion final".
fn fold(s: &str) -> String {
    s.chars()
        .flat_map(|c| c.to_lowercase())
        .map(|c| match c {
            'á' | 'à' | 'ä' | 'â' => 'a',
            'é' | 'è' | 'ë' | 'ê' => 'e',
            'í' | 'ì' | 'ï' | 'î' => 'i',
            'ó' | 'ò' | 'ö' | 'ô' => 'o',
            'ú' | 'ù' | 'ü' | 'û' => 'u',
            'ñ' => 'n',
            c if c.is_alphanumeric() => c,
            _ => ' ',
        })
        .collect()
}

/// Every word of the query appears in the text.
#[cfg(test)]
fn matches(text: &str, words: &[String]) -> bool {
    let text = fold(text);
    words.iter().all(|w| text.contains(w.as_str()))
}

fn words(query: &str) -> Vec<String> {
    fold(query).split_whitespace().map(String::from).collect()
}

// ───────────────────────── Media files ─────────────────────────

struct Indexed {
    path: PathBuf,
    folded: String,
    category: &'static str,
}

static INDEX: Mutex<Option<(Instant, Vec<Indexed>)>> = Mutex::new(None);

fn category(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if VIDEO_EXT.contains(&ext.as_str()) {
        Some("video")
    } else if AUDIO_EXT.contains(&ext.as_str()) {
        Some("audio")
    } else if IMAGE_EXT.contains(&ext.as_str()) {
        Some("image")
    } else {
        None
    }
}

fn walk(dir: &Path, depth: usize, out: &mut Vec<Indexed>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if out.len() >= MAX_FILES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') || name.starts_with('$') {
            continue;
        }
        let Ok(kind) = entry.file_type() else { continue };
        let path = entry.path();
        if kind.is_dir() {
            walk(&path, depth + 1, out);
        } else if let Some(category) = kind.is_file().then(|| category(&path)).flatten() {
            out.push(Indexed { folded: fold(&name), path, category });
        }
    }
}

fn media_roots() -> Vec<PathBuf> {
    let Some(home) = std::env::var_os("USERPROFILE").map(PathBuf::from) else { return vec![] };
    ["Videos", "Music", "Pictures", "Downloads", "Desktop"]
        .iter()
        .map(|d| home.join(d))
        .chain(std::env::var_os("OneDrive").map(|o| PathBuf::from(o).join("Pictures")))
        .filter(|p| p.is_dir())
        .collect()
}

fn with_index<T>(f: impl FnOnce(&[Indexed]) -> T) -> T {
    let mut guard = INDEX.lock().unwrap_or_else(|e| e.into_inner());
    let stale = guard.as_ref().is_none_or(|(at, _)| at.elapsed() > INDEX_TTL);
    if stale {
        let mut files = Vec::new();
        for root in media_roots() {
            walk(&root, 0, &mut files);
        }
        *guard = Some((Instant::now(), files));
    }
    f(&guard.as_ref().unwrap().1)
}

#[tauri::command]
pub async fn search_files(query: String, state: tauri::State<'_, crate::AppState>) -> Result<Vec<FileHit>, String> {
    let words = words(&query);
    // Children's profile: the PC's files aren't searchable.
    if words.is_empty() || query.len() > 100 || crate::profiles::kids(&state).is_some() {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_index(|files| {
            files
                .iter()
                .filter(|f| words.iter().all(|w| f.folded.contains(w.as_str())))
                .take(24)
                .map(|f| FileHit {
                    path: f.path.to_string_lossy().into_owned(),
                    name: f.path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                    folder: f.path.parent().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default(),
                    category: f.category,
                })
                .collect()
        })
    })
    .await
    .map_err(|e| e.to_string())
}

// ───────────────────────── YouTube ─────────────────────────

fn yt_text(v: &serde_json::Value) -> Option<String> {
    v.get("simpleText")
        .and_then(|t| t.as_str())
        .map(String::from)
        .or_else(|| {
            let runs = v.get("runs")?.as_array()?;
            Some(runs.iter().filter_map(|r| r.get("text")?.as_str()).collect::<String>())
        })
        .filter(|s| !s.trim().is_empty())
}

/// Depth-first collection of every `videoRenderer` in YouTube's page data.
fn collect_videos(v: &serde_json::Value, out: &mut Vec<YtResult>) {
    if out.len() >= 16 {
        return;
    }
    match v {
        serde_json::Value::Object(map) => {
            if let Some(r) = map.get("videoRenderer") {
                let id = r.get("videoId").and_then(|i| i.as_str()).unwrap_or_default();
                if crate::history::valid_video_id(id) {
                    if let Some(title) = r.get("title").and_then(yt_text) {
                        out.push(YtResult {
                            video_id: id.to_string(),
                            title,
                            channel: r.get("ownerText").and_then(yt_text),
                            length: r.get("lengthText").and_then(yt_text),
                            views: r.get("shortViewCountText").and_then(yt_text).or_else(|| r.get("viewCountText").and_then(yt_text)),
                            published: r.get("publishedTimeText").and_then(yt_text),
                            thumbnail: format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg"),
                        });
                    }
                }
                return;
            }
            map.values().for_each(|child| collect_videos(child, out));
        }
        serde_json::Value::Array(items) => items.iter().for_each(|child| collect_videos(child, out)),
        _ => {}
    }
}

fn parse_results(html: &str) -> Vec<YtResult> {
    let Some(start) = html.find("var ytInitialData = ").map(|i| i + "var ytInitialData = ".len()) else { return vec![] };
    let Some(len) = html[start..].find(";</script>") else { return vec![] };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(&html[start..start + len]) else { return vec![] };
    let mut out = Vec::new();
    collect_videos(&data, &mut out);
    out
}

#[tauri::command]
pub async fn youtube_search(query: String, state: tauri::State<'_, crate::AppState>) -> Result<Vec<YtResult>, String> {
    let query = query.trim().to_string();
    // Children's profile: no open YouTube search (YouTube Kids has its own).
    if query.is_empty() || query.chars().count() > 100 || crate::profiles::kids(&state).is_some() {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("https://www.youtube.com/results?search_query={}&hl=es&gl=ES", encode(&query));
        let html = crate::net::agent()
            .get(&url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")
            .header("Accept-Language", "es-ES,es;q=0.9")
            // Skips the EU cookie-consent page.
            .header("Cookie", "SOCS=CAI")
            .call()
            .map_err(|e| format!("YouTube no responde: {e}"))?
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        Ok(parse_results(&html))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding_and_matching() {
        assert_eq!(fold("Canción_Final.MP3").split_whitespace().collect::<Vec<_>>(), ["cancion", "final", "mp3"]);
        assert!(matches("Vacaciones Málaga 2024.mp4", &words("malaga vacaciones")));
        assert!(!matches("Vacaciones.mp4", &words("malaga")));
    }

    #[test]
    #[ignore = "needs internet"]
    fn youtube_results() {
        let html = ureq::get("https://www.youtube.com/results?search_query=lofi%20hip%20hop&hl=es&gl=ES")
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36")
            .header("Accept-Language", "es-ES,es;q=0.9")
            .call()
            .unwrap()
            .body_mut()
            .with_config()
            .limit(8 * 1024 * 1024)
            .read_to_string()
            .unwrap();
        let results = parse_results(&html);
        for r in results.iter().take(3) {
            println!("{r:?}");
        }
        assert!(results.len() >= 5);
    }

    #[test]
    #[ignore = "depends on this PC"]
    fn indexes_media_folders() {
        let n = with_index(|f| f.len());
        println!("{n} media files indexed under {:?}", media_roots());
    }
}
