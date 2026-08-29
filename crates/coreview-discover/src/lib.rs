//! Device discovery and configuration backup.
//!
//! Deliberately free of any Tauri dependency, for the same reason
//! `coreview-probe` is: everything security-critical here — credential
//! handling, command construction, the parsers that decide what to connect to
//! next — is testable with plain `cargo test` and none of the GTK/WebKit stack.
//!
//! The shape of a discovery run is deliberately three separate steps rather
//! than one:
//!
//!   1. **Discover.** Sweep and crawl, collecting everything reachable.
//!   2. **Filter.** Choose what you actually want out of it, by subnet,
//!      device class, name or address.
//!   3. **Build.** Turn what survived into a topology.
//!
//! Keeping them apart is what makes discovery on a real network usable: the
//! first step finds four hundred phones whether you want them or not, and the
//! decision about what to draw should not be buried inside the crawl.

pub mod backup;
pub mod capture;
pub mod cdp;
pub mod cli;
pub mod crawl;
pub mod classify;
pub mod filter;
pub mod hostkeys;
pub mod interfaces;
pub mod snmp;
pub mod ssh;
pub mod lldp;
pub mod types;
pub mod vault;

pub use backup::{backup_path, is_inside, safe_component, BackupKind, BackupPathError};
pub use capture::{count_changes, diff, list_captures, run_backups, BackupEvent, BackupOptions, BackupTarget, DiffLine};
pub use cli::{extract_output, find_prompt, looks_like_config, Prompt};
pub use crawl::{crawl, CrawlEvent, CrawlOptions, CrawlResult, CrawledDevice};
pub use interfaces::{addresses_from, parse_ip_interface_brief, Interface};
pub use hostkeys::{changed_key_message, HostKeyStore, HostKeyVerdict};
pub use snmp::{identify, AuthKind, PrivKind, SnmpAuth, SnmpIdentity};
pub use ssh::{Credentials, Device, Secret, SshError, SshOptions, SshProgress};
pub use cdp::{parse_cdp_detail, short_name};
pub use classify::classify;
pub use filter::{count_by_class, DiscoveryFilter};
pub use lldp::parse_lldp_detail;
pub use types::{AddressPreference, DeviceAddress, DeviceClass, Neighbor, Protocol};
pub use vault::{create, open, seal, unlock, SealedSecret, VaultError, VaultHeader, VaultKey};
