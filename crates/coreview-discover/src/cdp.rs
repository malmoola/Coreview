//! Parser for `show cdp neighbors detail`.
//!
//! The Python crawler this replaces leans on Cisco's `genie` parser, which is
//! not available here, so the format is parsed directly. That is tractable
//! because the output is regular, but it is not uniform: IOS, IOS XE and NX-OS
//! disagree about spacing, about whether the addresses block is called "Entry
//! address(es)" or "Interface address(es)", and about whether a device ID
//! carries a serial number in brackets.
//!
//! The rule followed throughout is to be liberal about layout and strict about
//! content. A missing field yields `None` and the neighbour is still reported,
//! because a neighbour with no advertised address is still a real adjacency
//! worth drawing — it just cannot be crawled into.

use std::collections::BTreeSet;

use crate::classify::classify;
use crate::types::{DeviceAddress, Neighbor, Protocol};

/// Reduces a CDP device ID to a diagram label.
///
/// CDP reports whatever the neighbour calls itself, which may be a bare
/// hostname, an FQDN, or a hostname with a serial number in brackets, and the
/// same device can appear in different forms from different neighbours. Both
/// forms have to reduce to the same label or the topology grows duplicates.
pub fn short_name(device_id: &str) -> String {
    let id = device_id.trim();
    // NX-OS: "N9K-2(FDO12345678)" — the serial is not part of the name.
    let id = match id.split_once('(') {
        Some((name, rest)) if rest.ends_with(')') => name.trim(),
        _ => id,
    };
    // An FQDN reduces to its first label. An IPv4 address must not: every
    // octet is a "label", and 10.1.1.1 would collapse to "10".
    if id.parse::<std::net::Ipv4Addr>().is_ok() {
        return id.to_string();
    }
    match id.split_once('.') {
        Some((first, _)) if !first.is_empty() => first.to_string(),
        _ => id.to_string(),
    }
}

/// Splits the output into per-neighbour blocks and parses each.
///
/// Never fails: unparseable text yields no neighbours rather than an error,
/// because the alternative is a crawl that aborts on one odd platform.
pub fn parse_cdp_detail(output: &str) -> Vec<Neighbor> {
    let mut out = Vec::new();
    for block in split_entries(output) {
        if let Some(n) = parse_entry(&block) {
            out.push(n);
        }
    }
    out
}

/// Entries are separated by a run of dashes. The trailing "Total cdp entries
/// displayed" line is not part of any entry.
fn split_entries(output: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut current = String::new();
    for line in output.lines() {
        let t = line.trim();
        if t.len() >= 4 && t.chars().all(|c| c == '-') {
            if !current.trim().is_empty() {
                blocks.push(std::mem::take(&mut current));
            }
            continue;
        }
        if t.to_ascii_lowercase().starts_with("total cdp entries") {
            continue;
        }
        current.push_str(line);
        current.push('\n');
    }
    if !current.trim().is_empty() {
        blocks.push(current);
    }
    blocks
}

/// Matches `Label: value` allowing the colon to be spaced away from the label,
/// which IOS does for `Version :` and `Holdtime : `.
fn field<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let rest = trimmed.get(..label.len())?;
    if !rest.eq_ignore_ascii_case(label) {
        return None;
    }
    let after = trimmed[label.len()..].trim_start();
    after.strip_prefix(':').map(|v| v.trim())
}

