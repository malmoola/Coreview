//! Takes a real backup off a fake device, over a real SSH session.
//!
//! The unit tests cover the writer with text handed to it directly. This covers
//! the part in between: that a configuration read off a terminal — echoed,
//! prompt-terminated, containing a banner with a bare `#` — reaches the file
//! intact, and that a device which cannot produce one leaves no file behind.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use coreview_discover::backup::BackupKind;
use coreview_discover::capture::{run_backups, BackupOptions, BackupTarget};
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Secret, SshOptions};

/// A configuration with the things that trip a naive capture: a banner
/// containing a bare `#`, and enough lines to be plausible.
fn running_config(hostname: &str) -> String {
    let mut c = String::from("Building configuration...\r\n\r\nCurrent configuration : 2048 bytes\r\n!\r\nversion 15.2\r\n!\r\n");
    c.push_str(&format!("hostname {hostname}\r\n!\r\n"));
    c.push_str("banner motd #\r\nUnauthorized access prohibited\r\n#\r\n!\r\n");
    for i in 1..=6 {
        c.push_str(&format!("interface GigabitEthernet0/{i}\r\n switchport mode access\r\n!\r\n"));
    }
    c.push_str("snmp-server community s3cr3t RO\r\n!\r\nend\r\n");
    c
}

#[derive(Clone)]
struct FakeSwitch {
    hostname: String,
    /// The device logs in at `>` and refuses to escalate, like an account
    /// without privilege 15.
    stuck_in_user_mode: bool,
    enabled: Arc<std::sync::Mutex<bool>>,
}

impl server::Handler for FakeSwitch {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-horse" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject { proceed_with_methods: None, partial_success: false })
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        reply: server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        _channel: ChannelId,
        _term: &str,
        _cw: u32,
        _rh: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        Ok(())
    }

    async fn shell_request(
        &mut self,
        channel: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        // User mode draws '>', enable mode draws '#'. That difference is the
        // whole reason `enable` exists.
        let mark = if self.stuck_in_user_mode { '>' } else { '#' };
        session.data(channel, format!("\r\n{}{mark}", self.hostname).into_bytes())?;
        Ok(())
    }

    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let line = String::from_utf8_lossy(data);
        let command = line.trim();
        let is_enabled = *self.enabled.lock().unwrap() || !self.stuck_in_user_mode;

        if command == "enable" {
            if self.stuck_in_user_mode {
                // Asks for a password and then refuses, staying at '>'.
                session.data(channel, format!("Password: \r\n% Access denied\r\n{}>", self.hostname).into_bytes())?;
            } else {
                *self.enabled.lock().unwrap() = true;
                session.data(channel, format!("\r\n{}#", self.hostname).into_bytes())?;
            }
            return Ok(());
        }

        let body: String = match command {
            "terminal length 0" => String::new(),
            "show running-config" if is_enabled => running_config(&self.hostname),
            "show running-config" => "% Invalid input detected at '^' marker.\r\n".into(),
            "show startup-config" if is_enabled => running_config(&self.hostname),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };

        let mark = if is_enabled { '#' } else { '>' };
        session.data(channel, format!("{command}\r\n{body}{}{mark}", self.hostname).into_bytes())?;
        Ok(())
    }
}

async fn start(hostname: &str, stuck_in_user_mode: bool) -> u16 {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519).unwrap();
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let switch = FakeSwitch {
        hostname: hostname.to_string(),
        stuck_in_user_mode,
        enabled: Arc::new(std::sync::Mutex::new(false)),
    };
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            let switch = FakeSwitch {
                enabled: Arc::new(std::sync::Mutex::new(false)),
                ..switch.clone()
            };
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, switch).await;
            });
        }
    });
    port
}

