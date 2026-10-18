//! NOVA's own volume, like a TV's: the volume keys (keyboard, media remotes,
//! the phone) change the volume through NOVA, which shows its own bar instead
//! of Windows'. Only while NOVA, or something it opened, is in front; with
//! NOVA in the background the keys are Windows' as always.
//!
//! The bar is its own small window (transparent, always on top, never takes
//! the focus or the mouse), so it shows over the TV, a streaming service or a game.

use crate::commands::system::{volume, VolumeState};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindowBuilder};

/// Volume step per press, like a TV remote.
pub const STEP: u32 = 2;
const LABEL: &str = "volume";
/// How long the bar stays after the last change.
const VISIBLE: Duration = Duration::from_millis(1800);
const FADE: Duration = Duration::from_millis(350);

#[derive(Clone, Copy, Debug)]
pub enum Change {
    Up,
    Down,
    Mute,
}

static SHOWN: AtomicU64 = AtomicU64::new(0);

/// Changes the volume and shows the bar.
pub fn change(app: &AppHandle, change: Change) -> Result<VolumeState, String> {
    let now = volume::get()?;
    let state = match change {
        Change::Up => {
            if now.muted {
                volume::set_mute(false)?;
            }
            volume::set_level((now.level + STEP).min(100))?
        }
        Change::Down => volume::set_level(now.level.saturating_sub(STEP))?,
        Change::Mute => volume::set_mute(!now.muted)?,
    };
    show(app, &state);
    Ok(state)
}

/// Shows the bar with this volume (and hides it a moment after the last change).
pub fn show(app: &AppHandle, state: &VolumeState) {
    let Some(window) = window(app) else { return };
    let _ = app.emit_to(LABEL, "volume-osd", state);
    present(&window);
    let generation = SHOWN.fetch_add(1, Ordering::AcqRel) + 1;
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(VISIBLE);
        if SHOWN.load(Ordering::Acquire) != generation {
            return;
        }
        let _ = app.emit_to(LABEL, "volume-osd-hide", ());
        std::thread::sleep(FADE);
        if SHOWN.load(Ordering::Acquire) == generation {
            if let Some(w) = app.get_webview_window(LABEL) {
                let _ = w.hide();
            }
        }
    });
}

/// The bar's window, created the first time (from tauri.conf.json), at the right edge of the screen.
fn window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let config = app.config().app.windows.iter().find(|w| w.label == LABEL)?.clone();
    let window = WebviewWindowBuilder::from_config(app, &config).ok()?.build().ok()?;
    let _ = window.set_ignore_cursor_events(true);
    if let Ok(Some(monitor)) = window.primary_monitor() {
        let scale = monitor.scale_factor();
        let size = monitor.size().to_logical::<f64>(scale);
        let position = monitor.position().to_logical::<f64>(scale);
        let _ = window.set_position(tauri::LogicalPosition::new(position.x + size.width - config.width - 24.0, position.y + (size.height - config.height) / 2.0));
    }
    no_activate(&window);
    Some(window)
}

/// Never takes the focus from what's playing, and stays out of Alt+Tab.
#[cfg(windows)]
fn no_activate(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW};
    if let Ok(hwnd) = window.hwnd() {
        let hwnd = HWND(hwnd.0 as _);
        unsafe {
            let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style | (WS_EX_NOACTIVATE.0 | WS_EX_TOOLWINDOW.0) as isize);
        }
    }
}

#[cfg(not(windows))]
fn no_activate(_: &tauri::WebviewWindow) {}

/// Shows it without activating it (on top of whatever is in front).
#[cfg(windows)]
fn present(window: &tauri::WebviewWindow) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, ShowWindow, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SW_SHOWNOACTIVATE};
    if let Ok(hwnd) = window.hwnd() {
        let hwnd = HWND(hwnd.0 as _);
        unsafe {
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            let _ = SetWindowPos(hwnd, Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
fn present(window: &tauri::WebviewWindow) {
    let _ = window.show();
}

// ───────────────────────── Volume keys ─────────────────────────

static KEYS: OnceLock<mpsc::Sender<Change>> = OnceLock::new();

/// Listens for the volume keys (a low-level keyboard hook that only looks at
/// those three keys and lets every other key through untouched).
#[cfg(windows)]
pub fn spawn(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<Change>();
    if KEYS.set(tx).is_err() {
        return;
    }
    // Changes happen here, not in the hook (which has to answer Windows at once).
    let worker = app.clone();
    std::thread::spawn(move || {
        for change in rx {
            let _ = self::change(&worker, change);
        }
    });
    std::thread::spawn(|| unsafe {
        use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, SetWindowsHookExW, TranslateMessage, MSG, WH_KEYBOARD_LL};
        let Ok(_hook) = SetWindowsHookExW(WH_KEYBOARD_LL, Some(hook), None, 0) else { return };
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    });
}

#[cfg(not(windows))]
pub fn spawn(_: AppHandle) {}

#[cfg(windows)]
unsafe extern "system" fn hook(code: i32, wparam: windows::Win32::Foundation::WPARAM, lparam: windows::Win32::Foundation::LPARAM) -> windows::Win32::Foundation::LRESULT {
    use windows::Win32::Foundation::LRESULT;
    use windows::Win32::UI::WindowsAndMessaging::{CallNextHookEx, HC_ACTION, KBDLLHOOKSTRUCT, WM_KEYDOWN, WM_KEYUP, WM_SYSKEYDOWN, WM_SYSKEYUP};
    if code == HC_ACTION as i32 {
        let key = unsafe { &*(lparam.0 as *const KBDLLHOOKSTRUCT) };
        let change = match key.vkCode as u16 {
            crate::remote::keys::VOLUME_UP => Some(Change::Up),
            crate::remote::keys::VOLUME_DOWN => Some(Change::Down),
            crate::remote::keys::VOLUME_MUTE => Some(Change::Mute),
            _ => None,
        };
        if let Some(change) = change {
            if crate::remote::keys::target_allowed() {
                let message = wparam.0 as u32;
                if message == WM_KEYDOWN || message == WM_SYSKEYDOWN {
                    if let Some(tx) = KEYS.get() {
                        let _ = tx.send(change);
                    }
                }
                // Handled by NOVA: Windows doesn't see it (no Windows volume flyout).
                if matches!(message, WM_KEYDOWN | WM_SYSKEYDOWN | WM_KEYUP | WM_SYSKEYUP) {
                    return LRESULT(1);
                }
            }
        }
    }
    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}
