//! Where a configuration backup goes, and what it is called.
//!
//! Backups live in a folder the user picks, outside the project file and
//! outside anything export touches. That separation is deliberate: a running
//! configuration contains SNMP communities, hashed local passwords, keys and
//! ACLs, and a `.coreview` project someone emails a colleague must not carry
//! any of it.
//!
//! The security-relevant part of this module is naming. A backup path is built
//! from a device name, and device names come off the network — CDP and LLDP
//! report whatever the device calls itself. A device named
//! `../../../etc/cron.d/x` must not be able to steer a write out of the backup
//! folder, so every component is sanitised here rather than trusted, and the
//! result is checked to still be inside the root.

use std::path::{Component, Path, PathBuf};

/// Longest a single path component may be. Most filesystems stop at 255 bytes;
/// leaving room for the timestamp suffix keeps the whole name legal.
const MAX_COMPONENT: usize = 96;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum BackupPathError {
    #[error("no backup folder has been chosen yet")]
    NoRoot,
    #[error("the device has no name or address to file the backup under")]
    NoName,
    #[error("that name does not produce a path inside the backup folder")]
    Escapes,
}

/// Reduces arbitrary text to one safe path component.
///
/// Keeps letters, digits, dot, dash and underscore; everything else becomes a
/// dash. Leading dots are dropped, so `..` and `.hidden` cannot survive, and
/// the result is truncated and trimmed. Returns `None` when nothing usable is
/// left, which the caller must treat as "use the address instead" rather than
/// inventing a name.
pub fn safe_component(raw: &str) -> Option<String> {
    let mut out = String::with_capacity(raw.len().min(MAX_COMPONENT));
    let mut last_dash = false;
    for ch in raw.trim().chars() {
        let keep = ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_';
        if keep {
            out.push(ch);
            last_dash = false;
        } else if !last_dash && !out.is_empty() {
            out.push('-');
            last_dash = true;
        }
        if out.len() >= MAX_COMPONENT {
            break;
        }
    }
    // A component that is only dots is `.` or `..`, both of which move around
    // the tree rather than naming anything.
    let trimmed = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed)
}

/// Timestamp used in backup filenames: `20260828-101530`.
///
/// Sortable as text, so a directory listing is in chronological order without
/// anything having to parse it. Takes the parts rather than reading the clock
/// so the caller decides the timezone and tests are deterministic.
pub fn stamp(year: i32, month: u32, day: u32, hour: u32, minute: u32, second: u32) -> String {
    format!("{year:04}{month:02}{day:02}-{hour:02}{minute:02}{second:02}")
}

/// Where one device's backups live: `<root>/<device>/`.
///
/// `name` is the device name and `address` the fallback, used when the name
/// sanitises away to nothing — which happens with names that are entirely
/// punctuation, and with a hostile name that was all path separators.
pub fn device_dir(root: &Path, name: &str, address: &str) -> Result<PathBuf, BackupPathError> {
    if root.as_os_str().is_empty() {
        return Err(BackupPathError::NoRoot);
    }
    let component = safe_component(name)
        .or_else(|| safe_component(address))
        .ok_or(BackupPathError::NoName)?;

    let dir = root.join(&component);
    // Belt and braces. `safe_component` should make this impossible, but the
    // cost of being wrong is a write outside the backup folder.
    if !is_inside(root, &dir) {
        return Err(BackupPathError::Escapes);
    }
    Ok(dir)
}

/// Full path for one backup: `<root>/<device>/<stamp>-running-config.txt`.
pub fn backup_path(
    root: &Path,
    name: &str,
    address: &str,
    stamp: &str,
    kind: BackupKind,
) -> Result<PathBuf, BackupPathError> {
    let dir = device_dir(root, name, address)?;
    let stamp = safe_component(stamp).ok_or(BackupPathError::NoName)?;
    let file = format!("{stamp}-{}.txt", kind.slug());
    let path = dir.join(file);
    if !is_inside(root, &path) {
        return Err(BackupPathError::Escapes);
    }
    Ok(path)
}

/// Which configuration was captured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BackupKind {
    Running,
    Startup,
}

impl BackupKind {
    pub fn slug(&self) -> &'static str {
        match self {
            BackupKind::Running => "running-config",
            BackupKind::Startup => "startup-config",
        }
    }

    /// The command that produces it. Kept beside the kind so the two cannot
    /// drift apart.
    pub fn command(&self) -> &'static str {
        match self {
            BackupKind::Running => "show running-config",
            BackupKind::Startup => "show startup-config",
        }
    }
}

