//! Playing the games of another PC of the house (NovaBridge + Moonlight).
//!
//! 1. NOVA finds NovaBridge with a broadcast and asks to pair: the user says
//!    yes on the PC and NOVA keeps the token.
//! 2. Moonlight (on this box) pairs with Sunshine (on the PC): NOVA runs
//!    `Moonlight pair <pc> --pin` and NovaBridge shows that PIN on the PC.
//! 3. The PC's games show up among NOVA's games as `pc:<pc>:<game>`. Playing
//!    one wakes the PC if it sleeps, has NovaBridge start the game and opens
//!    Moonlight on Sunshine's desktop; closing Moonlight comes back to NOVA.

use crate::bridge::proto::{self, Info, InputRequest, LaunchRequest, PairReply, PairRequest, PinRequest};
use crate::config::{Config, PairedPc, PcGame, Shortcut, ShortcutKind, ShortcutSource, Target};
use crate::AppState;
use serde::{de::DeserializeOwned, Serialize};
use std::net::{IpAddr, Ipv4Addr, UdpSocket};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::{env, thread};
use tauri::{AppHandle, Emitter, Manager, State};

const ID_PREFIX: &str = "pc:";
const QUICK: Duration = Duration::from_millis(1500);
/// The user has this long to answer the question on the PC.
const ANSWER: Duration = Duration::from_secs(90);
/// A PC waking up from sleep (or booting) answers within this.
const WAKE: Duration = Duration::from_secs(120);
const GAMES_EVERY: Duration = Duration::from_secs(120);

fn log(message: &str) {
    eprintln!("[NOVA · PC] {message}");
}

// ───────────────────────── Talking to NovaBridge ─────────────────────────

fn agent(timeout: Duration) -> ureq::Agent {
    ureq::Agent::config_builder().timeout_global(Some(timeout)).max_redirects(0).http_status_as_error(false).build().into()
}

fn url(host: &str, path: &str) -> String {
    format!("http://{host}:{}{path}", proto::HTTP_PORT)
}

fn reply<T: DeserializeOwned>(result: Result<ureq::http::Response<ureq::Body>, ureq::Error>, host: &str) -> Result<T, String> {
    let mut res = result.map_err(|e| format!("El PC ({host}) no responde: {e}"))?;
    let status = res.status().as_u16();
    let text = res.body_mut().with_config().limit(4 * 1024 * 1024).read_to_string().map_err(|e| e.to_string())?;
    if status >= 400 {
        let message = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| v.get("error")?.as_str().map(String::from))
            .unwrap_or_else(|| format!("El PC respondió {status}"));
        return Err(message);
    }
    serde_json::from_str(&text).map_err(|e| format!("Respuesta del PC no válida: {e}"))
}

fn get<T: DeserializeOwned>(host: &str, path: &str, token: Option<&str>, timeout: Duration) -> Result<T, String> {
    let mut req = agent(timeout).get(url(host, path));
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    reply(req.call(), host)
}

fn post<T: DeserializeOwned>(host: &str, path: &str, token: Option<&str>, body: &impl Serialize, timeout: Duration) -> Result<T, String> {
    let mut req = agent(timeout).post(url(host, path)).header("Content-Type", "application/json");
    if let Some(token) = token {
        req = req.header("Authorization", format!("Bearer {token}"));
    }
    reply(req.send(serde_json::to_vec(body).unwrap_or_default().as_slice()), host)
}

/// NovaBridges answering on the home network right now, with their address.
/// This box's addresses on real home networks (no loopback, no 169.254.x.x).
fn lan_addresses() -> Vec<Ipv4Addr> {
    let mut out: Vec<Ipv4Addr> = local_ip_address::list_afinet_netifas()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|(_, ip)| match ip {
            IpAddr::V4(v4) if v4.is_private() => Some(v4),
            _ => None,
        })
        .collect();
    out.sort();
    out.dedup();
    out
}

