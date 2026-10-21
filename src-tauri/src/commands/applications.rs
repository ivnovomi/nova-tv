//! App and game shortcuts: listing, validated registration and launching.
//!
//! The frontend never sends a path to launch. It sends a shortcut id, which is
//! resolved here against the persisted config or the detected/Steam lists, and
//! the executable is spawned directly (no shell) with structured arguments.

use crate::config::{new_id, Shortcut, ShortcutKind, ShortcutSource, Target, MAX_RECENT};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};
use tauri::{AppHandle, Manager, State};

const MAX_ARGS: usize = 16;
const MAX_ARG_LEN: usize = 512;
const MAX_PATH_LEN: usize = 1024;
const MAX_NAME_LEN: usize = 60;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    pub apps: Vec<Shortcut>,
    pub games: Vec<Shortcut>,
    pub streaming: Vec<Shortcut>,
    pub recent: Vec<String>,
    pub steam_installed: bool,
    pub browser_available: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewExecutable {
    pub name: String,
    pub description: Option<String>,
    pub kind: ShortcutKind,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
}

pub fn validate_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("El nombre no puede estar vacío.".into());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("El nombre no puede superar {MAX_NAME_LEN} caracteres."));
    }
    if name.chars().any(char::is_control) {
        return Err("El nombre contiene caracteres no válidos.".into());
    }
    Ok(name.to_string())
}

pub fn validate_executable(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim().trim_matches('"');
    if trimmed.is_empty() || trimmed.len() > MAX_PATH_LEN || trimmed.contains('\0') {
        return Err("La ruta del ejecutable no es válida.".into());
    }
    let p = PathBuf::from(trimmed);
    if !p.is_absolute() {
        return Err("La ruta debe ser absoluta (por ejemplo C:\\Program Files\\App\\app.exe).".into());
    }
    let is_exe = p
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    if !is_exe {
        return Err("Solo se admiten archivos .exe.".into());
    }
    if !p.is_file() {
        return Err(format!("No se encuentra el ejecutable: {}", p.display()));
    }
    Ok(p)
}

pub fn validate_args(args: &[String]) -> Result<Vec<String>, String> {
    if args.len() > MAX_ARGS {
        return Err(format!("Máximo {MAX_ARGS} argumentos."));
    }
    args.iter()
        .map(|a| {
            if a.len() > MAX_ARG_LEN || a.contains('\0') {
                Err("Hay un argumento demasiado largo o con caracteres no válidos.".to_string())
            } else {
                Ok(a.clone())
            }
        })
        .filter(|a| !matches!(a, Ok(s) if s.trim().is_empty()))
        .collect()
}

fn env_path(var: &str, rest: &str) -> Option<PathBuf> {
    env::var_os(var).map(|base| Path::new(&base).join(rest))
}

fn program_files(rest: &str) -> Vec<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|v| env_path(v, rest))
        .collect()
}

/// Well-known applications, included only if their executable exists on this PC.
pub(crate) fn detected_apps() -> Vec<Shortcut> {
    let windir = env::var_os("WINDIR").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
    let mut candidates: Vec<(&str, &str, &str, Vec<PathBuf>, Vec<&str>)> = vec![
        ("chrome", "Google Chrome", "Navegador web", program_files(r"Google\Chrome\Application\chrome.exe"), vec![]),
        ("edge", "Microsoft Edge", "Navegador web", program_files(r"Microsoft\Edge\Application\msedge.exe"), vec![]),
        ("firefox", "Firefox", "Navegador web", program_files(r"Mozilla Firefox\firefox.exe"), vec![]),
        ("vlc", "VLC Media Player", "Reproductor multimedia", program_files(r"VideoLAN\VLC\vlc.exe"), vec![]),
        ("spotify", "Spotify", "Música en streaming", env_path("APPDATA", r"Spotify\Spotify.exe").into_iter().collect(), vec![]),
        (
            "discord",
            "Discord",
            "Voz y chat",
            env_path("LOCALAPPDATA", r"Discord\Update.exe").into_iter().collect(),
            vec!["--processStart", "Discord.exe"],
        ),
        ("steam", "Steam", "Tienda y biblioteca de juegos", program_files(r"Steam\steam.exe"), vec![]),
        ("epic", "Epic Games", "Tienda de juegos", program_files(r"Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe"), vec![]),
        ("obs", "OBS Studio", "Grabación y streaming", program_files(r"obs-studio\bin\64bit\obs64.exe"), vec![]),
    ];
    candidates.push(("explorer", "Explorador", "Archivos y carpetas", vec![windir.join("explorer.exe")], vec![]));
    candidates.push(("notepad", "Bloc de notas", "Editor de texto", vec![windir.join(r"System32\notepad.exe")], vec![]));
    candidates.push(("calc", "Calculadora", "Utilidad de Windows", vec![windir.join(r"System32\calc.exe")], vec![]));

    candidates
        .into_iter()
        .filter_map(|(key, name, desc, paths, args)| {
            let path = paths.into_iter().find(|p| p.is_file())?;
            Some(Shortcut {
                id: format!("detected:{key}"),
                name: name.into(),
                description: Some(desc.into()),
                kind: ShortcutKind::App,
                target: Target::Executable {
                    path: path.to_string_lossy().into_owned(),
                    args: args.into_iter().map(String::from).collect(),
                },
                source: ShortcutSource::Detected,
            })
        })
        .collect()
}

