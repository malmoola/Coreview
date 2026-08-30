//! The shared vocabulary of discovery.
//!
//! CDP and LLDP describe the same world in different words, so both parsers
//! produce the same `Neighbor` and everything downstream — filtering,
//! classification, topology building — works on one type. Where the protocols
//! genuinely differ, the difference is recorded in `discovered_by` rather than
//! smoothed away, because "this link was learned from LLDP" is worth knowing
//! when a diagram looks wrong.

use std::net::Ipv4Addr;

/// Which neighbour protocol reported an adjacency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    Cdp,
    Lldp,
    /// A FortiGate managing a FortiSwitch over FortiLink. Not a discovery
    /// protocol in the CDP sense — the FortiGate is not overhearing an
    /// advertisement, it is naming a switch it administers. That is a stronger
    /// statement about the link than either protocol makes, and it is the only
    /// way this link is visible on an account that cannot run `diagnose`.
    FortiLink,
}

impl Protocol {
    pub fn label(&self) -> &'static str {
        match self {
            Protocol::Cdp => "CDP",
            Protocol::Lldp => "LLDP",
            Protocol::FortiLink => "FortiLink",
        }
    }
}

/// What kind of thing a discovered device is.
///
/// This is the axis the user filters on: "show me switches and routers, not
/// the four hundred phones". It is deliberately coarse. Finer distinctions
/// (which switch model, which IOS train) belong on the device record, not in a
/// filter people have to reason about.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeviceClass {
    Router,
    Switch,
    Firewall,
    WirelessController,
    AccessPoint,
    Phone,
    Camera,
    Printer,
    Server,
    /// A workstation, laptop, or anything else that is only an endpoint.
    Endpoint,
    /// Advertised something, but nothing that identifies it.
    Unknown,
}

impl DeviceClass {
    /// Every class, so a filter UI can render the full set without hardcoding
    /// a list that drifts from this enum.
    pub const ALL: [DeviceClass; 11] = [
        DeviceClass::Router,
        DeviceClass::Switch,
        DeviceClass::Firewall,
        DeviceClass::WirelessController,
        DeviceClass::AccessPoint,
        DeviceClass::Phone,
        DeviceClass::Camera,
        DeviceClass::Printer,
        DeviceClass::Server,
        DeviceClass::Endpoint,
        DeviceClass::Unknown,
    ];

    /// The classes a topology crawl should walk into by default.
    ///
    /// Crawling into a phone or an access point wastes a connection attempt
    /// and, worse, fills the diagram with leaves nobody asked for. The user
    /// can override this; it is a default, not a rule.
    pub const INFRASTRUCTURE: [DeviceClass; 4] = [
        DeviceClass::Router,
        DeviceClass::Switch,
        DeviceClass::Firewall,
        DeviceClass::WirelessController,
    ];

    pub fn is_infrastructure(&self) -> bool {
        Self::INFRASTRUCTURE.contains(self)
    }

    pub fn label(&self) -> &'static str {
        match self {
            DeviceClass::Router => "Router",
            DeviceClass::Switch => "Switch",
            DeviceClass::Firewall => "Firewall",
            DeviceClass::WirelessController => "Wireless controller",
            DeviceClass::AccessPoint => "Access point",
            DeviceClass::Phone => "Phone",
            DeviceClass::Camera => "Camera",
            DeviceClass::Printer => "Printer",
            DeviceClass::Server => "Server",
            DeviceClass::Endpoint => "Endpoint",
            DeviceClass::Unknown => "Unknown",
        }
    }

    /// The node glyph this maps to on the canvas, matching the `DeviceType`
    /// strings the frontend already knows.
    pub fn device_type(&self) -> &'static str {
        match self {
            DeviceClass::Router => "router",
            DeviceClass::Switch => "core-switch",
            DeviceClass::Firewall => "firewall",
            DeviceClass::WirelessController => "wireless-controller",
            DeviceClass::AccessPoint => "access-point",
            DeviceClass::Phone => "endpoint-client",
            DeviceClass::Camera => "camera-iot",
            DeviceClass::Printer => "printer",
            DeviceClass::Server => "server",
            DeviceClass::Endpoint => "endpoint-client",
            DeviceClass::Unknown => "generic",
        }
    }
}