/// A broadcast reaches only the network card Windows picks (often a VPN or a
/// virtual one): one socket per home card, each shouting on its own network.
fn broadcast(packet: &[u8], ports: &[u16]) -> Vec<UdpSocket> {
    let mut sockets: Vec<UdpSocket> = lan_addresses()
        .into_iter()
        .filter_map(|ip| {
            let socket = UdpSocket::bind((ip, 0)).ok()?;
            let _ = socket.set_broadcast(true);
            let [a, b, c, _] = ip.octets();
            for &port in ports {
                let _ = socket.send_to(packet, ("255.255.255.255", port));
                // Most homes are /24: also the network's own broadcast address.
                let _ = socket.send_to(packet, (Ipv4Addr::new(a, b, c, 255), port));
            }
            Some(socket)
        })
        .collect();
    // And Windows' own pick, in case none of the above is the right one.
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        let _ = socket.set_broadcast(true);
        for &port in ports {
            let _ = socket.send_to(packet, ("255.255.255.255", port));
        }
        sockets.push(socket);
    }
    sockets
}

/// An IPv4 address or a plain PC name (`TORRE`, `torre.local`).
fn valid_host(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && !host.starts_with(['.', '-'])
        && host.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-')
}

/// How likely an address is the home network: routers use 192.168.x.x; VPNs
/// tend to 10.x and virtual switches (Hyper-V, WSL) to 172.16-31.x.
fn home_rank(host: &str) -> u8 {
    match host.parse::<Ipv4Addr>().map(|ip| ip.octets()) {
        Ok([192, 168, ..]) => 0,
        Ok([10, ..]) => 1,
        Ok([172, ..]) => 2,
        Ok([169, 254, ..]) => 4,
        _ => 3,
    }
}

/// NovaBridges answering on the home network right now, with their address.
fn discover(wait: Duration) -> Vec<(Info, String)> {
    let sockets = broadcast(proto::DISCOVER, &[proto::DISCOVERY_PORT]);
    for socket in &sockets {
        let _ = socket.set_read_timeout(Some(Duration::from_millis(40)));
    }
    let deadline = Instant::now() + wait;
    let mut found: Vec<(Info, String)> = Vec::new();
    let mut buf = [0u8; 4096];
    while Instant::now() < deadline {
        for socket in &sockets {
            let Ok((n, from)) = socket.recv_from(&mut buf) else { continue };
            let Ok(info) = serde_json::from_slice::<Info>(&buf[..n]) else { continue };
            if info.id.is_empty() {
                continue;
            }
            let host = from.ip().to_string();
            match found.iter_mut().find(|(i, _)| i.id == info.id) {
                // The same PC through another card: keep its most home-like address.
                Some(entry) if home_rank(&host) < home_rank(&entry.1) => entry.1 = host,
                Some(_) => {}
                None => found.push((info, host)),
            }
        }
    }
    found
}

/// Magic packet: six 0xFF and the card's address sixteen times.
fn wake(macs: &[String]) {
    for mac in macs.iter().filter_map(|m| proto::parse_mac(m)) {
        let mut packet = vec![0xffu8; 6];
        for _ in 0..16 {
            packet.extend_from_slice(&mac);
        }
        broadcast(&packet, &[9, 7]);
    }
}

/// Where the PC answers now: its last address, or wherever discovery finds it.
/// `on_wake` runs once, when the PC doesn't answer and NOVA starts waking it.
fn reach(pc: &PairedPc, wait: Duration, on_wake: impl Fn()) -> Option<(Info, String)> {
    let deadline = Instant::now() + wait;
    let mut woke = false;
    loop {
        if let Some(info) = get::<Info>(&pc.host, "/info", None, QUICK).ok().filter(|i| i.id == pc.id) {
            return Some((info, pc.host.clone()));
        }
        if let Some(found) = discover(QUICK).into_iter().find(|(i, _)| i.id == pc.id) {
            return Some(found);
        }
        if Instant::now() >= deadline {
            return None;
        }
        if !woke {
            log(&format!("{} no contesta: lo despierto", pc.name));
            woke = true;
            on_wake();
        }
        wake(&pc.macs);
        thread::sleep(Duration::from_secs(2));
    }
}

