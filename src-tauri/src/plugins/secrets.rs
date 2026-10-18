//! A plugin's secrets: the sessions of the accounts signed in with it (tokens).
//! One file per NOVA profile, `secrets/<profile>.bin` in the plugin's data
//! folder, encrypted with Windows' data protection (DPAPI) for the Windows user
//! running NOVA: copied to another computer or user account, it can't be read.
//! Never in the plugin's normal storage, never in logs.

use super::storage::file_name;
use std::collections::BTreeMap;
use std::path::PathBuf;

/// Room for a few tokens per profile, not for data.
pub const QUOTA: usize = 64 * 1024;
const MAX_KEY: usize = 100;

pub struct Secrets {
    dir: PathBuf,
}

type Values = BTreeMap<String, String>;

impl Secrets {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    fn path(&self, profile: &str) -> PathBuf {
        self.dir.join(format!("{}.bin", file_name(profile)))
    }

    fn read(&self, profile: &str) -> Values {
        let Ok(bytes) = std::fs::read(self.path(profile)) else { return Values::new() };
        unprotect(&bytes).ok().and_then(|plain| serde_json::from_slice(&plain).ok()).unwrap_or_default()
    }

    fn write(&self, profile: &str, values: &Values) -> Result<(), String> {
        let path = self.path(profile);
        if values.is_empty() {
            let _ = std::fs::remove_file(&path);
            let _ = std::fs::remove_dir(&self.dir);
            return Ok(());
        }
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        let plain = serde_json::to_vec(values).map_err(|e| e.to_string())?;
        let sealed = protect(&plain)?;
        let temp = path.with_extension("tmp");
        std::fs::write(&temp, sealed).map_err(|e| e.to_string())?;
        std::fs::rename(&temp, &path).map_err(|e| e.to_string())
    }

    pub fn get(&self, profile: &str, key: &str) -> Option<String> {
        self.read(profile).get(key).cloned()
    }

    pub fn set(&self, profile: &str, key: &str, value: &str) -> Result<(), String> {
        if key.is_empty() || key.len() > MAX_KEY {
            return Err("La clave tiene que tener entre 1 y 100 caracteres".into());
        }
        let mut values = self.read(profile);
        values.insert(key.to_string(), value.to_string());
        if values.iter().map(|(k, v)| k.len() + v.len()).sum::<usize>() > QUOTA {
            return Err("Los secretos son para sesiones (64 KB por perfil), no para datos: usa storage".into());
        }
        self.write(profile, &values)
    }

    pub fn delete(&self, profile: &str, key: &str) -> Result<(), String> {
        let mut values = self.read(profile);
        if values.remove(key).is_some() {
            self.write(profile, &values)?;
        }
        Ok(())
    }

    /// Signs the profile out of everything: its secrets are gone.
    pub fn clear(&self, profile: &str) {
        let _ = std::fs::remove_file(self.path(profile));
        let _ = std::fs::remove_dir(&self.dir);
    }
}

#[cfg(windows)]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(plain, true)
}

#[cfg(windows)]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    dpapi(sealed, false)
}

/// DPAPI for the current Windows user, never asking anything on screen.
#[cfg(windows)]
fn dpapi(data: &[u8], seal: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    // Ties the files to NOVA: another program of the same user can't simply hand them to DPAPI.
    const ENTROPY: &[u8] = b"com.ivnov.novatv/plugin-secrets";
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let entropy = CRYPT_INTEGER_BLOB { cbData: ENTROPY.len() as u32, pbData: ENTROPY.as_ptr() as *mut u8 };
    let mut output = CRYPT_INTEGER_BLOB::default();
    // SAFETY: the input blobs point at live slices for the whole call; DPAPI
    // allocates `output` with LocalAlloc, copied out and freed below.
    unsafe {
        let done = if seal {
            CryptProtectData(&input, windows::core::PCWSTR::null(), Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, None, Some(&entropy), None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        };
        done.map_err(|e| format!("No se pudo proteger la sesión: {e}"))?;
        let bytes = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(Some(HLOCAL(output.pbData as _)));
        Ok(bytes)
    }
}

// Other systems (development only: NOVA runs on Windows): stored as they are.
#[cfg(not(windows))]
fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    Ok(plain.to_vec())
}

#[cfg(not(windows))]
fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
    Ok(sealed.to_vec())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sealed_per_profile() {
        let dir = std::env::temp_dir().join(format!("nova-plugin-secrets-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let s = Secrets::new(dir.clone());
        s.set("perfil-1", "token", "abc123-secreto").unwrap();
        assert_eq!(s.get("perfil-1", "token").as_deref(), Some("abc123-secreto"));
        assert_eq!(s.get("perfil-2", "token"), None);
        // On disk it's not readable as is.
        let raw = std::fs::read(dir.join("perfil-1.bin")).unwrap();
        if cfg!(windows) {
            assert!(!String::from_utf8_lossy(&raw).contains("abc123-secreto"));
        }
        assert!(s.set("perfil-1", "grande", &"x".repeat(QUOTA)).is_err());
        s.delete("perfil-1", "token").unwrap();
        // Nothing left: not the file, not the folder.
        assert!(!dir.exists());
        s.set("perfil-1", "token", "otro").unwrap();
        s.clear("perfil-1");
        assert_eq!(s.get("perfil-1", "token"), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
