//! Crawls a small fake network end to end.
//!
//! Two SSH servers stand in for two switches, on 127.0.0.1 and 127.0.0.2 — the
//! whole of 127.0.0.0/8 is loopback, so both can listen on the same port and
//! the crawler can reach them the way it would reach real devices, by address
//! alone.
//!
//! The topology is deliberately awkward:
//!
//! * SW1 advertises SW2, and SW2 advertises SW1 straight back. A crawler
//!   without a visited set loops between them forever.
//! * SW2 also advertises an access point, which must appear in the results and
//!   must not be logged into.
//! * SW2 advertises an Aruba switch over LLDP only, which a CDP-only crawl
//!   would never see.

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Auth, Msg, Session};
use russh::{Channel, ChannelId};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use coreview_discover::crawl::{crawl, CrawlEvent, CrawlOptions};
use coreview_discover::filter::DiscoveryFilter;
use coreview_discover::hostkeys::HostKeyStore;
use coreview_discover::ssh::{Credentials, Secret, SshOptions};
use coreview_discover::types::DeviceClass;
use coreview_probe::sweep::parse_cidr;

/// CDP as SW1 sees the world: one neighbour, SW2 at 127.0.0.2.
fn sw1_cdp() -> String {
    "-------------------------\r\n\
     Device ID: SW2.lab.example.com\r\n\
     Entry address(es):\r\n  IP address: 127.0.0.2\r\n\
     Platform: cisco WS-C2960X-24TS-L,  Capabilities: Switch IGMP\r\n\
     Interface: GigabitEthernet1/0/1,  Port ID (outgoing port): GigabitEthernet1/0/2\r\n\
     Holdtime : 137 sec\r\n\r\n\
     Total cdp entries displayed : 1\r\n"
        .into()
}

/// SW2 points back at SW1 — the loop — and adds an access point.
fn sw2_cdp() -> String {
    "-------------------------\r\n\
     Device ID: SW1.lab.example.com\r\n\
     Entry address(es):\r\n  IP address: 127.0.0.1\r\n\
     Platform: cisco WS-C3850-48P,  Capabilities: Router Switch\r\n\
     Interface: GigabitEthernet1/0/2,  Port ID (outgoing port): GigabitEthernet1/0/1\r\n\
     Holdtime : 140 sec\r\n\r\n\
     -------------------------\r\n\
     Device ID: AP-FLOOR2\r\n\
     Entry address(es):\r\n  IP address: 127.0.0.9\r\n\
     Platform: cisco AIR-CAP2702I-E-K9,  Capabilities: Trans-Bridge\r\n\
     Interface: GigabitEthernet1/0/7,  Port ID (outgoing port): GigabitEthernet0\r\n\
     Holdtime : 155 sec\r\n\r\n\
     Total cdp entries displayed : 2\r\n"
        .into()
}

/// An Aruba switch, visible over LLDP only.
fn sw2_lldp() -> String {
    "------------------------------------------------\r\n\
     Local Intf: Gi1/0/12\r\n\
     Chassis id: 001a.2b3c.4d5e\r\n\
     Port id: 001a.2b3c.4d60\r\n\
     Port Description: 1/1/1\r\n\
     System Name: ARUBA-EDGE-1\r\n\r\n\
     System Description:\r\n\
     ArubaOS-CX GL_10.09.1010, Aruba 6300M\r\n\r\n\
     Time remaining: 97 seconds\r\n\
     Enabled Capabilities: B,R\r\n\
     Management Addresses:\r\n    IP: 10.20.30.40\r\n\r\n\
     Total entries displayed: 1\r\n"
        .into()
}

#[derive(Clone)]
struct FakeSwitch {
    hostname: String,
    cdp: String,
    lldp: String,
    loopback: String,
    /// `show ip arp`, for resolving a neighbour that advertises no address.
    arp: String,
}

