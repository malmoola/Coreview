//! Walking a network from one seed address.
//!
//! Log in, ask what the device can see, decide which of those are worth
//! visiting, repeat. The shape is the same as the Python crawler this replaces,
//! with three differences that matter on a real estate:
//!
//! * It does not recurse. A recursive crawl of a large network is a stack of
//!   open SSH sessions, and a failure deep in it takes the whole run with it.
//!   This is a queue.
//! * A device that fails is recorded and the crawl continues. One unreachable
//!   switch must not end a survey of two hundred.
//! * Devices are identified by name, not address. The same switch is reached
//!   at one address and advertised at another, and an address-keyed visited set
//!   crawls it twice and draws it twice.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::cdp::parse_cdp_detail;
use crate::filter::DiscoveryFilter;
use crate::hostkeys::HostKeyStore;
use crate::interfaces::{addresses_from, parse_ip_interface_brief};
use crate::lldp::parse_lldp_detail;
use crate::snmp::{classify_identity, identify, SnmpAuth};
use crate::ssh::{Credentials, Device, SshError, SshOptions, SshProgress};
use crate::types::{AddressPreference, DeviceAddress, DeviceClass, Neighbor};

#[derive(Clone, Debug)]
pub struct CrawlOptions {
    /// Which devices the crawl may log into. Only `should_crawl` is consulted:
    /// the presentation half of the filter belongs to the UI, after the crawl
    /// has collected everything it can see.
    pub filter: DiscoveryFilter,
    /// How many hops from the seed. A guard against a crawl that walks out of
    /// the estate through a link nobody remembered.
    pub max_hops: usize,
    /// Ceiling on devices visited, whatever the topology says.
    pub max_devices: usize,
    /// How many devices to work on at once. Forced to 1 when a second factor
    /// is in play — nobody can approve sixty-four Duo pushes at the same time.
    pub concurrency: usize,
    /// The estate uses Duo or another push factor. Setting this up front avoids
    /// the first few devices racing before it is detected.
    pub second_factor: bool,
    /// Which of a device's addresses a probe should target afterwards.
    pub address_preference: AddressPreference,
    pub ssh: SshOptions,
    /// When set, a device that refuses SSH is still identified over SNMP.
    ///
    /// Worth having because the two are not interchangeable and not equally
    /// available: a read-only community is far easier to get approved than
    /// shell access, and on the network this was built against a neighbouring
    /// switch rejected SSH credentials while answering SNMP quite happily.
    /// Without this it would appear as an unreachable address and nothing else.
    pub snmp: Option<SnmpAuth>,
    pub snmp_timeout: Duration,
}

impl Default for CrawlOptions {
    fn default() -> Self {
        Self {
            filter: DiscoveryFilter::default(),
            max_hops: 8,
            max_devices: 500,
            concurrency: 4,
            second_factor: false,
            address_preference: AddressPreference::default(),
            ssh: SshOptions::default(),
            snmp: None,
            snmp_timeout: Duration::from_secs(5),
        }
    }
}

/// How much a device was willing to tell us.
///
/// Kept on the record because the difference matters: an SSH device reported
/// its own neighbours and its interface table, while an SNMP one only said what
/// it is. Presenting them identically would imply the map is more complete than
/// it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ReachedBy {
    Ssh,
    Snmp,
}

