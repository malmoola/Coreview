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

/// FortiSwitches this FortiGate manages, from `show switch-controller
/// managed-switch`.
///
/// A FortiGate that manages a switch is not overhearing an advertisement about
/// it — it is administering it, so the link is certain. Without this the
/// FortiGate is a dead end on the diagram: it cannot run `diagnose`, its LLDP
/// command is rejected, and a crawl that starts there reaches one device and
/// stops.
///
/// The switch is identified by serial number, because that is all the
/// FortiGate says. A FortiSwitch reached directly reports the same serial in
/// `get system status`, which is what lets the two be recognised as one
/// device rather than drawn twice.
pub fn parse_managed_switches(out: &str) -> Vec<Neighbor> {
    let mut found = Vec::new();
    // Depth inside the managed-switch block. A switch is an `edit` at depth 1;
    // anything deeper is a nested `config ports` block, whose own `edit
    // "port1"` lines are ports. Counting rather than latching is what lets
    // the scan resume for the second switch after the first one's ports.
    let mut depth = 0usize;
    for line in out.lines() {
        let t = line.trim();
        if depth == 0 {
            if t.starts_with("config switch-controller managed-switch") {
                depth = 1;
            }
            continue;
        }
        if t.starts_with("config ") {
            depth += 1;
            continue;
        }
        if t == "end" {
            depth -= 1;
            if depth == 0 {
                break;
            }
            continue;
        }
        if depth != 1 {
            continue;
        }
        let Some(rest) = t.strip_prefix("edit ") else {
            continue;
        };
        let serial = rest.trim().trim_matches('"').trim();
        if serial.is_empty() {
            continue;
        }
        found.push(Neighbor {
            device_id: serial.to_string(),
            short_name: serial.to_string(),
            addresses: Vec::new(),
            // FortiLink runs over whichever port is in the FortiLink
            // interface; the config does not say which, and inventing one
            // would put a wrong port label on the diagram.
            local_interface: None,
            remote_interface: None,
            platform: None,
            capabilities: Vec::new(),
            version: None,
            class: DeviceClass::Switch,
            discovered_by: Protocol::FortiLink,
            chassis_id: None,
            vendor: Some("Fortinet".to_string()),
        });
    }
    found
}

/// Every current DHCP lease, which is the best list of named endpoints a
/// restricted account can get.
///
/// `diagnose user-device-store device memory list` is richer, but `diagnose`
/// is refused outright by an admin profile that is not super_admin — the
/// FortiGate answers "Unknown action 0" to the bare word. A read-only account
/// is exactly what anyone sensible gives a discovery tool, so the lease list
/// is what actually runs. It gives a name, a MAC, an address, the DHCP vendor
/// class (which identifies the operating system), and for wireless clients the
/// SSID and the access point they are on.
///
/// Captured from a FortiGate-60F on 7.6.7.
pub fn parse_dhcp_leases(out: &str) -> Vec<Endpoint> {
    let mut found = Vec::new();
    // Leases are grouped under the interface serving them, as a bare line.
    let mut interface: Option<String> = None;
    // Column offsets are read from each group's header rather than assumed,
    // because the widths are a display choice and not a promise.
    let mut columns: Vec<(String, usize)> = Vec::new();

    for line in out.lines() {
        if line.trim().is_empty() {
            continue;
        }
        // The columns after the MAC are fixed width; the first two are
        // tab-separated. Splitting on tabs first is what keeps a hostname
        // containing spaces from being read as two fields.
        let mut parts = line.split('\t');
        let first = parts.next().unwrap_or("").trim();
        let rest: Vec<&str> = parts.filter(|p| !p.trim().is_empty()).collect();

        if first == "IP" {
            columns = header_columns(rest.last().unwrap_or(&""));
            continue;
        }
        if rest.is_empty() {
            // A bare line with no tabs is the interface this group is on.
            if !line.starts_with(' ') || !first.is_empty() {
                interface = Some(first.to_string());
            }
            continue;
        }
        let Some(mac) = rest.first().and_then(|m| normalise_mac(m.trim())) else {
            continue;
        };
        let tail = rest.get(1).copied().unwrap_or("");
        let field = |name: &str| column_value(tail, &columns, name);
        found.push(Endpoint {
            mac,
            address: (!first.is_empty()).then(|| first.to_string()),
            hostname: field("Hostname"),
            // The DHCP vendor class: "MSFT 5.0", "android-dhcp-14", "PS5".
            // The device said this about itself, so it is evidence.
            os_name: field("VCI"),
            interface: interface.clone(),
            fortiap_ssid: field("SSID"),
            fortiap_name: field("AP"),
            hardware_vendor: None,
            hardware_type: None,
            os_version: None,
            // A lease is not a statement that something is connected right
            // now. Claiming otherwise would put a device on the diagram as
            // present when it went home hours ago.
            online: false,
        });
    }
    found
}

