//! ICMP via a controlled invocation of the platform `ping` binary.
//!
//! Security note: the target is parsed by `validate::parse_target` first, and
//! the binary is invoked with an argument vector. There is no shell, no
//! `cmd.exe`, no string concatenation, and no user-controlled flags.

use std::process::Stdio;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::types::{Outcome, ProbeResult};
use crate::validate::{parse_target, Target};

/// Build the argument vector for a single-shot ping. Pure, so the exact flags
/// are covered by tests on every platform.
pub fn ping_args(target: &Target, timeout_ms: u64) -> Vec<String> {
    let t = target.as_str();
    if cfg!(windows) {
        let mut args = vec!["-n".into(), "1".into(), "-w".into(), timeout_ms.to_string()];
        match target {
            Target::Ip(ip) if ip.is_ipv6() => args.push("-6".into()),
            Target::Ip(_) => args.push("-4".into()),
            Target::Host(_) => {}
        }
        args.push(t);
        args
    } else {
        // Linux/macOS ping takes -W in seconds (rounded up, minimum 1).
        let secs = timeout_ms.div_ceil(1000).max(1).to_string();
        vec!["-c".into(), "1".into(), "-W".into(), secs, t]
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct PingParse {
    pub outcome: Outcome,
    pub rtt_ms: Option<f64>,
    pub summary: String,
}

/// Parse ping output. Exit code alone is not enough: Windows `ping.exe` returns
/// 0 for "Destination host unreachable" in some cases, so the text is
/// authoritative and the exit code is a fallback.
pub fn parse_ping_output(stdout: &str, stderr: &str, exit_code: Option<i32>) -> PingParse {
    let text = format!("{stdout}\n{stderr}");
    let lower = text.to_lowercase();

    if lower.contains("could not find host")
        || lower.contains("name or service not known")
        || lower.contains("unknown host")
        || lower.contains("temporary failure in name resolution")
    {
        return PingParse {
            outcome: Outcome::DnsFailure,
            rtt_ms: None,
            summary: "Host name could not be resolved".into(),
        };
    }

    if lower.contains("destination host unreachable")
        || lower.contains("destination net unreachable")
        || lower.contains("destination unreachable")
        || lower.contains("network is unreachable")
    {
        return PingParse {
            outcome: Outcome::Unreachable,
            rtt_ms: None,
            summary: "Destination unreachable".into(),
        };
    }

    if lower.contains("request timed out")
        || lower.contains("100% packet loss")
        || lower.contains("100.0% packet loss")
        || lower.contains("request timeout")
    {
        return PingParse {
            outcome: Outcome::Timeout,
            rtt_ms: None,
            summary: "Request timed out".into(),
        };
    }

    if let Some(rtt) = extract_rtt(&lower) {
        return PingParse {
            outcome: Outcome::Success,
            rtt_ms: Some(rtt),
            summary: format!("Reply, {} ms", format_rtt(rtt)),
        };
    }

    match exit_code {
        Some(0) => PingParse {
            outcome: Outcome::Success,
            rtt_ms: None,
            summary: "Reply received".into(),
        },
        _ => PingParse {
            outcome: Outcome::OsError,
            rtt_ms: None,
            summary: first_meaningful_line(&text)
                .unwrap_or_else(|| "Ping failed with no output".into()),
        },
    }
}

fn format_rtt(rtt: f64) -> String {
    if rtt < 1.0 {
        "<1".into()
    } else if rtt.fract() == 0.0 {
        format!("{rtt:.0}")
    } else {
        format!("{rtt:.1}")
    }
}

/// Handles `time=2ms`, `time<1ms`, `time=0.123 ms`, and `tiempo=2ms`-style
/// localized output by anchoring on `=`/`<` followed by digits and `ms`.
fn extract_rtt(lower: &str) -> Option<f64> {
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '=' || c == '<' {
            let rest = &lower[i + 1..];
            let trimmed = rest.trim_start();
            let num: String = trimmed
                .chars()
                .take_while(|ch| ch.is_ascii_digit() || *ch == '.')
                .collect();
            if !num.is_empty() {
                let after = trimmed[num.len()..].trim_start();
                if after.starts_with("ms") {
                    let parsed: f64 = num.parse().ok()?;
                    // "time<1ms" means "under one millisecond".
                    return Some(if c == '<' { 0.5_f64.min(parsed) } else { parsed });
                }
            }
        }
        i += 1;
    }
    None
}

fn first_meaningful_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .map(|l| l.chars().take(200).collect())
}

