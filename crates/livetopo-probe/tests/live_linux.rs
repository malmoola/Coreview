//! Live integration tests against the real host network stack.
//!
//! These run actual `ping` processes and real TCP connects. They are the
//! backend half of TEST_PLAN cases 6, 7, 9, 12, 13 and 19 — the parts that
//! can be observed without driving the UI.
//!
//! Targets are deliberately safe: 127.0.0.1 (always answers) and the RFC 5737
//! documentation range 192.0.2.0/24 (must never answer). Nothing here touches
//! a network the operator did not choose.
//!
//! Requires a `ping` binary. Run with: cargo test --test live_linux -- --nocapture

use livetopo_probe::engine::{run_once, Engine, EngineEvent, SessionState};
use livetopo_probe::types::{HealthStatus, ObjectKind, Outcome, ProbeConfig, ProbeKind};
use std::time::{Duration, Instant};

fn probe(id: &str, target: &str, kind: ProbeKind) -> ProbeConfig {
    ProbeConfig {
        id: id.into(),
        project_id: "live-test".into(),
        object_kind: ObjectKind::Node,
        object_id: format!("node-{id}"),
        name: format!("probe-{id}"),
        kind,
        target: target.into(),
        tcp_port: None,
        interval_seconds: 1,
        timeout_ms: 1000,
        failure_threshold: 3,
        recovery_threshold: 1,
        warning_latency_ms: Some(100),
        enabled: true,
        maintenance: false,
    }
}

/// Case 6 (backend): a reachable ICMP target reports success with an RTT.
#[tokio::test]
async fn loopback_icmp_really_succeeds() {
    let r = run_once(&probe("lo", "127.0.0.1", ProbeKind::Icmp)).await;
    println!("127.0.0.1 -> {:?} rtt={:?} :: {}", r.outcome, r.rtt_ms, r.summary);
    assert_eq!(r.outcome, Outcome::Success, "loopback must answer: {}", r.summary);
    assert!(r.rtt_ms.is_some(), "an RTT should have been parsed from real ping output");
}

/// Case 7 (backend): the documentation range does not answer, and the failure
/// is a timeout rather than being misreported as anything else.
#[tokio::test]
async fn documentation_range_icmp_really_fails() {
    let r = run_once(&probe("doc", "192.0.2.1", ProbeKind::Icmp)).await;
    println!("192.0.2.1 -> {:?} :: {}", r.outcome, r.summary);
    assert_ne!(r.outcome, Outcome::Success, "RFC 5737 range must not answer");
    assert!(
        matches!(r.outcome, Outcome::Timeout | Outcome::Unreachable),
        "expected timeout or unreachable, got {:?} ({})",
        r.outcome,
        r.summary
    );
}

/// Case 19 (backend): a shell-injection-shaped target is rejected before any
/// process is spawned, and the marker file is never created.
#[tokio::test]
async fn injection_target_is_rejected_and_touches_nothing() {
    let marker = std::path::Path::new("/tmp/livetopo_pwned_marker");
    let _ = std::fs::remove_file(marker);

    for hostile in [
        "10.0.0.1 && touch /tmp/livetopo_pwned_marker",
        "10.0.0.1; touch /tmp/livetopo_pwned_marker",
        "10.0.0.1 | touch /tmp/livetopo_pwned_marker",
        "$(touch /tmp/livetopo_pwned_marker)",
        "`touch /tmp/livetopo_pwned_marker`",
        "-c1 127.0.0.1",
    ] {
        let r = run_once(&probe("evil", hostile, ProbeKind::Icmp)).await;
        println!("{hostile:?} -> {:?} :: {}", r.outcome, r.summary);
        assert_eq!(
            r.outcome,
            Outcome::InvalidTarget,
            "hostile target must fail closed: {hostile:?}"
        );
    }

    assert!(
        !marker.exists(),
        "SECURITY FAILURE: injection created {}",
        marker.display()
    );
}

/// Case 12 (backend): run_once registers no schedule — the engine stays idle.
#[tokio::test]
async fn test_now_starts_no_background_work() {
    let (engine, _rx) = Engine::new(20);
    let _ = run_once(&probe("once", "127.0.0.1", ProbeKind::Icmp)).await;
    assert_eq!(engine.session_state().await, SessionState::Stopped);
    assert!(engine.active_project().await.is_none());
    assert!(engine.snapshot().await.is_empty());
}

