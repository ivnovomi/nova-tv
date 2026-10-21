//! The TV's controller as keyboard and mouse on this PC.
//!
//! Sunshine turns the TV's controller into an Xbox 360 pad here; while a mode
//! is on, NovaBridge reads it (XInput) and types keys / moves the mouse with
//! SendInput. Keys go as scan codes, so games reading the keyboard at a low
//! level (Minecraft, most PC games) see a real keyboard.
//!
//! Two layouts:
//! - **Game** ("mando como teclado y ratón", for games without controller support):
//!   left stick W A S D, right stick mouse, RT / LT left / right click,
//!   RB / LB wheel (hotbar), A space, B shift, X E, Y F, stick clicks ctrl / F5,
//!   Start Esc, Back Tab, D-pad up T, down Q, left/right wheel.
//! - **Desktop** (a launcher is in front: "Play", logins, updates): left stick
//!   moves the pointer, right stick scrolls, A click, X right click, B Esc,
//!   Y on-screen keyboard, D-pad arrows, Start Enter, Back Tab, RB / LB wheel.
//!
//! It stops by itself once no controller has been seen for a while (the
//! stream ended and Sunshine removed its pad).

use gilrs::{Axis, Button, Gilrs};
use std::sync::atomic::{AtomicU64, AtomicU8, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};

const TICK: Duration = Duration::from_millis(8);
/// No controller for this long: the stream is over.
const NO_PAD: Duration = Duration::from_secs(12);
/// Time to wait for the stream's pad after turning it on.
const FIRST_PAD: Duration = Duration::from_secs(90);
const STICK_KEY: f32 = 0.35;
const DEADZONE: f32 = 0.12;
/// Pixels per tick with the stick fully pushed: aiming (~2000 px/s) and pointing (~1600 px/s).
const LOOK_SPEED: f32 = 16.0;
const POINT_SPEED: f32 = 13.0;
/// Wheel notches per tick with the right stick fully pushed (desktop).
const SCROLL_SPEED: f32 = 0.12;
const TRIGGER: f32 = 0.3;
const WHEEL_REPEAT: Duration = Duration::from_millis(180);
const WHEEL_NOTCH: i32 = 120;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    Off = 0,
    Game = 1,
    Desktop = 2,
}

impl Mode {
    fn from(n: u8) -> Mode {
        match n {
            1 => Mode::Game,
            2 => Mode::Desktop,
            _ => Mode::Off,
        }
    }
}

static MODE: AtomicU8 = AtomicU8::new(0);
/// Each start gets a number; an older loop seeing a newer one stops.
static RUN: AtomicU64 = AtomicU64::new(0);

pub fn mode() -> Mode {
    Mode::from(MODE.load(Ordering::Acquire))
}

pub fn active() -> bool {
    mode() != Mode::Off
}

/// Switches the layout (or stops translating).
pub fn set_mode(next: Mode) {
    let previous = Mode::from(MODE.swap(next as u8, Ordering::AcqRel));
    if previous == next {
        return;
    }
    if previous == Mode::Off {
        let run = RUN.fetch_add(1, Ordering::AcqRel) + 1;
        thread::Builder::new().name("bridge-input".into()).spawn(move || translate(run)).ok();
    }
    super::log(match next {
        Mode::Off => "Mando: vuelve a ser mando",
        Mode::Game => "Mando: como teclado y ratón (juego)",
        Mode::Desktop => "Mando: como puntero (lanzador)",
    });
}

/// "Mando como teclado y ratón" on or off (tray, NOVA).
pub fn set(on: bool) {
    set_mode(if on { Mode::Game } else { Mode::Off });
}

// ───────────────────────── SendInput ─────────────────────────

fn key(scan: u16, extended: bool, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
    if extended {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VIRTUAL_KEY(0), wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: i32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: data as u32, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
    }
}

fn send(inputs: &[INPUT]) {
    if !inputs.is_empty() {
        unsafe {
            SendInput(inputs, std::mem::size_of::<INPUT>() as i32);
        }
    }
}

/// Windows' on-screen keyboard, to type in a launcher's login or search.
fn on_screen_keyboard() {
    let _ = tauri_plugin_opener::open_path(r"C:\Windows\System32\osk.exe", None::<&str>);
}

// ───────────────────────── Layouts ─────────────────────────

/// What a control does on the PC.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Out {
    Key(u16),
    /// Keys on the keyboard's extended part (arrows).
    Ext(u16),
    LeftClick,
    RightClick,
    /// Mouse wheel notches (+ up, − down), repeated while held.
    Wheel(i32),
    /// Windows' on-screen keyboard (on press).
    Osk,
}

