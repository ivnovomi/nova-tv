//! The active streaming session: tracks what NOVA TV opened (its own player
//! window, a browser app window or a Store app), returns focus to NOVA when it
//! closes, and turns the controller into key presses for it.
//!
//! While a session is active:
//! - Home / BrowserHome (keyboard, TV remotes) and View+Menu on the controller
//!   close it and bring NOVA back.
//! - D-pad/stick, A, B and X become arrows, Enter, Escape and Play/Pause, but
//!   only while the session's own window is in the foreground.

use crate::remote::keys;
use serde::Serialize;
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut as HotKey};

pub enum Kind {
    /// NOVA's own player window (by label).
    Player(String),
    /// A browser process NOVA started.
    Browser(Child),
    /// Moonlight playing a game from a PC: it reads the controller itself.
    Game(Child),
    /// A Store app, or a browser that handed off to an already running instance.
    Untracked,
}

struct Session {
    id: u64,
    name: String,
    kind: Kind,
    started: Instant,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Title of what is playing in the session, when the player reports it.
static NOW_PLAYING: Mutex<Option<String>> = Mutex::new(None);

pub fn set_now_playing(title: Option<String>) {
    if let Ok(mut n) = NOW_PLAYING.lock() {
        *n = title;
    }
}

pub fn now_playing() -> Option<String> {
    NOW_PLAYING.lock().ok().and_then(|n| n.clone())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionEvent {
    active: bool,
    name: String,
    /// "started" | "closed" (the user closed it) | "home" (returned with the remote)
    reason: &'static str,
}

fn hotkeys() -> [HotKey; 2] {
    [HotKey::new(None, Code::Home), HotKey::new(None, Code::BrowserHome)]
}

fn set_hotkeys(app: &AppHandle, on: bool) {
    let gs = app.global_shortcut();
    for key in hotkeys() {
        let _ = if on { gs.register(key) } else { gs.unregister(key) };
    }
}

fn emit(app: &AppHandle, active: bool, name: &str, reason: &'static str) {
    let _ = app.emit("stream-session", SessionEvent { active, name: name.to_string(), reason });
}

pub fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        // Toggling always-on-top lets a background process reclaim the foreground.
        let _ = w.set_always_on_top(true);
        let _ = w.set_focus();
        let _ = w.set_always_on_top(false);
    }
}

pub fn is_active() -> bool {
    SESSION.lock().map(|s| s.is_some()).unwrap_or(false)
}

pub fn current_name() -> Option<String> {
    SESSION.lock().ok().and_then(|s| s.as_ref().map(|s| s.name.clone()))
}

/// True when NOVA cannot tell when the session ends (Store apps).
pub fn is_untracked() -> bool {
    SESSION.lock().map(|s| s.as_ref().is_some_and(|s| matches!(s.kind, Kind::Untracked))).unwrap_or(false)
}

pub fn start(app: &AppHandle, name: &str, kind: Kind) {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let watch = matches!(kind, Kind::Browser(_) | Kind::Game(_));
    set_now_playing(None);
    if let Ok(mut s) = SESSION.lock() {
        *s = Some(Session { id, name: name.to_string(), kind, started: Instant::now() });
    }
    set_hotkeys(app, true);
    emit(app, true, name, "started");
    if watch {
        let app = app.clone();
        thread::spawn(move || watch_browser(app, id));
    }
}

fn finish(app: &AppHandle, name: &str, reason: &'static str) {
    set_hotkeys(app, false);
    set_now_playing(None);
    emit(app, false, name, reason);
    focus_main(app);
}

fn watch_browser(app: AppHandle, id: u64) {
    loop {
        thread::sleep(Duration::from_millis(500));
        let Ok(mut guard) = SESSION.lock() else { return };
        let Some(session) = guard.as_mut().filter(|s| s.id == id) else { return };
        let (child, game) = match &mut session.kind {
            Kind::Browser(child) => (child, false),
            Kind::Game(child) => (child, true),
            _ => return,
        };
        match child.try_wait() {
            Ok(None) => {}
            Ok(Some(_)) if !game && session.started.elapsed() < Duration::from_secs(4) => {
                // Handed the window to an already running instance: can't track it.
                session.kind = Kind::Untracked;
                return;
            }
            Ok(Some(_)) | Err(_) => {
                let name = session.name.clone();
                *guard = None;
                drop(guard);
                finish(&app, &name, "closed");
                return;
            }
        }
    }
}