fn find_shortcut(state: &AppState, id: &str) -> Option<Shortcut> {
    let config = state.config.snapshot();
    if let Some(s) = config.shortcuts.into_iter().find(|s| s.id == id) {
        return Some(s);
    }
    if id.starts_with("detected:") {
        return detected_apps().into_iter().find(|s| s.id == id);
    }
    if id.starts_with("stream:") {
        return super::streaming::catalog().into_iter().find(|s| s.id == id);
    }
    if id.starts_with("store:") {
        return super::store::installed_apps().into_iter().find(|s| s.id == id);
    }
    if id.starts_with("steam:") {
        return super::steam::installed_games().into_iter().find(|s| s.id == id);
    }
    if ["epic:", "gog:", "ubisoft:", "xbox:", "launcher:", "riot:", "modrinth:", "curseforge:"].iter().any(|p| id.starts_with(p)) {
        return super::games::installed_games().into_iter().find(|s| s.id == id);
    }
    if crate::gamestream::is_pc_id(id) {
        return crate::gamestream::shortcuts(&state.config.snapshot()).into_iter().find(|s| s.id == id);
    }
    None
}

fn spawn_executable(path: &str, args: &[String]) -> Result<(), String> {
    let exe = validate_executable(path)?;
    let args = validate_args(args)?;
    let mut cmd = Command::new(&exe);
    cmd.args(&args);
    if let Some(dir) = exe.parent() {
        cmd.current_dir(dir);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP);
    }
    match cmd.spawn() {
        Ok(_child) => Ok(()),
        Err(e) if e.raw_os_error() == Some(740) => {
            Err("Este programa requiere permisos de administrador; NOVA TV no lo eleva automáticamente.".into())
        }
        Err(e) => Err(format!("No se pudo iniciar {}: {e}", exe.display())),
    }
}

/// Every game NOVA knows about: Steam, other launchers and the user's own.
pub fn all_games(app: &AppHandle) -> Vec<Shortcut> {
    let mut games = super::steam::installed_games();
    games.extend(super::games::installed_games());
    games.extend(
        app.state::<AppState>()
            .config
            .snapshot()
            .shortcuts
            .into_iter()
            .filter(|s| s.kind == ShortcutKind::Game),
    );
    games.extend(crate::gamestream::games(app));
    games
}

#[tauri::command]
pub async fn list_library(app: AppHandle, state: State<'_, AppState>) -> Result<Library, String> {
    let config = state.config.snapshot();
    let profile = crate::profiles::active(&config);
    let mut apps = detected_apps();
    let mut games = super::steam::installed_games();
    games.extend(super::games::installed_games());
    // Games of the PCs of the house (NovaBridge), playable through Moonlight.
    games.extend(crate::gamestream::games(&app));
    let mut streaming = super::streaming::catalog();
    streaming.extend(super::store::installed_apps());
    for s in config.shortcuts {
        match s.kind {
            ShortcutKind::App => apps.push(s),
            ShortcutKind::Game => games.push(s),
            ShortcutKind::Stream => streaming.push(s),
        }
    }
    // Artwork for anything new arrives in the background.
    crate::metadata::refresh(&app, games.clone());
    // Children's profile: only what a parent allowed.
    if profile.kids {
        let ok = |s: &Shortcut| crate::profiles::shortcut_allowed(&profile, &s.id);
        apps.retain(ok);
        games.retain(ok);
        streaming.retain(ok);
    }
    let recent = config.recent.into_iter().filter(|id| crate::profiles::shortcut_allowed(&profile, id)).collect();
    Ok(Library {
        apps,
        games,
        streaming,
        recent,
        steam_installed: super::steam::steam_root().is_some(),
        browser_available: super::streaming::find_browser().is_some(),
    })
}

/// Everything that can be opened, for choosing what a children's profile may use.
#[tauri::command]
pub async fn parental_catalog(state: State<'_, AppState>) -> Result<Vec<Shortcut>, String> {
    crate::profiles::require_adult(&state)?;
    let mut all = super::streaming::catalog();
    all.extend(super::store::installed_apps());
    all.extend(super::steam::installed_games());
    all.extend(super::games::installed_games());
    all.extend(detected_apps());
    let config = state.config.snapshot();
    all.extend(crate::gamestream::shortcuts(&config));
    all.extend(config.shortcuts);
    Ok(all)
}

