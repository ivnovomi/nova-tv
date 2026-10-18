//! A plugin's saved values: `plugin.json` (shared) and `profiles/<id>.json`
//! (one per NOVA profile), all inside the plugin's own data folder, which is
//! deleted with the plugin. 5 MB in all.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const QUOTA: usize = 5 * 1024 * 1024;
const MAX_KEY: usize = 200;

pub struct Storage {
    dir: PathBuf,
}

type Values = BTreeMap<String, String>;

fn read(path: &Path) -> Values {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

fn size(values: &Values) -> usize {
    values.iter().map(|(k, v)| k.len() + v.len()).sum()
}

/// File-name-safe version of an opaque profile id.
pub(crate) fn file_name(profile: &str) -> String {
    profile.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').take(64).collect()
}

impl Storage {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    /// The plugin's data folder.
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Forgets what the plugin saved for one profile (the profile was deleted).
    pub fn forget_profile(&self, profile: &str) {
        let _ = std::fs::remove_file(self.path(Some(profile)));
        let _ = std::fs::remove_dir(self.dir.join("profiles"));
    }

    fn path(&self, profile: Option<&str>) -> PathBuf {
        match profile {
            None => self.dir.join("plugin.json"),
            Some(p) => self.dir.join("profiles").join(format!("{}.json", file_name(p))),
        }
    }

    /// Everything stored, across all scopes (for the quota).
    fn used(&self) -> usize {
        let mut total = size(&read(&self.dir.join("plugin.json")));
        if let Ok(entries) = std::fs::read_dir(self.dir.join("profiles")) {
            total += entries.flatten().map(|e| size(&read(&e.path()))).sum::<usize>();
        }
        total
    }

    pub fn get(&self, profile: Option<&str>, key: &str) -> Option<String> {
        read(&self.path(profile)).get(key).cloned()
    }

    pub fn set(&self, profile: Option<&str>, key: &str, value: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > MAX_KEY {
            return Err("La clave tiene que tener entre 1 y 200 caracteres".into());
        }
        let path = self.path(profile);
        let mut values = read(&path);
        let before = values.get(key).map_or(0, |v| key.len() + v.len());
        if self.used() - before + key.len() + value.len() > QUOTA {
            return Err("El plugin ha llenado sus 5 MB de almacenamiento".into());
        }
        values.insert(key.to_string(), value.to_string());
        self.write(&path, &values)
    }

    pub fn delete(&self, profile: Option<&str>, key: &str) -> Result<(), String> {
        let path = self.path(profile);
        let mut values = read(&path);
        if values.remove(key).is_some() {
            self.write(&path, &values)?;
        }
        Ok(())
    }

    fn write(&self, path: &Path, values: &Values) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let text = serde_json::to_string(values).map_err(|e| e.to_string())?;
        crate::config::write_atomic(path, &text).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scopes_and_quota() {
        let dir = std::env::temp_dir().join(format!("nova-plugin-storage-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Storage::new(dir.clone());
        s.set(None, "a", "1").unwrap();
        s.set(Some("perfil-1"), "a", "2").unwrap();
        assert_eq!(s.get(None, "a").as_deref(), Some("1"));
        assert_eq!(s.get(Some("perfil-1"), "a").as_deref(), Some("2"));
        assert_eq!(s.get(Some("perfil-2"), "a"), None);
        s.delete(None, "a").unwrap();
        assert_eq!(s.get(None, "a"), None);
        assert!(s.set(None, "grande", &"x".repeat(QUOTA)).is_err());
        assert!(s.set(Some("../fuera"), "k", "v").is_ok());
        assert!(dir.join("profiles").join("fuera.json").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
