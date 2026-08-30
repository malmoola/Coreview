//! Where each MAC was learned, from `show mac address-table`.
//!
//! Discovery protocols only see devices that speak them. A printer, a camera
//! or a workstation announces nothing, and on a real diagram those are most of
//! what is plugged in. The switch knows they are there: it learned their MAC
//! on a port, and its ARP table maps that MAC to an address.
//!
//! This is observation, not inference. "This MAC was seen on Gi0/7" is a fact
//! the switch reports; what the device *is* stays unknown, and the OUI lookup
//! names its maker rather than guessing a role.
//!
//! The fixture below is verbatim from a Catalyst 2960CX.

use crate::arp::normalise_mac;

/// One learned address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MacEntry {
    /// Twelve lowercase hex digits.
    pub mac: String,
    /// The port it was learned on, as the switch writes it.
    pub port: String,
    pub vlan: Option<String>,
}

/// Ports that are not a physical interface, and entries that are not a device.
fn is_real_port(port: &str) -> bool {
    let p = port.trim();
    !p.is_empty()
        && !p.eq_ignore_ascii_case("CPU")
        && !p.eq_ignore_ascii_case("Switch")
        && !p.eq_ignore_ascii_case("Router")
        && !p.eq_ignore_ascii_case("n/a")
        && !p.starts_with("Drop")
}

/// Reads `show mac address-table`, keeping only dynamically learned entries.
///
/// Static entries are the switch's own multicast and protocol addresses —
/// 0180.c200.0000 and friends, all pointing at the CPU — and are not devices
/// on a diagram.
pub fn parse_mac_table(out: &str) -> Vec<MacEntry> {
    let mut found = Vec::new();
    for line in out.lines() {
        let upper = line.to_ascii_uppercase();
        if !upper.contains("DYNAMIC") {
            continue;
        }
        let tokens: Vec<&str> = line.split_whitespace().collect();
        // Column order differs between platforms, so each field is found by
        // what it looks like rather than by position.
        let mac = tokens.iter().find_map(|t| normalise_mac(t));
        let Some(mac) = mac else { continue };
        // The port is the last token that is not the type word.
        let port = tokens
            .iter()
            .rev()
            .find(|t| !t.eq_ignore_ascii_case("DYNAMIC"))
            .map(|t| t.trim().to_string());
        let Some(port) = port.filter(|p| is_real_port(p) && normalise_mac(p).is_none()) else {
            continue;
        };
        let vlan = tokens
            .first()
            .filter(|t| t.chars().all(|c| c.is_ascii_digit()))
            .map(|t| t.to_string());
        found.push(MacEntry { mac, port, vlan });
    }
    found
}

/// How many distinct MACs each port has learned.
///
/// A port with one is something plugged in. A port with twenty is a link to
/// another switch, whether or not that switch runs a discovery protocol.
pub fn count_by_port(entries: &[MacEntry]) -> std::collections::HashMap<String, usize> {
    let mut counts: std::collections::HashMap<String, std::collections::HashSet<&str>> =
        Default::default();
    for e in entries {
        counts.entry(e.port.clone()).or_default().insert(&e.mac);
    }
    counts.into_iter().map(|(k, v)| (k, v.len())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from a Catalyst 2960CX, trimmed to the interesting rows.
    const IOS: &str = r#"
          Mac Address Table
-------------------------------------------

Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
 All    0100.0ccc.cccc    STATIC      CPU
 All    0180.c200.0000    STATIC      CPU
   1    000c.2923.0b29    DYNAMIC     Gi0/9
   1    7456.3c75.fcae    DYNAMIC     Gi0/7
   1    74ac.b9ec.c4a8    DYNAMIC     Gi0/1
   1    e81c.bac4.964b    DYNAMIC     Gi0/9
  14    04f7.7829.d450    DYNAMIC     Gi0/1
Total Mac Addresses for this criterion: 7
"#;

    #[test]
    fn keeps_only_what_was_actually_learned() {
        let e = parse_mac_table(IOS);
        assert_eq!(e.len(), 5, "{e:?}");
        // The switch's own protocol addresses point at the CPU and are not
        // devices on anyone's diagram.
        assert!(!e.iter().any(|x| x.port.eq_ignore_ascii_case("CPU")));
        assert!(!e.iter().any(|x| x.mac.starts_with("0180c2")));
    }

    #[test]
    fn finds_the_port_a_silent_device_is_on() {
        // 7456.3c75.fcae is the workstation the switch sees on Gi0/7 and that
        // announces nothing about itself.
        let e = parse_mac_table(IOS);
        let w = e.iter().find(|x| x.mac == "74563c75fcae").expect("the workstation");
        assert_eq!(w.port, "Gi0/7");
        assert_eq!(w.vlan.as_deref(), Some("1"));
    }

    #[test]
    fn counts_what_is_behind_each_port() {
        // Gi0/9 has two, which is how an uplink looks even when the switch on
        // the far end says nothing.
        let counts = count_by_port(&parse_mac_table(IOS));
        assert_eq!(counts.get("Gi0/9"), Some(&2));
        assert_eq!(counts.get("Gi0/7"), Some(&1));
        assert_eq!(counts.get("Gi0/1"), Some(&2));
    }

    #[test]
    fn a_header_or_an_empty_table_yields_nothing() {
        assert!(parse_mac_table("Vlan    Mac Address       Type        Ports").is_empty());
        assert!(parse_mac_table("").is_empty());
        // A table with only static entries is not a table of devices.
        assert!(parse_mac_table(" All    0100.0ccc.cccc    STATIC      CPU").is_empty());
    }
}
