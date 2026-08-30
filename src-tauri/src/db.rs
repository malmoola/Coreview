//! Local SQLite persistence. One database per installation, under
//! %LOCALAPPDATA%\Coreview\coreview.db. No server, no network.
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
        .or_else(dirs_next_local)
        .unwrap_or_else(|| PathBuf::from("."));
    let dir = base.join("Coreview");
    adopt_livetopo_data(&base, &dir);
    dir
}

/// Carries a pre-rename database over to the new name.
///
/// The app was called LiveTopo until 0.2.0 and kept its database in a folder
/// of that name. Renaming the product without this would leave every existing
/// project on disk but invisible, which looks exactly like data loss.
///
/// Deliberately conservative: it only acts when there is a LiveTopo folder and
/// no Coreview folder at all, so it can never overwrite newer data, and it
/// copies rather than moves — if anything here is wrong, the original is still
/// sitting there untouched. A failure is silent on purpose; a first run that
/// starts empty is recoverable, one that refuses to start is not.
fn adopt_livetopo_data(base: &Path, new_dir: &Path) {
    let old_dir = base.join("LiveTopo");
    if new_dir.exists() || !old_dir.is_dir() {
        return;
    }
    if std::fs::create_dir_all(new_dir).is_err() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&old_dir) else { return };
    for entry in entries.flatten() {
        if !entry.file_type().is_ok_and(|t| t.is_file()) {
            continue;
        }
        // The database file was renamed along with everything else, so the
        // copy has to be renamed too. Copying livetopo.db verbatim leaves it
        // sitting next to a freshly created empty coreview.db, which is the
        // data loss this whole function exists to prevent. The -wal and -shm
        // siblings are carried across under the same mapping so SQLite sees a
        // coherent set rather than a database with a stranded journal.
        let name = entry.file_name();
        let renamed = name.to_string_lossy().replace("livetopo", "coreview");
        let _ = std::fs::copy(entry.path(), new_dir.join(renamed));
    }
}

fn dirs_next_local() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local/share")))
}

