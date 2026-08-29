//! Ping sweep: find what answers inside a subnet.
//!
//! This is discovery, not monitoring. A sweep runs once, walks every host
//! address in a CIDR range concurrently, and reports what replied. The
//! validation engine in `engine.rs` is the opposite shape — a small fixed set
//! of targets checked forever on an interval — so the two share the transport
//! (`icmp::ping_once`) and nothing else.
//!
//! Every ping still goes through `validate::parse_target`, so a sweep cannot
//! reach a process argument the validator would have rejected. Addresses here
//! are generated from a parsed CIDR rather than typed by a person, so that is
//! belt and braces, but the sweep must not be the one place that bypasses it.

use std::net::Ipv4Addr;
use std::sync::Arc;

use tokio::sync::{mpsc, Semaphore};
use tokio_util::sync::CancellationToken;

use crate::icmp::ping_once;
use crate::validate::{parse_target, ValidationError};

/// Largest sweep we will start, in host addresses.
///
/// A /16 is 65,534 hosts. At 64 in flight and a 1 second timeout that is a few
/// minutes, which is a long wait but a legitimate thing to ask for. Anything
/// larger is almost certainly a typo — a /8 is sixteen million pings — and
/// refusing is kinder than appearing to hang.
pub const MAX_SWEEP_HOSTS: u32 = 65_534;

/// Concurrency bounds. Too few and a /24 takes minutes; too many and a laptop
/// runs out of file descriptors, or a firewall reads the burst as a scan.
pub const MIN_CONCURRENCY: usize = 1;
pub const MAX_CONCURRENCY: usize = 256;
pub const DEFAULT_CONCURRENCY: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CidrError {
    #[error("subnet is empty")]
    Empty,
    #[error("subnet must be written as address/prefix, for example 192.168.1.0/24")]
    NoPrefix,
    #[error("{0} is not an IPv4 address")]
    BadAddress(String),
    #[error("prefix length must be between 0 and 32")]
    BadPrefix,
    #[error("only IPv4 subnets can be swept")]
    NotIpv4,
    #[error("that subnet holds {0} addresses; the most that can be swept at once is {1}")]
    TooLarge(u32, u32),
}

/// An IPv4 subnet, stored as its network address and prefix length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    network: u32,
    prefix: u8,
}

impl Cidr {
    pub fn prefix(&self) -> u8 {
        self.prefix
    }

    pub fn network(&self) -> Ipv4Addr {
        Ipv4Addr::from(self.network)
    }

    pub fn broadcast(&self) -> Ipv4Addr {
        Ipv4Addr::from(self.network | !mask(self.prefix))
    }

    /// True if the address falls inside this subnet. This is what "filtered by
    /// subnet" means everywhere else in the app.
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & mask(self.prefix) == self.network
    }

    /// The addresses a sweep should actually try.
    ///
    /// For a /31 and /32 that is every address in the range: RFC 3021 gives
    /// /31 two usable hosts for point-to-point links, and a /32 is a single
    /// host route. For everything wider, the network and broadcast addresses
    /// are skipped — pinging the broadcast address either does nothing or
    /// provokes replies from every host at once, neither of which is a
    /// discovery result.
    pub fn hosts(&self) -> impl Iterator<Item = Ipv4Addr> {
        let (first, last) = self.host_range();
        (first..=last).map(Ipv4Addr::from)
    }

    pub fn host_count(&self) -> u32 {
        let (first, last) = self.host_range();
        last - first + 1
    }

    fn host_range(&self) -> (u32, u32) {
        let broadcast = self.network | !mask(self.prefix);
        if self.prefix >= 31 {
            (self.network, broadcast)
        } else {
            (self.network + 1, broadcast - 1)
        }
    }
}

fn mask(prefix: u8) -> u32 {
    if prefix == 0 {
        0
    } else {
        u32::MAX << (32 - prefix)
    }
}

/// Parses `a.b.c.d/n`, normalising the address down to the network address so
/// `192.168.1.57/24` and `192.168.1.0/24` describe the same subnet. Typing a
/// host address with a prefix is the common case, not an error.
pub fn parse_cidr(input: &str) -> Result<Cidr, CidrError> {
    let text = input.trim();
    if text.is_empty() {
        return Err(CidrError::Empty);
    }
    let (addr, prefix) = text.split_once('/').ok_or(CidrError::NoPrefix)?;

    let addr: Ipv4Addr = addr
        .trim()
        .parse()
        .map_err(|_| CidrError::BadAddress(addr.trim().to_string()))?;
    let prefix: u8 = prefix
        .trim()
        .parse()
        .map_err(|_| CidrError::BadPrefix)
        .and_then(|p: u8| if p <= 32 { Ok(p) } else { Err(CidrError::BadPrefix) })?;

    Ok(Cidr {
        network: u32::from(addr) & mask(prefix),
        prefix,
    })
}

