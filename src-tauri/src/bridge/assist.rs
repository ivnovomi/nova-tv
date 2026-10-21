//! After NovaBridge opens a game, it watches what is in front on this PC:
//! while it's a launcher (asking for "Play", a login, an update…) the
//! controller is a pointer; once the game takes the screen, it's a controller
//! again (or keyboard and mouse, for the games that asked for it).

use super::input::{self, Mode};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(300);
/// The launcher hasn't come back for this long since the game showed up: done.
const SETTLED: Duration = Duration::from_secs(45);
const LONGEST: Duration = Duration::from_secs(15 * 60);

/// Launchers and stores (executable names, lowercase).
const LAUNCHERS: [&str; 16] = [
    "steam.exe",
    "steamwebhelper.exe",
    "epicgameslauncher.exe",
    "eadesktop.exe",
    "battle.net.exe",
    "upc.exe",
    "ubisoftconnect.exe",
    "galaxyclient.exe",
    "riotclientux.exe",
    "riotclientservices.exe",
    "minecraftlauncher.exe",
    "curseforge.exe",
    "modrinth app.exe",
    "prismlauncher.exe",
    "xboxpcapp.exe",
    "rockstarlauncher.exe",
];

/// Windows' own surfaces: no reason to change anything while they're in front.
const SHELL: [&str; 7] = ["explorer.exe", "shellexperiencehost.exe", "searchhost.exe", "startmenuexperiencehost.exe", "applicationframehost.exe", "nova-bridge.exe", "novabridge.exe"];

static RUN: AtomicU64 = AtomicU64::new(0);
/// The game being opened wants keyboard and mouse (NOVA says so with `/input`).
static KEYBOARD: AtomicBool = AtomicBool::new(false);

#[derive(Clone, Copy, PartialEq, Debug)]
enum Front {
    Launcher,
    Shell,
    Game,
}

fn classify(exe: &str) -> Front {
    let exe = exe.to_ascii_lowercase();
    if LAUNCHERS.contains(&exe.as_str()) {
        Front::Launcher
    } else if SHELL.contains(&exe.as_str()) {
        Front::Shell
    } else {
        Front::Game
    }
}

/// The game's mode once it's in front.
fn game_mode() -> Mode {
    if KEYBOARD.load(Ordering::Acquire) { Mode::Game } else { Mode::Off }
}

/// What NOVA wants for the game being opened; applies now if the game is already in front.
pub fn prefer_keyboard(on: bool) {
    KEYBOARD.store(on, Ordering::Release);
    if foreground().map(|(exe, _)| classify(&exe)) != Some(Front::Launcher) {
        input::set_mode(game_mode());
    }
}

/// Starts watching after a launch (a newer launch replaces it).
pub fn start() {
    KEYBOARD.store(false, Ordering::Release);
    let run = RUN.fetch_add(1, Ordering::AcqRel) + 1;
    let _ = thread::Builder::new().name("bridge-assist".into()).spawn(move || watch(run));
}

fn watch(run: u64) {
    let started = Instant::now();
    let mut last: Option<Front> = None;
    let mut game_seen: Option<Instant> = None;
    let mut launcher_seen: Option<Instant> = None;
    while RUN.load(Ordering::Acquire) == run && started.elapsed() < LONGEST {
        thread::sleep(POLL);
        let Some((exe, window)) = foreground() else { continue };
        let front = classify(&exe);
        let now = Instant::now();
        match front {
            Front::Launcher => launcher_seen = Some(now),
            Front::Game => {
                game_seen.get_or_insert(now);
            }
            Front::Shell => {}
        }
        // Act only when what's in front changes: a mode chosen in the tray stays.
        if last != Some(front) && front != Front::Shell {
            last = Some(front);
            match front {
                Front::Launcher => {
                    super::log(&format!("Lanzador delante ({exe}): el mando es un puntero"));
                    input::set_mode(Mode::Desktop);
                    center_pointer(window);
                }
                _ => {
                    super::log(&format!("Juego delante ({exe})"));
                    input::set_mode(game_mode());
                }
            }
        }
        // The game has been in front for a while and no launcher came back: done.
        if let Some(seen) = game_seen
            && now - seen > SETTLED
            && launcher_seen.is_none_or(|l| now - l > SETTLED)
        {
            break;
        }
    }
}

/// The program in front: its executable's name and its window.
fn foreground() -> Option<(String, isize)> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    unsafe {
        let hwnd = GetForegroundWindow();
        if hwnd.0.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buf = [0u16; 1024];
        let mut len = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let path = String::from_utf16_lossy(&buf[..len as usize]);
        let name = path.rsplit(['\\', '/']).next().unwrap_or(&path).to_string();
        Some((name, hwnd.0 as isize))
    }
}

/// Puts the pointer in the middle of the launcher, so "Play" is a short move away.
fn center_pointer(window: isize) {
    use windows::Win32::Foundation::{HWND, RECT};
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, SetCursorPos};
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(HWND(window as *mut _), &mut rect).is_ok() {
            let _ = SetCursorPos((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_launchers_from_games() {
        assert_eq!(classify("Steam.exe"), Front::Launcher);
        assert_eq!(classify("Modrinth App.exe"), Front::Launcher);
        assert_eq!(classify("CurseForge.exe"), Front::Launcher);
        assert_eq!(classify("explorer.exe"), Front::Shell);
        assert_eq!(classify("javaw.exe"), Front::Game);
        assert_eq!(classify("Cyberpunk2077.exe"), Front::Game);
    }

    /// What this PC has in front right now (the terminal, most likely).
    #[test]
    #[ignore = "depends on the desktop"]
    fn reads_the_foreground() {
        println!("{:?}", foreground());
    }
}