/// Restricts the database to its owner.
///
/// It holds encrypted credentials, and while the encryption is what actually
/// protects them, a world-readable file hands an attacker the ciphertext and
/// the salt to work on offline at their leisure. Best effort: on Windows the
/// file inherits the folder's ACL, which is that platform's answer to the same
/// question.
fn restrict(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    migrate(&conn)?;
    // After WAL is enabled, so the sidecar files exist and get the same
    // treatment — a readable -wal is as good as a readable database.
    restrict(path);
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        let sidecar = std::path::PathBuf::from(sidecar);
        if sidecar.exists() {
            restrict(&sidecar);
        }
    }
    Ok(conn)
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS schema_info (version INTEGER NOT NULL);

        -- Preferences that must outlive a restart: the folders the user chose
        -- for backups, exports and the icon library. Deliberately a plain
        -- key/value table — these are a handful of paths and flags, and a
        -- typed column per setting would mean a migration for each new one.
        --
        -- Nothing secret goes in here. It is unencrypted, and it lives in the
        -- same database as the projects.
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- SSH host keys, remembered on first contact so a later change can be
        -- refused. Fingerprints only: a public key fingerprint is not a secret,
        -- and storing it here rather than in a project keeps it out of anything
        -- that gets exported or shared.
        -- The credential vault. Nothing here is readable without the
        -- passphrase, which is not stored: `salt` and `verifier` let a key be
        -- re-derived and checked, and neither reveals anything on its own.
        CREATE TABLE IF NOT EXISTS vault_header (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            salt BLOB NOT NULL,
            verifier BLOB NOT NULL,
            created_ms INTEGER NOT NULL
        );

        -- One saved credential. The username and label are deliberately in
        -- clear: they are not secrets, they are how a person picks the right
        -- credential from a list, and encrypting them would only make the
        -- interface unusable while locked.
        CREATE TABLE IF NOT EXISTS credentials (
            id TEXT PRIMARY KEY,
            label TEXT NOT NULL,
            kind TEXT NOT NULL,
            username TEXT NOT NULL,
            secret_nonce BLOB NOT NULL,
            secret_cipher BLOB NOT NULL,
            -- The second secret: an enable password for SSH, a privacy
            -- password for SNMPv3. Absent when there is none.
            extra_nonce BLOB,
            extra_cipher BLOB,
            -- Algorithm words for SNMPv3, which are not secret.
            detail TEXT NOT NULL DEFAULT '',
            created_ms INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS host_keys (
            host_id TEXT PRIMARY KEY,
            fingerprint TEXT NOT NULL,
            first_seen_ms INTEGER NOT NULL
        );

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

// ------------------------------------------------------------------ settings

/// Every stored preference. Small enough to read in one go on startup.
pub fn all_settings(conn: &Connection) -> rusqlite::Result<std::collections::HashMap<String, String>> {
    let mut stmt = conn.prepare("SELECT key, value FROM app_settings")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Writes a preference, or clears it when `value` is `None`.
///
/// Clearing rather than storing an empty string keeps "never set" and "set to
/// nothing" the same thing, which is what a folder that has been un-chosen
/// should be.
pub fn set_setting(conn: &Connection, key: &str, value: Option<&str>) -> rusqlite::Result<()> {
    match value {
        Some(v) if !v.is_empty() => conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        _ => conn.execute("DELETE FROM app_settings WHERE key = ?1", params![key])?,
    };
    Ok(())
}

// ---------------------------------------------------------------- host keys

/// Every remembered host key, for rebuilding the in-memory store on startup.
pub fn all_host_keys(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare("SELECT host_id, fingerprint FROM host_keys")?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    rows.collect()
}

/// Records a key seen for the first time. Does not overwrite: a fingerprint
/// that differs from the stored one is the case the store exists to catch, and
/// quietly replacing it here would defeat the whole mechanism.
pub fn remember_host_key(
    conn: &Connection,
    host_id: &str,
    fingerprint: &str,
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO host_keys (host_id, fingerprint, first_seen_ms) VALUES (?1, ?2, ?3)
         ON CONFLICT(host_id) DO NOTHING",
        params![host_id, fingerprint, now_ms],
    )?;
    Ok(())
}

/// Forgets everything, so every device is first contact again. The way back
/// after a switch is genuinely replaced.
pub fn clear_host_keys(conn: &Connection) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM host_keys", [])
}

/// Forgets one device.
pub fn forget_host_key(conn: &Connection, host_id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM host_keys WHERE host_id = ?1", params![host_id])
}

// ------------------------------------------------------------------- vault

pub struct StoredCredential {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub username: String,
    pub secret: (Vec<u8>, Vec<u8>),
    pub extra: Option<(Vec<u8>, Vec<u8>)>,
    pub detail: String,
}

pub fn vault_header(conn: &Connection) -> rusqlite::Result<Option<(Vec<u8>, Vec<u8>)>> {
    conn.query_row(
        "SELECT salt, verifier FROM vault_header WHERE id = 1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
}

/// Creates the vault. Refuses to replace an existing one: overwriting the
/// header would orphan every stored credential, silently and irreversibly.
pub fn create_vault(
    conn: &Connection,
    salt: &[u8],
    verifier: &[u8],
    now_ms: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO vault_header (id, salt, verifier, created_ms) VALUES (1, ?1, ?2, ?3)",
        params![salt, verifier, now_ms],
    )?;
    Ok(())
}

/// Removes the vault and everything in it.
///
/// The only way out of a forgotten passphrase, and it is destructive by
/// necessity — without the key the rows are unreadable, so keeping them would
/// only be keeping rubbish.
pub fn destroy_vault(conn: &Connection) -> rusqlite::Result<usize> {
    let removed = conn.execute("DELETE FROM credentials", [])?;
    conn.execute("DELETE FROM vault_header", [])?;
    Ok(removed)
}

