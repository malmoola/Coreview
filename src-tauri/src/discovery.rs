//! IPC for crawling and backing up devices.
//!
//! The rule this module exists to enforce: **credentials arrive per run and are
//! never stored.** They come in as command arguments, live in memory for the
//! length of one crawl or one backup, and go away with it. Nothing here writes
//! a password anywhere, and nothing here can hand one back to the interface —
//! the frontend sends them and never receives them.
//!
//! Host key fingerprints are the exception, and are not secret: a public key
//! fingerprint is what you would read out over the phone to verify a device.

use std::sync::Arc;

use coreview_discover::backup::BackupKind;
use coreview_discover::capture::{run_backups, BackupOptions, BackupTarget};
use coreview_discover::crawl::{crawl, CrawlOptions};
use coreview_discover::filter::DiscoveryFilter;
use coreview_discover::hostkeys::{host_id, HostKeyStore};
use coreview_discover::snmp::{AuthKind, PrivKind, SnmpAuth};
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use coreview_discover::types::{AddressPreference, DeviceClass};
use coreview_probe::sweep::parse_cidr;
use serde::Deserialize;
use tauri::{AppHandle, Emitter, State};
use tokio_util::sync::CancellationToken;

use crate::commands::AppState;
use crate::db;

type CmdResult<T> = Result<T, String>;

fn db_err(e: impl std::fmt::Display) -> String {
    format!("Local database error: {e}")
}

/// Credentials as they arrive from the interface.
///
/// Deliberately not `Debug`: the whole point is that this never reaches a log
/// line. It is converted to the transport's `Credentials` immediately, where
/// the password lives inside a `Secret`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialInput {
    pub username: String,
    pub password: String,
    pub enable_password: Option<String>,
}

