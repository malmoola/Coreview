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
    /// Whether the device keeps its configuration in virtual domains, so the
    /// crawler knows it has to enter one before asking about a network.
    pub vdoms_enabled: bool,
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
        } else if let Some(v) = value_after(line, "Virtual domain configuration") {
            s.vdoms_enabled = parse_vdom_mode(&v);
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

// ---------------------------------------------------------------------------
// FortiGate
//
// A FortiSwitch answers the commands above. A FortiGate is a different problem:
// it can sit behind a FIPS banner that swallows the first command, it can hide
// everything interesting inside a VDOM, and it knows far more about what is
// plugged into the network than ARP alone can say — hostnames, operating
// systems, hardware types, which SSID a device is on.
//
// The shapes parsed below come from a working script the operator ran against
// their own FortiGate, which is evidence of the real format rather than of the
// documented one. They have not yet been checked against a live FortiGate from
// inside this app; a FortiSwitch does not have a device store to check against.
// ---------------------------------------------------------------------------

/// Whether the box is holding a banner open and will ignore anything else.
///
/// A FIPS-CC FortiGate prints its banner and waits for a literal `a`. Until it
/// gets one, every command sent is read as the answer to the banner, so a
/// crawler that does not notice this collects one long banner and no data.
pub fn fips_banner_pending(out: &str) -> bool {
    out.contains("(Press 'a' to accept)")
}

/// Whether output stopped at a pager rather than at the end.
pub fn pagination_pending(out: &str) -> bool {
    out.contains("Do you want to continue? (y/n)")
}

/// Whether this device keeps its configuration in virtual domains.
///
/// When it does, `get system arp` in the wrong place answers for the wrong
/// network, so the crawler has to enter a VDOM before it asks anything.
fn parse_vdom_mode(line_value: &str) -> bool {
    let v = line_value.trim().to_ascii_lowercase();
    v != "disable"
}

/// One device as the FortiGate itself understands it.
///
/// This is richer than anything a switch can offer. An ARP table gives an
/// address and a MAC, and an OUI lookup turns the MAC into a manufacturer —
/// so a printer arrives as "Hewlett Packard". Here it arrives as a printer,
/// with its name.
#[derive(Debug, Default, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub mac: String,
    pub address: Option<String>,
    pub hostname: Option<String>,
    pub hardware_vendor: Option<String>,
    pub hardware_type: Option<String>,
    pub os_name: Option<String>,
    pub os_version: Option<String>,
    pub interface: Option<String>,
    /// The SSID, when the FortiGate learned about it through a FortiAP.
    pub fortiap_ssid: Option<String>,
    pub fortiap_name: Option<String>,
    pub online: bool,
}

/// Read `'label' = 'value'` out of one record.
///
/// The leading quote in the search is what keeps `'name'` from matching inside
/// `'os_name'`, so the fields stay distinct without a regex engine.
fn quoted_field(record: &str, label: &str) -> Option<String> {
    let needle = format!("'{label}'");
    let mut rest = record.get(record.find(&needle)? + needle.len()..)?.trim_start();
    rest = rest.strip_prefix('=')?.trim_start();
    let value = rest.strip_prefix('\'')?;
    let end = value.find('\'')?;
    let v = &value[..end];
    (!v.is_empty()).then(|| v.to_string())
}

