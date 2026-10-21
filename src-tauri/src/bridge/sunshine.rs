//! Sunshine as NOVA Host leaves it: NovaBridge knows its web credentials
//! (DPAPI, this Windows user) so it can type Moonlight's PIN by itself.
//!
//! `NovaBridge.exe --setup` (run elevated by the NOVA Host installer):
//! - lets NovaBridge through the firewall (private networks),
//! - gives Sunshine credentials if it has none yet, or if its user is our
//!   `nova` with a password NovaBridge no longer knows (never replaces the
//!   person's own user), with an easy password ("luna-tigre-verde-faro-42"),
//! - starts NovaBridge with Windows.
//!
//! `--uninstall` undoes the firewall rule and the autostart.
//!
//! Sunshine's web API (localhost only, its own certificate):
//! - `GET /api/pin` lists the pairing requests waiting for a PIN,
//! - `POST /api/pin {pairing_id, pin, name}` answers one of them,
//! - `POST /api/password` changes the credentials (no admin needed).

use serde_json::{json, Value};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{Duration, Instant};
use std::{env, fs, thread};

const SERVICE: &str = "SunshineService";
const FIREWALL_RULE: &str = "NOVA Host (NovaBridge)";
const USER: &str = "nova";
const API: &str = "https://localhost:47990/api";
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// How long Moonlight's request may take to show up in Sunshine.
const PIN_WAIT: Duration = Duration::from_secs(20);

/// Plain words (no accents, easy to type with a remote or a keyboard).
const WORDS: [&str; 256] = [
    "agua", "aire", "alba", "alce", "alma", "ancla", "arco", "arena", "arpa", "astro", "avion", "azul", "bahia", "balsa", "banco", "barco",
    "base", "bosque", "brisa", "brujula", "buho", "cabra", "cacao", "cafe", "calma", "cama", "campo", "canal", "canoa", "capa", "carta", "casa",
    "cebra", "cedro", "cielo", "cine", "circo", "ciudad", "clave", "cobre", "cohete", "coral", "costa", "cubo", "cueva", "dado", "delfin", "diente",
    "disco", "dragon", "duna", "eco", "eje", "estrella", "faro", "fuego", "flor", "foca", "fresa", "fruta", "gato", "gema", "globo", "golfo",
    "gorra", "grano", "grillo", "guante", "halcon", "helado", "hielo", "hierba", "hoja", "hongo", "huerto", "idea", "isla", "jade", "jardin", "jarra",
    "jirafa", "joya", "juego", "koala", "lago", "lana", "lapiz", "lava", "leon", "libro", "lima", "lince", "lino", "llama", "lluvia", "lobo",
    "loro", "luna", "luz", "madera", "mango", "mapa", "mar", "marea", "melon", "mesa", "miel", "mina", "mirlo", "mochila", "monte", "mora",
    "motor", "muro", "musica", "nave", "niebla", "nido", "nieve", "noche", "norte", "nube", "nuez", "ola", "olivo", "onda", "oro", "oso",
    "otono", "pala", "palma", "pan", "panda", "papel", "parque", "pato", "pera", "perla", "pez", "piano", "pino", "pista", "planeta", "playa",
    "pluma", "polo", "puente", "puerto", "pulpo", "queso", "radio", "rama", "rana", "rayo", "red", "reloj", "rio", "roble", "roca", "rosa",
    "rueda", "sal", "salto", "selva", "seta", "sierra", "silla", "sol", "sombra", "sonido", "taza", "tejado", "tierra", "tigre", "tinta", "toro",
    "torre", "tren", "trigo", "trueno", "tubo", "tulipan", "uva", "vaca", "valle", "vela", "verde", "viento", "vino", "violeta", "volcan", "yate",
    "yema", "yoyo", "zafiro", "zorro", "abeto", "acero", "album", "almendra", "amapola", "antena", "anillo", "arbol", "ardilla", "aurora", "ballena", "bambu",
    "baul", "bicho", "bombilla", "botella", "bufanda", "burbuja", "cactus", "camello", "canela", "castor", "cereza", "cisne", "cometa", "conejo", "copa", "cuerda",
    "dalia", "domino", "erizo", "escoba", "espiga", "farol", "flauta", "galleta", "gaviota", "girasol", "gorila", "granja", "guitarra", "hormiga", "iman", "kiwi",
    "lagarto", "laurel", "limon", "linterna", "madeja", "maleta", "manzana", "medusa", "molino", "naranja", "nutria", "ostra", "pajaro", "paraguas", "pepino", "tortuga",
];

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

