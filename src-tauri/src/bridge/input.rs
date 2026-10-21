//! "Mando como teclado y ratón": for games that only read keyboard and mouse.
//!
//! Sunshine turns the TV's controller into an Xbox 360 pad on this PC; while
//! this is on, NovaBridge reads it (XInput) and types keys / moves the mouse
//! with SendInput. Keys go as scan codes, so games reading the keyboard at a
//! low level (Minecraft, most PC games) see a real keyboard.
//!
//! The layout (a common PC game one, made to fit Minecraft too):
//! - left stick: W A S D        - right stick: mouse
//! - RT / LT: left / right click - RB / LB: wheel down / up (hotbar)
//! - A: space   B: shift   X: E   Y: F
//! - left stick click: ctrl (sprint)   right stick click: F5 (camera)
//! - Start: Esc   Back: Tab   D-pad: up T, down Q, left/right wheel
//!
//! It stops by itself once no controller has been seen for a while (the
//! stream ended and Sunshine removed its pad).

use gilrs::{Axis, Button, Gilrs};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE,
    MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEEVENTF_WHEEL,
    MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
};

const TICK: Duration = Duration::from_millis(8);
/// No controller for this long: the stream is over.
const NO_PAD: Duration = Duration::from_secs(12);
/// Time to wait for the stream's pad after turning it on.
const FIRST_PAD: Duration = Duration::from_secs(90);
const STICK_KEY: f32 = 0.35;
const LOOK_DEADZONE: f32 = 0.12;
/// Pixels per tick with the right stick fully pushed (~2000 px/s).
const LOOK_SPEED: f32 = 16.0;
const TRIGGER: f32 = 0.3;
const WHEEL_REPEAT: Duration = Duration::from_millis(180);
const WHEEL_NOTCH: i32 = 120;

static ON: AtomicBool = AtomicBool::new(false);
/// Each start gets a number; an older loop seeing a newer one stops.
static RUN: AtomicU64 = AtomicU64::new(0);

pub fn active() -> bool {
    ON.load(Ordering::Acquire)
}

/// Turns the translation on or off.
pub fn set(on: bool) {
    if on == active() {
        return;
    }
    ON.store(on, Ordering::Release);
    if on {
        let run = RUN.fetch_add(1, Ordering::AcqRel) + 1;
        thread::Builder::new().name("bridge-input".into()).spawn(move || translate(run)).ok();
        super::log("Mando como teclado y ratón: activado");
    } else {
        super::log("Mando como teclado y ratón: desactivado");
    }
}

// ───────────────────────── SendInput ─────────────────────────

