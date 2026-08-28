//! Project-scoped probe scheduler.
//!
//! Exactly one session may be active at a time. Starting a session spawns one
//! task per enabled probe; stopping cancels the token, which every task awaits
//! alongside its own sleep, so cancellation is immediate rather than
//! "at the end of the current interval".

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex, Semaphore};
use tokio::task::JoinSet;
use tokio_util::sync::CancellationToken;

use crate::icmp::probe_icmp;
use crate::net::{probe_dns, probe_tcp};
use crate::state::ProbeState;
use crate::types::{HealthStatus, ProbeConfig, ProbeKind, ProbeResult, StatusTransition};

pub const DEFAULT_MAX_CONCURRENCY: usize = 20;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

/// Everything the frontend needs for one probe, in one payload.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ProbeSnapshot {
    pub probe_id: String,
    pub object_kind: crate::types::ObjectKind,
    pub object_id: String,
    pub name: String,
    pub kind: ProbeKind,
    pub target: String,
    pub status: HealthStatus,
    pub last_rtt_ms: Option<f64>,
    pub last_success_ms: Option<i64>,
    pub last_failure_ms: Option<i64>,
    pub last_summary: Option<String>,
    pub consecutive_failures: u32,
    pub failure_threshold: u32,
}

/// Emitted to the UI and to the project event log.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EngineEvent {
    Sample {
        session_id: String,
        result: ProbeResult,
        status: HealthStatus,
    },
    Transition {
        session_id: String,
        transition: StatusTransition,
    },
    SessionState {
        session_id: String,
        project_id: String,
        state: SessionState,
    },
}

struct Session {
    id: String,
    project_id: String,
    token: CancellationToken,
    tasks: JoinSet<()>,
}

pub struct Engine {
    session: Mutex<Option<Session>>,
    /// Probe id -> live state, readable by the UI without touching the tasks.
    pub states: Arc<Mutex<HashMap<String, ProbeState>>>,
    pub configs: Arc<Mutex<HashMap<String, ProbeConfig>>>,
    events: mpsc::UnboundedSender<EngineEvent>,
    max_concurrency: usize,
}

impl Engine {
    pub fn new(max_concurrency: usize) -> (Arc<Self>, mpsc::UnboundedReceiver<EngineEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let engine = Arc::new(Self {
            session: Mutex::new(None),
            states: Arc::new(Mutex::new(HashMap::new())),
            configs: Arc::new(Mutex::new(HashMap::new())),
            events: tx,
            max_concurrency: max_concurrency.clamp(1, 500),
        });
        (engine, rx)
    }

    pub async fn active_project(&self) -> Option<String> {
        self.session.lock().await.as_ref().map(|s| s.project_id.clone())
    }

    pub async fn session_state(&self) -> SessionState {
        if self.session.lock().await.is_some() {
            SessionState::Running
        } else {
            SessionState::Stopped
        }
    }

