//! Ajustes → Privacidad y datos → "Tu ciudad": where the user says they are,
//! for plugins with the `location` permission (the weather, local news…).
//! Never GPS or IP: only the city the user picks, and plugins get it rounded
//! to about 10 km.

use crate::config::Place;
use crate::profiles::require_adult;
use crate::AppState;
use tauri::State;

/// Open-Meteo's free geocoding (no key, no account).
const GEOCODE: &str = "https://geocoding-api.open-meteo.com/v1/search";

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            b' ' => "+".into(),
            _ => format!("%{b:02X}"),
        })
        .collect()
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
        let text = crate::net::agent()
            .get(&url)
            .call()
            .map_err(|e| format!("No se pudo buscar la ciudad: {e}"))?
            .body_mut()
            .with_config()
            .limit(512 * 1024)
            .read_to_string()
            .map_err(|e| e.to_string())?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
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
                })
            })
            .collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn location_get(state: State<'_, AppState>) -> Option<Place> {
    state.config.snapshot().location
}

/// Saves the city (or forgets it with `None`).
#[tauri::command]
pub fn location_set(place: Option<Place>, state: State<'_, AppState>) -> Result<(), String> {
    require_adult(&state)?;
    if let Some(p) = &place {
        let ok = !p.city.trim().is_empty() && p.city.chars().count() <= 100 && (-90.0..=90.0).contains(&p.latitude) && (-180.0..=180.0).contains(&p.longitude);
        if !ok {
            return Err("Ciudad no válida".into());
        }
    }
    state.config.update(|c| {
        c.location = place;
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
}
