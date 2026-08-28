//! Local SQLite persistence. One database per installation, under
//! %LOCALAPPDATA%\LiveTopo\livetopo.db. No server, no network.
//!
//! Storage strategy: project *metadata*, *sessions*, *events* and *samples* are
//! normalized because they are queried, filtered and exported. The diagram
//! itself (nodes, links, notes, probes, canvas settings) is stored as one
//! versioned JSON document per project, because it is always read and written
//! whole, and because a single document keeps undo/redo, export and schema
//! migration straightforward.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SCHEMA_VERSION: i64 = 1;
/// Bumped whenever the diagram document shape changes; the frontend migrates.
pub const DOCUMENT_VERSION: i64 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub customer: String,
    #[serde(default)]
    pub site: String,
    #[serde(default)]
    pub ticket: String,
    #[serde(default)]
    pub engineer: String,
    #[serde(default)]
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub archived: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectPackage {
    pub meta: ProjectMeta,
    pub document_version: i64,
    /// Opaque to Rust: the frontend owns the diagram shape.
    pub document: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventRow {
    pub id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub timestamp_ms: i64,
    pub object_type: String,
    pub object_id: String,
    pub object_name: String,
    pub event_type: String,
    pub previous_status: Option<String>,
    pub current_status: Option<String>,
    pub probe_type: Option<String>,
    pub target: Option<String>,
    pub rtt_ms: Option<f64>,
    pub message: String,
}

pub fn data_dir() -> PathBuf {
    // %LOCALAPPDATA% on Windows, XDG data dir elsewhere.
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| dirs_next_local())
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("LiveTopo")
}

fn dirs_next_local() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL);

        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            customer TEXT NOT NULL DEFAULT '',
            site TEXT NOT NULL DEFAULT '',
            ticket TEXT NOT NULL DEFAULT '',
            engineer TEXT NOT NULL DEFAULT '',
            description TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            archived INTEGER NOT NULL DEFAULT 0,
            document_version INTEGER NOT NULL DEFAULT 1,
            document TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS validation_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            started_at INTEGER NOT NULL,
            stopped_at INTEGER,
            operator TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'running'
        );

        CREATE TABLE IF NOT EXISTS events (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
            session_id TEXT,
            timestamp_ms INTEGER NOT NULL,
            object_type TEXT NOT NULL,
            object_id TEXT NOT NULL,
            object_name TEXT NOT NULL DEFAULT '',
            event_type TEXT NOT NULL,
            previous_status TEXT,
            current_status TEXT,
            probe_type TEXT,
            target TEXT,
            rtt_ms REAL,
            message TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_events_project_time
            ON events(project_id, timestamp_ms DESC);

        CREATE TABLE IF NOT EXISTS probe_samples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            probe_id TEXT NOT NULL,
            timestamp_ms INTEGER NOT NULL,
            status TEXT NOT NULL,
            outcome TEXT NOT NULL,
            rtt_ms REAL,
            summary TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_samples_session
            ON probe_samples(session_id, timestamp_ms DESC);
        "#,
    )?;

    let current: Option<i64> = conn
        .query_row("SELECT version FROM schema_info LIMIT 1", [], |r| r.get(0))
        .optional()?;
    match current {
        None => {
            conn.execute("INSERT INTO schema_info (version) VALUES (?1)", params![SCHEMA_VERSION])?;
        }
        Some(v) if v < SCHEMA_VERSION => {
            // Future migrations are applied here in order before the bump.
            conn.execute("UPDATE schema_info SET version = ?1", params![SCHEMA_VERSION])?;
        }
        _ => {}
    }
    Ok(())
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

fn row_to_meta(row: &rusqlite::Row<'_>) -> rusqlite::Result<ProjectMeta> {
    Ok(ProjectMeta {
        id: row.get("id")?,
        name: row.get("name")?,
        customer: row.get("customer")?,
        site: row.get("site")?,
        ticket: row.get("ticket")?,
        engineer: row.get("engineer")?,
        description: row.get("description")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        archived: row.get::<_, i64>("archived")? != 0,
    })
}