impl server::Handler for FakeSwitch {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, password: &str) -> Result<Auth, Self::Error> {
        if password == "correct-horse" {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
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

        let body: String = match command {
            "terminal length 0" | "enable" => String::new(),
            "show cdp neighbors detail" => self.cdp.clone(),
            "show lldp neighbors detail" => self.lldp.clone(),
            "show ip arp" => self.arp.clone(),
            "show ip interface brief" => format!(
                "Interface              IP-Address      OK? Method Status                Protocol\r\n\
                 GigabitEthernet1/0/1   {}        YES NVRAM  up                    up\r\n\
                 Loopback0              {}       YES NVRAM  up                    up\r\n",
                self.hostname_address(),
                self.loopback
            ),
            "show version" => format!(
                "Cisco IOS Software, C2960X Software, Version 15.2(4)E7\r\n\
                 cisco WS-C2960X-24TS-L (APM86XXX) processor\r\n\
                 Model number            : WS-C2960X-24TS-L\r\n\
                 {} uptime is 3 weeks\r\n",
                self.hostname
            ),
            _ => "% Invalid input detected at '^' marker.\r\n".into(),
        };

        session.data(
            channel,
            format!("{command}\r\n{body}{}#", self.hostname).into_bytes(),
        )?;
        Ok(())
    }
}

impl FakeSwitch {
    fn hostname_address(&self) -> &str {
        if self.hostname == "SW1" {
            "127.0.0.1"
        } else {
            "127.0.0.2"
        }
    }
}

/// Starts a switch on `bind_ip:port`.
async fn start(bind_ip: &str, port: u16, switch: FakeSwitch) {
    let key = russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
        .expect("host key");
    let config = Arc::new(server::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        auth_rejection_time: Duration::from_millis(1),
        keys: vec![key],
        ..Default::default()
    });
    let listener = tokio::net::TcpListener::bind((bind_ip, port)).await.unwrap();
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let config = Arc::clone(&config);
            let switch = switch.clone();
            tokio::spawn(async move {
                let _ = server::run_stream(config, stream, switch).await;
            });
        }
    });
}

/// A port free on both loopback addresses.
async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    drop(l);
    port
}

async fn start_network() -> u16 {
    let port = free_port().await;
    start(
        "127.0.0.1",
        port,
        FakeSwitch {
            hostname: "SW1".into(),
            cdp: sw1_cdp(),
            lldp: sw1_lldp(),
            loopback: "10.255.0.1".into(),
            // SW1 has seen the silent switch and knows its address.
            arp: "Protocol  Address          Age (min)  Hardware Addr   Type   Interface\r\n                  Internet  127.0.0.4               0   e81c.bac4.964b  ARPA   Vlan1\r\n"
                .into(),
        },
    )
    .await;
    start(
        "127.0.0.2",
        port,
        FakeSwitch {
            hostname: "SW2".into(),
            cdp: sw2_cdp(),
            lldp: sw2_lldp(),
            loopback: "10.255.0.2".into(),
            arp: String::new(),
        },
    )
    .await;
    // The switch SW1 can see but that advertises no address of its own. It is
    // reachable — the point is that its address has to be worked out from the
    // chassis id and SW1's ARP table before anything can reach it.
    start(
        "127.0.0.4",
        port,
        FakeSwitch {
            hostname: "SILENT-SW".into(),
            cdp: String::new(),
            lldp: String::new(),
            loopback: "10.255.0.4".into(),
            arp: String::new(),
        },
    )
    .await;
    port
}

/// A switch that advertises a chassis id and no management address, which is
/// what a FortiSwitch does and what left one undrawable on the real network.
fn sw1_lldp() -> String {
    "------------------------------------------------\r\n     Local Intf: Gi0/9\r\n     Chassis id: e81c.bac4.964b\r\n     Port id: port24\r\n     System Name: SILENT-SW\r\n\r\n     System Description:\r\n     FortiSwitch-224E v7.6.1\r\n\r\n     Time remaining: 96 seconds\r\n     System Capabilities: B,R\r\n     Enabled Capabilities: B\r\n\r\n     Total entries displayed: 1\r\n"
        .into()
}

fn creds() -> Credentials {
    Credentials {
        username: "admin".into(),
        password: Secret::new("correct-horse"),
        enable_password: None,
    }
}