    /// Start a session for one project. Any prior session is stopped first, so
    /// switching projects can never leave orphaned probes running.
    pub async fn start(
        self: &Arc<Self>,
        session_id: String,
        project_id: String,
        probes: Vec<ProbeConfig>,
    ) -> Result<usize, String> {
        self.stop().await;

        let _ = self.events.send(EngineEvent::SessionState {
            session_id: session_id.clone(),
            project_id: project_id.clone(),
            state: SessionState::Starting,
        });

        let enabled: Vec<ProbeConfig> = probes
            .into_iter()
            .filter(|p| p.enabled && p.project_id == project_id && p.kind != ProbeKind::Manual)
            .collect();

        {
            let mut cfgs = self.configs.lock().await;
            let mut states = self.states.lock().await;
            cfgs.clear();
            states.clear();
            for p in &enabled {
                cfgs.insert(p.id.clone(), p.clone());
                states.insert(p.id.clone(), ProbeState::default());
            }
        }

        let token = CancellationToken::new();
        let semaphore = Arc::new(Semaphore::new(self.max_concurrency));
        let mut tasks = JoinSet::new();

        for (index, cfg) in enabled.iter().cloned().enumerate() {
            let engine = Arc::clone(self);
            let token = token.child_token();
            let semaphore = Arc::clone(&semaphore);
            let session_id = session_id.clone();
            // Deterministic stagger: 100 targets do not fire on the same tick.
            let stagger = Duration::from_millis(((index as u64) * 137) % 3_000);

            tasks.spawn(async move {
                tokio::select! {
                    _ = token.cancelled() => return,
                    _ = tokio::time::sleep(stagger) => {}
                }
                let interval = Duration::from_secs(cfg.interval_seconds.max(1));
                loop {
                    if token.is_cancelled() {
                        return;
                    }
                    let permit = tokio::select! {
                        _ = token.cancelled() => return,
                        p = semaphore.clone().acquire_owned() => match p {
                            Ok(p) => p,
                            Err(_) => return,
                        }
                    };
                    let result = tokio::select! {
                        _ = token.cancelled() => { drop(permit); return; }
                        r = run_once(&cfg) => r,
                    };
                    drop(permit);

                    engine.record(&session_id, &cfg, result).await;

                    tokio::select! {
                        _ = token.cancelled() => return,
                        _ = tokio::time::sleep(interval) => {}
                    }
                }
            });
        }

        let count = enabled.len();
        *self.session.lock().await = Some(Session {
            id: session_id.clone(),
            project_id: project_id.clone(),
            token,
            tasks,
        });

        let _ = self.events.send(EngineEvent::SessionState {
            session_id,
            project_id,
            state: SessionState::Running,
        });
        Ok(count)
    }

    /// Cancel everything and wait, with a bounded timeout so a wedged child
    /// process cannot block application shutdown.
    pub async fn stop(&self) {
        let mut guard = self.session.lock().await;
        let Some(mut session) = guard.take() else {
            return;
        };
        let _ = self.events.send(EngineEvent::SessionState {
            session_id: session.id.clone(),
            project_id: session.project_id.clone(),
            state: SessionState::Stopping,
        });

        session.token.cancel();
        let drain = async {
            while session.tasks.join_next().await.is_some() {}
        };
        if tokio::time::timeout(Duration::from_secs(3), drain).await.is_err() {
            session.tasks.abort_all();
        }

        // Live status is not evidence once probing stops.
        let mut states = self.states.lock().await;
        for state in states.values_mut() {
            if state.status != HealthStatus::Disabled {
                state.status = HealthStatus::Unknown;
            }
        }

        let _ = self.events.send(EngineEvent::SessionState {
            session_id: session.id,
            project_id: session.project_id,
            state: SessionState::Stopped,
        });
    }

    async fn record(&self, session_id: &str, cfg: &ProbeConfig, result: ProbeResult) {
        let mut states = self.states.lock().await;
        let state = states.entry(cfg.id.clone()).or_default();
        let transition = state.apply(cfg, &result);
        let status = state.status;
        drop(states);

        let _ = self.events.send(EngineEvent::Sample {
            session_id: session_id.to_string(),
            result,
            status,
        });
        if let Some(t) = transition {
            let _ = self.events.send(EngineEvent::Transition {
                session_id: session_id.to_string(),
                transition: t,
            });
        }
    }