pub fn save_credential(conn: &Connection, c: &StoredCredential, now_ms: i64) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO credentials
           (id, label, kind, username, secret_nonce, secret_cipher, extra_nonce, extra_cipher, detail, created_ms)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET
           label = excluded.label, kind = excluded.kind, username = excluded.username,
           secret_nonce = excluded.secret_nonce, secret_cipher = excluded.secret_cipher,
           extra_nonce = excluded.extra_nonce, extra_cipher = excluded.extra_cipher,
           detail = excluded.detail",
        params![
            c.id, c.label, c.kind, c.username,
            c.secret.0, c.secret.1,
            c.extra.as_ref().map(|e| &e.0), c.extra.as_ref().map(|e| &e.1),
            c.detail, now_ms
        ],
    )?;
    Ok(())
}

/// Everything about the saved credentials *except* the secrets.
///
/// A deliberately separate query from `credential`, so the listing path cannot
/// accidentally carry ciphertext towards the interface.
/// id, label, kind, username, detail — everything about a saved credential
/// except its secrets.
pub type CredentialListing = (String, String, String, String, String);

pub fn list_credentials(conn: &Connection) -> rusqlite::Result<Vec<CredentialListing>> {
    let mut stmt = conn.prepare(
        "SELECT id, label, kind, username, detail FROM credentials ORDER BY label",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
    })?;
    rows.collect()
}

pub fn credential(conn: &Connection, id: &str) -> rusqlite::Result<Option<StoredCredential>> {
    conn.query_row(
        "SELECT id, label, kind, username, secret_nonce, secret_cipher, extra_nonce, extra_cipher, detail
           FROM credentials WHERE id = ?1",
        params![id],
        |r| {
            let extra_nonce: Option<Vec<u8>> = r.get(6)?;
            let extra_cipher: Option<Vec<u8>> = r.get(7)?;
            Ok(StoredCredential {
                id: r.get(0)?,
                label: r.get(1)?,
                kind: r.get(2)?,
                username: r.get(3)?,
                secret: (r.get(4)?, r.get(5)?),
                extra: extra_nonce.zip(extra_cipher),
                detail: r.get(8)?,
            })
        },
    )
    .optional()
}

pub fn delete_credential(conn: &Connection, id: &str) -> rusqlite::Result<usize> {
    conn.execute("DELETE FROM credentials WHERE id = ?1", params![id])
}

#[cfg(test)]
mod tests {

    fn cred(id: &str, label: &str) -> StoredCredential {
        StoredCredential {
            id: id.into(),
            label: label.into(),
            kind: "ssh".into(),
            username: "netops".into(),
            secret: (vec![1, 2, 3], vec![9, 9, 9]),
            extra: Some((vec![4, 5, 6], vec![8, 8, 8])),
            detail: String::new(),
        }
    }

    #[test]
    fn a_vault_can_only_be_created_once() {
        // Replacing the header would orphan every stored credential, silently
        // and with no way back.
        let conn = mem();
        assert!(vault_header(&conn).unwrap().is_none());
        create_vault(&conn, b"salt", b"verifier", 1).unwrap();
        assert!(create_vault(&conn, b"other", b"other", 2).is_err());

        let (salt, verifier) = vault_header(&conn).unwrap().unwrap();
        assert_eq!(salt, b"salt");
        assert_eq!(verifier, b"verifier");
    }