/// An address learned from a device, with enough context to choose between
/// several sensibly.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceAddress {
    pub ip: String,
    /// Interface the address sits on, when known. CDP and LLDP rarely say;
    /// `show ip interface brief` during a crawl does.
    pub interface: Option<String>,
    /// The device advertised this as its management address.
    pub is_management: bool,
}

impl DeviceAddress {
    pub fn new(ip: impl Into<String>) -> Self {
        Self {
            ip: ip.into(),
            interface: None,
            is_management: false,
        }
    }

    pub fn management(ip: impl Into<String>) -> Self {
        Self {
            ip: ip.into(),
            interface: None,
            is_management: true,
        }
    }

    pub fn on(mut self, interface: impl Into<String>) -> Self {
        self.interface = Some(interface.into());
        self
    }

    /// Loopbacks are the conventional stable management address on Cisco gear:
    /// they stay up when a physical port does not.
    pub fn is_loopback_interface(&self) -> bool {
        self.interface
            .as_deref()
            .map(|i| i.to_ascii_lowercase().starts_with("loopback") || i.to_ascii_lowercase().starts_with("lo"))
            .unwrap_or(false)
    }

    pub fn parsed(&self) -> Option<Ipv4Addr> {
        self.ip.trim().parse().ok()
    }
}

/// Which of a device's addresses a probe should target.
///
/// A device with a loopback, a management VLAN and six physical interfaces has
/// six answers to "what IP is it", and only some of them stay up when the
/// network is having the sort of day you are monitoring for.
#[derive(Debug, Clone, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AddressPreference {
    /// Loopback first, then management, then anything. The right default for
    /// routed networks: a loopback is up as long as the device is.
    #[default]
    Loopback,
    /// The address the device advertises for management.
    Management,
    /// A named interface, for example "Vlan100" or "GigabitEthernet0/0".
    /// Matched case-insensitively on a prefix so "Vlan100" finds "Vlan100"
    /// however the platform capitalises it.
    Interface { name: String },
    /// Whatever was discovered first. Rarely what you want, but honest.
    First,
}

impl AddressPreference {
    /// Picks the address to probe, falling back down the order rather than
    /// returning nothing. A device that was discovered is reachable at *some*
    /// address, and refusing to probe it because the preferred one is absent
    /// would be worse than probing a less stable one and saying so.
    pub fn choose<'a>(&self, addresses: &'a [DeviceAddress]) -> Option<&'a DeviceAddress> {
        let named = |name: &str| {
            addresses.iter().find(|a| {
                a.interface
                    .as_deref()
                    .map(|i| i.to_ascii_lowercase().starts_with(&name.to_ascii_lowercase()))
                    .unwrap_or(false)
            })
        };
        let loopback = || addresses.iter().find(|a| a.is_loopback_interface());
        let management = || addresses.iter().find(|a| a.is_management);

        match self {
            AddressPreference::Loopback => loopback().or_else(management).or(addresses.first()),
            AddressPreference::Management => management().or_else(loopback).or(addresses.first()),
            AddressPreference::Interface { name } => {
                named(name).or_else(management).or_else(loopback).or(addresses.first())
            }
            AddressPreference::First => addresses.first(),
        }
    }
}

/// A device as discovered, whatever protocol found it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighbor {
    /// As advertised, verbatim, including any domain suffix or serial.
    pub device_id: String,
    /// `device_id` reduced to something usable as a diagram label.
    pub short_name: String,
    pub addresses: Vec<DeviceAddress>,
    /// Port on the device we asked.
    pub local_interface: Option<String>,
    /// Port on the neighbour.
    pub remote_interface: Option<String>,
    pub platform: Option<String>,
    /// Capability words as advertised, kept verbatim for display.
    pub capabilities: Vec<String>,
    /// First line of the version or system description.
    pub version: Option<String>,
    pub class: DeviceClass,
    pub discovered_by: Protocol,
    /// The LLDP chassis id, when there was one. Usually a MAC, which is what
    /// lets a neighbour that advertises no address be looked up in the ARP
    /// table of the device that saw it. CDP has no equivalent.
    pub chassis_id: Option<String>,
    /// Who registered the chassis id's MAC prefix, where there is one.
    ///
    /// Only the manufacturer. A vendor does not say what a device is —
    /// Hewlett Packard makes printers and servers and switches — so this
    /// names the maker and stops there rather than guessing a glyph.
    pub vendor: Option<String>,
}