fn parse_entry(block: &str) -> Option<Neighbor> {
    let mut device_id = String::new();
    let mut short = String::new();
    let mut local_interface = None;
    let mut remote_interface = None;
    let mut platform: Option<String> = None;
    let mut capabilities: Vec<String> = Vec::new();
    let mut version: Option<String> = None;
    let mut addresses: Vec<DeviceAddress> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut in_version = false;
    // Everything after the "Management address(es)" heading is exactly that,
    // which is what an AddressPreference::Management needs to find.
    let mut in_management = false;

    for line in block.lines() {
        // The version banner runs until the next recognised field, so it is
        // handled before anything else can claim these lines.
        if in_version {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            if field(line, "advertisement version").is_some()
                || field(line, "Duplex").is_some()
                || field(line, "Native VLAN").is_some()
                || field(line, "Management address(es)").is_some()
                || field(line, "Protocol Hello").is_some()
            {
                in_version = false;
            } else {
                if version.is_none() {
                    version = Some(t.to_string());
                }
                continue;
            }
        }

        if let Some(v) = field(line, "Device ID") {
            device_id = v.to_string();
            short = short_name(v);
        } else if let Some(v) = field(line, "System Name") {
            // NX-OS gives a clean name alongside the serial-bearing device ID.
            if !v.is_empty() {
                short = short_name(v);
            }
        } else if let Some(v) = field(line, "Platform") {
            // "cisco WS-C2960-24TT-L,  Capabilities: Switch IGMP"
            let (platform_raw, caps) = match v.split_once(',') {
                Some((p, rest)) => (p, field(rest, "Capabilities").unwrap_or("")),
                None => (v, ""),
            };
            let platform_str = platform_raw.trim().trim_start_matches("cisco ").trim();
            if !platform_str.is_empty() {
                platform = Some(platform_str.to_string());
            }
            capabilities = caps.split_whitespace().map(str::to_string).collect();
        } else if let Some(v) = field(line, "Interface") {
            // "GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/2"
            let (local, remote) = match v.split_once(',') {
                Some((l, rest)) => (l.trim(), port_id(rest)),
                None => (v.trim(), None),
            };
            if !local.is_empty() {
                local_interface = Some(local.to_string());
            }
            remote_interface = remote;
        } else if field(line, "Version").is_some() {
            in_version = true;
        } else if field(line, "Management address(es)").is_some() {
            in_management = true;
        } else if field(line, "Entry address(es)").is_some()
            || field(line, "Interface address(es)").is_some()
        {
            in_management = false;
        } else if let Some(v) = ip_line(line) {
            if seen.insert(v.clone()) {
                addresses.push(if in_management {
                    DeviceAddress::management(v)
                } else {
                    DeviceAddress::new(v)
                });
            } else if in_management {
                // Already seen as an entry address; the management heading
                // upgrades it rather than adding a duplicate.
                if let Some(a) = addresses.iter_mut().find(|a| a.ip == v) {
                    a.is_management = true;
                }
            }
        }
    }

    if device_id.is_empty() {
        return None;
    }
    let class = classify(platform.as_deref(), &capabilities, version.as_deref());
    Some(Neighbor {
        device_id,
        short_name: short,
        addresses,
        local_interface,
        remote_interface,
        platform,
        capabilities,
        version,
        class,
        discovered_by: Protocol::Cdp,
            chassis_id: None,
            vendor: None,
    })
}

