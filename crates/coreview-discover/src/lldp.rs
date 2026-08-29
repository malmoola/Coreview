//! Parser for `show lldp neighbors detail`.
//!
//! LLDP matters because CDP is Cisco-only. A mixed estate — Aruba, Juniper,
//! HP, a Palo Alto, anything virtual — is invisible to a CDP-only crawl, and
//! the gap is silent: the neighbours simply are not listed.
//!
//! The output is close enough to CDP's to share the entry-splitting idea and
//! different enough to need its own field names. Cisco's LLDP output uses
//! "Local Intf" / "Port id" / "System Name" / "System Description", and
//! renders capabilities as either words or single letters depending on the
//! platform.

use crate::classify::classify;
use crate::types::{DeviceAddress, Neighbor, Protocol};

/// Splits `show lldp neighbors detail` into entries and parses each.
///
/// Never fails, for the same reason the CDP parser does not: a crawl must not
/// abort because one switch printed something unexpected.
pub fn parse_lldp_detail(output: &str) -> Vec<Neighbor> {
    split_entries(output)
        .iter()
        .filter_map(|b| parse_entry(b))
        .collect()
}

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
        // "Total entries displayed: 3" belongs to no entry.
        let lower = t.to_ascii_lowercase();
        if lower.starts_with("total entries displayed") || lower.starts_with("total lldp entries") {
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

fn field<'a>(line: &'a str, label: &str) -> Option<&'a str> {
    let trimmed = line.trim_start();
    let head = trimmed.get(..label.len())?;
    if !head.eq_ignore_ascii_case(label) {
        return None;
    }
    let after = trimmed[label.len()..].trim_start();
    after.strip_prefix(':').map(|v| v.trim())
}

fn parse_entry(block: &str) -> Option<Neighbor> {
    let mut chassis_id: Option<String> = None;
    let mut system_name: Option<String> = None;
    let mut local_interface = None;
    let mut remote_interface = None;
    let mut port_description = None;
    let mut description: Option<String> = None;
    let mut capabilities: Vec<String> = Vec::new();
    let mut addresses: Vec<DeviceAddress> = Vec::new();
    let mut in_description = false;

    for line in block.lines() {
        if in_description {
            let t = line.trim();
            // The description is free text and runs until the next known
            // field. Only its first line is kept, like the CDP version banner.
            if t.is_empty() {
                continue;
            }
            if known_label(line) {
                in_description = false;
            } else {
                if description.is_none() {
                    description = Some(t.to_string());
                }
                continue;
            }
        }

        if let Some(v) = field(line, "Local Intf")
            .or_else(|| field(line, "Local Interface"))
            .or_else(|| field(line, "Local Port id"))
        {
            local_interface = non_empty(v);
        } else if let Some(v) = field(line, "Port id").or_else(|| field(line, "Port ID")) {
            remote_interface = non_empty(v);
        } else if let Some(v) = field(line, "Port Description").or_else(|| field(line, "Port Descr")) {
            port_description = non_empty(v);
        } else if let Some(v) = field(line, "Chassis id").or_else(|| field(line, "Chassis ID")) {
            chassis_id = non_empty(v);
        } else if let Some(v) = field(line, "System Name") {
            system_name = non_empty(v);
        } else if field(line, "System Description").is_some() {
            in_description = true;
        } else if let Some(v) = field(line, "Enabled Capabilities")
            .or_else(|| field(line, "System Capabilities"))
        {
            capabilities = split_capabilities(v);
        } else if let Some(ip) = management_address(line) {
            // LLDP's management address is exactly that, so it is marked as
            // such and an AddressPreference::Management can find it.
            if !addresses.iter().any(|a| a.ip == ip) {
                addresses.push(DeviceAddress::management(ip));
            }
        }
    }

    // A neighbour with neither a name nor a chassis id is not a neighbour.
    let device_id = system_name.clone().or_else(|| chassis_id.clone())?;
    let short_name = crate::cdp::short_name(&device_id);

    let platform = platform_from_description(description.as_deref());
    let class = classify(platform.as_deref(), &capabilities, description.as_deref());

    Some(Neighbor {
        device_id,
        short_name,
        addresses,
        local_interface,
        // "Port id" on many platforms is a MAC address, and the human-readable
        // port is in "Port Description". Prefer the readable one for a label.
        remote_interface: port_description.or(remote_interface),
        platform,
        capabilities,
        version: description,
        class,
        discovered_by: Protocol::Lldp,
    })
}

