//! `.novapkg`: how a plugin is distributed and installed.
//!
//! A `.novapkg` is a ZIP with its own extension. At its root, the manifest
//! (`nova-plugin.json`), then whatever the plugin needs: its code (`main`),
//! its app (`app`), icon, assets, LICENSE. It never carries any part of NOVA.
//!
//! Installing is careful and all-or-nothing:
//! 1. inspect: every entry's path and size is checked and the manifest is
//!    validated before anything is written (no `../`, no absolute paths, no
//!    links, limits against ZIP bombs);
//! 2. extract into a staging folder, checking the real sizes as it goes;
//! 3. move it into place as `<plugins>/<id>/<version>/` and only then point
//!    `<plugins>/<id>/current` at it. A failure at any step leaves the
//!    installed version exactly as it was.
//!
//! The previous version is kept (one) so a bad update can be rolled back.
//! Data lives elsewhere (`<data>/<id>/`) and survives updates.
//!
//! Signatures (store and developer keys) come with the store; they'll be
//! checked in `inspect` before anything else.

use super::manifest::{Kind, Manifest};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

/// The package file itself.
pub const MAX_PACKAGE: u64 = 50 * 1024 * 1024;
/// Everything once unpacked.
pub const MAX_UNPACKED: u64 = 200 * 1024 * 1024;
pub const MAX_FILE: u64 = 50 * 1024 * 1024;
pub const MAX_FILES: usize = 2000;
/// A file that grows more than this when unpacked is treated as a ZIP bomb.
pub const MAX_RATIO: u64 = 200;
const MANIFEST: &str = "nova-plugin.json";
const MAX_MANIFEST: u64 = 64 * 1024;
const MAX_PATH: usize = 240;

/// A package that passed inspection: what it is and what it contains.
#[derive(Debug)]
pub struct Inspected {
    pub manifest: Manifest,
    /// (index in the ZIP, path inside the package, size).
    files: Vec<(usize, String, u64)>,
    pub unpacked: u64,
}

#[derive(Debug, PartialEq)]
pub struct Installed {
    pub id: String,
    pub version: String,
    pub dir: PathBuf,
    /// The version that was current before, if any (kept for rollback).
    pub previous: Option<String>,
}

/// A path inside a package: relative, forward slashes, no `.`/`..`, no drive
/// letters or odd characters. Returns it normalised.
fn safe_path(name: &str) -> Result<String, String> {
    let bad = || Err(format!("Ruta no permitida en el paquete: «{name}»"));
    if name.is_empty() || name.len() > MAX_PATH || name.starts_with(['/', '\\']) || name.contains(['\\', ':', '\0']) || name.chars().any(char::is_control) {
        return bad();
    }
    let trimmed = name.trim_end_matches('/');
    let parts: Vec<&str> = trimmed.split('/').collect();
    if parts.iter().any(|p| p.is_empty() || *p == "." || *p == ".." || p.ends_with(['.', ' '])) {
        return bad();
    }
    // Windows reserved names (CON, NUL, COM1…) can't be files there.
    let reserved = |p: &str| {
        let stem = p.split('.').next().unwrap_or("").to_ascii_uppercase();
        matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL") || (stem.len() == 4 && (stem.starts_with("COM") || stem.starts_with("LPT")) && stem.as_bytes()[3].is_ascii_digit())
    };
    if parts.iter().any(|p| reserved(p)) {
        return bad();
    }
    Ok(trimmed.to_string())
}