// ───────────────────────── Moonlight on this box ─────────────────────────

// The portable Moonlight NOVA installs in its own folder (no admin, nothing
// in Windows): pinned version, checked against its published SHA-256.
const MOONLIGHT_VERSION: &str = "6.2.0";
const MOONLIGHT_URL: &str = "https://github.com/moonlight-stream/moonlight-qt/releases/download/v6.2.0/MoonlightPortable-x64-6.2.0.zip";
const MOONLIGHT_SHA256: &str = "6f91d268b41ed5ca8066d9d7578dc403b8db190991ff48f00b1700465f8f7ebf";
const MOONLIGHT_MAX: u64 = 64 * 1024 * 1024;
/// Written last: a folder without it is a half-finished install.
const MOONLIGHT_MARK: &str = "nova-version.txt";

fn own_moonlight_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_local_data_dir().ok().map(|d| d.join("moonlight"))
}

fn own_moonlight(app: &AppHandle) -> Option<PathBuf> {
    let dir = own_moonlight_dir(app)?;
    std::fs::read_to_string(dir.join(MOONLIGHT_MARK)).ok()?;
    Some(dir.join("Moonlight.exe")).filter(|p| p.is_file())
}

/// NOVA's own Moonlight, or one installed in Windows.
fn moonlight(app: &AppHandle) -> Option<PathBuf> {
    let program_files = ["ProgramFiles", "ProgramFiles(x86)"].iter().filter_map(env::var_os).map(PathBuf::from);
    let local = env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("Programs"));
    own_moonlight(app).or_else(|| {
        program_files
            .chain(local)
            .map(|base| base.join(r"Moonlight Game Streaming\Moonlight.exe"))
            .find(|p| p.is_file())
    })
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct InstallProgress {
    /// "download" | "unpack" | "done"
    stage: &'static str,
    done: u64,
    total: u64,
}

/// Downloads, checks and unpacks Moonlight into NOVA's folder.
fn install_moonlight(app: &AppHandle) -> Result<(), String> {
    let dir = own_moonlight_dir(app).ok_or("No se encuentra la carpeta de NOVA")?;
    install_moonlight_into(&dir, |stage, done, total| {
        let _ = app.emit("moonlight-install", InstallProgress { stage, done, total });
    })
}

fn install_moonlight_into(dir: &std::path::Path, emit: impl Fn(&'static str, u64, u64)) -> Result<(), String> {
    use sha2::{Digest, Sha256};
    use std::io::{Read, Write};
    let dir = dir.to_path_buf();
    let zip_path = dir.with_extension("zip.part");

    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(15 * 60)))
        .max_redirects(5)
        .https_only(true)
        .build()
        .into();
    let mut res = agent.get(MOONLIGHT_URL).call().map_err(|e| format!("No se pudo descargar Moonlight: {e}"))?;
    let total = res.body().content_length().unwrap_or(0);
    let mut reader = res.body_mut().with_config().limit(MOONLIGHT_MAX).reader();
    std::fs::create_dir_all(dir.parent().unwrap_or(&dir)).map_err(|e| e.to_string())?;
    let mut file = std::fs::File::create(&zip_path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let (mut done, mut last) = (0u64, 0u64);
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("La descarga de Moonlight se cortó: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if done - last >= 512 * 1024 {
            last = done;
            emit("download", done, total);
        }
    }
    drop(file);
    let sum: String = hasher.finalize().iter().map(|b| format!("{b:02x}")).collect();
    if sum != MOONLIGHT_SHA256 {
        let _ = std::fs::remove_file(&zip_path);
        return Err("Lo descargado no es el Moonlight esperado (la huella no coincide). No se ha instalado.".into());
    }

    emit("unpack", done, total);
    let _ = std::fs::remove_file(dir.join(MOONLIGHT_MARK));
    let unpacked = std::fs::File::open(&zip_path)
        .map_err(|e| e.to_string())
        .and_then(|f| zip::ZipArchive::new(f).map_err(|e| e.to_string()))
        .and_then(|mut archive| archive.extract(&dir).map_err(|e| e.to_string()));
    let _ = std::fs::remove_file(&zip_path);
    unpacked.map_err(|e| format!("No se pudo descomprimir Moonlight: {e}"))?;
    std::fs::write(dir.join(MOONLIGHT_MARK), MOONLIGHT_VERSION).map_err(|e| e.to_string())?;
    emit("done", done, total);
    log(&format!("Moonlight {MOONLIGHT_VERSION} instalado en {}", dir.display()));
    Ok(())
}