fn non_empty(v: &str) -> Option<String> {
    (!v.trim().is_empty()).then(|| v.trim().to_string())
}

/// Labels that end a free-text System Description block.
fn known_label(line: &str) -> bool {
    const LABELS: [&str; 8] = [
        "Time remaining",
        "System Capabilities",
        "Enabled Capabilities",
        "Management Addresses",
        "Auto Negotiation",
        "Physical media",
        "Media Attachment",
        "Vlan ID",
    ];
    LABELS.iter().any(|l| field(line, l).is_some() || line.trim_start().starts_with(l))
}

/// Capabilities appear as "B,R" on some platforms and "Bridge Router" on
/// others, so both separators are accepted.
fn split_capabilities(v: &str) -> Vec<String> {
    v.split([',', ' '])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect()
}

/// "IP: 10.1.1.2" under a "Management Addresses" heading, or an inline
/// "Management Address: 10.1.1.2". Only IPv4: the subnet filter is IPv4, and
/// an address it cannot filter is worse than none.
fn management_address(line: &str) -> Option<String> {
    let t = line.trim();
    let lower = t.to_ascii_lowercase();
    if !(lower.starts_with("ip:")
        || lower.starts_with("ipv4:")
        || lower.starts_with("management address")
        || lower.starts_with("ip address"))
    {
        return None;
    }
    let (_, value) = t.split_once(':')?;
    value
        .trim()
        .parse::<std::net::Ipv4Addr>()
        .ok()
        .map(|v| v.to_string())
}