/// Run a single ICMP check. Cancellation is handled by the caller dropping the
/// future; the child process is killed on drop.
pub async fn probe_icmp(probe_id: &str, raw_target: &str, timeout_ms: u64, now_ms: i64) -> ProbeResult {
    let target = match parse_target(raw_target) {
        Ok(t) => t,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };

    let program = if cfg!(windows) { "ping.exe" } else { "ping" };
    let mut cmd = Command::new(program);
    cmd.args(ping_args(&target, timeout_ms))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    {
        // Suppress the console flash that ping.exe would otherwise cause.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    // Hard wall-clock bound so a wedged child cannot hold a scheduler slot.
    let wall = Duration::from_millis(timeout_ms + 2_000);
    let output = match timeout(wall, cmd.output()).await {
        Err(_) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::Timeout,
                "Ping did not return within the timeout",
            )
        }
        Ok(Err(e)) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::OsError,
                &format!("Could not run ping: {e}"),
            )
        }
        Ok(Ok(o)) => o,
    };

    let parsed = parse_ping_output(
        &String::from_utf8_lossy(&output.stdout),
        &String::from_utf8_lossy(&output.stderr),
        output.status.code(),
    );

    ProbeResult {
        probe_id: probe_id.to_string(),
        timestamp_ms: now_ms,
        outcome: parsed.outcome,
        rtt_ms: parsed.rtt_ms,
        resolved: vec![],
        summary: parsed.summary.clone(),
        error_message: if parsed.outcome.is_success() {
            None
        } else {
            Some(parsed.summary)
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_reply_is_parsed_with_rtt() {
        let out = "Pinging 10.10.10.1 with 32 bytes of data:\r\n\
                   Reply from 10.10.10.1: bytes=32 time=2ms TTL=255\r\n";
        let p = parse_ping_output(out, "", Some(0));
        assert_eq!(p.outcome, Outcome::Success);
        assert_eq!(p.rtt_ms, Some(2.0));
        assert_eq!(p.summary, "Reply, 2 ms");
    }

    #[test]
    fn sub_millisecond_reply_is_success() {
        let out = "Reply from 127.0.0.1: bytes=32 time<1ms TTL=128\r\n";
        let p = parse_ping_output(out, "", Some(0));
        assert_eq!(p.outcome, Outcome::Success);
        assert_eq!(p.summary, "Reply, <1 ms");
    }

    #[test]
    fn linux_reply_is_parsed() {
        let out = "64 bytes from 10.10.10.1: icmp_seq=1 ttl=64 time=0.123 ms\n";
        let p = parse_ping_output(out, "", Some(0));
        assert_eq!(p.outcome, Outcome::Success);
        assert_eq!(p.rtt_ms, Some(0.123));
    }

    #[test]
    fn timeout_is_distinct_from_unreachable() {
        let t = parse_ping_output("Request timed out.\r\n", "", Some(1));
        assert_eq!(t.outcome, Outcome::Timeout);
        let u = parse_ping_output(
            "Reply from 10.10.10.9: Destination host unreachable.\r\n",
            "",
            Some(0),
        );
        assert_eq!(u.outcome, Outcome::Unreachable);
    }

    #[test]
    fn dns_failure_is_distinct() {
        let p = parse_ping_output("Ping request could not find host nope.invalid.", "", Some(1));
        assert_eq!(p.outcome, Outcome::DnsFailure);
    }

    #[test]
    fn hundred_percent_loss_is_a_timeout() {
        let out = "1 packets transmitted, 0 received, 100% packet loss, time 0ms\n";
        assert_eq!(parse_ping_output(out, "", Some(1)).outcome, Outcome::Timeout);
    }

    #[test]
    fn unparseable_output_is_an_os_error_not_a_success() {
        let p = parse_ping_output("", "ping: socket: Operation not permitted", Some(2));
        assert_eq!(p.outcome, Outcome::OsError);
        assert!(p.summary.contains("Operation not permitted"));
    }

    #[test]
    fn arg_vector_sends_exactly_one_probe() {
        let t = parse_target("10.10.10.1").unwrap();
        let args = ping_args(&t, 1000);
        assert!(args.contains(&"1".to_string()));
        assert_eq!(args.last().unwrap(), "10.10.10.1");
        // The target is always a single argv element, never spliced.
        assert_eq!(args.iter().filter(|a| a.contains("10.10.10.1")).count(), 1);
    }
}