/// Parses a subnet and refuses one too large to sweep.
pub fn parse_sweepable_cidr(input: &str) -> Result<Cidr, CidrError> {
    let cidr = parse_cidr(input)?;
    let count = cidr.host_count();
    if count > MAX_SWEEP_HOSTS {
        return Err(CidrError::TooLarge(count, MAX_SWEEP_HOSTS));
    }
    Ok(cidr)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepOptions {
    /// Milliseconds to wait for a single reply.
    pub timeout_ms: u64,
    /// How many pings may be in flight at once.
    pub concurrency: usize,
}

impl Default for SweepOptions {
    fn default() -> Self {
        Self {
            timeout_ms: 1_000,
            concurrency: DEFAULT_CONCURRENCY,
        }
    }
}

impl SweepOptions {
    /// Clamps rather than rejects. These come from a slider, and a value out of
    /// range should behave sensibly instead of failing a long-running sweep.
    pub fn clamped(self) -> Self {
        Self {
            timeout_ms: self.timeout_ms.clamp(100, 60_000),
            concurrency: self.concurrency.clamp(MIN_CONCURRENCY, MAX_CONCURRENCY),
        }
    }
}

/// One address that answered.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SweepHit {
    pub ip: String,
    pub rtt_ms: Option<f64>,
}

/// Progress and results, streamed as the sweep runs.
///
/// A /24 takes a while and a user watching a blank screen assumes it has hung,
/// so hosts are reported the moment they answer rather than collected into a
/// final list.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SweepEvent {
    Started { total: u32 },
    Alive(SweepHit),
    /// Emitted after every address, answered or not, so a progress bar can move.
    Progress { done: u32, total: u32 },
    Finished { alive: u32, scanned: u32, cancelled: bool },
}

/// Sweeps several subnets as one run.
///
/// A single combined total and one progress sequence, rather than a run per
/// subnet: a progress bar that restarts three times reads as three failures,
/// and "142 of 762" is the number someone actually wants while waiting.
///
/// Subnets are scanned in the order given, so results arrive in an order that
/// matches what was typed.
pub async fn sweep_many(
    cidrs: Vec<Cidr>,
    options: SweepOptions,
    events: mpsc::Sender<SweepEvent>,
    cancel: CancellationToken,
) -> Vec<SweepHit> {
    let options = options.clamped();
    let total: u32 = cidrs.iter().map(|c| c.host_count()).sum();
    let _ = events.send(SweepEvent::Started { total }).await;

    let mut alive = Vec::new();
    let mut done = 0u32;
    for cidr in cidrs {
        if cancel.is_cancelled() {
            break;
        }
        let (found, scanned) =
            scan_one(cidr, &options, &events, &cancel, done, total).await;
        alive.extend(found);
        done += scanned;
    }

    let _ = events
        .send(SweepEvent::Finished {
            alive: alive.len() as u32,
            scanned: done,
            cancelled: cancel.is_cancelled(),
        })
        .await;
    alive
}

/// Sweeps a subnet, sending events as they happen.
///
/// Returns the addresses that answered, in the order they answered. Cancelling
/// the token stops new pings starting and lets in-flight ones fall away; the
/// `Finished` event still arrives, with `cancelled` set, so the UI always gets
/// a terminal event to react to.
pub async fn sweep(
    cidr: Cidr,
    options: SweepOptions,
    events: mpsc::Sender<SweepEvent>,
    cancel: CancellationToken,
) -> Vec<SweepHit> {
    let options = options.clamped();
    let total = cidr.host_count();
    let _ = events.send(SweepEvent::Started { total }).await;

    let (alive, scanned) = scan_one(cidr, &options, &events, &cancel, 0, total).await;

    let _ = events
        .send(SweepEvent::Finished {
            alive: alive.len() as u32,
            scanned,
            cancelled: cancel.is_cancelled(),
        })
        .await;
    alive
}