/// Set-1 scan codes.
mod sc {
    pub const ESC: u16 = 0x01;
    pub const TAB: u16 = 0x0F;
    pub const Q: u16 = 0x10;
    pub const W: u16 = 0x11;
    pub const E: u16 = 0x12;
    pub const T: u16 = 0x14;
    pub const ENTER: u16 = 0x1C;
    pub const A: u16 = 0x1E;
    pub const S: u16 = 0x1F;
    pub const D: u16 = 0x20;
    pub const F: u16 = 0x21;
    pub const LCTRL: u16 = 0x1D;
    pub const LSHIFT: u16 = 0x2A;
    pub const SPACE: u16 = 0x39;
    pub const F5: u16 = 0x3F;
    pub const UP: u16 = 0x48;
    pub const LEFT: u16 = 0x4B;
    pub const RIGHT: u16 = 0x4D;
    pub const DOWN: u16 = 0x50;
}

const GAME: [(Button, Out); 14] = [
    (Button::South, Out::Key(sc::SPACE)),
    (Button::East, Out::Key(sc::LSHIFT)),
    (Button::West, Out::Key(sc::E)),
    (Button::North, Out::Key(sc::F)),
    (Button::LeftThumb, Out::Key(sc::LCTRL)),
    (Button::RightThumb, Out::Key(sc::F5)),
    (Button::Start, Out::Key(sc::ESC)),
    (Button::Select, Out::Key(sc::TAB)),
    (Button::DPadUp, Out::Key(sc::T)),
    (Button::DPadDown, Out::Key(sc::Q)),
    (Button::DPadLeft, Out::Wheel(1)),
    (Button::DPadRight, Out::Wheel(-1)),
    (Button::LeftTrigger, Out::Wheel(1)),
    (Button::RightTrigger, Out::Wheel(-1)),
];

const DESKTOP: [(Button, Out); 12] = [
    (Button::South, Out::LeftClick),
    (Button::West, Out::RightClick),
    (Button::East, Out::Key(sc::ESC)),
    (Button::North, Out::Osk),
    (Button::Start, Out::Key(sc::ENTER)),
    (Button::Select, Out::Key(sc::TAB)),
    (Button::DPadUp, Out::Ext(sc::UP)),
    (Button::DPadDown, Out::Ext(sc::DOWN)),
    (Button::DPadLeft, Out::Ext(sc::LEFT)),
    (Button::DPadRight, Out::Ext(sc::RIGHT)),
    (Button::LeftTrigger, Out::Wheel(1)),
    (Button::RightTrigger, Out::Wheel(-1)),
];

/// Everything held right now, from every connected controller.
#[derive(Default)]
struct Pad {
    held: Vec<Out>,
    left: (f32, f32),
    right: (f32, f32),
}

fn strongest(current: &mut (f32, f32), x: f32, y: f32) {
    if x.abs() > current.0.abs() {
        current.0 = x;
    }
    if y.abs() > current.1.abs() {
        current.1 = y;
    }
}

fn read(gilrs: &Gilrs, mode: Mode) -> Option<Pad> {
    let layout: &[(Button, Out)] = if mode == Mode::Desktop { &DESKTOP } else { &GAME };
    let mut pad = Pad::default();
    let mut any = false;
    let hold = |pad: &mut Pad, out: Out| {
        if !pad.held.contains(&out) {
            pad.held.push(out);
        }
    };
    for (_, gp) in gilrs.gamepads() {
        any = true;
        for &(button, out) in layout {
            if gp.is_pressed(button) {
                hold(&mut pad, out);
            }
        }
        strongest(&mut pad.left, gp.value(Axis::LeftStickX), gp.value(Axis::LeftStickY));
        strongest(&mut pad.right, gp.value(Axis::RightStickX), gp.value(Axis::RightStickY));
        if mode == Mode::Game {
            // Analog triggers (gilrs: LeftTrigger2 / RightTrigger2) are the clicks.
            let trigger = |b: Button| gp.button_data(b).map(|d| d.value()).unwrap_or(0.0) > TRIGGER || gp.is_pressed(b);
            if trigger(Button::RightTrigger2) {
                hold(&mut pad, Out::LeftClick);
            }
            if trigger(Button::LeftTrigger2) {
                hold(&mut pad, Out::RightClick);
            }
        }
    }
    if mode == Mode::Game {
        let (lx, ly) = pad.left;
        for (on, scan) in [(ly > STICK_KEY, sc::W), (ly < -STICK_KEY, sc::S), (lx < -STICK_KEY, sc::A), (lx > STICK_KEY, sc::D)] {
            if on {
                hold(&mut pad, Out::Key(scan));
            }
        }
    }
    any.then_some(pad)
}

/// Stick → amount this tick: a dead zone, then a curve for fine control.
fn curve(v: f32, max: f32) -> f32 {
    let a = v.abs();
    if a < DEADZONE {
        return 0.0;
    }
    let t = ((a - DEADZONE) / (1.0 - DEADZONE)).min(1.0);
    v.signum() * t * t * max
}