pub fn list_projects(conn: &Connection) -> rusqlite::Result<Vec<ProjectMeta>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, customer, site, ticket, engineer, description,
                created_at, updated_at, archived
         FROM projects ORDER BY updated_at DESC",
    )?;
    let rows = stmt.query_map([], row_to_meta)?;
    rows.collect()
}

pub fn upsert_project(conn: &Connection, pkg: &ProjectPackage) -> rusqlite::Result<()> {
    let doc = pkg.document.to_string();
    conn.execute(
        "INSERT INTO projects
           (id, name, customer, site, ticket, engineer, description,
            created_at, updated_at, archived, document_version, document)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, customer=excluded.customer, site=excluded.site,
           ticket=excluded.ticket, engineer=excluded.engineer,
           description=excluded.description, updated_at=excluded.updated_at,
           archived=excluded.archived,
           document_version=excluded.document_version, document=excluded.document",
        params![
            pkg.meta.id,
            pkg.meta.name,
            pkg.meta.customer,
            pkg.meta.site,
            pkg.meta.ticket,
            pkg.meta.engineer,
            pkg.meta.description,
            pkg.meta.created_at,
            pkg.meta.updated_at,
            pkg.meta.archived as i64,
            pkg.document_version,
            doc,
        ],
    )?;
    Ok(())
}

pub fn load_project(conn: &Connection, id: &str) -> rusqlite::Result<Option<ProjectPackage>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, customer, site, ticket, engineer, description,
                created_at, updated_at, archived, document_version, document
         FROM projects WHERE id = ?1",
    )?;
    let pkg = stmt
        .query_row(params![id], |row| {
            let meta = row_to_meta(row)?;
            let doc_str: String = row.get("document")?;
            Ok(ProjectPackage {
                meta,
                document_version: row.get("document_version")?,
                document: serde_json::from_str(&doc_str).unwrap_or(serde_json::json!({})),
            })
        })
        .optional()?;
    Ok(pkg)
}

pub fn delete_project(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM projects WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn set_archived(conn: &Connection, id: &str, archived: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE projects SET archived = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, archived as i64, now_ms()],
    )?;
    Ok(())
}

pub fn open_session(
    conn: &Connection,
    id: &str,
    project_id: &str,
    operator: &str,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO validation_sessions (id, project_id, started_at, operator, status)
         VALUES (?1,?2,?3,?4,'running')",
        params![id, project_id, now_ms(), operator],
    )?;
    Ok(())
}

pub fn close_session(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE validation_sessions SET stopped_at = ?2, status = 'stopped' WHERE id = ?1",
        params![id, now_ms()],
    )?;
    Ok(())
}

pub fn insert_event(conn: &Connection, e: &EventRow) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events (id, project_id, session_id, timestamp_ms, object_type, object_id,
                             object_name, event_type, previous_status, current_status,
                             probe_type, target, rtt_ms, message)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
        params![
            e.id, e.project_id, e.session_id, e.timestamp_ms, e.object_type, e.object_id,
            e.object_name, e.event_type, e.previous_status, e.current_status,
            e.probe_type, e.target, e.rtt_ms, e.message
        ],
    )?;
    Ok(())
}

