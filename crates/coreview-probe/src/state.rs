//! Threshold state machine. Pure: it takes a config plus a result and returns
//! the next status. No I/O, no clock, no async — so it can be exhaustively
//! tested and reasoned about.

use crate::types::{HealthStatus, ProbeConfig, ProbeResult, StatusTransition};

#[derive(Debug, Clone)]
pub struct ProbeState {
    pub status: HealthStatus,
    pub consecutive_failures: u32,
    pub consecutive_successes: u32,
    pub last_rtt_ms: Option<f64>,
    pub last_success_ms: Option<i64>,
    pub last_failure_ms: Option<i64>,
    pub last_error: Option<String>,
    pub last_summary: Option<String>,
    /// Rolling window of recent RTTs for the inspector sparkline.
    pub recent_rtt: Vec<f64>,
}

impl Default for ProbeState {
    fn default() -> Self {
        Self {
            status: HealthStatus::Unknown,
            consecutive_failures: 0,
            consecutive_successes: 0,
            last_rtt_ms: None,
            last_success_ms: None,
            last_failure_ms: None,
            last_error: None,
            last_summary: None,
            recent_rtt: Vec::new(),
        }
    }
}

const RTT_WINDOW: usize = 60;

impl ProbeState {
    /// Apply one probe result. Returns a transition only when the reported
    /// status actually changed, so the event log records edges, not samples.
    pub fn apply(&mut self, cfg: &ProbeConfig, result: &ProbeResult) -> Option<StatusTransition> {
        let previous = self.status;

        if !cfg.enabled {
            self.status = HealthStatus::Disabled;
            return self.transition(cfg, previous, result, "Probe disabled");
        }

        if result.outcome.is_success() {
            self.consecutive_failures = 0;
            self.consecutive_successes = self.consecutive_successes.saturating_add(1);
            self.last_success_ms = Some(result.timestamp_ms);
            self.last_rtt_ms = result.rtt_ms;
            self.last_error = None;
            if let Some(rtt) = result.rtt_ms {
                self.recent_rtt.push(rtt);
                if self.recent_rtt.len() > RTT_WINDOW {
                    self.recent_rtt.remove(0);
                }
            }

            let over_warning = match (cfg.warning_latency_ms, result.rtt_ms) {
                (Some(limit), Some(rtt)) => rtt > limit as f64,
                _ => false,
            };
            let candidate = if over_warning {
                HealthStatus::Warning
            } else {
                HealthStatus::Healthy
            };

            // Recovering from down requires the configured number of successes.
            let recovered = previous != HealthStatus::Down
                || self.consecutive_successes >= cfg.recovery_threshold.max(1);
            if recovered {
                self.status = candidate;
            }
        } else {
            self.consecutive_successes = 0;
            self.consecutive_failures = self.consecutive_failures.saturating_add(1);
            self.last_failure_ms = Some(result.timestamp_ms);
            self.last_error = result.error_message.clone();

            if self.consecutive_failures >= cfg.failure_threshold.max(1) {
                self.status = HealthStatus::Down;
            } else if previous == HealthStatus::Unknown {
                // Nothing has ever succeeded; stay unknown rather than
                // claiming health we have not observed.
                self.status = HealthStatus::Unknown;
            }
            // Otherwise hold the prior healthy/warning state while the
            // failure count climbs toward the threshold.
        }

        // Maintenance masks the reported status but the counters above still
        // ran, so the underlying observation is preserved for the log.
        if cfg.maintenance {
            self.status = HealthStatus::Maintenance;
        }

        self.last_summary = Some(self.detail_line(cfg, result));
        self.transition(cfg, previous, result, &self.detail_line(cfg, result))
    }

    /// Operator-facing detail, e.g. "Request timed out (failure 1 of 3)".
    pub fn detail_line(&self, cfg: &ProbeConfig, result: &ProbeResult) -> String {
        if result.outcome.is_success() {
            result.summary.clone()
        } else if self.consecutive_failures > 0
            && self.consecutive_failures < cfg.failure_threshold.max(1)
        {
            format!(
                "{} (failure {} of {})",
                result.summary, self.consecutive_failures, cfg.failure_threshold
            )
        } else {
            result.summary.clone()
        }
    }