/// Sunshine's web credentials as NovaBridge knows them.
pub fn credentials() -> Option<(String, String)> {
    let sealed = fs::read(creds_path()).ok()?;
    let plain = crate::plugins::secrets::unprotect(&sealed).ok()?;
    let text = String::from_utf8(plain).ok()?;
    let (user, pass) = text.split_once('\n')?;
    Some((user.to_string(), pass.to_string()))
}

fn save_credentials(user: &str, password: &str) -> Result<(), String> {
    let sealed = crate::plugins::secrets::protect(format!("{user}\n{password}").as_bytes())?;
    fs::create_dir_all(super::dir()).map_err(|e| e.to_string())?;
    fs::write(creds_path(), sealed).map_err(|e| e.to_string())
}

/// Four plain words and a number: `luna-tigre-verde-faro-42` (~38 bits).
pub fn easy_password() -> String {
    let bytes = super::random::<5>();
    let mut parts: Vec<String> = bytes[..4].iter().map(|b| WORDS[*b as usize].to_string()).collect();
    parts.push(format!("{:02}", bytes[4] % 100));
    parts.join("-")
}

fn run(program: &str, args: &[&str]) -> bool {
    Command::new(program).args(args).creation_flags(CREATE_NO_WINDOW).status().is_ok_and(|s| s.success())
}