/// Every device the FortiGate is currently holding in its device store.
///
/// Records with no usable MAC are dropped: a device store entry that cannot be
/// tied to a MAC cannot be matched against anything else the crawl found, so
/// carrying it forward would only produce a duplicate node.
pub fn parse_device_store(out: &str) -> Vec<Endpoint> {
    let mut found = Vec::new();
    for record in out.split("Record #").skip(1) {
        let Some(mac) = quoted_field(record, "mac").and_then(|m| crate::arp::normalise_mac(&m))
        else {
            continue;
        };
        found.push(Endpoint {
            mac,
            address: quoted_field(record, "ipv4_address"),
            hostname: quoted_field(record, "hostname"),
            hardware_vendor: quoted_field(record, "hardware_vendor"),
            hardware_type: quoted_field(record, "hardware_type"),
            os_name: quoted_field(record, "os_name"),
            os_version: quoted_field(record, "os_version"),
            interface: quoted_field(record, "detected_interface"),
            fortiap_ssid: quoted_field(record, "fortiap_ssid"),
            fortiap_name: quoted_field(record, "fortiap_name"),
            online: quoted_field(record, "is_online")
                .is_some_and(|v| v.eq_ignore_ascii_case("1") || v.eq_ignore_ascii_case("true")),
        });
    }
    found
}

/// What a FortiGate device store entry says this thing is.
///
/// The FortiGate's own words are better evidence than an OUI: "Printer" is a
/// fact about the device, where "Hewlett Packard" is a fact about who made the
/// chip in it. Where it says nothing useful, this says nothing rather than
/// guessing, and the OUI classifier keeps its turn.
pub fn endpoint_class(e: &Endpoint) -> Option<DeviceClass> {
    let hint = format!(
        "{} {}",
        e.hardware_type.as_deref().unwrap_or(""),
        e.os_name.as_deref().unwrap_or("")
    )
    .to_ascii_lowercase();
    if hint.contains("printer") {
        Some(DeviceClass::Printer)
    } else if hint.contains("server") {
        Some(DeviceClass::Server)
    } else if hint.contains("phone") || hint.contains("ip-phone") {
        Some(DeviceClass::Phone)
    } else if hint.contains("firewall") {
        Some(DeviceClass::Firewall)
    } else if hint.contains("router") {
        Some(DeviceClass::Router)
    } else if hint.contains("switch") {
        Some(DeviceClass::Switch)
    } else if hint.contains("windows") || hint.contains("mac os") || hint.contains("linux") {
        Some(DeviceClass::Endpoint)
    } else {
        None
    }
}

#[cfg(test)]
mod fortigate_tests {
    use super::*;

    /// The shape a working script proved, with the fields it actually read.
    const DEVICE_STORE: &str = r"
Record #1:
  'mac' = '00:0c:29:1a:2b:3c'
  'ipv4_address' = '192.168.14.50'
  'hostname' = 'DESKTOP-QA1'
  'hardware_vendor' = 'VMware'
  'hardware_type' = 'Computer'
  'os_name' = 'Windows'
  'os_version' = '10'
  'detected_interface' = 'internal1'
  'is_online' = '1'
  'host_src' = 'arp'
Record #2:
  'mac' = 'b8:27:eb:44:55:66'
  'ipv4_address' = '192.168.14.71'
  'hostname' = 'HPLJ-3rdfloor'
  'hardware_vendor' = 'Hewlett Packard'
  'hardware_type' = 'Printer'
  'detected_interface' = 'internal3'
  'is_online' = '0'
Record #3:
  'mac' = '3c:22:fb:aa:bb:cc'
  'hostname' = 'iPhone'
  'fortiap_ssid' = 'CorpWiFi'
  'fortiap_name' = 'AP-Lobby'
  'is_online' = '1'
";

    #[test]
    fn reads_every_record() {
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(found.len(), 3);
        assert_eq!(found[0].hostname.as_deref(), Some("DESKTOP-QA1"));
        assert_eq!(found[1].address.as_deref(), Some("192.168.14.71"));
    }

    #[test]
    fn normalises_the_mac_so_it_matches_the_arp_table() {
        // The whole value of the device store is being able to attach a name
        // to something the crawl already found by MAC. Two spellings of the
        // same MAC would produce two nodes instead of one named node.
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(
            found[0].mac,
            crate::arp::normalise_mac("000C.291A.2B3C").expect("a valid MAC normalises")
        );
    }

