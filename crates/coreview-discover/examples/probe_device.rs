//! Points the real SSH client at a real device and reports what it sees.
//!
//! Everything in this crate is otherwise tested against servers written to
//! behave like switches. This is the tool for the part that cannot be faked:
//! how an actual platform draws its prompt, whether it pages, whether it needs
//! enable, and whether the parsers understand its output.
//!
//! Credentials come from the environment so they never reach the source tree:
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... \
//!         cargo run -p coreview-discover --example probe_device

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::cdp::parse_cdp_detail;
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::interfaces::parse_ip_interface_brief;
use coreview_discover::lldp::parse_lldp_detail;
use coreview_discover::ssh::{Credentials, Device, Secret, SshOptions, SshProgress};

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let port: u16 = std::env::var("CV_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(22);

    let (tx, mut rx) = tokio::sync::mpsc::channel::<SshProgress>(32);
    tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            eprintln!("  [ssh] {p:?}");
        }
    });

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

    println!("connecting to {host}:{port}");
    let mut device = match Device::connect(&host, &credentials, options, Arc::clone(&store), Some(tx)).await {
        Ok(d) => d,
        Err(e) => {
            println!("FAILED: {e}");
            return;
        }
    };

    println!("prompt   : {:?}", device.prompt.text);
    println!("hostname : {}", device.hostname());
    println!("enabled  : {}", device.prompt.enabled);
    if !device.prompt.enabled {
        let ok = device.enable(credentials.enable_password.as_ref()).await.unwrap_or(false);
        println!("enable   : {ok} -> {:?}", device.prompt.text);
    }
    for (id, fp) in store.lock().unwrap().entries() {
        println!("host key : {id} {fp}");
    }

    for command in [
        "show version",
        "show ip interface brief",
        "show cdp neighbors detail",
        "show lldp neighbors detail",
    ] {
        println!("\n===== {command} =====");
        match device.run(command).await {
            Err(e) => println!("  ERROR: {e}"),
            Ok(out) => {
                println!("  {} bytes, {} lines", out.len(), out.lines().count());
                for line in out.lines().take(12) {
                    println!("  | {line}");
                }
                if out.lines().count() > 12 {
                    println!("  | ... ({} more lines)", out.lines().count() - 12);
                }
                match command {
                    "show cdp neighbors detail" => {
                        let n = parse_cdp_detail(&out);
                        println!("  -> parsed {} CDP neighbour(s)", n.len());
                        for x in &n {
                            println!(
                                "     {} [{:?}] {} via {} -> {}",
                                x.short_name,
                                x.class,
                                x.address().unwrap_or("no address"),
                                x.local_interface.as_deref().unwrap_or("?"),
                                x.remote_interface.as_deref().unwrap_or("?"),
                            );
                        }
                    }
                    "show lldp neighbors detail" => {
                        let n = parse_lldp_detail(&out);
                        println!("  -> parsed {} LLDP neighbour(s)", n.len());
                        for x in &n {
                            println!(
                                "     {} [{:?}] {} via {}",
                                x.short_name,
                                x.class,
                                x.address().unwrap_or("no address"),
                                x.local_interface.as_deref().unwrap_or("?"),
                            );
                        }
                    }
                    "show ip interface brief" => {
                        let i = parse_ip_interface_brief(&out);
                        println!("  -> parsed {} interface(s)", i.len());
                        for x in i.iter().filter(|x| x.address.is_some()) {
                            println!("     {} {} up={}", x.name, x.address.as_deref().unwrap(), x.up);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    device.close().await;
    println!("\ndone");
}
