//! Runs a list of candidate commands against a real device and reports which
//! ones it understood.
//!
//! Adding a platform starts with finding out what it answers to. Guessing from
//! documentation and then wiring it in produces a crawler that fails silently
//! on hardware nobody tested; this asks the device.
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... \
//!       CV_CMDS='get system status;get switch lldp neighbors-summary' \
//!         cargo run -p coreview-discover --example try_commands

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Device, Secret, SshOptions, SshProgress};

/// Wording platforms use to say they did not understand.
fn rejected(output: &str) -> bool {
    let l = output.to_ascii_lowercase();
    [
        "command parse error",
        "unknown action",
        "invalid input detected",
        "% invalid",
        "syntax error",
        "command fail",
        "unknown command",
        "permission denied",
    ]
    .iter()
    .any(|m| l.contains(m))
}

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);
    let commands: Vec<String> = std::env::var("CV_CMDS")
        .expect("set CV_CMDS, semicolon separated")
        .split(';')
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty())
        .collect();

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SshProgress>(32);
    tokio::spawn(async move { while rx.recv().await.is_some() {} });

    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let options = SshOptions {
        port,
        connect_timeout: Duration::from_secs(10),
        auth_timeout: Duration::from_secs(90),
        command_timeout: Duration::from_secs(45),
    };
    let credentials = Credentials {
        username: user,
        password: Secret::new(pass),
        enable_password: std::env::var("CV_ENABLE").ok().map(Secret::new),
    };

    let mut device = match Device::connect(&host, &credentials, options, Arc::clone(&store), Some(tx)).await {
        Ok(d) => d,
        Err(e) => {
            println!("FAILED to connect: {e}");
            return;
        }
    };
    println!("prompt: {:?}\n", device.prompt.text);

    for command in commands {
        match device.run(&command).await {
            Ok(out) => {
                let trimmed = out.trim();
                if rejected(trimmed) {
                    println!("--- {command}\n    NOT UNDERSTOOD: {}", trimmed.lines().next().unwrap_or(""));
                } else {
                    println!("--- {command}\n    {} bytes, {} lines", trimmed.len(), trimmed.lines().count());
                    for line in trimmed.lines().take(400) {
                        println!("    | {line}");
                    }
                    if trimmed.lines().count() > 400 {
                        println!("    | ... {} more", trimmed.lines().count() - 400);
                    }
                }
            }
            Err(e) => println!("--- {command}\n    ERROR: {e}"),
        }
        println!();
    }
}