fn press(out: Out, down: bool) -> Option<INPUT> {
    Some(match out {
        Out::Key(scan) => key(scan, false, !down),
        Out::Ext(scan) => key(scan, true, !down),
        Out::LeftClick => mouse(if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP }, 0, 0, 0),
        Out::RightClick => mouse(if down { MOUSEEVENTF_RIGHTDOWN } else { MOUSEEVENTF_RIGHTUP }, 0, 0, 0),
        Out::Wheel(notches) if down => mouse(MOUSEEVENTF_WHEEL, 0, 0, notches * WHEEL_NOTCH),
        Out::Wheel(_) | Out::Osk => return None,
    })
}

fn translate(run: u64) {
    let Ok(mut gilrs) = Gilrs::new() else {
        super::log("Mando: no se pueden leer los mandos de este PC");
        MODE.store(Mode::Off as u8, Ordering::Release);
        return;
    };
    let started = Instant::now();
    let mut last_pad: Option<Instant> = None;
    let mut held: Vec<Out> = Vec::new();
    let mut layout = mode();
    let mut wheel_at: Option<Instant> = None;
    let mut rest = (0.0f32, 0.0f32);
    let mut scroll = 0.0f32;

    loop {
        let now_mode = mode();
        if now_mode == Mode::Off || RUN.load(Ordering::Acquire) != run {
            break;
        }
        let mut inputs: Vec<INPUT> = Vec::new();
        // Another layout: let go of everything the old one held.
        if now_mode != layout {
            inputs.extend(held.drain(..).filter_map(|o| press(o, false)));
            layout = now_mode;
        }

        while gilrs.next_event().is_some() {}
        let now = Instant::now();
        let pad = read(&gilrs, layout);
        if pad.is_some() {
            last_pad = Some(now);
        }
        let gone = match last_pad {
            Some(at) => now - at > NO_PAD,
            None => now - started > FIRST_PAD,
        };
        if gone {
            super::log("Mando: ya no hay mando (fin de la partida)");
            MODE.store(Mode::Off as u8, Ordering::Release);
            break;
        }
        let pad = pad.unwrap_or_default();

        for out in held.iter().filter(|o| !pad.held.contains(o)) {
            inputs.extend(press(*out, false));
        }
        for out in pad.held.iter().filter(|o| !held.contains(o)) {
            match out {
                Out::Osk => on_screen_keyboard(),
                Out::Wheel(_) => {
                    inputs.extend(press(*out, true));
                    wheel_at = Some(now);
                }
                _ => inputs.extend(press(*out, true)),
            }
        }
        // A held wheel button keeps scrolling, like holding a key.
        if wheel_at.is_some_and(|at| now - at >= WHEEL_REPEAT) {
            for out in pad.held.iter().filter(|o| matches!(o, Out::Wheel(_)) && held.contains(o)) {
                inputs.extend(press(*out, true));
            }
            wheel_at = Some(now);
        }
        held = pad.held;

        // Mouse: the right stick aims in games, the left one points on the desktop.
        // Fractions are kept so slow movements still add up.
        let (stick, speed) = if layout == Mode::Desktop { (pad.left, POINT_SPEED) } else { (pad.right, LOOK_SPEED) };
        rest.0 += curve(stick.0, speed);
        rest.1 -= curve(stick.1, speed);
        let (dx, dy) = (rest.0.trunc() as i32, rest.1.trunc() as i32);
        if dx != 0 || dy != 0 {
            rest.0 -= dx as f32;
            rest.1 -= dy as f32;
            inputs.push(mouse(MOUSEEVENTF_MOVE, dx, dy, 0));
        }
        if layout == Mode::Desktop {
            scroll += curve(pad.right.1, SCROLL_SPEED);
            let notches = scroll.trunc() as i32;
            if notches != 0 {
                scroll -= notches as f32;
                inputs.push(mouse(MOUSEEVENTF_WHEEL, 0, 0, notches * WHEEL_NOTCH));
            }
        }
        send(&inputs);
        thread::sleep(TICK);
    }

    // Never leave a key or a button stuck down.
    let release: Vec<INPUT> = held.iter().filter_map(|o| press(*o, false)).collect();
    send(&release);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sticks_have_a_dead_zone_and_a_curve() {
        assert_eq!(curve(0.05, LOOK_SPEED), 0.0);
        assert_eq!(curve(-0.1, LOOK_SPEED), 0.0);
        assert!((curve(1.0, LOOK_SPEED) - LOOK_SPEED).abs() < 1e-4);
        assert!((curve(-1.0, LOOK_SPEED) + LOOK_SPEED).abs() < 1e-4);
        // Half way is much slower than half speed: fine aiming.
        assert!(curve(0.5, LOOK_SPEED) < LOOK_SPEED / 2.0);
    }

    #[test]
    fn every_control_does_one_thing() {
        for layout in [&GAME[..], &DESKTOP[..]] {
            let mut seen = Vec::new();
            for (button, _) in layout {
                assert!(!seen.contains(button), "{button:?} repetido");
                seen.push(*button);
            }
        }
    }

    #[test]
    fn modes_round_trip() {
        for m in [Mode::Off, Mode::Game, Mode::Desktop] {
            assert_eq!(Mode::from(m as u8), m);
        }
    }
}
