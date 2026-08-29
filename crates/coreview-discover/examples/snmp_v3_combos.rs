//! Finds which v3 auth/privacy pair a device accepts.
//!
//! Not credential guessing — the username and passwords are fixed and known.
//! It is algorithm discovery: SNMPv3 gives no way to ask a device what it
//! expects, and getting it wrong reports "not authenticated", which is
//! indistinguishable from a wrong password.
use std::time::Duration;
use coreview_discover::snmp::{identify, AuthKind, PrivKind, SnmpAuth};

#[tokio::main]
async fn main() {
    let host = std::env::var("CV_HOST").unwrap();
    let user = std::env::var("CV_V3_USER").unwrap();
    let pass = std::env::var("CV_V3_AUTH_PASS").unwrap();
    let priv_pass = std::env::var("CV_V3_PRIV_PASS").unwrap_or_else(|_| pass.clone());

    let auths = [AuthKind::Sha1, AuthKind::Md5, AuthKind::Sha256];
    let privs = [None, Some(PrivKind::Aes128), Some(PrivKind::Des), Some(PrivKind::Aes256)];

    for a in auths {
        for p in privs {
            let auth = SnmpAuth::V3 {
                username: user.clone(),
                auth_protocol: a,
                auth_password: pass.clone(),
                privacy: p,
                privacy_password: priv_pass.clone(),
            };
            let label = format!("{a:?} + {}", p.map(|x| format!("{x:?}")).unwrap_or("none".into()));
            match identify(&host, 161, &auth, Duration::from_secs(4)).await {
                Ok(id) => println!("  WORKS  {label:<22} -> {:?}", id.name),
                Err(e) => {
                    let msg = e.to_string();
                    let short = msg.split(':').next_back().unwrap_or("").trim();
                    println!("  no     {label:<22} {short}");
                }
            }
        }
    }
}
