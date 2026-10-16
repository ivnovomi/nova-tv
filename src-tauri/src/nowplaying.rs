//! "Now playing" for all of Windows: whatever app owns the current media
//! session (Spotify, Edge, Chrome, VLC, NOVA's own YouTube…) as reported by
//! Windows' system media transport controls, plus play/pause/skip.

use serde::Serialize;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Clone, PartialEq, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NowPlaying {
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    /// Friendly app name ("Spotify", "Microsoft Edge"…)
    pub app: String,
    pub playing: bool,
    pub position: Option<f64>,
    pub duration: Option<f64>,
    /// data: URL of the cover art (sent only when the track changes).
    pub artwork: Option<String>,
    pub can_skip: bool,
}

static CURRENT: Mutex<Option<NowPlaying>> = Mutex::new(None);

/// Current media without the (large) artwork, e.g. for the phone remote.
pub fn current_summary() -> Option<NowPlaying> {
    CURRENT.lock().ok()?.clone().map(|mut n| {
        n.artwork = None;
        n
    })
}

fn friendly_app(aumid: &str) -> String {
    let lower = aumid.to_lowercase();
    let known: [(&str, &str); 9] = [
        ("spotify", "Spotify"),
        ("msedge", "Microsoft Edge"),
        ("chrome", "Google Chrome"),
        ("308046b0af4a39cb", "Firefox"),
        ("firefox", "Firefox"),
        ("vlc", "VLC"),
        ("zunemusic", "Reproductor multimedia"),
        ("nova-tv", "NOVA TV"),
        ("applemusic", "Apple Music"),
    ];
    known
        .iter()
        .find(|(k, _)| lower.contains(k))
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| {
            let base = aumid.rsplit(['\\', '!']).next().unwrap_or(aumid);
            base.trim_end_matches(".exe").trim_end_matches(".EXE").to_string()
        })
}

#[cfg(windows)]
mod imp {
    use super::{friendly_app, NowPlaying};
    use windows::Media::Control::{
        GlobalSystemMediaTransportControlsSession as Session,
        GlobalSystemMediaTransportControlsSessionManager as Manager,
        GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status,
    };
    use windows::Storage::Streams::{DataReader, IRandomAccessStreamReference};

    fn ticks_to_secs(t: i64) -> f64 {
        t as f64 / 10_000_000.0
    }

    fn artwork(reference: &IRandomAccessStreamReference) -> windows::core::Result<Option<String>> {
        let stream = reference.OpenReadAsync()?.join()?;
        let size = stream.Size()? as u32;
        if size == 0 || size > 2_000_000 {
            return Ok(None);
        }
        let reader = DataReader::CreateDataReader(&stream)?;
        reader.LoadAsync(size)?.join()?;
        let mut bytes = vec![0u8; size as usize];
        reader.ReadBytes(&mut bytes)?;
        let mime = if bytes.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else { "image/jpeg" };
        Ok(Some(format!("data:{mime};base64,{}", super::base64(&bytes))))
    }

    pub fn manager() -> windows::core::Result<Manager> {
        Manager::RequestAsync()?.join()
    }

    pub fn read(manager: &Manager, with_artwork: bool) -> windows::core::Result<Option<NowPlaying>> {
        let Ok(session) = manager.GetCurrentSession() else { return Ok(None) };
        let props = session.TryGetMediaPropertiesAsync()?.join()?;
        let title = props.Title()?.to_string();
        if title.trim().is_empty() {
            return Ok(None);
        }
        let text = |s: windows::core::HSTRING| Some(s.to_string()).filter(|s| !s.trim().is_empty());
        let playback = session.GetPlaybackInfo()?;
        let controls = playback.Controls()?;
        let timeline = session.GetTimelineProperties()?;
        let end = ticks_to_secs(timeline.EndTime()?.Duration);
        let duration = (end > 1.0).then_some(end);
        let position = ticks_to_secs(timeline.Position()?.Duration);
        Ok(Some(NowPlaying {
            title,
            artist: text(props.Artist()?),
            album: text(props.AlbumTitle()?),
            app: friendly_app(&session.SourceAppUserModelId()?.to_string()),
            playing: playback.PlaybackStatus()? == Status::Playing,
            position: duration.map(|_| position),
            duration,
            artwork: if with_artwork { props.Thumbnail().ok().and_then(|t| artwork(&t).ok().flatten()) } else { None },
            can_skip: controls.IsNextEnabled()?,
        }))
    }

