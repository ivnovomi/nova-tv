//! NOVA's official plugin store.
//!
//! The catalogue (`store/catalog.json` in the nova-plugins repository) says
//! which plugins exist, how the store shows them (art, screenshots, colour,
//! collections) and where each package is, with its SHA-256 and the store's
//! signature. NOVA keeps the last good catalogue for offline use.
//!
//! Installing from the store: download (with progress) → SHA-256 → signature
//! of the NOVA team's store key → the package's manifest must be exactly the
//! catalogue's (id, version, permissions the user just approved) → the same
//! atomic install as a .novapkg → the download is deleted.

use super::manifest::{valid_id, Audience, Manifest, Permissions};
use super::registry::{install_package, installed_versions, record_install};
use crate::profiles::require_adult;
use crate::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

const CATALOG_URL: &str = "https://raw.githubusercontent.com/ivnovomi/nova-plugins/main/store/catalog.json";
const CATALOG_TTL: u64 = 6 * 3600;
const MAX_CATALOG: u64 = 4 * 1024 * 1024;

/// The store's public key (as `tauri signer generate` prints it: base64 of the
/// minisign .pub file). Different from the updater's, and its private half is
/// kept in the team's credentials. With None the store would only install in
/// developer mode, without a signature check.
const STORE_PUBLIC_KEY: Option<&str> = Some(
    "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERFNzZBQUNFMEU3RUQzRTYKUldUbTAzNE96cXAyM3ZIMXlIaFRKcWxjVlExK1lWWkVGSnZKQ3lzRGJZVEI2UkFiZFZvYVFMMCsK",
);

// ───────────────────────── The catalogue ─────────────────────────

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Catalog {
    pub version: u32,
    pub updated_at: u64,
    /// The plugins in the big carousel at the top, in order.
    pub featured: Vec<String>,
    pub collections: Vec<Collection>,
    #[serde(deserialize_with = "lenient")]
    pub plugins: Vec<Entry>,
}

