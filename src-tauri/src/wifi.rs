//! Internet for the first-run assistant: is there a connection, which Wi-Fi
//! networks are around, and joining one (Windows' native Wi-Fi API: unlike
//! `netsh`, it doesn't depend on the system's language).
//!
//! Windows 11 24H2+ only lets desktop apps see Wi-Fi networks while location
//! is allowed for them; when it isn't, scanning fails and NOVA says so.

use serde::Serialize;
use std::time::Duration;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub ssid: String,
    /// 0-100.
    pub signal: u32,
    /// Needs a password.
    pub secured: bool,
    /// Connected right now.
    pub connected: bool,
    /// Windows already knows it (no password needed).
    pub saved: bool,
    /// Windows' profile for it (may differ from the name).
    #[serde(skip)]
    pub profile: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct NetStatus {
    /// Reaches the internet.
    pub internet: bool,
    /// "wifi" | "ethernet" | null
    pub kind: Option<&'static str>,
    /// The Wi-Fi it's on, if any.
    pub ssid: Option<String>,
    /// The network's name in Windows and whether it's private (NOVA's phone
    /// remote and NovaBridge need "Privada"); None when unknown.
    pub network: Option<String>,
    pub private: Option<bool>,
    /// This computer has a Wi-Fi card.
    pub wifi: bool,
}

/// Can we reach the internet? (Windows' own connectivity test page.)
fn internet() -> bool {
    let agent: ureq::Agent = ureq::Agent::config_builder().timeout_global(Some(Duration::from_secs(5))).max_redirects(0).build().into();
    agent
        .get("http://www.msftconnecttest.com/connecttest.txt")
        .call()
        .ok()
        .and_then(|mut r| r.body_mut().read_to_string().ok())
        .is_some_and(|t| t.trim() == "Microsoft Connect Test")
}

#[cfg(windows)]
mod imp {
    use super::Network;
    use std::ptr::null_mut;
    use std::thread;
    use std::time::{Duration, Instant};
    use windows::core::{GUID, HSTRING, PCWSTR};
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::NetworkManagement::WiFi::*;

    /// An open WLAN handle with its first Wi-Fi card.
    pub struct Wlan {
        handle: HANDLE,
        pub iface: GUID,
        pub connected: bool,
    }

    impl Drop for Wlan {
        fn drop(&mut self) {
            unsafe {
                WlanCloseHandle(self.handle, None);
            }
        }
    }

    fn check(code: u32, what: &str) -> Result<(), String> {
        match code {
            0 => Ok(()),
            5 => Err("Windows no deja a NOVA ver las redes Wi-Fi: permite la ubicación para las apps de escritorio (Configuración → Privacidad → Ubicación).".into()),
            _ => Err(format!("{what} (error {code})")),
        }
    }

