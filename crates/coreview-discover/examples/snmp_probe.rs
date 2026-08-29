//! Asks a real device to identify itself over SNMP.
//!
//!     CV_HOST=10.1.1.1 CV_COMMUNITY=public \
//!     CV_V3_USER=netops CV_V3_AUTH=sha CV_V3_AUTH_PASS=... \
//!     CV_V3_PRIV='aes 256' CV_V3_PRIV_PASS=... \
//!         cargo run -p coreview-discover --example snmp_probe

use std::time::Duration;

use coreview_discover::snmp::{classify_identity, identify, AuthKind, PrivKind, SnmpAuth};

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").expect("set CV_HOST");
    let timeout = Duration::from_secs(6);

    if let Ok(community) = std::env::var("CV_COMMUNITY") {
        println!("=== v2c ===");
        report(&host, &SnmpAuth::V2c { community }, timeout).await;
    }

    if let Ok(username) = std::env::var("CV_V3_USER") {
        println!("\n=== v3 ===");
        let auth = SnmpAuth::V3 {
            username,
            auth_protocol: AuthKind::parse(&std::env::var("CV_V3_AUTH").unwrap_or_else(|_| "sha".into()))
                .expect("bad CV_V3_AUTH"),
            auth_password: std::env::var("CV_V3_AUTH_PASS").expect("set CV_V3_AUTH_PASS"),
            privacy: std::env::var("CV_V3_PRIV").ok().map(|p| PrivKind::parse(&p).expect("bad CV_V3_PRIV")),
            privacy_password: std::env::var("CV_V3_PRIV_PASS").unwrap_or_default(),
        };
        report(&host, &auth, timeout).await;
    }
}

async fn report(host: &str, auth: &SnmpAuth, timeout: Duration) {
    match identify(host, 161, auth, timeout).await {
        Err(e) => println!("  FAILED: {e}"),
        Ok(id) => {
            println!("  name        : {:?}", id.name);
            println!("  description : {:?}", id.description.as_deref().map(|d| &d[..d.len().min(90)]));
            println!("  location    : {:?}", id.location);
            println!("  object id   : {:?}", id.object_id);
            println!("  uptime      : {:?} ticks", id.uptime_ticks);
            println!("  routes={} bridges={}", id.routes, id.bridges);
            println!("  classified  : {:?}", classify_identity(&id));
        }
    }
}