fn key(scan: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_SCANCODE;
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

// ───────────────────────── The layout ─────────────────────────

/// What a control does on the PC.
#[derive(Clone, Copy, PartialEq, Debug)]
enum Out {
    Key(u16),
    LeftClick,
    RightClick,
    /// Mouse wheel notches (+ up, − down), repeated while held.
    Wheel(i32),
}

/// Set-1 scan codes.
mod sc {
    pub const ESC: u16 = 0x01;
    pub const TAB: u16 = 0x0F;
    pub const Q: u16 = 0x10;
    pub const W: u16 = 0x11;
    pub const E: u16 = 0x12;
    pub const T: u16 = 0x14;
    pub const A: u16 = 0x1E;
    pub const S: u16 = 0x1F;
    pub const D: u16 = 0x20;
    pub const F: u16 = 0x21;
    pub const LCTRL: u16 = 0x1D;
    pub const LSHIFT: u16 = 0x2A;
    pub const SPACE: u16 = 0x39;
    pub const F5: u16 = 0x3F;
}

const BUTTONS: [(Button, Out); 14] = [
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

/// Everything held right now, from every connected controller.
#[derive(Default)]
struct Pad {
    held: Vec<Out>,
    look: (f32, f32),
}

fn read(gilrs: &Gilrs) -> Option<Pad> {
    let mut pad = Pad::default();
    let mut any = false;
    for (_, gp) in gilrs.gamepads() {
        any = true;
        for (button, out) in BUTTONS {
            if gp.is_pressed(button) && !pad.held.contains(&out) {
                pad.held.push(out);
            }
        }
        // Analog triggers (gilrs reports them as LeftTrigger2 / RightTrigger2).
        let trigger = |b: Button| gp.button_data(b).map(|d| d.value()).unwrap_or(0.0) > TRIGGER || gp.is_pressed(b);
        if trigger(Button::RightTrigger2) && !pad.held.contains(&Out::LeftClick) {
            pad.held.push(Out::LeftClick);
        }
        if trigger(Button::LeftTrigger2) && !pad.held.contains(&Out::RightClick) {
            pad.held.push(Out::RightClick);
        }
        let (lx, ly) = (gp.value(Axis::LeftStickX), gp.value(Axis::LeftStickY));
        for (on, scan) in [(ly > STICK_KEY, sc::W), (ly < -STICK_KEY, sc::S), (lx < -STICK_KEY, sc::A), (lx > STICK_KEY, sc::D)] {
            if on && !pad.held.contains(&Out::Key(scan)) {
                pad.held.push(Out::Key(scan));
            }
        }
        let (rx, ry) = (gp.value(Axis::RightStickX), gp.value(Axis::RightStickY));
        if rx.abs() > pad.look.0.abs() {
            pad.look.0 = rx;
        }
        if ry.abs() > pad.look.1.abs() {
            pad.look.1 = ry;
        }
    }
    any.then_some(pad)
}

/// Stick → pixels this tick: a dead zone, then a curve for fine aiming.
fn look_speed(v: f32) -> f32 {
    let a = v.abs();
    if a < LOOK_DEADZONE {
        return 0.0;
    }
    let t = ((a - LOOK_DEADZONE) / (1.0 - LOOK_DEADZONE)).min(1.0);
    v.signum() * t * t * LOOK_SPEED
}

fn press(out: Out, down: bool) -> Option<INPUT> {
    Some(match out {
        Out::Key(scan) => key(scan, !down),
        Out::LeftClick => mouse(if down { MOUSEEVENTF_LEFTDOWN } else { MOUSEEVENTF_LEFTUP }, 0, 0, 0),
        Out::RightClick => mouse(if down { MOUSEEVENTF_RIGHTDOWN } else { MOUSEEVENTF_RIGHTUP }, 0, 0, 0),
        Out::Wheel(notches) if down => mouse(MOUSEEVENTF_WHEEL, 0, 0, notches * WHEEL_NOTCH),
        Out::Wheel(_) => return None,
    })
}

fn translate(run: u64) {
    let Ok(mut gilrs) = Gilrs::new() else {
        super::log("Mando como teclado y ratón: no se pueden leer los mandos de este PC");
        ON.store(false, Ordering::Release);
        return;
    };
    let started = Instant::now();
    let mut last_pad: Option<Instant> = None;
    let mut held: Vec<Out> = Vec::new();
    let mut wheel_at: Option<Instant> = None;
    let mut rest = (0.0f32, 0.0f32);

    while active() && RUN.load(Ordering::Acquire) == run {
        while gilrs.next_event().is_some() {}
        let now = Instant::now();
        let pad = read(&gilrs);
        if pad.is_some() {
            last_pad = Some(now);
        }
        let gone = match last_pad {
            Some(at) => now - at > NO_PAD,
            None => now - started > FIRST_PAD,
        };
        if gone {
            super::log("Mando como teclado y ratón: ya no hay mando (fin de la partida)");
            ON.store(false, Ordering::Release);
            break;
        }
        let pad = pad.unwrap_or_default();

        let mut inputs: Vec<INPUT> = Vec::new();
        for out in held.iter().filter(|o| !pad.held.contains(o)) {
            inputs.extend(press(*out, false));
        }
        for out in pad.held.iter().filter(|o| !held.contains(o)) {
            inputs.extend(press(*out, true));
            if matches!(out, Out::Wheel(_)) {
                wheel_at = Some(now);
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

        // Mouse: keep the fractions so slow movements still add up.
        rest.0 += look_speed(pad.look.0);
        rest.1 += -look_speed(pad.look.1);
        let (dx, dy) = (rest.0.trunc() as i32, rest.1.trunc() as i32);
        if dx != 0 || dy != 0 {
            rest.0 -= dx as f32;
            rest.1 -= dy as f32;
            inputs.push(mouse(MOUSEEVENTF_MOVE, dx, dy, 0));
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
    fn aiming_has_a_dead_zone_and_a_curve() {
        assert_eq!(look_speed(0.05), 0.0);
        assert_eq!(look_speed(-0.1), 0.0);
        assert!((look_speed(1.0) - LOOK_SPEED).abs() < 1e-4);
        assert!((look_speed(-1.0) + LOOK_SPEED).abs() < 1e-4);
        // Half way is much slower than half speed: fine aiming.
        assert!(look_speed(0.5) < LOOK_SPEED / 2.0);
    }

    #[test]
    fn every_control_does_one_thing() {
        let mut seen = Vec::new();
        for (button, _) in BUTTONS {
            assert!(!seen.contains(&button), "{button:?} repetido");
            seen.push(button);
        }
    }
}
