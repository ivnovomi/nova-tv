//! NovaBridge: the small program that lives in the tray of the gaming PC.
//!
//! It lets NOVA (on the TV box) find this PC, asks the user before pairing,
//! lists the PC's games with NOVA's own scanners and starts them when NOVA
//! asks. The picture travels with Sunshine (on the PC) and Moonlight (on the
//! box): NOVA streams Sunshine's "Desktop" and NovaBridge opens the game there.
//!
//! The binary is `src/bin/nova-bridge.rs`; its state lives in
//! `%APPDATA%\NovaBridge` (id, accepted boxes, log).

#[cfg(windows)]
mod input;
#[cfg(windows)]
mod page;
pub mod proto;
#[cfg(windows)]
mod sunshine;
#[cfg(windows)]
mod tray;

use crate::commands::{games, steam};
use crate::config::{PcGame, Shortcut, ShortcutSource, Target};
use proto::{Info, InputRequest, LaunchRequest, PairReply, PairRequest, PinRequest};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::UdpSocket;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::{env, fs, thread};
use tiny_http::{Header, Method, Request, Response, Server};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
const SUNSHINE_WEB: &str = "https://localhost:47990";
const MAX_BODY: u64 = 4096;
const MAX_LOG: u64 = 256 * 1024;

// ───────────────────────── State ─────────────────────────

#[derive(Serialize, Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
struct Client {
    name: String,
    token: String,
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct State {
    id: String,
    #[serde(default)]
    clients: Vec<Client>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);
/// One "¿Dejas que…?" question on screen at a time.
static ASKING: AtomicBool = AtomicBool::new(false);

pub fn dir() -> PathBuf {
    env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(env::temp_dir).join("NovaBridge")
}

fn state_path() -> PathBuf {
    dir().join("bridge.json")
}

fn load() -> State {
    let mut state: State = fs::read_to_string(state_path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    if state.id.is_empty() {
        state.id = hex(&random::<8>());
        save(&state);
    }
    state
}

fn save(state: &State) {
    let _ = fs::create_dir_all(dir());
    let tmp = state_path().with_extension("tmp");
    if fs::write(&tmp, serde_json::to_vec_pretty(state).unwrap_or_default()).is_ok() && fs::rename(&tmp, state_path()).is_err() {
        let _ = fs::write(state_path(), serde_json::to_vec_pretty(state).unwrap_or_default());
    }
}

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut guard = STATE.lock().unwrap_or_else(|e| e.into_inner());
    f(guard.get_or_insert_with(load))
}

/// Boxes the user let in.
pub fn clients() -> Vec<String> {
    with_state(|s| s.clients.iter().map(|c| c.name.clone()).collect())
}

/// Forgets every box: they have to ask again.
pub fn forget_clients() {
    with_state(|s| {
        s.clients.clear();
        save(s);
    });
    log("Se han olvidado todas las cajas emparejadas");
}

fn random<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("OS random number generator unavailable");
    buf
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

pub fn log_path() -> PathBuf {
    dir().join("bridge.log")
}

pub fn log(message: &str) {
    let path = log_path();
    let _ = fs::create_dir_all(dir());
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG) {
        let _ = fs::rename(&path, path.with_extension("old.log"));
    }
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(f, "[{secs}] {message}");
    }
}

// ───────────────────────── This PC ─────────────────────────

pub fn computer_name() -> String {
    env::var("COMPUTERNAME").unwrap_or_else(|_| "PC".into())
}

#[cfg(windows)]
fn sunshine_exe() -> Option<PathBuf> {
    sunshine::dir().map(|d| d.join("sunshine.exe"))
}

#[cfg(not(windows))]
fn sunshine_exe() -> Option<PathBuf> {
    None
}

