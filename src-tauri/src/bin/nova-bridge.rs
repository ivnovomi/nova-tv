// NovaBridge: lets NOVA play this PC's games through Moonlight (no console window).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    nova_tv_lib::bridge::run();
}
