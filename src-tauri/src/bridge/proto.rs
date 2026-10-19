//! What NOVA and NovaBridge say to each other on the home network.
//!
//! - UDP `DISCOVERY_PORT`: NOVA broadcasts `DISCOVER`; every NovaBridge answers
//!   with its `Info` as JSON.
//! - HTTP `HTTP_PORT`: `GET /info`, `POST /pair` (the user accepts on the PC),
//!   then with `Authorization: Bearer <token>`: `GET /games`, `POST /launch`,
//!   `POST /moonlight-pin`.

use serde::{Deserialize, Serialize};

pub const HTTP_PORT: u16 = 47800;
pub const DISCOVERY_PORT: u16 = 47801;
pub const DISCOVER: &[u8] = b"NOVA?";

/// The Sunshine app Moonlight opens: the PC's screen, where NovaBridge starts the game.
pub const DESKTOP_APP: &str = "Desktop";

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    pub id: String,
    pub name: String,
    pub version: String,
    /// Sunshine is installed (Moonlight needs it to stream).
    pub sunshine: bool,
    /// Sunshine is running right now.
    pub sunshine_running: bool,
    /// Network cards, for Wake-on-LAN.
    pub macs: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PairRequest {
    /// How the box shows up in the question on the PC.
    pub name: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PairReply {
    pub token: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LaunchRequest {
    pub id: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct PinRequest {
    pub pin: String,
}

/// A Moonlight pairing PIN: exactly four digits.
pub fn valid_pin(pin: &str) -> bool {
    pin.len() == 4 && pin.bytes().all(|b| b.is_ascii_digit())
}

/// `aa:bb:cc:dd:ee:ff` → six bytes.
pub fn parse_mac(mac: &str) -> Option<[u8; 6]> {
    let parts: Vec<u8> = mac.split([':', '-']).map(|p| u8::from_str_radix(p, 16)).collect::<Result<_, _>>().ok()?;
    parts.try_into().ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pins_and_macs() {
        assert!(valid_pin("0427"));
        assert!(!valid_pin("427"));
        assert!(!valid_pin("12a4"));
        assert_eq!(parse_mac("AA-bb-01-02-03-ff"), Some([0xaa, 0xbb, 1, 2, 3, 0xff]));
        assert_eq!(parse_mac("aa:bb:cc"), None);
    }
}