impl From<CredentialInput> for Credentials {
    fn from(v: CredentialInput) -> Self {
        Credentials {
            username: v.username,
            password: Secret::new(v.password),
            enable_password: v
                .enable_password
                .filter(|p| !p.is_empty())
                .map(Secret::new),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlInput {
    pub seed: String,
    /// Subnets the crawl may dial into. Empty means no limit, which is rarely
    /// what anyone wants — a crawl with no subnet limit follows a WAN link out
    /// of the estate.
    pub subnets: Vec<String>,
    /// Device classes worth logging into. Empty falls back to infrastructure.
    pub crawl_classes: Vec<String>,
    pub max_hops: usize,
    pub max_devices: usize,
    pub second_factor: bool,
    pub address_preference: String,
    /// Named interface, when `address_preference` is "interface".
    pub interface_name: Option<String>,
    pub port: u16,
    /// Optional SNMP credentials, used only for devices that refuse SSH.
    pub snmp: Option<SnmpInput>,
}

/// SNMP credentials as the interface sends them.
///
/// Not `Debug`, for the same reason the SSH credentials are not: a community
/// string is a credential and belongs in no log line.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpInput {
    /// "v2c" or "v3".
    pub version: String,
    /// v2c only.
    pub community: Option<String>,
    /// v3 only.
    pub username: Option<String>,
    /// "sha", "md5", "sha256"...
    pub auth_protocol: Option<String>,
    pub auth_password: Option<String>,
    /// "aes 256", "aes", "des"; absent means authentication without privacy.
    pub privacy: Option<String>,
    pub privacy_password: Option<String>,
}

impl SnmpInput {
    /// Returns `None` rather than a half-built credential: SNMP is optional,
    /// and an incomplete v3 user would fail on every device with an error that
    /// looks like the devices are at fault.
    fn into_auth(self) -> Option<SnmpAuth> {
        match self.version.as_str() {
            "v2c" => self
                .community
                .filter(|c| !c.is_empty())
                .map(|community| SnmpAuth::V2c { community }),
            "v3" => {
                let username = self.username.filter(|u| !u.is_empty())?;
                let auth_password = self.auth_password.filter(|p| !p.is_empty())?;
                Some(SnmpAuth::V3 {
                    username,
                    auth_protocol: AuthKind::parse(self.auth_protocol.as_deref().unwrap_or("sha"))?,
                    auth_password,
                    privacy: self.privacy.as_deref().and_then(PrivKind::parse),
                    privacy_password: self.privacy_password.unwrap_or_default(),
                })
            }
            _ => None,
        }
    }
}

/// Loads remembered host keys into a store the transport can use.
fn load_host_keys(state: &AppState) -> CmdResult<Arc<std::sync::Mutex<HostKeyStore>>> {
    let conn = state.db.lock().map_err(db_err)?;
    let pairs = db::all_host_keys(&conn).map_err(db_err)?;
    Ok(Arc::new(std::sync::Mutex::new(HostKeyStore::from_pairs(pairs))))
}

/// Writes back any key learned during a run.
///
/// Called once a run finishes rather than per connection, because the store is
/// the source of truth while a crawl is in flight and the database only needs
/// to agree with it by the end.
///
/// `remember_host_key` refuses to overwrite, so this cannot launder a changed
/// key into the database: a device whose key differed never reached the point
/// of being remembered anyway, because the connection was refused.
fn persist_host_keys(app: &AppHandle, store: &Arc<std::sync::Mutex<HostKeyStore>>) {
    use tauri::Manager;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let state = app.state::<AppState>();
    let Ok(conn) = state.db.lock() else { return };
    let Ok(guard) = store.lock() else { return };
    for (id, fingerprint) in guard.entries() {
        let _ = db::remember_host_key(&conn, id, fingerprint, now_ms);
    }
}

fn parse_classes(names: &[String]) -> Vec<DeviceClass> {
    names
        .iter()
        .filter_map(|n| {
            DeviceClass::ALL
                .iter()
                .find(|c| serde_json::to_string(c).ok().as_deref() == Some(&format!("\"{n}\"")))
                .copied()
        })
        .collect()
}

fn parse_preference(kind: &str, interface: Option<&str>) -> AddressPreference {
    match kind {
        "management" => AddressPreference::Management,
        "first" => AddressPreference::First,
        "interface" => AddressPreference::Interface {
            name: interface.unwrap_or_default().to_string(),
        },
        _ => AddressPreference::Loopback,
    }
}

/// Starts a crawl. Returns as soon as it is scheduled; everything else arrives
/// on `coreview://crawl`.
#[tauri::command]
pub async fn start_crawl(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CrawlInput,
    credentials: CredentialInput,
) -> CmdResult<()> {
    let mut subnets = Vec::new();
    for s in &input.subnets {
        if s.trim().is_empty() {
            continue;
        }
        subnets.push(parse_cidr(s).map_err(|e| format!("{s}: {e}"))?);
    }

    let options = CrawlOptions {
        filter: DiscoveryFilter {
            subnets,
            crawl_classes: parse_classes(&input.crawl_classes),
            ..Default::default()
        },
        max_hops: input.max_hops.clamp(0, 32),
        max_devices: input.max_devices.clamp(1, 5_000),
        concurrency: 1,
        second_factor: input.second_factor,
        address_preference: parse_preference(&input.address_preference, input.interface_name.as_deref()),
        ssh: SshOptions {
            port: input.port,
            ..SshOptions::default()
        },
        snmp: input.snmp.and_then(SnmpInput::into_auth),
        ..CrawlOptions::default()
    };

    let store = load_host_keys(&state)?;
    let token = CancellationToken::new();
    {
        let mut slot = state.crawl_cancel.lock().map_err(db_err)?;
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = emitter.emit("coreview://crawl", &event);
        }
    });

