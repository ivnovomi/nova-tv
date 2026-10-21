//! NovaBridge keeps itself up to date.
//!
//! Each NOVA Host release ships `host.json` (version, installer URL, signature)
//! next to NOVA's own files. NovaBridge looks for the newest one once a day;
//! when it's newer, it asks on the PC (or NOVA asks for it from the TV),
//! downloads the installer, checks it was signed with NOVA's updater key and
//! runs it silently. The installer closes NovaBridge and opens the new one.

use serde::Deserialize;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

const RELEASES: &str = "https://api.github.com/repos/ivnovomi/nova-tv-releases/releases?per_page=15";
/// Installers may only come from NOVA's own releases.
const DOWNLOADS: &str = "https://github.com/ivnovomi/nova-tv-releases/releases/download/";
/// NOVA's updater key (tauri.conf.json → plugins.updater.pubkey): the same one signs NOVA Host.
const UPDATER_KEY: &str = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM4MTEzQTE2MDVGRkZDOEQKUldTTi9QOEZGam9ST0hBZFAzNlZZVFpBWTJ2MytnWklJb0FHbm1HcitlK1d4TXBtd0orRGo3MkUK";
const FIRST_CHECK: Duration = Duration::from_secs(90);
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_INSTALLER: u64 = 150 * 1024 * 1024;

#[derive(Deserialize, Clone, Debug)]
pub struct Update {
    pub version: String,
    pub url: String,
    pub signature: String,
}

#[derive(Deserialize)]
struct Release {
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    assets: Vec<Asset>,
}

#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

static AVAILABLE: Mutex<Option<Update>> = Mutex::new(None);
static INSTALLING: AtomicBool = AtomicBool::new(false);
/// The version the person already said "later" to (asked once per version).
static ASKED: Mutex<Option<String>> = Mutex::new(None);

/// The newer NOVA Host found, if any.
pub fn available() -> Option<String> {
    AVAILABLE.lock().ok()?.as_ref().map(|u| u.version.clone())
}

/// `0.3.10` > `0.3.9`; anything unreadable is never newer.
fn newer(candidate: &str, current: &str) -> bool {
    let parse = |v: &str| -> Option<Vec<u64>> { v.trim_start_matches('v').split('.').map(|p| p.parse().ok()).collect() };
    match (parse(candidate), parse(current)) {
        (Some(a), Some(b)) => a > b,
        _ => false,
    }
}

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .https_only(true)
        .max_redirects(5)
        // GitHub's API wants one.
        .user_agent(format!("NovaBridge/{}", super::VERSION))
        .build()
        .into()
}

fn get_json<T: serde::de::DeserializeOwned>(agent: &ureq::Agent, url: &str, what: &str) -> Result<T, String> {
    let text = agent
        .get(url)
        .call()
        .map_err(|e| format!("No se pudo consultar {what}: {e}"))?
        .body_mut()
        .with_config()
        .limit(2 * 1024 * 1024)
        .read_to_string()
        .map_err(|e| format!("No se pudo leer {what}: {e}"))?;
    serde_json::from_str(&text).map_err(|e| format!("{what} no válido: {e}"))
}

/// Looks for a NOVA Host newer than this one.
pub fn check() -> Result<Option<Update>, String> {
    let agent = agent(Duration::from_secs(30));
    let releases: Vec<Release> = get_json(&agent, RELEASES, "las versiones")?;
    // Newest first: the first release that carries NOVA Host is the latest one.
    let Some(manifest) = releases
        .iter()
        .filter(|r| !r.draft && !r.prerelease)
        .find_map(|r| r.assets.iter().find(|a| a.name == "host.json"))
    else {
        return Ok(None);
    };
    let update: Update = get_json(&agent, &manifest.browser_download_url, "host.json")?;
    if !update.url.starts_with(DOWNLOADS) {
        return Err("host.json apunta fuera de las versiones de NOVA".into());
    }
    let found = newer(&update.version, super::VERSION).then_some(update);
    if let Ok(mut slot) = AVAILABLE.lock() {
        *slot = found.clone();
    }
    Ok(found)
}

fn verify(signature: &str, data: &[u8]) -> Result<(), String> {
    use base64::Engine;
    let text = |b64: &str| base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok().and_then(|b| String::from_utf8(b).ok());
    let public = minisign_verify::PublicKey::decode(&text(UPDATER_KEY).ok_or("Clave no válida")?).map_err(|_| "Clave no válida")?;
    let signature = minisign_verify::Signature::decode(&text(signature).ok_or("Firma no válida")?).map_err(|_| "Firma no válida")?;
    public
        .verify(data, &signature, false)
        .map_err(|_| "El instalador no está firmado por NOVA: no se instala".to_string())
}

