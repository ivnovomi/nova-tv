//! The first-run assistant: shown once on a new NOVA (internet, who you are,
//! where you are, the phone remote, how NOVA starts), again from Ajustes.

use crate::AppState;
use tauri::State;

/// Before the profiles exist: a NOVA that already had them was set up before
/// the assistant existed, and doesn't need it.
pub fn init(state: &AppState) {
    let c = state.config.snapshot();
    if !c.setup_done && !c.profiles.is_empty() {
        let _ = state.config.update(|c| {
            c.setup_done = true;
            Ok(())
        });
    }
}

#[tauri::command]
pub fn setup_needed(state: State<'_, AppState>) -> bool {
    !state.config.snapshot().setup_done
}

#[tauri::command]
pub fn setup_finish(state: State<'_, AppState>) -> Result<(), String> {
    state.config.update(|c| {
        c.setup_done = true;
        Ok(())
    })
}

/// Ajustes → "Repetir el asistente".
#[tauri::command]
pub fn setup_restart(state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.setup_done = false;
        Ok(())
    })
}
