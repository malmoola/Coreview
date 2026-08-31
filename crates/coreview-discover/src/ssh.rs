//! SSH to a network device.
//!
//! Not a general SSH client. It does the one conversation network equipment
//! expects: log in, take a terminal, stop it paging, run commands, read until
//! the prompt comes back.
//!
//! ## Duo
//!
//! Push-only, which is simpler than it sounds. The device asks Duo over RADIUS
//! and the SSH authentication simply blocks until the push is approved on the
//! phone. There is nothing to type, so there is no prompt to show and no answer
//! to collect — the client responds to the password challenge, responds to
//! anything after it with an empty answer, and waits.
//!
//! Two consequences fall out of that and are enforced here rather than left to
//! the caller. Authentication needs a much longer deadline than a connection
//! does, because a person has to reach for their phone; and only one device can
//! be authenticated at a time, because nobody can approve sixty-four pushes at
//! once.

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::{cipher, kex, mac, Preferred};
use russh::keys::ssh_key::HashAlg;
use russh::keys::PublicKeyOrCertificate;
use russh::{ChannelMsg, Disconnect};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::cli::{extract_output, find_prompt, is_paging, Prompt};
use crate::hostkeys::{changed_key_message, HostKeyStore, HostKeyVerdict};

/// A password, kept out of anything that prints.
///
/// The point is the `Debug` implementation: a credential struct that derives
/// `Debug` ends up in a log line or an error message eventually, and this is
/// the cheapest way to make that impossible rather than merely unlikely.
#[derive(Clone)]
pub struct Secret(String);

impl Secret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
    /// Crate-visible, not public: the telnet transport needs it to answer a
    /// login prompt, and nothing outside this crate should be able to read a
    /// secret back out at all.
    pub(crate) fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret(***)")
    }
}

#[derive(Clone, Debug)]
pub struct Credentials {
    pub username: String,
    pub password: Secret,
    /// Password for `enable`, when the device drops into user mode on login
    /// and the commands we need are privileged.
    pub enable_password: Option<Secret>,
}

#[derive(Clone, Debug)]
pub struct SshOptions {
    pub port: u16,
    /// How long to wait for a TCP connection and key exchange. Short: an
    /// unreachable device should fail fast so a crawl keeps moving.
    pub connect_timeout: Duration,
    /// How long to wait for authentication to complete. Long, because a Duo
    /// push waits on a person. Kept separate from `connect_timeout` for
    /// exactly that reason — one is a network fact, the other is human.
    pub auth_timeout: Duration,
    /// How long to wait for a command's output to finish arriving.
    pub command_timeout: Duration,
}

impl Default for SshOptions {
    fn default() -> Self {
        Self {
            port: 22,
            connect_timeout: Duration::from_secs(8),
            auth_timeout: Duration::from_secs(90),
            command_timeout: Duration::from_secs(60),
        }
    }
}

/// What is happening, for a progress line in the UI.
///
/// `AwaitingSecondFactor` is the one that matters: without it, a Duo push looks
/// exactly like a hung connection, and the user has no reason to look at their
/// phone.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SshProgress {
    Connecting { host: String },
    CheckingHostKey { host: String },
    Authenticating { host: String },
    AwaitingSecondFactor { host: String, message: String },
    Ready { host: String, hostname: String },
    Running { host: String, command: String },
}

#[derive(Debug, thiserror::Error)]
pub enum SshError {
    #[error("could not reach {host}:{port}: {source}")]
    Connect {
        host: String,
        port: u16,
        source: std::io::Error,
    },
    #[error("{host} did not answer within {}s", .timeout.as_secs())]
    ConnectTimeout { host: String, timeout: Duration },
    #[error("{0}")]
    HostKeyChanged(String),
    #[error("{host} rejected the credentials")]
    AuthFailed { host: String },
    #[error("authentication to {host} was not completed within {}s — if this was a Duo push, it was not approved in time", .timeout.as_secs())]
    AuthTimeout { host: String, timeout: Duration },
    #[error("{host} never presented a command prompt; it may not be a device with a CLI")]
    NoPrompt { host: String },
    #[error("{host} stopped responding while running `{command}`")]
    CommandTimeout { host: String, command: String },
    #[error("ssh error talking to {host}: {source}")]
    Protocol {
        host: String,
        #[source]
        source: russh::Error,
    },
}

