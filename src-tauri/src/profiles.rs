//! Profiles and parental controls.
//!
//! Each profile keeps its own favourite channels, last channel and watch
//! history. A children's profile only sees kids' channels and the apps a parent
//! allowed, and can't open settings, search the web/PC or play arbitrary
//! YouTube. These rules are enforced here, in Rust, so neither the TV interface
//! nor the phone remote can get around them. Leaving a children's profile (or
//! unlocking settings from it for a few minutes) needs the parental PIN, which
//! is stored only as a salted, stretched hash and locks after repeated failures.

use crate::config::{new_id, now_secs, Config, Profile};
use crate::livetv::{Channel, Source};
use crate::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

const MAX_PROFILES: usize = 8;
/// Settings unlocked from a children's profile stay open this long.
const UNLOCK_SECS: u64 = 10 * 60;
const MAX_FAILS: u32 = 5;
const LOCKOUT_SECS: u64 = 60;
const HASH_ROUNDS: u32 = 50_000;

static UNLOCKED_UNTIL: AtomicU64 = AtomicU64::new(0);
/// (failed attempts, locked until)
static FAILS: Mutex<(u32, u64)> = Mutex::new((0, 0));

pub const BLOCKED: &str = "Bloqueado por el control parental. Pide a un adulto que introduzca el PIN.";
pub const KIDS_ONLY: &str = "No está disponible en un perfil infantil.";

fn main_profile(c: &Config) -> Profile {
    Profile {
        id: "principal".into(),
        name: "Principal".into(),
        avatar: "😎".into(),
        color: "#6e6cff".into(),
        kids: false,
        favorites: c.live_tv.favorites.clone(),
        last_channel: c.live_tv.last_channel.clone(),
        allowed: vec![],
        allow_anime: true,
        allow_world: false,
    }
}

/// First run with profiles: the existing favourites become the main profile's.
pub fn init(state: &AppState) {
    let c = state.config.snapshot();
    if !c.profiles.is_empty() && c.active_profile.as_ref().is_some_and(|id| c.profiles.iter().any(|p| &p.id == id)) {
        return;
    }
    let _ = state.config.update(|c| {
        if c.profiles.is_empty() {
            let main = main_profile(c);
            c.profiles.push(main);
        }
        if !c.active_profile.as_ref().is_some_and(|id| c.profiles.iter().any(|p| &p.id == id)) {
            c.active_profile = c.profiles.first().map(|p| p.id.clone());
        }
        Ok(())
    });
}

pub fn active(c: &Config) -> Profile {
    c.active_profile
        .as_ref()
        .and_then(|id| c.profiles.iter().find(|p| &p.id == id))
        .or(c.profiles.first())
        .cloned()
        .unwrap_or_else(|| main_profile(c))
}

pub fn active_mut(c: &mut Config) -> Option<&mut Profile> {
    let id = c.active_profile.clone().or_else(|| c.profiles.first().map(|p| p.id.clone()))?;
    c.profiles.iter_mut().find(|p| p.id == id)
}

/// The active profile, when it's a children's one.
pub fn kids(state: &AppState) -> Option<Profile> {
    Some(active(&state.config.snapshot())).filter(|p| p.kids)
}

fn unlocked() -> bool {
    now_secs() < UNLOCKED_UNTIL.load(Ordering::Acquire)
}

/// Settings and changes: adults, or a parent who unlocked them with the PIN.
pub fn require_adult(state: &AppState) -> Result<(), String> {
    if kids(state).is_some() && !unlocked() {
        return Err(BLOCKED.into());
    }
    Ok(())
}

/// Content a children's profile never gets (web search, any YouTube video, PC files…).
pub fn deny_kids(state: &AppState) -> Result<(), String> {
    match kids(state) {
        Some(_) => Err(KIDS_ONLY.into()),
        None => Ok(()),
    }
}