#[tauri::command]
pub async fn add_executable(input: NewExecutable, state: State<'_, AppState>) -> Result<Shortcut, String> {
    crate::profiles::require_adult(&state)?;
    if input.kind == ShortcutKind::Stream {
        return Err("Los servicios web se añaden con una dirección https://.".into());
    }
    let name = validate_name(&input.name)?;
    let exe = validate_executable(&input.path)?;
    let args = validate_args(&input.args)?;
    let description = input
        .description
        .map(|d| d.trim().chars().take(80).collect::<String>())
        .filter(|d| !d.is_empty());
    let shortcut = Shortcut {
        id: new_id(if input.kind == ShortcutKind::Game { "game" } else { "app" }),
        name,
        description,
        kind: input.kind,
        target: Target::Executable { path: exe.to_string_lossy().into_owned(), args },
        source: ShortcutSource::User,
    };
    let saved = shortcut.clone();
    state.config.update(move |c| {
        c.shortcuts.push(shortcut);
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub async fn add_steam_game(name: String, app_id: u32, state: State<'_, AppState>) -> Result<Shortcut, String> {
    crate::profiles::require_adult(&state)?;
    let name = validate_name(&name)?;
    if app_id == 0 {
        return Err("El App ID de Steam debe ser un número positivo.".into());
    }
    let shortcut = Shortcut {
        id: new_id("game"),
        name,
        description: Some(format!("Steam · App {app_id}")),
        kind: ShortcutKind::Game,
        target: Target::Steam { app_id },
        source: ShortcutSource::User,
    };
    let saved = shortcut.clone();
    state.config.update(move |c| {
        if c.shortcuts.iter().any(|s| matches!(s.target, Target::Steam { app_id: id } if id == app_id)) {
            return Err("Ese juego de Steam ya está registrado.".into());
        }
        c.shortcuts.push(shortcut);
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub async fn add_web_app(name: String, url: String, state: State<'_, AppState>) -> Result<Shortcut, String> {
    crate::profiles::require_adult(&state)?;
    let name = validate_name(&name)?;
    let url = super::streaming::validate_url(&url)?;
    let host = url.trim_start_matches("https://").split(['/', '?', '#']).next().unwrap_or("").to_string();
    let shortcut = Shortcut {
        id: new_id("web"),
        name,
        description: Some(host),
        kind: ShortcutKind::Stream,
        target: Target::Web { url, tv: false },
        source: ShortcutSource::User,
    };
    let saved = shortcut.clone();
    state.config.update(move |c| {
        c.shortcuts.push(shortcut);
        Ok(())
    })?;
    Ok(saved)
}

#[tauri::command]
pub async fn remove_shortcut(id: String, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        let before = c.shortcuts.len();
        c.shortcuts.retain(|s| s.id != id);
        if c.shortcuts.len() == before {
            return Err("Solo se pueden quitar accesos añadidos por ti.".into());
        }
        c.recent.retain(|r| r != &id);
        Ok(())
    })
}

#[tauri::command]
pub async fn launch_shortcut(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    let shortcut = find_shortcut(&state, &id).ok_or("Este acceso ya no existe.")?;
    let profile = crate::profiles::active(&state.config.snapshot());
    if !crate::profiles::shortcut_allowed(&profile, &id) {
        return Err(crate::profiles::BLOCKED.into());
    }
    match &shortcut.target {
        Target::Executable { path, args } => spawn_executable(path, args)?,
        Target::Steam { app_id } => super::steam::launch(*app_id)?,
        Target::Web { url, tv: true } => {
            // No DRM needed: NOVA hosts it in its own TV window.
            crate::session::end_blocking(&app).await;
            let label = super::player::open(&app, &shortcut.name, url)?;
            crate::session::start(&app, &shortcut.name, crate::session::Kind::Player(label));
        }
        Target::Web { url, tv: false } => {
            let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?.join("browser");
            crate::session::end_blocking(&app).await;
            let child = super::streaming::launch(url, &dir, &profile.id, profile.kids)?;
            crate::session::start(&app, &shortcut.name, crate::session::Kind::Browser(child));
        }
        // Games read the controller themselves: no streaming session, no key mapping.
        Target::Packaged { aumid } if shortcut.kind == ShortcutKind::Game => super::store::activate(aumid)?,
        Target::Uri { uri } => super::games::launch_uri(uri)?,
        // Played on the PC, seen here through Moonlight (NOVA watches Moonlight, not the game).
        Target::Pc { pc, game } => crate::gamestream::play(&app, &shortcut.id, pc, game, &shortcut.name).await?,
        Target::Packaged { aumid } => {
            crate::session::end_blocking(&app).await;
            super::store::launch(aumid)?;
            crate::session::start(&app, &shortcut.name, crate::session::Kind::Untracked);
        }
    }
    if shortcut.kind == ShortcutKind::Game && !matches!(shortcut.target, Target::Pc { .. }) {
        crate::gamewatch::watch(&app, &shortcut);
    }
    // Launch succeeded; recording it in "recent" is best effort.
    let _ = state.config.update(|c| {
        c.recent.retain(|r| r != &id);
        c.recent.insert(0, id.clone());
        c.recent.truncate(MAX_RECENT);
        Ok(())
    });
    Ok(shortcut.name)
}
