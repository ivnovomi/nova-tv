mod commands;
mod config;
mod gamewatch;
mod history;
mod livetv;
mod livetv_health;
mod location;
mod metadata;
mod net;
mod nowplaying;
mod osd;
mod playtime;
mod plugins;
mod power;
mod profiles;
mod remote;
mod search;
mod session;
mod sources;
mod splash;
mod twitch;
mod updates;

use commands::{applications, media, system};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub config: config::ConfigStore,
    pub sys: Mutex<system::SysMonitor>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Driven only from Rust (updates.rs): the interface has no updater permissions.
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Registers nothing by itself: the user turns it on in Ajustes.
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--autostart"])))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _key, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        session::go_home(app);
                    }
                })
                .build(),
        )
        .on_window_event(|window, event| {
            match event {
                // Back in NOVA while a Store app (untracked) is open: release the Home key.
                tauri::WindowEvent::Focused(true) => {
                    if window.label() == "main" && session::is_untracked() {
                        session::end(window.app_handle(), false);
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    if window.label().starts_with(commands::player::LABEL_PREFIX) {
                        session::window_destroyed(window.app_handle(), window.label());
                    }
                }
                _ => {}
            }
        })
        .setup(|app| {
            session::spawn_gamepad_listener(app.handle().clone());
            let dir = app.path().app_config_dir()?;
            // Settings that can't be saved are lost at the next restart: say so (at most once a minute).
            let handle = app.handle().clone();
            let last = Mutex::new(None::<std::time::Instant>);
            config::on_save_error(move |error| {
                let mut last = last.lock().unwrap_or_else(|p| p.into_inner());
                if last.is_none_or(|t| t.elapsed() > std::time::Duration::from_secs(60)) {
                    *last = Some(std::time::Instant::now());
                    let _ = handle.emit("config-save-failed", error.to_string());
                }
            });
            app.manage(AppState {
                config: config::ConfigStore::load(&dir),
                sys: Mutex::new(system::SysMonitor::new()),
            });
            profiles::init(&app.state::<AppState>());
            app.manage(history::HistoryStore::load(&dir));
            app.manage(metadata::MetadataStore::load(&dir));
            app.manage(playtime::PlaytimeStore::load(&dir));
            app.manage(livetv::LiveTv::new(&dir));
            app.manage(livetv_health::HealthStore::load(&dir));
            nowplaying::spawn_watcher(app.handle().clone());
            history::spawn_flusher(app.handle().clone());
            remote::start(app.handle());
            app.manage(plugins::registry::Registry::new(app.handle()));
            plugins::tv::init(app.handle());
            plugins::dev::spawn(app.handle().clone());
            plugins::store::clean_downloads(app.handle());
            osd::spawn(app.handle().clone());
            app.manage(updates::Updates::default());
            updates::spawn_checker(app.handle().clone());
            updates::clean_leftovers(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            applications::list_library,
            applications::add_executable,
            applications::add_steam_game,
            applications::add_web_app,
            applications::remove_shortcut,
            applications::launch_shortcut,
            applications::parental_catalog,
            profiles::profiles_get,
            profiles::profile_save,
            profiles::profile_delete,
            profiles::profile_switch,
            profiles::parental_set_pin,
            profiles::parental_remove_pin,
            profiles::parental_unlock,
            profiles::parental_lock,
            media::open_media,
            media::list_recent_media,
            media::forget_media,
            media::media_extensions,
            system::get_system_info,
            system::get_system_stats,
            system::open_windows_settings,
            system::get_volume,
            system::set_volume,
            system::set_mute,
            remote::remote_info,
            remote::remote_set_enabled,
            remote::remote_revoke,
            remote::remote_new_pin,
            remote::api::remote_publish,
            history::history_list,
            history::history_remove,
            history::history_clear,
            history::youtube_feed,
            history::play_youtube,
            sources::sources_status,
            sources::sources_probe,
            plugins::registry::plugins_list,
            plugins::registry::plugins_rows,
            plugins::registry::plugins_set_developer,
            plugins::registry::plugins_inspect,
            plugins::registry::plugins_install,
            plugins::registry::plugins_uninstall,
            plugins::registry::plugins_set_enabled,
            plugins::registry::plugins_set_kids,
            plugins::registry::plugins_set_setting,
            plugins::registry::plugins_rollback,
            plugins::registry::plugins_log,
            plugins::store::store_catalog,
            plugins::store::store_install,
            plugins::registry::plugins_account,
            plugins::registry::plugins_account_start,
            plugins::registry::plugins_account_poll,
            plugins::registry::plugins_account_sign_out,
            plugins::registry::plugins_search,
            plugins::registry::plugins_screensaver,
            location::location_search,
            location::location_get,
            location::location_set,
            plugins::tv::plugins_stream,
            plugins::tv::plugins_playlist,
            splash::splash_step,
            splash::splash_done,
            power::power_info,
            power::power_action,
            power::power_timer,
            updates::updates_status,
            updates::updates_check,
            updates::updates_set_auto,
            updates::updates_skip,
            updates::updates_install,
            twitch::twitch_live,
            twitch::twitch_play,
            history::player_report,
            session::list_gamepads,
            metadata::game_metadata,
            metadata::rescan_games,
            playtime::playtime,
            nowplaying::now_playing,
            nowplaying::media_control,
            search::search_files,
            search::youtube_search,
            livetv::livetv_channels,
            livetv::livetv_epg,
            livetv::livetv_set_favorite,
            livetv::livetv_set_last,
            livetv::livetv_add_playlist,
            livetv::livetv_remove_playlist,
            livetv::livetv_set_world,
            livetv::livetv_set_twitch,
            livetv::livetv_check_now,
            livetv_health::livetv_health,
            livetv_health::livetv_report,
        ])
        .build(tauri::generate_context!())
        .expect("error while building NOVA TV")
        .run(|app, event| {
            // Never lose the last minutes of watch progress.
            if let tauri::RunEvent::Exit = event {
                app.state::<history::HistoryStore>().flush();
            }
        });
}