fn temp_root(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("coreview-e2e-{label}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn creds(password: &str) -> Credentials {
    Credentials {
        username: "admin".into(),
        password: Secret::new(password),
        enable_password: Some(Secret::new("enable-secret")),
    }
}

fn options(root: std::path::PathBuf, port: u16, kinds: Vec<BackupKind>) -> BackupOptions {
    BackupOptions {
        root,
        kinds,
        ssh: SshOptions {
            port,
            connect_timeout: Duration::from_secs(5),
            auth_timeout: Duration::from_secs(10),
            command_timeout: Duration::from_secs(10),
        },
        second_factor: false,
    }
}

#[tokio::test]
async fn a_configuration_read_off_a_terminal_reaches_the_file_intact() {
    let port = start("CORE-SW-01", false).await;
    let root = temp_root("intact");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "seed-name".into() }],
        creds("correct-horse"),
        options(root.clone(), port, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.failed.is_empty(), "unexpected failures: {:?}", run.failed);
    assert_eq!(run.saved.len(), 1);

    let saved = &run.saved[0];
    // Filed under the device's own name, not the one the caller guessed.
    assert_eq!(saved.name, "CORE-SW-01", "the device's own name should win");
    assert!(saved.path.contains("CORE-SW-01"), "got {}", saved.path);

    let text = std::fs::read_to_string(&saved.path).unwrap();
    assert!(text.contains("hostname CORE-SW-01"));
    // The banner's bare '#' must not have truncated the capture.
    assert!(text.contains("interface GigabitEthernet0/6"), "capture stopped early:\n{text}");
    assert!(text.contains("snmp-server community"), "capture stopped early:\n{text}");
    assert!(text.trim().ends_with("end"));
    // And the terminal's own noise must not have got in.
    assert!(!text.contains("CORE-SW-01#"), "a prompt reached the file:\n{text}");
    assert!(!text.contains("show running-config"), "the echo reached the file:\n{text}");

    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn a_device_stuck_in_user_mode_fails_instead_of_filing_an_error() {
    // The failure this is built to prevent: a file under the device's name
    // containing "% Invalid input", which looks like a backup until you need it.
    let port = start("EDGE-RTR", true).await;
    let root = temp_root("usermode");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "EDGE-RTR".into() }],
        creds("correct-horse"),
        options(root.clone(), port, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.saved.is_empty(), "nothing should have been written");
    assert_eq!(run.failed.len(), 1);
    assert!(
        run.failed[0].reason.contains("user mode"),
        "the reason should name the cause: {}",
        run.failed[0].reason
    );

    // No stray folder suggesting the device was ever backed up.
    assert!(!root.join("EDGE-RTR").exists(), "an empty device folder was left behind");
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn both_configurations_are_captured_separately() {
    let port = start("SW1", false).await;
    let root = temp_root("both");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "SW1".into() }],
        creds("correct-horse"),
        options(root.clone(), port, vec![BackupKind::Running, BackupKind::Startup]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(run.saved.len(), 2, "got {:?}", run.saved);
    assert!(run.saved.iter().any(|s| s.path.contains("running-config")));
    assert!(run.saved.iter().any(|s| s.path.contains("startup-config")));
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn one_bad_device_does_not_stop_the_rest_of_a_bulk_run() {
    // Ninety-nine switches must not go unbacked because the hundredth is off.
    let good = start("SW-GOOD", false).await;
    let root = temp_root("bulk");
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let run = run_backups(
        vec![
            BackupTarget { address: "127.0.0.9".into(), name: "SW-DEAD".into() },
            BackupTarget { address: "127.0.0.1".into(), name: "SW-GOOD".into() },
        ],
        creds("correct-horse"),
        options(root.clone(), good, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(run.failed.len(), 1, "the dead one should be recorded");
    assert_eq!(run.saved.len(), 1, "the live one should still have been backed up");
    assert_eq!(run.saved[0].name, "SW-GOOD");
    std::fs::remove_dir_all(&root).ok();
}

#[tokio::test]
async fn with_no_backup_folder_chosen_nothing_is_attempted() {
    let port = start("SW1", false).await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(128);

    let run = run_backups(
        vec![BackupTarget { address: "127.0.0.1".into(), name: "SW1".into() }],
        creds("correct-horse"),
        options(std::path::PathBuf::new(), port, vec![BackupKind::Running]),
        store,
        "20260828-120000".into(),
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(run.saved.is_empty());
    assert_eq!(run.failed.len(), 1);
    assert!(run.failed[0].reason.contains("folder"), "got: {}", run.failed[0].reason);
}
