//! Taking configuration backups and filing them.
//!
//! A backup is worth having only if you can trust it later, so most of this
//! module is about refusing to write things that would look like backups
//! without being them. An error message saved under a device's name is worse
//! than no file at all: the gap is obvious, the bad file is not.
//!
//! Files land in the folder the user chose, one directory per device, one
//! timestamped file per capture. Nothing else writes there and exporting never
//! touches it — a running configuration carries SNMP communities, hashed local
//! passwords and ACLs, and must not travel inside a diagram someone shares.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::backup::{backup_path, BackupKind, BackupPathError};
use crate::cli::looks_like_config;
use crate::hostkeys::HostKeyStore;
use crate::ssh::{Credentials, Device, SshOptions, SshProgress};

/// A device to back up.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupTarget {
    /// Address to connect to.
    pub address: String,
    /// Name to file it under. The device's own name is used instead once it is
    /// known, because that is stable when an address is not.
    pub name: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupSaved {
    pub name: String,
    pub address: String,
    pub path: String,
    pub bytes: usize,
    pub kind: BackupKind,
    /// The previous capture was byte-identical, so this one adds nothing.
    /// Still written — a backup that silently skips is a backup you cannot
    /// prove you took — but worth saying.
    pub unchanged: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupFailed {
    pub name: String,
    pub address: String,
    pub reason: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum BackupEvent {
    Started { devices: usize },
    Ssh(SshProgress),
    Saved(BackupSaved),
    Failed(BackupFailed),
    Finished { saved: usize, failed: usize, cancelled: bool },
}

#[derive(Debug, Clone)]
pub struct BackupOptions {
    pub root: PathBuf,
    /// Which configurations to take. Both is the usual choice: a running
    /// config that was never saved differs from the startup one, and that
    /// difference is often the thing you wanted to know.
    pub kinds: Vec<BackupKind>,
    pub ssh: SshOptions,
    /// Serialise logins, for estates behind a push factor.
    pub second_factor: bool,
}

impl Default for BackupOptions {
    fn default() -> Self {
        Self {
            root: PathBuf::new(),
            kinds: vec![BackupKind::Running],
            ssh: SshOptions::default(),
            second_factor: false,
        }
    }
}

#[derive(Debug, Default)]
pub struct BackupRun {
    pub saved: Vec<BackupSaved>,
    pub failed: Vec<BackupFailed>,
    pub cancelled: bool,
}

/// Writes one capture, refusing anything that is not a configuration.
///
/// Returns the path written and whether it matched the previous capture.
pub fn write_capture(
    root: &Path,
    name: &str,
    address: &str,
    stamp: &str,
    kind: BackupKind,
    contents: &str,
) -> Result<(PathBuf, bool), String> {
    // Checked before the directory is created, so a device that returns
    // rubbish does not leave an empty folder behind suggesting it was backed
    // up at some point.
    looks_like_config(contents)?;

    let path = backup_path(root, name, address, stamp, kind).map_err(describe)?;
    let dir = path.parent().ok_or("the backup path has no folder")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;

    let unchanged = latest_capture(root, name, address, kind)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|previous| previous == contents)
        .unwrap_or(false);

    std::fs::write(&path, contents)
        .map_err(|e| format!("could not write {}: {e}", path.display()))?;
    restrict_permissions(&path);

    Ok((path, unchanged))
}

/// Configurations contain secrets, so a backup is readable by its owner only.
///
/// Best effort: on Windows the file inherits the folder's ACL, which is the
/// platform's own answer to the same question, and there is nothing sensible to
/// do if the call fails.
fn restrict_permissions(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn describe(e: BackupPathError) -> String {
    e.to_string()
}

/// Every capture for one device, newest first.
pub fn list_captures(root: &Path, name: &str, address: &str) -> Vec<PathBuf> {
    let Ok(dir) = crate::backup::device_dir(root, name, address) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().map(|e| e == "txt").unwrap_or(false))
        .collect();
    // Filenames start with a sortable timestamp, so this is chronological
    // without anything having to parse a date.
    files.sort();
    files.reverse();
    files
}

/// The most recent capture of one kind, if there is one.
pub fn latest_capture(root: &Path, name: &str, address: &str, kind: BackupKind) -> Option<PathBuf> {
    let suffix = format!("{}.txt", kind.slug());
    list_captures(root, name, address)
        .into_iter()
        .find(|p| p.file_name().map(|f| f.to_string_lossy().ends_with(&suffix)).unwrap_or(false))
}

/// Backs up a list of devices.
///
/// Never returns an error. A device that fails is recorded and the run
/// continues, for the same reason the crawl works that way: one unreachable
/// switch must not abandon the other ninety-nine.
pub async fn run_backups(
    targets: Vec<BackupTarget>,
    credentials: Credentials,
    options: BackupOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    stamp: String,
    events: mpsc::Sender<BackupEvent>,
    cancel: CancellationToken,
) -> BackupRun {
    let _ = events
        .send(BackupEvent::Started {
            devices: targets.len(),
        })
        .await;

    let mut run = BackupRun::default();
    let auth_gate = Arc::new(Mutex::new(()));
    let serialise = Arc::new(std::sync::atomic::AtomicBool::new(options.second_factor));

    for target in targets {
        if cancel.is_cancelled() {
            run.cancelled = true;
            break;
        }

        match back_up_one(
            &target,
            &credentials,
            &options,
            Arc::clone(&store),
            &stamp,
            &events,
            Arc::clone(&auth_gate),
            Arc::clone(&serialise),
        )
        .await
        {
            Ok(saved) => {
                for s in saved {
                    let _ = events.send(BackupEvent::Saved(s.clone())).await;
                    run.saved.push(s);
                }
            }
            Err(reason) => {
                let failure = BackupFailed {
                    name: target.name.clone(),
                    address: target.address.clone(),
                    reason,
                };
                let _ = events.send(BackupEvent::Failed(failure.clone())).await;
                run.failed.push(failure);
            }
        }
    }

    let _ = events
        .send(BackupEvent::Finished {
            saved: run.saved.len(),
            failed: run.failed.len(),
            cancelled: run.cancelled,
        })
        .await;
    run
}

#[allow(clippy::too_many_arguments)]
async fn back_up_one(
    target: &BackupTarget,
    credentials: &Credentials,
    options: &BackupOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    stamp: &str,
    events: &mpsc::Sender<BackupEvent>,
    auth_gate: Arc<Mutex<()>>,
    serialise: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Vec<BackupSaved>, String> {
    if options.root.as_os_str().is_empty() {
        return Err("no backup folder has been chosen yet".into());
    }

    let (tx, mut rx) = mpsc::channel::<SshProgress>(32);
    let forward = events.clone();
    let flag = Arc::clone(&serialise);
    tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            if matches!(p, SshProgress::AwaitingSecondFactor { .. }) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let _ = forward.send(BackupEvent::Ssh(p)).await;
        }
    });

    let mut device = {
        let _lock = if serialise.load(std::sync::atomic::Ordering::Relaxed) {
            Some(auth_gate.lock().await)
        } else {
            None
        };
        Device::connect(
            &target.address,
            credentials,
            options.ssh.clone(),
            store,
            Some(tx),
        )
        .await
        .map_err(|e| e.to_string())?
    };

    // A configuration cannot be read from user mode. Escalating first turns a
    // file full of "% Invalid input" into an honest failure.
    let enabled = device
        .enable(credentials.enable_password.as_ref())
        .await
        .unwrap_or(false);
    if !enabled {
        device.close().await;
        return Err(
            "the device stayed in user mode; a configuration cannot be read without enable".into(),
        );
    }

    // The device's own name beats whatever the caller passed: it is what the
    // device calls itself, and it stays the same when an address does not.
    let name = {
        let h = device.hostname();
        if h.is_empty() { target.name.clone() } else { h.to_string() }
    };

    let mut saved = Vec::new();
    let mut problems = Vec::new();
    for kind in &options.kinds {
        match device.run(kind.command()).await {
            Err(e) => problems.push(format!("{}: {e}", kind.slug())),
            Ok(text) => match write_capture(&options.root, &name, &target.address, stamp, *kind, &text) {
                Err(why) => problems.push(format!("{}: {why}", kind.slug())),
                Ok((path, unchanged)) => saved.push(BackupSaved {
                    name: name.clone(),
                    address: target.address.clone(),
                    path: path.to_string_lossy().to_string(),
                    bytes: text.len(),
                    kind: *kind,
                    unchanged,
                }),
            },
        }
    }
    device.close().await;

    if saved.is_empty() {
        return Err(problems.join("; "));
    }
    Ok(saved)
}