/// Decides whether to trust the key a device presented, and records the answer.
///
/// russh calls this during the handshake, before authentication, which is the
/// only correct place: a password must not be sent to a host whose identity has
/// not been settled.
struct Verifier {
    host: String,
    port: u16,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    /// Set when the key differed, so the connect path can report *why* it was
    /// refused rather than a bare handshake failure.
    rejection: Arc<std::sync::Mutex<Option<String>>>,
}

impl client::Handler for Verifier {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else {
            // A certificate-based host identity is a different trust model and
            // this store cannot express it. Refusing is honest.
            *self.rejection.lock().unwrap() = Some(format!(
                "{} presented a host certificate rather than a key, which Coreview cannot verify",
                self.host
            ));
            return Ok(false);
        };
        let fingerprint = key.key_data().fingerprint(HashAlg::Sha256).to_string();

        let mut store = self.store.lock().unwrap();
        match store.check(&self.host, self.port, &fingerprint) {
            HostKeyVerdict::Known => Ok(true),
            HostKeyVerdict::New => {
                store.remember(&self.host, self.port, &fingerprint);
                Ok(true)
            }
            HostKeyVerdict::Changed { remembered } => {
                *self.rejection.lock().unwrap() = Some(changed_key_message(
                    &self.host,
                    self.port,
                    &remembered,
                    &fingerprint,
                ));
                Ok(false)
            }
        }
    }
}


/// Algorithm preferences that can actually reach network equipment.
///
/// russh's defaults are what a modern SSH client should offer, and a great deal
/// of network gear cannot meet them. A Catalyst running a current IOS image
/// offers `diffie-hellman-group14-sha1` and `diffie-hellman-group-exchange-sha1`
/// and nothing else, so a client with only SHA-2 key exchange fails the
/// handshake before it ever sees a password prompt — which is exactly what
/// happened the first time this was pointed at a real switch.
///
/// The legacy algorithms are appended **after** the modern ones rather than
/// replacing them. SSH negotiation picks the client's first choice the server
/// also supports, so a modern device still negotiates modern algorithms and
/// nothing is weakened for equipment that can do better; the old names are only
/// reached when the alternative is not connecting at all.
///
/// This is a deliberate trade, and worth being clear about: talking to a switch
/// that only speaks SHA-1 means using SHA-1. The honest options are to support
/// it or to not manage the device.
fn network_device_algorithms() -> Preferred {
    let mut kex: Vec<kex::Name> = Preferred::DEFAULT.kex.to_vec();
    // NIST ECDH: not in russh's defaults, but a hardened IOS-XE box is often
    // locked to exactly `ecdh-sha2-nistp521 ecdh-sha2-nistp384` — the lab
    // 9300 refused every default offer with "No common Kex algorithm"
    // (LT-054). Biggest curve first, all below the modern curves.
    kex.extend([
        kex::ECDH_SHA2_NISTP521,
        kex::ECDH_SHA2_NISTP384,
        kex::ECDH_SHA2_NISTP256,
    ]);
    kex.extend([kex::DH_G14_SHA1, kex::DH_GEX_SHA1]);

    let mut cipher: Vec<cipher::Name> = Preferred::DEFAULT.cipher.to_vec();
    cipher.extend([
        cipher::AES_256_CBC,
        cipher::AES_192_CBC,
        cipher::AES_128_CBC,
    ]);

    let mut mac: Vec<mac::Name> = Preferred::DEFAULT.mac.to_vec();
    mac.extend([mac::HMAC_SHA1_ETM, mac::HMAC_SHA1]);

    Preferred {
        kex: kex.into(),
        cipher: cipher.into(),
        mac: mac.into(),
        ..Preferred::DEFAULT
    }
}

