//! The power button: turn the PC off or restart it, switch the screen off,
//! leave NOVA for the desktop, restart NOVA, and a TV-style sleep timer.
//!
//! The interface always asks first (a countdown that can be cancelled, also
//! from the phone). Only fixed actions exist; the system's own shutdown tool
//! is run with fixed arguments, never a command line.

use crate::history::HistoryStore;
use crate::profiles::require_adult;
use crate::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

/// Screen switched off by NOVA: the next controller press turns it back on.
static DISPLAY_OFF: AtomicBool = AtomicBool::new(false);
/// Sleep timer: when it fires (Unix seconds), and which one (a new one cancels the old).
static TIMER_UNTIL: Mutex<Option<u64>> = Mutex::new(None);
static TIMER_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PowerInfo {
    /// "Salir a Windows": the system NOVA runs on.
    os: &'static str,
    /// Sleep timer end, Unix seconds.
    timer_until: Option<u64>,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    }
}

pub fn info() -> PowerInfo {
    PowerInfo { os: os_name(), timer_until: TIMER_UNTIL.lock().ok().and_then(|t| *t) }
}

/// Turns the PC off or restarts it with the system's own tool.
fn system_power(restart: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        let tool = std::path::Path::new(&root).join("System32").join("shutdown.exe");
        std::process::Command::new(tool)
            .args([if restart { "/r" } else { "/s" }, "/t", "0"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("No se pudo {} el equipo: {e}", if restart { "reiniciar" } else { "apagar" }))
    }
    #[cfg(target_os = "macos")]
    {
        let script = if restart { "tell app \"System Events\" to restart" } else { "tell app \"System Events\" to shut down" };
        std::process::Command::new("/usr/bin/osascript").args(["-e", script]).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("systemctl").arg(if restart { "reboot" } else { "poweroff" }).spawn().map(|_| ()).map_err(|e| e.to_string())
    }
}

/// Switches the screen off (like a TV's picture-off). Any key, the mouse,
/// the phone or a controller turns it back on.
fn display_off() -> Result<(), String> {
    #[cfg(windows)]
    {
        DISPLAY_OFF.store(true, Ordering::Release);
        // A moment first, so the key or click that asked for it doesn't wake it at once.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_millis(600));
            use windows::Win32::Foundation::{LPARAM, WPARAM};
            use windows::Win32::UI::WindowsAndMessaging::{PostMessageW, HWND_BROADCAST, SC_MONITORPOWER, WM_SYSCOMMAND};
            // 2 = off.
            let _ = unsafe { PostMessageW(Some(HWND_BROADCAST), WM_SYSCOMMAND, WPARAM(SC_MONITORPOWER as usize), LPARAM(2)) };
        });
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Err("Disponible en Windows".into())
    }
}

pub fn display_is_off() -> bool {
    DISPLAY_OFF.load(Ordering::Acquire)
}

/// Controllers don't wake Windows' screen by themselves: a tiny mouse nudge does.
pub fn wake_display() {
    if !DISPLAY_OFF.swap(false, Ordering::AcqRel) {
        return;
    }
    #[cfg(windows)]
    {
        use windows::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_MOVE, MOUSEINPUT};
        let nudge = |dx: i32| INPUT {
            r#type: INPUT_MOUSE,
            Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 } },
        };
        unsafe {
            SendInput(&[nudge(1), nudge(-1)], std::mem::size_of::<INPUT>() as i32);
        }
    }
}

/// Runs one of the power actions (the interface has already asked).
pub fn run(app: &AppHandle, action: &str) -> Result<(), String> {
    match action {
        "shutdown" | "restart" => {
            app.state::<HistoryStore>().flush();
            system_power(action == "restart")
        }
        // Leaving NOVA for the desktop: a children's profile needs a parent.
        "exit" => {
            require_adult(&app.state::<AppState>())?;
            app.exit(0);
            Ok(())
        }
        "restart-nova" => {
            app.state::<HistoryStore>().flush();
            app.restart()
        }
        "display-off" => display_off(),
        _ => Err("Acción no válida".into()),
    }
}

/// Sets (1–240 minutes) or cancels (`None`) the sleep timer. When it ends the
/// interface counts down a last minute before turning the PC off.
pub fn set_timer(app: &AppHandle, minutes: Option<u32>) -> Result<PowerInfo, String> {
    let generation = TIMER_GEN.fetch_add(1, Ordering::AcqRel) + 1;
    let until = match minutes {
        Some(m) if (1..=240).contains(&m) => Some(now_secs() + u64::from(m) * 60),
        Some(_) => return Err("El temporizador va de 1 a 240 minutos".into()),
        None => None,
    };
    *TIMER_UNTIL.lock().map_err(|e| e.to_string())? = until;
    if let Some(until) = until {
        let app = app.clone();
        std::thread::spawn(move || {
            while now_secs() < until {
                std::thread::sleep(Duration::from_secs(1));
                if TIMER_GEN.load(Ordering::Acquire) != generation {
                    return;
                }
            }
            if let Ok(mut t) = TIMER_UNTIL.lock() {
                *t = None;
            }
            let _ = app.emit("power-timer-due", ());
            let _ = app.emit("power-changed", info());
        });
    }
    let _ = app.emit("power-changed", info());
    Ok(info())
}

#[tauri::command]
pub fn power_info() -> PowerInfo {
    info()
}

#[tauri::command]
pub fn power_action(app: AppHandle, action: String) -> Result<(), String> {
    run(&app, &action)
}

#[tauri::command]
pub fn power_timer(app: AppHandle, minutes: Option<u32>) -> Result<PowerInfo, String> {
    set_timer(&app, minutes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_is_named() {
        assert!(["Windows", "macOS", "Linux"].contains(&os_name()));
    }
}
