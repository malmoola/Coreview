//! Coreview probe engine.
//!
//! Deliberately free of any Tauri dependency: this crate is the security- and
//! correctness-critical core (target validation, process invocation, threshold
//! state machine, scheduler) and can be tested with plain `cargo test`.

pub mod engine;
pub mod icmp;
pub mod net;
pub mod state;
pub mod sweep;
pub mod types;
pub mod validate;

pub use engine::{Engine, EngineEvent, ProbeSnapshot, SessionState, DEFAULT_MAX_CONCURRENCY};
pub use state::ProbeState;
pub use sweep::{parse_cidr, parse_sweepable_cidr, parse_subnets, within_any, Cidr, CidrError, SweepEvent, SweepHit, SweepOptions};
pub use types::{HealthStatus, ObjectKind, Outcome, ProbeConfig, ProbeKind, ProbeResult, StatusTransition};
pub use validate::{parse_target, validate_port, Target, ValidationError};