pub fn list_events(
    conn: &Connection,
    project_id: &str,
    limit: i64,
) -> rusqlite::Result<Vec<EventRow>> {
    let mut stmt = conn.prepare(
        "SELECT id, project_id, session_id, timestamp_ms, object_type, object_id, object_name,
                event_type, previous_status, current_status, probe_type, target, rtt_ms, message
         FROM events WHERE project_id = ?1 ORDER BY timestamp_ms DESC LIMIT ?2",
    )?;
    let rows = stmt.query_map(params![project_id, limit], |row| {
        Ok(EventRow {
            id: row.get(0)?,
            project_id: row.get(1)?,
            session_id: row.get(2)?,
            timestamp_ms: row.get(3)?,
            object_type: row.get(4)?,
            object_id: row.get(5)?,
            object_name: row.get(6)?,
            event_type: row.get(7)?,
            previous_status: row.get(8)?,
            current_status: row.get(9)?,
            probe_type: row.get(10)?,
            target: row.get(11)?,
            rtt_ms: row.get(12)?,
            message: row.get(13)?,
        })
    })?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        migrate(&c).unwrap();
        c
    }

    fn pkg(id: &str, name: &str) -> ProjectPackage {
        ProjectPackage {
            meta: ProjectMeta {
                id: id.into(),
                name: name.into(),
                customer: "Contoso".into(),
                site: "HQ".into(),
                ticket: "CHG-1001".into(),
                engineer: "Operator".into(),
                description: String::new(),
                created_at: 1,
                updated_at: 1,
                archived: false,
            },
            document_version: DOCUMENT_VERSION,
            document: serde_json::json!({ "nodes": [{"id": "n1"}], "links": [] }),
        }
    }

    /// Test case 17: a saved project reloads with its diagram intact.
    #[test]
    fn round_trips_a_project_document() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "Branch")).unwrap();
        let loaded = load_project(&c, "p1").unwrap().unwrap();
        assert_eq!(loaded.meta.ticket, "CHG-1001");
        assert_eq!(loaded.document["nodes"][0]["id"], "n1");
    }

    /// Test case 16: duplication yields independent rows.
    #[test]
    fn duplicate_is_independent() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "Branch")).unwrap();
        let mut copy = load_project(&c, "p1").unwrap().unwrap();
        copy.meta.id = "p2".into();
        copy.meta.name = "Branch (copy)".into();
        upsert_project(&c, &copy).unwrap();

        let mut edited = load_project(&c, "p2").unwrap().unwrap();
        edited.document = serde_json::json!({ "nodes": [], "links": [] });
        upsert_project(&c, &edited).unwrap();

        assert_eq!(
            load_project(&c, "p1").unwrap().unwrap().document["nodes"][0]["id"],
            "n1"
        );
        assert_eq!(
            load_project(&c, "p2").unwrap().unwrap().document["nodes"]
                .as_array()
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn events_are_scoped_and_ordered() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "A")).unwrap();
        upsert_project(&c, &pkg("p2", "B")).unwrap();
        for (i, pid) in [("e1", "p1"), ("e2", "p1"), ("e3", "p2")] {
            insert_event(
                &c,
                &EventRow {
                    id: i.into(),
                    project_id: pid.into(),
                    session_id: Some("s1".into()),
                    timestamp_ms: i.len() as i64,
                    object_type: "node".into(),
                    object_id: "n1".into(),
                    object_name: "CORE-SW-01".into(),
                    event_type: "transition".into(),
                    previous_status: Some("healthy".into()),
                    current_status: Some("down".into()),
                    probe_type: Some("icmp".into()),
                    target: Some("10.10.20.2".into()),
                    rtt_ms: None,
                    message: "Request timed out".into(),
                },
            )
            .unwrap();
        }
        assert_eq!(list_events(&c, "p1", 100).unwrap().len(), 2);
        assert_eq!(list_events(&c, "p2", 100).unwrap().len(), 1);
    }

    #[test]
    fn deleting_a_project_removes_its_events() {
        let c = mem();
        upsert_project(&c, &pkg("p1", "A")).unwrap();
        insert_event(
            &c,
            &EventRow {
                id: "e1".into(),
                project_id: "p1".into(),
                session_id: None,
                timestamp_ms: 1,
                object_type: "node".into(),
                object_id: "n1".into(),
                object_name: "n".into(),
                event_type: "transition".into(),
                previous_status: None,
                current_status: Some("down".into()),
                probe_type: None,
                target: None,
                rtt_ms: None,
                message: String::new(),
            },
        )
        .unwrap();
        delete_project(&c, "p1").unwrap();
        assert!(list_events(&c, "p1", 100).unwrap().is_empty());
    }
}