/// Sunshine's web user, if it has one (set by the person, or `nova` by us).
fn current_user(sunshine: &std::path::Path) -> Option<String> {
    fs::read_to_string(sunshine.join(r"config\sunshine_state.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("username")?.as_str().map(String::from))
        .filter(|u| !u.is_empty())
}

fn set_credentials(sunshine: &std::path::Path) -> Result<(), String> {
    let password = easy_password();
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
    save_credentials(USER, &password)
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
    if credentials().is_some() {
        super::log("NovaBridge ya conocía el usuario de Sunshine");
        return 0;
    }
    // `nova` is ours (an earlier NOVA Host whose password was forgotten, e.g.
    // after uninstalling): it gets a new one. Anyone else's user is never touched.
    match current_user(&sunshine) {
        Some(user) if user != USER => {
            super::log(&format!("Sunshine ya tenía el usuario «{user}»: se respeta (se conecta desde el menú de NovaBridge)"));
            return 0;
        }
        Some(_) => super::log("Sunshine tenía el usuario de NOVA Host sin contraseña conocida: se le da una nueva"),
        None => {}
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

// ───────────────────────── Sunshine's web API ─────────────────────────

fn agent(timeout: Duration) -> ureq::Agent {
    // Only localhost, whose certificate Sunshine makes up itself.
    ureq::Agent::config_builder()
        .timeout_global(Some(timeout))
        .http_status_as_error(false)
        .tls_config(ureq::tls::TlsConfig::builder().disable_verification(true).build())
        .build()
        .into()
}

fn basic(user: &str, password: &str) -> String {
    use base64::Engine;
    format!("Basic {}", base64::engine::general_purpose::STANDARD.encode(format!("{user}:{password}")))
}

/// Calls the API: (HTTP status, JSON body).
fn call(method: &str, path: &str, auth: &str, body: Option<&Value>, timeout: Duration) -> Result<(u16, Value), String> {
    let agent = agent(timeout);
    let url = format!("{API}{path}");
    let result = match body {
        Some(body) => agent
            .post(&url)
            .header("Authorization", auth)
            .header("Content-Type", "application/json")
            .send(body.to_string().as_bytes()),
        None if method == "GET" => agent.get(&url).header("Authorization", auth).call(),
        None => return Err(format!("método {method} sin cuerpo")),
    };
    let mut res = result.map_err(|e| format!("Sunshine no responde: {e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().read_to_string().unwrap_or_default();
    Ok((status, serde_json::from_str(&text).unwrap_or(Value::Null)))
}

fn ok(value: &Value) -> bool {
    value.get("status").and_then(|s| s.as_bool().or_else(|| s.as_str().map(|s| s == "true"))).unwrap_or(false)
}

/// Whether `user`/`password` open Sunshine's web API.
pub fn check(user: &str, password: &str) -> Result<bool, String> {
    let (status, _) = call("GET", "/clients/list", &basic(user, password), None, Duration::from_secs(10))?;
    Ok(status == 200)
}

/// Remembers credentials the person typed (after checking them with Sunshine).
pub fn connect(user: &str, password: &str) -> Result<(), String> {
    if !check(user, password)? {
        return Err("Sunshine no acepta ese usuario y esa contraseña.".into());
    }
    save_credentials(user, password)?;
    super::log(&format!("NovaBridge conectado con el usuario «{user}» de Sunshine"));
    Ok(())
}

/// Changes Sunshine's password (same user) and remembers the new one.
pub fn change_password(new_password: &str) -> Result<(), String> {
    let (user, current) = credentials().ok_or("NovaBridge no conoce aún el usuario de Sunshine.")?;
    let body = json!({
        "currentUsername": user,
        "currentPassword": current,
        "newUsername": user,
        "newPassword": new_password,
        "confirmNewPassword": new_password,
    });
    let (status, reply) = call("POST", "/password", &basic(&user, &current), Some(&body), Duration::from_secs(10))?;
    if status != 200 || !ok(&reply) {
        let why = reply.get("error").and_then(|e| e.as_str()).unwrap_or("sin motivo");
        return Err(format!("Sunshine no cambió la contraseña ({status}: {why})."));
    }
    save_credentials(&user, new_password)?;
    super::log("Contraseña de Sunshine cambiada");
    Ok(())
}

/// Same address, written either way (`::ffff:192.168.1.5` / `192.168.1.5`).
fn same_ip(a: &str, b: &str) -> bool {
    let plain = |s: &str| s.trim().trim_start_matches("::ffff:").to_ascii_lowercase();
    !a.is_empty() && plain(a) == plain(b)
}

/// The pairing request Moonlight on the box at `from` is waiting on.
fn pending_pairing(auth: &str, from: &str) -> Option<String> {
    let (status, reply) = call("GET", "/pin", auth, None, Duration::from_secs(10)).ok()?;
    if status != 200 {
        super::log(&format!("Sunshine no dio las peticiones pendientes ({status})"));
        return None;
    }
    let pairings = reply.get("pairings")?.as_array()?;
    let id = |p: &Value| p.get("id").and_then(|i| i.as_str()).map(String::from);
    // Its own address first; a box on this same PC may show up as another
    // local address, so a single pending request is also ours.
    pairings
        .iter()
        .find(|p| p.get("address").and_then(|a| a.as_str()).is_some_and(|a| same_ip(a, from)))
        .and_then(id)
        .or_else(|| if pairings.len() == 1 { id(&pairings[0]) } else { None })
}

/// Types Moonlight's PIN into Sunshine. False when NovaBridge has no
/// credentials, Moonlight's request never arrived or Sunshine said no.
pub fn send_pin(pin: &str, name: &str, from: &str) -> bool {
    let Some((user, pass)) = credentials() else { return false };
    let auth = basic(&user, &pass);
    let deadline = Instant::now() + PIN_WAIT;
    let pairing = loop {
        if let Some(id) = pending_pairing(&auth, from) {
            break id;
        }
        if Instant::now() >= deadline {
            super::log("Moonlight no llegó a pedir el emparejamiento a Sunshine");
            return false;
        }
        thread::sleep(Duration::from_millis(500));
    };
    let name: String = name.chars().take(64).collect();
    let body = json!({ "pairing_id": pairing, "pin": pin, "name": name });
    // Sunshine answers once Moonlight has finished the handshake.
    match call("POST", "/pin", &auth, Some(&body), Duration::from_secs(40)) {
        Ok((status, reply)) => {
            let done = status == 200 && ok(&reply);
            super::log(&format!("Sunshine respondió al PIN: {status} {reply}"));
            done
        }
        Err(e) => {
            super::log(&e);
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn easy_passwords_are_easy() {
        let p = easy_password();
        let parts: Vec<&str> = p.split('-').collect();
        assert_eq!(parts.len(), 5, "{p}");
        assert!(parts[..4].iter().all(|w| WORDS.contains(w)));
        assert!(parts[4].len() == 2 && parts[4].bytes().all(|b| b.is_ascii_digit()));
    }

    #[test]
    fn words_are_unique_and_typeable() {
        let mut seen = std::collections::HashSet::new();
        for w in WORDS {
            assert!(seen.insert(w), "repetida: {w}");
            assert!(w.bytes().all(|b| b.is_ascii_lowercase()), "no se teclea fácil: {w}");
        }
    }

    #[test]
    fn addresses_match_either_way() {
        assert!(same_ip("::ffff:192.168.1.5", "192.168.1.5"));
        assert!(!same_ip("192.168.1.6", "192.168.1.5"));
        assert!(!same_ip("", ""));
    }
}