    pub fn open() -> Result<Option<Wlan>, String> {
        unsafe {
            let mut negotiated = 0u32;
            let mut handle = HANDLE::default();
            // No Wi-Fi service (a wired-only box): no Wi-Fi at all, not an error.
            if WlanOpenHandle(2, None, &mut negotiated, &mut handle) != 0 {
                return Ok(None);
            }
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = null_mut();
            if WlanEnumInterfaces(handle, None, &mut list) != 0 || list.is_null() {
                WlanCloseHandle(handle, None);
                return Ok(None);
            }
            let infos = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), (*list).dwNumberOfItems as usize);
            let found = infos.first().map(|i| (i.InterfaceGuid, i.isState == wlan_interface_state_connected));
            WlanFreeMemory(list as _);
            match found {
                Some((iface, connected)) => Ok(Some(Wlan { handle, iface, connected })),
                None => {
                    WlanCloseHandle(handle, None);
                    Ok(None)
                }
            }
        }
    }

    fn ssid_text(ssid: &DOT11_SSID) -> String {
        let len = (ssid.uSSIDLength as usize).min(ssid.ucSSID.len());
        String::from_utf8_lossy(&ssid.ucSSID[..len]).into_owned()
    }

    impl Wlan {
        /// The networks around, strongest first (one entry per name).
        pub fn networks(&self, rescan: bool) -> Result<Vec<Network>, String> {
            unsafe {
                if rescan {
                    // The scan runs in the background; Windows needs a few seconds.
                    let _ = WlanScan(self.handle, &self.iface, None, None, None);
                    thread::sleep(Duration::from_millis(3500));
                }
                let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = null_mut();
                check(WlanGetAvailableNetworkList(self.handle, &self.iface, 0, None, &mut list), "No se pudieron ver las redes")?;
                let items = std::slice::from_raw_parts((*list).Network.as_ptr(), (*list).dwNumberOfItems as usize);
                let mut out: Vec<Network> = Vec::new();
                for n in items {
                    let ssid = ssid_text(&n.dot11Ssid);
                    if ssid.is_empty() {
                        continue; // hidden networks
                    }
                    let network = Network {
                        ssid,
                        signal: n.wlanSignalQuality,
                        secured: n.bSecurityEnabled.as_bool(),
                        connected: n.dwFlags & WLAN_AVAILABLE_NETWORK_CONNECTED != 0,
                        saved: n.dwFlags & WLAN_AVAILABLE_NETWORK_HAS_PROFILE != 0,
                        profile: {
                            let end = n.strProfileName.iter().position(|&c| c == 0).unwrap_or(n.strProfileName.len());
                            String::from_utf16_lossy(&n.strProfileName[..end])
                        },
                    };
                    match out.iter_mut().find(|o| o.ssid == network.ssid) {
                        Some(o) => {
                            o.signal = o.signal.max(network.signal);
                            o.connected |= network.connected;
                            o.saved |= network.saved;
                            if o.profile.is_empty() {
                                o.profile = network.profile;
                            }
                        }
                        None => out.push(network),
                    }
                }
                WlanFreeMemory(list as _);
                out.sort_by(|a, b| b.connected.cmp(&a.connected).then(b.signal.cmp(&a.signal)));
                Ok(out)
            }
        }

        /// The network's security as Windows profiles name it.
        fn security(&self, ssid: &str) -> Result<(&'static str, &'static str), String> {
            unsafe {
                let mut list: *mut WLAN_AVAILABLE_NETWORK_LIST = null_mut();
                check(WlanGetAvailableNetworkList(self.handle, &self.iface, 0, None, &mut list), "No se pudieron ver las redes")?;
                let items = std::slice::from_raw_parts((*list).Network.as_ptr(), (*list).dwNumberOfItems as usize);
                let found = items.iter().find(|n| ssid_text(&n.dot11Ssid) == ssid).map(|n| (n.dot11DefaultAuthAlgorithm, n.dot11DefaultCipherAlgorithm));
                WlanFreeMemory(list as _);
                let (auth, cipher) = found.ok_or("Esa red ya no está a la vista.")?;
                let authentication = match auth {
                    DOT11_AUTH_ALGO_80211_OPEN => "open",
                    DOT11_AUTH_ALGO_WPA_PSK => "WPAPSK",
                    DOT11_AUTH_ALGO_RSNA_PSK => "WPA2PSK",
                    DOT11_AUTH_ALGO_WPA3_SAE => "WPA3SAE",
                    _ => return Err("Esa red usa una seguridad de empresa: conéctala desde la configuración de Windows.".into()),
                };
                let encryption = match (authentication, cipher) {
                    ("open", _) => "none",
                    (_, DOT11_CIPHER_ALGO_TKIP) => "TKIP",
                    _ => "AES",
                };
                Ok((authentication, encryption))
            }
        }

        /// Joins `ssid` (with `password` unless Windows already knows it as `saved`) and waits for it.
        pub fn connect(&self, ssid: &str, password: Option<&str>, saved: Option<&str>) -> Result<(), String> {
            let mut created = false;
            let profile_name = saved.filter(|p| !p.is_empty()).unwrap_or(ssid).to_string();
            unsafe {
                if saved.is_none() {
                    let (authentication, encryption) = self.security(ssid)?;
                    let key = match (authentication, password) {
                        ("open", _) => String::new(),
                        (_, Some(p)) if (8..=63).contains(&p.chars().count()) => format!(
                            "<sharedKey><keyType>passPhrase</keyType><protected>false</protected><keyMaterial>{}</keyMaterial></sharedKey>",
                            super::xml(p)
                        ),
                        _ => return Err("La contraseña de una Wi-Fi tiene entre 8 y 63 caracteres.".into()),
                    };
                    let xml = format!(
                        "<?xml version=\"1.0\"?><WLANProfile xmlns=\"http://www.microsoft.com/networking/WLAN/profile/v1\"><name>{name}</name>\
                         <SSIDConfig><SSID><name>{name}</name></SSID></SSIDConfig><connectionType>ESS</connectionType><connectionMode>auto</connectionMode>\
                         <MSM><security><authEncryption><authentication>{authentication}</authentication><encryption>{encryption}</encryption>\
                         <useOneX>false</useOneX></authEncryption>{key}</security></MSM></WLANProfile>",
                        name = super::xml(ssid)
                    );
                    let mut reason = 0u32;
                    check(
                        WlanSetProfile(self.handle, &self.iface, 0, &HSTRING::from(xml), PCWSTR::null(), true, None, &mut reason),
                        "Windows no aceptó esa red",
                    )?;
                    created = true;
                }
                let profile = HSTRING::from(profile_name.as_str());
                let params = WLAN_CONNECTION_PARAMETERS {
                    wlanConnectionMode: wlan_connection_mode_profile,
                    strProfile: PCWSTR(profile.as_ptr()),
                    pDot11Ssid: null_mut(),
                    pDesiredBssidList: null_mut(),
                    dot11BssType: dot11_BSS_type_infrastructure,
                    dwFlags: 0,
                };
                check(WlanConnect(self.handle, &self.iface, &params, None), "No se pudo conectar")?;
            }
            // Joining takes a few seconds; a wrong password just never connects.
            let deadline = Instant::now() + Duration::from_secs(25);
            while Instant::now() < deadline {
                thread::sleep(Duration::from_millis(800));
                if self.networks(false).is_ok_and(|list| list.iter().any(|n| n.ssid == ssid && n.connected)) {
                    return Ok(());
                }
            }
            if created {
                // Don't leave a profile with a wrong password behind.
                unsafe {
                    let _ = WlanDeleteProfile(self.handle, &self.iface, &HSTRING::from(ssid), None);
                }
            }
            Err("No se pudo conectar. ¿La contraseña es correcta?".into())
        }
    }

    /// The connected network's name in Windows and whether it's private.
    pub fn category() -> Option<(String, bool)> {
        use windows::Win32::Networking::NetworkListManager::{INetworkListManager, NetworkListManager, NLM_ENUM_NETWORK_CONNECTED, NLM_NETWORK_CATEGORY_PUBLIC};
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED};
        // On its own thread: COM set up its own way, whatever the caller's thread uses.
        thread::spawn(|| unsafe {
            let init = CoInitializeEx(None, COINIT_MULTITHREADED).is_ok();
            let result = (|| {
                let manager: INetworkListManager = CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL).ok()?;
                let networks = manager.GetNetworks(NLM_ENUM_NETWORK_CONNECTED).ok()?;
                let mut fetched = 0u32;
                let mut slot = [None];
                // The first connected network is the one that matters.
                networks.Next(&mut slot, Some(&mut fetched)).ok()?;
                let network = slot[0].take()?;
                let name = network.GetName().ok()?.to_string();
                let private = network.GetCategory().ok()? != NLM_NETWORK_CATEGORY_PUBLIC;
                Some((name, private))
            })();
            if init {
                CoUninitialize();
            }
            result
        })
        .join()
        .ok()
        .flatten()
    }
}

