//! FortiOS: FortiSwitch and FortiGate.
//!
//! These answer SSH and then reject every IOS command with a parse error, so a
//! crawl that only speaks IOS logs in, learns the hostname from the prompt and
//! nothing else. They are common enough in the networks this app is for that
//! "we got in and found out nothing" is not good enough.
//!
//! The fixtures below are verbatim output from a FortiSwitch 224E on
//! 7.6.1, captured with `examples/try_commands.rs`. Guessing this from
//! documentation is how a parser ends up working on nothing real.

use crate::types::{DeviceAddress, DeviceClass, Neighbor, Protocol};

/// Whether output is a FortiOS rejection rather than a real answer.
///
/// The point of asking is to decide whether to try the FortiOS command set,
/// so it errs towards saying no: a false positive costs a wasted round trip,
/// a false negative costs the whole device.
pub fn rejected_command(output: &str) -> bool {
    let l = output.to_ascii_lowercase();
    l.contains("command parse error") || l.contains("command fail. return code")
}

/// Identity from `get system status`.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct SystemStatus {
    pub hostname: Option<String>,
    /// "FortiSwitch-224E", the part a classifier can use.
    pub model: Option<String>,
    /// The whole version line, for display.
    pub version: Option<String>,
    pub serial: Option<String>,
}

fn value_after(line: &str, label: &str) -> Option<String> {
    let (name, value) = line.split_once(':')?;
    if !name.trim().eq_ignore_ascii_case(label) {
        return None;
    }
    let v = value.trim();
    (!v.is_empty()).then(|| v.to_string())
}

pub fn parse_system_status(out: &str) -> SystemStatus {
    let mut s = SystemStatus::default();
    for line in out.lines() {
        if let Some(v) = value_after(line, "Hostname") {
            s.hostname = Some(v);
        } else if let Some(v) = value_after(line, "Serial-Number") {
            s.serial = Some(v);
        } else if let Some(v) = value_after(line, "Version") {
            // "FortiSwitch-224E v7.6.1,build1047,241217 (GA)" — the model is
            // the first word, and it is what identifies the platform.
            s.model = v.split_whitespace().next().map(str::to_string);
            s.version = Some(v);
        }
    }
    s
}

/// Addresses from `get system interface`.
///
/// Unconfigured DHCP interfaces report 0.0.0.0 and are skipped: an address
/// that routes nowhere is worse than no address, because the crawler would
/// try to reach the device on it.
pub fn parse_system_interface(out: &str) -> Vec<DeviceAddress> {
    let mut found = Vec::new();
    for line in out.lines() {
        let t = line.trim();
        if !t.starts_with("name:") {
            continue;
        }
        let name = t
            .split_whitespace()
            .nth(1)
            .filter(|n| !n.is_empty())
            .map(str::to_string);
        let Some(rest) = t.split("ip:").nth(1) else { continue };
        let Some(ip) = rest.split_whitespace().next() else { continue };
        if ip == "0.0.0.0" || ip.parse::<std::net::Ipv4Addr>().is_err() {
            continue;
        }
        let lower = name.as_deref().unwrap_or("").to_ascii_lowercase();
        found.push(DeviceAddress {
            ip: ip.to_string(),
            interface: name,
            is_management: lower.contains("mgmt") || lower.contains("internal"),
        });
    }
    found
}

/// Neighbours from `get switch lldp neighbors-summary`.
///
/// A fixed-width table. Ports with nothing attached fill every column with a
/// single dash, which is most of the table on a real switch.
pub fn parse_lldp_summary(out: &str) -> Vec<Neighbor> {
    let mut header: Option<Vec<(usize, String)>> = None;
    let mut neighbors = Vec::new();

    for line in out.lines() {
        let t = line.trim_end();
        if header.is_none() {
            if t.contains("Portname") && t.contains("Device-name") {
                // Column starts, so the fields can be cut by position: the
                // values contain spaces and splitting on whitespace merges
                // them into the wrong columns.
                let mut cols = Vec::new();
                for name in ["Portname", "Status", "Device-name", "TTL", "Capability", "MED-type", "Port-ID"] {
                    if let Some(at) = t.find(name) {
                        cols.push((at, name.to_string()));
                    }
                }
                cols.sort_by_key(|c| c.0);
                header = Some(cols);
            }
            continue;
        }
        let cols = header.as_ref().unwrap();
        if t.trim().is_empty() || t.trim_start().starts_with('_') {
            continue;
        }

        let cut = |name: &str| -> String {
            let Some(i) = cols.iter().position(|c| c.1 == name) else { return String::new() };
            let start = cols[i].0;
            let end = cols.get(i + 1).map(|c| c.0).unwrap_or(t.len());
            t.get(start..end.min(t.len())).unwrap_or("").trim().to_string()
        };

        let port = cut("Portname");
        let name = cut("Device-name");
        if port.is_empty() || name.is_empty() || name == "-" {
            continue;
        }
        let capabilities: Vec<String> = cut("Capability")
            .split(',')
            .map(str::trim)
            .filter(|c| !c.is_empty() && *c != "-")
            .map(str::to_string)
            .collect();
        let remote = cut("Port-ID");

        neighbors.push(Neighbor {
            device_id: name.clone(),
            short_name: name.split('.').next().unwrap_or(&name).to_string(),
            addresses: Vec::new(),
            local_interface: Some(port),
            remote_interface: (!remote.is_empty() && remote != "-").then_some(remote),
            platform: None,
            capabilities: capabilities.clone(),
            version: None,
            // Single letters here, not words: R:Router, B:Bridge, W:WLAN
            // Access Point, T:Telephone.
            class: class_from_codes(&capabilities),
            discovered_by: Protocol::Lldp,
            chassis_id: None,
            vendor: None,
        });
    }
    neighbors
}