/// A device the crawl identified.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawledDevice {
    /// The device's own name, from its prompt. The identity everything else
    /// keys on.
    pub hostname: String,
    /// The address it was actually reached on.
    pub address: String,
    /// Every address it reports, with interface names where known.
    pub addresses: Vec<DeviceAddress>,
    /// The address a probe should aim at, under the chosen preference.
    pub probe_target: String,
    pub class: DeviceClass,
    pub platform: Option<String>,
    pub version: Option<String>,
    pub neighbors: Vec<Neighbor>,
    pub hops: usize,
    pub reached_by: ReachedBy,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrawlFailure {
    pub address: String,
    pub reason: String,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CrawlEvent {
    Started {
        seed: String,
    },
    /// Mirrors SshProgress so the UI has one stream to watch, including the
    /// "approve the push on your phone" message.
    Ssh(SshProgress),
    Reached(Box<CrawledDevice>),
    /// Seen as a neighbour but not visited: filtered out, no address, or a
    /// class the crawl does not walk into.
    Skipped {
        name: String,
        reason: String,
    },
    Failed(CrawlFailure),
    Finished {
        reached: usize,
        failed: usize,
        cancelled: bool,
    },
}

/// What a crawl found.
#[derive(Debug, Default)]
pub struct CrawlResult {
    pub devices: Vec<CrawledDevice>,
    pub failures: Vec<CrawlFailure>,
    /// Neighbours seen but never visited — access points, phones, anything
    /// outside the subnet filter. Still worth drawing.
    pub not_visited: Vec<Neighbor>,
    pub cancelled: bool,
}

/// Everything one device contributes, so the visiting step is independent of
/// the scheduling step and can be tested on its own.
struct Visit {
    device: CrawledDevice,
    neighbors: Vec<Neighbor>,
}

/// Crawls from a seed address.
///
/// Never returns an error: a crawl that dies because one device misbehaved is
/// worse than one that reports what it managed. Failures are in the result.
pub async fn crawl(
    seed: &str,
    credentials: Credentials,
    options: CrawlOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    events: mpsc::Sender<CrawlEvent>,
    cancel: CancellationToken,
) -> CrawlResult {
    let _ = events
        .send(CrawlEvent::Started {
            seed: seed.to_string(),
        })
        .await;

    let mut result = CrawlResult::default();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    queue.push_back((seed.to_string(), 0));

    // Two visited sets, because a device has two kinds of identity and both
    // cause duplicate work if ignored. Addresses stop us dialling the same
    // endpoint twice; names stop us crawling one device twice because it was
    // advertised under two addresses.
    let mut tried_addresses: HashSet<String> = HashSet::new();
    let mut seen_hostnames: HashSet<String> = HashSet::new();
    let mut pending_neighbors: HashMap<String, Neighbor> = HashMap::new();

    // Serialising authentication is the whole answer to "pause for Duo before
    // moving to the next device". Only the login is serialised, because that
    // is where the push happens.
    let auth_gate = Arc::new(Mutex::new(()));
    let serialise = Arc::new(std::sync::atomic::AtomicBool::new(options.second_factor));

    while let Some((address, hops)) = queue.pop_front() {
        if cancel.is_cancelled() {
            result.cancelled = true;
            break;
        }
        if result.devices.len() >= options.max_devices {
            let _ = events
                .send(CrawlEvent::Skipped {
                    name: address.clone(),
                    reason: format!("stopped at the {} device limit", options.max_devices),
                })
                .await;
            break;
        }
        if !tried_addresses.insert(address.clone()) {
            continue;
        }

        // Boxed deliberately. Every awaited call inside `visit` — the SSH
        // handshake, the command reads, the SNMP fallback — is inlined into
        // this function's state machine, and the whole thing grew past the
        // stack a thread is given. The symptom was a stack overflow in a test
        // that had nothing to do with the code that caused it, so the boxing
        // is load-bearing rather than stylistic.
        let visited = Box::pin(visit(
            &address,
            hops,
            &credentials,
            &options,
            Arc::clone(&store),
            &events,
            Arc::clone(&auth_gate),
            Arc::clone(&serialise),
        ))
        .await;

        match visited {
            Err(e) => {
                // SSH refused. Before writing the device off, ask whether it
                // will identify itself over SNMP — a device that answers is
                // worth drawing, even without its neighbours.
                // What a neighbour already told us about this address. SNMP
                // often cannot work out a device's role — a UniFi switch
                // reports sysServices 0 and a description of "Linux UBNT" —
                // while the switch that advertised it said plainly that it is
                // a bridge. Throwing that away would make a device change kind
                // depending on which protocol reached it.
                let known = pending_neighbors
                    .values()
                    .find(|n| n.addresses.iter().any(|a| a.ip == address))
                    .cloned();

                if let Some(device) =
                    Box::pin(identify_over_snmp(&address, hops, &options, known.as_ref())).await
                {
                    if seen_hostnames.insert(device.hostname.clone()) {
                        let _ = events
                            .send(CrawlEvent::Reached(Box::new(device.clone())))
                            .await;
                        result.devices.push(device);
                        continue;
                    }
                }
                let failure = CrawlFailure {
                    address: address.clone(),
                    reason: e.to_string(),
                };
                let _ = events.send(CrawlEvent::Failed(failure.clone())).await;
                result.failures.push(failure);
                continue;
            }
            Ok(visit) => {
                // The same device reached by a second address: record nothing
                // new, and above all do not crawl its neighbours again.
                if !seen_hostnames.insert(visit.device.hostname.clone()) {
                    continue;
                }

                for address in &visit.device.addresses {
                    tried_addresses.insert(address.ip.clone());
                }

                for neighbor in &visit.neighbors {
                    pending_neighbors
                        .entry(neighbor.short_name.clone())
                        .or_insert_with(|| neighbor.clone());

                    if hops + 1 > options.max_hops {
                        continue;
                    }
                    if !options.filter.should_crawl(neighbor) {
                        continue;
                    }
                    if seen_hostnames.contains(&neighbor.short_name) {
                        continue;
                    }
                    if let Some(next) = neighbor.probe_target(&options.address_preference) {
                        if !tried_addresses.contains(next) {
                            queue.push_back((next.to_string(), hops + 1));
                        }
                    }
                }

                let _ = events
                    .send(CrawlEvent::Reached(Box::new(visit.device.clone())))
                    .await;
                result.devices.push(visit.device);
            }
        }
    }

    // Everything seen but not logged into, deliberately unfiltered.
    //
    // The filter's presentation half is *not* applied here. Discovery collects
    // and the user filters afterwards — that is the whole point of doing it in
    // two steps. Applying it now would silently drop the most interesting
    // findings: a switch just outside the subnet limit is a link leaving the
    // estate, which is something you want to see precisely because the crawl
    // would not dial it.
    result.not_visited = pending_neighbors
        .into_values()
        .filter(|n| !seen_hostnames.contains(&n.short_name))
        .collect();
    result.not_visited.sort_by(|a, b| a.short_name.cmp(&b.short_name));

    let _ = events
        .send(CrawlEvent::Finished {
            reached: result.devices.len(),
            failed: result.failures.len(),
            cancelled: result.cancelled,
        })
        .await;
    result
}

/// Asks a device to identify itself over SNMP, when SSH would not have it.
///
/// Returns `None` when SNMP is not configured or the device does not answer,
/// so the caller falls through to recording the original SSH failure — which
/// is the more useful error of the two.
async fn identify_over_snmp(
    address: &str,
    hops: usize,
    options: &CrawlOptions,
    known: Option<&Neighbor>,
) -> Option<CrawledDevice> {
    let auth = options.snmp.as_ref()?;
    let identity = identify(address, 161, auth, options.snmp_timeout).await.ok()?;

    // The device's own name first, then whatever the neighbour called it.
    let hostname = identity
        .name
        .clone()
        .map(|n| crate::cdp::short_name(&n))
        .filter(|n| !n.is_empty())
        .or_else(|| known.map(|n| n.short_name.clone()))
        .filter(|n| !n.is_empty())?;

    // SNMP's view of what a device *is* is often weaker than a neighbour's:
    // sysServices is frequently 0 on equipment that plainly bridges. Prefer
    // whichever of the two actually knows something.
    let class = match classify_identity(&identity) {
        DeviceClass::Unknown => known.map(|n| n.class).unwrap_or(DeviceClass::Unknown),
        decided => decided,
    };

    Some(CrawledDevice {
        hostname,
        address: address.to_string(),
        addresses: vec![DeviceAddress {
            ip: address.to_string(),
            interface: None,
            is_management: true,
        }],
        probe_target: address.to_string(),
        class,
        platform: identity.description.clone(),
        version: identity.description,
        // SNMP told us what this is, not what it is connected to. Leaving this
        // empty is the honest answer.
        neighbors: Vec::new(),
        hops,
        reached_by: ReachedBy::Snmp,
    })
}

/// Logs into one device and asks it everything worth asking.
#[allow(clippy::too_many_arguments)]
async fn visit(
    address: &str,
    hops: usize,
    credentials: &Credentials,
    options: &CrawlOptions,
    store: Arc<std::sync::Mutex<HostKeyStore>>,
    events: &mpsc::Sender<CrawlEvent>,
    auth_gate: Arc<Mutex<()>>,
    serialise: Arc<std::sync::atomic::AtomicBool>,
) -> Result<Visit, SshError> {
    let (tx, mut rx) = mpsc::channel::<SshProgress>(32);
    let forward = events.clone();
    let flag = Arc::clone(&serialise);
    let pump = tokio::spawn(async move {
        while let Some(p) = rx.recv().await {
            // A push seen once means every later login must wait its turn,
            // even if the run started assuming otherwise.
            if matches!(p, SshProgress::AwaitingSecondFactor { .. }) {
                flag.store(true, std::sync::atomic::Ordering::Relaxed);
            }
            let _ = forward.send(CrawlEvent::Ssh(p)).await;
        }
    });

    let mut device = {
        // Held only across the login. Commands afterwards can overlap freely;
        // it is the push that cannot.
        let _lock = if serialise.load(std::sync::atomic::Ordering::Relaxed) {
            Some(auth_gate.lock().await)
        } else {
            None
        };
        Device::connect(
            address,
            credentials,
            options.ssh.clone(),
            store,
            Some(tx),
        )
        .await?
    };

    // Escalate before asking for anything privileged. From user mode the
    // neighbour commands often work but the configuration does not, and it is
    // better to find out now than at backup time.
    let _ = device.enable(credentials.enable_password.as_ref()).await;

    let hostname = device.hostname().to_string();

    // Both protocols, always. CDP misses everything that is not Cisco, and
    // LLDP is off by default on plenty of Cisco kit — asking only one leaves a
    // silent hole in the map.
    let cdp = device.run("show cdp neighbors detail").await.unwrap_or_default();
    let lldp = device.run("show lldp neighbors detail").await.unwrap_or_default();
    let brief = device.run("show ip interface brief").await.unwrap_or_default();
    let version = device.run("show version").await.unwrap_or_default();

    device.close().await;
    drop(pump);

    let interfaces = parse_ip_interface_brief(&brief);
    let mut addresses = addresses_from(&interfaces, address);
    if addresses.is_empty() {
        // A platform whose interface table this parser does not understand.
        // The address that worked is still a fact worth keeping.
        addresses.push(DeviceAddress {
            ip: address.to_string(),
            interface: None,
            is_management: true,
        });
    }

    let neighbors = merge_neighbors(parse_cdp_detail(&cdp), parse_lldp_detail(&lldp));
    let probe_target = options
        .address_preference
        .choose(&addresses)
        .map(|a| a.ip.clone())
        .unwrap_or_else(|| address.to_string());

    let platform = platform_from_version(&version);
    let class = crate::classify::classify(platform.as_deref(), &[], first_line(&version));

    Ok(Visit {
        device: CrawledDevice {
            hostname,
            address: address.to_string(),
            addresses,
            probe_target,
            class,
            platform,
            version: first_line(&version).map(str::to_string),
            neighbors: neighbors.clone(),
            hops,
            reached_by: ReachedBy::Ssh,
        },
        neighbors,
    })
}

/// Combines what the two protocols saw of the same link.
///
/// A device running both advertises the same neighbour twice. Keying on the
/// neighbour name and the local port keeps one entry per adjacency; CDP is
/// preferred where they disagree because it carries a platform string and LLDP
/// does not, but an LLDP-only neighbour is kept — that is the whole reason for
/// asking both.
pub fn merge_neighbors(cdp: Vec<Neighbor>, lldp: Vec<Neighbor>) -> Vec<Neighbor> {
    let same = |a: &Neighbor, b: &Neighbor| {
        a.short_name.eq_ignore_ascii_case(&b.short_name)
            && same_interface(
                a.local_interface.as_deref().unwrap_or(""),
                b.local_interface.as_deref().unwrap_or(""),
            )
    };

    let mut merged: Vec<Neighbor> = Vec::new();

    for n in cdp {
        merged.push(n);
    }
    for mut n in lldp {
        if let Some(existing) = merged.iter_mut().find(|e| same(e, &n)) {
            // Fill gaps CDP left rather than discarding the LLDP view entirely.
            if existing.addresses.is_empty() && !n.addresses.is_empty() {
                existing.addresses = std::mem::take(&mut n.addresses);
            }
            if existing.remote_interface.is_none() {
                existing.remote_interface = n.remote_interface.take();
            }
            continue;
        }
        merged.push(n);
    }
    merged
}

/// Whether two interface names refer to the same port.
///
/// CDP prints `GigabitEthernet0/8` and LLDP prints `Gi0/8` for the same port on
/// the same switch. Comparing the strings directly means one adjacency becomes
/// two, and every device running both protocols gets a duplicate edge — which
/// is exactly what a real switch produced the first time this was pointed at
/// one.
///
/// The rule: split each name into its alphabetic prefix and its numeric tail.
/// The tails must match exactly; the shorter prefix must be a prefix of the
/// longer. That makes `Gi` match `GigabitEthernet`, `Te` match
/// `TenGigabitEthernet` and `Po` match `Port-channel`, without inventing a
/// table of abbreviations that would go stale.
pub fn same_interface(a: &str, b: &str) -> bool {
    let split = |s: &str| {
        let s = s.trim().to_ascii_lowercase();
        let head: String = s.chars().take_while(|c| c.is_ascii_alphabetic() || *c == '-').filter(|c| *c != '-').collect();
        let tail: String = s.chars().skip_while(|c| c.is_ascii_alphabetic() || *c == '-').collect();
        (head, tail)
    };
    let (ha, ta) = split(a);
    let (hb, tb) = split(b);
    if ta != tb {
        return false;
    }
    if ha.is_empty() || hb.is_empty() {
        // No alphabetic part at all — compare what is left, so a bare port
        // number is not treated as matching everything.
        return ha == hb && !ta.is_empty();
    }
    ha.starts_with(&hb) || hb.starts_with(&ha)
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|l| !l.is_empty())
}