/// An open session on a device.
pub struct Device {
    host: String,
    handle: client::Handle<Verifier>,
    channel: russh::Channel<client::Msg>,
    options: SshOptions,
    /// The prompt this device draws, learned at login and used to know when a
    /// command has finished.
    pub prompt: Prompt,
}

impl Device {
    /// Connects, authenticates, takes a terminal and turns paging off.
    ///
    /// `progress` receives status as it goes; it is how the UI says "waiting
    /// for Duo" instead of appearing to hang.
    pub async fn connect(
        host: &str,
        credentials: &Credentials,
        options: SshOptions,
        store: Arc<std::sync::Mutex<HostKeyStore>>,
        progress: Option<mpsc::Sender<SshProgress>>,
    ) -> Result<Self, SshError> {
        let say = |p: SshProgress| {
            if let Some(tx) = &progress {
                let _ = tx.try_send(p);
            }
        };

        say(SshProgress::Connecting {
            host: host.to_string(),
        });

        let rejection = Arc::new(std::sync::Mutex::new(None));
        let verifier = Verifier {
            host: host.to_string(),
            port: options.port,
            store,
            rejection: Arc::clone(&rejection),
        };

        let config = Arc::new(client::Config {
            inactivity_timeout: Some(Duration::from_secs(300)),
            preferred: network_device_algorithms(),
            ..Default::default()
        });

        say(SshProgress::CheckingHostKey {
            host: host.to_string(),
        });

        let connect = client::connect(config, (host, options.port), verifier);
        let mut handle = match timeout(options.connect_timeout, connect).await {
            Err(_) => {
                return Err(SshError::ConnectTimeout {
                    host: host.to_string(),
                    timeout: options.connect_timeout,
                })
            }
            Ok(Err(e)) => {
                // A refused key surfaces from russh as a generic handshake
                // failure, so the specific reason is carried out of the
                // verifier rather than lost.
                if let Some(why) = rejection.lock().unwrap().take() {
                    return Err(SshError::HostKeyChanged(why));
                }
                return Err(SshError::Protocol {
                    host: host.to_string(),
                    source: e,
                });
            }
            Ok(Ok(h)) => h,
        };

        say(SshProgress::Authenticating {
            host: host.to_string(),
        });
        let auth = authenticate(&mut handle, host, credentials, &say);
        match timeout(options.auth_timeout, auth).await {
            Err(_) => {
                return Err(SshError::AuthTimeout {
                    host: host.to_string(),
                    timeout: options.auth_timeout,
                })
            }
            Ok(result) => result?,
        }

        let channel = handle.channel_open_session().await.map_err(|e| SshError::Protocol {
            host: host.to_string(),
            source: e,
        })?;

        // A terminal wide enough that the device does not wrap its own output,
        // and tall enough that `terminal length 0` is not the only thing
        // standing between us and a paged capture.
        channel
            .request_pty(true, "vt100", 200, 200, 0, 0, &[])
            .await
            .map_err(|e| SshError::Protocol {
                host: host.to_string(),
                source: e,
            })?;
        channel.request_shell(true).await.map_err(|e| SshError::Protocol {
            host: host.to_string(),
            source: e,
        })?;

        let mut device = Device {
            host: host.to_string(),
            handle,
            channel,
            options,
            // Replaced immediately below; a shell has no prompt until it draws
            // one.
            prompt: Prompt {
                text: String::new(),
                hostname: String::new(),
                enabled: false,
            },
        };

        device.prompt = device.read_until_prompt(None).await?;
        say(SshProgress::Ready {
            host: host.to_string(),
            hostname: device.prompt.hostname.clone(),
        });

        // Turn paging off. Failure is not fatal — some accounts cannot set it —
        // because strip_paging can still clean up after it.
        let _ = device.run("terminal length 0").await;

        Ok(device)
    }