    pub fn control(manager: &Manager, action: &str) -> windows::core::Result<bool> {
        let session: Session = manager.GetCurrentSession()?;
        let op = match action {
            "playpause" => session.TryTogglePlayPauseAsync()?,
            "next" => session.TrySkipNextAsync()?,
            "prev" => session.TrySkipPreviousAsync()?,
            _ => return Ok(false),
        };
        op.join()
    }
}

/// Minimal standard base64 (artwork data URLs).
fn base64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = u32::from(chunk[0]) << 16 | u32::from(*chunk.get(1).unwrap_or(&0)) << 8 | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

/// Polls Windows' media session on its own MTA thread and emits `now-playing`
/// whenever something visible changes (artwork only when the track changes).
#[cfg(windows)]
pub fn spawn_watcher(app: AppHandle) {
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    std::thread::spawn(move || {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
        }
        let Ok(manager) = imp::manager() else { return };
        let mut last_track = String::new();
        let mut last_art: Option<String> = None;
        loop {
            let probe = imp::read(&manager, false).ok().flatten();
            let track = probe.as_ref().map(|n| format!("{}|{:?}|{}", n.title, n.artist, n.app)).unwrap_or_default();
            if track != last_track {
                last_track = track;
                last_art = imp::read(&manager, true).ok().flatten().and_then(|n| n.artwork);
            }
            let next = probe.map(|mut n| {
                n.artwork = last_art.clone();
                n
            });
            let changed = CURRENT.lock().map(|mut c| {
                // Position moves every tick; only notify on meaningful changes.
                let same = match (&*c, &next) {
                    (Some(a), Some(b)) => {
                        a.title == b.title && a.artist == b.artist && a.playing == b.playing && a.app == b.app
                            && (a.position.unwrap_or(0.0) - b.position.unwrap_or(0.0)).abs() < 5.0
                    }
                    (None, None) => true,
                    _ => false,
                };
                *c = next.clone();
                !same
            });
            if changed.unwrap_or(false) {
                let _ = app.emit("now-playing", &next);
            }
            std::thread::sleep(Duration::from_millis(1500));
        }
    });
}

#[cfg(not(windows))]
pub fn spawn_watcher(_: AppHandle) {}

#[tauri::command]
pub fn now_playing() -> Option<NowPlaying> {
    CURRENT.lock().ok()?.clone()
}

/// play/pause/skip on whatever app is currently playing.
#[tauri::command]
pub async fn media_control(action: String) -> Result<(), String> {
    if !matches!(action.as_str(), "playpause" | "next" | "prev") {
        return Err("Acción no válida.".into());
    }
    #[cfg(windows)]
    {
        std::thread::spawn(move || {
            use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            }
            imp::manager().and_then(|m| imp::control(&m, &action))
        })
        .join()
        .map_err(|_| "Error interno".to_string())?
        .map_err(|e| format!("La app no aceptó la orden: {}", e.message()))?;
        Ok(())
    }
    #[cfg(not(windows))]
    Err("Solo disponible en Windows.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches_reference() {
        assert_eq!(base64(b"Man"), "TWFu");
        assert_eq!(base64(b"Ma"), "TWE=");
        assert_eq!(base64(b"M"), "TQ==");
    }

    /// Read-only: prints what Windows reports as playing right now.
    #[cfg(windows)]
    #[test]
    #[ignore = "depends on what this PC is playing"]
    fn reads_current_session() {
        let manager = imp::manager().expect("media session manager");
        let now = imp::read(&manager, true).expect("read session");
        println!(
            "{:?}",
            now.map(|mut n| {
                n.artwork = n.artwork.map(|a| format!("{}… ({} bytes)", &a[..30], a.len()));
                n
            })
        );
    }

    #[test]
    fn app_names() {
        assert_eq!(friendly_app("Spotify.exe"), "Spotify");
        assert_eq!(friendly_app("MSEdge"), "Microsoft Edge");
        assert_eq!(friendly_app("308046B0AF4A39CB"), "Firefox");
    }
}