/// "Port ID (outgoing port): GigabitEthernet0/2", with the label varying in
/// spacing and, on some platforms, lacking the bracketed aside. The value is
/// whatever follows the first colon after the label, so the bracketed part is
/// skipped without having to match it.
fn port_id(rest: &str) -> Option<String> {
    let at = rest.to_ascii_lowercase().find("port id")?;
    let after = &rest[at + "port id".len()..];
    let (_, value) = after.split_once(':')?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

/// An address line inside an "Entry address(es)" or "Interface address(es)"
/// block. IOS writes "IP address: 10.1.1.2"; NX-OS writes "IPv4 Address:".
/// Only IPv4 is taken — the crawler filters by IPv4 subnet, and an IPv6
/// management address it cannot filter would be worse than none.
fn ip_line(line: &str) -> Option<String> {
    let t = line.trim();
    let lower = t.to_ascii_lowercase();
    if !(lower.starts_with("ip address") || lower.starts_with("ipv4 address")) {
        return None;
    }
    let (_, value) = t.split_once(':')?;
    let value = value.trim();
    value.parse::<std::net::Ipv4Addr>().ok().map(|v| v.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Classic IOS, two neighbours: a switch and an access point.
    const IOS: &str = r#"
-------------------------
Device ID: SW2.lab.example.com
Entry address(es):
  IP address: 10.1.1.2
Platform: cisco WS-C2960-24TT-L,  Capabilities: Switch IGMP
Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/2
Holdtime : 137 sec

Version :
Cisco IOS Software, C2960 Software (C2960-LANBASEK9-M), Version 15.0(2)SE4, RELEASE SOFTWARE (fc1)
Technical Support: http://www.cisco.com/techsupport
Copyright (c) 1986-2013 by Cisco Systems, Inc.

advertisement version: 2
Duplex: full

-------------------------
Device ID: AP-FLOOR2
Entry address(es):
  IP address: 10.1.9.55
Platform: cisco AIR-CAP2702I-E-K9,  Capabilities: Trans-Bridge
Interface: GigabitEthernet0/5,  Port ID (outgoing port): GigabitEthernet0
Holdtime : 155 sec

Version :
Cisco IOS Software, C2700 Software

advertisement version: 2

Total cdp entries displayed : 2
"#;

    /// NX-OS: different block separator, "System Name", a serial in the device
    /// ID, "Interface address(es)" and "IPv4 Address".
    const NXOS: &str = r#"
----------------------------------------
Device ID:N9K-SPINE-1(FDO21120U3F)
System Name: N9K-SPINE-1

Interface address(es):
    IPv4 Address: 10.2.2.2
Platform: N9K-C93180YC-EX, Capabilities: Router Switch IGMP Filtering Supports-STP-Dispute
Interface: Ethernet1/1, Port ID (outgoing port): Ethernet1/2
Holdtime: 165 sec

Version:
Cisco Nexus Operating System (NX-OS) Software, Version 9.3(3)

Advertisement Version: 2
"#;

    #[test]
    fn parses_an_ios_switch_neighbour() {
        let n = &parse_cdp_detail(IOS)[0];
        assert_eq!(n.device_id, "SW2.lab.example.com");
        assert_eq!(n.short_name, "SW2");
        assert_eq!(n.address(), Some("10.1.1.2"));
        assert_eq!(n.local_interface.as_deref(), Some("GigabitEthernet0/1"));
        assert_eq!(n.remote_interface.as_deref(), Some("GigabitEthernet0/2"));
        assert_eq!(n.platform.as_deref(), Some("WS-C2960-24TT-L"));
        assert_eq!(n.capabilities, vec!["Switch", "IGMP"]);
        assert_eq!(n.class, crate::types::DeviceClass::Switch);
        assert_eq!(n.discovered_by, crate::types::Protocol::Cdp);
        assert!(n.version.as_deref().unwrap().starts_with("Cisco IOS Software"));
    }

    #[test]
    fn finds_every_entry_and_drops_the_totals_line() {
        let all = parse_cdp_detail(IOS);
        assert_eq!(all.len(), 2, "totals line must not become a third entry");
        assert_eq!(all[1].device_id, "AP-FLOOR2");
    }

    #[test]
    fn an_access_point_is_not_infrastructure() {
        let all = parse_cdp_detail(IOS);
        assert!(all[0].class.is_infrastructure(), "a switch should be crawled");
        // The Python original filtered these out by platform so the crawl did
        // not walk into APs and phones.
        assert!(!all[1].class.is_infrastructure(), "an AIR- access point should not be");
    }

    #[test]
    fn parses_nxos_with_its_different_labels() {
        let n = &parse_cdp_detail(NXOS)[0];
        // The serial in brackets is not part of the name.
        assert_eq!(n.device_id, "N9K-SPINE-1(FDO21120U3F)");
        assert_eq!(n.short_name, "N9K-SPINE-1");
        assert_eq!(n.address(), Some("10.2.2.2"));
        assert_eq!(n.local_interface.as_deref(), Some("Ethernet1/1"));
        assert_eq!(n.remote_interface.as_deref(), Some("Ethernet1/2"));
        assert_eq!(n.platform.as_deref(), Some("N9K-C93180YC-EX"));
        assert!(n.class.is_infrastructure());
    }

    #[test]
    fn the_version_banner_stops_at_the_next_field() {
        // Left unbounded, the banner swallows "advertisement version" and
        // everything after it.
        let n = &parse_cdp_detail(IOS)[0];
        let v = n.version.as_deref().unwrap();
        assert!(!v.contains("advertisement"), "banner leaked: {v}");
        assert!(!v.contains("Copyright"), "banner should be its first line only");
    }

    #[test]
    fn short_name_collapses_the_forms_of_one_device() {
        // The same device seen from two neighbours must reduce to one label,
        // or the topology grows duplicates.
        assert_eq!(short_name("SW1.example.com"), "SW1");
        assert_eq!(short_name("SW1"), "SW1");
        assert_eq!(short_name("N9K-2(FDO12345678)"), "N9K-2");
        assert_eq!(short_name("  SW1.example.com  "), "SW1");
    }

    #[test]
    fn short_name_leaves_an_address_alone() {
        // Every octet is a "label"; splitting on the first dot would turn
        // 10.1.1.1 into "10" and merge every device that reports an address.
        assert_eq!(short_name("10.1.1.1"), "10.1.1.1");
    }

    #[test]
    fn a_neighbour_with_no_address_is_still_reported() {
        // It cannot be crawled into, but it is a real adjacency worth drawing.
        let text = "\
-------------------------
Device ID: SW-NOIP
Entry address(es):
Platform: cisco WS-C3750,  Capabilities: Switch
Interface: GigabitEthernet0/1,  Port ID (outgoing port): GigabitEthernet0/9
";
        let n = &parse_cdp_detail(text)[0];
        assert_eq!(n.device_id, "SW-NOIP");
        assert_eq!(n.address(), None);
        assert!(n.addresses.is_empty());
        assert_eq!(n.remote_interface.as_deref(), Some("GigabitEthernet0/9"));
    }

    #[test]
    fn duplicate_addresses_are_collapsed() {
        // IOS repeats the address under "Management address(es)".
        let text = "\
-------------------------
Device ID: SW1
Entry address(es):
  IP address: 10.1.1.2
Platform: cisco WS-C2960,  Capabilities: Switch
Interface: Gi0/1,  Port ID (outgoing port): Gi0/2
Management address(es):
  IP address: 10.1.1.2
";
        let n = &parse_cdp_detail(text)[0];
        let ips: Vec<&str> = n.addresses.iter().map(|a| a.ip.as_str()).collect();
        assert_eq!(ips, vec!["10.1.1.2"]);
        // The management heading upgrades the existing entry rather than
        // adding a duplicate, so AddressPreference::Management can find it.
        assert!(n.addresses[0].is_management);
    }

    #[test]
    fn garbage_yields_no_neighbours_rather_than_an_error() {
        // A crawl must not abort because one platform printed something odd.
        assert!(parse_cdp_detail("").is_empty());
        assert!(parse_cdp_detail("% Invalid input detected at '^' marker.").is_empty());
        assert!(parse_cdp_detail("CDP is not enabled").is_empty());
    }

    #[test]
    fn a_phone_is_not_infrastructure() {
        let text = "\
-------------------------
Device ID: SEP001122334455
Entry address(es):
  IP address: 10.3.3.9
Platform: Cisco IP Phone 8845,  Capabilities: Host Phone
Interface: GigabitEthernet1/0/7,  Port ID (outgoing port): Port 1
";
        assert!(!parse_cdp_detail(text)[0].class.is_infrastructure());
        assert_eq!(parse_cdp_detail(text)[0].class, crate::types::DeviceClass::Phone);
    }
}