/// `<` `>` `&` `"` `'` as XML wants them (network names and passwords).
fn xml(text: &str) -> String {
    text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;").replace('\'', "&apos;")
}

#[cfg(windows)]
pub fn status() -> NetStatus {
    let wlan = imp::open().ok().flatten();
    let ssid = wlan
        .as_ref()
        .filter(|w| w.connected)
        .and_then(|w| w.networks(false).ok())
        .and_then(|list| list.into_iter().find(|n| n.connected).map(|n| n.ssid));
    let category = imp::category();
    let internet = internet();
    NetStatus {
        internet,
        kind: if ssid.is_some() { Some("wifi") } else if category.is_some() { Some("ethernet") } else { None },
        ssid,
        network: category.as_ref().map(|(n, _)| n.clone()),
        private: category.map(|(_, p)| p),
        wifi: wlan.is_some(),
    }
}

#[cfg(windows)]
pub fn networks() -> Result<Vec<Network>, String> {
    match imp::open()? {
        Some(wlan) => wlan.networks(true),
        None => Err("Este equipo no tiene Wi-Fi: conéctalo con un cable de red.".into()),
    }
}

#[cfg(windows)]
pub fn connect(ssid: &str, password: Option<&str>) -> Result<(), String> {
    let wlan = imp::open()?.ok_or("Este equipo no tiene Wi-Fi.")?;
    let known = wlan.networks(false)?;
    // Windows already has it: its own profile, unless a password was typed to replace it.
    let saved = known
        .iter()
        .find(|n| n.ssid == ssid && n.saved)
        .filter(|_| password.is_none_or(str::is_empty))
        .map(|n| n.profile.clone());
    wlan.connect(ssid, password.filter(|p| !p.is_empty()), saved.as_deref())
}

#[cfg(not(windows))]
pub fn status() -> NetStatus {
    NetStatus { internet: internet(), ..Default::default() }
}
#[cfg(not(windows))]
pub fn networks() -> Result<Vec<Network>, String> {
    Err("Solo en Windows".into())
}
#[cfg(not(windows))]
pub fn connect(_: &str, _: Option<&str>) -> Result<(), String> {
    Err("Solo en Windows".into())
}

#[tauri::command]
pub async fn net_status() -> NetStatus {
    tauri::async_runtime::spawn_blocking(status).await.unwrap_or_default()
}

#[tauri::command]
pub async fn wifi_networks() -> Result<Vec<Network>, String> {
    tauri::async_runtime::spawn_blocking(networks).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn wifi_connect(ssid: String, password: Option<String>, state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    crate::profiles::require_adult(&state)?;
    if ssid.is_empty() || ssid.len() > 32 {
        return Err("Nombre de red no válido.".into());
    }
    tauri::async_runtime::spawn_blocking(move || connect(&ssid, password.as_deref())).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xml_is_escaped() {
        assert_eq!(xml(r#"a<b>&"c'"#), "a&lt;b&gt;&amp;&quot;c&apos;");
    }

    /// This PC's connection and the networks around (read-only).
    #[test]
    #[ignore = "depends on this PC's network"]
    fn reads_this_network() {
        println!("{:#?}", status());
        println!("{:#?}", networks());
    }
}
