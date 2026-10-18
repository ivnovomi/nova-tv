//! `nova-plugin.json`: who the plugin is and what it may do. Mirrors
//! sdk/src/manifest.ts and sdk/schema/nova-plugin.schema.json; checked again
//! here because the host never trusts a package.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Manifest {
    /// Editors' JSON Schema link; accepted and ignored.
    #[serde(rename = "$schema", default, skip_serializing)]
    #[allow(dead_code)]
    pub schema: Option<String>,
    pub id: String,
    pub name: String,
    pub version: String,
    pub api: u32,
    pub kind: Vec<Kind>,
    pub main: String,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    pub description: String,
    pub author: Author,
    pub audience: Audience,
    pub permissions: Permissions,
    #[serde(default)]
    pub settings: Vec<Setting>,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Provider,
    App,
}

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Audience {
    Everyone,
    Adults,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
pub struct Author {
    pub name: String,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub email: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(deny_unknown_fields)]
pub struct Permissions {
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub channels: bool,
    #[serde(default)]
    pub guide: bool,
    #[serde(default)]
    pub rows: bool,
    #[serde(default)]
    pub search: bool,
    #[serde(default)]
    pub screensaver: bool,
    #[serde(default)]
    pub notify: bool,
    #[serde(default)]
    pub location: bool,
    /// Signing in to the service with a code on the TV, and keeping the session.
    #[serde(default)]
    pub account: bool,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Setting {
    pub key: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub label: String,
    #[serde(default)]
    pub help: Option<String>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub options: Vec<serde_json::Value>,
}

/// The API version this NOVA speaks.
pub const API: u32 = 1;

fn is_label(s: &str) -> bool {
    !s.is_empty() && s.len() <= 63 && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') && !s.starts_with('-') && !s.ends_with('-')
}

/// "es.ejemplo.eltiempo": three or more dot-separated parts, lower case.
pub fn valid_id(id: &str) -> bool {
    id.len() <= 100 && id.split('.').count() >= 3 && id.split('.').all(is_label)
}

/// "api.ejemplo.es" or "*.ejemplo.es" (subdomains only).
fn valid_domain(d: &str) -> bool {
    let d = d.strip_prefix("*.").unwrap_or(d);
    d.len() <= 253 && d.split('.').count() >= 2 && d.split('.').all(is_label)
}

/// A file inside the package: relative, no "..", no drive letters.
fn valid_path(p: &str) -> bool {
    !p.is_empty() && !p.starts_with(['/', '\\']) && !p.contains(':') && p.split(['/', '\\']).all(|part| !part.is_empty() && part != "..")
}

fn valid_version(v: &str) -> bool {
    let core = v.split('-').next().unwrap_or("");
    core.split('.').count() == 3 && core.split('.').all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()))
}

impl Manifest {
    pub fn read(dir: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(dir.join("nova-plugin.json")).map_err(|e| format!("No se pudo leer nova-plugin.json: {e}"))?;
        let manifest: Manifest = serde_json::from_str(&text).map_err(|e| format!("nova-plugin.json no es válido: {e}"))?;
        manifest.validate()?;
        Ok(manifest)
    }

    pub fn validate(&self) -> Result<(), String> {
        let fail = |what: &str| Err(format!("nova-plugin.json: {what}"));
        if !valid_id(&self.id) {
            return fail("«id» tiene que ser un dominio invertido en minúsculas (es.ejemplo.plugin)");
        }
        if self.name.trim().is_empty() || self.name.chars().count() > 40 {
            return fail("«name» tiene que tener entre 1 y 40 caracteres");
        }
        if !valid_version(&self.version) {
            return fail("«version» tiene que ser SemVer (1.0.0)");
        }
        if self.api != API {
            return Err(format!("Este plugin usa la API {} y NOVA usa la {API}", self.api));
        }
        if self.kind.is_empty() {
            return fail("«kind» no puede estar vacío");
        }
        if !valid_path(&self.main) || self.app.as_deref().is_some_and(|a| !valid_path(a)) || self.icon.as_deref().is_some_and(|i| !valid_path(i)) {
            return fail("«main», «app» e «icon» tienen que ser rutas dentro del plugin");
        }
        if let Some(bad) = self.permissions.network.iter().find(|d| !valid_domain(d)) {
            return Err(format!("nova-plugin.json: el dominio «{bad}» no es válido"));
        }
        if self.permissions.network.len() > 20 || self.settings.len() > 20 {
            return fail("demasiados dominios u opciones (máximo 20)");
        }
        Ok(())
    }

    /// Whether `host` is one of the plugin's `network` domains.
    pub fn allows_host(&self, host: &str) -> bool {
        let host = host.to_ascii_lowercase();
        self.permissions.network.iter().any(|d| match d.strip_prefix("*.") {
            Some(parent) => host.len() > parent.len() + 1 && host.ends_with(parent) && host.as_bytes()[host.len() - parent.len() - 1] == b'.',
            None => host == *d,
        })
    }

    /// Default values of the declared settings.
    pub fn default_setting(&self, key: &str) -> Option<serde_json::Value> {
        self.settings.iter().find(|s| s.key == key).and_then(|s| s.default.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(network: &[&str]) -> Manifest {
        serde_json::from_value(serde_json::json!({
            "id": "es.ejemplo.prueba", "name": "Prueba", "version": "1.0.0", "api": 1, "kind": ["provider"],
            "main": "dist/index.js", "description": "Un plugin de prueba.", "author": { "name": "Yo" },
            "audience": "everyone", "permissions": { "network": network, "rows": true }
        }))
        .unwrap()
    }

    #[test]
    fn domains() {
        let m = manifest(&["api.ejemplo.es", "*.pluto.tv"]);
        assert!(m.validate().is_ok());
        assert!(m.allows_host("api.ejemplo.es"));
        assert!(m.allows_host("API.Ejemplo.es"));
        assert!(m.allows_host("boot.pluto.tv"));
        assert!(m.allows_host("a.b.pluto.tv"));
        assert!(!m.allows_host("pluto.tv"));
        assert!(!m.allows_host("evilpluto.tv"));
        assert!(!m.allows_host("ejemplo.es"));
        assert!(!m.allows_host("api.ejemplo.es.evil.com"));
    }

    #[test]
    fn rejects_bad_manifests() {
        let mut m = manifest(&["api.ejemplo.es"]);
        m.id = "ejemplo".into();
        assert!(m.validate().is_err());
        let mut m = manifest(&["*.*.es"]);
        assert!(m.validate().is_err());
        m = manifest(&[]);
        m.main = "../fuera.js".into();
        assert!(m.validate().is_err());
        m = manifest(&[]);
        m.api = 2;
        assert!(m.validate().is_err());
        assert!(serde_json::from_value::<Manifest>(serde_json::json!({ "id": "x", "nuevo": true })).is_err());
    }
}
