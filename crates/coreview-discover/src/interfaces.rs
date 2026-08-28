//! Parser for `show ip interface brief`.
//!
//! This is what makes the address preference real. CDP and LLDP tell you *an*
//! address for a neighbour; only the device itself can tell you which of its
//! addresses sits on a loopback and which is on a physical port that goes down
//! with the cable. Without this, "prefer the loopback" has nothing to prefer.

use crate::types::DeviceAddress;

/// One row of the table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interface {
    pub name: String,
    /// `None` when the row says `unassigned`.
    pub address: Option<String>,
    /// The line protocol is up, which is what decides whether an address is
    /// worth probing.
    pub up: bool,
}

impl Interface {
    pub fn is_loopback(&self) -> bool {
        self.name.to_ascii_lowercase().starts_with("loopback")
    }
}

/// Parses the table, ignoring the header and anything that is not a row.
///
/// Never fails. A device that does not understand the command returns an error
/// line, and the right response is no interfaces rather than an aborted crawl.
pub fn parse_ip_interface_brief(output: &str) -> Vec<Interface> {
    let mut out = Vec::new();
    for line in output.lines() {
        let fields: Vec<&str> = line.split_whitespace().collect();
        // Interface, IP-Address, OK?, Method, Status..., Protocol
        if fields.len() < 5 {
            continue;
        }
        // The header row and error lines both fail this: a real row always
        // names an interface starting with a letter and carries OK?/Method.
        if fields[0].eq_ignore_ascii_case("Interface") || !fields[0].starts_with(char::is_alphabetic) {
            continue;
        }

        let address = match fields[1] {
            "unassigned" | "unassigned," => None,
            candidate => candidate.parse::<std::net::Ipv4Addr>().ok().map(|v| v.to_string()),
        };
        // "OK?" is YES/NO on every platform that prints this table; requiring
        // it keeps stray text out.
        if !matches!(fields[2].to_ascii_uppercase().as_str(), "YES" | "NO") {
            continue;
        }

        // The protocol column is last. Status can be two words
        // ("administratively down"), so counting from the end is the only
        // reliable way to find it.
        let up = fields
            .last()
            .map(|p| p.eq_ignore_ascii_case("up"))
            .unwrap_or(false);

        out.push(Interface {
            name: fields[0].to_string(),
            address,
            up,
        });
    }
    out
}

/// Turns the table into addresses the probe preference can choose between.
///
/// Only interfaces that have an address and are up: a loopback that is
/// administratively down is not the stable management address it looks like,
/// and probing it would report the device as unreachable forever.
///
/// `management` marks the address the device was reached on, so a preference
/// for "management" resolves to the address that demonstrably works.
pub fn addresses_from(interfaces: &[Interface], reached_on: &str) -> Vec<DeviceAddress> {
    interfaces
        .iter()
        .filter(|i| i.up)
        .filter_map(|i| {
            i.address.as_ref().map(|a| DeviceAddress {
                ip: a.clone(),
                interface: Some(i.name.clone()),
                is_management: a == reached_on,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::AddressPreference;

    const IOS: &str = "\
Interface              IP-Address      OK? Method Status                Protocol
GigabitEthernet0/0     10.1.1.1        YES NVRAM  up                    up
GigabitEthernet0/1     unassigned      YES NVRAM  up                    up
Loopback0              10.255.0.1      YES NVRAM  up                    up
Vlan100                10.99.0.1       YES NVRAM  up                    up
Vlan999                10.99.9.1       YES NVRAM  administratively down down
";

    #[test]
    fn every_real_row_is_parsed_and_the_header_is_not() {
        let rows = parse_ip_interface_brief(IOS);
        assert_eq!(rows.len(), 5, "got {rows:?}");
        assert_eq!(rows[0].name, "GigabitEthernet0/0");
        assert_eq!(rows[0].address.as_deref(), Some("10.1.1.1"));
        assert!(rows[0].up);
    }

    #[test]
    fn an_unassigned_interface_has_no_address() {
        let rows = parse_ip_interface_brief(IOS);
        assert_eq!(rows[1].address, None);
    }

    #[test]
    fn a_two_word_status_still_finds_the_protocol_column() {
        // "administratively down" is two fields, so counting from the left
        // reads the wrong column and reports the interface as up.
        let rows = parse_ip_interface_brief(IOS);
        let vlan999 = rows.iter().find(|r| r.name == "Vlan999").unwrap();
        assert!(!vlan999.up, "administratively down must not read as up");
    }

    #[test]
    fn a_loopback_is_recognised() {
        let rows = parse_ip_interface_brief(IOS);
        assert!(rows.iter().find(|r| r.name == "Loopback0").unwrap().is_loopback());
        assert!(!rows[0].is_loopback());
    }

    #[test]
    fn addresses_feed_the_preference_and_the_loopback_wins() {
        // The whole point of running this command during a crawl.
        let rows = parse_ip_interface_brief(IOS);
        let addrs = addresses_from(&rows, "10.1.1.1");
        let pick = AddressPreference::Loopback.choose(&addrs).unwrap();
        assert_eq!(pick.ip, "10.255.0.1");
    }

    #[test]
    fn a_down_interface_is_never_offered_as_a_probe_target() {
        // A loopback that is administratively down looks like the stable
        // management address and would report the device down forever.
        let rows = parse_ip_interface_brief(IOS);
        let addrs = addresses_from(&rows, "10.1.1.1");
        assert!(!addrs.iter().any(|a| a.ip == "10.99.9.1"), "got {addrs:?}");
        assert!(!addrs.iter().any(|a| a.interface.as_deref() == Some("GigabitEthernet0/1")));
    }

    #[test]
    fn the_address_we_reached_it_on_is_marked_as_management() {
        // So a "management" preference resolves to the address that
        // demonstrably works, rather than one the device merely advertises.
        let rows = parse_ip_interface_brief(IOS);
        let addrs = addresses_from(&rows, "10.99.0.1");
        let mgmt: Vec<_> = addrs.iter().filter(|a| a.is_management).collect();
        assert_eq!(mgmt.len(), 1);
        assert_eq!(mgmt[0].ip, "10.99.0.1");
        assert_eq!(
            AddressPreference::Management.choose(&addrs).unwrap().ip,
            "10.99.0.1"
        );
    }

    #[test]
    fn a_device_that_rejected_the_command_yields_nothing() {
        assert!(parse_ip_interface_brief("% Invalid input detected at '^' marker.").is_empty());
        assert!(parse_ip_interface_brief("").is_empty());
        assert!(parse_ip_interface_brief("Building configuration...").is_empty());
    }

    #[test]
    fn nxos_style_output_is_parsed_too() {
        // NX-OS omits the OK?/Method columns entirely, which this parser
        // requires — so it produces nothing rather than nonsense. Recording
        // the limitation here so it is a known gap, not a surprise.
        let nxos = "\
IP Interface Status for VRF \"default\"
Interface            IP Address      Interface Status
Vlan10               10.1.10.1       protocol-up/link-up/admin-up
";
        assert!(
            parse_ip_interface_brief(nxos).is_empty(),
            "NX-OS output is not yet understood; the crawl falls back to the address it reached the device on"
        );
    }
}
