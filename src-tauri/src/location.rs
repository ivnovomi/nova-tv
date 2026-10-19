//! Where NOVA is, for plugins with the `location` permission (the weather,
//! local news, a channel lineup by region…) and for autoconfiguring them.
//!
//! Two ways, in Ajustes → Privacidad y datos → "Tu ubicación":
//! - the city the user picks (always wins);
//! - while they haven't picked one, the approximate place of the connection
//!   (city, region, country, time zone), asked once at start and then once a
//!   week to an IP geolocation service. It can be turned off; turning it off
//!   forgets what was detected.
//!
//! Plugins get coordinates rounded to about 10 km, never GPS.

use crate::config::{now_secs, Place, PlaceSource};
use crate::profiles::require_adult;
use crate::AppState;
use serde::Serialize;
use tauri::{AppHandle, Manager, State};

/// Open-Meteo's free geocoding (no key, no account).
const GEOCODE: &str = "https://geocoding-api.open-meteo.com/v1/search";
/// IP geolocation, free and without a key; the second one if the first fails.
const IPWHO: &str = "https://ipwho.is/?lang=es&fields=success,city,region,country,country_code,latitude,longitude,timezone";
const IPAPI: &str = "https://ipapi.co/json/";
/// A detected place is checked again after a week (the Box may have moved).
const REDETECT: u64 = 7 * 24 * 3600;

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn get_json(url: &str) -> Result<serde_json::Value, String> {
    let text = crate::net::agent()
        .get(url)
        .header("User-Agent", concat!("NOVA-TV/", env!("CARGO_PKG_VERSION")))
        .call()
        .map_err(|e| e.to_string())?
        .body_mut()
        .with_config()
        .limit(512 * 1024)
        .read_to_string()
        .map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// Places matching what the user typed ("Sevilla" → Sevilla, Andalucía, España…).
#[tauri::command]
pub async fn location_search(query: String) -> Result<Vec<Place>, String> {
    let query: String = query.trim().chars().filter(|c| !c.is_control()).take(80).collect();
    if query.chars().count() < 2 {
        return Ok(vec![]);
    }
    tauri::async_runtime::spawn_blocking(move || {
        let url = format!("{GEOCODE}?name={}&count=8&language=es&format=json", encode(&query));
        let json = get_json(&url).map_err(|e| format!("No se pudo buscar la ciudad: {e}"))?;
        Ok(json["results"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|r| {
                Some(Place {
                    city: r["name"].as_str()?.to_string(),
                    country: r["country"].as_str().unwrap_or_default().to_string(),
                    region: r["admin1"].as_str().map(String::from),
                    latitude: r["latitude"].as_f64()?,
                    longitude: r["longitude"].as_f64()?,
                    country_code: r["country_code"].as_str().map(|c| c.to_uppercase()),
                    timezone: r["timezone"].as_str().map(String::from),
                    source: PlaceSource::User,
                    detected_at: None,
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ───────────────────────── Detection ─────────────────────────

fn text(v: &serde_json::Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty() && s.len() <= 100).map(String::from)
}

/// ipwho.is: `{ success, city, region, country, country_code, latitude, longitude, timezone: { id } }`.
fn from_ipwho(j: &serde_json::Value) -> Option<Place> {
    if j["success"].as_bool() != Some(true) {
        return None;
    }
    place(text(&j["city"])?, text(&j["country"])?, text(&j["region"]), j["latitude"].as_f64()?, j["longitude"].as_f64()?, text(&j["country_code"]), text(&j["timezone"]["id"]))
}

/// ipapi.co: `{ city, region, country_name, country_code, latitude, longitude, timezone }`.
fn from_ipapi(j: &serde_json::Value) -> Option<Place> {
    if j["error"].as_bool() == Some(true) {
        return None;
    }
    place(text(&j["city"])?, text(&j["country_name"])?, text(&j["region"]), j["latitude"].as_f64()?, j["longitude"].as_f64()?, text(&j["country_code"]), text(&j["timezone"]))
}

fn place(city: String, country: String, region: Option<String>, lat: f64, lon: f64, code: Option<String>, tz: Option<String>) -> Option<Place> {
    let valid = (-90.0..=90.0).contains(&lat) && (-180.0..=180.0).contains(&lon);
    valid.then(|| Place {
        city,
        country,
        region,
        latitude: lat,
        longitude: lon,
        country_code: code.filter(|c| c.len() == 2 && c.chars().all(|x| x.is_ascii_alphabetic())).map(|c| c.to_uppercase()),
        timezone: tz.filter(|t| t.len() <= 60),
        source: PlaceSource::Auto,
        detected_at: Some(now_secs()),
    })
}

/// The approximate place of this connection (asked to an IP geolocation service).
pub fn detect() -> Result<Place, String> {
    let first = get_json(IPWHO).map(|j| from_ipwho(&j));
    if let Ok(Some(p)) = first {
        return Ok(p);
    }
    match get_json(IPAPI).map(|j| from_ipapi(&j)) {
        Ok(Some(p)) => Ok(p),
        Ok(None) => Err("No se pudo saber dónde está esta conexión".into()),
        Err(e) => Err(format!("No se pudo detectar la ubicación: {e}")),
    }
}

/// Saves a detected place, unless the user chose one meanwhile or turned detection off.
fn save_detected(state: &AppState, place: Place) -> Result<Option<Place>, String> {
    state.config.update(|c| {
        if c.location_detect_disabled || c.location.as_ref().is_some_and(|p| p.source == PlaceSource::User) {
            return Ok(None);
        }
        c.location = Some(place.clone());
        Ok(Some(place))
    })
}

/// At start (after a short wait) and then daily: detects the place if the user
/// hasn't chosen one, detection is on, and the last detection is a week old.
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(20));
        loop {
            let config = app.state::<AppState>().config.snapshot();
            let due = match &config.location {
                _ if config.location_detect_disabled => false,
                Some(p) if p.source == PlaceSource::User => false,
                Some(p) => now_secs().saturating_sub(p.detected_at.unwrap_or(0)) > REDETECT,
                None => true,
            };
            if due {
                match detect() {
                    Ok(place) => {
                        let _ = save_detected(&app.state::<AppState>(), place);
                    }
                    Err(e) => eprintln!("NOVA TV: {e}"),
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
        }
    });
}

// ───────────────────────── Ajustes ─────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocationInfo {
    place: Option<Place>,
    /// Detection from the connection is on.
    detect: bool,
}

#[tauri::command]
pub fn location_get(state: State<'_, AppState>) -> LocationInfo {
    let c = state.config.snapshot();
    LocationInfo { place: c.location, detect: !c.location_detect_disabled }
}

/// Saves the city the user picked (or forgets it with `None`: then, with
/// detection on, the connection's place is used again).
#[tauri::command]
pub fn location_set(place: Option<Place>, state: State<'_, AppState>) -> Result<(), String> {
    require_adult(&state)?;
    let place = match place {
        Some(mut p) => {
            let ok = !p.city.trim().is_empty() && p.city.chars().count() <= 100 && (-90.0..=90.0).contains(&p.latitude) && (-180.0..=180.0).contains(&p.longitude);
            if !ok {
                return Err("Ciudad no válida".into());
            }
            p.source = PlaceSource::User;
            p.detected_at = None;
            Some(p)
        }
        None => None,
    };
    state.config.update(|c| {
        c.location = place;
        Ok(())
    })
}

/// "Detectar ahora": the connection's place, replacing whatever was there.
#[tauri::command]
pub async fn location_detect(app: AppHandle) -> Result<Place, String> {
    require_adult(&app.state::<AppState>())?;
    let place = tauri::async_runtime::spawn_blocking(detect).await.map_err(|e| e.to_string())??;
    app.state::<AppState>().config.update(|c| {
        c.location_detect_disabled = false;
        c.location = Some(place.clone());
        Ok(())
    })?;
    Ok(place)
}

/// Turns detection on or off. Off forgets a detected place (a chosen city stays).
#[tauri::command]
pub fn location_set_detect(enabled: bool, state: State<'_, AppState>) -> Result<(), String> {
    require_adult(&state)?;
    state.config.update(|c| {
        c.location_detect_disabled = !enabled;
        if !enabled && c.location.as_ref().is_some_and(|p| p.source == PlaceSource::Auto) {
            c.location = None;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_queries() {
        assert_eq!(encode("San Sebastián"), "San+Sebasti%C3%A1n");
    }

    #[test]
    fn reads_both_services() {
        let who = serde_json::json!({ "success": true, "country": "España", "country_code": "ES", "region": "Comunidad de Madrid", "city": "Madrid",
            "latitude": 40.41, "longitude": -3.70, "timezone": { "id": "Europe/Madrid" } });
        let p = from_ipwho(&who).unwrap();
        assert_eq!((p.city.as_str(), p.country_code.as_deref(), p.timezone.as_deref(), p.source), ("Madrid", Some("ES"), Some("Europe/Madrid"), PlaceSource::Auto));
        assert!(from_ipwho(&serde_json::json!({ "success": false })).is_none());
        let api = serde_json::json!({ "city": "Bilbao", "region": "Basque Country", "country_name": "Spain", "country_code": "es", "latitude": 43.26, "longitude": -2.93, "timezone": "Europe/Madrid" });
        assert_eq!(from_ipapi(&api).unwrap().country_code.as_deref(), Some("ES"));
        assert!(from_ipapi(&serde_json::json!({ "error": true, "reason": "RateLimited" })).is_none());
        assert!(from_ipapi(&serde_json::json!({ "city": "X", "country_name": "Y", "latitude": 200.0, "longitude": 0.0 })).is_none());
    }

    #[test]
    #[ignore = "needs internet"]
    fn detects_this_connection() {
        let p = detect().unwrap();
        println!("{} · {:?} · {} ({:?}) · {:?}", p.city, p.region, p.country, p.country_code, p.timezone);
    }
}
