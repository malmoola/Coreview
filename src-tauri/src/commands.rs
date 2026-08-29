//! The complete IPC surface. Every command is narrow and typed; there is no
//! generic exec, no shell plugin, and no path passed through from JavaScript
//! except through the dialog plugin's user-chosen file handles.

use std::sync::{Arc, Mutex};

use coreview_probe::engine::{run_once, EngineEvent, SessionState};
use coreview_probe::sweep::{parse_sweepable_cidr, sweep, SweepEvent, SweepOptions};
use coreview_probe::{Engine, ProbeConfig, ProbeResult, ProbeSnapshot};
use base64::Engine as _;
use rusqlite::Connection;
use tokio_util::sync::CancellationToken;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::db::{self, EventRow, ProjectMeta, ProjectPackage};

pub struct AppState {
    pub engine: Arc<Engine>,
    pub db: Mutex<Connection>,
    pub session_id: Mutex<Option<String>>,
    pub project_id: Mutex<Option<String>>,
    /// Cancels the sweep that is currently running, if any. A sweep is a
    /// one-shot job rather than a session, so it needs its own handle — the
    /// validation engine's Stop must not cancel a discovery scan, and vice
    /// versa.
    pub sweep_cancel: Mutex<Option<CancellationToken>>,
    /// Cancels the running crawl. Separate from the sweep and the backup: they
    /// are three different jobs and stopping one must not stop the others.
    pub crawl_cancel: Mutex<Option<CancellationToken>>,
    pub backup_cancel: Mutex<Option<CancellationToken>>,
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
    coreview_probe::parse_target(&target)
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
            let _ = app.emit("coreview://engine", &event);
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

// ------------------------------------------------------------------ exports

/// Writes an export to the path the user picked in the save dialog.
///
/// This is the only way anything in the webview can write to disk: there is no
/// filesystem plugin, so the frontend cannot name a path on its own — it can
/// only pass back one the user chose in a native dialog.
///
/// Bytes arrive base64-encoded because one of the five exports (PNG) is binary
/// and the other four are text. Encoding them all the same way keeps this to a
/// single command rather than a text one and a binary one.
#[tauri::command]
pub fn save_export(path: String, contents_b64: String) -> CmdResult<()> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(contents_b64.as_bytes())
        .map_err(|e| format!("Export could not be encoded: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("Could not write {path}: {e}"))
}

#[cfg(test)]
mod export_tests {
    use super::*;

    #[test]
    fn writes_decoded_bytes_to_the_given_path() {
        let dir = std::env::temp_dir().join(format!("coreview-export-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("diagram.png");
        // PNG magic, so this also covers the binary case rather than only text.
        let png = [0x89u8, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        let b64 = base64::engine::general_purpose::STANDARD.encode(png);

        save_export(path.to_string_lossy().into_owned(), b64).unwrap();

        assert_eq!(std::fs::read(&path).unwrap(), png);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn rejects_a_payload_that_is_not_base64() {
        let path = std::env::temp_dir().join("coreview-should-not-appear");
        std::fs::remove_file(&path).ok();

        let err = save_export(path.to_string_lossy().into_owned(), "not base64!!".into())
            .unwrap_err();

        assert!(err.contains("could not be encoded"), "unexpected error: {err}");
        // Fail closed: a bad payload must not leave a truncated or empty file.
        assert!(!path.exists());
    }

    #[test]
    fn reports_the_path_when_the_directory_does_not_exist() {
        let path = std::env::temp_dir().join("coreview-no-such-dir").join("x.svg");
        let err = save_export(path.to_string_lossy().into_owned(), String::new()).unwrap_err();
        assert!(err.contains("Could not write"), "unexpected error: {err}");
    }
}

// ----------------------------------------------------------------- settings

/// Every stored preference, read once on startup.
///
/// These are the folders the user has chosen — backups, exports, icon library
/// — and nothing else. No secret is stored here: the table is unencrypted and
/// sits in the same database as the projects.
#[tauri::command]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<std::collections::HashMap<String, String>> {
    let conn = state.db.lock().map_err(db_err)?;
    db::all_settings(&conn).map_err(db_err)
}

/// Stores a preference, or clears it when `value` is absent or empty.
#[tauri::command]
pub fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: Option<String>,
) -> CmdResult<()> {
    // A fixed key list rather than an open map: this table is read on startup
    // and fed straight into the UI, and an unbounded key space invites it
    // becoming a dumping ground for things that belong in a typed column.
    const ALLOWED: [&str; 4] = ["backupFolder", "exportFolder", "iconLibraryDir", "addressPreference"];
    if !ALLOWED.contains(&key.as_str()) {
        return Err(format!("{key} is not a setting Coreview stores"));
    }
    let conn = state.db.lock().map_err(db_err)?;
    db::set_setting(&conn, &key, value.as_deref()).map_err(db_err)
}

/// Confirms a chosen folder is usable before it is stored.
///
/// The folder picker returns a path the user selected, but selecting a folder
/// is not the same as being able to write into it — a read-only mount or a
/// removed USB stick both pick cleanly and fail later, at which point the
/// failure looks like the backup feature being broken.
#[tauri::command]
pub fn check_folder_writable(path: String) -> CmdResult<()> {
    let dir = std::path::Path::new(&path);
    if !dir.is_dir() {
        return Err(format!("{path} is not a folder"));
    }
    let probe = dir.join(".coreview-write-test");
    std::fs::write(&probe, b"")
        .map_err(|e| format!("Coreview cannot write into {path}: {e}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

// ---------------------------------------------------------------- discovery

/// Starts a ping sweep of one subnet, streaming results as hosts answer.
///
/// Returns as soon as the sweep is scheduled; progress and hits arrive on the
/// `coreview://sweep` event. A /24 takes the better part of a minute even at
/// full concurrency, and a caller blocked on the whole thing could not draw a
/// progress bar or offer a Stop button.
///
/// Starting a sweep cancels any sweep already running. Two at once would fight
/// over the same concurrency budget and report interleaved progress that adds
/// up to nothing sensible.
#[tauri::command]
pub async fn start_sweep(
    app: AppHandle,
    state: State<'_, AppState>,
    subnet: String,
    options: SweepOptions,
) -> CmdResult<u32> {
    // Parsed here, before anything is spawned, so a typo comes back as an
    // error on the button press rather than as a sweep that finds nothing.
    let cidr = parse_sweepable_cidr(&subnet).map_err(|e| e.to_string())?;
    let total = cidr.host_count();

    let token = CancellationToken::new();
    {
        let mut slot = state.sweep_cancel.lock().map_err(db_err)?;
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SweepEvent>(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = emitter.emit("coreview://sweep", &event);
        }
    });

    tauri::async_runtime::spawn(async move {
        sweep(cidr, options, tx, token).await;
    });

    Ok(total)
}

/// Stops the running sweep. Harmless when none is running, so the UI can call
/// it without first asking whether there is anything to stop.
#[tauri::command]
pub fn cancel_sweep(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(token) = state.sweep_cancel.lock().map_err(db_err)?.take() {
        token.cancel();
    }
    Ok(())
}

/// Checks a subnet without starting anything, so the form can say what is
/// wrong — and how many addresses are involved — while it is being typed.
#[tauri::command]
pub fn describe_subnet(subnet: String) -> CmdResult<SubnetInfo> {
    let cidr = parse_sweepable_cidr(&subnet).map_err(|e| e.to_string())?;
    Ok(SubnetInfo {
        network: cidr.network().to_string(),
        broadcast: cidr.broadcast().to_string(),
        prefix: cidr.prefix(),
        hosts: cidr.host_count(),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubnetInfo {
    pub network: String,
    pub broadcast: String,
    pub prefix: u8,
    pub hosts: u32,
}