#[tauri::command]
pub async fn pc_install_moonlight(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    static INSTALLING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if INSTALLING.swap(true, std::sync::atomic::Ordering::AcqRel) {
        return Err("Moonlight ya se está instalando.".into());
    }
    let worker = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || install_moonlight(&worker)).await.map_err(|e| e.to_string());
    INSTALLING.store(false, std::sync::atomic::Ordering::Release);
    result?
}

fn box_name() -> String {
    format!("NOVA · {}", env::var("COMPUTERNAME").unwrap_or_else(|_| "TV".into()))
}

// ───────────────────────── The PC's games in NOVA ─────────────────────────

pub fn is_pc_id(id: &str) -> bool {
    id.starts_with(ID_PREFIX)
}

fn shortcut(pc: &PairedPc, game: &PcGame) -> Shortcut {
    Shortcut {
        id: format!("{ID_PREFIX}{}:{}", pc.id, game.id),
        name: game.name.clone(),
        description: Some(if game.store.is_empty() { format!("En {}", pc.name) } else { format!("En {} · {}", pc.name, game.store) }),
        kind: ShortcutKind::Game,
        target: Target::Pc { pc: pc.id.clone(), game: game.id.clone() },
        source: ShortcutSource::Pc,
    }
}

/// Every game of every PC ready to play (also while they sleep).
pub fn shortcuts(config: &Config) -> Vec<Shortcut> {
    config.pcs.iter().filter(|pc| pc.moonlight).flat_map(|pc| pc.games.iter().map(|g| shortcut(pc, g))).collect()
}

/// `shortcuts`, and a background check of the PCs' games.
pub fn games(app: &AppHandle) -> Vec<Shortcut> {
    refresh_games(app);
    shortcuts(&app.state::<AppState>().config.snapshot())
}

static REFRESHED: Mutex<Option<Instant>> = Mutex::new(None);

/// Asks the paired PCs for their games now and then, in the background.
fn refresh_games(app: &AppHandle) {
    {
        let Ok(mut last) = REFRESHED.lock() else { return };
        if last.is_some_and(|t| t.elapsed() < GAMES_EVERY) {
            return;
        }
        *last = Some(Instant::now());
    }
    let app = app.clone();
    thread::spawn(move || {
        let pcs = app.state::<AppState>().config.snapshot().pcs;
        let mut changed = false;
        for pc in pcs {
            let Ok(list) = get::<Vec<PcGame>>(&pc.host, "/games", Some(&pc.token), Duration::from_secs(20)) else { continue };
            if list != pc.games {
                changed |= app
                    .state::<AppState>()
                    .config
                    .update(|c| {
                        if let Some(p) = c.pcs.iter_mut().find(|p| p.id == pc.id) {
                            p.games = list;
                        }
                        Ok(())
                    })
                    .is_ok();
            }
        }
        if changed {
            let _ = app.emit("pcs-changed", ());
        }
    });
}

fn force_refresh(app: &AppHandle) {
    if let Ok(mut last) = REFRESHED.lock() {
        *last = None;
    }
    refresh_games(app);
}