    let seed = input.seed;
    let credentials: Credentials = credentials.into();
    let persist_store = Arc::clone(&store);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = crawl(&seed, credentials, options, store, tx, token).await;
        // Emitted separately from the event stream because it carries the
        // neighbours that were seen but never visited, which no single event
        // contains.
        // Before the result, so a host key learned on the last device is
        // already durable by the time the interface reacts.
        persist_host_keys(&handle, &persist_store);
        let _ = handle.emit(
            "coreview://crawl-result",
            serde_json::json!({
                "devices": result.devices,
                "notVisited": result.not_visited,
                "failures": result.failures,
                "cancelled": result.cancelled,
            }),
        );
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_crawl(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(token) = state.crawl_cancel.lock().map_err(db_err)?.take() {
        token.cancel();
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInput {
    pub targets: Vec<BackupTarget>,
    /// "running", "startup", or both.
    pub kinds: Vec<String>,
    pub second_factor: bool,
    pub port: u16,
}

/// Backs up the given devices into the chosen backup folder.
#[tauri::command]
pub async fn start_backup(
    app: AppHandle,
    state: State<'_, AppState>,
    input: BackupInput,
    credentials: CredentialInput,
    stamp: String,
) -> CmdResult<()> {
    let root = {
        let conn = state.db.lock().map_err(db_err)?;
        db::all_settings(&conn)
            .map_err(db_err)?
            .get("backupFolder")
            .cloned()
    }
    .ok_or("Choose a backup folder before backing anything up.")?;

    let kinds: Vec<BackupKind> = input
        .kinds
        .iter()
        .filter_map(|k| match k.as_str() {
            "startup" => Some(BackupKind::Startup),
            "running" => Some(BackupKind::Running),
            _ => None,
        })
        .collect();
    if kinds.is_empty() {
        return Err("Choose at least one configuration to capture.".into());
    }
    if input.targets.is_empty() {
        return Err("Choose at least one device to back up.".into());
    }

    let options = BackupOptions {
        root: root.into(),
        kinds,
        ssh: SshOptions {
            port: input.port,
            ..SshOptions::default()
        },
        second_factor: input.second_factor,
    };

    let store = load_host_keys(&state)?;
    let token = CancellationToken::new();
    {
        let mut slot = state.backup_cancel.lock().map_err(db_err)?;
        if let Some(previous) = slot.replace(token.clone()) {
            previous.cancel();
        }
    }

    let (tx, mut rx) = tokio::sync::mpsc::channel(1024);
    let emitter = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = rx.recv().await {
            let _ = emitter.emit("coreview://backup", &event);
        }
    });

    let credentials: Credentials = credentials.into();
    let targets = input.targets;
    let persist_store = Arc::clone(&store);
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        run_backups(targets, credentials, options, store, stamp, tx, token).await;
        persist_host_keys(&handle, &persist_store);
    });

    Ok(())
}

#[tauri::command]
pub fn cancel_backup(state: State<'_, AppState>) -> CmdResult<()> {
    if let Some(token) = state.backup_cancel.lock().map_err(db_err)?.take() {
        token.cancel();
    }
    Ok(())
}

// --------------------------------------------------------------- host keys

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyRow {
    pub host: String,
    pub fingerprint: String,
}

/// Every remembered host key, for the settings list.
#[tauri::command]
pub fn list_host_keys(state: State<'_, AppState>) -> CmdResult<Vec<HostKeyRow>> {
    let conn = state.db.lock().map_err(db_err)?;
    let mut rows: Vec<HostKeyRow> = db::all_host_keys(&conn)
        .map_err(db_err)?
        .into_iter()
        .map(|(host, fingerprint)| HostKeyRow { host, fingerprint })
        .collect();
    rows.sort_by(|a, b| a.host.cmp(&b.host));
    Ok(rows)
}

/// Forgets every remembered host key. Returns how many went, for the
/// confirmation message.
#[tauri::command]
pub fn clear_host_keys(state: State<'_, AppState>) -> CmdResult<usize> {
    let conn = state.db.lock().map_err(db_err)?;
    db::clear_host_keys(&conn).map_err(db_err)
}

