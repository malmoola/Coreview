//! TCP connect and DNS resolution probes.

use std::io::ErrorKind;
use std::time::{Duration, Instant};

use tokio::net::TcpStream;
use tokio::time::timeout;

use crate::types::{Outcome, ProbeResult};
use crate::validate::{parse_target, validate_port};

/// Timeout-bounded TCP connect. Refused, timed out, DNS failure, and other OS
/// errors are reported distinctly rather than collapsed into "down".
pub async fn probe_tcp(
    probe_id: &str,
    raw_target: &str,
    port: u32,
    timeout_ms: u64,
    now_ms: i64,
) -> ProbeResult {
    let target = match parse_target(raw_target) {
        Ok(t) => t,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };
    let port = match validate_port(port) {
        Ok(p) => p,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };

    let addr = format!("{}:{}", target.as_str(), port);
    let started = Instant::now();

    match timeout(Duration::from_millis(timeout_ms), TcpStream::connect(&addr)).await {
        Err(_) => ProbeResult::failed(
            probe_id,
            now_ms,
            Outcome::Timeout,
            &format!("Connection to {addr} timed out"),
        ),
        Ok(Ok(stream)) => {
            let rtt = started.elapsed().as_secs_f64() * 1000.0;
            drop(stream);
            ProbeResult {
                probe_id: probe_id.to_string(),
                timestamp_ms: now_ms,
                outcome: Outcome::Success,
                rtt_ms: Some(rtt),
                resolved: vec![],
                summary: format!("Connected to port {port}, {rtt:.0} ms"),
                error_message: None,
            }
        }
        Ok(Err(e)) => {
            let outcome = match e.kind() {
                ErrorKind::ConnectionRefused => Outcome::Refused,
                ErrorKind::TimedOut => Outcome::Timeout,
                ErrorKind::AddrNotAvailable | ErrorKind::InvalidInput => Outcome::DnsFailure,
                _ => {
                    // Resolver failures surface as generic OS errors on some
                    // platforms; the text is the only discriminator.
                    let msg = e.to_string().to_lowercase();
                    if msg.contains("not known")
                        || msg.contains("no such host")
                        || msg.contains("failed to lookup")
                        || msg.contains("name or service")
                    {
                        Outcome::DnsFailure
                    } else if msg.contains("unreachable") {
                        Outcome::Unreachable
                    } else {
                        Outcome::OsError
                    }
                }
            };
            let summary = match outcome {
                Outcome::Refused => format!("Connection refused on port {port}"),
                Outcome::DnsFailure => "Host name could not be resolved".to_string(),
                Outcome::Unreachable => "Destination unreachable".to_string(),
                _ => e.to_string(),
            };
            ProbeResult::failed(probe_id, now_ms, outcome, &summary)
        }
    }
}

/// Resolve a name through the operating system resolver.
pub async fn probe_dns(probe_id: &str, raw_target: &str, timeout_ms: u64, now_ms: i64) -> ProbeResult {
    let target = match parse_target(raw_target) {
        Ok(t) => t,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };

    let name = target.as_str();
    let started = Instant::now();
    // Port 0 is ignored by the resolver; it is required by the lookup API.
    let lookup = format!("{name}:0");

    let res = timeout(
        Duration::from_millis(timeout_ms),
        tokio::net::lookup_host(lookup),
    )
    .await;

    match res {
        Err(_) => ProbeResult::failed(
            probe_id,
            now_ms,
            Outcome::Timeout,
            "DNS lookup timed out",
        ),
        Ok(Err(e)) => ProbeResult::failed(
            probe_id,
            now_ms,
            Outcome::DnsFailure,
            &format!("DNS lookup failed: {e}"),
        ),
        Ok(Ok(addrs)) => {
            let resolved: Vec<String> = addrs.map(|a| a.ip().to_string()).collect();
            if resolved.is_empty() {
                return ProbeResult::failed(
                    probe_id,
                    now_ms,
                    Outcome::NoAnswer,
                    "DNS returned no addresses",
                );
            }
            let rtt = started.elapsed().as_secs_f64() * 1000.0;
            ProbeResult {
                probe_id: probe_id.to_string(),
                timestamp_ms: now_ms,
                outcome: Outcome::Success,
                rtt_ms: Some(rtt),
                summary: format!("Resolved to {}", resolved.join(", ")),
                resolved,
                error_message: None,
            }
        }
    }
}