/// One broken entry in the catalogue doesn't take the whole store down: it's skipped.
fn lenient<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<Entry>, D::Error> {
    let raw = Vec::<serde_json::Value>::deserialize(d)?;
    Ok(raw.into_iter().filter_map(|v| serde_json::from_value(v).ok()).collect())
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Collection {
    pub id: String,
    pub title: String,
    pub subtitle: Option<String>,
    /// "cards", "wide", "ranked" (big numbers) or "editorial" (one big banner).
    pub style: String,
    pub ids: Vec<String>,
    pub accent: Option<String>,
    pub image: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub tagline: String,
    #[serde(default)]
    pub description: String,
    pub author: Author,
    #[serde(default)]
    pub category: String,
    pub audience: Audience,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub banner: Option<String>,
    /// "#rrggbb": the store paints the plugin's pages with it.
    #[serde(default)]
    pub accent: Option<String>,
    #[serde(default)]
    pub screenshots: Vec<Screenshot>,
    pub permissions: Permissions,
    #[serde(default)]
    pub changelog: Vec<Change>,
    #[serde(default)]
    pub languages: Vec<String>,
    #[serde(default)]
    pub updated_at: u64,
    /// When the NOVA team reviewed this version.
    #[serde(default)]
    pub reviewed_at: u64,
    #[serde(default)]
    pub tags: Vec<String>,
    pub package: Package,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Author {
    pub name: String,
    /// The NOVA team itself, or a developer it knows.
    #[serde(default)]
    pub verified: bool,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Screenshot {
    pub url: String,
    #[serde(default)]
    pub caption: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Change {
    pub version: String,
    #[serde(default)]
    pub date: u64,
    #[serde(default)]
    pub notes: Vec<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct Package {
    pub url: String,
    pub sha256: String,
    /// The store's signature (the .sig `tauri signer sign` writes: base64 of a minisign signature).
    #[serde(default)]
    pub signature: Option<String>,
    pub size: u64,
}

fn https(url: &Option<String>) -> Option<String> {
    url.as_ref().filter(|u| u.starts_with("https://") && !u.contains(char::is_whitespace) && u.len() <= 2048).cloned()
}

fn clip(s: &str, max: usize) -> String {
    s.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect()
}

fn color(c: &Option<String>) -> Option<String> {
    c.as_ref().filter(|c| c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())).cloned()
}

/// Only what the store can show safely: valid ids, https images, sane sizes.
fn clean(mut catalog: Catalog) -> Catalog {
    catalog.plugins.retain(|e| {
        valid_id(&e.id)
            && !e.name.trim().is_empty()
            && e.package.url.starts_with("https://")
            && e.package.sha256.len() == 64
            && e.package.sha256.chars().all(|c| c.is_ascii_hexdigit())
            && e.package.size <= super::package::MAX_PACKAGE
    });
    catalog.plugins.truncate(500);
    for e in &mut catalog.plugins {
        e.name = clip(&e.name, 40);
        e.tagline = clip(&e.tagline, 120);
        e.description = clip(&e.description, 4000);
        e.category = clip(&e.category, 30);
        e.author.name = clip(&e.author.name, 60);
        e.author.url = https(&e.author.url);
        e.icon = https(&e.icon);
        e.banner = https(&e.banner);
        e.accent = color(&e.accent);
        e.screenshots.retain(|s| https(&Some(s.url.clone())).is_some());
        e.screenshots.truncate(10);
        for s in &mut e.screenshots {
            s.caption = s.caption.as_deref().map(|c| clip(c, 120));
        }
        e.changelog.truncate(10);
        for ch in &mut e.changelog {
            ch.notes.truncate(20);
            ch.notes = ch.notes.iter().map(|n| clip(n, 300)).collect();
        }
        e.tags.truncate(10);
        e.languages.truncate(10);
    }
    let known: std::collections::HashSet<String> = catalog.plugins.iter().map(|e| e.id.clone()).collect();
    catalog.featured.retain(|id| known.contains(id));
    catalog.featured.truncate(8);
    catalog.collections.retain(|c| !c.title.trim().is_empty());
    catalog.collections.truncate(20);
    for c in &mut catalog.collections {
        c.ids.retain(|id| known.contains(id));
        c.title = clip(&c.title, 60);
        c.subtitle = c.subtitle.as_deref().map(|s| clip(s, 160));
        c.accent = color(&c.accent);
        c.image = https(&c.image);
    }
    catalog.collections.retain(|c| !c.ids.is_empty());
    catalog
}

fn store_dir(app: &AppHandle) -> PathBuf {
    app.path().app_local_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("nova-tv")).join("store")
}

#[derive(Serialize, Deserialize)]
struct Cached {
    fetched_at: u64,
    catalog: Catalog,
}

fn read_cache(app: &AppHandle) -> Option<Cached> {
    let text = std::fs::read_to_string(store_dir(app).join("catalog.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn agent(timeout: u64) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_global(Some(Duration::from_secs(timeout)))
        .https_only(true)
        .user_agent(concat!("NOVA-TV/", env!("CARGO_PKG_VERSION"), " (store)"))
        .build()
        .into()
}

fn fetch_catalog() -> Result<Catalog, String> {
    let mut res = agent(15).get(CATALOG_URL).call().map_err(|e| format!("No se pudo abrir la tienda: {e}"))?;
    let text = res.body_mut().with_config().limit(MAX_CATALOG).read_to_string().map_err(|e| format!("Catálogo no válido: {e}"))?;
    let catalog: Catalog = serde_json::from_str(&text).map_err(|e| format!("Catálogo no válido: {e}"))?;
    Ok(clean(catalog))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInfo {
    catalog: Option<Catalog>,
    /// Plugin id → installed version.
    installed: HashMap<String, String>,
    /// Couldn't refresh (the catalogue shown is the saved one, or none).
    error: Option<String>,
    /// When the catalogue shown was downloaded.
    fetched_at: Option<u64>,
    /// The store checks signatures (its key is set). Otherwise only developer mode installs.
    signed: bool,
    developer_mode: bool,
}

/// The catalogue (saved one if it's recent, unless `refresh`), and what's installed.
#[tauri::command]
pub async fn store_catalog(refresh: bool, app: AppHandle) -> StoreInfo {
    tauri::async_runtime::spawn_blocking(move || {
        let cached = read_cache(&app);
        let now = crate::config::now_secs();
        let fresh = cached.as_ref().is_some_and(|c| now.saturating_sub(c.fetched_at) < CATALOG_TTL);
        let (catalog, fetched_at, error) = if fresh && !refresh {
            let c = cached.expect("checked");
            (Some(c.catalog), Some(c.fetched_at), None)
        } else {
            match fetch_catalog() {
                Ok(catalog) => {
                    let dir = store_dir(&app);
                    let _ = std::fs::create_dir_all(&dir);
                    let _ = crate::config::write_atomic(&dir.join("catalog.json"), &serde_json::to_string(&Cached { fetched_at: now, catalog: catalog.clone() }).unwrap_or_default());
                    (Some(catalog), Some(now), None)
                }
                Err(e) => match cached {
                    Some(c) => (Some(c.catalog), Some(c.fetched_at), Some(e)),
                    None => (None, None, Some(e)),
                },
            }
        };
        StoreInfo {
            catalog,
            installed: installed_versions(&app),
            error,
            fetched_at,
            signed: STORE_PUBLIC_KEY.is_some(),
            developer_mode: app.state::<AppState>().config.snapshot().plugins.developer_mode,
        }
    })
    .await
    .unwrap_or(StoreInfo { catalog: None, installed: HashMap::new(), error: Some("La tienda no respondió".into()), fetched_at: None, signed: false, developer_mode: false })
}

// ───────────────────────── Installing ─────────────────────────

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress<'a> {
    id: &'a str,
    /// "download", "verify", "install", "done".
    phase: &'a str,
    done: u64,
    total: u64,
}

fn progress(app: &AppHandle, id: &str, phase: &str, done: u64, total: u64) {
    let _ = app.emit("store-progress", Progress { id, phase, done, total });
}

/// The store's signature over the package, with the store's key.
fn verify_signature(signature: &str, data: &[u8]) -> Result<(), String> {
    use base64::Engine;
    let key = STORE_PUBLIC_KEY.ok_or("La tienda no tiene clave de firma")?;
    let text = |b64: &str| base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok().and_then(|b| String::from_utf8(b).ok());
    let public = minisign_verify::PublicKey::decode(&text(key).ok_or("Clave de la tienda no válida")?).map_err(|_| "Clave de la tienda no válida")?;
    let signature = minisign_verify::Signature::decode(&text(signature).ok_or("Firma no válida")?).map_err(|_| "Firma no válida")?;
    public.verify(data, &signature, false).map_err(|_| "La firma del paquete no es de la tienda de NOVA: no se instala".to_string())
}

/// Downloads `url` (at most `size` bytes), reporting progress; returns the bytes.
fn download(app: &AppHandle, id: &str, url: &str, size: u64) -> Result<Vec<u8>, String> {
    let mut res = agent(300).get(url).call().map_err(|e| format!("No se pudo descargar: {e}"))?;
    let total = res.headers().get("content-length").and_then(|v| v.to_str().ok()?.parse().ok()).unwrap_or(size).max(1);
    let limit = size.min(super::package::MAX_PACKAGE);
    let mut reader = res.body_mut().with_config().limit(limit + 1).reader();
    let mut data = Vec::with_capacity(size as usize);
    let mut buf = [0u8; 64 * 1024];
    let mut last = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| format!("Descarga interrumpida: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&buf[..n]);
        if data.len() as u64 > limit {
            return Err("El paquete es más grande de lo que dice la tienda: no se instala".into());
        }
        // Every 2 %, not every chunk.
        if data.len() as u64 - last > total / 50 {
            last = data.len() as u64;
            progress(app, id, "download", last, total);
        }
    }
    progress(app, id, "download", data.len() as u64, total);
    Ok(data)
}

/// Installs (or updates) a plugin from the store. The user approved its
/// permissions on the screen just before; they must be exactly the package's.
#[tauri::command]
pub async fn store_install(id: String, app: AppHandle) -> Result<(), String> {
    require_adult(&app.state::<AppState>())?;
    let handle = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let app = handle;
        let entry = read_cache(&app)
            .and_then(|c| c.catalog.plugins.into_iter().find(|e| e.id == id))
            .ok_or("Ese plugin ya no está en la tienda")?;
        let developer = app.state::<AppState>().config.snapshot().plugins.developer_mode;
        if STORE_PUBLIC_KEY.is_none() && !developer {
            return Err("La tienda aún no firma sus paquetes: de momento solo instala con el modo desarrollador (Ajustes → Plugins)".to_string());
        }

        progress(&app, &id, "download", 0, entry.package.size.max(1));
        let data = download(&app, &id, &entry.package.url, entry.package.size)?;

        progress(&app, &id, "verify", 0, 1);
        let sum: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
        if !sum.eq_ignore_ascii_case(&entry.package.sha256) {
            return Err("El paquete descargado no es el de la tienda (no coincide su huella): no se instala".into());
        }
        if STORE_PUBLIC_KEY.is_some() {
            verify_signature(entry.package.signature.as_deref().ok_or("El paquete no está firmado por la tienda")?, &data)?;
        }

        // On disk only while installing.
        let dir = store_dir(&app).join("downloads");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join(format!("{id}.novapkg"));
        std::fs::write(&file, &data).map_err(|e| e.to_string())?;
        let result = (|| {
            let manifest: Manifest = super::package::inspect(&file)?.manifest;
            if manifest.id != entry.id || manifest.version != entry.version {
                return Err("El paquete no es el que anuncia la tienda".to_string());
            }
            if serde_json::to_value(&manifest.permissions).ok() != serde_json::to_value(&entry.permissions).ok() {
                return Err("El paquete pide permisos distintos de los que has aprobado: no se instala".to_string());
            }
            progress(&app, &id, "install", 0, 1);
            install_package(&app, &id, &file)?;
            record_install(&app, &manifest)
        })();
        let _ = std::fs::remove_file(&file);
        let _ = std::fs::remove_dir(&dir);
        result?;
        progress(&app, &id, "done", 1, 1);
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A download left by a crash or a power cut: removed at start.
pub fn clean_downloads(app: &AppHandle) {
    let _ = std::fs::remove_dir_all(store_dir(app).join("downloads"));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: &str) -> serde_json::Value {
        serde_json::json!({
            "id": id, "name": "Plugin", "version": "1.0.0", "author": { "name": "Yo" }, "audience": "everyone",
            "icon": "http://inseguro/icon.png", "banner": "https://img.es/b.jpg", "accent": "rojo",
            "screenshots": [{ "url": "https://img.es/1.jpg" }, { "url": "file:///C:/x.png" }],
            "permissions": { "channels": true },
            "package": { "url": "https://github.com/x.novapkg", "sha256": "a".repeat(64), "size": 1000 }
        })
    }

    #[test]
    fn the_store_key_is_valid_and_bad_signatures_fail() {
        use base64::Engine;
        let text = String::from_utf8(base64::engine::general_purpose::STANDARD.decode(STORE_PUBLIC_KEY.unwrap()).unwrap()).unwrap();
        assert!(minisign_verify::PublicKey::decode(&text).is_ok());
        assert!(verify_signature("no es una firma", b"paquete").is_err());
    }

    /// A package signed for the store (`npx tauri signer sign`), before publishing it:
    /// NOVA_STORE_PACKAGE=<path to .novapkg> cargo test --lib signed_package -- --ignored
    #[test]
    #[ignore = "needs a signed package"]
    fn signed_package_is_accepted() {
        let path = std::path::PathBuf::from(std::env::var("NOVA_STORE_PACKAGE").expect("NOVA_STORE_PACKAGE"));
        let data = std::fs::read(&path).unwrap();
        let signature = std::fs::read_to_string(path.with_extension("novapkg.sig")).unwrap();
        verify_signature(&signature, &data).expect("signed with the store key");
        let mut tampered = data.clone();
        tampered[100] ^= 1;
        assert!(verify_signature(&signature, &tampered).is_err(), "a changed byte breaks it");
        println!("sha256 {}", Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect::<String>());
    }

    /// The published store, as a TV sees it: every plugin downloads, matches its
    /// SHA-256, carries the store's signature and is the package it announces.
    #[test]
    #[ignore = "needs internet"]
    fn the_published_store_installs() {
        let catalog = fetch_catalog().unwrap();
        assert!(!catalog.plugins.is_empty());
        for entry in &catalog.plugins {
            let mut res = agent(60).get(&entry.package.url).call().unwrap();
            let data = res.body_mut().with_config().limit(entry.package.size + 1).read_to_vec().unwrap();
            let sum: String = Sha256::digest(&data).iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(sum, entry.package.sha256, "{}", entry.id);
            verify_signature(entry.package.signature.as_deref().unwrap(), &data).unwrap();
            let file = std::env::temp_dir().join(format!("nova-store-check-{}.novapkg", std::process::id()));
            std::fs::write(&file, &data).unwrap();
            let manifest = super::super::package::inspect(&file).unwrap().manifest;
            let _ = std::fs::remove_file(&file);
            assert_eq!((manifest.id.as_str(), manifest.version.as_str()), (entry.id.as_str(), entry.version.as_str()));
            assert_eq!(serde_json::to_value(&manifest.permissions).unwrap(), serde_json::to_value(&entry.permissions).unwrap());
            println!("✓ {} {} ({} bytes)", entry.name, entry.version, data.len());
        }
    }

    #[test]
    fn the_catalogue_is_cleaned() {
        let raw = serde_json::json!({
            "version": 1,
            "featured": ["es.yo.uno", "es.yo.no-existe"],
            "collections": [{ "id": "c", "title": "Colección", "style": "cards", "ids": ["es.yo.uno", "x"] }, { "title": "Vacía", "ids": ["x"] }],
            "plugins": [entry("es.yo.uno"), entry("malo"), { "id": "es.yo.roto" }],
            "algoNuevo": true
        });
        // Unknown fields and broken entries don't sink the whole catalogue.
        let catalog = clean(serde_json::from_value::<Catalog>(raw).unwrap());
        assert_eq!(catalog.plugins.len(), 1);
        let e = &catalog.plugins[0];
        assert_eq!(e.icon, None, "http images are dropped");
        assert_eq!(e.accent, None);
        assert_eq!(e.screenshots.len(), 1);
        assert_eq!(catalog.featured, ["es.yo.uno"]);
        assert_eq!(catalog.collections.len(), 1);
        assert_eq!(catalog.collections[0].ids, ["es.yo.uno"]);
    }
}