    fn transition(
        &self,
        cfg: &ProbeConfig,
        previous: HealthStatus,
        result: &ProbeResult,
        message: &str,
    ) -> Option<StatusTransition> {
        if previous == self.status {
            return None;
        }
        Some(StatusTransition {
            probe_id: cfg.id.clone(),
            project_id: cfg.project_id.clone(),
            object_kind: cfg.object_kind,
            object_id: cfg.object_id.clone(),
            timestamp_ms: result.timestamp_ms,
            previous,
            current: self.status,
            message: message.to_string(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Outcome, ProbeResult};

    fn cfg() -> ProbeConfig {
        ProbeConfig::defaults("p1", "proj1", "n1", "10.10.10.1")
    }

    fn ok(t: i64, rtt: f64) -> ProbeResult {
        ProbeResult {
            probe_id: "p1".into(),
            timestamp_ms: t,
            outcome: Outcome::Success,
            rtt_ms: Some(rtt),
            resolved: vec![],
            summary: format!("Reply, {rtt} ms"),
            error_message: None,
        }
    }

    fn fail(t: i64) -> ProbeResult {
        ProbeResult::failed("p1", t, Outcome::Timeout, "Request timed out")
    }

    #[test]
    fn starts_unknown_until_a_result_arrives() {
        let s = ProbeState::default();
        assert_eq!(s.status, HealthStatus::Unknown);
    }

    #[test]
    fn first_success_is_healthy_and_emits_a_transition() {
        let mut s = ProbeState::default();
        let t = s.apply(&cfg(), &ok(1, 2.0)).expect("transition");
        assert_eq!(t.previous, HealthStatus::Unknown);
        assert_eq!(t.current, HealthStatus::Healthy);
    }

    #[test]
    fn repeated_identical_results_do_not_emit_events() {
        let mut s = ProbeState::default();
        s.apply(&cfg(), &ok(1, 2.0));
        assert!(s.apply(&cfg(), &ok(2, 2.0)).is_none());
        assert!(s.apply(&cfg(), &ok(3, 2.0)).is_none());
    }

    /// Test case 10: RTT above the warning threshold reports warning.
    #[test]
    fn high_rtt_becomes_warning() {
        let mut s = ProbeState::default();
        s.apply(&cfg(), &ok(1, 2.0));
        let t = s.apply(&cfg(), &ok(2, 156.0)).expect("transition");
        assert_eq!(t.current, HealthStatus::Warning);
        // and back down again
        let t = s.apply(&cfg(), &ok(3, 4.0)).expect("transition");
        assert_eq!(t.current, HealthStatus::Healthy);
    }

    /// Test case 7: a single failure must not flip a healthy node to down.
    #[test]
    fn holds_prior_state_below_failure_threshold() {
        let mut s = ProbeState::default();
        s.apply(&cfg(), &ok(1, 2.0));
        assert!(s.apply(&cfg(), &fail(2)).is_none());
        assert_eq!(s.status, HealthStatus::Healthy);
        assert!(s.apply(&cfg(), &fail(3)).is_none());
        assert_eq!(s.status, HealthStatus::Healthy);
        let t = s.apply(&cfg(), &fail(4)).expect("third failure trips");
        assert_eq!(t.current, HealthStatus::Down);
    }

    #[test]
    fn detail_line_counts_failures_toward_threshold() {
        let mut s = ProbeState::default();
        s.apply(&cfg(), &ok(1, 2.0));
        s.apply(&cfg(), &fail(2));
        assert_eq!(
            s.last_summary.as_deref(),
            Some("Request timed out (failure 1 of 3)")
        );
    }

    #[test]
    fn never_claims_health_it_has_not_observed() {
        let mut s = ProbeState::default();
        s.apply(&cfg(), &fail(1));
        assert_eq!(s.status, HealthStatus::Unknown);
        s.apply(&cfg(), &fail(2));
        assert_eq!(s.status, HealthStatus::Unknown);
        s.apply(&cfg(), &fail(3));
        assert_eq!(s.status, HealthStatus::Down);
    }

    #[test]
    fn recovery_threshold_is_enforced() {
        let mut c = cfg();
        c.recovery_threshold = 2;
        let mut s = ProbeState::default();
        for i in 1..=3 {
            s.apply(&c, &fail(i));
        }
        assert_eq!(s.status, HealthStatus::Down);
        assert!(s.apply(&c, &ok(4, 2.0)).is_none());
        assert_eq!(s.status, HealthStatus::Down, "one success is not enough");
        let t = s.apply(&c, &ok(5, 2.0)).expect("second success recovers");
        assert_eq!(t.current, HealthStatus::Healthy);
    }

    #[test]
    fn failure_threshold_of_one_trips_immediately() {
        let mut c = cfg();
        c.failure_threshold = 1;
        let mut s = ProbeState::default();
        s.apply(&c, &ok(1, 2.0));
        let t = s.apply(&c, &fail(2)).expect("transition");
        assert_eq!(t.current, HealthStatus::Down);
    }

    #[test]
    fn maintenance_masks_status_but_keeps_observations() {
        let mut c = cfg();
        c.maintenance = true;
        let mut s = ProbeState::default();
        s.apply(&c, &fail(1));
        assert_eq!(s.status, HealthStatus::Maintenance);
        assert_eq!(s.consecutive_failures, 1);
        assert_eq!(s.last_failure_ms, Some(1));
    }

    #[test]
    fn disabled_probe_reports_disabled() {
        let mut c = cfg();
        c.enabled = false;
        let mut s = ProbeState::default();
        s.apply(&c, &ok(1, 2.0));
        assert_eq!(s.status, HealthStatus::Disabled);
    }
}