/// Plays `game` from the PC `pc_id`: wakes it, starts the game there and opens Moonlight.
/// Each step goes to the loading screen as a `game-launch` stage of `shortcut`.
pub async fn play(app: &AppHandle, shortcut: &str, pc_id: &str, game: &str, name: &str) -> Result<(), String> {
    use crate::gamewatch::stage;
    let pc = app
        .state::<AppState>()
        .config
        .snapshot()
        .pcs
        .into_iter()
        .find(|p| p.id == pc_id)
        .ok_or("Ese PC ya no está emparejado.")?;
    let exe = moonlight(app).ok_or("Falta Moonlight en esta tele: instálalo desde Ajustes → Juegos desde tu PC.")?;
    if !pc.moonlight {
        return Err(format!("Moonlight aún no está emparejado con {}: hazlo en Ajustes → Juegos desde tu PC.", pc.name));
    }
    stage(app, shortcut, "connecting", Some(pc.name.clone()));
    let (wait_pc, wake_app, wake_id) = (pc.clone(), app.clone(), shortcut.to_string());
    let (info, host) = tauri::async_runtime::spawn_blocking(move || {
        reach(&wait_pc, WAKE, || stage(&wake_app, &wake_id, "waking", Some(wait_pc.name.clone())))
    })
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("{} no contesta. ¿Está encendido y con NovaBridge abierto?", pc.name))?;
    if !info.sunshine_running {
        return Err(format!("Sunshine no está en marcha en {}.", pc.name));
    }
    if host != pc.host {
        let (id, new_host) = (pc.id.clone(), host.clone());
        let _ = app.state::<AppState>().config.update(move |c| {
            if let Some(p) = c.pcs.iter_mut().find(|p| p.id == id) {
                p.host = new_host;
            }
            Ok(())
        });
    }
    stage(app, shortcut, "starting", Some(pc.name.clone()));
    let (launch_host, token, id) = (host.clone(), pc.token.clone(), game.to_string());
    tauri::async_runtime::spawn_blocking(move || {
        post::<serde_json::Value>(&launch_host, "/launch", Some(&token), &LaunchRequest { id }, Duration::from_secs(15))
    })
    .await
    .map_err(|e| e.to_string())??;
    log(&format!("{name} arrancado en {}; abro Moonlight", pc.name));
    // Games without controller support: NovaBridge types for the controller
    // (and stops by itself when the stream ends). Not essential: never blocks playing.
    let keyboard = pc.keyboard.iter().any(|g| g == game);
    let (input_host, token) = (host.clone(), pc.token.clone());
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = post::<serde_json::Value>(&input_host, "/input", Some(&token), &InputRequest { keyboard }, QUICK) {
            log(&format!("NovaBridge no pudo cambiar el mando: {e}"));
        }
    });

    crate::session::end_blocking(app).await;
    let child = Command::new(&exe)
        .args(["stream", &host, proto::DESKTOP_APP, "--display-mode", "borderless"])
        .spawn()
        .map_err(|e| format!("No se pudo abrir Moonlight: {e}"))?;
    crate::session::start(app, name, crate::session::Kind::Game(child));
    // Moonlight's window taking the screen is what ends the loading screen.
    stage(app, shortcut, "streaming", Some(pc.name.clone()));
    Ok(())
}

