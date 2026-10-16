//! Real system information, Windows Settings shortcuts and master volume.

use crate::AppState;
use serde::Serialize;
use std::time::Instant;
use sysinfo::System;
use tauri::{AppHandle, State};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub long_os_version: Option<String>,
    pub kernel_version: Option<String>,
    pub host_name: Option<String>,
    pub arch: String,
    pub cpu_brand: Option<String>,
    pub logical_cores: usize,
    pub physical_cores: Option<usize>,
    pub total_memory: u64,
    pub uptime_secs: u64,
    pub app_version: String,
    pub user_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemStats {
    /// None until two samples are far enough apart to be meaningful.
    pub cpu_usage: Option<f32>,
    pub used_memory: u64,
    pub total_memory: u64,
}

pub struct SysMonitor {
    pub sys: System,
    pub created: Instant,
}

impl SysMonitor {
    pub fn new() -> Self {
        let mut sys = System::new();
        sys.refresh_cpu_all();
        sys.refresh_memory();
        Self { sys, created: Instant::now() }
    }
}

#[tauri::command]
pub async fn get_system_info(app: AppHandle, state: State<'_, AppState>) -> Result<SystemInfo, String> {
    let mon = state.sys.lock().map_err(|_| "Monitor no disponible")?;
    let cpu_brand = mon
        .sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|b| !b.is_empty());
    Ok(SystemInfo {
        os_name: System::name(),
        os_version: System::os_version(),
        long_os_version: System::long_os_version(),
        kernel_version: System::kernel_version(),
        host_name: System::host_name(),
        arch: System::cpu_arch(),
        cpu_brand,
        logical_cores: mon.sys.cpus().len(),
        physical_cores: System::physical_core_count(),
        total_memory: mon.sys.total_memory(),
        uptime_secs: System::uptime(),
        app_version: app.package_info().version.to_string(),
        user_name: std::env::var("USERNAME").ok().filter(|u| !u.trim().is_empty()),
    })
}

#[tauri::command]
pub async fn get_system_stats(state: State<'_, AppState>) -> Result<SystemStats, String> {
    let mut mon = state.sys.lock().map_err(|_| "Monitor no disponible")?;
    mon.sys.refresh_cpu_usage();
    mon.sys.refresh_memory();
    let primed = mon.created.elapsed() >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL;
    Ok(SystemStats {
        cpu_usage: primed.then(|| mon.sys.global_cpu_usage()),
        used_memory: mon.sys.used_memory(),
        total_memory: mon.sys.total_memory(),
    })
}

/// Only these `ms-settings:` pages can be opened.
const SETTINGS_PAGES: &[(&str, &str)] = &[
    ("home", "ms-settings:"),
    ("display", "ms-settings:display"),
    ("sound", "ms-settings:sound"),
    ("bluetooth", "ms-settings:bluetooth"),
    ("network", "ms-settings:network"),
    ("apps", "ms-settings:appsfeatures"),
    ("personalization", "ms-settings:personalization"),
    ("update", "ms-settings:windowsupdate"),
    ("power", "ms-settings:powersleep"),
    ("gaming", "ms-settings:gaming-gamebar"),
    ("gamebar", "ms-gamebar:"),
];

#[tauri::command]
pub fn open_windows_settings(page: String, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    let uri = SETTINGS_PAGES
        .iter()
        .find(|(k, _)| *k == page)
        .map(|(_, uri)| *uri)
        .ok_or("Página de configuración desconocida.")?;
    tauri_plugin_opener::open_url(uri, None::<&str>).map_err(|e| format!("No se pudo abrir Configuración: {e}"))
}

#[derive(Serialize)]
pub struct VolumeState {
    /// 0-100
    pub level: u32,
    pub muted: bool,
}

#[tauri::command]
pub async fn get_volume() -> Result<VolumeState, String> {
    volume::get()
}

#[tauri::command]
pub async fn set_volume(level: u32) -> Result<VolumeState, String> {
    volume::set_level(level.min(100))
}

#[tauri::command]
pub async fn set_mute(muted: bool) -> Result<VolumeState, String> {
    volume::set_mute(muted)
}

#[cfg(windows)]
pub mod volume {
    use super::VolumeState;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Runs `f` against the default output device on a dedicated MTA thread,
    /// so it never conflicts with the WebView's COM apartment.
    fn with_endpoint<T: Send + 'static>(
        f: impl FnOnce(&IAudioEndpointVolume) -> windows::core::Result<T> + Send + 'static,
    ) -> Result<T, String> {
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED)
                .ok()
                .map_err(|e| format!("Audio no disponible: {}", e.message()))?;
            let result = (|| {
                let enumerator: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
                let device = enumerator.GetDefaultAudioEndpoint(eRender, eConsole)?;
                let endpoint: IAudioEndpointVolume = device.Activate(CLSCTX_ALL, None)?;
                f(&endpoint)
            })();
            CoUninitialize();
            result.map_err(|e| format!("No hay un dispositivo de salida de audio disponible: {}", e.message()))
        })
        .join()
        .map_err(|_| "Error interno de audio".to_string())?
    }

    fn read(ep: &IAudioEndpointVolume) -> windows::core::Result<VolumeState> {
        unsafe {
            Ok(VolumeState {
                level: (ep.GetMasterVolumeLevelScalar()? * 100.0).round() as u32,
                muted: ep.GetMute()?.as_bool(),
            })
        }
    }

    pub fn get() -> Result<VolumeState, String> {
        with_endpoint(|ep| read(ep))
    }

    pub fn set_level(level: u32) -> Result<VolumeState, String> {
        with_endpoint(move |ep| unsafe {
            ep.SetMasterVolumeLevelScalar(level as f32 / 100.0, std::ptr::null())?;
            read(ep)
        })
    }

    pub fn set_mute(muted: bool) -> Result<VolumeState, String> {
        with_endpoint(move |ep| unsafe {
            ep.SetMute(muted, std::ptr::null())?;
            read(ep)
        })
    }
}

#[cfg(not(windows))]
pub mod volume {
    use super::VolumeState;
    const MSG: &str = "El control de volumen solo está disponible en Windows.";
    pub fn get() -> Result<VolumeState, String> { Err(MSG.into()) }
    pub fn set_level(_: u32) -> Result<VolumeState, String> { Err(MSG.into()) }
    pub fn set_mute(_: bool) -> Result<VolumeState, String> { Err(MSG.into()) }
}