    #[test]
    fn listing_credentials_returns_no_ciphertext_at_all() {
        // The listing feeds the interface. Its query is deliberately separate
        // from the one that reads a secret, so this path cannot carry
        // ciphertext towards the front end even by mistake.
        let conn = mem();
        save_credential(&conn, &cred("a", "Core switches"), 1).unwrap();

        let listed = list_credentials(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        let (id, label, kind, username, _detail) = &listed[0];
        assert_eq!((id.as_str(), label.as_str(), kind.as_str(), username.as_str()),
                   ("a", "Core switches", "ssh", "netops"));
    }

    #[test]
    fn a_credential_round_trips_with_both_secrets() {
        let conn = mem();
        save_credential(&conn, &cred("a", "Core"), 1).unwrap();
        let got = credential(&conn, "a").unwrap().unwrap();
        assert_eq!(got.secret, (vec![1, 2, 3], vec![9, 9, 9]));
        assert_eq!(got.extra, Some((vec![4, 5, 6], vec![8, 8, 8])));
    }

    #[test]
    fn a_credential_without_a_second_secret_stays_without_one() {
        // An SSH credential with no enable password, or v3 with no privacy.
        let conn = mem();
        let mut c = cred("a", "Core");
        c.extra = None;
        save_credential(&conn, &c, 1).unwrap();
        assert_eq!(credential(&conn, "a").unwrap().unwrap().extra, None);
    }

    #[test]
    fn saving_the_same_id_updates_rather_than_duplicating() {
        let conn = mem();
        save_credential(&conn, &cred("a", "Old name"), 1).unwrap();
        save_credential(&conn, &cred("a", "New name"), 2).unwrap();
        let listed = list_credentials(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].1, "New name");
    }

    #[test]
    fn destroying_the_vault_takes_the_credentials_with_it() {
        // Without the key the rows are unreadable, so keeping them would only
        // be keeping rubbish — and leaving them would make a fresh vault look
        // like it had contents.
        let conn = mem();
        create_vault(&conn, b"salt", b"verifier", 1).unwrap();
        save_credential(&conn, &cred("a", "One"), 1).unwrap();
        save_credential(&conn, &cred("b", "Two"), 1).unwrap();

        assert_eq!(destroy_vault(&conn).unwrap(), 2);
        assert!(vault_header(&conn).unwrap().is_none());
        assert!(list_credentials(&conn).unwrap().is_empty());
        // And a new vault can be created afterwards.
        assert!(create_vault(&conn, b"new", b"new", 2).is_ok());
    }