fn normalise_mac(v: &str) -> Option<String> {
    crate::arp::normalise_mac(v)
}

/// Where each named column begins, read off the header line.
fn header_columns(header: &str) -> Vec<(String, usize)> {
    let mut out = Vec::new();
    let mut index = 0;
    let bytes: Vec<char> = header.chars().collect();
    while index < bytes.len() {
        if bytes[index] == ' ' {
            index += 1;
            continue;
        }
        let start = index;
        // A label runs until two spaces; one space can sit inside one.
        while index < bytes.len()
            && !(bytes[index] == ' ' && bytes.get(index + 1).is_some_and(|c| *c == ' '))
        {
            index += 1;
        }
        let label: String = bytes[start..index].iter().collect();
        out.push((label.trim().to_string(), start));
        index += 1;
    }
    out
}

/// One column out of a fixed-width row, or `None` when it is blank.
fn column_value(row: &str, columns: &[(String, usize)], name: &str) -> Option<String> {
    let at = columns.iter().position(|(label, _)| label == name)?;
    let start = columns[at].1;
    let end = columns.get(at + 1).map_or(usize::MAX, |(_, s)| *s);
    let chars: Vec<char> = row.chars().collect();
    if start >= chars.len() {
        return None;
    }
    let slice: String = chars[start..end.min(chars.len())].iter().collect();
    let v = slice.trim();
    (!v.is_empty()).then(|| v.to_string())
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
    } else if hint.contains("windows")
        || hint.contains("mac os")
        || hint.contains("linux")
        // DHCP vendor class identifiers, which are what a lease list carries:
        // "MSFT 5.0" is every Windows machine, "android-dhcp-14" every Android.
        || hint.contains("msft")
        || hint.contains("android")
    {
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

#[cfg(test)]
mod dhcp_lease_tests {
    use super::*;

    /// Verbatim from a FortiGate-60F on 7.6.7, tabs and all. The blank
    /// hostnames and blank VCIs are real and are the whole difficulty.
    const LEASES: &str = "Corp_WLAN\n  IP\t\tMAC-Address\t\tHostname            VCI                 SSID                AP                  SERVER-ID           Expiry\n  192.168.1.204\tac:3d:cb:c2:42:eb\tF-1248              MSFT 5.0            RITAJ-IT            PU431F5E19002618    22                  Thu Sep  3 07:51:56 2026\n  192.168.1.205\t42:59:ba:88:dd:cb\tiPhone                                  RITAJ-IT            FP231FTF2309C2FK    22                  Fri Sep  4 21:20:35 2026\nHOME-WIFI\n  IP\t\tMAC-Address\t\tHostname            VCI                 SSID                AP                  SERVER-ID           Expiry\n  10.192.14.21\t1e:6e:5b:f4:f0:a2\t                                        A-R-M-R             PU431F5E19002618    21                  Mon Aug 31 10:37:11 2026\n  10.192.14.18\tda:b6:b2:e8:d8:8d\t                    android-dhcp-14     A-R-M-R             PU431F5E19002618    21                  Wed Sep  2 07:43:07 2026\n  10.192.14.19\tc4:db:ad:99:38:d3\tRingSpotlightCam-d3                     A-R-M-R             PU431F5E19002618    21                  Sat Sep  5 23:45:43 2026\n";

    #[test]
    fn reads_every_lease() {
        assert_eq!(parse_dhcp_leases(LEASES).len(), 5);
    }

    #[test]
    fn reads_a_full_row() {
        let l = &parse_dhcp_leases(LEASES)[0];
        assert_eq!(l.address.as_deref(), Some("192.168.1.204"));
        assert_eq!(l.hostname.as_deref(), Some("F-1248"));
        assert_eq!(l.os_name.as_deref(), Some("MSFT 5.0"));
        assert_eq!(l.fortiap_ssid.as_deref(), Some("RITAJ-IT"));
        assert_eq!(l.fortiap_name.as_deref(), Some("PU431F5E19002618"));
    }

    #[test]
    fn a_hostname_with_a_space_in_its_vci_is_not_split() {
        // "MSFT 5.0" has a space in it. Splitting the row on whitespace would
        // shift every column after it by one and put "5.0" in the SSID.
        let l = &parse_dhcp_leases(LEASES)[0];
        assert_eq!(l.os_name.as_deref(), Some("MSFT 5.0"));
        assert_eq!(l.fortiap_ssid.as_deref(), Some("RITAJ-IT"));
    }

    #[test]
    fn a_blank_hostname_stays_blank_and_does_not_borrow_the_next_column() {
        // The commonest row on a real network: a device that never sent a
        // name. Reading "A-R-M-R" as its hostname would name a dozen devices
        // after the SSID they are on.
        let l = &parse_dhcp_leases(LEASES)[2];
        assert_eq!(l.hostname, None);
        assert_eq!(l.fortiap_ssid.as_deref(), Some("A-R-M-R"));
    }

    #[test]
    fn a_blank_hostname_with_a_vci_still_reads_the_vci() {
        let l = &parse_dhcp_leases(LEASES)[3];
        assert_eq!(l.hostname, None);
        assert_eq!(l.os_name.as_deref(), Some("android-dhcp-14"));
    }

    #[test]
    fn each_lease_carries_the_interface_it_was_served_on() {
        let all = parse_dhcp_leases(LEASES);
        assert_eq!(all[0].interface.as_deref(), Some("Corp_WLAN"));
        assert_eq!(all[2].interface.as_deref(), Some("HOME-WIFI"));
    }

    #[test]
    fn the_header_row_is_not_read_as_a_lease() {
        let all = parse_dhcp_leases(LEASES);
        assert!(all.iter().all(|l| l.hostname.as_deref() != Some("Hostname")));
    }

    #[test]
    fn a_lease_is_not_a_claim_that_the_device_is_here_now() {
        // Leases outlive the device by days. Reporting them as online would
        // put a laptop that went home on the diagram as present.
        assert!(parse_dhcp_leases(LEASES).iter().all(|l| !l.online));
    }

    #[test]
    fn the_mac_matches_the_arp_table_spelling() {
        let l = &parse_dhcp_leases(LEASES)[0];
        assert_eq!(l.mac, crate::arp::normalise_mac("AC3D.CBC2.42EB").expect("valid"));
    }

    #[test]
    fn no_leases_is_no_devices() {
        assert!(parse_dhcp_leases("").is_empty());
        assert!(parse_dhcp_leases("Corp_WLAN\n").is_empty());
    }
}

#[cfg(test)]
mod managed_switch_tests {
    use super::*;

    /// Verbatim from a FortiGate-60F on 7.6.7, trimmed to two switches and
    /// the nested port block that is the whole difficulty.
    const MANAGED: &str = r#"config switch-controller managed-switch
    edit "S224ENTF19001615"
        set sn "S224ENTF19001615"
        set fsw-wan1-peer "Fortilink"
        set fsw-wan1-admin enable
        config ports
            edit "port1"
                set vlan "Printers-FS"
            next
            edit "port2"
                set vlan "_default"
            next
        end
    next
    edit "S248EPTF18001234"
        set sn "S248EPTF18001234"
    next
end
"#;

    #[test]
    fn finds_the_switches_it_manages() {
        let found = parse_managed_switches(MANAGED);
        assert_eq!(
            found.iter().map(|n| n.short_name.as_str()).collect::<Vec<_>>(),
            ["S224ENTF19001615", "S248EPTF18001234"]
        );
    }

    #[test]
    fn a_port_is_not_a_switch() {
        // The nested `config ports` block has its own `edit "port1"` lines.
        // Reading those as switches would put a node on the diagram for every
        // port on every switch.
        let found = parse_managed_switches(MANAGED);
        assert!(found.iter().all(|n| !n.short_name.starts_with("port")));
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn the_link_is_marked_as_fortilink_not_a_discovery_protocol() {
        // The FortiGate administers this switch rather than overhearing it.
        // Labelling it CDP would claim evidence that does not exist.
        let found = parse_managed_switches(MANAGED);
        assert_eq!(found[0].discovered_by, Protocol::FortiLink);
        assert_eq!(found[0].class, DeviceClass::Switch);
    }

    #[test]
    fn no_port_is_claimed_because_the_config_does_not_say() {
        let found = parse_managed_switches(MANAGED);
        assert_eq!(found[0].local_interface, None);
        assert_eq!(found[0].remote_interface, None);
    }

    #[test]
    fn a_fortigate_that_manages_nothing_reports_nothing() {
        assert!(parse_managed_switches("config switch-controller managed-switch\nend\n").is_empty());
        assert!(parse_managed_switches("").is_empty());
    }

    #[test]
    fn other_configuration_is_not_read_as_switches() {
        let other = "config system interface\n    edit \"wan1\"\n    next\nend\n";
        assert!(parse_managed_switches(other).is_empty());
    }
}
