// Windows: no console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod icons;
mod shapeconv;
mod commands;
mod discovery;
mod vault_commands;
mod db;

use std::sync::{Arc, Mutex};

use commands::AppState;
use coreview_probe::{Engine, DEFAULT_MAX_CONCURRENCY};
use tauri::{Manager, RunEvent, WindowEvent};

/// Sizes the window to the screen it opens on.
///
/// A fixed default cannot fit every display: 1600x1000 is comfortable on a
/// desktop and larger than the whole screen on a 1366x768 laptop, where the
/// window opens with its edges off the display and its buttons unreachable.
/// Scaled displays make it worse — 1920x1080 at 150% is 1280x720 of usable
/// space, and nothing about the reported resolution says so.
///
/// So the window is asked for a proportion of whatever it actually opens on,
/// capped at a size beyond which more pixels stop helping, and floored at the
/// smallest layout that still works. Failure is silent and harmless: the
/// window keeps the size from the config, which is what happened before.
fn fit_to_screen(app: &tauri::App) {
    use tauri::{LogicalSize, Manager};

    const MAX_W: f64 = 1600.0;
    const MAX_H: f64 = 1000.0;
    const MIN_W: f64 = 900.0;
    const MIN_H: f64 = 600.0;
    // Leaves room for a taskbar, dock or panel, which no API reliably reports.
    const OF_SCREEN: f64 = 0.9;

    let Some(window) = app.get_webview_window("main") else { return };
    let Ok(Some(monitor)) = window.current_monitor() else { return };

    let scale = monitor.scale_factor();
    let size = monitor.size().to_logical::<f64>(scale);

    let width = (size.width * OF_SCREEN).clamp(MIN_W, MAX_W);
    let height = (size.height * OF_SCREEN).clamp(MIN_H, MAX_H);

    let _ = window.set_size(LogicalSize::new(width, height));

    // Positioned explicitly rather than with center(). That reads the window's
    // current size to work out where the middle is, and the resize above has
    // not necessarily been applied by the time it looks — so it centred a
    // window it believed had no size and put the top-left at the middle of the
    // screen, leaving more than half the window off the display. Computing the
    // position from the size just asked for has no such race.
    let x = ((size.width - width) / 2.0).max(0.0);
    let y = ((size.height - height) / 2.0).max(0.0);
    let _ = window.set_position(tauri::LogicalPosition::new(x, y));
}

fn main() {
    let db_path = db::data_dir().join("coreview.db");
    let conn = db::open(&db_path).expect("could not open the local Coreview database");
    let (engine, rx) = Engine::new(DEFAULT_MAX_CONCURRENCY);
    let engine_for_exit = Arc::clone(&engine);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            engine,
            db: Mutex::new(conn),
            session_id: Mutex::new(None),
            project_id: Mutex::new(None),
            sweep_cancel: Mutex::new(None),
            crawl_cancel: Mutex::new(None),
            backup_cancel: Mutex::new(None),
            vault_key: Mutex::new(None),
        })
        .setup(move |app| {
            commands::pump_events(app.handle().clone(), rx);
            fit_to_screen(app);
            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the window must stop probing before the process exits.
            if let WindowEvent::CloseRequested { .. } = event {
                let state = window.state::<AppState>();
                let engine = Arc::clone(&state.engine);
                tauri::async_runtime::block_on(async move { engine.stop().await });
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_projects,
            commands::save_project,
            commands::load_project,
            commands::delete_project,
            commands::set_project_archived,
            commands::test_probe_now,
            commands::validate_target,
            commands::start_validation,
            commands::stop_validation,
            commands::session_status,
            commands::probe_snapshot,
            commands::list_events,
            commands::record_event,
            commands::app_info,
            commands::list_icon_library,
            commands::save_export,
            commands::read_import,
            commands::get_settings,
            commands::set_setting,
            commands::check_folder_writable,
            commands::start_sweep,
            commands::cancel_sweep,
            commands::describe_subnet,
            discovery::start_crawl,
            discovery::cancel_crawl,
            discovery::start_backup,
            discovery::cancel_backup,
            discovery::list_backup_devices,
            discovery::list_device_captures,
            discovery::read_capture,
            discovery::diff_captures,
            discovery::list_host_keys,
            discovery::clear_host_keys,
            discovery::forget_host_key,
            vault_commands::vault_status,
            vault_commands::create_vault,
            vault_commands::unlock_vault,
            vault_commands::lock_vault,
            vault_commands::discard_vault,
            vault_commands::save_credential,
            vault_commands::list_credentials,
            vault_commands::reveal_credential,
            vault_commands::export_vault,
            vault_commands::import_vault,
            vault_commands::delete_credential,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Coreview")
        .run(move |_app, event| {
            if let RunEvent::Exit = event {
                let engine = Arc::clone(&engine_for_exit);
                tauri::async_runtime::block_on(async move { engine.stop().await });
            }
        });
}