pub fn sunshine_running() -> bool {
    use sysinfo::{ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    sys.processes().values().any(|p| p.name().eq_ignore_ascii_case("sunshine.exe"))
}

pub fn info() -> Info {
    Info {
        id: with_state(|s| s.id.clone()),
        name: computer_name(),
        version: VERSION.into(),
        sunshine: sunshine_exe().is_some(),
        sunshine_running: sunshine_running(),
        macs: macs(),
    }
}

pub fn open_sunshine() {
    let _ = tauri_plugin_opener::open_url(SUNSHINE_WEB, None::<&str>);
}

/// The games NOVA would find if it ran on this PC.
fn all_games() -> Vec<Shortcut> {
    let mut list = steam::installed_games();
    list.extend(games::installed_games());
    list
}

fn store_name(game: &Shortcut) -> String {
    match game.source {
        ShortcutSource::Steam => "Steam".into(),
        _ => game.description.clone().unwrap_or_default(),
    }
}

fn game_list() -> Vec<PcGame> {
    all_games().iter().map(|g| PcGame { id: g.id.clone(), name: g.name.clone(), store: store_name(g) }).collect()
}

/// Starts a game found by the scanners (never a path sent by the box).
fn launch(id: &str) -> Result<String, String> {
    games::invalidate();
    let game = all_games().into_iter().find(|g| g.id == id).ok_or("Ese juego ya no está en este PC.")?;
    match &game.target {
        Target::Steam { app_id } => steam::launch(*app_id)?,
        Target::Uri { uri } => games::launch_uri(uri)?,
        Target::Packaged { aumid } => crate::commands::store::activate(aumid)?,
        Target::Executable { path, args } => {
            let path = PathBuf::from(path);
            let mut cmd = std::process::Command::new(&path);
            cmd.args(args);
            if let Some(parent) = path.parent() {
                cmd.current_dir(parent);
            }
            cmd.spawn().map_err(|e| format!("No se pudo abrir el juego: {e}"))?;
        }
        _ => return Err("Este juego no se puede abrir desde NovaBridge.".into()),
    }
    Ok(game.name)
}

// ───────────────────────── Questions on the PC's screen ─────────────────────────

#[cfg(windows)]
fn ask(title: &str, text: &str) -> bool {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_ICONQUESTION, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO};
    unsafe { MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_YESNO | MB_ICONQUESTION | MB_TOPMOST | MB_SETFOREGROUND) == IDYES }
}

#[cfg(windows)]
fn tell(title: &str, text: &str) {
    use windows::core::HSTRING;
    use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST};
    let (title, text) = (HSTRING::from(title), HSTRING::from(text));
    thread::spawn(move || unsafe {
        MessageBoxW(None, &text, &title, MB_OK | MB_ICONINFORMATION | MB_TOPMOST | MB_SETFOREGROUND);
    });
}

#[cfg(not(windows))]
fn ask(_: &str, _: &str) -> bool {
    false
}

#[cfg(not(windows))]
fn tell(_: &str, _: &str) {}

// ───────────────────────── Network cards (Wake-on-LAN) ─────────────────────────

#[cfg(windows)]
fn macs() -> Vec<String> {
    use windows::Win32::NetworkManagement::IpHelper::{
        GetAdaptersAddresses, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IP_ADAPTER_ADDRESSES_LH,
    };
    use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
    use windows::Win32::Networking::WinSock::AF_UNSPEC;
    const ETHERNET: u32 = 6;
    const WIFI: u32 = 71;

    let mut size: u32 = 32 * 1024;
    // u64s keep the adapter records aligned.
    let mut buf = vec![0u64; size as usize / 8];
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    let first = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
    if unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(first), &mut size) } != 0 {
        return vec![];
    }
    let mut out = Vec::new();
    let mut next = first as *const IP_ADAPTER_ADDRESSES_LH;
    while let Some(a) = unsafe { next.as_ref() } {
        if a.PhysicalAddressLength == 6 && a.OperStatus == IfOperStatusUp && (a.IfType == ETHERNET || a.IfType == WIFI) {
            let mac = a.PhysicalAddress[..6].iter().map(|b| format!("{b:02x}")).collect::<Vec<_>>().join(":");
            if !out.contains(&mac) {
                out.push(mac);
            }
        }
        next = a.Next;
    }
    out
}

