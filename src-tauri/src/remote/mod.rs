//! Phone remote: a small HTTP server on the local network that serves a web
//! remote and accepts a fixed set of commands from paired phones.
//!
//! Safety model:
//! - Only private/loopback client addresses are served.
//! - Commands need a token obtained by pairing with the PIN shown on the TV
//!   (the QR code carries it). The PIN rotates after every pairing and pairing
//!   locks for a minute after repeated wrong PINs.
//! - Requests must be `application/json`, so other websites cannot post to it
//!   without a CORS preflight, which is never granted.
//! - A remote can only press navigation/media/volume keys or type text. It
//!   cannot launch programs.

pub mod api;
pub mod keys;

use crate::config::{new_id, now_secs, RemoteDevice};
use crate::{session, AppState};
use serde::{Deserialize, Serialize};
use std::io::Read;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Request, Response, Server};

const PORTS: std::ops::RangeInclusive<u16> = 8765..=8770;
const MAX_BODY: usize = 2048;
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(60);
const PAGE: &str = include_str!("../../remote/index.html");
const ICON: &str = include_str!("../../remote/icon.svg");
const ICON_PNG: &[u8] = include_bytes!("../../remote/icon-180.png");
const MANIFEST: &str = include_str!("../../remote/manifest.json");

struct Runtime {
    server: Option<Arc<Server>>,
    port: Option<u16>,
    pin: String,
    failures: u32,
    locked_until: Option<Instant>,
    error: Option<String>,
}

static RUNTIME: Mutex<Runtime> = Mutex::new(Runtime {
    server: None,
    port: None,
    pin: String::new(),
    failures: 0,
    locked_until: None,
    error: None,
});

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut buf = [0u8; N];
    getrandom::fill(&mut buf).expect("OS random number generator unavailable");
    buf
}

fn new_pin() -> String {
    let n = u32::from_le_bytes(random_bytes::<4>()) % 1_000_000;
    format!("{n:06}")
}

fn new_token() -> String {
    random_bytes::<32>().iter().map(|b| format!("{b:02x}")).collect()
}

fn is_private(addr: &SocketAddr) -> bool {
    match addr.ip() {
        IpAddr::V4(ip) => ip.is_private() || ip.is_loopback() || ip.is_link_local(),
        IpAddr::V6(ip) => {
            if let Some(v4) = ip.to_ipv4_mapped() {
                v4.is_private() || v4.is_loopback() || v4.is_link_local()
            } else {
                ip.is_loopback() || (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80
            }
        }
    }
}

/// LAN IPv4 addresses a phone can reach, real Wi-Fi/Ethernet adapters first.
fn lan_addresses() -> Vec<String> {
    const VIRTUAL: [&str; 9] = ["vethernet", "virtualbox", "vmware", "hyper-v", "loopback", "wsl", "vpn", "tap", "proton"];
    let mut found: Vec<(i32, String)> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(name, ip)| {
            let IpAddr::V4(v4) = ip else { return None };
            let lower = name.to_lowercase();
            if !v4.is_private() || VIRTUAL.iter().any(|v| lower.contains(v)) {
                return None;
            }
            let rank = if lower.contains("wi-fi") || lower.contains("wlan") || lower.contains("wireless") {
                0
            } else if lower.contains("ethernet") {
                1
            } else {
                2
            };
            Some((rank, v4.to_string()))
        })
        .collect();
    found.sort();
    let mut out: Vec<String> = found.into_iter().map(|(_, ip)| ip).collect();
    out.dedup();
    if out.is_empty() {
        // Fallback: the interface used for the default route (no packet is sent).
        if let Some(ip) = UdpSocket::bind("0.0.0.0:0")
            .and_then(|s| s.connect("192.168.0.1:9").map(|_| s))
            .and_then(|s| s.local_addr())
            .ok()
            .map(|a| a.ip())
        {
            out.push(ip.to_string());
        }
    }
    out
}

// ───────────────────────── Lifecycle ─────────────────────────