    /// Runs one command and returns its output, with the echo and the trailing
    /// prompt removed.
    pub async fn run(&mut self, command: &str) -> Result<String, SshError> {
        self.channel
            .data(format!("{command}\n").as_bytes())
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })?;

        let raw = self.read_raw_until_prompt(Some(command)).await?;
        Ok(extract_output(&raw, command))
    }

    /// Reads until the device draws its prompt, returning the prompt itself.
    async fn read_until_prompt(&mut self, command: Option<&str>) -> Result<Prompt, SshError> {
        let raw = self.read_raw_until_prompt(command).await?;
        find_prompt(&raw).ok_or_else(|| SshError::NoPrompt {
            host: self.host.clone(),
        })
    }

    /// The read loop. Accumulates output until a prompt appears at the end.
    ///
    /// Paging is answered with a space rather than treated as the end of
    /// output: on a device where `terminal length 0` was refused, stopping at
    /// the first `--More--` would truncate every long capture.
    async fn read_raw_until_prompt(&mut self, command: Option<&str>) -> Result<String, SshError> {
        let mut buffer = String::new();
        let deadline = tokio::time::Instant::now() + self.options.command_timeout;

        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(SshError::CommandTimeout {
                    host: self.host.clone(),
                    command: command.unwrap_or("<login>").to_string(),
                });
            }

            match timeout(remaining, self.channel.wait()).await {
                Err(_) => {
                    return Err(SshError::CommandTimeout {
                        host: self.host.clone(),
                        command: command.unwrap_or("<login>").to_string(),
                    })
                }
                Ok(None) => {
                    // The channel closed. Whatever arrived is all there is.
                    return Ok(buffer);
                }
                Ok(Some(msg)) => match msg {
                    ChannelMsg::Data { ref data } => {
                        buffer.push_str(&String::from_utf8_lossy(data));
                        if is_paging(&buffer) {
                            let _ = self.channel.data(&b" "[..]).await;
                            continue;
                        }
                        if find_prompt(&buffer).is_some() {
                            return Ok(buffer);
                        }
                    }
                    ChannelMsg::ExtendedData { ref data, .. } => {
                        buffer.push_str(&String::from_utf8_lossy(data));
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => return Ok(buffer),
                    _ => {}
                },
            }
        }
    }

    /// Escalates to enable mode, if the device left us in user mode.
    ///
    /// Worth doing before a configuration capture rather than after: from user
    /// mode `show running-config` returns an error, and an error saved as a
    /// backup is worse than a backup that failed.
    pub async fn enable(&mut self, password: Option<&Secret>) -> Result<bool, SshError> {
        if self.prompt.enabled {
            return Ok(true);
        }
        self.channel
            .data(&b"enable\n"[..])
            .await
            .map_err(|e| SshError::Protocol {
                host: self.host.clone(),
                source: e,
            })?;

        // The device answers with a password prompt, which is not a CLI prompt,
        // so the ordinary read loop would wait for one that never comes.
        let mut buffer = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(false);
            }
            match timeout(remaining, self.channel.wait()).await {
                Ok(Some(ChannelMsg::Data { ref data })) => {
                    buffer.push_str(&String::from_utf8_lossy(data));
                    if buffer.to_ascii_lowercase().contains("password") {
                        let secret = password.map(|p| p.expose()).unwrap_or("");
                        let _ = self.channel.data(format!("{secret}\n").as_bytes()).await;
                        buffer.clear();
                        continue;
                    }
                    if let Some(p) = find_prompt(&buffer) {
                        let ok = p.enabled;
                        self.prompt = p;
                        return Ok(ok);
                    }
                }
                Ok(Some(_)) => {}
                _ => return Ok(false),
            }
        }
    }

    pub fn hostname(&self) -> &str {
        &self.prompt.hostname
    }

    pub async fn close(self) {
        let _ = self.channel.eof().await;
        let _ = self
            .handle
            .disconnect(Disconnect::ByApplication, "", "English")
            .await;
    }
}