#[cfg(not(windows))]
fn macs() -> Vec<String> {
    vec![]
}

// ───────────────────────── Network ─────────────────────────

/// Answers NOVA's "who's there?" broadcasts with this PC's info.
fn discovery() {
    let socket = match UdpSocket::bind(("0.0.0.0", proto::DISCOVERY_PORT)) {
        Ok(s) => s,
        Err(e) => return log(&format!("No se pudo escuchar el puerto de búsqueda {}: {e}", proto::DISCOVERY_PORT)),
    };
    let mut buf = [0u8; 64];
    loop {
        let Ok((n, from)) = socket.recv_from(&mut buf) else { continue };
        if &buf[..n] == proto::DISCOVER {
            let _ = socket.send_to(&serde_json::to_vec(&info()).unwrap_or_default(), from);
        }
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn json<T: Serialize>(request: Request, status: u16, value: &T) {
    let body = serde_json::to_vec(value).unwrap_or_default();
    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", "application/json"))
        .with_header(header("Cache-Control", "no-store"));
    let _ = request.respond(response);
}

fn error(request: Request, status: u16, message: &str) {
    json(request, status, &serde_json::json!({ "error": message }));
}

fn body<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Option<T> {
    let mut text = String::new();
    request.as_reader().take(MAX_BODY).read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok()
}

/// The box this request comes from, if it was let in.
fn client(request: &Request) -> Option<Client> {
    let token = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .and_then(|h| h.value.as_str().strip_prefix("Bearer "))?
        .to_string();
    with_state(|s| s.clients.iter().find(|c| !token.is_empty() && c.token == token).cloned())
}

fn clean_name(name: &str) -> String {
    let name: String = name.chars().filter(|c| !c.is_control()).take(40).collect();
    if name.trim().is_empty() { "NOVA".into() } else { name.trim().to_string() }
}

fn handle(mut request: Request) {
    let from = request.remote_addr().map(|a| a.ip().to_string()).unwrap_or_default();
    let path = request.url().split('?').next().unwrap_or("").to_string();
    match (request.method(), path.as_str()) {
        (Method::Get, "/info") => json(request, 200, &info()),
        (Method::Post, "/pair") => {
            let Some(PairRequest { name }) = body(&mut request) else { return error(request, 400, "Petición no válida") };
            let name = clean_name(&name);
            if ASKING.swap(true, Ordering::AcqRel) {
                return error(request, 409, "Ya hay una pregunta abierta en el PC");
            }
            log(&format!("«{name}» ({from}) pide jugar con este PC"));
            let yes = ask(
                "NovaBridge",
                &format!("«{name}» quiere jugar a los juegos de este PC desde la tele.\n\n¿Le dejas?"),
            );
            ASKING.store(false, Ordering::Release);
            if !yes {
                log(&format!("«{name}» rechazado"));
                return error(request, 403, "En el PC han dicho que no");
            }
            let token = hex(&random::<32>());
            with_state(|s| {
                s.clients.retain(|c| c.name != name);
                s.clients.push(Client { name: name.clone(), token: token.clone() });
                save(s);
            });
            log(&format!("«{name}» emparejado"));
            json(request, 200, &PairReply { token });
        }
        (_, "/games" | "/launch" | "/moonlight-pin" | "/input") => {
            let Some(client) = client(&request) else { return error(request, 401, "Esta caja no está emparejada") };
            match (request.method(), path.as_str()) {
                (Method::Get, "/games") => json(request, 200, &game_list()),
                (Method::Post, "/launch") => {
                    let Some(LaunchRequest { id }) = body(&mut request) else { return error(request, 400, "Petición no válida") };
                    match launch(&id) {
                        Ok(name) => {
                            log(&format!("«{}» abre {name} ({id})", client.name));
                            json(request, 200, &serde_json::json!({ "ok": true }));
                        }
                        Err(e) => {
                            log(&format!("«{}» no pudo abrir {id}: {e}", client.name));
                            error(request, 404, &e);
                        }
                    }
                }
                (Method::Post, "/moonlight-pin") => {
                    let Some(PinRequest { pin }) = body(&mut request) else { return error(request, 400, "Petición no válida") };
                    if !proto::valid_pin(&pin) {
                        return error(request, 400, "El PIN son 4 cifras");
                    }
                    if !sunshine_running() {
                        return error(request, 409, "Sunshine no está en marcha en el PC");
                    }
                    log(&format!("«{}» ({from}) empareja Moonlight", client.name));
                    json(request, 200, &serde_json::json!({ "ok": true }));
                    pin_to_sunshine(pin, client.name, from);
                }
                (Method::Post, "/input") => {
                    let Some(InputRequest { keyboard }) = body(&mut request) else { return error(request, 400, "Petición no válida") };
                    #[cfg(windows)]
                    input::set(keyboard);
                    log(&format!("«{}» pide el mando como teclado y ratón: {}", client.name, if keyboard { "sí" } else { "no" }));
                    json(request, 200, &serde_json::json!({ "ok": true, "keyboard": keyboard }));
                }
                _ => error(request, 405, "Método no permitido"),
            }
        }
        #[cfg(windows)]
        (_, "/sunshine") => page::handle(request, &from),
        _ => error(request, 404, "No existe"),
    }
}

/// Gives Sunshine the PIN Moonlight is pairing with: by itself when NovaBridge
/// knows Sunshine's user, or by asking the person to type it on the PC.
fn pin_to_sunshine(pin: String, name: String, from: String) {
    #[cfg(windows)]
    {
        let known = sunshine::credentials().is_some();
        if known && sunshine::send_pin(&pin, &name, &from) {
            return log(&format!("PIN de «{name}» escrito en Sunshine: no hace falta tocar nada"));
        }
        let how = if known {
            "NovaBridge no pudo escribirlo solo (mira «Ver registro» en su menú)."
        } else {
            "Para que la próxima vez se escriba solo: menú de NovaBridge → «Conectar con Sunshine…»."
        };
        let _ = tauri_plugin_opener::open_url(format!("{SUNSHINE_WEB}/pin"), None::<&str>);
        tell(
            "NovaBridge · Moonlight",
            &format!("«{name}» quiere ver la pantalla de este PC.\n\nEscribe este PIN en la página de Sunshine que se acaba de abrir:\n\n{pin}\n\n{how}"),
        );
    }
    #[cfg(not(windows))]
    let _ = (pin, name, from);
}

fn server() {
    let server = match Server::http(("0.0.0.0", proto::HTTP_PORT)) {
        Ok(s) => s,
        Err(e) => return log(&format!("No se pudo abrir el puerto {}: {e}", proto::HTTP_PORT)),
    };
    for request in server.incoming_requests() {
        // The pairing question waits for the user: never block the others.
        let _ = thread::Builder::new().name("bridge-request".into()).spawn(move || handle(request));
    }
}

/// Starts NovaBridge: network in the background, tray icon in front.
/// `--setup` / `--uninstall` are for the NOVA Host installer (elevated).
pub fn run() {
    #[cfg(windows)]
    match env::args().nth(1).as_deref() {
        Some("--setup") => std::process::exit(sunshine::setup()),
        Some("--uninstall") => std::process::exit(sunshine::uninstall()),
        _ => {}
    }
    #[cfg(windows)]
    if !tray::single_instance() {
        return;
    }
    log(&format!("NovaBridge {VERSION} arrancado en {} (Sunshine: {})", computer_name(), if sunshine_exe().is_some() { "sí" } else { "no" }));
    thread::spawn(discovery);
    thread::spawn(server);
    #[cfg(windows)]
    tray::run();
    #[cfg(not(windows))]
    loop {
        thread::park();
    }
}