/// One subnet's worth of scanning, without the Started and Finished events.
///
/// Split out so a multi-subnet run reports one continuous sequence:
/// `already_done` is how many addresses earlier subnets contributed, and
/// `total` is the whole run rather than this subnet.
///
/// Returns what answered and how many addresses were tried.
async fn scan_one(
    cidr: Cidr,
    options: &SweepOptions,
    events: &mpsc::Sender<SweepEvent>,
    cancel: &CancellationToken,
    already_done: u32,
    total: u32,
) -> (Vec<SweepHit>, u32) {
    let permits = Arc::new(Semaphore::new(options.concurrency));
    let mut tasks = tokio::task::JoinSet::new();

    for ip in cidr.hosts() {
        if cancel.is_cancelled() {
            break;
        }
        let Ok(permit) = Arc::clone(&permits).acquire_owned().await else {
            break;
        };
        let cancel = cancel.clone();
        let timeout_ms = options.timeout_ms;
        tasks.spawn(async move {
            let _permit = permit;
            if cancel.is_cancelled() {
                return (ip, None);
            }
            // Generated from a parsed CIDR, but routed through the validator
            // anyway so this is not the one path into `ping` that skips it.
            let Ok(target) = parse_target(&ip.to_string()) else {
                return (ip, None);
            };
            let hit = tokio::select! {
                _ = cancel.cancelled() => None,
                res = ping_once(&target, timeout_ms) => match res {
                    Ok(p) if p.outcome.is_success() => Some(p.rtt_ms),
                    _ => None,
                },
            };
            (ip, hit)
        });
    }

    let mut alive = Vec::new();
    let mut done = 0u32;
    while let Some(joined) = tasks.join_next().await {
        done += 1;
        if let Ok((ip, Some(rtt_ms))) = joined {
            let hit = SweepHit {
                ip: ip.to_string(),
                rtt_ms,
            };
            alive.push(hit.clone());
            let _ = events.send(SweepEvent::Alive(hit)).await;
        }
        let _ = events
            .send(SweepEvent::Progress {
                done: already_done + done,
                total,
            })
            .await;
    }

    (alive, done)
}

/// Convenience for the "filtered by subnet" rule applied to a list of
/// addresses that came from somewhere else — CDP neighbours, an SNMP table, a
/// diagram. Anything unparseable is excluded rather than assumed to be inside.
pub fn within_any(ip: &str, subnets: &[Cidr]) -> bool {
    match ip.trim().parse::<Ipv4Addr>() {
        Ok(addr) => subnets.iter().any(|c| c.contains(addr)),
        Err(_) => false,
    }
}

/// Parses a list of subnets, reporting which entry failed rather than which
/// text failed, so a form can mark the offending row.
pub fn parse_subnets(inputs: &[String]) -> Result<Vec<Cidr>, (usize, CidrError)> {
    inputs
        .iter()
        .enumerate()
        .map(|(i, s)| parse_cidr(s).map_err(|e| (i, e)))
        .collect()
}