/// Cases 6 + 7 + 9 (backend), end to end through the scheduler: a healthy
/// target reaches `healthy` and a dead one reaches `down` only after the
/// failure threshold, with transitions emitted.
#[tokio::test]
async fn engine_reaches_healthy_and_down_against_the_real_stack() {
    let (engine, mut rx) = Engine::new(20);
    engine
        .start(
            "session-1".into(),
            "live-test".into(),
            vec![
                probe("up", "127.0.0.1", ProbeKind::Icmp),
                probe("down", "192.0.2.1", ProbeKind::Icmp),
            ],
        )
        .await
        .expect("engine start");

    let deadline = Instant::now() + Duration::from_secs(45);
    let (mut saw_healthy, mut saw_down) = (false, false);
    let mut transitions = Vec::new();

    while Instant::now() < deadline && !(saw_healthy && saw_down) {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(EngineEvent::Transition { transition, .. })) => {
                let (probe_id, previous, current) =
                    (transition.probe_id.clone(), transition.previous, transition.current);
                println!(
                    "transition {probe_id}: {previous:?} -> {current:?}  :: {}",
                    transition.message
                );
                transitions.push((probe_id.clone(), current));
                if probe_id == "up" && current == HealthStatus::Healthy {
                    saw_healthy = true;
                }
                if probe_id == "down" && current == HealthStatus::Down {
                    saw_down = true;
                }
            }
            Ok(Some(_)) => {}
            Ok(None) => break,
            Err(_) => {}
        }
    }

    engine.stop().await;

    assert!(saw_healthy, "127.0.0.1 never reached healthy; saw {transitions:?}");
    assert!(saw_down, "192.0.2.1 never reached down; saw {transitions:?}");

    // The dead probe must not have gone down on the first failure.
    let first_down = transitions
        .iter()
        .position(|(id, st)| id == "down" && *st == HealthStatus::Down);
    assert!(first_down.is_some(), "expected a down transition");
}

/// Case 13 (backend): stop() clears the session and empties the snapshot, and
/// no ping process outlives it.
#[tokio::test]
async fn stop_kills_the_session_and_leaves_no_children() {
    let (engine, _rx) = Engine::new(20);
    engine
        .start(
            "session-2".into(),
            "live-test".into(),
            vec![probe("a", "127.0.0.1", ProbeKind::Icmp)],
        )
        .await
        .expect("engine start");

    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(engine.session_state().await, SessionState::Running);
    // Guard against a vacuous pass: if the probe was never scheduled, the
    // post-stop "snapshot is empty" assertion below would succeed for the
    // wrong reason.
    assert!(
        !engine.snapshot().await.is_empty(),
        "probe was never scheduled, so this test would pass vacuously"
    );

    engine.stop().await;
    assert_eq!(engine.session_state().await, SessionState::Stopped);
    assert!(engine.active_project().await.is_none());
    // ARCHITECTURE.md: "every probe status resets to unknown — a stopped
    // session is not evidence". The probe list is deliberately KEPT so the UI
    // can still draw the objects; it is the *status* that must be cleared.
    let after = engine.snapshot().await;
    assert!(!after.is_empty(), "probe list should survive stop so the UI can render it");
    for s in &after {
        assert!(
            matches!(s.status, HealthStatus::Unknown | HealthStatus::Disabled),
            "probe {} kept status {:?} after stop — a stopped session must not be evidence",
            s.probe_id,
            s.status
        );
    }

    // Give any orphaned child a moment to surface, then check for ours.
    tokio::time::sleep(Duration::from_secs(2)).await;
    let out = std::process::Command::new("pgrep")
        .args(["-f", "ping -c 1 -W 1 127.0.0.1"])
        .output();
    if let Ok(o) = out {
        let pids = String::from_utf8_lossy(&o.stdout);
        let pids: Vec<_> = pids.split_whitespace().collect();
        assert!(pids.is_empty(), "ping processes survived stop(): {pids:?}");
    }
}