/// Kids see an allow-list: Spain's kids TDT channels, Pluto's kids (and
/// optionally anime) channels, and — only if a parent turns it on — worldwide
/// kids channels. Never the user's own playlists.
pub fn channel_allowed(p: &Profile, c: &Channel) -> bool {
    if !p.kids {
        return true;
    }
    match c.source {
        Source::Tdt => c.group == "Infantiles",
        Source::Fast => c.group == "Infantil" || (p.allow_anime && c.group == "Anime"),
        Source::World => p.allow_world && c.categories.iter().any(|k| k == "Infantil"),
        Source::Playlist => false,
        Source::Twitch => shortcut_allowed(p, "stream:twitch"),
    }
}

pub fn shortcut_allowed(p: &Profile, id: &str) -> bool {
    !p.kids || p.allowed.iter().any(|a| a == id)
}

/// Any YouTube video (resume, phone "send to TV"): only if a parent allowed YouTube itself.
pub fn require_youtube(state: &AppState) -> Result<(), String> {
    match kids(state) {
        Some(p) if !shortcut_allowed(&p, "stream:youtube") => Err(KIDS_ONLY.into()),
        _ => Ok(()),
    }
}

// ───────────────────────── PIN ─────────────────────────

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash(salt: &str, pin: &str) -> String {
    let mut digest = Sha256::new().chain_update(salt.as_bytes()).chain_update(b":").chain_update(pin.as_bytes()).finalize();
    for _ in 0..HASH_ROUNDS {
        digest = Sha256::new().chain_update(digest).chain_update(salt.as_bytes()).finalize();
    }
    hex(&digest)
}

fn valid_pin(pin: &str) -> bool {
    (4..=6).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
}

fn check_pin(c: &Config, pin: &str) -> Result<(), String> {
    let now = now_secs();
    let mut fails = FAILS.lock().map_err(|_| "Inténtalo de nuevo")?;
    if now < fails.1 {
        return Err(format!("Demasiados intentos. Espera {} s.", fails.1 - now));
    }
    let (Some(expected), Some(salt)) = (&c.parental.pin_hash, &c.parental.pin_salt) else {
        return Err("Aún no hay PIN parental.".into());
    };
    let actual = hash(salt, pin);
    // Constant-time comparison.
    let same = actual.len() == expected.len() && actual.bytes().zip(expected.bytes()).fold(0u8, |acc, (a, b)| acc | (a ^ b)) == 0;
    if same && valid_pin(pin) {
        *fails = (0, 0);
        return Ok(());
    }
    fails.0 += 1;
    if fails.0 >= MAX_FAILS {
        *fails = (0, now + LOCKOUT_SECS);
        return Err(format!("PIN incorrecto. Bloqueado {LOCKOUT_SECS} s."));
    }
    Err(format!("PIN incorrecto ({} de {MAX_FAILS} intentos)", fails.0))
}

// ───────────────────────── Commands ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfilesInfo {
    profiles: Vec<Profile>,
    active: String,
    has_pin: bool,
    /// Settings unlocked from a children's profile (until this Unix time).
    unlocked_until: Option<u64>,
}

fn info(state: &AppState) -> ProfilesInfo {
    let c = state.config.snapshot();
    let until = UNLOCKED_UNTIL.load(Ordering::Acquire);
    ProfilesInfo {
        active: active(&c).id,
        has_pin: c.parental.pin_hash.is_some(),
        unlocked_until: (until > now_secs()).then_some(until),
        profiles: c.profiles,
    }
}

#[tauri::command]
pub fn profiles_get(state: State<'_, AppState>) -> ProfilesInfo {
    info(&state)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    id: Option<String>,
    name: String,
    avatar: String,
    color: String,
    kids: bool,
    #[serde(default)]
    allowed: Vec<String>,
    #[serde(default = "yes")]
    allow_anime: bool,
    #[serde(default)]
    allow_world: bool,
}

fn yes() -> bool {
    true
}