/// Called when a window is destroyed: if it was the session's player, the user closed it.
pub fn window_destroyed(app: &AppHandle, label: &str) {
    let Ok(mut guard) = SESSION.lock() else { return };
    let is_ours = guard.as_ref().is_some_and(|s| matches!(&s.kind, Kind::Player(l) if l == label));
    if !is_ours {
        return;
    }
    let name = guard.take().map(|s| s.name).unwrap_or_default();
    drop(guard);
    finish(app, &name, "closed");
}

/// Ends the current session, closing whatever NOVA opened when it can.
pub fn end(app: &AppHandle, refocus: bool) {
    let Some(session) = SESSION.lock().ok().and_then(|mut s| s.take()) else { return };
    set_hotkeys(app, false);
    set_now_playing(None);
    match session.kind {
        Kind::Player(label) => {
            if let Some(w) = app.get_webview_window(&label) {
                let _ = w.destroy();
            }
        }
        Kind::Browser(child) | Kind::Game(child) => close_gracefully(child),
        Kind::Untracked => {}
    }
    emit(app, false, &session.name, "home");
    if refocus {
        focus_main(app);
    }
}

/// `end` for async commands: closing a browser can wait up to 3 s, so it runs off the async runtime.
pub async fn end_blocking(app: &AppHandle) {
    let app = app.clone();
    let _ = tauri::async_runtime::spawn_blocking(move || end(&app, false)).await;
}

/// Remote "Home": leave the service and go back to NOVA TV.
pub fn go_home(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if is_active() {
            end(&app, true);
        } else {
            focus_main(&app);
        }
    });
}