/// Downloads, checks and runs the newer NOVA Host (Windows asks for permission).
pub fn install() -> Result<String, String> {
    let update = AVAILABLE.lock().ok().and_then(|u| u.clone()).ok_or("No hay ninguna versión nueva")?;
    if INSTALLING.swap(true, Ordering::AcqRel) {
        return Err("Ya se está actualizando".into());
    }
    let result = (|| {
        super::log(&format!("Descargando NOVA Host {}", update.version));
        let mut data = Vec::new();
        agent(Duration::from_secs(15 * 60))
            .get(&update.url)
            .call()
            .map_err(|e| format!("No se pudo descargar: {e}"))?
            .body_mut()
            .with_config()
            .limit(MAX_INSTALLER)
            .reader()
            .read_to_end(&mut data)
            .map_err(|e| format!("La descarga se cortó: {e}"))?;
        verify(&update.signature, &data)?;
        let path: PathBuf = std::env::temp_dir().join(format!("NOVA-Host_{}_setup.exe", update.version));
        std::fs::write(&path, &data).map_err(|e| e.to_string())?;
        super::log(&format!("NOVA Host {} verificado: instalando", update.version));
        run_elevated(&path)?;
        Ok(update.version.clone())
    })();
    INSTALLING.store(false, Ordering::Release);
    if let Err(e) = &result {
        super::log(&format!("No se pudo actualizar: {e}"));
    }
    result
}

/// Runs the installer silently as administrator (Windows shows its prompt).
fn run_elevated(path: &std::path::Path) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::UI::Shell::ShellExecuteW;
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
    let done = unsafe { ShellExecuteW(None, &HSTRING::from("runas"), &HSTRING::from(path.as_os_str()), &HSTRING::from("/S"), None, SW_SHOWNORMAL) };
    // Values above 32 mean it started; below, Windows refused (or the person said no).
    if done.0 as usize > 32 { Ok(()) } else { Err("Windows no dejó instalar la actualización".into()) }
}

/// Checks now (from the tray) and says what it found.
pub fn check_now() {
    thread::spawn(|| match check() {
        Ok(Some(update)) => offer(&update, true),
        Ok(None) => super::tell("NovaBridge", &format!("NovaBridge está al día ({}).", super::VERSION)),
        Err(e) => super::tell("NovaBridge", &e),
    });
}

/// Asks on the PC whether to update now (once per version unless asked for).
fn offer(update: &Update, always: bool) {
    if !always {
        let Ok(mut asked) = ASKED.lock() else { return };
        if asked.as_deref() == Some(update.version.as_str()) {
            return;
        }
        *asked = Some(update.version.clone());
    }
    let yes = super::ask(
        "NovaBridge",
        &format!("Hay una versión nueva de NOVA Host: {} (tienes la {}).\n\n¿Actualizar ahora? Windows pedirá permiso y NovaBridge se reiniciará.", update.version, super::VERSION),
    );
    if yes && let Err(e) = install() {
        super::tell("NovaBridge", &e);
    }
}

/// Looks for updates a little after starting, then once a day.
pub fn spawn() {
    let _ = thread::Builder::new().name("bridge-update".into()).spawn(|| {
        thread::sleep(FIRST_CHECK);
        loop {
            match check() {
                Ok(Some(update)) => {
                    super::log(&format!("Hay una versión nueva de NOVA Host: {}", update.version));
                    offer(&update, false);
                }
                Ok(None) => {}
                Err(e) => super::log(&e),
            }
            thread::sleep(EVERY);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn versions_compare_as_numbers() {
        assert!(newer("0.3.10", "0.3.9"));
        assert!(newer("0.4.0", "0.3.9"));
        assert!(newer("v1.0.0", "0.9.9"));
        assert!(!newer("0.3.6", "0.3.6"));
        assert!(!newer("0.3.5", "0.3.6"));
        assert!(!newer("nueva", "0.3.6"));
    }

    #[test]
    fn same_key_as_novas_updater() {
        assert!(include_str!("../../tauri.conf.json").contains(UPDATER_KEY), "UPDATER_KEY ≠ tauri.conf.json");
    }

    #[test]
    fn the_updater_key_reads() {
        use base64::Engine;
        let text = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(UPDATER_KEY).unwrap()).unwrap();
        assert!(minisign_verify::PublicKey::decode(&text).is_ok());
    }

    /// A NOVA Host installer signed with `tauri signer sign` (NOVA_HOST_SETUP=path, with path.sig beside it).
    #[test]
    #[ignore = "needs a signed installer"]
    fn verifies_a_signed_installer() {
        let path = std::env::var("NOVA_HOST_SETUP").expect("NOVA_HOST_SETUP");
        let data = std::fs::read(&path).unwrap();
        let signature = std::fs::read_to_string(format!("{path}.sig")).unwrap();
        verify(&signature, &data).expect("signed by NOVA");
        let mut tampered = data.clone();
        tampered[data.len() / 2] ^= 0xff;
        assert!(verify(&signature, &tampered).is_err(), "a changed installer must not pass");
    }

    /// The installer NOVA published, against its signature (needs the network).
    #[test]
    #[ignore = "network"]
    fn finds_the_published_host() {
        println!("{:?}", check());
    }
}
