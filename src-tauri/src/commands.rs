//! The complete IPC surface. Every command is narrow and typed; there is no
//! generic exec, no shell plugin, and no path passed through from JavaScript
//! except through the dialog plugin's user-chosen file handles.

use std::sync::{Arc, Mutex};

use livetopo_probe::engine::{run_once, EngineEvent, SessionState};
use livetopo_probe::{Engine, ProbeConfig, ProbeResult, ProbeSnapshot};
use rusqlite::Connection;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{self, EventRow, ProjectMeta, ProjectPackage};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub db: Mutex<Connection>,
    pub session_id: Mutex<Option<String>>,
    pub project_id: Mutex<Option<String>>,
}

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

// ---------------------------------------------------------------- projects

#[tauri::command]
pub fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<ProjectMeta>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_projects(&conn).map_err(db_err)
}

#[tauri::command]
pub fn save_project(state: State<'_, AppState>, package: ProjectPackage) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::upsert_project(&conn, &package).map_err(db_err)
}

#[tauri::command]
pub fn load_project(state: State<'_, AppState>, id: String) -> CmdResult<Option<ProjectPackage>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::load_project(&conn, &id).map_err(db_err)
}

#[tauri::command]
pub fn delete_project(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::delete_project(&conn, &id).map_err(db_err)
}

#[tauri::command]
pub fn set_project_archived(
    state: State<'_, AppState>,
    id: String,
    archived: bool,
) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::set_archived(&conn, &id, archived).map_err(db_err)
}

// ------------------------------------------------------------------ probes

/// One-off test. Runs exactly once and registers no schedule, so `Test Now`
/// can never leave background monitoring behind (test case 12).
#[tauri::command]
pub async fn test_probe_now(config: ProbeConfig) -> CmdResult<ProbeResult> {
    Ok(run_once(&config).await)
}

/// Validate a target without probing it — used for live inspector feedback.
#[tauri::command]
pub fn validate_target(target: String) -> CmdResult<String> {
    livetopo_probe::parse_target(&target)
        .map(|t| t.as_str())
        .map_err(|e| e.to_string())
}

// ------------------------------------------------------------- validation

#[derive(Serialize, Clone)]
pub struct SessionInfo {
    pub session_id: Option<String>,
    pub project_id: Option<String>,
    pub state: SessionState,
    pub probe_count: usize,
}

#[tauri::command]
pub async fn start_validation(
    state: State<'_, AppState>,
    project_id: String,
    operator: String,
    probes: Vec<ProbeConfig>,
) -> CmdResult<SessionInfo> {
    // Switching projects always stops the prior session first.
    stop_internal(&state).await?;

    let session_id = Uuid::new_v4().to_string();
    {
        let conn = state.db.lock().map_err(db_err)?;
        db::open_session(&conn, &session_id, &project_id, &operator).map_err(db_err)?;
    }

    let count = state
        .engine
        .start(session_id.clone(), project_id.clone(), probes)
        .await?;

    *state.session_id.lock().map_err(db_err)? = Some(session_id.clone());
    *state.project_id.lock().map_err(db_err)? = Some(project_id.clone());

    Ok(SessionInfo {
        session_id: Some(session_id),
        project_id: Some(project_id),
        state: SessionState::Running,
        probe_count: count,
    })
}

#[tauri::command]
pub async fn stop_validation(state: State<'_, AppState>) -> CmdResult<SessionInfo> {
    stop_internal(&state).await?;
    Ok(SessionInfo {
        session_id: None,
        project_id: None,
        state: SessionState::Stopped,
        probe_count: 0,
    })
}

async fn stop_internal(state: &State<'_, AppState>) -> CmdResult<()> {
    state.engine.stop().await;
    let sid = state.session_id.lock().map_err(db_err)?.take();
    *state.project_id.lock().map_err(db_err)? = None;
    if let Some(sid) = sid {
        let conn = state.db.lock().map_err(db_err)?;
        db::close_session(&conn, &sid).map_err(db_err)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn session_status(state: State<'_, AppState>) -> CmdResult<SessionInfo> {
    let engine_state = state.engine.session_state().await;
    let snapshot = state.engine.snapshot().await;
    let project_id = state.engine.active_project().await;
    // Every await happens above. A std::sync::MutexGuard is !Send, so taking
    // this lock inside the struct literal below would hold it across the
    // `active_project().await` and make the whole future !Send, which Tauri
    // rejects. Bind it after the last await instead.
    let session_id = state.session_id.lock().map_err(db_err)?.clone();
    Ok(SessionInfo {
        session_id,
        project_id,
        state: engine_state,
        probe_count: snapshot.len(),
    })
}

#[tauri::command]
pub async fn probe_snapshot(state: State<'_, AppState>) -> CmdResult<Vec<ProbeSnapshot>> {
    Ok(state.engine.snapshot().await)
}

// ------------------------------------------------------------------ events

#[tauri::command]
pub fn list_events(
    state: State<'_, AppState>,
    project_id: String,
    limit: Option<i64>,
) -> CmdResult<Vec<EventRow>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::list_events(&conn, &project_id, limit.unwrap_or(2000)).map_err(db_err)
}

/// The frontend records the object *name* alongside the transition, because the
/// engine only knows ids.
#[tauri::command]
pub fn record_event(state: State<'_, AppState>, event: EventRow) -> CmdResult<()> {
    let conn = state.db.lock().map_err(db_err)?;
    db::insert_event(&conn, &event).map_err(db_err)
}

#[tauri::command]
pub fn app_info() -> CmdResult<serde_json::Value> {
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "dataDir": db::data_dir().to_string_lossy(),
        "schemaVersion": db::SCHEMA_VERSION,
        "documentVersion": db::DOCUMENT_VERSION,
    }))
}

/// Forward engine events to the webview. Runs for the life of the process.
pub fn pump_events(app: AppHandle, mut rx: tokio::sync::mpsc::UnboundedReceiver<EngineEvent>) {
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = app.emit("livetopo://engine", &event);
        }
    });
}

// ------------------------------------------------------------------- icons

/// Index a user-chosen folder of SVGs as an icon library.
///
/// The artwork stays on disk in the operator's own directory; nothing is
/// bundled or committed. Returns sanitised SVG source plus the list of files
/// that were skipped and why, so the palette can say what it could not read
/// rather than quietly showing fewer icons.
#[tauri::command]
pub fn list_icon_library(dir: String) -> CmdResult<crate::icons::IconLibrary> {
    crate::icons::scan(&dir)
}