/// Pulls a model out of a `show version` banner, for classification.
fn platform_from_version(version: &str) -> Option<String> {
    // A `show version` on a Catalyst runs to sixty lines and puts "Model
    // number" near the bottom, past where a short scan would look.
    for line in version.lines().take(80) {
        let t = line.trim();
        // "Model number            : WS-C2960X-24TS-L"
        if let Some((label, value)) = t.split_once(':') {
            let l = label.trim().to_ascii_lowercase();
            if l.contains("model number") || l.contains("model") && l.contains("hardware") {
                let v = value.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
        // "cisco WS-C2960X-24TS-L (PowerPC405) processor" — and the same line
        // is capitalised on some trains.
        let lower = t.to_ascii_lowercase();
        if let Some(offset) = lower.strip_prefix("cisco ").map(|_| "cisco ".len()) {
            let rest = &t[offset..];
            if let Some(model) = rest.split_whitespace().next() {
                if model.len() > 3 {
                    return Some(model.to_string());
                }
            }
        }
    }
    // NX-OS puts the family in the banner rather than a model line.
    first_line(version).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DeviceAddress, Protocol};

    fn neighbor(name: &str, local: &str, protocol: Protocol) -> Neighbor {
        Neighbor {
            device_id: name.into(),
            short_name: name.into(),
            addresses: vec![],
            local_interface: Some(local.into()),
            remote_interface: Some("Gi0/1".into()),
            platform: None,
            capabilities: vec![],
            version: None,
            class: DeviceClass::Switch,
            discovered_by: protocol,
        }
    }

    #[test]
    fn one_adjacency_seen_by_both_protocols_is_one_neighbour() {
        // A device running CDP and LLDP advertises the same link twice, and
        // drawing it twice puts two edges between the same pair of nodes.
        let cdp = vec![neighbor("SW2", "Gi1/0/1", Protocol::Cdp)];
        let lldp = vec![neighbor("SW2", "Gi1/0/1", Protocol::Lldp)];
        let merged = merge_neighbors(cdp, lldp);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].discovered_by, Protocol::Cdp, "CDP carries a platform string");
    }

    #[test]
    fn an_lldp_only_neighbour_survives_the_merge() {
        // The entire reason for asking both: this is the Aruba switch CDP
        // cannot see.
        let cdp = vec![neighbor("SW2", "Gi1/0/1", Protocol::Cdp)];
        let lldp = vec![neighbor("ARUBA-1", "Gi1/0/9", Protocol::Lldp)];
        let merged = merge_neighbors(cdp, lldp);
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|n| n.short_name == "ARUBA-1"));
    }

    #[test]
    fn the_same_name_on_a_different_port_is_a_different_link() {
        // Two links to the same neighbour is a normal thing — a port channel
        // seen as two adjacencies — and collapsing them loses a real edge.
        let cdp = vec![
            neighbor("SW2", "Gi1/0/1", Protocol::Cdp),
            neighbor("SW2", "Gi1/0/2", Protocol::Cdp),
        ];
        let merged = merge_neighbors(cdp, vec![]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn lldp_fills_in_what_cdp_left_blank() {
        let mut cdp_entry = neighbor("SW2", "Gi1/0/1", Protocol::Cdp);
        cdp_entry.addresses = vec![];
        let mut lldp_entry = neighbor("SW2", "Gi1/0/1", Protocol::Lldp);
        lldp_entry.addresses = vec![DeviceAddress::management("10.1.1.2")];

        let merged = merge_neighbors(vec![cdp_entry], vec![lldp_entry]);
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].addresses.len(), 1, "the address LLDP knew was dropped");
        assert_eq!(merged[0].addresses[0].ip, "10.1.1.2");
    }

    #[test]
    fn cdp_and_lldp_names_for_one_port_are_the_same_port() {
        // From a real switch: CDP said GigabitEthernet0/8 and LLDP said Gi0/8
        // for the same access point, and the diagram gained a duplicate edge.
        assert!(same_interface("GigabitEthernet0/8", "Gi0/8"));
        assert!(same_interface("Gi0/8", "GigabitEthernet0/8"));
        assert!(same_interface("TenGigabitEthernet1/0/1", "Te1/0/1"));
        assert!(same_interface("Port-channel10", "Po10"));
        assert!(same_interface("Ethernet1/1", "Eth1/1"));
        assert!(same_interface("Gi0/8", "gi0/8"));
    }

    #[test]
    fn different_ports_are_not_merged() {
        // The failure in the other direction loses a real link.
        assert!(!same_interface("GigabitEthernet0/8", "Gi0/9"));
        assert!(!same_interface("GigabitEthernet1/0/8", "Gi0/8"));
        assert!(!same_interface("Gi0/1", "Te0/1"), "different media, same number");
        assert!(!same_interface("", ""));
    }

    #[test]
    fn one_adjacency_named_two_ways_merges_into_one() {
        let cdp = vec![neighbor("AP-1", "GigabitEthernet0/8", Protocol::Cdp)];
        let lldp = vec![neighbor("AP-1", "Gi0/8", Protocol::Lldp)];
        assert_eq!(merge_neighbors(cdp, lldp).len(), 1);
    }

    #[test]
    fn a_catalyst_version_banner_classifies_as_a_switch() {
        // A real C2960CX came back Unknown: the model line sits past the first
        // thirty lines, and the family was missing from the switch list.
        let banner = "\
Cisco IOS Software, C2960CX Software (C2960CX-UNIVERSALK9-M), Version 15.2(7)E, RELEASE SOFTWARE (fc3)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2019 by Cisco Systems, Inc.

HOME-MAIN-SW uptime is 5 weeks
System image file is \"flash:/c2960cx-universalk9-mz.152-7.E.bin\"
";
        let platform = platform_from_version(banner).unwrap();
        assert_eq!(
            crate::classify::classify(Some(&platform), &[], Some(banner)),
            DeviceClass::Switch,
            "platform was {platform:?}"
        );
    }

    #[test]
    fn a_model_is_pulled_from_a_version_banner() {
        let ios = "\
Cisco IOS Software, C2960X Software (C2960X-UNIVERSALK9-M), Version 15.2(4)E7
cisco WS-C2960X-24TS-L (APM86XXX) processor (revision H0) with 524288K bytes
Model number            : WS-C2960X-24TS-L
";
        assert_eq!(
            platform_from_version(ios).as_deref(),
            Some("WS-C2960X-24TS-L")
        );
    }

    #[test]
    fn an_unrecognised_banner_still_yields_something_to_classify_on() {
        let nxos = "Cisco Nexus Operating System (NX-OS) Software\nVersion 9.3(3)";
        let p = platform_from_version(nxos).unwrap();
        assert!(p.contains("Nexus"), "got {p}");
        // And that is enough for the classifier.
        assert_eq!(
            crate::classify::classify(Some(&p), &[], None),
            DeviceClass::Switch
        );
    }

    #[test]
    fn snmp_is_off_unless_asked_for() {
        // A community string is a credential; using one nobody supplied would
        // be surprising, and an estate without SNMP should see no attempts.
        assert!(CrawlOptions::default().snmp.is_none());
    }

    #[test]
    fn how_a_device_was_reached_is_recorded() {
        // The distinction matters: SSH gives neighbours and an interface
        // table, SNMP gives a name. Presenting them identically would imply
        // the map is more complete than it is.
        assert_ne!(ReachedBy::Ssh, ReachedBy::Snmp);
        let json = serde_json::to_string(&ReachedBy::Snmp).unwrap();
        assert_eq!(json, "\"snmp\"", "the interface reads this");
    }

    #[test]
    fn crawl_options_default_to_something_survivable() {
        // These are the guards against a crawl that never ends: a link nobody
        // remembered, a routing loop, a lab connected to production.
        let o = CrawlOptions::default();
        assert!(o.max_hops > 0 && o.max_hops <= 16);
        assert!(o.max_devices > 0);
        assert!(o.concurrency >= 1);
        assert!(!o.second_factor, "opt in, since most estates do not use it");
    }
}
