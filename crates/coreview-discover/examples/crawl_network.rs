//! Runs a real crawl and a real backup against real equipment.
//!
//!     CV_HOST=10.1.1.1 CV_USER=admin CV_PASS=... CV_SUBNETS=10.1.0.0/16 \
//!     CV_BACKUP_DIR=/tmp/backups \
//!         cargo run -p coreview-discover --example crawl_network

use std::sync::Arc;
use std::time::Duration;

use coreview_discover::backup::BackupKind;
use coreview_discover::capture::{run_backups, BackupOptions, BackupTarget};
use coreview_discover::crawl::{crawl, CrawlEvent, CrawlOptions};
use coreview_discover::filter::DiscoveryFilter;
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::snmp::{AuthKind, PrivKind, SnmpAuth};
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use coreview_probe::sweep::parse_cidr;
use tokio_util::sync::CancellationToken;

/// SNMP credentials, if the environment supplies any.
fn snmp_from_env() -> Option<SnmpAuth> {
    if let Ok(username) = std::env::var("CV_V3_USER") {
        return Some(SnmpAuth::V3 {
            username,
            auth_protocol: AuthKind::parse(&std::env::var("CV_V3_AUTH").unwrap_or_default())?,
            auth_password: std::env::var("CV_V3_AUTH_PASS").ok()?,
            privacy: std::env::var("CV_V3_PRIV").ok().and_then(|p| PrivKind::parse(&p)),
            privacy_password: std::env::var("CV_V3_PRIV_PASS").unwrap_or_default(),
        });
    }
    std::env::var("CV_COMMUNITY").ok().map(|community| SnmpAuth::V2c { community })
}

#[tokio::main]
async fn main() {
    let seed = std::env::var("CV_HOST").expect("set CV_HOST");
    let user = std::env::var("CV_USER").expect("set CV_USER");
    let pass = std::env::var("CV_PASS").expect("set CV_PASS");
    let subnets: Vec<_> = std::env::var("CV_SUBNETS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| parse_cidr(s).expect("bad subnet"))
        .collect();

    let credentials = Credentials {
        username: user,
        password: Secret::new(pass),
        enable_password: std::env::var("CV_ENABLE").ok().map(Secret::new),
    };
    // A second login, for an estate that does not have just one.
    let fallbacks: Vec<Credentials> = match (std::env::var("CV_USER2"), std::env::var("CV_PASS2")) {
        (Ok(u), Ok(p)) if !u.is_empty() => vec![Credentials {
            username: u,
            password: Secret::new(p),
            enable_password: std::env::var("CV_ENABLE2").ok().map(Secret::new),
        }],
        _ => Vec::new(),
    };

    let ssh = SshOptions {
        port: 22,
        connect_timeout: Duration::from_secs(8),
        auth_timeout: Duration::from_secs(60),
        command_timeout: Duration::from_secs(45),
    };

    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, mut rx) = tokio::sync::mpsc::channel::<CrawlEvent>(512);
    tokio::spawn(async move {
        while let Some(e) = rx.recv().await {
            match e {
                CrawlEvent::Reached(d) => println!("  reached {} ({})", d.hostname, d.address),
                CrawlEvent::Failed(f) => println!("  failed  {} — {}", f.address, f.reason),
                CrawlEvent::Finished { reached, failed, .. } => {
                    println!("  done: {reached} reached, {failed} failed")
                }
                _ => {}
            }
        }
    });

    println!("crawling from {seed}");
    let result = crawl(
        &seed,
        credentials.clone(),
        CrawlOptions {
            filter: DiscoveryFilter { subnets, ..Default::default() },
            fallback_credentials: fallbacks,
            max_hops: 3,
            ssh: ssh.clone(),
            snmp: snmp_from_env(),
            ..Default::default()
        },
        Arc::clone(&store),
        tx,
        CancellationToken::new(),
    )
    .await;

    println!("\n--- reached ---");
    for d in &result.devices {
        println!(
            "  {:<22} {:<16} via {:<5} {:?} {}",
            d.hostname,
            d.address,
            format!("{:?}", d.reached_by),
            d.class,
            d.platform.as_deref().unwrap_or("").chars().take(46).collect::<String>()
        );
        for n in &d.neighbors {
            println!(
                "      via {:<22} {} [{:?}] {}",
                n.local_interface.as_deref().unwrap_or("?"),
                n.short_name,
                n.class,
                n.address().unwrap_or("")
            );
        }
    }
    println!("\n--- seen but not visited ---");
    for n in &result.not_visited {
        println!("  {:<22} [{:?}] {}", n.short_name, n.class, n.address().unwrap_or(""));
    }
    println!("\n--- failures ---");
    for f in &result.failures {
        println!("  {} — {}", f.address, f.reason);
    }

    if let Ok(dir) = std::env::var("CV_BACKUP_DIR") {
        println!("\n=== backing up to {dir} ===");
        let targets: Vec<BackupTarget> = result
            .devices
            .iter()
            .map(|d| BackupTarget { address: d.address.clone(), name: d.hostname.clone() })
            .collect();
        let (btx, mut brx) = tokio::sync::mpsc::channel(256);
        tokio::spawn(async move {
            while let Some(e) = brx.recv().await {
                if let coreview_discover::capture::BackupEvent::Saved(s) = e {
                    println!("  saved {} ({} bytes, unchanged={})", s.path, s.bytes, s.unchanged);
                } else if let coreview_discover::capture::BackupEvent::Failed(f) = e {
                    println!("  FAILED {} — {}", f.name, f.reason);
                }
            }
        });
        let run = run_backups(
            targets,
            credentials,
            BackupOptions {
                root: dir.into(),
                kinds: vec![BackupKind::Running],
                ssh,
                second_factor: false,
            },
            store,
            "20260828-live".into(),
            btx,
            CancellationToken::new(),
        )
        .await;
        println!("  {} saved, {} failed", run.saved.len(), run.failed.len());
    }
}