/// A line-level comparison of two captures.
///
/// Enough to answer "what changed between these two", which is the question a
/// pair of timestamped configurations exists to answer. Not a general diff:
/// configuration files are line-oriented and short, so a straightforward
/// longest-common-subsequence is both correct and fast enough.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffLine {
    Same(String),
    Added(String),
    Removed(String),
}

/// Compares two configurations line by line.
pub fn diff(before: &str, after: &str) -> Vec<DiffLine> {
    let a: Vec<&str> = before.lines().collect();
    let b: Vec<&str> = after.lines().collect();

    // Longest common subsequence table. Configurations are thousands of lines
    // at most, so the quadratic table is a few megabytes in the worst case and
    // nothing in the normal one.
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }

    let mut out = Vec::new();
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i] == b[j] {
            out.push(DiffLine::Same(a[i].to_string()));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            out.push(DiffLine::Removed(a[i].to_string()));
            i += 1;
        } else {
            out.push(DiffLine::Added(b[j].to_string()));
            j += 1;
        }
    }
    while i < a.len() {
        out.push(DiffLine::Removed(a[i].to_string()));
        i += 1;
    }
    while j < b.len() {
        out.push(DiffLine::Added(b[j].to_string()));
        j += 1;
    }
    out
}

/// How many lines differ, for a one-line summary.
pub fn count_changes(lines: &[DiffLine]) -> (usize, usize) {
    let added = lines.iter().filter(|l| matches!(l, DiffLine::Added(_))).count();
    let removed = lines.iter().filter(|l| matches!(l, DiffLine::Removed(_))).count();
    (added, removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("coreview-backup-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    const CONFIG: &str = "version 15.2\n!\nhostname SW1\n!\ninterface Gi0/1\n!\nend";

    #[test]
    fn a_capture_lands_in_a_folder_named_after_the_device() {
        let root = temp_root("basic");
        let (path, unchanged) =
            write_capture(&root, "CORE-SW-01", "10.1.1.1", "20260828-101530", BackupKind::Running, CONFIG)
                .unwrap();

        assert!(path.ends_with("CORE-SW-01/20260828-101530-running-config.txt"), "got {path:?}");
        assert_eq!(std::fs::read_to_string(&path).unwrap(), CONFIG);
        assert!(!unchanged, "there was nothing to compare against");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_error_message_is_never_filed_as_a_backup() {
        // The failure this whole module is shaped around: a file that looks
        // like a backup, under the right name, containing an error.
        let root = temp_root("rejects");
        let err = write_capture(
            &root,
            "SW1",
            "10.1.1.1",
            "20260828-101530",
            BackupKind::Running,
            "% Invalid input detected at '^' marker.",
        )
        .unwrap_err();
        assert!(err.contains("rejected"), "got: {err}");

        // And it left no folder behind suggesting the device was ever backed up.
        assert!(!root.join("SW1").exists(), "an empty device folder was created");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn an_empty_capture_is_refused() {
        let root = temp_root("empty");
        assert!(write_capture(&root, "SW1", "10.1.1.1", "20260828-101530", BackupKind::Running, "").is_err());
        assert!(write_capture(&root, "SW1", "10.1.1.1", "20260828-101530", BackupKind::Running, "   \n ").is_err());
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_second_identical_capture_is_flagged_as_unchanged_but_still_written() {
        // Still written, because a backup that silently skips is one you
        // cannot prove you took.
        let root = temp_root("unchanged");
        write_capture(&root, "SW1", "10.1.1.1", "20260828-100000", BackupKind::Running, CONFIG).unwrap();
        let (path, unchanged) =
            write_capture(&root, "SW1", "10.1.1.1", "20260828-110000", BackupKind::Running, CONFIG).unwrap();

        assert!(unchanged, "an identical capture should be recognised");
        assert!(path.exists(), "it should still have been written");
        assert_eq!(list_captures(&root, "SW1", "10.1.1.1").len(), 2);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_changed_capture_is_not_flagged_as_unchanged() {
        let root = temp_root("changed");
        write_capture(&root, "SW1", "10.1.1.1", "20260828-100000", BackupKind::Running, CONFIG).unwrap();
        let changed = CONFIG.replace("hostname SW1", "hostname SW1-RENAMED");
        let (_, unchanged) =
            write_capture(&root, "SW1", "10.1.1.1", "20260828-110000", BackupKind::Running, &changed).unwrap();
        assert!(!unchanged);
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn captures_are_listed_newest_first() {
        let root = temp_root("listing");
        for stamp in ["20260826-090000", "20260828-090000", "20260827-090000"] {
            write_capture(&root, "SW1", "10.1.1.1", stamp, BackupKind::Running, CONFIG).unwrap();
        }
        let listed = list_captures(&root, "SW1", "10.1.1.1");
        let names: Vec<String> = listed
            .iter()
            .map(|p| p.file_name().unwrap().to_string_lossy().to_string())
            .collect();
        assert_eq!(
            names,
            vec![
                "20260828-090000-running-config.txt",
                "20260827-090000-running-config.txt",
                "20260826-090000-running-config.txt",
            ]
        );
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn running_and_startup_are_kept_apart() {
        let root = temp_root("kinds");
        write_capture(&root, "SW1", "10.1.1.1", "20260828-090000", BackupKind::Running, CONFIG).unwrap();
        write_capture(&root, "SW1", "10.1.1.1", "20260828-090000", BackupKind::Startup, CONFIG).unwrap();

        let running = latest_capture(&root, "SW1", "10.1.1.1", BackupKind::Running).unwrap();
        let startup = latest_capture(&root, "SW1", "10.1.1.1", BackupKind::Startup).unwrap();
        assert!(running.to_string_lossy().contains("running-config"));
        assert!(startup.to_string_lossy().contains("startup-config"));
        assert_ne!(running, startup);
        std::fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn a_backup_is_readable_by_its_owner_only() {
        // Configurations carry SNMP communities and hashed passwords.
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("perms");
        let (path, _) =
            write_capture(&root, "SW1", "10.1.1.1", "20260828-090000", BackupKind::Running, CONFIG).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "got {mode:o}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_hostile_device_name_cannot_write_outside_the_backup_folder() {
        // Device names come off the network. The path rules are tested in
        // backup.rs; this proves the writer actually uses them.
        let root = temp_root("hostile");
        let (path, _) = write_capture(
            &root,
            "../../../etc/cron.d/x",
            "10.1.1.1",
            "20260828-090000",
            BackupKind::Running,
            CONFIG,
        )
        .unwrap();
        assert!(crate::backup::is_inside(&root, &path), "escaped to {path:?}");
        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn no_backup_folder_chosen_is_reported_clearly() {
        let err = write_capture(
            Path::new(""),
            "SW1",
            "10.1.1.1",
            "20260828-090000",
            BackupKind::Running,
            CONFIG,
        )
        .unwrap_err();
        assert!(err.contains("folder"), "got: {err}");
    }

    #[test]
    fn a_diff_finds_a_changed_line() {
        let before = "hostname SW1\ninterface Gi0/1\n description uplink\n!";
        let after = "hostname SW1\ninterface Gi0/1\n description downlink\n!";
        let d = diff(before, after);
        assert_eq!(count_changes(&d), (1, 1));
        assert!(d.contains(&DiffLine::Removed(" description uplink".into())));
        assert!(d.contains(&DiffLine::Added(" description downlink".into())));
        // And it kept the unchanged lines as context.
        assert!(d.contains(&DiffLine::Same("hostname SW1".into())));
    }

    #[test]
    fn identical_configurations_show_no_changes() {
        let d = diff(CONFIG, CONFIG);
        assert_eq!(count_changes(&d), (0, 0));
        assert!(d.iter().all(|l| matches!(l, DiffLine::Same(_))));
    }

    #[test]
    fn a_diff_reports_pure_additions_and_pure_removals() {
        let before = "line a\nline b";
        let after = "line a\nline b\nline c\nline d";
        assert_eq!(count_changes(&diff(before, after)), (2, 0));
        assert_eq!(count_changes(&diff(after, before)), (0, 2));
    }

    #[test]
    fn a_diff_does_not_mangle_a_block_inserted_in_the_middle() {
        // The case a naive line-by-line comparison gets wrong: everything
        // after an insertion shifts by one and reads as changed.
        let before = "a\nb\nc";
        let after = "a\nNEW\nb\nc";
        let d = diff(before, after);
        assert_eq!(count_changes(&d), (1, 0), "got {d:?}");
        assert!(d.contains(&DiffLine::Added("NEW".into())));
    }
}
