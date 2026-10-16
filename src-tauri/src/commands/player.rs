//! NOVA's own full-screen player window for web apps that need no DRM
//! (YouTube's TV interface). NOVA controls the window completely: it chooses
//! the browser identity and injects a script before the page runs.
//!
//! The window loads remote content, so it is deliberately left out of every
//! capability: pages inside it cannot call NOVA commands.

use std::sync::atomic::{AtomicU32, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

pub const LABEL_PREFIX: &str = "player-";

/// Cobalt is the engine real smart TVs use for YouTube.
const TV_USER_AGENT: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.136 Safari/537.36 Cobalt/22.lts.3.306369-gold (unlike Gecko) v8/8.8.278.17-jit gles Starboard/13";

/// Tauri's default WebView2 flags, plus no UA client hints (they would reveal
/// "Edge on Windows" and make YouTube fall back to the desktop site).
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,UserAgentClientHint,UserAgentClientHintFullVersionList --autoplay-policy=no-user-gesture-required";

/// Runs before any page script, only with the TV identity (YouTube's TV interface).
const TV_IDENTITY_SCRIPT: &str = r#"
(() => {
  const def = (o, k, v) => { try { Object.defineProperty(o, k, { get: () => v, configurable: true }); } catch (_) {} };
  // Keep the TV identity consistent with the user agent.
  def(Navigator.prototype, 'platform', 'Linux x86_64');
  def(Navigator.prototype, 'userAgentData', undefined);
  def(Navigator.prototype, 'maxTouchPoints', 0);
})();
"#;

/// Runs before any page script, in every player window.
const INIT_SCRIPT: &str = r#"
(() => {
  // NOVA turns the controller into key presses itself; avoid double input.
  try { Navigator.prototype.getGamepads = function () { return []; }; } catch (_) {}
  // TV feel: hide the mouse pointer when idle.
  let timer;
  addEventListener('mousemove', () => {
    document.documentElement.style.cursor = '';
    clearTimeout(timer);
    timer = setTimeout(() => { document.documentElement.style.cursor = 'none'; }, 2500);
  }, true);
})();
"#;

/// Reports what is playing to NOVA (watch history) and resumes where you left off.
/// `__NOVA_RESUME__` is replaced with JSON built by Rust, never with page data.
const BRIDGE_SCRIPT: &str = r#"
(() => {
  if (location.hostname !== 'www.youtube.com') return;
  const RESUME = __NOVA_RESUME__;
  const invoke = (cmd, args) => {
    const ipc = window.__TAURI_INTERNALS__;
    return ipc ? ipc.invoke(cmd, args) : Promise.resolve();
  };
  const meta = {};
  let resumed = false, lastSent = 0, lastKey = '';
  const videoId = () => (location.hash.match(/[?&]v=([\w-]{11})/) || [])[1];
  async function details(v) {
    if (meta[v]) return meta[v];
    meta[v] = {};
    try {
      const r = await fetch('/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + v));
      if (r.ok) {
        const j = await r.json();
        meta[v] = { title: j.title, channel: j.author_name, channelUrl: j.author_url, thumbnail: j.thumbnail_url };
      }
    } catch (_) {}
    return meta[v];
  }
  async function tick(force) {
    const v = videoId();
    const el = document.querySelector('video');
    if (!v || !el || !isFinite(el.duration) || el.duration <= 0) return;
    if (RESUME && !resumed && RESUME.v === v && el.readyState >= 1) {
      resumed = true;
      if (RESUME.t > 0 && el.currentTime < RESUME.t - 5) el.currentTime = RESUME.t;
    }
    const now = Date.now();
    if (!force && lastKey === v && (el.paused || now - lastSent < 8000)) return;
    lastSent = now;
    lastKey = v;
    const m = await details(v);
    invoke('player_report', { report: Object.assign({ videoId: v, position: el.currentTime, duration: el.duration }, m) })
      .catch(() => {});
  }
  setInterval(() => tick(false), 2000);
  // Media events don't bubble; listen in the capture phase.
  addEventListener('pause', () => tick(true), true);
  addEventListener('ended', () => tick(true), true);
  addEventListener('pagehide', () => tick(true));
})();
"#;

static NEXT: AtomicU32 = AtomicU32::new(1);

/// Opens `url` full screen in a NOVA-owned TV window and returns its label.
pub fn open(app: &AppHandle, name: &str, url: &str) -> Result<String, String> {
    open_with_resume(app, name, url, None)
}

/// Like `open`, resuming `video_id` at `seconds` once it starts playing.
pub fn open_with_resume(app: &AppHandle, name: &str, url: &str, resume: Option<(&str, f64)>) -> Result<String, String> {
    build(app, name, url, resume, true)
}

/// A regular web player (e.g. Twitch's), full screen, without the TV identity.
pub fn open_plain(app: &AppHandle, name: &str, url: &str) -> Result<String, String> {
    build(app, name, url, None, false)
}

fn build(app: &AppHandle, name: &str, url: &str, resume: Option<(&str, f64)>, tv: bool) -> Result<String, String> {
    let url: tauri::Url = url.parse().map_err(|_| "Dirección no válida.".to_string())?;
    if url.scheme() != "https" {
        return Err("Solo se admiten direcciones https://".into());
    }
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?
        .join("player");
    let label = format!("{LABEL_PREFIX}{}", NEXT.fetch_add(1, Ordering::Relaxed));
    let resume_json = match resume {
        Some((v, t)) if crate::history::valid_video_id(v) && t.is_finite() => serde_json::json!({ "v": v, "t": t }).to_string(),
        _ => "null".to_string(),
    };
    let bridge = BRIDGE_SCRIPT.replace("__NOVA_RESUME__", &resume_json);
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(url))
        .title(name)
        .fullscreen(true)
        .focused(true)
        // Every player window shares one WebView2 profile, so the flags must match.
        .additional_browser_args(BROWSER_ARGS)
        .data_directory(data_dir);
    builder = if tv {
        builder.user_agent(TV_USER_AGENT).initialization_script(&format!("{TV_IDENTITY_SCRIPT}\n{INIT_SCRIPT}\n{bridge}"))
    } else {
        builder.initialization_script(INIT_SCRIPT)
    };
    builder.build().map_err(|e| format!("No se pudo abrir el reproductor: {e}"))?;
    Ok(label)
}
