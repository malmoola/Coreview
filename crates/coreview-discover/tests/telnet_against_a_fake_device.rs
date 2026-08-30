//! Drives the telnet client against a server that behaves like a switch.
//!
//! The negotiation and prompt logic are unit-tested in the module; this is
//! the part those cannot cover — that the client answers a real socket in the
//! right order and comes away with a usable session.
//!
//! No real device was available to test against. The exchange below is what a
//! Cisco does on telnet: options first, then a banner, then Username and
//! Password, then a prompt.

use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use coreview_discover::ssh::{Credentials, Secret, SshError};
use coreview_discover::telnet::TelnetDevice;

const IAC: u8 = 255;
const DO: u8 = 253;
const WILL: u8 = 251;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TERMINAL_TYPE: u8 = 24;

/// A switch that wants a password, or one that refuses it.
async fn fake_switch(accept: bool) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();

        // Options first, exactly as a Cisco opens.
        socket
            .write_all(&[
                IAC, WILL, OPT_ECHO,
                IAC, WILL, OPT_SGA,
                IAC, DO, OPT_TERMINAL_TYPE,
            ])
            .await
            .unwrap();
        socket
            .write_all(b"\r\nUnauthorised access prohibited.\r\nUsername: ")
            .await
            .unwrap();

        let mut buf = [0u8; 1024];
        // The client's option replies and the username arrive together or
        // separately; read until a line ends.
        let mut seen = Vec::new();
        while !seen.contains(&b'\n') {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                return;
            }
            seen.extend_from_slice(&buf[..n]);
        }
        socket.write_all(b"\r\nPassword: ").await.unwrap();

        seen.clear();
        while !seen.contains(&b'\n') {
            let n = socket.read(&mut buf).await.unwrap();
            if n == 0 {
                return;
            }
            seen.extend_from_slice(&buf[..n]);
        }

        if !accept {
            socket
                .write_all(b"\r\n% Login invalid\r\n\r\nUsername: ")
                .await
                .unwrap();
            // Sit there, as a real device does, waiting for another attempt.
            let _ = socket.read(&mut buf).await;
            return;
        }

        socket.write_all(b"\r\nSW-TELNET>").await.unwrap();

        // Then answer commands until the client goes away.
        loop {
            let n = match socket.read(&mut buf).await {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            let line = String::from_utf8_lossy(&buf[..n]).trim().to_string();
            let body = match line.as_str() {
                "terminal length 0" => String::new(),
                "enable" => {
                    socket.write_all(b"\r\nPassword: ").await.unwrap();
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    if n == 0 {
                        return;
                    }
                    socket.write_all(b"\r\nSW-TELNET#").await.unwrap();
                    continue;
                }
                "show version" => "Cisco IOS Software, C2960X Software\r\n".into(),
                other => format!("% Unknown command: {other}\r\n"),
            };
            let prompt = "SW-TELNET>";
            socket
                .write_all(format!("{line}\r\n{body}{prompt}").as_bytes())
                .await
                .unwrap();
        }
    });

    port
}

fn creds() -> Credentials {
    Credentials {
        username: "netops".into(),
        password: Secret::new("correct-horse"),
        enable_password: Some(Secret::new("enable-me")),
    }
}

#[tokio::test]
async fn logs_in_over_telnet_and_runs_a_command() {
    let port = fake_switch(true).await;
    let mut device = TelnetDevice::connect(
        "127.0.0.1",
        port,
        &creds(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .await
    .expect("the session should establish");

    assert_eq!(device.hostname(), "SW-TELNET");
    assert!(!device.prompt.enabled, "a telnet login lands in user mode");

    let out = device.run("show version").await.expect("the command should run");
    assert!(out.contains("Cisco IOS Software"), "got: {out:?}");
    // The echoed command must not be in the output.
    assert!(!out.starts_with("show version"), "the echo leaked: {out:?}");

    device.close().await;
}

#[tokio::test]
async fn a_refused_login_is_reported_rather_than_retried_forever() {
    // A device that rejects the credentials asks again. Taking the second
    // prompt for the first would sit there retrying until the timeout.
    let port = fake_switch(false).await;
    let err = TelnetDevice::connect(
        "127.0.0.1",
        port,
        &creds(),
        Duration::from_secs(5),
        Duration::from_secs(5),
    )
    .await
    .map(|_| ())
    .expect_err("a refused login must not succeed");

    assert!(
        matches!(err, SshError::AuthFailed { .. }),
        "should be an authentication failure, got: {err}"
    );
    assert!(
        !err.to_string().contains("correct-horse"),
        "the password leaked into the error: {err}"
    );
}

#[tokio::test]
async fn nothing_listening_fails_quickly() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    drop(listener);

    let err = TelnetDevice::connect(
        "127.0.0.1",
        port,
        &creds(),
        Duration::from_secs(2),
        Duration::from_secs(2),
    )
    .await
    .map(|_| ())
    .expect_err("there is nothing there");
    assert!(matches!(err, SshError::Connect { .. } | SshError::ConnectTimeout { .. }), "{err}");
}