fn close_gracefully(mut child: Child) {
    #[cfg(windows)]
    win::post_close(child.id());
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Whether synthetic keys from the controller should go to the foreground window now.
fn controller_may_type(app: &AppHandle) -> bool {
    let main_focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    if main_focused {
        return false; // NOVA's own UI reads the controller itself
    }
    let Ok(guard) = SESSION.lock() else { return false };
    let Some(session) = guard.as_ref() else { return false };
    #[cfg(windows)]
    {
        let fg = keys::foreground_pid();
        match &session.kind {
            Kind::Player(_) => fg == Some(std::process::id()),
            Kind::Browser(child) => fg == Some(child.id()),
            // Moonlight sends the controller to the PC as it is.
            Kind::Game(_) => false,
            // Store apps run under system hosts; any foreground app except NOVA.
            Kind::Untracked => fg.is_some() && fg != Some(std::process::id()),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = session;
        false
    }
}

#[cfg(windows)]
mod win {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindowThreadProcessId, IsWindowVisible, PostMessageW, WM_CLOSE,
    };

    unsafe extern "system" fn close_if_owned(hwnd: HWND, lparam: LPARAM) -> BOOL {
        let target = lparam.0 as u32;
        let mut pid = 0u32;
        unsafe {
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == target && IsWindowVisible(hwnd).as_bool() {
                let _ = PostMessageW(Some(hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
        BOOL(1)
    }

    /// Politely asks every visible top-level window of `pid` to close.
    pub fn post_close(pid: u32) {
        unsafe {
            let _ = EnumWindows(Some(close_if_owned), LPARAM(pid as isize));
        }
    }
}

/// A connected controller as seen by XInput (no button press needed, unlike the web API).
#[derive(Serialize, Clone, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PadInfo {
    id: usize,
    name: String,
    /// 0-100 when the driver reports it.
    battery: Option<u8>,
    charging: bool,
    wired: bool,
}

static PADS: Mutex<Vec<PadInfo>> = Mutex::new(Vec::new());

/// Connected controllers right now.
#[tauri::command]
pub fn list_gamepads() -> Vec<PadInfo> {
    PADS.lock().map(|p| p.clone()).unwrap_or_default()
}

fn pad_snapshot(gilrs: &gilrs::Gilrs) -> Vec<PadInfo> {
    use gilrs::PowerInfo;
    gilrs
        .gamepads()
        .map(|(id, pad)| {
            let (battery, charging, wired) = match pad.power_info() {
                PowerInfo::Wired => (None, false, true),
                PowerInfo::Discharging(l) => (Some(l), false, false),
                PowerInfo::Charging(l) => (Some(l), true, false),
                PowerInfo::Charged => (Some(100), false, false),
                PowerInfo::Unknown => (None, false, false),
            };
            PadInfo { id: usize::from(id), name: pad.name().to_string(), battery, charging, wired }
        })
        .collect()
}

/// Background controller listener (XInput works while other windows have focus).
pub fn spawn_gamepad_listener(app: AppHandle) {
    thread::spawn(move || {
        use gilrs::{Axis, Button, Gilrs};
        let Ok(mut gilrs) = Gilrs::new() else { return };
        const FIRST_REPEAT: Duration = Duration::from_millis(380);
        const REPEAT: Duration = Duration::from_millis(130);
        let mut home_armed = true;
        // (action, next fire time) for held inputs.
        let mut held: Vec<(&'static str, Instant)> = Vec::new();

        let mut last_poll = Instant::now() - Duration::from_secs(10);
        loop {
            while gilrs.next_event().is_some() {}
            // Keep the connected-controllers list fresh (battery changes slowly).
            if last_poll.elapsed() >= Duration::from_millis(500) {
                last_poll = Instant::now();
                let snapshot = pad_snapshot(&gilrs);
                let changed = PADS.lock().map(|mut p| {
                    let changed = *p != snapshot;
                    if changed {
                        *p = snapshot.clone();
                    }
                    changed
                });
                if changed.unwrap_or(false) {
                    let _ = app.emit("gamepads-changed", &snapshot);
                }
            }
            // Screen switched off from the power menu: any button turns it back on.
            if crate::power::display_is_off() {
                let any = gilrs.gamepads().any(|(_, pad)| {
                    [Button::South, Button::East, Button::West, Button::North, Button::Start, Button::Mode, Button::DPadUp, Button::DPadDown, Button::DPadLeft, Button::DPadRight]
                        .into_iter()
                        .any(|b| pad.is_pressed(b))
                });
                if any {
                    crate::power::wake_display();
                }
            }
            if !is_active() {
                home_armed = true;
                held.clear();
                thread::sleep(Duration::from_millis(250));
                continue;
            }

            let mut pressed: Vec<&'static str> = Vec::new();
            let mut home = false;
            for (_, pad) in gilrs.gamepads() {
                let ax = pad.value(Axis::LeftStickX);
                let ay = pad.value(Axis::LeftStickY);
                if pad.is_pressed(Button::DPadUp) || ay > 0.6 { pressed.push("up") }
                if pad.is_pressed(Button::DPadDown) || ay < -0.6 { pressed.push("down") }
                if pad.is_pressed(Button::DPadLeft) || ax < -0.6 { pressed.push("left") }
                if pad.is_pressed(Button::DPadRight) || ax > 0.6 { pressed.push("right") }
                if pad.is_pressed(Button::South) { pressed.push("ok") }
                if pad.is_pressed(Button::East) { pressed.push("back") }
                if pad.is_pressed(Button::West) { pressed.push("playpause") }
                home |= (pad.is_pressed(Button::Start) && pad.is_pressed(Button::Select)) || pad.is_pressed(Button::Mode);
            }

            if home {
                if home_armed {
                    home_armed = false;
                    held.clear();
                    go_home(&app);
                }
                thread::sleep(Duration::from_millis(30));
                continue;
            }
            home_armed = true;

            let now = Instant::now();
            held.retain(|(a, _)| pressed.contains(a));
            for action in pressed {
                let repeats = matches!(action, "up" | "down" | "left" | "right");
                let fire = match held.iter_mut().find(|(a, _)| *a == action) {
                    None => {
                        held.push((action, now + FIRST_REPEAT));
                        true
                    }
                    Some((_, next)) if repeats && now >= *next => {
                        *next = now + REPEAT;
                        true
                    }
                    Some(_) => false,
                };
                if fire && controller_may_type(&app) {
                    keys::tap(match action {
                        "up" => keys::UP,
                        "down" => keys::DOWN,
                        "left" => keys::LEFT,
                        "right" => keys::RIGHT,
                        "ok" => keys::ENTER,
                        "back" => keys::ESCAPE,
                        _ => keys::MEDIA_PLAY_PAUSE,
                    });
                }
            }
            thread::sleep(Duration::from_millis(16));
        }
    });
}