    pub async fn snapshot(&self) -> Vec<ProbeSnapshot> {
        let configs = self.configs.lock().await;
        let states = self.states.lock().await;
        configs
            .values()
            .map(|c| {
                let s = states.get(&c.id).cloned().unwrap_or_default();
                ProbeSnapshot {
                    probe_id: c.id.clone(),
                    object_kind: c.object_kind,
                    object_id: c.object_id.clone(),
                    name: c.name.clone(),
                    kind: c.kind,
                    target: c.target.clone(),
                    status: s.status,
                    last_rtt_ms: s.last_rtt_ms,
                    last_success_ms: s.last_success_ms,
                    last_failure_ms: s.last_failure_ms,
                    last_summary: s.last_summary.clone(),
                    consecutive_failures: s.consecutive_failures,
                    failure_threshold: c.failure_threshold,
                }
            })
            .collect()
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// One probe attempt. Also used by `Test Now`, which is why it takes no
/// session context — a one-off test must never register a schedule.
pub async fn run_once(cfg: &ProbeConfig) -> ProbeResult {
    let t = now_ms();
    match cfg.kind {
        ProbeKind::Icmp => probe_icmp(&cfg.id, &cfg.target, cfg.timeout_ms, t).await,
        ProbeKind::Tcp => {
            probe_tcp(
                &cfg.id,
                &cfg.target,
                cfg.tcp_port.unwrap_or(0),
                cfg.timeout_ms,
                t,
            )
            .await
        }
        ProbeKind::Dns => probe_dns(&cfg.id, &cfg.target, cfg.timeout_ms, t).await,
        ProbeKind::Manual => ProbeResult {
            probe_id: cfg.id.clone(),
            timestamp_ms: t,
            outcome: crate::types::Outcome::Success,
            rtt_ms: None,
            resolved: vec![],
            summary: "Manual probe — not tested".into(),
            error_message: None,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stop_is_idempotent_and_safe_with_no_session() {
        let (engine, _rx) = Engine::new(DEFAULT_MAX_CONCURRENCY);
        engine.stop().await;
        engine.stop().await;
        assert_eq!(engine.session_state().await, SessionState::Stopped);
    }

    /// Test case 13/14: stopping must end all scheduling for the project.
    #[tokio::test]
    async fn start_then_stop_clears_the_session() {
        let (engine, _rx) = Engine::new(4);
        let mut cfg = ProbeConfig::defaults("p1", "proj", "n1", "127.0.0.1");
        cfg.interval_seconds = 1;
        let started = engine
            .start("s1".into(), "proj".into(), vec![cfg])
            .await
            .unwrap();
        assert_eq!(started, 1);
        assert_eq!(engine.session_state().await, SessionState::Running);
        engine.stop().await;
        assert_eq!(engine.session_state().await, SessionState::Stopped);
        assert_eq!(engine.active_project().await, None);
    }

    /// Probes belonging to another project are never scheduled.
    #[tokio::test]
    async fn only_the_active_project_is_scheduled() {
        let (engine, _rx) = Engine::new(4);
        let mine = ProbeConfig::defaults("p1", "proj-a", "n1", "127.0.0.1");
        let theirs = ProbeConfig::defaults("p2", "proj-b", "n2", "127.0.0.1");
        let started = engine
            .start("s1".into(), "proj-a".into(), vec![mine, theirs])
            .await
            .unwrap();
        assert_eq!(started, 1);
        engine.stop().await;
    }

    #[tokio::test]
    async fn disabled_probes_are_not_scheduled() {
        let (engine, _rx) = Engine::new(4);
        let mut cfg = ProbeConfig::defaults("p1", "proj", "n1", "127.0.0.1");
        cfg.enabled = false;
        let started = engine.start("s1".into(), "proj".into(), vec![cfg]).await.unwrap();
        assert_eq!(started, 0);
        engine.stop().await;
    }

    #[tokio::test]
    async fn starting_a_second_project_stops_the_first() {
        let (engine, _rx) = Engine::new(4);
        let a = ProbeConfig::defaults("p1", "proj-a", "n1", "127.0.0.1");
        let b = ProbeConfig::defaults("p2", "proj-b", "n2", "127.0.0.1");
        engine.start("s1".into(), "proj-a".into(), vec![a]).await.unwrap();
        engine.start("s2".into(), "proj-b".into(), vec![b]).await.unwrap();
        assert_eq!(engine.active_project().await.as_deref(), Some("proj-b"));
        engine.stop().await;
    }

    #[tokio::test]
    async fn invalid_target_fails_closed_without_running_a_process() {
        let mut cfg = ProbeConfig::defaults("p1", "proj", "n1", "10.0.0.1 && calc.exe");
        cfg.timeout_ms = 500;
        let r = run_once(&cfg).await;
        assert_eq!(r.outcome, crate::types::Outcome::InvalidTarget);
    }
}
