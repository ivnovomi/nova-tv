//! Brings NOVA back when a game closes, like a console.
//!
//! Games often aren't the process NOVA starts (Steam, Epic and Riot start them
//! for us; Minecraft goes through its launcher), so NOVA watches the game's
//! install folder instead: it waits for a process from that folder to appear,
//! and when none has been running for a few seconds, the game has ended.

use crate::commands::{games, steam};
use crate::config::{Shortcut, Target};
use crate::{playtime, session};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

const POLL: Duration = Duration::from_secs(2);
/// Launchers can take a while to start the actual game.
const START_TIMEOUT: Duration = Duration::from_secs(240);
/// Launcher → game hand-offs leave short gaps; don't end on those.
const GONE_POLLS: u32 = 3;

static GENERATION: AtomicU64 = AtomicU64::new(0);

/// How a launch is going, for NOVA's loading screen (`game-launch` event).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LaunchStage {
    pub id: String,
    /// "running" (its process appeared), "unwatched" (NOVA can't tell when it
    /// starts), or for a PC's games "connecting" | "waking" | "starting" | "streaming".
    pub stage: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

pub fn stage(app: &AppHandle, id: &str, stage: &'static str, detail: Option<String>) {
    let _ = app.emit("game-launch", LaunchStage { id: id.to_string(), stage, detail });
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GameEnded {
    id: String,
    name: String,
    seconds: u64,
}

fn lower(p: &Path) -> String {
    let mut s = p.to_string_lossy().to_lowercase();
    if !s.ends_with('\\') {
        s.push('\\');
    }
    s
}

/// Folders whose processes belong to this game (lowercase, with trailing `\`).
fn prefixes(game: &Shortcut) -> Vec<String> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    match &game.target {
        Target::Steam { app_id } => dirs.extend(steam::install_dir(*app_id)),
        // Riot games start through Riot Client, which stays open: watching its folder
        // would mean the game never ends. Only the game's own install folder counts.
        Target::Executable { .. } if game.id.starts_with("riot:") => {}
        Target::Executable { path, .. } => dirs.extend(Path::new(path).parent().map(Path::to_path_buf)),
        _ => {}
    }
    dirs.extend(games::install_dir(&game.id));
    // Minecraft Java runs from the launcher's runtime and game folders.
    if game.name == "Minecraft" {
        let env = |v: &str| std::env::var_os(v).map(PathBuf::from);
        dirs.extend(env("APPDATA").map(|p| p.join(".minecraft")));
        dirs.extend(env("LOCALAPPDATA").map(|p| p.join(r"Packages\Microsoft.4297127D64EC6_8wekyb3d8bbwe")));
    }
    // Never treat a whole system folder as "the game".
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| r"C:\Windows".into()).to_lowercase();
    let mut out: Vec<String> = dirs
        .iter()
        .map(|d| lower(d))
        .filter(|d| !d.starts_with(&windir) && d.matches('\\').count() > 2)
        .collect();
    out.sort();
    out.dedup();
    out
}

fn game_running(sys: &mut System, prefixes: &[String], me: u32) -> bool {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet),
    );
    sys.processes().iter().any(|(pid, p)| {
        pid.as_u32() != me
            && p.exe().is_some_and(|exe| {
                let exe = exe.to_string_lossy().to_lowercase();
                prefixes.iter().any(|pre| exe.starts_with(pre.as_str()))
            })
    })
}

/// Starts watching `game` after NOVA launched it. A newer launch replaces it.
/// Tells the loading screen when the game is up (or that NOVA can't tell).
pub fn watch(app: &AppHandle, game: &Shortcut) {
    let prefixes = prefixes(game);
    let generation = GENERATION.fetch_add(1, Ordering::AcqRel) + 1;
    if prefixes.is_empty() {
        stage(app, &game.id, "unwatched", None);
        return;
    }
    let (app, id, name) = (app.clone(), game.id.clone(), game.name.clone());
    thread::spawn(move || {
        let me = std::process::id();
        let mut sys = System::new();
        let launched = Instant::now();
        let mut started: Option<Instant> = None;
        let mut gone = 0;
        // Seconds already written to the play-time store (saved every minute).
        let mut recorded = 0u64;
        loop {
            thread::sleep(POLL);
            if GENERATION.load(Ordering::Acquire) != generation {
                // Replaced by another launch: keep what was played so far.
                if let Some(at) = started {
                    playtime::record(&app, &id, at.elapsed().as_secs().saturating_sub(recorded), false);
                }
                return;
            }
            let running = game_running(&mut sys, &prefixes, me);
            match (started, running) {
                (None, true) => {
                    started = Some(Instant::now());
                    playtime::record(&app, &id, 0, true);
                    stage(&app, &id, "running", None);
                }
                (None, false) if launched.elapsed() > START_TIMEOUT => {
                    stage(&app, &id, "unwatched", None);
                    return;
                }
                (Some(at), true) => {
                    gone = 0;
                    let played = at.elapsed().as_secs();
                    if played - recorded >= 60 {
                        playtime::record(&app, &id, played - recorded, false);
                        recorded = played;
                    }
                }
                (Some(at), false) => {
                    gone += 1;
                    if gone >= GONE_POLLS {
                        let seconds = at.elapsed().as_secs().saturating_sub(POLL.as_secs() * u64::from(GONE_POLLS));
                        playtime::record(&app, &id, seconds.saturating_sub(recorded), false);
                        let _ = app.emit("game-ended", GameEnded { id, name, seconds });
                        session::focus_main(&app);
                        return;
                    }
                }
                _ => {}
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ShortcutKind, ShortcutSource};

    fn exe_game(path: &str) -> Shortcut {
        Shortcut {
            id: "game-test".into(),
            name: "Test".into(),
            description: None,
            kind: ShortcutKind::Game,
            target: Target::Executable { path: path.into(), args: vec![] },
            source: ShortcutSource::User,
        }
    }

    #[test]
    fn system_folders_are_never_watched() {
        assert!(prefixes(&exe_game(r"C:\Windows\System32\notepad.exe")).is_empty());
        assert!(prefixes(&exe_game(r"C:\game.exe")).is_empty());
        assert_eq!(prefixes(&exe_game(r"D:\Games\Celeste\Celeste.exe")), vec![r"d:\games\celeste\".to_string()]);
    }

    /// The test binary's own folder counts as "running" (it's this process' sibling check).
    #[test]
    fn detects_a_running_process_by_folder() {
        let exe = std::env::current_exe().unwrap();
        let prefix = lower(exe.parent().unwrap());
        let mut sys = System::new();
        // Excluding nobody: this test process itself lives in that folder.
        assert!(game_running(&mut sys, &[prefix.clone()], 0));
        // Excluding ourselves and pointing at an empty folder: nothing runs there.
        assert!(!game_running(&mut sys, &[r"z:\nova-no-such-folder\".into()], std::process::id()));
    }
}