/// Checks a `.novapkg` without writing anything.
pub fn inspect(package: &Path) -> Result<Inspected, String> {
    let size = fs::metadata(package).map_err(|e| format!("No se pudo leer el paquete: {e}"))?.len();
    if size > MAX_PACKAGE {
        return Err("El paquete supera 50 MB".into());
    }
    let file = fs::File::open(package).map_err(|e| format!("No se pudo abrir el paquete: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|_| "No es un paquete .novapkg válido (no es un ZIP)".to_string())?;
    if zip.len() > MAX_FILES {
        return Err(format!("El paquete tiene demasiados archivos (máximo {MAX_FILES})"));
    }

    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut unpacked: u64 = 0;
    let mut manifest_index = None;
    for i in 0..zip.len() {
        let entry = zip.by_index(i).map_err(|e| format!("Paquete dañado: {e}"))?;
        let raw = entry.name().map_err(|_| "Paquete con nombres de archivo no válidos".to_string())?.to_string();
        let path = safe_path(&raw)?;
        if entry.is_symlink() {
            return Err(format!("El paquete contiene un enlace, y no se permiten: «{raw}»"));
        }
        if entry.is_dir() {
            continue;
        }
        // Case-insensitive duplicates would overwrite each other on Windows.
        if !seen.insert(path.to_lowercase()) {
            return Err(format!("Archivo repetido en el paquete: «{path}»"));
        }
        let len = entry.size();
        if len > MAX_FILE {
            return Err(format!("«{path}» supera 50 MB"));
        }
        if len > 1024 * 1024 && len / entry.compressed_size().max(1) > MAX_RATIO {
            return Err(format!("«{path}» se comprime de forma sospechosa (posible bomba ZIP)"));
        }
        unpacked += len;
        if unpacked > MAX_UNPACKED {
            return Err("El paquete descomprimido supera 200 MB".into());
        }
        if path == MANIFEST {
            manifest_index = Some(i);
        }
        files.push((i, path, len));
    }

    let index = manifest_index.ok_or("El paquete no tiene nova-plugin.json en la raíz")?;
    let mut text = String::new();
    zip.by_index(index)
        .map_err(|e| e.to_string())?
        .take(MAX_MANIFEST + 1)
        .read_to_string(&mut text)
        .map_err(|_| "nova-plugin.json no es texto válido".to_string())?;
    if text.len() as u64 > MAX_MANIFEST {
        return Err("nova-plugin.json es demasiado grande".into());
    }
    let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("nova-plugin.json no es válido: {e}"))?;
    manifest.validate()?;

    let has = |p: &str| files.iter().any(|(_, f, _)| f == p.trim_start_matches("./"));
    if manifest.kind.contains(&Kind::Provider) && !has(&manifest.main) {
        return Err(format!("Falta el código del plugin: «{}»", manifest.main));
    }
    if manifest.kind.contains(&Kind::App) && !manifest.app.as_deref().is_some_and(has) {
        return Err("Un plugin de tipo app necesita «app» con su página de entrada".into());
    }
    if let Some(icon) = manifest.icon.as_deref().filter(|i| !has(i)) {
        return Err(format!("Falta el icono: «{icon}»"));
    }
    Ok(Inspected { manifest, files, unpacked })
}

/// The installed version of a plugin and its folder, if any.
pub fn current(plugins: &Path, id: &str) -> Option<(String, PathBuf)> {
    let version = fs::read_to_string(plugins.join(id).join("current")).ok()?.trim().to_string();
    let dir = plugins.join(id).join(&version);
    dir.join(MANIFEST).is_file().then_some((version, dir))
}

fn random_suffix() -> String {
    let mut b = [0u8; 6];
    let _ = getrandom::fill(&mut b);
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Installs (or updates) a plugin from a `.novapkg`. All-or-nothing.
pub fn install(package: &Path, plugins: &Path) -> Result<Installed, String> {
    let inspected = inspect(package)?;
    let id = inspected.manifest.id.clone();
    let version = inspected.manifest.version.clone();
    let root = plugins.join(&id);
    let target = root.join(&version);
    let staging = plugins.join(format!(".staging-{id}-{}", random_suffix()));
    fs::create_dir_all(&staging).map_err(|e| format!("No se pudo preparar la instalación: {e}"))?;

    let extracted = extract(package, &inspected, &staging);
    if let Err(e) = extracted {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }

    let previous = current(plugins, &id).map(|(v, _)| v);
    let placed = (|| -> std::io::Result<()> {
        fs::create_dir_all(&root)?;
        // Reinstalling the same version: the old copy steps aside until the new one is in place.
        let aside = root.join(format!(".old-{version}-{}", random_suffix()));
        let had = target.exists();
        if had {
            fs::rename(&target, &aside)?;
        }
        if let Err(e) = fs::rename(&staging, &target) {
            if had {
                let _ = fs::rename(&aside, &target);
            }
            return Err(e);
        }
        crate::config::write_atomic(&root.join("current"), &version)?;
        if had {
            let _ = fs::remove_dir_all(&aside);
        }
        Ok(())
    })();
    if let Err(e) = placed {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("No se pudo instalar: {e}"));
    }

    // Keep the new version and the one before it (for rollback); remove older ones.
    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let keep = name == version || Some(&name) == previous.as_ref() || name == "current";
            if !keep && entry.path().is_dir() {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(Installed { id, version, dir: target, previous: previous.filter(|p| *p != inspected.manifest.version) })
}

fn extract(package: &Path, inspected: &Inspected, into: &Path) -> Result<(), String> {
    let file = fs::File::open(package).map_err(|e| e.to_string())?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
    let mut written: u64 = 0;
    for (index, path, size) in &inspected.files {
        let dest = into.join(path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut entry = zip.by_index(*index).map_err(|e| format!("Paquete dañado: {e}"))?;
        let mut out = fs::File::create(&dest).map_err(|e| format!("No se pudo escribir «{path}»: {e}"))?;
        // Never trust the declared size: stop at it, and fail if there's more.
        let copied = std::io::copy(&mut (&mut entry).take(size + 1), &mut out).map_err(|e| format!("Paquete dañado en «{path}»: {e}"))?;
        if copied != *size {
            return Err(format!("«{path}» no tiene el tamaño que declara el paquete"));
        }
        written += copied;
        if written > MAX_UNPACKED {
            return Err("El paquete descomprimido supera 200 MB".into());
        }
    }
    Ok(())
}

/// Goes back to the version installed before the current one.
pub fn rollback(plugins: &Path, id: &str) -> Result<String, String> {
    let root = plugins.join(id);
    let (now, _) = current(plugins, id).ok_or("El plugin no está instalado")?;
    let other = fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .find(|n| *n != now && !n.starts_with('.') && n != "current" && root.join(n).join(MANIFEST).is_file())
        .ok_or("No hay una versión anterior a la que volver")?;
    crate::config::write_atomic(&root.join("current"), &other).map_err(|e| e.to_string())?;
    Ok(other)
}

/// Removes a plugin's files and, if asked, its saved data.
pub fn uninstall(plugins: &Path, data: &Path, id: &str, delete_data: bool) -> Result<(), String> {
    // Only ever a folder named exactly like a valid plugin id, inside our folders.
    if !super::manifest::valid_id(id) {
        return Err("Plugin no válido".into());
    }
    let root = plugins.join(id);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|e| format!("No se pudo desinstalar: {e}"))?;
    }
    if delete_data {
        let _ = fs::remove_dir_all(data.join(id));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::write::SimpleFileOptions;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nova-pkg-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn manifest(version: &str) -> String {
        serde_json::json!({
            "id": "es.ejemplo.prueba", "name": "Prueba", "version": version, "api": 1, "kind": ["provider"],
            "main": "dist/index.js", "icon": "icon.png", "description": "Un plugin de prueba.",
            "author": { "name": "Yo" }, "audience": "everyone", "permissions": { "rows": true }
        })
        .to_string()
    }

    /// Writes a .novapkg with these (path, contents) entries.
    fn package(dir: &Path, name: &str, files: &[(&str, Vec<u8>)]) -> PathBuf {
        let path = dir.join(name);
        let mut zip = zip::ZipWriter::new(fs::File::create(&path).unwrap());
        for (file, data) in files {
            zip.start_file(*file, SimpleFileOptions::default()).unwrap();
            zip.write_all(data).unwrap();
        }
        zip.finish().unwrap();
        path
    }

    fn good(dir: &Path, version: &str) -> PathBuf {
        package(
            dir,
            &format!("prueba-{version}.novapkg"),
            &[
                ("nova-plugin.json", manifest(version).into_bytes()),
                ("dist/index.js", format!("// {version}").into_bytes()),
                ("icon.png", vec![0x89, b'P', b'N', b'G']),
                ("LICENSE", b"MIT".to_vec()),
            ],
        )
    }

    #[test]
    fn installs_updates_and_rolls_back() {
        let dir = temp("install");
        let plugins = dir.join("plugins");
        let first = install(&good(&dir, "1.0.0"), &plugins).unwrap();
        assert_eq!(first.previous, None);
        assert_eq!(fs::read_to_string(first.dir.join("dist/index.js")).unwrap(), "// 1.0.0");
        assert_eq!(current(&plugins, "es.ejemplo.prueba").unwrap().0, "1.0.0");

        let second = install(&good(&dir, "1.1.0"), &plugins).unwrap();
        assert_eq!(second.previous.as_deref(), Some("1.0.0"));
        assert_eq!(current(&plugins, "es.ejemplo.prueba").unwrap().0, "1.1.0");

        // A broken update changes nothing.
        let broken = package(&dir, "rota.novapkg", &[("nova-plugin.json", manifest("1.2.0").into_bytes())]);
        assert!(install(&broken, &plugins).is_err());
        assert_eq!(current(&plugins, "es.ejemplo.prueba").unwrap().0, "1.1.0");
        assert!(!plugins.join("es.ejemplo.prueba/1.2.0").exists());

        // Only the current and the previous version stay.
        install(&good(&dir, "1.2.0"), &plugins).unwrap();
        assert!(!plugins.join("es.ejemplo.prueba/1.0.0").exists());
        assert_eq!(rollback(&plugins, "es.ejemplo.prueba").unwrap(), "1.1.0");
        assert_eq!(current(&plugins, "es.ejemplo.prueba").unwrap().0, "1.1.0");

        // No staging folders left behind.
        assert!(fs::read_dir(&plugins).unwrap().flatten().all(|e| !e.file_name().to_string_lossy().starts_with(".staging")));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_paths_that_escape() {
        let dir = temp("paths");
        for bad in ["../fuera.js", "/absoluta.js", "dist/../../fuera.js", "C:/Windows/x.js", "dist\\x.js", "dist/./x.js", "CON.txt", "dist/nul"] {
            let pkg = package(&dir, "p.novapkg", &[("nova-plugin.json", manifest("1.0.0").into_bytes()), (bad, b"x".to_vec())]);
            assert!(inspect(&pkg).is_err(), "aceptó {bad}");
        }
        assert!(safe_path("app/index.html").is_ok());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_packages() {
        let dir = temp("bad");
        let not_zip = dir.join("x.novapkg");
        fs::write(&not_zip, b"hola").unwrap();
        assert!(inspect(&not_zip).unwrap_err().contains("ZIP"));
        let no_manifest = package(&dir, "a.novapkg", &[("dist/index.js", b"x".to_vec())]);
        assert!(inspect(&no_manifest).unwrap_err().contains("nova-plugin.json"));
        let bad_manifest = package(&dir, "b.novapkg", &[("nova-plugin.json", b"{\"id\":\"x\"}".to_vec())]);
        assert!(inspect(&bad_manifest).is_err());
        let duplicated = package(&dir, "c.novapkg", &[("nova-plugin.json", manifest("1.0.0").into_bytes()), ("A.js", vec![]), ("a.js", vec![])]);
        assert!(inspect(&duplicated).unwrap_err().contains("repetido"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_zip_bombs() {
        let dir = temp("bomb");
        let zeros = vec![0u8; 20 * 1024 * 1024];
        let pkg = package(&dir, "bomba.novapkg", &[("nova-plugin.json", manifest("1.0.0").into_bytes()), ("dist/index.js", b"x".to_vec()), ("icon.png", vec![1]), ("ceros.bin", zeros)]);
        assert!(inspect(&pkg).unwrap_err().contains("bomba"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// The example plugin packed by `npm run plugin:build -- plugins/ejemplo`: installs and runs.
    #[test]
    #[ignore = "needs the example plugin packed with npm"]
    fn installs_and_runs_a_package_built_by_the_sdk() {
        use super::super::runtime::{Env, Plugin};
        use super::super::storage::Storage;
        let pkg = Path::new(env!("CARGO_MANIFEST_DIR")).join("../plugins/ejemplo/dist/es.novatv.ejemplo-1.0.0.novapkg");
        let dir = temp("real");
        let installed = install(&pkg, &dir.join("plugins")).unwrap();
        let manifest = Manifest::read(&installed.dir).unwrap();
        let source = fs::read_to_string(installed.dir.join(&manifest.main)).unwrap();
        let plugin = Plugin::start(std::sync::Arc::new(Env::new(manifest, Storage::new(dir.join("data")))), source).unwrap();
        let ctx = serde_json::json!({ "profile": { "id": "p1", "kids": false }, "locale": "es-ES" });
        let rows = plugin.call("rows", "load", serde_json::json!([ctx]), Some("p1".into())).unwrap();
        assert_eq!(rows[0]["title"], "Desde un plugin");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn uninstall_keeps_or_deletes_data() {
        let dir = temp("uninstall");
        let (plugins, data) = (dir.join("plugins"), dir.join("data"));
        install(&good(&dir, "1.0.0"), &plugins).unwrap();
        fs::create_dir_all(data.join("es.ejemplo.prueba")).unwrap();
        uninstall(&plugins, &data, "es.ejemplo.prueba", false).unwrap();
        assert!(current(&plugins, "es.ejemplo.prueba").is_none());
        assert!(data.join("es.ejemplo.prueba").exists());
        install(&good(&dir, "1.0.0"), &plugins).unwrap();
        uninstall(&plugins, &data, "es.ejemplo.prueba", true).unwrap();
        assert!(!data.join("es.ejemplo.prueba").exists());
        assert!(uninstall(&plugins, &data, "../config", true).is_err());
        let _ = fs::remove_dir_all(&dir);
    }
}
