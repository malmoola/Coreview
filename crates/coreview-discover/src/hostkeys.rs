//! Remembering which SSH host key belongs to which device.
//!
//! The policy is trust-on-first-use, the same one `ssh` uses: the first time a
//! device is seen its key is recorded, and every time after that the key must
//! match. That is a deliberate trade. Prompting on first contact would be
//! stricter, but a first crawl of two hundred devices would be two hundred
//! dialogs, and a prompt answered two hundred times in a row is not a security
//! control — it is a reflex.
//!
//! What the policy does buy is the case that actually matters. A key that
//! *changes* is either a device that was legitimately rebuilt or someone
//! sitting between you and it, and those are indistinguishable from here, so a
//! change is refused rather than reported. The user can clear the remembered
//! key and reconnect, which is an explicit act rather than a click-through.

use std::collections::BTreeMap;

/// What to do about the key a device just presented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyVerdict {
    /// Never seen. Remember it and carry on.
    New,
    /// Matches what was remembered.
    Known,
    /// Does not match. Connecting anyway would defeat the point of having
    /// remembered it at all.
    Changed { remembered: String },
}

impl HostKeyVerdict {
    pub fn is_acceptable(&self) -> bool {
        matches!(self, HostKeyVerdict::New | HostKeyVerdict::Known)
    }
}

/// Host keys, keyed by the address and port actually connected to.
///
/// Port is part of the identity: two devices behind different forwarded ports
/// on one jump host are different devices, and treating them as one would make
/// every connection look like a key change.
#[derive(Debug, Clone, Default)]
pub struct HostKeyStore {
    keys: BTreeMap<String, String>,
}

/// The identity a key is remembered against. Lower-cased so a host typed two
/// ways is not remembered twice.
pub fn host_id(host: &str, port: u16) -> String {
    format!("{}:{}", host.trim().to_ascii_lowercase(), port)
}

impl HostKeyStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Builds a store from whatever was persisted.
    pub fn from_pairs(pairs: impl IntoIterator<Item = (String, String)>) -> Self {
        Self {
            keys: pairs.into_iter().collect(),
        }
    }

    pub fn check(&self, host: &str, port: u16, fingerprint: &str) -> HostKeyVerdict {
        match self.keys.get(&host_id(host, port)) {
            None => HostKeyVerdict::New,
            Some(known) if known == fingerprint => HostKeyVerdict::Known,
            Some(known) => HostKeyVerdict::Changed {
                remembered: known.clone(),
            },
        }
    }

    /// Records a key. Overwrites, so this must only be called after `check`
    /// returned something acceptable — otherwise it would quietly paper over
    /// the one case the store exists to catch.
    pub fn remember(&mut self, host: &str, port: u16, fingerprint: &str) {
        self.keys
            .insert(host_id(host, port), fingerprint.to_string());
    }

    /// Forgets one device, so the next connection is treated as first contact.
    /// Returns whether anything was actually removed.
    pub fn forget(&mut self, host: &str, port: u16) -> bool {
        self.keys.remove(&host_id(host, port)).is_some()
    }

    /// Forgets everything. Backs the "clear saved host keys" button, for after
    /// a switch replacement or a re-image, when the alternative is hunting
    /// down entries one at a time.
    pub fn clear(&mut self) -> usize {
        let n = self.keys.len();
        self.keys.clear();
        n
    }

    pub fn len(&self) -> usize {
        self.keys.len()
    }

    pub fn is_empty(&self) -> bool {
        self.keys.is_empty()
    }

    /// Everything remembered, for listing in the UI.
    pub fn entries(&self) -> impl Iterator<Item = (&str, &str)> {
        self.keys.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }
}