/// Whether `path` is `root` or sits underneath it, comparing component by
/// component so `/backups-elsewhere` is not treated as inside `/backups`.
///
/// Purely lexical, and deliberately so: it must give the same answer whether
/// or not the path exists yet, since backups are written into folders that are
/// created on demand.
pub fn is_inside(root: &Path, path: &Path) -> bool {
    let normal = |p: &Path| -> Option<Vec<String>> {
        let mut parts = Vec::new();
        for c in p.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_string_lossy().to_string()),
                Component::CurDir => {}
                // A parent component means the path climbs, and a lexical
                // check cannot safely decide where it lands.
                Component::ParentDir => return None,
                Component::RootDir => parts.push("/".into()),
                Component::Prefix(p) => parts.push(p.as_os_str().to_string_lossy().to_string()),
            }
        }
        Some(parts)
    };
    let (Some(r), Some(p)) = (normal(root), normal(path)) else {
        return false;
    };
    p.len() >= r.len() && r.iter().zip(p.iter()).all(|(a, b)| a == b)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        PathBuf::from("/home/user/backups")
    }

    #[test]
    fn an_ordinary_device_gets_an_ordinary_path() {
        let p = backup_path(&root(), "CORE-SW-01", "10.1.1.1", "20260828-101530", BackupKind::Running).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/home/user/backups/CORE-SW-01/20260828-101530-running-config.txt")
        );
    }

    #[test]
    fn a_hostile_device_name_cannot_escape_the_backup_folder() {
        // Device names come off the network. This is the whole reason this
        // module exists rather than the paths being built inline.
        for hostile in [
            "../../../etc/cron.d/x",
            "..",
            "../..",
            "/etc/passwd",
            "..\\..\\windows\\system32",
            "....//....//etc",
        ] {
            let p = backup_path(&root(), hostile, "10.1.1.1", "20260828-101530", BackupKind::Running)
                .expect("should fall back to a safe name, not fail");
            assert!(
                is_inside(&root(), &p),
                "{hostile:?} produced {p:?}, which is outside the backup folder"
            );
            assert!(!p.to_string_lossy().contains(".."), "{hostile:?} left a parent reference in {p:?}");
        }
    }

    #[test]
    fn a_name_that_sanitises_to_nothing_falls_back_to_the_address() {
        // "../.." is all separators and dots; there is no name left.
        let p = backup_path(&root(), "../..", "10.1.1.9", "20260828-101530", BackupKind::Running).unwrap();
        assert_eq!(
            p,
            PathBuf::from("/home/user/backups/10.1.1.9/20260828-101530-running-config.txt")
        );
    }

    #[test]
    fn a_device_with_neither_name_nor_address_is_refused() {
        // Inventing a name would file a backup somewhere nobody can find it.
        let err = backup_path(&root(), "", "", "20260828-101530", BackupKind::Running).unwrap_err();
        assert_eq!(err, BackupPathError::NoName);
    }

    #[test]
    fn no_backup_folder_chosen_is_its_own_error() {
        // Distinct from a bad name, because the UI response differs: one asks
        // the user to pick a folder, the other is a device problem.
        let err = backup_path(Path::new(""), "SW1", "10.1.1.1", "20260828-101530", BackupKind::Running)
            .unwrap_err();
        assert_eq!(err, BackupPathError::NoRoot);
    }

    #[test]
    fn spaces_and_punctuation_become_dashes_without_doubling_up() {
        assert_eq!(safe_component("Core Switch #1").unwrap(), "Core-Switch-1");
        assert_eq!(safe_component("a///b").unwrap(), "a-b");
        assert_eq!(safe_component("  padded  ").unwrap(), "padded");
    }

    #[test]
    fn an_fqdn_survives_intact() {
        // Dots are legal in a filename and an FQDN is a perfectly good folder
        // name; only leading dots are a problem.
        assert_eq!(safe_component("sw1.lab.example.com").unwrap(), "sw1.lab.example.com");
    }

    #[test]
    fn leading_dots_are_stripped_so_nothing_becomes_hidden_or_relative() {
        assert_eq!(safe_component(".hidden").unwrap(), "hidden");
        assert_eq!(safe_component("."), None);
        assert_eq!(safe_component(".."), None);
        assert_eq!(safe_component("..."), None);
    }

    #[test]
    fn a_very_long_name_is_truncated_to_a_legal_component() {
        let long = "A".repeat(500);
        let c = safe_component(&long).unwrap();
        assert!(c.len() <= MAX_COMPONENT, "component was {} bytes", c.len());
    }

    #[test]
    fn is_inside_is_not_fooled_by_a_shared_prefix() {
        // "/home/user/backups-elsewhere" starts with the root as a *string*
        // but is not inside it.
        assert!(is_inside(&root(), Path::new("/home/user/backups/sw1/x.txt")));
        assert!(is_inside(&root(), &root()));
        assert!(!is_inside(&root(), Path::new("/home/user/backups-elsewhere/x.txt")));
        assert!(!is_inside(&root(), Path::new("/home/user")));
        assert!(!is_inside(&root(), Path::new("/etc/passwd")));
    }

    #[test]
    fn is_inside_refuses_to_judge_a_path_that_climbs() {
        // A lexical check cannot say where "root/../.." lands, so it says no.
        assert!(!is_inside(&root(), Path::new("/home/user/backups/../../etc")));
    }

    #[test]
    fn timestamps_sort_chronologically_as_text() {
        let a = stamp(2026, 8, 28, 9, 5, 3);
        let b = stamp(2026, 8, 28, 10, 15, 30);
        let c = stamp(2026, 12, 1, 0, 0, 0);
        assert_eq!(a, "20260828-090503");
        assert!(a < b && b < c, "a directory listing should be in time order");
    }

    #[test]
    fn each_kind_carries_its_own_command_and_suffix() {
        assert_eq!(BackupKind::Running.command(), "show running-config");
        assert_eq!(BackupKind::Startup.command(), "show startup-config");
        let r = backup_path(&root(), "SW1", "", "20260828-101530", BackupKind::Startup).unwrap();
        assert!(r.to_string_lossy().ends_with("startup-config.txt"));
    }

    #[test]
    fn windows_style_roots_stay_inside_themselves() {
        let win = Path::new(r"C:\Users\me\backups");
        let p = win.join("SW1").join("x.txt");
        assert!(is_inside(win, &p));
        assert!(!is_inside(win, Path::new(r"C:\Users\me\other\x.txt")));
    }
}