    #[test]
    fn does_not_confuse_one_field_for_another() {
        // 'os_name' ends in name'; a looser search would read it as 'name'.
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(found[0].os_name.as_deref(), Some("Windows"));
        assert_eq!(found[0].hardware_vendor.as_deref(), Some("VMware"));
    }

    #[test]
    fn absent_fields_are_absent_rather_than_empty() {
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(found[2].address, None);
        assert_eq!(found[2].hardware_type, None);
    }

    #[test]
    fn reads_whether_a_device_is_online() {
        let found = parse_device_store(DEVICE_STORE);
        assert!(found[0].online);
        assert!(!found[1].online);
    }

    #[test]
    fn keeps_the_wireless_details() {
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(found[2].fortiap_ssid.as_deref(), Some("CorpWiFi"));
        assert_eq!(found[2].fortiap_name.as_deref(), Some("AP-Lobby"));
    }

    #[test]
    fn a_record_with_no_mac_is_dropped() {
        // It could not be matched against anything else the crawl found, so
        // keeping it would only add a duplicate node.
        let out = "Record #1:\n  'hostname' = 'ghost'\nRecord #2:\n  'mac' = 'aa:bb:cc:dd:ee:ff'\n";
        let found = parse_device_store(out);
        assert_eq!(found.len(), 1);
    }

    #[test]
    fn a_record_whose_mac_is_not_a_mac_is_dropped() {
        let out = "Record #1:\n  'mac' = 'unknown'\n  'hostname' = 'ghost'\n";
        assert!(parse_device_store(out).is_empty());
    }

    #[test]
    fn empty_output_is_no_devices_not_a_panic() {
        assert!(parse_device_store("").is_empty());
        assert!(parse_device_store("Record #1:\n").is_empty());
    }

    #[test]
    fn classifies_from_what_the_fortigate_says() {
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(endpoint_class(&found[0]), Some(DeviceClass::Endpoint));
        assert_eq!(endpoint_class(&found[1]), Some(DeviceClass::Printer));
    }

    #[test]
    fn says_nothing_rather_than_guessing() {
        // Record 3 has no hardware type and no OS. Claiming a class here
        // would overwrite whatever the OUI lookup could have contributed.
        let found = parse_device_store(DEVICE_STORE);
        assert_eq!(endpoint_class(&found[2]), None);
    }

    #[test]
    fn notices_a_banner_holding_the_session() {
        assert!(fips_banner_pending(
            "FIPS-CC mode\nYou are about to access a private network\n(Press 'a' to accept)"
        ));
        assert!(!fips_banner_pending("FGT # "));
    }

    #[test]
    fn notices_output_that_stopped_at_a_pager() {
        assert!(pagination_pending(
            "Record #1:\n  'mac' = 'aa'\n--More--\nDo you want to continue? (y/n)"
        ));
        assert!(!pagination_pending("Record #1:\n  'mac' = 'aa'\nFGT # "));
    }

    #[test]
    fn reads_whether_vdoms_are_in_use() {
        let multi = "Hostname: FGT-1\nVirtual domain configuration: multiple\nVersion: FortiGate-60F v7.4.4,build2662,240514 (GA)";
        assert!(parse_system_status(multi).vdoms_enabled);
        let single = "Hostname: FGT-1\nVirtual domain configuration: disable\nVersion: FortiGate-60F v7.4.4,build2662,240514 (GA)";
        assert!(!parse_system_status(single).vdoms_enabled);
    }

    #[test]
    fn a_fortiswitch_status_still_parses() {
        // The FortiSwitch output has no virtual domain line at all, and the
        // new field must not change what was already working.
        let s = parse_system_status(
            "Version: FortiSwitch-224E v7.6.1,build1047,241217 (GA)\nSerial-Number: S224ENTF00000000\nHostname: FSW-224E",
        );
        assert_eq!(s.model.as_deref(), Some("FortiSwitch-224E"));
        assert_eq!(s.hostname.as_deref(), Some("FSW-224E"));
        assert!(!s.vdoms_enabled);
    }
}
