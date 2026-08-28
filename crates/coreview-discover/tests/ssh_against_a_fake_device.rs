//! Drives the real SSH client against a fake device.
//!
//! There is no network equipment on the machine this was written on, and the
//! parts of SSH most likely to be wrong — the handshake, the authentication
//! exchange, the Duo pause, reading until a prompt — cannot be checked by
//! feeding text to a parser. So the tests stand up an actual SSH server that
//! behaves like a switch, and point the actual client at it over a real socket.
//!
//! What this proves: the client connects, verifies a host key, survives a
//! password rejection, completes a keyboard-interactive exchange, waits through
//! a second-factor round that returns nothing to type, takes a shell, and reads
//! command output back cleanly.
//!
//! What it does not prove: how any particular vendor's box behaves. A real
//! device has a banner, its own paging quirks, and its own idea of when to
//! echo. That still needs one real device.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use tokio::sync::mpsc;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Device, Secret, SshError, SshOptions, SshProgress};

/// How the fake device should behave when asked to authenticate.
#[derive(Clone, Copy, PartialEq)]
enum AuthStyle {
    /// Accepts the password immediately. The simple case.
    PasswordOnly,
    /// Refuses password auth, then runs keyboard-interactive: asks for the
    /// password, then sends a round with no prompts at all — which is what
    /// push-only Duo looks like on the wire — and only then succeeds.
    DuoPush,
    /// Refuses everything.
    AlwaysReject,
}

#[derive(Clone)]
struct FakeDevice {
    style: AuthStyle,
    hostname: String,
    /// How far through the keyboard-interactive exchange this connection is.
    step: Arc<std::sync::Mutex<u8>>,
}

impl server::Handler for FakeDevice {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        match self.style {
            AuthStyle::PasswordOnly if password == "correct-horse" => Ok(Auth::Accept),
            // Refusing password auth is what pushes a real device's client on
            // to keyboard-interactive, where Duo lives.
            _ => Ok(Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                partial_success: false,
            }),
        }
    }

    async fn auth_keyboard_interactive(
        &mut self,
        _user: &str,
        _submethods: &str,
        response: Option<server::Response<'_>>,
    ) -> Result<Auth, Self::Error> {
        if self.style == AuthStyle::AlwaysReject {
            return Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            });
        }

        let mut step = self.step.lock().unwrap();
        match *step {
            0 => {
                *step = 1;
                Ok(Auth::Partial {
                    name: "Password".into(),
                    instructions: "".into(),
                    prompts: vec![("Password: ".into(), false)].into(),
                })
            }
            1 => {
                // Check what came back for the password prompt.
                let answered: Vec<String> = response
                    .map(|r| r.map(|b| String::from_utf8_lossy(&b).to_string()).collect())
                    .unwrap_or_default();
                if answered.first().map(String::as_str) != Some("correct-horse") {
                    return Ok(Auth::Reject {
                        proceed_with_methods: None,
                        partial_success: false,
                    });
                }
                *step = 2;
                // The Duo round: an instruction and nothing to type. A client
                // that insists on collecting an answer from a human stalls
                // here forever.
                Ok(Auth::Partial {
                    name: "Duo".into(),
                    instructions: "Duo two-factor login for admin".into(),
                    prompts: vec![].into(),
                })
            }
            _ => Ok(Auth::Accept),
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
        // A device draws its prompt as soon as the shell is up. That is the
        // only signal the client gets that login finished.
        session.data(channel, format!("\r\n{}#", self.hostname).into_bytes())?;
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

        // Echo the command after the prompt, exactly as a real terminal does —
        // this is the case that broke extract_output before it was fixed.
        let body = match command {
            "terminal length 0" => String::new(),
            "show version" => "Cisco IOS Software, Version 15.2(4)E7\r\nuptime is 3 weeks\r\n".into(),
            "show running-config" => {
                let mut c = String::from("Building configuration...\r\n\r\n");
                c.push_str("Current configuration : 1234 bytes\r\n!\r\nversion 15.2\r\n!\r\n");
                c.push_str(&format!("hostname {}\r\n!\r\n", self.hostname));
                for i in 1..=4 {
                    c.push_str(&format!("interface GigabitEthernet0/{i}\r\n switchport mode access\r\n!\r\n"));
                }
                // A banner containing a bare '#', which is the thing that used
                // to truncate a capture by looking like a prompt.
                c.push_str("banner motd #\r\nUnauthorized access prohibited\r\n#\r\n!\r\nend\r\n");
                c
            }
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };

        session.data(channel, format!("{command}\r\n{body}{}#", self.hostname).into_bytes())?;
        Ok(())
    }
}

/// Starts a fake device on a random port and returns its address.
async fn start_device(style: AuthStyle, hostname: &str) -> String {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .expect("generate host key");
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let handler = FakeDevice {
        style,
        hostname: hostname.to_string(),
        step: Arc::new(std::sync::Mutex::new(0)),
    };

    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            // A fresh handler per connection, so the keyboard-interactive step
            // counter does not leak between tests.
            let handler = FakeDevice {
                step: Arc::new(std::sync::Mutex::new(0)),
                ..handler.clone()
            };
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, handler).await;
            });
        }
    });

    addr.to_string()
}

fn creds(password: &str) -> Credentials {
    Credentials {
        username: "admin".into(),
        password: Secret::new(password),
        enable_password: None,
    }
}

fn options(port: u16) -> SshOptions {
    SshOptions {
        port,
        connect_timeout: Duration::from_secs(10),
        auth_timeout: Duration::from_secs(20),
        command_timeout: Duration::from_secs(10),
    }
}

fn port_of(addr: &str) -> u16 {
    addr.rsplit(':').next().unwrap().parse().unwrap()
}