pub fn start(app: &AppHandle) {
    let enabled = app.state::<AppState>().config.snapshot().remote.enabled;
    let mut rt = RUNTIME.lock().unwrap();
    if rt.pin.is_empty() {
        rt.pin = new_pin();
    }
    if !enabled || rt.server.is_some() {
        return;
    }
    let mut last_err = None;
    for port in PORTS {
        match Server::http(("0.0.0.0", port)) {
            Ok(server) => {
                let server = Arc::new(server);
                rt.server = Some(server.clone());
                rt.port = Some(port);
                rt.error = None;
                let app = app.clone();
                thread::spawn(move || {
                    for request in server.incoming_requests() {
                        handle(&app, request);
                    }
                });
                return;
            }
            Err(e) => last_err = Some(e.to_string()),
        }
    }
    rt.error = Some(format!(
        "No se pudo abrir el servidor del mando (puertos {}-{} ocupados): {}",
        PORTS.start(),
        PORTS.end(),
        last_err.unwrap_or_default()
    ));
}

pub fn stop() {
    let mut rt = RUNTIME.lock().unwrap();
    if let Some(server) = rt.server.take() {
        server.unblock();
    }
    rt.port = None;
}

fn changed(app: &AppHandle) {
    let _ = app.emit("remote-changed", ());
}

// ───────────────────────── HTTP ─────────────────────────

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("valid header")
}

fn respond(request: Request, status: u16, content_type: &str, body: String) {
    respond_bytes(request, status, content_type, body.into_bytes());
}

fn respond_bytes(request: Request, status: u16, content_type: &str, body: Vec<u8>) {
    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", content_type))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"))
        .with_header(header("Referrer-Policy", "no-referrer"))
        .with_header(header("X-Frame-Options", "DENY"));
    let _ = request.respond(response);
}

fn json<T: Serialize>(request: Request, status: u16, value: &T) {
    respond(request, status, "application/json", serde_json::to_string(value).unwrap_or_default());
}

fn error(request: Request, status: u16, message: &str) {
    json(request, status, &serde_json::json!({ "error": message }));
}

fn header_value<'a>(request: &'a Request, name: &'static str) -> Option<&'a str> {
    request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str())
}

fn read_json<T: for<'de> Deserialize<'de>>(request: &mut Request) -> Result<T, &'static str> {
    let is_json = header_value(request, "Content-Type").is_some_and(|v| v.starts_with("application/json"));
    if !is_json {
        return Err("Content-Type debe ser application/json");
    }
    let mut body = String::new();
    request
        .as_reader()
        .take(MAX_BODY as u64 + 1)
        .read_to_string(&mut body)
        .map_err(|_| "Cuerpo no válido")?;
    if body.len() > MAX_BODY {
        return Err("Petición demasiado grande");
    }
    serde_json::from_str(&body).map_err(|_| "JSON no válido")
}

fn authorized(app: &AppHandle, request: &Request) -> Option<RemoteDevice> {
    let token = header_value(request, "Authorization")?.strip_prefix("Bearer ")?.trim();
    if token.len() != 64 {
        return None;
    }
    app.state::<AppState>()
        .config
        .snapshot()
        .remote
        .devices
        .into_iter()
        .find(|d| d.token == token)
}

