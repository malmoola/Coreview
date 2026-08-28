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

use tokio::sync::{mpsc, Mutex};
use tokio_util::sync::CancellationToken;

use crate::cdp::parse_cdp_detail;
use crate::filter::DiscoveryFilter;
use crate::hostkeys::HostKeyStore;
use crate::interfaces::{addresses_from, parse_ip_interface_brief};
use crate::lldp::parse_lldp_detail;
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
        }
    }
}

/// A device the crawl logged into.
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

        match visit(
            &address,
            hops,
            &credentials,
            &options,
            Arc::clone(&store),
            &events,
            Arc::clone(&auth_gate),
            Arc::clone(&serialise),
        )
        .await
        {
            Err(e) => {
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
    let key = |n: &Neighbor| {
        (
            n.short_name.to_ascii_lowercase(),
            n.local_interface.clone().unwrap_or_default().to_ascii_lowercase(),
        )
    };

    let mut merged: Vec<Neighbor> = Vec::new();
    let mut seen: HashSet<(String, String)> = HashSet::new();

    for n in cdp {
        seen.insert(key(&n));
        merged.push(n);
    }
    for mut n in lldp {
        if let Some(existing) = merged.iter_mut().find(|e| key(e) == key(&n)) {
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

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|l| !l.is_empty())
}

/// Pulls a model out of a `show version` banner, for classification.
fn platform_from_version(version: &str) -> Option<String> {
    for line in version.lines().take(30) {
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
        // "cisco WS-C2960X-24TS-L (PowerPC405) processor"
        if let Some(rest) = t.strip_prefix("cisco ") {
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
