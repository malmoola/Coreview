//! Resolving a neighbour that advertises no address.
//!
//! LLDP does not require a device to advertise a management address, and
//! plenty do not. On the network this was built against, a FortiSwitch is seen
//! on Gi0/9, named and classified correctly, and has nowhere to connect —
//! which no credential can fix.
//!
//! The switch that sees it does know. LLDP carries a chassis id, which is
//! usually a MAC, and the switch's own ARP table maps that MAC to an address:
//!
//! ```text
//! Chassis id: e81c.bac4.964b                      (LLDP, on Gi0/9)
//! 192.168.14.203  e81c.bac4.964b  ARPA  Vlan1     (show ip arp)
//! ```
//!
//! Both lines above are verbatim from that network, and together they are the
//! difference between a device drawn as an island and one that can be reached.

use std::collections::HashMap;
use std::net::Ipv4Addr;

/// A MAC reduced to twelve lowercase hex digits.
///
/// Written `e81c.bac4.964b` by Cisco, `e8:1c:ba:c4:96:4b` by nearly everyone
/// else, and `E8-1C-BA-C4-96-4B` by Windows. Comparing them as they arrive
/// finds nothing.
pub fn normalise_mac(raw: &str) -> Option<String> {
    let hex: String = raw
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    // Exactly twelve, or it is not a MAC — a hostname like "WORKSTATION1"
    // survives the filter above as "1" and must not be treated as one.
    (hex.len() == 12 && raw.chars().any(|c| c == ':' || c == '.' || c == '-'))
        .then_some(hex)
}

/// MAC to address, from `show ip arp`.
///
/// Column order differs between IOS and NX-OS, so each line is read by finding
/// the first thing that parses as an address and the first that parses as a
/// MAC, rather than by position.
pub fn parse_arp_table(out: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    for line in out.lines() {
        let mut ip: Option<String> = None;
        let mut mac: Option<String> = None;
        for token in line.split_whitespace() {
            if ip.is_none() {
                if let Ok(v) = token.parse::<Ipv4Addr>() {
                    // 0.0.0.0 and the broadcast address are not somewhere a
                    // device can be reached.
                    if !v.is_unspecified() && !v.is_broadcast() {
                        ip = Some(v.to_string());
                        continue;
                    }
                }
            }
            if mac.is_none() {
                if let Some(m) = normalise_mac(token) {
                    mac = Some(m);
                }
            }
        }
        if let (Some(ip), Some(mac)) = (ip, mac) {
            // First wins: an ARP table can hold the same MAC on several
            // interfaces, and the earlier entry is the one the device listed
            // first, which is as good a tie-break as any and is stable.
            map.entry(mac).or_insert(ip);
        }
    }
    map
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from a Catalyst 2960CX, trimmed.
    const IOS: &str = r#"
Protocol  Address          Age (min)  Hardware Addr   Type   Interface
Internet  192.168.14.1            0   ac71.2ed7.0fe8  ARPA   Vlan1
Internet  192.168.14.7            -   cc7f.750f.fcc0  ARPA   Vlan1
Internet  192.168.14.112          0   74ac.b9ec.c4a8  ARPA   Vlan1
Internet  192.168.14.203          0   e81c.bac4.964b  ARPA   Vlan1
"#;

    /// NX-OS puts the columns in a different order and has no Protocol column.
    const NXOS: &str = r#"
IP ARP Table for context default
Total number of entries: 2
Address         Age       MAC Address     Interface       Flags
10.1.1.1        00:02:31  0011.2233.4455  Ethernet1/1
10.1.1.2        00:14:02  0011.2233.4456  Ethernet1/2
"#;

    #[test]
    fn reads_an_ios_arp_table() {
        let map = parse_arp_table(IOS);
        assert_eq!(map.len(), 4, "{map:?}");
        // The entry this whole module exists for.
        assert_eq!(map.get("e81cbac4964b").map(String::as_str), Some("192.168.14.203"));
        assert_eq!(map.get("74acb9ecc4a8").map(String::as_str), Some("192.168.14.112"));
    }

    #[test]
    fn reads_nxos_where_the_columns_are_in_another_order() {
        // Position-based parsing would take "00:02:31" for the MAC.
        let map = parse_arp_table(NXOS);
        assert_eq!(map.get("001122334455").map(String::as_str), Some("10.1.1.1"));
        assert_eq!(map.get("001122334456").map(String::as_str), Some("10.1.1.2"));
        assert_eq!(map.len(), 2, "the age column must not be read as a MAC: {map:?}");
    }

    #[test]
    fn a_hostname_is_not_a_mac() {
        // A chassis id is often a name. "WORKSTATION1" filters down to "1",
        // and a device whose chassis id is a name has no MAC to look up.
        assert_eq!(normalise_mac("WORKSTATION1"), None);
        assert_eq!(normalise_mac("S224ENTF19001615"), None);
        assert_eq!(normalise_mac(""), None);
        // Twelve hex digits with no separator is a serial as often as a MAC,
        // and guessing wrong points a crawl at the wrong device.
        assert_eq!(normalise_mac("e81cbac4964b"), None);
    }

    #[test]
    fn the_three_ways_of_writing_a_mac_agree() {
        let want = Some("e81cbac4964b".to_string());
        assert_eq!(normalise_mac("e81c.bac4.964b"), want);
        assert_eq!(normalise_mac("e8:1c:ba:c4:96:4b"), want);
        assert_eq!(normalise_mac("E8-1C-BA-C4-96-4B"), want);
    }

    #[test]
    fn a_header_row_yields_nothing() {
        assert!(parse_arp_table("Protocol  Address  Age (min)  Hardware Addr  Type  Interface").is_empty());
        assert!(parse_arp_table("").is_empty());
    }

    #[test]
    fn an_incomplete_entry_is_skipped() {
        // A pending ARP entry has no hardware address.
        let out = "Internet  192.168.14.9           0   Incomplete      ARPA   Vlan1";
        assert!(parse_arp_table(out).is_empty());
    }
}
