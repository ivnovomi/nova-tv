//! Synthesises key presses for the foreground window (NOVA TV, YouTube TV,
//! Netflix…). Only a fixed set of keys and plain text are possible, and only
//! into NOVA itself or the session it opened (see `target_allowed`).

pub const NOT_NOVA: &str = "La tele no está mostrando NOVA. Pulsa Inicio en el mando.";

/// Keys and text may only go to NOVA's own windows, or while a NOVA session is open.
pub fn target_allowed() -> bool {
    crate::session::is_active() || foreground_pid() == Some(std::process::id())
}

pub const LEFT: u16 = 0x25;
pub const UP: u16 = 0x26;
pub const RIGHT: u16 = 0x27;
pub const DOWN: u16 = 0x28;
pub const ENTER: u16 = 0x0D;
pub const ESCAPE: u16 = 0x1B;
pub const BACKSPACE: u16 = 0x08;
pub const SPACE: u16 = 0x20;
pub const MEDIA_NEXT: u16 = 0xB0;
pub const MEDIA_PREV: u16 = 0xB1;
pub const MEDIA_PLAY_PAUSE: u16 = 0xB3;
pub const VOLUME_MUTE: u16 = 0xAD;
pub const VOLUME_DOWN: u16 = 0xAE;
pub const VOLUME_UP: u16 = 0xAF;

#[cfg(windows)]
mod imp {
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY,
    };

    fn input(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT { wVk: VIRTUAL_KEY(vk), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
            },
        }
    }

    fn send(inputs: &[INPUT]) {
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }

    pub fn tap(vk: u16) {
        // Arrow keys live on the extended part of the keyboard.
        let ext = if (0x21..=0x28).contains(&vk) { KEYEVENTF_EXTENDEDKEY } else { KEYBD_EVENT_FLAGS(0) };
        send(&[input(vk, 0, ext), input(vk, 0, ext | KEYEVENTF_KEYUP)]);
    }

    pub fn type_text(text: &str) {
        let inputs: Vec<INPUT> = text
            .encode_utf16()
            .flat_map(|unit| {
                [input(0, unit, KEYEVENTF_UNICODE), input(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]
            })
            .collect();
        send(&inputs);
    }

    pub fn foreground_pid() -> Option<u32> {
        use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.0.is_null() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            (pid != 0).then_some(pid)
        }
    }
}

#[cfg(windows)]
pub use imp::{foreground_pid, tap, type_text};

#[cfg(not(windows))]
pub fn foreground_pid() -> Option<u32> {
    None
}
#[cfg(not(windows))]
pub fn tap(_: u16) {}
#[cfg(not(windows))]
pub fn type_text(_: &str) {}