fn handle(app: &AppHandle, mut request: Request) {
    if !request.remote_addr().is_some_and(is_private) {
        return error(request, 403, "Solo red local");
    }
    let path = request.url().split('?').next().unwrap_or("/").to_string();
    match (request.method().clone(), path.as_str()) {
        (Method::Get, "/") | (Method::Get, "/index.html") => {
            respond(request, 200, "text/html; charset=utf-8", PAGE.to_string())
        }
        (Method::Get, "/icon-180.png") => respond_bytes(request, 200, "image/png", ICON_PNG.to_vec()),
        (Method::Get, "/icon.svg") => respond(request, 200, "image/svg+xml", ICON.to_string()),
        (Method::Get, "/manifest.json") => respond(request, 200, "application/manifest+json", MANIFEST.to_string()),
        (Method::Post, "/api/pair") => pair(app, request),
        (Method::Get, "/api/status") => match authorized(app, &request) {
            Some(device) => status(request, device),
            None => error(request, 401, "No emparejado"),
        },
        (Method::Post, "/api/cmd") => {
            let Some(_) = authorized(app, &request) else { return error(request, 401, "No emparejado") };
            #[derive(Deserialize)]
            struct Cmd {
                cmd: String,
            }
            match read_json::<Cmd>(&mut request) {
                Ok(c) if run_command(app, &c.cmd) => respond(request, 204, "text/plain", String::new()),
                Ok(_) => error(request, 400, "Orden desconocida"),
                Err(e) => error(request, 400, e),
            }
        }
        (Method::Get, "/api/channels") | (Method::Get, "/api/apps") | (Method::Get, "/api/artwork") | (Method::Post, "/api/tv") | (Method::Post, "/api/launch") | (Method::Post, "/api/cast") | (Method::Post, "/api/volume") | (Method::Post, "/api/power") => {
            if authorized(app, &request).is_none() {
                return error(request, 401, "No emparejado");
            }
            match path.as_str() {
                "/api/channels" => api::channels(app, request),
                "/api/apps" => api::apps(app, request),
                "/api/artwork" => api::artwork(request),
                "/api/tv" => api::tv(app, request),
                "/api/launch" => api::launch(app, request),
                "/api/cast" => api::cast(app, request),
                "/api/power" => api::power(app, request),
                _ => api::set_volume(request),
            }
        }
        (Method::Post, "/api/text") => {
            let Some(_) = authorized(app, &request) else { return error(request, 401, "No emparejado") };
            #[derive(Deserialize)]
            struct Text {
                text: String,
                #[serde(default)]
                submit: bool,
            }
            match read_json::<Text>(&mut request) {
                Ok(t) if t.text.chars().count() <= 200 && !t.text.chars().any(char::is_control) => {
                    keys::type_text(&t.text);
                    if t.submit {
                        keys::tap(keys::ENTER);
                    }
                    respond(request, 204, "text/plain", String::new())
                }
                Ok(_) => error(request, 400, "Texto no válido (máx. 200 caracteres)"),
                Err(e) => error(request, 400, e),
            }
        }
        _ => error(request, 404, "No encontrado"),
    }
}

fn pair(app: &AppHandle, mut request: Request) {
    #[derive(Deserialize)]
    struct Pair {
        pin: String,
        #[serde(default)]
        name: String,
    }
    let body = match read_json::<Pair>(&mut request) {
        Ok(b) => b,
        Err(e) => return error(request, 400, e),
    };
    {
        let mut rt = RUNTIME.lock().unwrap();
        if rt.locked_until.is_some_and(|t| Instant::now() < t) {
            return error(request, 429, "Demasiados intentos. Espera un minuto.");
        }
        if body.pin.trim() != rt.pin {
            rt.failures += 1;
            if rt.failures >= MAX_FAILURES {
                rt.failures = 0;
                rt.locked_until = Some(Instant::now() + LOCKOUT);
                rt.pin = new_pin();
                drop(rt);
                changed(app);
            }
            return error(request, 403, "PIN incorrecto");
        }
        rt.failures = 0;
        rt.pin = new_pin(); // one-time: the QR on screen is refreshed
    }
    let name: String = body.name.trim().chars().filter(|c| !c.is_control()).take(40).collect();
    let device = RemoteDevice {
        id: new_id("remote"),
        name: if name.is_empty() { "Móvil".into() } else { name },
        token: new_token(),
        paired_at: now_secs(),
    };
    let token = device.token.clone();
    let device_name = device.name.clone();
    let saved = app.state::<AppState>().config.update(move |c| {
        c.remote.devices.push(device);
        Ok(())
    });
    match saved {
        Ok(()) => {
            let _ = app.emit("remote-paired", &device_name);
            changed(app);
            json(request, 200, &serde_json::json!({ "token": token, "name": device_name }));
        }
        Err(e) => error(request, 500, &e),
    }
}