#[tauri::command]
pub fn profile_save(input: ProfileInput, state: State<'_, AppState>, app: AppHandle) -> Result<ProfilesInfo, String> {
    require_adult(&state)?;
    let name: String = input.name.trim().chars().filter(|c| !c.is_control()).take(24).collect();
    if name.is_empty() {
        return Err("Ponle un nombre al perfil.".into());
    }
    let avatar: String = input.avatar.trim().chars().filter(|c| !c.is_control()).take(8).collect();
    if avatar.is_empty() {
        return Err("Elige un avatar.".into());
    }
    let color = input.color.trim().to_string();
    if !(color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())) {
        return Err("Color no válido.".into());
    }
    let allowed: Vec<String> = input.allowed.into_iter().filter(|a| a.len() <= 200 && !a.is_empty()).take(300).collect();
    let mut changed_active = false;
    state.config.update(|c| {
        if input.kids && c.parental.pin_hash.is_none() {
            return Err("Antes de crear un perfil infantil, crea el PIN parental.".into());
        }
        let current = active(c).id;
        match input.id.as_deref() {
            Some(id) => {
                let adults_left = c.profiles.iter().filter(|p| !p.kids && p.id != id).count();
                let p = c.profiles.iter_mut().find(|p| p.id == id).ok_or("Ese perfil ya no existe.")?;
                if input.kids && !p.kids && adults_left == 0 {
                    return Err("Tiene que quedar al menos un perfil de adulto.".into());
                }
                p.name = name;
                p.avatar = avatar;
                p.color = color;
                p.kids = input.kids;
                p.allowed = allowed;
                p.allow_anime = input.allow_anime;
                p.allow_world = input.allow_world;
                changed_active = p.id == current;
            }
            None => {
                if c.profiles.len() >= MAX_PROFILES {
                    return Err(format!("Máximo {MAX_PROFILES} perfiles."));
                }
                c.profiles.push(Profile {
                    id: new_id("profile"),
                    name,
                    avatar,
                    color,
                    kids: input.kids,
                    favorites: vec![],
                    last_channel: None,
                    allowed,
                    allow_anime: input.allow_anime,
                    allow_world: input.allow_world,
                });
            }
        }
        Ok(())
    })?;
    if changed_active {
        let _ = app.emit("profile-changed", ());
    }
    Ok(info(&state))
}

#[tauri::command]
pub fn profile_delete(id: String, state: State<'_, AppState>) -> Result<ProfilesInfo, String> {
    require_adult(&state)?;
    state.config.update(|c| {
        if active(c).id == id {
            return Err("No puedes borrar el perfil que está en uso. Cambia de perfil primero.".into());
        }
        if !c.profiles.iter().any(|p| !p.kids && p.id != id) {
            return Err("Tiene que quedar al menos un perfil de adulto.".into());
        }
        c.profiles.retain(|p| p.id != id);
        Ok(())
    })?;
    Ok(info(&state))
}

/// "¿Quién está viendo?" Leaving a children's profile needs the PIN.
#[tauri::command]
pub fn profile_switch(id: String, pin: Option<String>, state: State<'_, AppState>, app: AppHandle) -> Result<ProfilesInfo, String> {
    let c = state.config.snapshot();
    let target = c.profiles.iter().find(|p| p.id == id).ok_or("Ese perfil ya no existe.")?;
    let current = active(&c);
    if current.kids && !target.kids && c.parental.pin_hash.is_some() && !unlocked() {
        check_pin(&c, pin.as_deref().unwrap_or_default())?;
    }
    state.config.update(|c| {
        c.active_profile = Some(id.clone());
        Ok(())
    })?;
    UNLOCKED_UNTIL.store(0, Ordering::Release);
    let _ = app.emit("profile-changed", ());
    Ok(info(&state))
}

/// Creates or changes the parental PIN (the current one is needed to change it).
#[tauri::command]
pub fn parental_set_pin(current: Option<String>, pin: String, state: State<'_, AppState>) -> Result<ProfilesInfo, String> {
    if !valid_pin(&pin) {
        return Err("El PIN tiene que tener de 4 a 6 números.".into());
    }
    let c = state.config.snapshot();
    if c.parental.pin_hash.is_some() {
        check_pin(&c, current.as_deref().unwrap_or_default())?;
    } else {
        require_adult(&state)?;
    }
    let mut salt = [0u8; 16];
    getrandom::fill(&mut salt).map_err(|e| e.to_string())?;
    let salt = hex(&salt);
    let pin_hash = hash(&salt, &pin);
    state.config.update(|c| {
        c.parental.pin_salt = Some(salt);
        c.parental.pin_hash = Some(pin_hash);
        Ok(())
    })?;
    Ok(info(&state))
}