/// FortiOS abbreviates capabilities to single letters, which the shared
/// classifier does not know.
fn class_from_codes(codes: &[String]) -> DeviceClass {
    let has = |c: &str| codes.iter().any(|x| x.eq_ignore_ascii_case(c));
    // Bridging wins over routing: a switch that also routes is still a switch
    // on a diagram.
    if has("B") {
        DeviceClass::Switch
    } else if has("W") {
        DeviceClass::AccessPoint
    } else if has("T") {
        DeviceClass::Phone
    } else if has("R") {
        DeviceClass::Router
    } else {
        DeviceClass::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from a FortiSwitch 224E running 7.6.1.
    const STATUS: &str = r#"
Version: FortiSwitch-224E v7.6.1,build1047,241217 (GA)
Serial-Number: S224ENTF19001615
Firmware Signature: valid
Boot: Coldboot
BIOS version: 04000006
System Part-Number: P21932-05
Burn in MAC: e8:1c:ba:c4:96:4a
Hostname: S224ENTF19001615
Security mode: none
"#;

    /// Verbatim from the same switch.
    const INTERFACES: &str = r#"
== [ mgmt ]
name: mgmt    status: up    mode: dhcp    ip: 0.0.0.0 0.0.0.0   type: physical   dhcp-client-status: initial
== [ internal ]
name: internal    status: up    mode: static    ip: 192.168.14.203 255.255.255.0   type: physical
== [ 90_lab ]
name: 90_lab    status: up    mode: dhcp    ip: 0.0.0.0 0.0.0.0   type: vlan   dhcp-client-status: initial    vlanid: 90
"#;

    /// The header and the empty rows are verbatim. The two rows with a
    /// neighbour are built to the same column positions: the switch tested
    /// against has LLDP off, so a populated table was not observed.
    const LLDP: &str = r#"
Capability codes:
	R:Router, B:Bridge, T:Telephone, C:DOCSIS Cable Device
MED type codes:
	Generic:Generic Endpoint (Class 1), Media:Media Endpoint (Class 2)

  Portname    Status   Device-name                 TTL   Capability  MED-type  Port-ID
  __________  _______  __________________________  ____  __________  ________  _______
  port1       Down     -                           -     -           -         -
  port9       Up       HOME-MAIN-SW.lab.local      120   B,R         -         Gi0/9
  port12      Up       Moe Office AP               120   W           -         eth1
  port13      Down     -                           -     -           -         -
"#;

    #[test]
    fn an_ios_command_on_fortios_is_recognised_as_a_rejection() {
        assert!(rejected_command("command parse error before 'cdp'\nCommand fail. Return code -61"));
        assert!(!rejected_command("Version: FortiSwitch-224E v7.6.1"));
        // A Cisco rejection is not a FortiOS one; it must not send the crawl
        // down this path.
        assert!(!rejected_command("% Invalid input detected at '^' marker."));
    }

    #[test]
    fn reads_the_identity_a_fortiswitch_reports() {
        let s = parse_system_status(STATUS);
        assert_eq!(s.hostname.as_deref(), Some("S224ENTF19001615"));
        assert_eq!(s.model.as_deref(), Some("FortiSwitch-224E"));
        assert_eq!(s.serial.as_deref(), Some("S224ENTF19001615"));
        assert!(s.version.as_deref().unwrap().contains("7.6.1"));
    }

    #[test]
    fn skips_interfaces_dhcp_never_configured() {
        // 0.0.0.0 is not somewhere the crawler can reach the device, and
        // keeping it would have it try.
        let a = parse_system_interface(INTERFACES);
        assert_eq!(a.len(), 1, "{a:?}");
        assert_eq!(a[0].ip, "192.168.14.203");
        assert_eq!(a[0].interface.as_deref(), Some("internal"));
        assert!(a[0].is_management);
    }

    #[test]
    fn reads_neighbours_and_ignores_empty_ports() {
        let n = parse_lldp_summary(LLDP);
        assert_eq!(n.len(), 2, "{n:?}");

        assert_eq!(n[0].short_name, "HOME-MAIN-SW");
        assert_eq!(n[0].local_interface.as_deref(), Some("port9"));
        assert_eq!(n[0].remote_interface.as_deref(), Some("Gi0/9"));
        assert_eq!(n[0].class, DeviceClass::Switch);

        // A name with spaces in it, which is why the table is cut by column
        // position rather than split on whitespace.
        assert_eq!(n[1].short_name, "Moe Office AP");
        assert_eq!(n[1].class, DeviceClass::AccessPoint);
    }

    #[test]
    fn a_table_with_nothing_attached_yields_nothing() {
        let empty = LLDP.replace("HOME-MAIN-SW.lab.local", "-                     ")
            .replace("Moe Office AP", "-            ");
        assert!(parse_lldp_summary(&empty).is_empty());
    }
}