/// Forgets one device's key, so the next connection is treated as first
/// contact. The narrower answer when a single switch was replaced.
#[tauri::command]
pub fn forget_host_key(state: State<'_, AppState>, host: String, port: u16) -> CmdResult<bool> {
    let conn = state.db.lock().map_err(db_err)?;
    let id = host_id(&host, port);
    // The list shows the stored id directly, so accept either form.
    let removed = db::forget_host_key(&conn, &host).map_err(db_err)?
        + db::forget_host_key(&conn, &id).map_err(db_err)?;
    Ok(removed > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_class_names_from_the_interface_are_understood() {
        // The interface sends the kebab-case names serde produces, and a
        // mismatch here would silently mean "no classes selected", which
        // reads as the filter being ignored.
        let parsed = parse_classes(&[
            "router".into(),
            "switch".into(),
            "wireless-controller".into(),
            "access-point".into(),
        ]);
        assert_eq!(
            parsed,
            vec![
                DeviceClass::Router,
                DeviceClass::Switch,
                DeviceClass::WirelessController,
                DeviceClass::AccessPoint
            ]
        );
    }

    #[test]
    fn an_unknown_class_name_is_dropped_rather_than_guessed() {
        assert!(parse_classes(&["not-a-class".into()]).is_empty());
    }

    #[test]
    fn every_class_survives_a_round_trip_through_its_name() {
        // Guards against a class being added to the enum and quietly failing
        // to appear in the filter.
        for class in DeviceClass::ALL {
            let name = serde_json::to_string(&class).unwrap();
            let name = name.trim_matches('"').to_string();
            assert_eq!(
                parse_classes(std::slice::from_ref(&name)),
                vec![class],
                "{class:?} did not survive as {name:?}"
            );
        }
    }

    #[test]
    fn incomplete_snmp_credentials_yield_nothing_rather_than_half_a_user() {
        // A half-built v3 user fails on every device with an error that reads
        // like the devices are at fault.
        let missing_password = SnmpInput {
            version: "v3".into(),
            community: None,
            username: Some("netops".into()),
            auth_protocol: Some("sha".into()),
            auth_password: None,
            privacy: None,
            privacy_password: None,
        };
        assert!(missing_password.into_auth().is_none());

        let empty_community = SnmpInput {
            version: "v2c".into(),
            community: Some(String::new()),
            username: None,
            auth_protocol: None,
            auth_password: None,
            privacy: None,
            privacy_password: None,
        };
        assert!(empty_community.into_auth().is_none());
    }

    #[test]
    fn a_complete_v3_user_is_built_from_the_words_a_configuration_uses() {
        // These come off an `snmp-server user` line verbatim.
        let input = SnmpInput {
            version: "v3".into(),
            community: None,
            username: Some("GRP123".into()),
            auth_protocol: Some("sha".into()),
            auth_password: Some("secret".into()),
            privacy: Some("aes 256".into()),
            privacy_password: Some("secret".into()),
        };
        match input.into_auth() {
            Some(SnmpAuth::V3 { username, auth_protocol, privacy, .. }) => {
                assert_eq!(username, "GRP123");
                assert_eq!(auth_protocol, AuthKind::Sha1, "IOS 'sha' is SHA-1");
                assert_eq!(privacy, Some(PrivKind::Aes256));
            }
            other => panic!("expected a v3 user, got {other:?}"),
        }
    }

    #[test]
    fn address_preferences_map_from_their_names() {
        assert_eq!(parse_preference("loopback", None), AddressPreference::Loopback);
        assert_eq!(parse_preference("management", None), AddressPreference::Management);
        assert_eq!(parse_preference("first", None), AddressPreference::First);
        assert_eq!(
            parse_preference("interface", Some("Vlan100")),
            AddressPreference::Interface { name: "Vlan100".into() }
        );
        // Anything unrecognised falls back to the safest default rather than
        // failing a long run over a typo.
        assert_eq!(parse_preference("nonsense", None), AddressPreference::Loopback);
    }
}