/// The message shown when a key has changed.
///
/// Deliberately blunt. This is the one moment the store exists for, and a
/// message that reads like a warning to be dismissed is worse than none.
pub fn changed_key_message(host: &str, port: u16, remembered: &str, presented: &str) -> String {
    format!(
        "The SSH host key for {host}:{port} is not the one Coreview remembered.\n\n\
         Remembered: {remembered}\n\
         Presented:  {presented}\n\n\
         This happens when a device is rebuilt or replaced — and it is also what \
         an intercepted connection looks like. Coreview will not connect until you \
         confirm which it is. If the device was genuinely replaced, clear its saved \
         key and connect again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "SHA256:0zaqrPUcHnE0V0z+kM4ZmJmS7nDBn/8P9wYc4bTGf2E";
    const KEY_B: &str = "SHA256:9xyzQQQQQnE0V0z+kM4ZmJmS7nDBn/8P9wYc4bTGf2E";

    #[test]
    fn a_device_never_seen_before_is_new() {
        let store = HostKeyStore::new();
        assert_eq!(store.check("10.1.1.1", 22, KEY_A), HostKeyVerdict::New);
        assert!(store.check("10.1.1.1", 22, KEY_A).is_acceptable());
    }

    #[test]
    fn the_same_key_next_time_is_known() {
        let mut store = HostKeyStore::new();
        store.remember("10.1.1.1", 22, KEY_A);
        assert_eq!(store.check("10.1.1.1", 22, KEY_A), HostKeyVerdict::Known);
    }

    #[test]
    fn a_changed_key_is_refused_and_says_what_it_remembered() {
        // The whole reason the store exists.
        let mut store = HostKeyStore::new();
        store.remember("10.1.1.1", 22, KEY_A);
        let verdict = store.check("10.1.1.1", 22, KEY_B);
        assert_eq!(
            verdict,
            HostKeyVerdict::Changed {
                remembered: KEY_A.into()
            }
        );
        assert!(!verdict.is_acceptable(), "a changed key must not connect");
    }

    #[test]
    fn port_is_part_of_the_identity() {
        // Two devices behind different forwarded ports on one jump host are
        // different devices; merging them would make every connection look
        // like a key change.
        let mut store = HostKeyStore::new();
        store.remember("jump.example.com", 2201, KEY_A);
        assert_eq!(
            store.check("jump.example.com", 2202, KEY_B),
            HostKeyVerdict::New
        );
        assert_eq!(
            store.check("jump.example.com", 2201, KEY_A),
            HostKeyVerdict::Known
        );
    }

    #[test]
    fn a_host_typed_two_ways_is_remembered_once() {
        let mut store = HostKeyStore::new();
        store.remember("SW1.Example.COM", 22, KEY_A);
        assert_eq!(store.check("sw1.example.com", 22, KEY_A), HostKeyVerdict::Known);
        assert_eq!(store.check("  SW1.EXAMPLE.COM  ", 22, KEY_A), HostKeyVerdict::Known);
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn forgetting_one_device_makes_it_first_contact_again() {
        // The recovery path after a switch is genuinely replaced.
        let mut store = HostKeyStore::new();
        store.remember("10.1.1.1", 22, KEY_A);
        store.remember("10.1.1.2", 22, KEY_A);

        assert!(store.forget("10.1.1.1", 22));
        assert_eq!(store.check("10.1.1.1", 22, KEY_B), HostKeyVerdict::New);
        // And it left the other one alone.
        assert_eq!(store.check("10.1.1.2", 22, KEY_A), HostKeyVerdict::Known);
    }

    #[test]
    fn forgetting_something_unknown_reports_that_nothing_happened() {
        let mut store = HostKeyStore::new();
        assert!(!store.forget("10.9.9.9", 22));
    }

    #[test]
    fn clearing_empties_the_store_and_says_how_many_went() {
        // Backs the "clear saved host keys" button; the count is what the
        // confirmation message needs.
        let mut store = HostKeyStore::new();
        store.remember("10.1.1.1", 22, KEY_A);
        store.remember("10.1.1.2", 22, KEY_B);
        assert_eq!(store.clear(), 2);
        assert!(store.is_empty());
        assert_eq!(store.check("10.1.1.1", 22, KEY_B), HostKeyVerdict::New);
        // Clearing an empty store is not an error.
        assert_eq!(store.clear(), 0);
    }

    #[test]
    fn a_store_round_trips_through_persistence() {
        let mut store = HostKeyStore::new();
        store.remember("10.1.1.1", 22, KEY_A);
        store.remember("10.1.1.2", 2222, KEY_B);

        let pairs: Vec<(String, String)> = store
            .entries()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        let restored = HostKeyStore::from_pairs(pairs);

        assert_eq!(restored.check("10.1.1.1", 22, KEY_A), HostKeyVerdict::Known);
        assert_eq!(restored.check("10.1.1.2", 2222, KEY_B), HostKeyVerdict::Known);
        assert_eq!(restored.len(), 2);
    }

    #[test]
    fn the_changed_key_message_shows_both_fingerprints() {
        // Someone has to be able to tell which device this is and compare the
        // key by hand; a message that hides either is useless.
        let msg = changed_key_message("10.1.1.1", 22, KEY_A, KEY_B);
        assert!(msg.contains("10.1.1.1:22"));
        assert!(msg.contains(KEY_A));
        assert!(msg.contains(KEY_B));
        assert!(msg.contains("clear"), "it must point at the way out");
    }
}
