//! Telnet, for equipment that offers nothing better.
//!
//! Every credential and every byte of output crosses the network in clear
//! text. That is not a flaw in this implementation, it is what the protocol
//! is, and it is why this is never chosen automatically — a run has to ask
//! for it, and the interface says plainly what it costs.
//!
//! Only the parts a command-line session needs: option negotiation, a login
//! exchange, and reading until the device draws its prompt. Prompt handling,
//! paging and output extraction are shared with the SSH path in `cli`, so a
//! device behaves the same whichever way it was reached.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use crate::cli::{extract_output, find_prompt, is_paging, Prompt};
use crate::ssh::{Credentials, Secret, SshError};

const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

const OPT_ECHO: u8 = 1;
const OPT_SUPPRESS_GO_AHEAD: u8 = 3;

/// Splits a raw stream into the text it carries and the reply it demands.
///
/// Pure, because option negotiation is where a telnet client goes wrong in
/// ways that are invisible until a real device hangs waiting for an answer
/// nobody sent.
///
/// Returns the text with all commands removed, the bytes to write back, and
/// any trailing partial command to carry into the next read.
pub fn negotiate(input: &[u8]) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    let mut text = Vec::new();
    let mut reply = Vec::new();
    let mut i = 0;

    while i < input.len() {
        if input[i] != IAC {
            text.push(input[i]);
            i += 1;
            continue;
        }
        // A command needs at least one more byte to say what it is.
        if i + 1 >= input.len() {
            return (text, reply, input[i..].to_vec());
        }
        match input[i + 1] {
            // A doubled IAC is a literal 0xFF in the data.
            IAC => {
                text.push(IAC);
                i += 2;
            }
            WILL | WONT | DO | DONT => {
                if i + 2 >= input.len() {
                    return (text, reply, input[i..].to_vec());
                }
                let (verb, option) = (input[i + 1], input[i + 2]);
                reply.extend_from_slice(&[IAC, answer(verb, option), option]);
                i += 3;
            }
            SB => {
                // Subnegotiation runs until IAC SE. Nothing here needs its
                // content, but it has to be stepped over rather than treated
                // as text.
                let mut j = i + 2;
                while j + 1 < input.len() && !(input[j] == IAC && input[j + 1] == SE) {
                    j += 1;
                }
                if j + 1 >= input.len() {
                    return (text, reply, input[i..].to_vec());
                }
                i = j + 2;
            }
            // Any other two-byte command is stepped over.
            _ => i += 2,
        }
    }
    (text, reply, Vec::new())
}

/// What to answer a negotiation with.
///
/// Accepts the two options that make a session behave like a terminal, and
/// refuses everything else. Silence is not an option: a device that asked
/// will wait.
fn answer(verb: u8, option: u8) -> u8 {
    match verb {
        // The far end offering to do something.
        WILL => {
            if option == OPT_ECHO || option == OPT_SUPPRESS_GO_AHEAD {
                DO
            } else {
                DONT
            }
        }
        WONT => DONT,
        // The far end asking us to do something.
        DO => {
            if option == OPT_SUPPRESS_GO_AHEAD {
                WILL
            } else {
                WONT
            }
        }
        DONT => WONT,
        _ => WONT,
    }
}