/// Removes the PIN (only when there are no children's profiles left).
#[tauri::command]
pub fn parental_remove_pin(current: String, state: State<'_, AppState>) -> Result<ProfilesInfo, String> {
    let c = state.config.snapshot();
    if c.profiles.iter().any(|p| p.kids) {
        return Err("Mientras haya perfiles infantiles, el PIN es obligatorio.".into());
    }
    check_pin(&c, &current)?;
    state.config.update(|c| {
        c.parental = Default::default();
        Ok(())
    })?;
    Ok(info(&state))
}

/// From a children's profile: a parent opens settings for a few minutes.
#[tauri::command]
pub fn parental_unlock(pin: String, state: State<'_, AppState>) -> Result<ProfilesInfo, String> {
    check_pin(&state.config.snapshot(), &pin)?;
    UNLOCKED_UNTIL.store(now_secs() + UNLOCK_SECS, Ordering::Release);
    Ok(info(&state))
}

#[tauri::command]
pub fn parental_lock(state: State<'_, AppState>) -> ProfilesInfo {
    UNLOCKED_UNTIL.store(0, Ordering::Release);
    info(&state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kid() -> Profile {
        Profile {
            id: "k".into(),
            name: "Peque".into(),
            avatar: "🦊".into(),
            color: "#ff8a3d".into(),
            kids: true,
            favorites: vec![],
            last_channel: None,
            allowed: vec!["stream:youtubekids".into()],
            allow_anime: false,
            allow_world: false,
        }
    }

    fn channel(source: Source, group: &str, categories: &[&str]) -> Channel {
        Channel {
            source,
            country: None,
            categories: categories.iter().map(|s| s.to_string()).collect(),
            id: "x".into(),
            number: 1,
            name: "x".into(),
            logo: None,
            group: group.into(),
            region: String::new(),
            streams: vec![],
            epg_id: None,
            geo: false,
        }
    }

    #[test]
    fn kids_allow_list() {
        let k = kid();
        assert!(channel_allowed(&k, &channel(Source::Tdt, "Infantiles", &[])));
        assert!(!channel_allowed(&k, &channel(Source::Tdt, "Generalistas", &[])));
        assert!(channel_allowed(&k, &channel(Source::Fast, "Infantil", &["Infantil"])));
        assert!(!channel_allowed(&k, &channel(Source::Fast, "Anime", &["Infantil"])), "anime off for this kid");
        assert!(!channel_allowed(&k, &channel(Source::Fast, "MTV en Pluto TV", &["Entretenimiento"])));
        assert!(!channel_allowed(&k, &channel(Source::World, "US", &["Infantil"])), "world kids off by default");
        assert!(!channel_allowed(&k, &channel(Source::Playlist, "Kids", &["Infantil"])));
        assert!(shortcut_allowed(&k, "stream:youtubekids"));
        assert!(!shortcut_allowed(&k, "stream:netflix"));
    }

    #[test]
    fn pin_hash_and_lockout() {
        let mut c = Config::default();
        c.parental.pin_salt = Some("abc".into());
        c.parental.pin_hash = Some(hash("abc", "2468"));
        assert!(check_pin(&c, "2468").is_ok());
        for _ in 0..MAX_FAILS - 1 {
            assert!(check_pin(&c, "0000").unwrap_err().contains("incorrecto"));
        }
        assert!(check_pin(&c, "0000").unwrap_err().contains("Bloqueado"));
        assert!(check_pin(&c, "2468").unwrap_err().contains("Espera"), "locked even with the right PIN");
        *FAILS.lock().unwrap() = (0, 0);
        assert_ne!(hash("abc", "2468"), hash("abd", "2468"), "salted");
    }
}
