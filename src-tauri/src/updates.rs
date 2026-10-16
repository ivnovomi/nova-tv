//! New versions of NOVA. Looks for one on GitHub Releases (a signed NSIS
//! installer, checked against the public key in tauri.conf.json), tells the
//! interface, and downloads and installs it only when someone presses
//! "Actualizar". Children's profiles can see that there's an update, not
//! install it.

use crate::config::UpdatesConfig;
use crate::history::HistoryStore;
use crate::profiles::require_adult;
use crate::AppState;
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Error, Update, UpdaterExt};

/// First look a little after start-up (the TV is tuning), then every 6 hours.
const FIRST_CHECK: Duration = Duration::from_secs(45);
const EVERY: Duration = Duration::from_secs(6 * 3600);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    version: String,
    /// Release notes, Markdown as written in the release.
    notes: Option<String>,
    /// ISO 8601.
    date: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    current: String,
    available: Option<UpdateInfo>,
    /// Unix seconds of the last check that got an answer.
    checked_at: Option<u64>,
    error: Option<String>,
    checking: bool,
    /// Downloading or installing right now.
    installing: bool,
    auto_check: bool,
    skipped: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: u64,
    total: Option<u64>,
}

#[derive(Default)]
pub struct Updates {
    pending: Mutex<Option<Update>>,
    checked_at: Mutex<Option<u64>>,
    error: Mutex<Option<String>>,
    checking: AtomicBool,
    installing: AtomicBool,
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn friendly(e: Error) -> String {
    match e {
        // 404 or no manifest: nothing published yet (or the release has no latest.json).
        Error::ReleaseNotFound => "Todavía no hay ninguna versión publicada.".into(),
        Error::Reqwest(e) if e.is_timeout() => "El servidor de actualizaciones no responde.".into(),
        Error::Reqwest(e) if e.is_connect() => "Sin conexión a internet.".into(),
        Error::Minisign(_) | Error::SignatureUtf8(_) => "La firma de la actualización no es válida: no se instala.".into(),
        Error::TargetNotFound(_) | Error::TargetsNotFound(_) => "La versión publicada no incluye instalador para Windows.".into(),
        other => format!("No se pudo comprobar: {other}"),
    }
}

fn status(app: &AppHandle) -> UpdateStatus {
    let state = app.state::<Updates>();
    let config: UpdatesConfig = app.state::<AppState>().config.snapshot().updates;
    let available = state.pending.lock().ok().and_then(|p| {
        p.as_ref().map(|u| UpdateInfo {
            version: u.version.clone(),
            notes: u.body.clone().filter(|b| !b.trim().is_empty()),
            date: u.raw_json.get("pub_date").and_then(|d| d.as_str()).map(String::from),
        })
    });
    UpdateStatus {
        current: app.package_info().version.to_string(),
        available,
        checked_at: state.checked_at.lock().ok().and_then(|c| *c),
        error: state.error.lock().ok().and_then(|e| e.clone()),
        checking: state.checking.load(Ordering::Acquire),
        installing: state.installing.load(Ordering::Acquire),
        auto_check: !config.auto_check_off,
        skipped: config.skipped,
    }
}

fn announce(app: &AppHandle) {
    let _ = app.emit("update-status", status(app));
}

async fn check(app: &AppHandle) {
    let state = app.state::<Updates>();
    if state.installing.load(Ordering::Acquire) || state.checking.swap(true, Ordering::AcqRel) {
        return;
    }
    announce(app);
    let result = match app.updater_builder().timeout(Duration::from_secs(20)).build() {
        Ok(updater) => updater.check().await.map_err(friendly),
        Err(e) => Err(friendly(e)),
    };
    match result {
        Ok(update) => {
            *state.pending.lock().unwrap_or_else(|p| p.into_inner()) = update;
            *state.checked_at.lock().unwrap_or_else(|p| p.into_inner()) = Some(now_secs());
            *state.error.lock().unwrap_or_else(|p| p.into_inner()) = None;
        }
        Err(e) => *state.error.lock().unwrap_or_else(|p| p.into_inner()) = Some(e),
    }
    state.checking.store(false, Ordering::Release);
    announce(app);
}

/// Looks by itself in the background, unless turned off in Ajustes.
/// Not while developing (`tauri dev`): there's no installed copy to update.
pub fn spawn_checker(app: AppHandle) {
    if cfg!(debug_assertions) {
        return;
    }
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            let off = app.state::<AppState>().config.snapshot().updates.auto_check_off;
            if !off {
                tauri::async_runtime::block_on(check(&app));
            }
            std::thread::sleep(EVERY);
        }
    });
}

async fn pause(d: Duration) {
    let _ = tauri::async_runtime::spawn_blocking(move || std::thread::sleep(d)).await;
}

#[tauri::command]
pub fn updates_status(app: AppHandle) -> UpdateStatus {
    status(&app)
}

/// "Buscar actualizaciones".
#[tauri::command]
pub async fn updates_check(app: AppHandle) -> UpdateStatus {
    check(&app).await;
    status(&app)
}

#[tauri::command]
pub fn updates_set_auto(app: AppHandle, enabled: bool) -> Result<UpdateStatus, String> {
    let state = app.state::<AppState>();
    require_adult(&state)?;
    state.config.update(|c| {
        c.updates.auto_check_off = !enabled;
        Ok(())
    })?;
    Ok(status(&app))
}

/// "Omitir esta versión" (or `None` to announce it again).
#[tauri::command]
pub fn updates_skip(app: AppHandle, version: Option<String>) -> Result<UpdateStatus, String> {
    let state = app.state::<AppState>();
    require_adult(&state)?;
    state.config.update(|c| {
        c.updates.skipped = version;
        Ok(())
    })?;
    Ok(status(&app))
}

/// "Actualizar ahora": downloads (reporting real progress), verifies the
/// signature and runs the installer, which closes NOVA and opens the new one.
#[tauri::command]
pub async fn updates_install(app: AppHandle) -> Result<(), String> {
    require_adult(&app.state::<AppState>())?;
    let state = app.state::<Updates>();
    let update = state.pending.lock().map_err(|e| e.to_string())?.clone().ok_or("No hay ninguna actualización pendiente.")?;
    if state.installing.swap(true, Ordering::AcqRel) {
        return Err("La actualización ya se está descargando.".into());
    }
    announce(&app);

    let mut downloaded = 0u64;
    let mut last = Instant::now() - Duration::from_secs(1);
    let progress_app = app.clone();
    let result = update
        .download(
            |chunk, total| {
                downloaded += chunk as u64;
                // At most ~10 updates a second.
                if last.elapsed() >= Duration::from_millis(100) || total == Some(downloaded) {
                    last = Instant::now();
                    let _ = progress_app.emit("update-progress", Progress { downloaded, total });
                }
            },
            || {},
        )
        .await;

    let bytes = match result {
        Ok(bytes) => bytes,
        Err(e) => {
            state.installing.store(false, Ordering::Release);
            announce(&app);
            return Err(match e {
                Error::Minisign(_) => "La firma de la descarga no coincide: no se instala.".into(),
                other => format!("No se pudo descargar: {other}"),
            });
        }
    };

    let _ = app.emit("update-installing", ());
    // The installer closes NOVA right away: keep the watch progress.
    app.state::<HistoryStore>().flush();
    // Give the interface a moment to show "Instalando…".
    pause(Duration::from_millis(900)).await;
    update.install(bytes).map_err(|e| {
        state.installing.store(false, Ordering::Release);
        announce(&app);
        format!("No se pudo abrir el instalador: {e}")
    })
}
