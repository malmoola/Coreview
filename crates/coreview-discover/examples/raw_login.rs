//! Dumps exactly what a device sends after login, with nothing parsed.
//!
//! When a device connects but never reaches a usable state, the question is
//! always what it actually sent — a banner waiting on a keypress, a prompt in
//! a shape the prompt finder rejects, or nothing at all. Guessing at that from
//! an error message is how a fix gets written for the wrong problem.
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... \
//!       cargo run -p coreview-discover --example raw_login

use std::sync::Arc;
use std::time::Duration;

use russh::client::{self, Handler};
use russh::keys::PublicKeyOrCertificate;
use russh::ChannelMsg;

struct AcceptAny;

impl Handler for AcceptAny {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        // A diagnostic run against a device the operator named. Host key
        // policy is the crawler's job, not this tool's.
        Ok(true)
    }
}

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let send = std::env::var("CV_SEND").unwrap_or_default();
    let seconds: u64 = std::env::var("CV_WAIT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8);

    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(60)),
        ..Default::default()
    });
    let mut handle = client::connect(config, (host.as_str(), 22), AcceptAny)
        .await
        .expect("connect");
    let authenticated = handle
        .authenticate_password(&user, &pass)
        .await
        .expect("authenticate");
    println!("== auth: {authenticated:?}");

    let mut channel = handle.channel_open_session().await.expect("open session");
    channel
        .request_pty(true, "vt100", 200, 200, 0, 0, &[])
        .await
        .expect("pty");
    channel.request_shell(true).await.expect("shell");

    if !send.is_empty() {
        for line in send.split(';') {
            tokio::time::sleep(Duration::from_millis(700)).await;
            println!("== sending {line:?}");
            channel.data(format!("{line}\n").as_bytes()).await.expect("send");
        }
    }

    let deadline = tokio::time::Instant::now() + Duration::from_secs(seconds);
    let mut buffer = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => buffer.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => buffer.extend_from_slice(&data),
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => break,
        }
    }

    let text = String::from_utf8_lossy(&buffer);
    println!("== {} bytes received", buffer.len());
    for line in text.lines() {
        println!("| {line:?}");
    }
    println!("== tail bytes: {:?}", &buffer[buffer.len().saturating_sub(40)..]);
}