/// LLDP has no platform field. The system description usually starts with
/// something identifying, so the first comma-delimited chunk is used as a
/// stand-in for the classifier.
fn platform_from_description(desc: Option<&str>) -> Option<String> {
    let d = desc?.trim();
    if d.is_empty() {
        return None;
    }
    let head = d.split(',').next().unwrap_or(d).trim();
    (!head.is_empty()).then(|| head.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DeviceClass;

    /// Cisco IOS `show lldp neighbors detail`.
    const IOS: &str = r#"
------------------------------------------------
Local Intf: Gi1/0/12
Chassis id: 001a.2b3c.4d5e
Port id: 001a.2b3c.4d60
Port Description: GigabitEthernet1/0/1
System Name: ARUBA-SW-01

System Description:
ArubaOS-CX GL_10.09.1010, Aruba 6300M 48G

Time remaining: 97 seconds
System Capabilities: B,R
Enabled Capabilities: B
Management Addresses:
    IP: 10.20.30.40
Auto Negotiation - supported, enabled

------------------------------------------------
Local Intf: Gi1/0/7
Chassis id: 0011.2233.4455
Port id: 0011.2233.4456
System Name: SEP001122334455

System Description:
Cisco IP Phone 8845, V1, sip88xx.12-8-1-0001-27

Time remaining: 143 seconds
System Capabilities: B,T
Enabled Capabilities: B,T
Management Addresses:
    IP: 10.3.3.9

Total entries displayed: 2
"#;

    /// NX-OS `show lldp neighbors detail`: "Local Port id" rather than
    /// "Local Intf", and a one-line "Management Address" rather than a
    /// "Management Addresses" heading with an "IP:" under it.
    const NXOS: &str = r#"
Chassis id: 00de.fb12.3456
Port id: Ethernet1/1
Local Port id: Eth1/2
Port Description: Ethernet1/1
System Name: N9K-LEAF-2
System Description: Cisco Nexus Operating System (NX-OS) Software 9.3(3)

Time remaining: 103 seconds
System Capabilities: B, R
Enabled Capabilities: B, R
Management Address: 10.2.2.5
Management Address IPV6: not advertised
Vlan ID: 1

Total entries displayed: 1
"#;

    #[test]
    fn parses_nxos_lldp_with_its_different_labels() {
        let all = parse_lldp_detail(NXOS);
        assert_eq!(all.len(), 1, "{all:?}");
        let n = &all[0];
        assert_eq!(n.short_name, "N9K-LEAF-2");
        assert_eq!(n.local_interface.as_deref(), Some("Eth1/2"));
        assert_eq!(n.remote_interface.as_deref(), Some("Ethernet1/1"));
        assert_eq!(n.address(), Some("10.2.2.5"));
        // Bridge and Router: a switch that also routes is still a switch.
        assert_eq!(n.class, DeviceClass::Switch);
    }

    #[test]
    fn parses_a_third_party_switch_cdp_would_have_missed() {
        // The reason LLDP is here at all: an Aruba switch is invisible to CDP.
        let all = parse_lldp_detail(IOS);
        let n = &all[0];
        assert_eq!(n.device_id, "ARUBA-SW-01");
        assert_eq!(n.local_interface.as_deref(), Some("Gi1/0/12"));
        assert_eq!(n.discovered_by, Protocol::Lldp);
        assert_eq!(n.addresses[0].ip, "10.20.30.40");
        assert!(n.addresses[0].is_management, "LLDP says so explicitly");
    }

    #[test]
    fn the_readable_port_beats_the_mac_address() {
        // "Port id" is a MAC on many platforms; the description is the port a
        // human recognises, and it is what belongs on a link label.
        let n = &parse_lldp_detail(IOS)[0];
        assert_eq!(n.remote_interface.as_deref(), Some("GigabitEthernet1/0/1"));
    }

    #[test]
    fn falls_back_to_port_id_when_there_is_no_description() {
        let text = "\
------------------------------------------------
Local Intf: Gi1/0/3
Chassis id: aabb.ccdd.eeff
Port id: xe-0/0/1
System Name: JUNIPER-1
";
        let n = &parse_lldp_detail(text)[0];
        assert_eq!(n.remote_interface.as_deref(), Some("xe-0/0/1"));
    }

    #[test]
    fn letter_capabilities_classify_correctly() {
        let all = parse_lldp_detail(IOS);
        // B,R on an Aruba switch.
        assert_eq!(all[0].class, DeviceClass::Switch);
        // B,T is a phone, and must not be classified as a switch because it
        // also bridges — a phone with a PC port does.
        assert_eq!(all[1].class, DeviceClass::Phone);
    }

    #[test]
    fn the_description_stops_at_the_next_field() {
        let n = &parse_lldp_detail(IOS)[0];
        let d = n.version.as_deref().unwrap();
        assert!(d.starts_with("ArubaOS-CX"));
        assert!(!d.contains("Time remaining"), "description leaked: {d}");
    }

    #[test]
    fn a_chassis_id_stands_in_for_a_missing_system_name() {
        let text = "\
------------------------------------------------
Local Intf: Gi1/0/9
Chassis id: 00de.ad00.beef
Port id: 1
";
        let n = &parse_lldp_detail(text)[0];
        assert_eq!(n.device_id, "00de.ad00.beef");
    }

    #[test]
    fn the_totals_line_is_not_an_entry() {
        assert_eq!(parse_lldp_detail(IOS).len(), 2);
    }

    #[test]
    fn garbage_yields_no_neighbours() {
        assert!(parse_lldp_detail("").is_empty());
        assert!(parse_lldp_detail("% LLDP is not enabled").is_empty());
    }
}
