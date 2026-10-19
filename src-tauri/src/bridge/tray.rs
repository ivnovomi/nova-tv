//! NovaBridge's tray icon and menu (Windows message loop).

use super::{clients, computer_name, forget_clients, info, log_path, open_sunshine, VERSION};
use std::time::{Duration, Instant};
use tray_icon::menu::{CheckMenuItem, Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tray_icon::{Icon, TrayIconBuilder};
use windows::core::w;
use windows::Win32::Foundation::{GetLastError, ERROR_ALREADY_EXISTS};
use windows::Win32::System::Threading::CreateMutexW;
use windows::Win32::UI::WindowsAndMessaging::{DispatchMessageW, GetMessageW, PostQuitMessage, SetTimer, TranslateMessage, MSG};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "NovaBridge";

/// False when another NovaBridge is already running for this user.
pub fn single_instance() -> bool {
    unsafe {
        // Kept open for the life of the process.
        let created = CreateMutexW(None, true, w!("Local\\NovaBridge"));
        created.is_ok() && GetLastError() != ERROR_ALREADY_EXISTS
    }
}

fn autostart() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER).open_subkey(RUN_KEY).and_then(|k| k.get_value::<String, _>(RUN_VALUE)).is_ok()
}

fn set_autostart(on: bool) {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let Ok((key, _)) = RegKey::predef(HKEY_CURRENT_USER).create_subkey(RUN_KEY) else { return };
    if on {
        if let Ok(exe) = std::env::current_exe() {
            let _ = key.set_value(RUN_VALUE, &format!("\"{}\"", exe.display()));
        }
    } else {
        let _ = key.delete_value(RUN_VALUE);
    }
}

/// The program's own icon, or a NOVA-blue dot when it has none.
fn icon() -> Icon {
    if let Ok(icon) = Icon::from_resource(32512, None) {
        return icon;
    }
    const SIZE: u32 = 32;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let (dx, dy) = (x as f32 - 15.5, y as f32 - 15.5);
            let inside = dx * dx + dy * dy <= 15.0 * 15.0;
            rgba.extend_from_slice(if inside { &[0x4f, 0x7c, 0xff, 0xff] } else { &[0, 0, 0, 0] });
        }
    }
    Icon::from_rgba(rgba, SIZE, SIZE).expect("valid icon")
}

fn status_text() -> (String, String) {
    let info = info();
    let sunshine = match (info.sunshine, info.sunshine_running) {
        (false, _) => "Sunshine: no instalado".to_string(),
        (true, false) => "Sunshine: instalado, pero parado".to_string(),
        (true, true) => "Sunshine: listo para emitir".to_string(),
    };
    let boxes = match clients().len() {
        0 => "Ninguna tele emparejada".to_string(),
        1 => "1 tele emparejada".to_string(),
        n => format!("{n} teles emparejadas"),
    };
    (sunshine, boxes)
}

pub fn run() {
    let menu = Menu::new();
    let title = MenuItem::new(format!("NovaBridge {VERSION} · {}", computer_name()), false, None);
    let sunshine = MenuItem::new("Sunshine: …", false, None);
    let boxes = MenuItem::new("…", false, None);
    let open = MenuItem::new("Abrir Sunshine", true, None);
    let log = MenuItem::new("Ver registro", true, None);
    let forget = MenuItem::new("Olvidar las teles emparejadas", true, None);
    let start = CheckMenuItem::new("Arrancar con Windows", true, autostart(), None);
    let quit = MenuItem::new("Salir", true, None);
    let _ = menu.append_items(&[
        &title,
        &sunshine,
        &boxes,
        &PredefinedMenuItem::separator(),
        &open,
        &log,
        &forget,
        &start,
        &PredefinedMenuItem::separator(),
        &quit,
    ]);
    let tray = match TrayIconBuilder::new().with_menu(Box::new(menu)).with_tooltip("NovaBridge").with_icon(icon()).build() {
        Ok(t) => t,
        Err(e) => {
            super::log(&format!("No se pudo crear el icono de la bandeja: {e}"));
            loop {
                std::thread::park();
            }
        }
    };

    let mut refreshed = Instant::now() - Duration::from_secs(60);
    unsafe {
        // Wakes the loop to read menu clicks and refresh the status.
        SetTimer(None, 0, 300, None);
        let mut msg = MSG::default();
        while GetMessageW(&mut msg, None, 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);

            while let Ok(event) = MenuEvent::receiver().try_recv() {
                if event.id == *quit.id() {
                    super::log("NovaBridge cerrado desde la bandeja");
                    PostQuitMessage(0);
                } else if event.id == *open.id() {
                    open_sunshine();
                } else if event.id == *log.id() {
                    let _ = tauri_plugin_opener::open_path(log_path(), None::<&str>);
                } else if event.id == *forget.id() {
                    forget_clients();
                    refreshed = Instant::now() - Duration::from_secs(60);
                } else if event.id == *start.id() {
                    set_autostart(start.is_checked());
                }
            }
            if refreshed.elapsed() > Duration::from_secs(5) {
                refreshed = Instant::now();
                let (s, b) = status_text();
                sunshine.set_text(&s);
                boxes.set_text(&b);
                let _ = tray.set_tooltip(Some(format!("NovaBridge\n{s}\n{b}")));
            }
        }
    }
}