/// Password first, then keyboard-interactive.
///
/// Both are tried because devices differ about which one they offer for the
/// same credentials, and Duo lives on keyboard-interactive.
async fn authenticate(
    handle: &mut client::Handle<Verifier>,
    host: &str,
    credentials: &Credentials,
    say: &impl Fn(SshProgress),
) -> Result<(), SshError> {
    let protocol = |e: russh::Error| SshError::Protocol {
        host: host.to_string(),
        source: e,
    };

    let ok = handle
        .authenticate_password(&credentials.username, credentials.password.expose())
        .await
        .map_err(protocol)?;
    if ok.success() {
        return Ok(());
    }

    let mut response = handle
        .authenticate_keyboard_interactive_start(&credentials.username, None)
        .await
        .map_err(protocol)?;

    // Bounded so a device that keeps asking cannot spin here forever. Real
    // exchanges are two or three rounds: password, then the Duo wait.
    for _ in 0..8 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(SshError::AuthFailed {
                    host: host.to_string(),
                })
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                instructions,
                prompts,
                ..
            } => {
                // A request with no prompts is the server talking, not asking:
                // with push-only Duo this is "a push has been sent". The
                // correct reply is an empty response, and then more waiting.
                let answers: Vec<String> = prompts
                    .iter()
                    .map(|p| {
                        if looks_like_password(&p.prompt) {
                            credentials.password.expose().to_string()
                        } else {
                            // Anything else is the second factor. Push-only
                            // means there is nothing to type; an empty answer
                            // is what triggers the push in an autopush setup.
                            String::new()
                        }
                    })
                    .collect();

                let waiting = prompts.is_empty() || prompts.iter().any(|p| !looks_like_password(&p.prompt));
                if waiting {
                    let message = second_factor_message(&instructions);
                    say(SshProgress::AwaitingSecondFactor {
                        host: host.to_string(),
                        message,
                    });
                }

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(protocol)?;
            }
        }
    }

    Err(SshError::AuthFailed {
        host: host.to_string(),
    })
}

/// Whether a challenge is asking for the account password rather than a second
/// factor.
fn looks_like_password(prompt: &str) -> bool {
    let p = prompt.to_ascii_lowercase();
    p.contains("password") && !p.contains("passcode")
}

