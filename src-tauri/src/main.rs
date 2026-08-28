// Windows: no console window in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod icons;
mod commands;
mod db;

use std::sync::{Arc, Mutex};

use commands::AppState;
use coreview_probe::{Engine, DEFAULT_MAX_CONCURRENCY};
use tauri::{Manager, RunEvent, WindowEvent};

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
        })
        .setup(move |app| {
            commands::pump_events(app.handle().clone(), rx);
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
            commands::get_settings,
            commands::set_setting,
            commands::check_folder_writable,
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