fn options(port: u16) -> CrawlOptions {
    CrawlOptions {
        filter: DiscoveryFilter {
            // 127.0.0.0/8 keeps the crawl on the fake network; the Aruba's
            // 10.20.30.40 is outside it and must not be dialled.
            subnets: vec![parse_cidr("127.0.0.0/8").unwrap()],
            ..Default::default()
        },
        ssh: SshOptions {
            port,
            connect_timeout: Duration::from_secs(5),
            auth_timeout: Duration::from_secs(10),
            command_timeout: Duration::from_secs(10),
        },
        ..Default::default()
    }
}

#[tokio::test]
async fn crawls_two_switches_without_looping_between_them() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, mut rx) = mpsc::channel(256);

    let result = crawl(
        "127.0.0.1",
        creds(),
        options(port),
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    let names: Vec<&str> = result.devices.iter().map(|d| d.hostname.as_str()).collect();
    assert_eq!(
        names,
        vec!["SW1", "SW2", "SILENT-SW"],
        "both switches plus the one whose address came from ARP, each once"
    );
    assert!(result.failures.is_empty(), "unexpected failures: {:?}", result.failures);
    assert!(!result.cancelled);

    // SW2 advertises SW1 back. Without a visited set this never terminates,
    // and the fact that it did is the assertion.
    let reached = rx
        .try_recv()
        .into_iter()
        .chain(std::iter::from_fn(|| rx.try_recv().ok()))
        .filter(|e| matches!(e, CrawlEvent::Reached(_)))
        .count();
    assert_eq!(reached, 3, "one Reached event per device, no repeats");
}

/// One estate, more than one login.
///
/// Sites migrate between TACACS realms and appliances keep their own local
/// account. On the network this was built against, the Cisco and the
/// FortiSwitch take different passwords, so a crawl with one credential set
/// reached one of them and never both.
#[tokio::test]
async fn a_rejected_password_falls_back_to_the_next_credential() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let wrong = Credentials {
        username: "netops".into(),
        password: Secret::new("not-the-password"),
        enable_password: None,
    };
    let mut opts = options(port);
    opts.fallback_credentials = vec![creds()];

    let result = crawl("127.0.0.1", wrong, opts, store, tx, CancellationToken::new()).await;

    let names: Vec<&str> = result.devices.iter().map(|d| d.hostname.as_str()).collect();
    assert_eq!(
        names,
        vec!["SW1", "SW2", "SILENT-SW"],
        "the second credential should get in"
    );
    assert!(result.failures.is_empty(), "{:?}", result.failures);
}

/// The fallback is for a rejected password and nothing else.
#[tokio::test]
async fn every_credential_being_wrong_still_reports_one_failure() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let wrong = |p: &str| Credentials {
        username: "netops".into(),
        password: Secret::new(p),
        enable_password: None,
    };
    let mut opts = options(port);
    opts.fallback_credentials = vec![wrong("also-wrong")];

    let result = crawl("127.0.0.1", wrong("wrong"), opts, store, tx, CancellationToken::new()).await;

    assert!(result.devices.is_empty());
    assert_eq!(result.failures.len(), 1, "one device, one failure: {:?}", result.failures);
    assert!(
        result.failures[0].reason.contains("rejected"),
        "the last rejection is what to report: {:?}",
        result.failures[0]
    );
}

/// LLDP does not require a management address, and plenty of devices do not
/// advertise one. Without resolving it there is nowhere to connect, and no
/// credential can help — a FortiSwitch sat undrawable on the real network for
/// exactly this reason.
#[tokio::test]
async fn a_neighbour_that_advertises_no_address_is_resolved_from_arp() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let silent = result
        .devices
        .iter()
        .find(|d| d.hostname == "SILENT-SW")
        .expect("the switch with no advertised address should have been reached");
    // Its chassis id is e81c.bac4.964b and SW1's ARP table maps that to
    // 127.0.0.4. Nothing else in the crawl knows that address.
    assert_eq!(silent.address, "127.0.0.4");

    // And it is one device, not two: the same switch must not appear once as
    // an addressless neighbour and again as a reached device.
    assert_eq!(
        result.devices.iter().filter(|d| d.hostname == "SILENT-SW").count(),
        1
    );
}