// ───────────────────────── Commands (Ajustes → Juegos desde tu PC) ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundPc {
    id: String,
    name: String,
    host: String,
    sunshine: bool,
    paired: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcView {
    id: String,
    name: String,
    host: String,
    moonlight: bool,
    games: usize,
    online: bool,
    sunshine: bool,
    sunshine_running: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcsView {
    /// Moonlight is installed on this box.
    moonlight: bool,
    /// The one NOVA installs.
    moonlight_version: &'static str,
    pcs: Vec<PcView>,
}

#[tauri::command]
pub async fn pc_list(app: AppHandle, state: State<'_, AppState>) -> Result<PcsView, String> {
    let pcs = state.config.snapshot().pcs;
    let checks: Vec<_> = pcs
        .into_iter()
        .map(|pc| thread::spawn(move || (get::<Info>(&pc.host, "/info", None, QUICK).ok().filter(|i| i.id == pc.id), pc)))
        .collect();
    let views = tauri::async_runtime::spawn_blocking(move || {
        checks
            .into_iter()
            .filter_map(|h| h.join().ok())
            .map(|(info, pc)| PcView {
                id: pc.id,
                name: pc.name,
                host: pc.host,
                moonlight: pc.moonlight,
                games: pc.games.len(),
                online: info.is_some(),
                sunshine: info.as_ref().is_some_and(|i| i.sunshine),
                sunshine_running: info.as_ref().is_some_and(|i| i.sunshine_running),
            })
            .collect()
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(PcsView { moonlight: moonlight(&app).is_some(), moonlight_version: MOONLIGHT_VERSION, pcs: views })
}

#[tauri::command]
pub async fn pc_discover(state: State<'_, AppState>) -> Result<Vec<FoundPc>, String> {
    let paired: Vec<String> = state.config.snapshot().pcs.into_iter().map(|p| p.id).collect();
    let found = tauri::async_runtime::spawn_blocking(|| discover(Duration::from_secs(2))).await.map_err(|e| e.to_string())?;
    Ok(found
        .into_iter()
        .map(|(info, host)| FoundPc { paired: paired.contains(&info.id), id: info.id, name: info.name, host, sunshine: info.sunshine })
        .collect())
}

/// Asks the PC at `host` to let this box in (the user answers on the PC).
#[tauri::command]
pub async fn pc_pair(host: String, app: AppHandle, state: State<'_, AppState>) -> Result<String, String> {
    crate::profiles::require_adult(&state)?;
    // Found by discovery or typed by the person: an address or a PC name, nothing else.
    let host = host.trim().to_string();
    if !valid_host(&host) {
        return Err("Escribe la IP del PC (por ejemplo 192.168.1.20) o su nombre.".into());
    }
    let ask_host = host.clone();
    let (info, PairReply { token }) = tauri::async_runtime::spawn_blocking(move || {
        let info = get::<Info>(&ask_host, "/info", None, QUICK)?;
        let reply = post::<PairReply>(&ask_host, "/pair", None, &PairRequest { name: box_name() }, ANSWER)?;
        Ok::<_, String>((info, reply))
    })
    .await
    .map_err(|e| e.to_string())??;
    let pc = PairedPc { id: info.id.clone(), name: info.name, host, macs: info.macs, token, ..Default::default() };
    state.config.update(move |c| {
        // Paired again: keeps Moonlight's pairing and the per-game choices.
        let (moonlight, keyboard) = c.pcs.iter().find(|p| p.id == pc.id).map(|p| (p.moonlight, p.keyboard.clone())).unwrap_or_default();
        c.pcs.retain(|p| p.id != pc.id);
        c.pcs.push(PairedPc { moonlight, keyboard, ..pc });
        Ok(())
    })?;
    log(&format!("emparejado con {}", info.id));
    force_refresh(&app);
    let _ = app.emit("pcs-changed", ());
    Ok(info.id)
}

/// Pairs Moonlight with the PC's Sunshine using `pin` (shown on the TV and on the PC).
#[tauri::command]
pub async fn pc_link_moonlight(id: String, pin: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    if !proto::valid_pin(&pin) {
        return Err("El PIN son 4 cifras.".into());
    }
    let pc = state.config.snapshot().pcs.into_iter().find(|p| p.id == id).ok_or("Ese PC ya no está emparejado.")?;
    let exe = moonlight(&app).ok_or("Falta Moonlight en esta tele: instálalo desde Ajustes → Juegos desde tu PC.")?;
    let ok = tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new(&exe).args(["pair", &pc.host, "--pin", &pin]).spawn().map_err(|e| format!("No se pudo abrir Moonlight: {e}"))?;
        // Moonlight first says hello to Sunshine; then the PC can take the PIN.
        thread::sleep(Duration::from_secs(1));
        if let Err(e) = post::<serde_json::Value>(&pc.host, "/moonlight-pin", Some(&pc.token), &PinRequest { pin }, QUICK * 4) {
            let _ = child.kill();
            return Err(e);
        }
        let deadline = Instant::now() + ANSWER;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return Ok(status.success()),
                Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(300)),
                _ => {
                    let _ = child.kill();
                    return Err("Se acabó el tiempo para escribir el PIN en el PC.".into());
                }
            }
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if !ok {
        return Err("Moonlight no pudo emparejarse. ¿Escribiste el PIN en Sunshine?".into());
    }
    state.config.update(|c| {
        if let Some(p) = c.pcs.iter_mut().find(|p| p.id == id) {
            p.moonlight = true;
        }
        Ok(())
    })?;
    force_refresh(&app);
    let _ = app.emit("pcs-changed", ());
    Ok(())
}

/// NOVA's ids (`pc:<pc>:<game>`) of the PC games played with the controller as keyboard and mouse.
#[tauri::command]
pub async fn pc_keyboard_games(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    Ok(state
        .config
        .snapshot()
        .pcs
        .iter()
        .flat_map(|pc| pc.keyboard.iter().map(move |g| format!("{ID_PREFIX}{}:{g}", pc.id)))
        .collect())
}

/// Turns "controller as keyboard and mouse" on or off for one of a PC's games.
#[tauri::command]
pub async fn pc_game_keyboard(id: String, on: bool, state: State<'_, AppState>) -> Result<(), String> {
    let (pc_id, game) = id
        .strip_prefix(ID_PREFIX)
        .and_then(|rest| rest.split_once(':'))
        .map(|(pc, game)| (pc.to_string(), game.to_string()))
        .ok_or("Ese juego no es de un PC.")?;
    state.config.update(move |c| {
        let pc = c.pcs.iter_mut().find(|p| p.id == pc_id).ok_or("Ese PC ya no está emparejado.")?;
        pc.keyboard.retain(|g| g != &game);
        if on {
            pc.keyboard.push(game);
        }
        Ok(())
    })
}

#[tauri::command]
pub async fn pc_forget(id: String, app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    state.config.update(|c| {
        c.pcs.retain(|p| p.id != id);
        Ok(())
    })?;
    let _ = app.emit("pcs-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pc_games_are_nova_games() {
        let pc = PairedPc { id: "ab12".into(), name: "TORRE".into(), ..Default::default() };
        let s = shortcut(&pc, &PcGame { id: "steam:730".into(), name: "Counter-Strike 2".into(), store: "Steam".into() });
        assert_eq!(s.id, "pc:ab12:steam:730");
        assert!(is_pc_id(&s.id));
        assert_eq!(s.description.as_deref(), Some("En TORRE · Steam"));
        assert!(matches!(s.target, Target::Pc { ref pc, ref game } if pc == "ab12" && game == "steam:730"));
    }

    #[test]
    fn typed_hosts() {
        assert!(valid_host("192.168.1.20"));
        assert!(valid_host("TORRE"));
        assert!(valid_host("torre.local"));
        assert!(!valid_host(""));
        assert!(!valid_host("192.168.1.20/x"));
        assert!(!valid_host("a b"));
        assert!(!valid_host("http://x"));
    }

    #[test]
    fn home_addresses_win() {
        assert!(home_rank("192.168.1.133") < home_rank("10.2.0.2"));
        assert!(home_rank("10.2.0.2") < home_rank("172.22.208.1"));
        assert!(home_rank("172.22.208.1") < home_rank("169.254.45.201"));
    }

    /// Downloads the real Moonlight (≈37 MB) into a temporary folder.
    #[test]
    #[ignore = "downloads Moonlight"]
    fn installs_portable_moonlight() {
        let dir = env::temp_dir().join("nova-moonlight-test").join("moonlight");
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
        install_moonlight_into(&dir, |stage, done, total| {
            if stage != "download" || done % (8 * 1024 * 1024) < 512 * 1024 {
                println!("{stage} {done}/{total}");
            }
        })
        .unwrap();
        assert!(dir.join("Moonlight.exe").is_file());
        assert!(dir.join("portable.dat").is_file());
        assert_eq!(std::fs::read_to_string(dir.join(MOONLIGHT_MARK)).unwrap(), MOONLIGHT_VERSION);
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    /// Needs NovaBridge running on this network.
    #[test]
    #[ignore = "needs NovaBridge on the network"]
    fn finds_novabridge() {
        let found = discover(Duration::from_secs(2));
        println!("{found:#?}");
        assert!(!found.is_empty());
    }
}
