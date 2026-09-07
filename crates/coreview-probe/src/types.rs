use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum HealthStatus {
    Unknown,
    Healthy,
    Warning,
    Down,
    Disabled,
    Maintenance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeKind {
    Icmp,
    Tcp,
    Dns,
    Http,
    Https,
    Manual,
}

/// Owner of a probe. Probes are always scoped to one project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ObjectKind {
    Node,
    Link,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProbeConfig {
    pub id: String,
    pub project_id: String,
    pub object_kind: ObjectKind,
    pub object_id: String,
    pub name: String,
    pub kind: ProbeKind,
    pub target: String,
    pub tcp_port: Option<u32>,
    pub interval_seconds: u64,
    pub timeout_ms: u64,
    pub failure_threshold: u32,
    pub recovery_threshold: u32,
    pub warning_latency_ms: Option<u64>,
    pub enabled: bool,
    /// Suppresses status reporting without deleting configuration.
    #[serde(default)]
    pub maintenance: bool,
    /// Request path for `Http`/`Https`, e.g. `/health`. `None` sends `/`.
    #[serde(default)]
    pub http_path: Option<String>,
    /// `Https` only: skip certificate validation. For a backup site on an
    /// internal CA or a self-signed endpoint, where the thing worth proving
    /// during a failover drill is "the application answers", not "the
    /// certificate chains to a public root".
    #[serde(default)]
    pub ignore_cert_errors: bool,
    /// `Dns` only: the address a name is expected to resolve to. `None` keeps
    /// the original behaviour (healthy if anything resolves). Set, a
    /// resolution that does not include this address is reported as
    /// `AddressMismatch` rather than `Success` — the way to prove a
    /// GSLB/DNS-based failover actually moved a name to the backup site.
    #[serde(default)]
    pub expected_address: Option<String>,
    /// `Http`/`Https` only: text the response must contain. `None` keeps
    /// the original behaviour (healthy on status code alone). Set, a
    /// healthy status whose body does not contain this text is reported as
    /// `BodyMismatch` — the way to catch a maintenance page or a default
    /// web-server page answering in place of the real application.
    #[serde(default)]
    pub expected_body: Option<String>,
}

impl ProbeConfig {
    pub fn defaults(id: &str, project_id: &str, object_id: &str, target: &str) -> Self {
        Self {
            id: id.to_string(),
            project_id: project_id.to_string(),
            object_kind: ObjectKind::Node,
            object_id: object_id.to_string(),
            name: "Primary".into(),
            kind: ProbeKind::Icmp,
            target: target.to_string(),
            tcp_port: None,
            interval_seconds: 5,
            timeout_ms: 1000,
            failure_threshold: 3,
            recovery_threshold: 1,
            warning_latency_ms: Some(100),
            enabled: true,
            maintenance: false,
            http_path: None,
            ignore_cert_errors: false,
            expected_address: None,
            expected_body: None,
        }
    }
}

/// Why a probe attempt ended the way it did. Kept distinct so the UI can show
/// the real reason instead of collapsing everything into "down".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Success,
    Timeout,
    Unreachable,
    Refused,
    DnsFailure,
    NoAnswer,
    OsError,
    InvalidTarget,
    /// Connected and got a response, but the HTTP status was outside 2xx/3xx.
    HttpError,
    /// TLS handshake or certificate validation failed (`Https`, unless
    /// `ignore_cert_errors` is set).
    CertificateError,
    /// `Dns` with `expected_address` set: resolution succeeded, but not to
    /// the expected address.
    AddressMismatch,
    /// `Http`/`Https` with `expected_body` set: a healthy status came back,
    /// but the expected text was not in the response.
    BodyMismatch,
}

impl Outcome {
    pub fn is_success(self) -> bool {
        matches!(self, Outcome::Success)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProbeResult {
    pub probe_id: String,
    /// Unix epoch milliseconds.
    pub timestamp_ms: i64,
    pub outcome: Outcome,
    pub rtt_ms: Option<f64>,
    /// Addresses returned by a DNS probe.
    #[serde(default)]
    pub resolved: Vec<String>,
    /// Operator-facing one-line description, e.g. "Reply, 2 ms" or
    /// "Request timed out".
    pub summary: String,
    pub error_message: Option<String>,
}

impl ProbeResult {
    pub fn failed(probe_id: &str, timestamp_ms: i64, outcome: Outcome, message: &str) -> Self {
        Self {
            probe_id: probe_id.to_string(),
            timestamp_ms,
            outcome,
            rtt_ms: None,
            resolved: Vec::new(),
            summary: message.to_string(),
            error_message: Some(message.to_string()),
        }
    }
}

/// A status transition worth writing to the event log.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StatusTransition {
    pub probe_id: String,
    pub project_id: String,
    pub object_kind: ObjectKind,
    pub object_id: String,
    pub timestamp_ms: i64,
    pub previous: HealthStatus,
    pub current: HealthStatus,
    pub message: String,
}
