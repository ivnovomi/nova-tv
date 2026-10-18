//! Network access for plugins: HTTPS only, only to the manifest's domains,
//! with a time and size cap. Redirects are never followed here: the plugin
//! gets the 3xx and its `location`, and following it is a new request that is
//! checked again (so a redirect can't lead anywhere the plugin may not go).

use super::manifest::Manifest;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::time::Duration;

pub const MAX_BODY: u64 = 5 * 1024 * 1024;
const MAX_TIMEOUT: u64 = 20;
/// Headers a plugin can't set (the HTTP client owns them).
const RESERVED: &[&str] = &["host", "content-length", "connection", "transfer-encoding", "upgrade", "te", "trailer", "proxy-authorization", "keep-alive"];

#[derive(Deserialize, Debug)]
pub struct Request {
    pub url: String,
    #[serde(default)]
    pub method: Option<String>,
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub timeout: Option<u64>,
}

#[derive(Serialize, Debug)]
pub struct Response {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

/// The URL's host if a plugin with this manifest may call it.
pub fn check_url(manifest: &Manifest, url: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| format!("Dirección no válida: {url}"))?;
    if parsed.scheme() != "https" {
        return Err(format!("Solo se permite HTTPS: {url}"));
    }
    if !parsed.username().is_empty() || parsed.password().is_some() || parsed.port().is_some_and(|p| p != 443) {
        return Err(format!("Dirección no permitida: {url}"));
    }
    let host = parsed.host_str().unwrap_or_default();
    if !manifest.allows_host(host) {
        return Err(format!("El plugin no tiene permiso para conectarse a {host} (añádelo a permissions.network)"));
    }
    Ok(parsed)
}

pub fn fetch(manifest: &Manifest, req: Request) -> Result<Response, String> {
    let url = check_url(manifest, &req.url)?;
    let timeout = req.timeout.unwrap_or(MAX_TIMEOUT).clamp(1, MAX_TIMEOUT);
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .max_redirects(0)
        .http_status_as_error(false)
        .https_only(true)
        .user_agent(format!("NOVA-TV-Plugin/{} ({})", super::manifest::API, manifest.id))
        .build()
        .into();

    let method = req.method.as_deref().unwrap_or("GET").to_ascii_uppercase();
    let headers: Vec<(String, String)> = req
        .headers
        .into_iter()
        .filter(|(k, v)| !RESERVED.contains(&k.to_ascii_lowercase().as_str()) && !v.contains(['\r', '\n']) && !k.contains(['\r', '\n', ':']))
        .collect();
    let body = req.body.unwrap_or_default();
    if body.len() as u64 > MAX_BODY {
        return Err("El cuerpo de la petición supera 5 MB".into());
    }

    macro_rules! with_headers {
        ($builder:expr) => {{
            let mut b = $builder;
            for (k, v) in &headers {
                b = b.header(k.as_str(), v.as_str());
            }
            b
        }};
    }
    let result = match method.as_str() {
        "GET" => with_headers!(agent.get(url.as_str())).call(),
        "HEAD" => with_headers!(agent.head(url.as_str())).call(),
        "DELETE" => with_headers!(agent.delete(url.as_str())).call(),
        "POST" => with_headers!(agent.post(url.as_str())).send(body.as_bytes()),
        "PUT" => with_headers!(agent.put(url.as_str())).send(body.as_bytes()),
        other => return Err(format!("Método HTTP no permitido: {other}")),
    };
    let mut res = result.map_err(|e| format!("{}: {e}", url.host_str().unwrap_or_default()))?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .filter_map(|(k, v)| Some((k.as_str().to_ascii_lowercase(), v.to_str().ok()?.to_string())))
        .collect();
    let body = if method == "HEAD" {
        String::new()
    } else {
        res.body_mut().with_config().limit(MAX_BODY).read_to_string().map_err(|e| format!("Respuesta no válida (o de más de 5 MB): {e}"))?
    };
    Ok(Response { status, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest() -> Manifest {
        serde_json::from_value(serde_json::json!({
            "id": "es.ejemplo.prueba", "name": "Prueba", "version": "1.0.0", "api": 1, "kind": ["provider"],
            "main": "dist/index.js", "description": "Un plugin de prueba.", "author": { "name": "Yo" },
            "audience": "everyone", "permissions": { "network": ["api.ejemplo.es"] }
        }))
        .unwrap()
    }

    #[test]
    fn only_allowed_https_urls() {
        let m = manifest();
        assert!(check_url(&m, "https://api.ejemplo.es/v1?x=1").is_ok());
        assert!(check_url(&m, "http://api.ejemplo.es/").is_err());
        assert!(check_url(&m, "https://otra.es/").is_err());
        assert!(check_url(&m, "https://user:pw@api.ejemplo.es/").is_err());
        assert!(check_url(&m, "https://api.ejemplo.es:8443/").is_err());
        assert!(check_url(&m, "https://api.ejemplo.es.evil.com/").is_err());
        assert!(check_url(&m, "https://127.0.0.1/").is_err());
        assert!(check_url(&m, "file:///C:/Windows").is_err());
    }
}