#[tokio::test]
async fn an_access_point_is_recorded_but_never_logged_into() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    // Nothing tried to log into it — there is no SSH server on 127.0.0.9, so a
    // crawl that tried would have recorded a failure.
    assert!(
        !result.failures.iter().any(|f| f.address == "127.0.0.9"),
        "the crawler dialled an access point: {:?}",
        result.failures
    );
    assert!(!result.devices.iter().any(|d| d.hostname.contains("AP")));

    // But it is still in the results, because it belongs on a diagram.
    let ap = result
        .not_visited
        .iter()
        .find(|n| n.short_name == "AP-FLOOR2")
        .expect("the access point should be reported, just not crawled");
    assert_eq!(ap.class, DeviceClass::AccessPoint);
}

#[tokio::test]
async fn a_switch_only_lldp_can_see_is_found() {
    // The Aruba. A CDP-only crawl misses it silently.
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let aruba = result
        .not_visited
        .iter()
        .find(|n| n.short_name == "ARUBA-EDGE-1")
        .expect("LLDP-only neighbour missing from the results");
    assert_eq!(aruba.class, DeviceClass::Switch);
    assert_eq!(aruba.addresses[0].ip, "10.20.30.40");

    // It is a switch, so it would normally be crawled — but its address is
    // outside the subnet filter, which is what keeps a crawl inside an estate.
    assert!(
        !result.failures.iter().any(|f| f.address == "10.20.30.40"),
        "the crawler left the subnet filter: {:?}",
        result.failures
    );
}

#[tokio::test]
async fn the_probe_target_is_the_loopback_not_the_address_dialled() {
    // The point of running `show ip interface brief` during a crawl.
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;

    let sw1 = result.devices.iter().find(|d| d.hostname == "SW1").unwrap();
    assert_eq!(sw1.address, "127.0.0.1", "reached on the seed address");
    assert_eq!(
        sw1.probe_target, "10.255.0.1",
        "a probe should aim at the loopback, which stays up when a port does not"
    );
    assert_eq!(sw1.class, DeviceClass::Switch);
    assert_eq!(sw1.platform.as_deref(), Some("WS-C2960X-24TS-L"));
}

#[tokio::test]
async fn a_hop_limit_stops_the_crawl_going_further() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl(
        "127.0.0.1",
        creds(),
        CrawlOptions {
            max_hops: 0,
            ..options(port)
        },
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert_eq!(result.devices.len(), 1, "only the seed should be visited");
    assert_eq!(result.devices[0].hostname, "SW1");
    // Its neighbours are still reported — they were seen, just not followed.
    assert!(result.not_visited.iter().any(|n| n.short_name == "SW2"));
}

#[tokio::test]
async fn one_unreachable_device_does_not_end_the_crawl() {
    // The failure mode the Python original had: an exception deep in the
    // recursion takes the whole survey with it.
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    // Seed with a dead address first; the crawl should report it and stop
    // there, having nothing else queued — then prove the same run style works
    // from a live seed.
    let dead = crawl(
        "127.0.0.3",
        creds(),
        options(port),
        Arc::clone(&store),
        tx.clone(),
        CancellationToken::new(),
    )
    .await;
    assert_eq!(dead.devices.len(), 0);
    assert_eq!(dead.failures.len(), 1, "the failure should be recorded, not thrown");
    assert!(dead.failures[0].reason.contains("127.0.0.3"), "got: {:?}", dead.failures[0]);

    let live = crawl("127.0.0.1", creds(), options(port), store, tx, CancellationToken::new()).await;
    assert_eq!(live.devices.len(), 3, "a later crawl is unaffected");
}

#[tokio::test]
async fn wrong_credentials_fail_every_device_rather_than_hanging() {
    let port = start_network().await;
    let store = Arc::new(std::sync::Mutex::new(HostKeyStore::new()));
    let (tx, _rx) = mpsc::channel(256);

    let result = crawl(
        "127.0.0.1",
        Credentials {
            username: "admin".into(),
            password: Secret::new("wrong"),
            enable_password: None,
        },
        options(port),
        store,
        tx,
        CancellationToken::new(),
    )
    .await;

    assert!(result.devices.is_empty());
    assert_eq!(result.failures.len(), 1);
    let reason = &result.failures[0].reason;
    assert!(!reason.contains("wrong"), "the password leaked into a failure: {reason}");
}