#[tokio::test]
async fn connects_authenticates_and_runs_a_command() {
    let addr = start_device(AuthStyle::PasswordOnly, "CORE-SW-01").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    let mut device = Device::connect("127.0.0.1", &creds("correct-horse"), options(port_of(&addr)), store, None)
        .await
        .expect("should connect and log in");

    assert_eq!(device.hostname(), "CORE-SW-01", "the prompt names the device");

    let out = device.run("show version").await.unwrap();
    assert!(out.contains("Cisco IOS Software"), "got: {out:?}");
    assert!(!out.contains("show version"), "the echo leaked: {out:?}");
    assert!(!out.contains("CORE-SW-01#"), "the prompt leaked: {out:?}");

    device.close().await;
}

#[tokio::test]
async fn a_duo_push_completes_without_anything_to_type() {
    // The case this whole design exists for: the device refuses password auth,
    // asks for the password over keyboard-interactive, then sends a round with
    // no prompts while a push is outstanding. A client that waits for a human
    // to type something stalls here forever.
    let addr = start_device(AuthStyle::DuoPush, "EDGE-RTR").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, mut rx) = mpsc::channel(32);

    let device = Device::connect(
        "127.0.0.1",
        &creds("correct-horse"),
        options(port_of(&addr)),
        store,
        Some(tx),
    )
    .await
    .expect("a push-only Duo exchange should complete on its own");

    assert_eq!(device.hostname(), "EDGE-RTR");

    // And the user was told to look at their phone — without this a push is
    // indistinguishable from a hang.
    let mut told = None;
    while let Ok(p) = rx.try_recv() {
        if let SshProgress::AwaitingSecondFactor { message, .. } = p {
            told = Some(message);
        }
    }
    let message = told.expect("the UI must be told a second factor is pending");
    assert!(message.contains("Duo two-factor login"), "got: {message}");
    assert!(message.contains("phone"), "got: {message}");

    device.close().await;
}

#[tokio::test]
async fn a_configuration_survives_a_banner_containing_a_hash() {
    // A '#' inside a banner looks exactly like a prompt. Getting this wrong
    // truncates the capture and nobody notices until a restore.
    let addr = start_device(AuthStyle::PasswordOnly, "CORE-SW-01").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let mut device = Device::connect("127.0.0.1", &creds("correct-horse"), options(port_of(&addr)), store, None)
        .await
        .unwrap();

    let config = device.run("show running-config").await.unwrap();

    assert!(config.contains("hostname CORE-SW-01"));
    assert!(config.contains("interface GigabitEthernet0/4"), "capture stopped early: {config:?}");
    assert!(config.trim().ends_with("end"), "capture did not reach the end: {config:?}");
    assert!(coreview_discover::cli::looks_like_config(&config).is_ok());

    device.close().await;
}

#[tokio::test]
async fn wrong_credentials_are_reported_as_such() {
    let addr = start_device(AuthStyle::AlwaysReject, "SW1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    let err = match Device::connect("127.0.0.1", &creds("wrong"), options(port_of(&addr)), store, None).await {
        Err(e) => e,
        Ok(_) => panic!("bad credentials must not connect"),
    };

    // Whoever reads this needs to know it was the credentials, not the network.
    let msg = err.to_string();
    assert!(
        matches!(err, SshError::AuthFailed { .. }) || msg.contains("rejected"),
        "unhelpful error: {msg}"
    );
    assert!(!msg.contains("wrong"), "the attempted password leaked into the error: {msg}");
}

#[tokio::test]
async fn a_host_key_is_remembered_and_a_change_is_refused() {
    let addr = start_device(AuthStyle::PasswordOnly, "SW1").await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));

    Device::connect("127.0.0.1", &creds("correct-horse"), options(port_of(&addr)), Arc::clone(&store), None)
        .await
        .unwrap()
        .close()
        .await;

    assert_eq!(store.lock().unwrap().len(), 1, "first contact should record the key");

    // A second device on a new port has a different key. Pretend it is the
    // same host by rewriting the stored fingerprint to something else, which
    // is what an intercepted connection would look like.
    let addr2 = start_device(AuthStyle::PasswordOnly, "SW1").await;
    let port2 = port_of(&addr2);
    store
        .lock()
        .unwrap()
        .remember("127.0.0.1", port2, "SHA256:definitely-not-the-real-key");

    let err = match Device::connect("127.0.0.1", &creds("correct-horse"), options(port2), Arc::clone(&store), None).await {
        Err(e) => e,
        Ok(_) => panic!("a changed host key must refuse to connect"),
    };

    assert!(matches!(err, SshError::HostKeyChanged(_)), "got: {err}");
    let msg = err.to_string();
    assert!(msg.contains("clear"), "the message must point at the way out: {msg}");
}

#[tokio::test]
async fn an_unreachable_device_fails_fast_rather_than_waiting_for_a_push() {
    // The connect deadline is short on purpose: a crawl must keep moving past
    // dead addresses, and only *authentication* waits on a human.
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let opts = SshOptions {
        // Port 1 on loopback refuses immediately.
        port: 1,
        connect_timeout: Duration::from_secs(3),
        auth_timeout: Duration::from_secs(60),
        command_timeout: Duration::from_secs(10),
    };

    let started = std::time::Instant::now();
    let err = match Device::connect("127.0.0.1", &creds("x"), opts, store, None).await {
        Err(e) => e,
        Ok(_) => panic!("nothing is listening on port 1"),
    };
    let elapsed = started.elapsed();

    assert!(
        elapsed < Duration::from_secs(10),
        "took {elapsed:?}; a dead device must not wait out the auth deadline"
    );
    assert!(err.to_string().contains("127.0.0.1"), "got: {err}");
}