/// Whether a device is asking for a username or a password.
///
/// Devices word this differently — "Username:", "login:", "User Name:" — and
/// the password prompt has to be told apart from the username one or the
/// password goes into the wrong field in clear text.
pub fn login_prompt(text: &str) -> Option<LoginPrompt> {
    let tail = text.trim_end();
    let lower = tail.to_ascii_lowercase();
    let last = lower.lines().last().unwrap_or("").trim().to_string();
    if last.contains("password") {
        return Some(LoginPrompt::Password);
    }
    if last.contains("username") || last.ends_with("login:") || last.contains("user name") {
        return Some(LoginPrompt::Username);
    }
    None
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginPrompt {
    Username,
    Password,
}

/// A telnet command-line session.
pub struct TelnetDevice {
    host: String,
    stream: TcpStream,
    pending: Vec<u8>,
    command_timeout: Duration,
    pub prompt: Prompt,
}

impl TelnetDevice {
    /// Connects, logs in, and turns paging off.
    pub async fn connect(
        host: &str,
        port: u16,
        credentials: &Credentials,
        connect_timeout: Duration,
        command_timeout: Duration,
    ) -> Result<Self, SshError> {
        let stream = tokio::time::timeout(connect_timeout, TcpStream::connect((host, port)))
            .await
            .map_err(|_| SshError::ConnectTimeout {
                host: host.to_string(),
                timeout: connect_timeout,
            })?
            .map_err(|source| SshError::Connect {
                host: host.to_string(),
                port,
                source,
            })?;

        let mut device = Self {
            host: host.to_string(),
            stream,
            pending: Vec::new(),
            command_timeout,
            prompt: Prompt::default(),
        };

        device.log_in(credentials).await?;
        // Best effort: a device that refuses it pages instead, which the read
        // loop already answers.
        let _ = device.run("terminal length 0").await;
        Ok(device)
    }

    /// Answers the login exchange, then waits for a prompt.
    async fn log_in(&mut self, credentials: &Credentials) -> Result<(), SshError> {
        let deadline = tokio::time::Instant::now() + self.command_timeout;
        let mut buffer = String::new();
        let mut sent_user = false;
        let mut sent_password = false;

        loop {
            if tokio::time::Instant::now() >= deadline {
                return Err(SshError::NoPrompt {
                    host: self.host.clone(),
                });
            }
            let chunk = self.read_chunk(deadline).await?;
            buffer.push_str(&chunk);

            // A device that rejects the login says so and asks again; taking
            // the second prompt for the first would sit there retrying.
            let lower = buffer.to_ascii_lowercase();
            if sent_password
                && (lower.contains("authentication failed")
                    || lower.contains("login invalid")
                    || lower.contains("access denied")
                    || lower.contains("% login failed"))
            {
                return Err(SshError::AuthFailed {
                    host: self.host.clone(),
                });
            }

            match login_prompt(&buffer) {
                Some(LoginPrompt::Username) if !sent_user => {
                    self.write_line(&credentials.username).await?;
                    sent_user = true;
                    buffer.clear();
                }
                Some(LoginPrompt::Password) if !sent_password => {
                    self.write_line(credentials.password.expose()).await?;
                    sent_password = true;
                    buffer.clear();
                }
                Some(LoginPrompt::Username) | Some(LoginPrompt::Password) => {
                    // Asked twice: the credentials were refused.
                    return Err(SshError::AuthFailed {
                        host: self.host.clone(),
                    });
                }
                None => {
                    if let Some(p) = find_prompt(&buffer) {
                        self.prompt = p;
                        return Ok(());
                    }
                }
            }
        }
    }

    /// Runs one command and returns its output.
    pub async fn run(&mut self, command: &str) -> Result<String, SshError> {
        self.write_line(command).await?;
        let raw = self.read_until_prompt(Some(command)).await?;
        Ok(extract_output(&raw, command))
    }

    /// Escalates to privileged mode.
    pub async fn enable(&mut self, password: Option<&Secret>) -> Result<bool, SshError> {
        if self.prompt.enabled {
            return Ok(true);
        }
        self.write_line("enable").await?;
        let raw = self.read_until_prompt(None).await?;
        if login_prompt(&raw) == Some(LoginPrompt::Password) {
            let Some(secret) = password else { return Ok(false) };
            self.write_line(secret.expose()).await?;
            let after = self.read_until_prompt(None).await?;
            if let Some(p) = find_prompt(&after) {
                self.prompt = p;
            }
        } else if let Some(p) = find_prompt(&raw) {
            self.prompt = p;
        }
        Ok(self.prompt.enabled)
    }

    pub fn hostname(&self) -> &str {
        &self.prompt.hostname
    }

    pub async fn close(mut self) {
        let _ = self.stream.shutdown().await;
    }

    async fn write_line(&mut self, text: &str) -> Result<(), SshError> {
        self.stream
            .write_all(format!("{text}\r\n").as_bytes())
            .await
            .map_err(|source| SshError::Connect {
                host: self.host.clone(),
                port: 23,
                source,
            })
    }

    /// Reads until the device draws its prompt, answering paging as it goes.
    async fn read_until_prompt(&mut self, command: Option<&str>) -> Result<String, SshError> {
        let deadline = tokio::time::Instant::now() + self.command_timeout;
        let mut buffer = String::new();
        loop {
            buffer.push_str(&self.read_chunk(deadline).await?);
            if is_paging(&buffer) {
                self.stream
                    .write_all(b" ")
                    .await
                    .map_err(|source| SshError::Connect {
                        host: self.host.clone(),
                        port: 23,
                        source,
                    })?;
                continue;
            }
            if find_prompt(&buffer).is_some() {
                // The echoed command is still in there; the caller strips it.
                let _ = command;
                return Ok(buffer);
            }
        }
    }

    /// One read, with the protocol's commands answered and removed.
    async fn read_chunk(&mut self, deadline: tokio::time::Instant) -> Result<String, SshError> {
        let mut raw = [0u8; 4096];
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(SshError::CommandTimeout {
                host: self.host.clone(),
                command: String::new(),
            });
        }
        let read = tokio::time::timeout(remaining, self.stream.read(&mut raw))
            .await
            .map_err(|_| SshError::CommandTimeout {
                host: self.host.clone(),
                command: String::new(),
            })?
            .map_err(|source| SshError::Connect {
                host: self.host.clone(),
                port: 23,
                source,
            })?;
        if read == 0 {
            return Err(SshError::NoPrompt {
                host: self.host.clone(),
            });
        }

        // Anything left over from a command split across two reads goes first.
        let mut input = std::mem::take(&mut self.pending);
        input.extend_from_slice(&raw[..read]);
        let (text, reply, partial) = negotiate(&input);
        self.pending = partial;
        if !reply.is_empty() {
            self.stream
                .write_all(&reply)
                .await
                .map_err(|source| SshError::Connect {
                    host: self.host.clone(),
                    port: 23,
                    source,
                })?;
        }
        Ok(String::from_utf8_lossy(&text).to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_commands_and_answers_them() {
        // What a Cisco sends first: it will echo and suppress go-ahead, and
        // wants a terminal type it is not getting.
        let input = [
            IAC, WILL, OPT_ECHO,
            IAC, WILL, OPT_SUPPRESS_GO_AHEAD,
            IAC, DO, 24, // terminal-type
            b'U', b's', b'e', b'r', b':',
        ];
        let (text, reply, partial) = negotiate(&input);
        assert_eq!(String::from_utf8_lossy(&text), "User:");
        assert!(partial.is_empty());
        assert_eq!(
            reply,
            vec![
                IAC, DO, OPT_ECHO,
                IAC, DO, OPT_SUPPRESS_GO_AHEAD,
                IAC, WONT, 24,
            ],
            "every request must be answered — a device that asked will wait"
        );
    }

    #[test]
    fn carries_a_split_command_into_the_next_read() {
        // TCP does not respect message boundaries, so a command can arrive in
        // two pieces. Treating the tail as text puts 0xFF in the output.
        let (text, reply, partial) = negotiate(&[b'h', b'i', IAC, DO]);
        assert_eq!(String::from_utf8_lossy(&text), "hi");
        assert!(reply.is_empty());
        assert_eq!(partial, vec![IAC, DO]);

        // And the rest of it, prepended by the caller.
        let mut next = partial;
        next.push(OPT_SUPPRESS_GO_AHEAD);
        let (text, reply, partial) = negotiate(&next);
        assert!(text.is_empty());
        assert_eq!(reply, vec![IAC, WILL, OPT_SUPPRESS_GO_AHEAD]);
        assert!(partial.is_empty());
    }

    #[test]
    fn a_doubled_iac_is_data() {
        let (text, _, _) = negotiate(&[b'a', IAC, IAC, b'b']);
        assert_eq!(text, vec![b'a', IAC, b'b']);
    }

    #[test]
    fn steps_over_subnegotiation() {
        let input = [b'a', IAC, SB, 24, 0, b'x', b'y', IAC, SE, b'b'];
        let (text, reply, partial) = negotiate(&input);
        assert_eq!(String::from_utf8_lossy(&text), "ab");
        assert!(reply.is_empty());
        assert!(partial.is_empty());
    }

    #[test]
    fn an_unterminated_subnegotiation_is_carried_over() {
        let (text, _, partial) = negotiate(&[b'a', IAC, SB, 24, 0]);
        assert_eq!(String::from_utf8_lossy(&text), "a");
        assert_eq!(partial, vec![IAC, SB, 24, 0]);
    }

    #[test]
    fn tells_a_username_prompt_from_a_password_one() {
        // Getting this wrong sends the password into the username field, in
        // clear text, on a protocol that has no other protection.
        assert_eq!(login_prompt("Username: "), Some(LoginPrompt::Username));
        assert_eq!(login_prompt("switch login: "), Some(LoginPrompt::Username));
        assert_eq!(login_prompt("User Name:"), Some(LoginPrompt::Username));
        assert_eq!(login_prompt("Password: "), Some(LoginPrompt::Password));
        assert_eq!(login_prompt("Enter password:"), Some(LoginPrompt::Password));
        assert_eq!(login_prompt("SW1#"), None);
        assert_eq!(login_prompt(""), None);
    }

    #[test]
    fn reads_the_last_line_not_the_banner() {
        // A login banner can mention either word; only the line the device is
        // waiting on counts.
        let banner = "Unauthorised access prohibited.\nThis system logs your username.\nPassword: ";
        assert_eq!(login_prompt(banner), Some(LoginPrompt::Password));
    }
}
