//! Installed Microsoft Store streaming apps (they ship their own DRM).
//!
//! Only packages whose family name matches a known streaming keyword are listed,
//! and only AUMIDs from that list can be launched.

#[cfg(not(windows))]
use crate::config::Shortcut;

/// (family-name keyword, display name, description)
const KNOWN: &[(&str, &str, &str)] = &[
    ("netflix", "Netflix", "App de Microsoft Store"),
    ("primevideo", "Prime Video", "App de Microsoft Store"),
    ("disney", "Disney+", "App de Microsoft Store"),
    ("appletv", "Apple TV", "App de Microsoft Store"),
    ("spotify", "Spotify", "App de Microsoft Store"),
    ("plex", "Plex", "App de Microsoft Store"),
    ("crunchyroll", "Crunchyroll", "App de Microsoft Store"),
    ("twitch", "Twitch", "App de Microsoft Store"),
    ("dazn", "DAZN", "App de Microsoft Store"),
    ("rakuten", "Rakuten TV", "App de Microsoft Store"),
    ("movistar", "Movistar Plus+", "App de Microsoft Store"),
    ("filmin", "Filmin", "App de Microsoft Store"),
    ("plutotv", "Pluto TV", "App de Microsoft Store"),
    ("deezer", "Deezer", "App de Microsoft Store"),
    ("tidal", "TIDAL", "App de Microsoft Store"),
];

#[cfg(windows)]
mod imp {
    use super::KNOWN;
    use crate::config::{Shortcut, ShortcutKind, ShortcutSource, Target};
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Management::Deployment::PackageManager;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_LOCAL_SERVER, COINIT_APARTMENTTHREADED,
        COINIT_MULTITHREADED,
    };
    use windows::Win32::UI::Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NONE};

    static CACHE: Mutex<Option<(Instant, Vec<Shortcut>)>> = Mutex::new(None);
    const TTL: Duration = Duration::from_secs(90);

    fn enumerate() -> windows::core::Result<Vec<Shortcut>> {
        let manager = PackageManager::new()?;
        let mut out = Vec::new();
        for package in manager.FindPackagesByUserSecurityId(&HSTRING::new())? {
            let family = package.Id()?.FamilyName()?.to_string();
            let lower = family.to_lowercase();
            let Some((_, name, desc)) = KNOWN.iter().find(|(k, _, _)| lower.contains(k)) else { continue };
            let Ok(entries) = package.GetAppListEntries() else { continue };
            for entry in entries {
                let aumid = entry.AppUserModelId()?.to_string();
                if out.iter().any(|s: &Shortcut| s.id == format!("store:{aumid}")) {
                    continue;
                }
                out.push(Shortcut {
                    id: format!("store:{aumid}"),
                    name: (*name).into(),
                    description: Some((*desc).into()),
                    kind: ShortcutKind::Stream,
                    target: Target::Packaged { aumid },
                    source: ShortcutSource::Store,
                });
                break; // one tile per app
            }
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }

    pub fn installed_apps() -> Vec<Shortcut> {
        if let Ok(cache) = CACHE.lock() {
            if let Some((at, list)) = cache.as_ref() {
                if at.elapsed() < TTL {
                    return list.clone();
                }
            }
        }
        // WinRT on a dedicated MTA thread, independent of the WebView's apartment.
        let list = std::thread::spawn(|| unsafe {
            let init = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let list = enumerate().unwrap_or_default();
            if init {
                CoUninitialize();
            }
            list
        })
        .join()
        .unwrap_or_default();
        if let Ok(mut cache) = CACHE.lock() {
            *cache = Some((Instant::now(), list.clone()));
        }
        list
    }

    pub fn launch(aumid: &str) -> Result<(), String> {
        if !installed_apps().iter().any(|s| matches!(&s.target, Target::Packaged { aumid: a } if a == aumid)) {
            return Err("Esta app de la Store ya no está instalada.".into());
        }
        activate(aumid)
    }

    /// Starts a packaged app. Callers must have resolved `aumid` from a scanned list.
    pub fn activate(aumid: &str) -> Result<(), String> {
        let aumid = HSTRING::from(aumid);
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED)
                .ok()
                .map_err(|e| e.message().to_string())?;
            let result = (|| {
                let manager: IApplicationActivationManager =
                    CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_LOCAL_SERVER)?;
                manager.ActivateApplication(&aumid, PCWSTR::null(), AO_NONE)
            })();
            CoUninitialize();
            result.map(|_| ()).map_err(|e| e.message().to_string())
        })
        .join()
        .map_err(|_| "Error interno al abrir la app".to_string())?
        .map_err(|e| format!("Windows no pudo abrir la app: {e}"))
    }
}

#[cfg(windows)]
pub use imp::{activate, installed_apps, launch};

#[cfg(not(windows))]
pub fn installed_apps() -> Vec<Shortcut> {
    let _ = KNOWN;
    vec![]
}

#[cfg(not(windows))]
pub fn launch(_: &str) -> Result<(), String> {
    Err("Solo disponible en Windows.".into())
}

#[cfg(not(windows))]
pub fn activate(_: &str) -> Result<(), String> {
    Err("Solo disponible en Windows.".into())
}

#[cfg(test)]
mod tests {
    /// Read-only: lists the streaming Store apps found on this PC.
    #[test]
    #[ignore = "depends on the local machine"]
    fn lists_installed_store_apps() {
        for app in super::installed_apps() {
            println!("{} -> {:?}", app.name, app.target);
        }
    }
}