impl Neighbor {
    pub fn address(&self) -> Option<&str> {
        self.addresses.first().map(|a| a.ip.as_str())
    }

    /// The address a probe should aim at, under the given policy.
    pub fn probe_target(&self, preference: &AddressPreference) -> Option<&str> {
        preference.choose(&self.addresses).map(|a| a.ip.as_str())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs() -> Vec<DeviceAddress> {
        vec![
            DeviceAddress::new("10.0.0.1").on("GigabitEthernet0/0"),
            DeviceAddress::management("10.99.0.1").on("Vlan100"),
            DeviceAddress::new("10.255.0.1").on("Loopback0"),
        ]
    }

    #[test]
    fn loopback_is_preferred_by_default() {
        // The point of a loopback: it is up as long as the device is.
        let a = addrs();
        let pick = AddressPreference::default().choose(&a).unwrap();
        assert_eq!(pick.ip, "10.255.0.1");
    }

    #[test]
    fn management_preference_picks_the_advertised_management_address() {
        let a = addrs();
        let pick = AddressPreference::Management.choose(&a).unwrap();
        assert_eq!(pick.ip, "10.99.0.1");
    }

    #[test]
    fn a_named_interface_can_be_selected() {
        let a = addrs();
        let pick = AddressPreference::Interface {
            name: "gigabitethernet0/0".into(),
        }
        .choose(&a)
        .unwrap();
        assert_eq!(pick.ip, "10.0.0.1");
    }

    #[test]
    fn preferences_fall_back_rather_than_returning_nothing() {
        // A device with only a physical address must still be probeable.
        let only = vec![DeviceAddress::new("192.168.1.5").on("GigabitEthernet0/1")];
        assert_eq!(
            AddressPreference::Loopback.choose(&only).unwrap().ip,
            "192.168.1.5"
        );
        assert_eq!(
            AddressPreference::Interface { name: "Vlan999".into() }
                .choose(&only)
                .unwrap()
                .ip,
            "192.168.1.5"
        );
    }

    #[test]
    fn a_device_with_no_addresses_has_nothing_to_probe() {
        assert!(AddressPreference::Loopback.choose(&[]).is_none());
    }

    #[test]
    fn loopback_detection_does_not_match_unrelated_interfaces() {
        assert!(DeviceAddress::new("1.1.1.1").on("Loopback0").is_loopback_interface());
        assert!(DeviceAddress::new("1.1.1.1").on("lo0").is_loopback_interface());
        assert!(!DeviceAddress::new("1.1.1.1").on("Vlan10").is_loopback_interface());
        assert!(!DeviceAddress::new("1.1.1.1").is_loopback_interface());
    }

    #[test]
    fn infrastructure_is_what_a_crawl_should_walk_into() {
        assert!(DeviceClass::Switch.is_infrastructure());
        assert!(DeviceClass::Router.is_infrastructure());
        assert!(DeviceClass::Firewall.is_infrastructure());
        // Walking into these fills the diagram with leaves and wastes
        // connection attempts.
        assert!(!DeviceClass::Phone.is_infrastructure());
        assert!(!DeviceClass::AccessPoint.is_infrastructure());
        assert!(!DeviceClass::Endpoint.is_infrastructure());
    }

    #[test]
    fn every_class_maps_to_a_glyph_the_canvas_knows() {
        // A class with no glyph would silently render as a blank node.
        for c in DeviceClass::ALL {
            assert!(!c.device_type().is_empty(), "{c:?} has no device type");
            assert!(!c.label().is_empty(), "{c:?} has no label");
        }
    }
}
