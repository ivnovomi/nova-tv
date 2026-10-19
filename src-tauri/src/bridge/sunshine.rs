//! Sunshine as NOVA Host leaves it: NovaBridge owns its web credentials
//! (DPAPI, this Windows user) so it can type Moonlight's PIN by itself.
//!
//! `NovaBridge.exe --setup` (run elevated by the NOVA Host installer):
//! - lets NovaBridge through the firewall (private networks),
//! - gives Sunshine credentials if it has none yet (never replaces the user's),
//! - starts NovaBridge with Windows.
//!
//! `--uninstall` undoes the firewall rule and the autostart.

use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use std::{env, fs};

const SERVICE: &str = "SunshineService";
const FIREWALL_RULE: &str = "NOVA Host (NovaBridge)";
const USER: &str = "nova";
const API: &str = "https://localhost:47990/api";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub fn dir() -> Option<PathBuf> {
    ["ProgramFiles", "ProgramFiles(x86)"]
        .iter()
        .filter_map(env::var_os)
        .map(|base| PathBuf::from(base).join("Sunshine"))
        .find(|p| p.join("sunshine.exe").is_file())
}

fn creds_path() -> PathBuf {
    super::dir().join("sunshine.dat")
}

/// The web credentials NovaBridge set up, if it did.
pub fn credentials() -> Option<(String, String)> {
    let sealed = fs::read(creds_path()).ok()?;
    let plain = crate::plugins::secrets::unprotect(&sealed).ok()?;
    let text = String::from_utf8(plain).ok()?;
    let (user, pass) = text.split_once('\n')?;
    Some((user.to_string(), pass.to_string()))
}

fn run(program: &str, args: &[&str]) -> bool {
    Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).status().is_ok_and(|s| s.success())
}

/// Whether Sunshine already has a web user (set by the person or by us).
fn has_user(sunshine: &std::path::Path) -> bool {
    fs::read_to_string(sunshine.join(r"config\sunshine_state.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
        .is_some_and(|v| v.get("username").and_then(|u| u.as_str()).is_some_and(|u| !u.is_empty()))
}

fn set_credentials(sunshine: &std::path::Path) -> Result<(), String> {
    let password = super::hex(&super::random::<16>());
    // The service reads the credentials when it starts.
    run("net", &["stop", SERVICE]);
    let ok = Command::new(sunshine.join("sunshine.exe"))
        .args(["--creds", USER, &password])
        .current_dir(sunshine)
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .is_ok_and(|s| s.success());
    run("net", &["start", SERVICE]);
    if !ok {
        return Err("Sunshine no aceptó las credenciales".into());
    }
    let sealed = crate::plugins::secrets::protect(format!("{USER}\n{password}").as_bytes())?;
    fs::create_dir_all(super::dir()).map_err(|e| e.to_string())?;
    fs::write(creds_path(), sealed).map_err(|e| e.to_string())
}

fn firewall(on: bool) {
    run("netsh", &["advfirewall", "firewall", "delete", "rule", &format!("name={FIREWALL_RULE}")]);
    if !on {
        return;
    }
    let Ok(exe) = env::current_exe() else { return };
    let program = format!("program={}", exe.display());
    for protocol in ["protocol=tcp", "protocol=udp"] {
        run(
            "netsh",
            &["advfirewall", "firewall", "add", "rule", &format!("name={FIREWALL_RULE}"), "dir=in", "action=allow", protocol, &program, "profile=private,domain", "enable=yes"],
        );
    }
}

/// `--setup`: what the installer asks for. Returns the process exit code.
pub fn setup() -> i32 {
    super::log("Configurando NOVA Host");
    firewall(true);
    super::tray::set_autostart(true);
    let Some(sunshine) = dir() else {
        super::log("Sunshine no está instalado: NovaBridge funcionará, pero sin imagen");
        return 0;
    };
    if credentials().is_some() || has_user(&sunshine) {
        super::log("Sunshine ya tenía usuario: se respeta (el PIN de Moonlight se escribirá a mano)");
        return 0;
    }
    match set_credentials(&sunshine) {
        Ok(()) => super::log("Sunshine configurado: NovaBridge escribirá solo el PIN de Moonlight"),
        Err(e) => super::log(&format!("No se pudo configurar Sunshine: {e}")),
    }
    0
}

/// `--uninstall`: before the files go.
pub fn uninstall() -> i32 {
    firewall(false);
    super::tray::set_autostart(false);
    let _ = fs::remove_file(creds_path());
    super::log("NOVA Host desinstalado");
    0
}

/// Types Moonlight's PIN into Sunshine. False when NovaBridge has no credentials or Sunshine said no.
pub fn send_pin(pin: &str, name: &str) -> bool {
    let Some((user, pass)) = credentials() else { return false };
    use base64::Engine;
    let auth = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
    // Only localhost, whose certificate Sunshine makes up itself.
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(10)))
        .http_status_as_error(false)
        .tls_config(ureq::tls::TlsConfig::builder().disable_verification(true).build())
        .build()
        .into();
    let body = serde_json::json!({ "pin": pin, "name": name }).to_string();
    let result = agent
        .post(format!("{API}/pin"))
        .header("Authorization", format!("Basic {auth}"))
        .header("Content-Type", "application/json")
        .send(body.as_bytes());
    match result {
        Ok(mut res) => {
            let status = res.status().as_u16();
            let text = res.body_mut().read_to_string().unwrap_or_default();
            let ok = status == 200 && serde_json::from_str::<serde_json::Value>(&text).ok().and_then(|v| v.get("status")?.as_bool().or_else(|| v.get("status")?.as_str().map(|s| s == "true"))).unwrap_or(false);
            super::log(&format!("Sunshine respondió al PIN: {status} {text}"));
            ok
        }
        Err(e) => {
            super::log(&format!("Sunshine no respondió al PIN: {e}"));
            false
        }
    }
}