fn status(request: Request, device: RemoteDevice) {
    let volume = crate::commands::system::volume::get().ok();
    json(
        request,
        200,
        &serde_json::json!({
            "device": device.name,
            "watching": session::current_name(),
            "nowPlaying": session::now_playing(),
            "media": crate::nowplaying::current_summary(),
            "tv": api::published_tv(),
            "volume": volume,
            "power": crate::power::info(),
        }),
    );
}

fn run_command(app: &AppHandle, cmd: &str) -> bool {
    let key = match cmd {
        "up" => keys::UP,
        "down" => keys::DOWN,
        "left" => keys::LEFT,
        "right" => keys::RIGHT,
        "ok" => keys::ENTER,
        "back" => keys::ESCAPE,
        "backspace" => keys::BACKSPACE,
        "space" => keys::SPACE,
        "playpause" => keys::MEDIA_PLAY_PAUSE,
        "next" => keys::MEDIA_NEXT,
        "prev" => keys::MEDIA_PREV,
        "volup" => keys::VOLUME_UP,
        "voldown" => keys::VOLUME_DOWN,
        "mute" => keys::VOLUME_MUTE,
        "home" => {
            if session::is_active() {
                session::go_home(app);
            } else {
                session::focus_main(app);
                let _ = app.emit("remote-home", ());
            }
            return true;
        }
        "search" => {
            if session::is_active() {
                session::end(app, false);
            }
            session::focus_main(app);
            let _ = app.emit("remote-search", ());
            return true;
        }
        _ => return false,
    };
    keys::tap(key);
    true
}

// ───────────────────────── Tauri commands ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteDeviceInfo {
    id: String,
    name: String,
    paired_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    enabled: bool,
    running: bool,
    urls: Vec<String>,
    pin: String,
    pair_url: Option<String>,
    qr_svg: Option<String>,
    locked: bool,
    devices: Vec<RemoteDeviceInfo>,
    error: Option<String>,
}

#[tauri::command]
pub async fn remote_info(state: State<'_, AppState>) -> Result<RemoteInfo, String> {
    let config = state.config.snapshot().remote;
    let (port, pin, error, locked) = {
        let rt = RUNTIME.lock().map_err(|_| "Mando no disponible")?;
        (rt.port, rt.pin.clone(), rt.error.clone(), rt.locked_until.is_some_and(|t| Instant::now() < t))
    };
    let urls: Vec<String> = match port {
        Some(p) => lan_addresses().into_iter().map(|ip| format!("http://{ip}:{p}")).collect(),
        None => vec![],
    };
    let pair_url = urls.first().map(|u| format!("{u}/?pair={pin}"));
    let qr_svg = pair_url.as_ref().and_then(|u| {
        qrcode::QrCode::new(u.as_bytes()).ok().map(|code| {
            code.render::<qrcode::render::svg::Color>()
                .min_dimensions(220, 220)
                .quiet_zone(true)
                .dark_color(qrcode::render::svg::Color("#070b18"))
                .light_color(qrcode::render::svg::Color("#ffffff"))
                .build()
        })
    });
    Ok(RemoteInfo {
        enabled: config.enabled,
        running: port.is_some(),
        urls,
        pin,
        pair_url,
        qr_svg,
        locked,
        devices: config
            .devices
            .into_iter()
            .map(|d| RemoteDeviceInfo { id: d.id, name: d.name, paired_at: d.paired_at })
            .collect(),
        error,
    })
}

#[tauri::command]
pub async fn remote_set_enabled(enabled: bool, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.remote.enabled = enabled;
        Ok(())
    })?;
    if enabled {
        start(&app);
    } else {
        stop();
    }
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn remote_revoke(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.remote.devices.retain(|d| d.id != id);
        Ok(())
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub async fn remote_new_pin(app: AppHandle) -> Result<(), String> {
    crate::profiles::require_adult(&app.state::<AppState>())?;
    RUNTIME.lock().map_err(|_| "Mando no disponible")?.pin = new_pin();
    changed(&app);
    Ok(())
}
