//! The start-up window: a small NOVA window that opens first, looks for an
//! update (and offers it), loads profiles, tunes the channel list and scans the
//! library, then opens NOVA itself with everything ready.
//!
//! It only gets its own small set of commands (capabilities/splash.json).

use crate::commands::applications;
use crate::livetv;
use crate::AppState;
use std::sync::mpsc;
use std::time::Duration;
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

/// Runs `work` in the background and waits for it at most `limit`: a slow
/// network never holds the start-up back (the work still finishes, for NOVA).
async fn within<T: Send + 'static>(limit: Duration, work: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(work());
        });
        rx.recv_timeout(limit).ok()
    })
    .await
    .ok()
    .flatten()
}

fn plural(n: usize, one: &str, many: &str) -> String {
    format!("{n} {}", if n == 1 { one } else { many })
}

/// One start-up step. Returns a short line for the window ("145 canales").
#[tauri::command]
pub async fn splash_step(app: AppHandle, step: String) -> Result<String, String> {
    match step.as_str() {
        "profiles" => {
            let config = app.state::<AppState>().config.snapshot();
            let active = crate::profiles::active(&config);
            Ok(if config.profiles.len() > 1 { format!("{} · hola, {}", plural(config.profiles.len(), "perfil", "perfiles"), active.name) } else { format!("Hola, {}", active.name) })
        }
        "channels" => {
            let handle = app.clone();
            match within(Duration::from_secs(15), move || livetv::snapshot(&handle).len()).await {
                Some(0) => Err("Sin canales por ahora: NOVA lo reintentará".into()),
                Some(n) => Ok(plural(n, "canal", "canales")),
                None => Ok("Terminando de sintonizar en segundo plano".into()),
            }
        }
        "library" => {
            let handle = app.clone();
            let found = within(Duration::from_secs(10), move || {
                tauri::async_runtime::block_on(async {
                    let state = handle.state::<AppState>();
                    applications::list_library(handle.clone(), state).await.map(|l| l.games.len() + l.apps.len() + l.streaming.len())
                })
            })
            .await;
            match found {
                Some(Ok(n)) => Ok(plural(n, "app o juego", "apps y juegos")),
                Some(Err(e)) => Err(e),
                None => Ok("Terminando en segundo plano".into()),
            }
        }
        _ => Err("Paso desconocido".into()),
    }
}

/// Start-up finished: opens NOVA (its window is created now, from
/// tauri.conf.json) and closes this one.
#[tauri::command]
pub fn splash_done(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("main").is_none() {
        let config = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("Falta la ventana principal")?;
        WebviewWindowBuilder::from_config(&app, &config).and_then(|b| b.build()).map_err(|e| e.to_string())?;
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    Ok(())
}