/// What to show while a push is outstanding.
///
/// The device's own instruction text is used when there is one, because it
/// names the service and is more use than anything invented here. Otherwise a
/// sentence that tells the user to go and look at their phone, which is the
/// entire job of this message.
fn second_factor_message(instructions: &str) -> String {
    let trimmed = instructions.trim();
    if trimmed.is_empty() {
        "Waiting for second-factor approval — approve the push on your phone.".to_string()
    } else {
        format!("{trimmed} — approve the push on your phone.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_algorithms_are_offered_but_never_preferred() {
        // The order is the whole point: a modern device must still negotiate
        // modern algorithms, and the SHA-1 names exist only so an old switch
        // is reachable at all.
        let p = network_device_algorithms();

        let kex: Vec<&str> = p.kex.iter().map(|k| k.as_ref()).collect();
        assert!(kex.contains(&"diffie-hellman-group14-sha1"), "no legacy kex: {kex:?}");
        assert!(kex.contains(&"diffie-hellman-group-exchange-sha1"));
        let modern = kex.iter().position(|k| *k == "curve25519-sha256").unwrap();
        let legacy = kex.iter().position(|k| *k == "diffie-hellman-group14-sha1").unwrap();
        assert!(modern < legacy, "SHA-1 kex must sit below the modern ones");

        let macs: Vec<&str> = p.mac.iter().map(|m| m.as_ref()).collect();
        assert!(macs.contains(&"hmac-sha1"));
        let modern = macs.iter().position(|m| *m == "hmac-sha2-256-etm@openssh.com").unwrap();
        let legacy = macs.iter().position(|m| *m == "hmac-sha1").unwrap();
        assert!(modern < legacy, "SHA-1 MACs must sit below the modern ones");

        let ciphers: Vec<&str> = p.cipher.iter().map(|c| c.as_ref()).collect();
        assert!(ciphers.contains(&"aes256-cbc"), "CBC is common on older IOS");
        let modern = ciphers.iter().position(|c| *c == "aes256-ctr").unwrap();
        let legacy = ciphers.iter().position(|c| *c == "aes256-cbc").unwrap();
        assert!(modern < legacy, "CBC must sit below CTR and GCM");
    }

    /// LT-054: the lab 9300 is locked to `ip ssh server algorithm kex
    /// ecdh-sha2-nistp521 ecdh-sha2-nistp384` and refused every client offer
    /// — "No common Kex algorithm". IOS-XE hardening guides recommend
    /// exactly that pair, so this is what a locked-down enterprise switch
    /// looks like, not an oddity.
    #[test]
    fn nist_ecdh_kex_is_offered_for_hardened_ios_xe() {
        let p = network_device_algorithms();
        let kex: Vec<&str> = p.kex.iter().map(|k| k.as_ref()).collect();
        for want in ["ecdh-sha2-nistp521", "ecdh-sha2-nistp384", "ecdh-sha2-nistp256"] {
            assert!(kex.contains(&want), "{want} missing: {kex:?}");
        }
        // Preference order: modern curves first, NIST ECDH next, SHA-1 last.
        let curve = kex.iter().position(|k| *k == "curve25519-sha256").unwrap();
        let nist = kex.iter().position(|k| *k == "ecdh-sha2-nistp521").unwrap();
        let sha1 = kex.iter().position(|k| *k == "diffie-hellman-group14-sha1").unwrap();
        assert!(curve < nist && nist < sha1, "order wrong: {kex:?}");
    }

    #[test]
    fn a_password_never_appears_in_debug_output() {
        // Credentials end up in an error message or a log line eventually, and
        // this is what makes that impossible rather than merely unlikely.
        let creds = Credentials {
            username: "admin".into(),
            password: Secret::new("hunter2"),
            enable_password: Some(Secret::new("enable-secret")),
        };
        let rendered = format!("{creds:?}");
        assert!(!rendered.contains("hunter2"), "password leaked: {rendered}");
        assert!(!rendered.contains("enable-secret"), "enable password leaked: {rendered}");
        assert!(rendered.contains("admin"), "the username is not secret and is useful");
    }

    #[test]
    fn the_password_challenge_is_told_apart_from_the_second_factor() {
        // Answering a Duo passcode prompt with the account password would send
        // the password to Duo and fail in a confusing way.
        assert!(looks_like_password("Password: "));
        assert!(looks_like_password("admin@10.1.1.1's password:"));
        assert!(!looks_like_password("Passcode or option (1-1): "));
        assert!(!looks_like_password("Duo two-factor login for admin"));
        assert!(!looks_like_password("Enter a passcode or select one of the following options:"));
    }

    #[test]
    fn the_waiting_message_prefers_what_the_device_said() {
        // The device names the service; anything invented here would not.
        let m = second_factor_message("Duo two-factor login for admin");
        assert!(m.contains("Duo two-factor login for admin"));
        assert!(m.contains("phone"), "it must tell the user where to look");

        let m = second_factor_message("   ");
        assert!(m.contains("phone"));
        assert!(!m.starts_with("—"), "an empty instruction should not leave a dangling dash");
    }

    #[test]
    fn the_auth_deadline_is_far_longer_than_the_connect_deadline() {
        // A person has to reach for a phone. Sharing one timeout would either
        // make unreachable devices slow to fail or make Duo impossible.
        let o = SshOptions::default();
        assert!(
            o.auth_timeout >= o.connect_timeout * 5,
            "auth {:?} should dwarf connect {:?}",
            o.auth_timeout,
            o.connect_timeout
        );
        assert!(o.connect_timeout <= Duration::from_secs(10), "a dead device must fail fast");
        assert!(o.auth_timeout >= Duration::from_secs(60), "a push needs time to be approved");
    }

    #[test]
    fn errors_say_which_device_and_what_to_do() {
        // These are read by someone deciding whether the device, the network or
        // the credentials are at fault.
        let e = SshError::AuthTimeout {
            host: "10.1.1.1".into(),
            timeout: Duration::from_secs(90),
        };
        let msg = e.to_string();
        assert!(msg.contains("10.1.1.1"));
        assert!(msg.contains("Duo"), "the likely cause should be named: {msg}");

        let e = SshError::ConnectTimeout {
            host: "10.1.1.2".into(),
            timeout: Duration::from_secs(8),
        };
        assert!(e.to_string().contains("10.1.1.2"));
    }
}