impl From<ValidationError> for CidrError {
    fn from(_: ValidationError) -> Self {
        CidrError::NotIpv4
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_plain_subnet() {
        let c = parse_cidr("192.168.1.0/24").unwrap();
        assert_eq!(c.network(), Ipv4Addr::new(192, 168, 1, 0));
        assert_eq!(c.prefix(), 24);
        assert_eq!(c.broadcast(), Ipv4Addr::new(192, 168, 1, 255));
    }

    #[test]
    fn normalises_a_host_address_to_its_network() {
        // Typing the address of a device you know, with a prefix, is the
        // common way to say "this subnet".
        let c = parse_cidr("192.168.14.57/24").unwrap();
        assert_eq!(c.network(), Ipv4Addr::new(192, 168, 14, 0));
        assert!(c.contains(Ipv4Addr::new(192, 168, 14, 1)));
        assert!(c.contains(Ipv4Addr::new(192, 168, 14, 254)));
        assert!(!c.contains(Ipv4Addr::new(192, 168, 15, 1)));
    }

    #[test]
    fn a_24_skips_network_and_broadcast() {
        let c = parse_cidr("10.0.0.0/24").unwrap();
        let hosts: Vec<_> = c.hosts().collect();
        assert_eq!(hosts.len(), 254);
        assert_eq!(hosts[0], Ipv4Addr::new(10, 0, 0, 1));
        assert_eq!(hosts[253], Ipv4Addr::new(10, 0, 0, 254));
        assert_eq!(c.host_count(), 254);
    }

    #[test]
    fn a_31_sweeps_both_addresses() {
        // RFC 3021: a /31 is two usable hosts on a point-to-point link, so
        // skipping "network" and "broadcast" would leave nothing to scan.
        let c = parse_cidr("10.0.0.4/31").unwrap();
        let hosts: Vec<_> = c.hosts().collect();
        assert_eq!(hosts, vec![Ipv4Addr::new(10, 0, 0, 4), Ipv4Addr::new(10, 0, 0, 5)]);
    }

    #[test]
    fn a_32_sweeps_exactly_one_address() {
        let c = parse_cidr("10.0.0.9/32").unwrap();
        assert_eq!(c.hosts().collect::<Vec<_>>(), vec![Ipv4Addr::new(10, 0, 0, 9)]);
        assert_eq!(c.host_count(), 1);
    }

    #[test]
    fn a_30_has_two_usable_hosts() {
        let c = parse_cidr("172.16.0.0/30").unwrap();
        assert_eq!(
            c.hosts().collect::<Vec<_>>(),
            vec![Ipv4Addr::new(172, 16, 0, 1), Ipv4Addr::new(172, 16, 0, 2)]
        );
    }

    #[test]
    fn rejects_malformed_input() {
        assert_eq!(parse_cidr(""), Err(CidrError::Empty));
        assert_eq!(parse_cidr("192.168.1.0"), Err(CidrError::NoPrefix));
        assert_eq!(parse_cidr("192.168.1.0/33"), Err(CidrError::BadPrefix));
        assert_eq!(parse_cidr("192.168.1.0/abc"), Err(CidrError::BadPrefix));
        assert!(matches!(parse_cidr("not-an-ip/24"), Err(CidrError::BadAddress(_))));
        // IPv6 has no sweep: a /64 is more addresses than exist in IPv4.
        assert!(matches!(parse_cidr("2001:db8::/64"), Err(CidrError::BadAddress(_))));
    }

    #[test]
    fn refuses_a_sweep_too_large_to_finish() {
        // A /8 is sixteen million pings. Refusing beats appearing to hang.
        let err = parse_sweepable_cidr("10.0.0.0/8").unwrap_err();
        assert!(matches!(err, CidrError::TooLarge(16_777_214, MAX_SWEEP_HOSTS)));
        // A /16 is large but a real thing to ask for.
        assert!(parse_sweepable_cidr("10.1.0.0/16").is_ok());
    }

    #[test]
    fn subnet_filter_excludes_unparseable_addresses() {
        let nets = parse_subnets(&["192.168.14.0/24".into(), "10.0.0.0/8".into()]).unwrap();
        assert!(within_any("192.168.14.1", &nets));
        assert!(within_any("10.5.6.7", &nets));
        assert!(!within_any("172.16.0.1", &nets));
        // CDP reports "N/A" when a neighbour advertises no address. It must not
        // be treated as inside the filter.
        assert!(!within_any("N/A", &nets));
        assert!(!within_any("", &nets));
    }

    #[test]
    fn parse_subnets_reports_which_entry_failed() {
        let err = parse_subnets(&["192.168.1.0/24".into(), "bad".into()]).unwrap_err();
        assert_eq!(err.0, 1);
        assert_eq!(err.1, CidrError::NoPrefix);
    }

    #[test]
    fn options_are_clamped_not_rejected() {
        let o = SweepOptions {
            timeout_ms: 5,
            concurrency: 100_000,
        }
        .clamped();
        assert_eq!(o.timeout_ms, 100);
        assert_eq!(o.concurrency, MAX_CONCURRENCY);
    }

    #[test]
    fn the_event_wire_format_is_what_the_frontend_expects() {
        // This is a contract with TypeScript, which cannot check it. Serde's
        // tagging rules decide the shape, and a newtype variant flattening or
        // not flattening changes whether the UI sees `ip` or `{ip}`.
        let json = |e: &SweepEvent| serde_json::to_string(e).unwrap();

        assert_eq!(json(&SweepEvent::Started { total: 254 }), r#"{"kind":"started","total":254}"#);
        assert_eq!(
            json(&SweepEvent::Alive(SweepHit {
                ip: "10.0.0.1".into(),
                rtt_ms: Some(1.5),
            })),
            r#"{"kind":"alive","ip":"10.0.0.1","rttMs":1.5}"#
        );
        assert_eq!(
            json(&SweepEvent::Progress { done: 7, total: 254 }),
            r#"{"kind":"progress","done":7,"total":254}"#
        );
        assert_eq!(
            json(&SweepEvent::Finished {
                alive: 3,
                scanned: 254,
                cancelled: false
            }),
            r#"{"kind":"finished","alive":3,"scanned":254,"cancelled":false}"#
        );
        // A host that answered without a parseable time still counts as alive.
        assert_eq!(
            json(&SweepEvent::Alive(SweepHit { ip: "10.0.0.2".into(), rtt_ms: None })),
            r#"{"kind":"alive","ip":"10.0.0.2","rttMs":null}"#
        );
    }

    #[tokio::test]
    async fn sweeping_a_single_loopback_address_finds_it() {
        let (tx, mut rx) = mpsc::channel(64);
        let cidr = parse_cidr("127.0.0.1/32").unwrap();
        let hits = sweep(cidr, SweepOptions::default(), tx, CancellationToken::new()).await;

        assert_eq!(hits.len(), 1, "loopback should answer");
        assert_eq!(hits[0].ip, "127.0.0.1");

        let mut events = Vec::new();
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }
        assert!(matches!(events.first(), Some(SweepEvent::Started { total: 1 })));
        assert!(matches!(
            events.last(),
            Some(SweepEvent::Finished {
                alive: 1,
                scanned: 1,
                cancelled: false
            })
        ));
    }

    #[tokio::test]
    async fn several_subnets_report_one_continuous_progress_sequence() {
        // A progress bar that restarts per subnet reads as several failures.
        let (tx, mut rx) = mpsc::channel(4096);
        let cidrs = vec![
            parse_cidr("127.0.0.1/32").unwrap(),
            parse_cidr("127.0.0.2/32").unwrap(),
            parse_cidr("127.0.0.3/32").unwrap(),
        ];
        let hits = sweep_many(cidrs, SweepOptions::default(), tx, CancellationToken::new()).await;
        assert_eq!(hits.len(), 3, "the whole of 127/8 is loopback and answers");

        let mut events = Vec::new();
        while let Ok(e) = rx.try_recv() {
            events.push(e);
        }

        // One Started and one Finished for the run, not one per subnet.
        let started: Vec<_> = events
            .iter()
            .filter_map(|e| match e {
                SweepEvent::Started { total } => Some(*total),
                _ => None,
            })
            .collect();
        assert_eq!(started, vec![3], "one Started, carrying the combined total");

        let finished = events
            .iter()
            .filter(|e| matches!(e, SweepEvent::Finished { .. }))
            .count();
        assert_eq!(finished, 1, "one Finished for the run");

        // Progress climbs to the combined total and never restarts.
        let progress: Vec<u32> = events
            .iter()
            .filter_map(|e| match e {
                SweepEvent::Progress { done, total } => {
                    assert_eq!(*total, 3, "every Progress carries the run total");
                    Some(*done)
                }
                _ => None,
            })
            .collect();
        assert_eq!(progress, vec![1, 2, 3], "got {progress:?}");
    }

    #[tokio::test]
    async fn sweeping_no_subnets_at_all_still_finishes() {
        // A UI that clears its spinner on Finished must always get one.
        let (tx, mut rx) = mpsc::channel(16);
        let hits = sweep_many(vec![], SweepOptions::default(), tx, CancellationToken::new()).await;
        assert!(hits.is_empty());
        let mut last = None;
        while let Ok(e) = rx.try_recv() {
            last = Some(e);
        }
        assert!(matches!(last, Some(SweepEvent::Finished { scanned: 0, .. })), "got {last:?}");
    }

    #[tokio::test]
    async fn cancelling_still_produces_a_finished_event() {
        // A UI that only clears its spinner on Finished must always get one.
        let (tx, mut rx) = mpsc::channel(4096);
        let cidr = parse_cidr("192.0.2.0/24").unwrap();
        let cancel = CancellationToken::new();
        cancel.cancel();

        let hits = sweep(cidr, SweepOptions::default(), tx, cancel).await;

        assert!(hits.is_empty());
        let mut last = None;
        while let Ok(e) = rx.try_recv() {
            last = Some(e);
        }
        assert!(
            matches!(last, Some(SweepEvent::Finished { cancelled: true, .. })),
            "a cancelled sweep must still finish, got {last:?}"
        );
    }
}