    #[test]
    fn one_credential_can_be_deleted_without_touching_the_rest() {
        let conn = mem();
        save_credential(&conn, &cred("a", "One"), 1).unwrap();
        save_credential(&conn, &cred("b", "Two"), 1).unwrap();
        assert_eq!(delete_credential(&conn, "a").unwrap(), 1);
        let listed = list_credentials(&conn).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].0, "b");
    }

    #[test]
    fn host_keys_round_trip() {
        let conn = mem();
        remember_host_key(&conn, "10.1.1.1:22", "SHA256:aaa", 1).unwrap();
        remember_host_key(&conn, "10.1.1.2:22", "SHA256:bbb", 2).unwrap();
        let all = all_host_keys(&conn).unwrap();
        assert_eq!(all.len(), 2);
        assert!(all.contains(&("10.1.1.1:22".into(), "SHA256:aaa".into())));
    }

    #[test]
    fn remembering_never_overwrites_a_key_that_already_exists() {
        // The case the whole mechanism exists for. If a second sighting could
        // silently replace the first, a changed key would never be detected.
        let conn = mem();
        remember_host_key(&conn, "10.1.1.1:22", "SHA256:original", 1).unwrap();
        remember_host_key(&conn, "10.1.1.1:22", "SHA256:different", 2).unwrap();
        let all = all_host_keys(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].1, "SHA256:original", "the stored key must not move");
    }

    #[test]
    fn clearing_reports_how_many_were_forgotten() {
        // The count is what the confirmation message needs.
        let conn = mem();
        remember_host_key(&conn, "a:22", "SHA256:a", 1).unwrap();
        remember_host_key(&conn, "b:22", "SHA256:b", 1).unwrap();
        assert_eq!(clear_host_keys(&conn).unwrap(), 2);
        assert!(all_host_keys(&conn).unwrap().is_empty());
        assert_eq!(clear_host_keys(&conn).unwrap(), 0, "clearing an empty store is not an error");
    }

    #[test]
    fn one_device_can_be_forgotten_without_touching_the_rest() {
        let conn = mem();
        remember_host_key(&conn, "a:22", "SHA256:a", 1).unwrap();
        remember_host_key(&conn, "b:22", "SHA256:b", 1).unwrap();
        assert_eq!(forget_host_key(&conn, "a:22").unwrap(), 1);
        let all = all_host_keys(&conn).unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].0, "b:22");
    }

    #[test]
    fn settings_round_trip_and_survive_being_overwritten() {
        let conn = mem();
        assert_eq!(all_settings(&conn).unwrap().get("backupFolder"), None);

        set_setting(&conn, "backupFolder", Some("/home/me/backups")).unwrap();
        assert_eq!(
            all_settings(&conn).unwrap().get("backupFolder").map(String::as_str),
            Some("/home/me/backups")
        );

        set_setting(&conn, "backupFolder", Some("/home/me/other")).unwrap();
        assert_eq!(
            all_settings(&conn).unwrap().get("backupFolder").map(String::as_str),
            Some("/home/me/other")
        );
        assert_eq!(all_settings(&conn).unwrap().len(), 1, "an update, not a second row");
    }

    #[test]
    fn clearing_a_setting_makes_it_unset_rather_than_empty() {
        // A folder that has been un-chosen must read the same as one never
        // chosen, or the UI has two states meaning the same thing.
        let conn = mem();
        set_setting(&conn, "exportFolder", Some("/tmp/x")).unwrap();
        set_setting(&conn, "exportFolder", None).unwrap();
        assert_eq!(all_settings(&conn).unwrap().get("exportFolder"), None);

        set_setting(&conn, "exportFolder", Some("")).unwrap();
        assert_eq!(all_settings(&conn).unwrap().get("exportFolder"), None);
        assert!(all_settings(&conn).unwrap().is_empty());
    }

    #[test]
    fn settings_are_independent_of_each_other() {
        let conn = mem();
        set_setting(&conn, "backupFolder", Some("/b")).unwrap();
        set_setting(&conn, "exportFolder", Some("/e")).unwrap();
        set_setting(&conn, "iconLibraryDir", Some("/i")).unwrap();
        let all = all_settings(&conn).unwrap();
        assert_eq!(all.get("backupFolder").map(String::as_str), Some("/b"));
        assert_eq!(all.get("exportFolder").map(String::as_str), Some("/e"));
        assert_eq!(all.get("iconLibraryDir").map(String::as_str), Some("/i"));
    }

    #[test]
    fn adopts_a_pre_rename_database() {
        let base = std::env::temp_dir().join(format!("cv-adopt-{}", uuid::Uuid::new_v4()));
        let old = base.join("LiveTopo");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::write(old.join("livetopo.db"), b"old-bytes").unwrap();
        std::fs::write(old.join("livetopo.db-wal"), b"old-wal").unwrap();

        let new_dir = base.join("Coreview");
        adopt_livetopo_data(&base, &new_dir);

        // Renamed, not just copied: the app opens coreview.db, so a verbatim
        // copy would leave the projects stranded beside an empty database.
        assert_eq!(std::fs::read(new_dir.join("coreview.db")).unwrap(), b"old-bytes");
        assert_eq!(std::fs::read(new_dir.join("coreview.db-wal")).unwrap(), b"old-wal");
        assert!(!new_dir.join("livetopo.db").exists());
        // Copied, not moved: the original stays put in case this went wrong.
        assert!(old.join("livetopo.db").exists());
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn never_overwrites_data_that_is_already_there() {
        let base = std::env::temp_dir().join(format!("cv-adopt-{}", uuid::Uuid::new_v4()));
        let old = base.join("LiveTopo");
        let new_dir = base.join("Coreview");
        std::fs::create_dir_all(&old).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();
        std::fs::write(old.join("livetopo.db"), b"old-bytes").unwrap();
        std::fs::write(new_dir.join("coreview.db"), b"current-bytes").unwrap();

        adopt_livetopo_data(&base, &new_dir);

        assert_eq!(std::fs::read(new_dir.join("coreview.db")).unwrap(), b"current-bytes");
        std::fs::remove_dir_all(&base).ok();
    }

    #[test]
    fn does_nothing_when_there_is_no_old_install() {
        let base = std::env::temp_dir().join(format!("cv-adopt-{}", uuid::Uuid::new_v4()));
        let new_dir = base.join("Coreview");
        adopt_livetopo_data(&base, &new_dir);
        assert!(!new_dir.exists());
        std::fs::remove_dir_all(&base).ok();
    }
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

#[cfg(test)]
mod document_round_trip {
    use super::*;

    fn mem() -> Connection {
        let c = Connection::open_in_memory().expect("in-memory database");
        migrate(&c).expect("schema");
        c
    }

    /// A document carrying every field the interface has added since this
    /// storage was written, plus one it has not.
    fn document() -> serde_json::Value {
        serde_json::json!({
            "nodes": [{
                "id": "n1",
                "type": "device",
                "position": { "x": 10.5, "y": -20.25 },
                "width": 176,
                "height": 96,
                "data": {
                    "label": "CORE-SW",
                    "deviceType": "core-switch",
                    "tags": ["site-hq"],
                    "addresses": [{ "id": "a", "label": "Mgmt", "address": "10.0.0.1", "isPrimary": true }],
                    "layers": ["logical"],
                    "locked": false,
                    "maintenance": false,
                    "showDetails": true,
                    "somethingAddedNextYear": { "deeply": ["nested", 1, true, null] }
                }
            }],
            "edges": [{
                "id": "e1",
                "source": "n1",
                "target": "n1",
                "data": {
                    "kind": "leader",
                    "lineStyle": "dash-dot",
                    "startCap": "circle",
                    "endCap": "open-arrow",
                    "colorMode": "fixed",
                    "color": "#b76eff",
                    "pinnedSides": true,
                    "layers": ["physical"]
                }
            }],
            "probes": [],
            "canvas": {
                "gridEnabled": true,
                "colourBy": "subnet",
                "lineJumps": false,
                "layers": [{ "id": "logical", "name": "Logical", "visible": false, "locked": true }]
            }
        })
    }

    fn package() -> ProjectPackage {
        ProjectPackage {
            meta: ProjectMeta {
                id: "p1".into(),
                name: "Round trip".into(),
                customer: String::new(),
                site: String::new(),
                ticket: String::new(),
                engineer: String::new(),
                description: String::new(),
                created_at: 1,
                updated_at: 2,
                archived: false,
            },
            document_version: 1,
            document: document(),
        }
    }

    #[test]
    fn a_document_comes_back_byte_for_byte() {
        // The diagram's shape belongs to the interface, and this layer stores
        // it as opaque JSON on purpose. If it were ever parsed into a typed
        // struct here, every field added to the interface after that struct
        // was written would be silently dropped on the next save — and the
        // person would find out when their diagram reopened without its
        // views, its leaders or its colours.
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let back = load_project(&c, "p1").expect("load").expect("a project");
        assert_eq!(back.document, document());
    }

    #[test]
    fn a_field_this_version_has_never_heard_of_survives() {
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let back = load_project(&c, "p1").expect("load").expect("a project");
        let node = &back.document["nodes"][0]["data"];
        assert_eq!(node["somethingAddedNextYear"]["deeply"][0], "nested");
    }

    #[test]
    fn saving_twice_does_not_erode_it() {
        // Round-tripping through the database and back has to be stable, or a
        // diagram loses a little each time it is opened and saved.
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let once = load_project(&c, "p1").expect("load").expect("a project");
        upsert_project(&c, &once).expect("save again");
        let twice = load_project(&c, "p1").expect("load").expect("a project");
        assert_eq!(twice.document, document());
    }

    #[test]
    fn numbers_keep_their_precision() {
        // A position rounded to an integer on every save walks a diagram out
        // of alignment over a few sessions.
        let c = mem();
        upsert_project(&c, &package()).expect("save");
        let back = load_project(&c, "p1").expect("load").expect("a project");
        assert_eq!(back.document["nodes"][0]["position"]["y"], -20.25);
    }
}
