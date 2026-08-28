//! Deciding what kind of device something is.
//!
//! Three signals, in decreasing order of trust:
//!
//! 1. The platform string. `AIR-CAP2702I` is an access point and nothing else.
//!    This is the strongest signal when it matches, and it is how the Python
//!    crawler decided what to skip.
//! 2. Advertised capabilities. CDP and LLDP both carry these, and a device
//!    that claims Router or Switch usually is one. Weaker than the platform
//!    because a wireless controller claims Switch, and an access point in
//!    bridge mode claims Trans-Bridge.
//! 3. The version or system description, as a last resort for platforms whose
//!    model string says nothing useful.
//!
//! Getting this wrong is not fatal — it changes an icon and whether a device
//! passes a filter — but getting it wrong *consistently* makes the filter
//! useless, so each rule below is anchored to a real product family.

use crate::types::DeviceClass;

/// Classifies a device from whatever the neighbour protocol advertised.
///
/// `capabilities` are the raw words: CDP's "Router Switch IGMP", or LLDP's
/// "Bridge Router" / "W" / "Station Only" depending on how the platform
/// renders them.
pub fn classify(platform: Option<&str>, capabilities: &[String], version: Option<&str>) -> DeviceClass {
    let platform_up = platform.unwrap_or("").to_ascii_uppercase();
    let version_up = version.unwrap_or("").to_ascii_uppercase();

    if let Some(c) = from_platform(&platform_up) {
        return c;
    }
    if let Some(c) = from_capabilities(capabilities) {
        return c;
    }
    if let Some(c) = from_platform(&version_up) {
        return c;
    }
    DeviceClass::Unknown
}

/// Model-string rules, most specific first. Order matters: `AIR-CT5520` is a
/// wireless controller, but it also starts with `AIR-`, so controllers are
/// tested before access points.
fn from_platform(s: &str) -> Option<DeviceClass> {
    if s.is_empty() {
        return None;
    }

    // Wireless controllers, before the AIR- access point rule below.
    const WLC: [&str; 6] = ["AIR-CT", "C9800", "AIRCT", "WLC", "VWLC", "WISM"];
    if WLC.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::WirelessController);
    }

    // Access points.
    const AP: [&str; 6] = ["AIR-", "AIR ", "C9105", "C9115", "C9120", "C9130"];
    if AP.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::AccessPoint);
    }

    // Firewalls. FPR is Firepower; ASA covers the 5500 series.
    const FW: [&str; 6] = ["ASA", "FPR", "FIREPOWER", "PALO ALTO", "PA-", "FORTIGATE"];
    if FW.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Firewall);
    }

    // Phones. SEP is the MAC-derived device ID Cisco phones use.
    const PHONE: [&str; 5] = ["IP PHONE", "CP-", "SEP", "TELEPRESENCE", "DX80"];
    if PHONE.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Phone);
    }

    // Cameras.
    const CAMERA: [&str; 3] = ["CIVS-", "IPCAMERA", "AXIS"];
    if CAMERA.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Camera);
    }

    const PRINTER: [&str; 4] = ["JETDIRECT", "LASERJET", "PRINTER", "KYOCERA"];
    if PRINTER.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Printer);
    }

    // Routers. ISR/ASR/CSR are router families; "CISCO29" style covers the
    // older bare-numeric platform strings.
    const ROUTER: [&str; 8] = ["ISR", "ASR", "CSR", "C8000", "C8200", "C8300", "CISCO19", "CISCO29"];
    if ROUTER.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Router);
    }

    // Switches. Catalyst, Nexus, and the WS- Catalyst prefix.
    const SWITCH: [&str; 8] = ["WS-C", "C9200", "C9300", "C9400", "C9500", "N9K", "N5K", "N7K"];
    if SWITCH.iter().any(|p| s.contains(p)) {
        return Some(DeviceClass::Switch);
    }
    // "Nexus" and "Catalyst" spelled out, as NX-OS version strings do.
    if s.contains("NEXUS") || s.contains("CATALYST") {
        return Some(DeviceClass::Switch);
    }

    None
}

/// Capability rules. CDP words are spelled out; LLDP is either spelled out or
/// reduced to single letters (`R` router, `B` bridge, `W` WLAN AP, `T`
/// telephone, `S` station), depending on the platform.
fn from_capabilities(caps: &[String]) -> Option<DeviceClass> {
    let has = |want: &str| caps.iter().any(|c| c.eq_ignore_ascii_case(want));

    // Checked before Bridge/Switch: an access point advertises both.
    if has("Phone") || has("Telephone") || has("T") {
        return Some(DeviceClass::Phone);
    }
    if has("WLAN Access Point") || has("WLAN-Access-Point") || has("W") {
        return Some(DeviceClass::AccessPoint);
    }
    if has("Router") || has("R") {
        return Some(DeviceClass::Router);
    }
    if has("Switch") || has("Bridge") || has("B") {
        return Some(DeviceClass::Switch);
    }
    // A device that only bridges is an access point or a media converter far
    // more often than it is a switch.
    if has("Trans-Bridge") {
        return Some(DeviceClass::AccessPoint);
    }
    // "Station Only" is LLDP for "I am an endpoint".
    if has("Station Only") || has("Station") || has("S") {
        return Some(DeviceClass::Endpoint);
    }
    if has("Host") {
        return Some(DeviceClass::Endpoint);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn caps(words: &str) -> Vec<String> {
        words.split_whitespace().map(str::to_string).collect()
    }

    #[test]
    fn a_catalyst_is_a_switch() {
        assert_eq!(
            classify(Some("WS-C2960-24TT-L"), &caps("Switch IGMP"), None),
            DeviceClass::Switch
        );
        assert_eq!(
            classify(Some("C9300-48P"), &caps("Router Switch"), None),
            DeviceClass::Switch
        );
    }

    #[test]
    fn a_nexus_is_a_switch_even_though_it_claims_router() {
        // N9Ks advertise Router and Switch. The platform is the stronger
        // signal, and drawing every leaf switch as a router is misleading.
        assert_eq!(
            classify(Some("N9K-C93180YC-EX"), &caps("Router Switch IGMP"), None),
            DeviceClass::Switch
        );
    }

    #[test]
    fn an_isr_is_a_router() {
        assert_eq!(
            classify(Some("ISR4331/K9"), &caps("Router Source-Route-Bridge"), None),
            DeviceClass::Router
        );
    }

    #[test]
    fn an_access_point_is_not_a_switch() {
        // This is the case the Python crawler special-cased, and the one that
        // matters most: APs are numerous and crawling into them is pointless.
        assert_eq!(
            classify(Some("AIR-CAP2702I-E-K9"), &caps("Trans-Bridge"), None),
            DeviceClass::AccessPoint
        );
        assert_eq!(
            classify(Some("AIR-AP3802I-B-K9"), &caps("Trans-Bridge Source-Route-Bridge"), None),
            DeviceClass::AccessPoint
        );
    }

    #[test]
    fn a_wireless_controller_is_not_an_access_point() {
        // AIR-CT5520 starts with AIR-, so ordering decides this one.
        assert_eq!(
            classify(Some("AIR-CT5520-K9"), &caps("Switch"), None),
            DeviceClass::WirelessController
        );
        assert_eq!(
            classify(Some("C9800-40-K9"), &caps("Router Switch"), None),
            DeviceClass::WirelessController
        );
    }

    #[test]
    fn a_phone_is_a_phone_by_platform_or_capability() {
        assert_eq!(
            classify(Some("Cisco IP Phone 8845"), &caps("Host Phone"), None),
            DeviceClass::Phone
        );
        // LLDP-MED from a third-party handset: no useful platform string.
        assert_eq!(classify(None, &caps("Telephone Bridge"), None), DeviceClass::Phone);
    }

    #[test]
    fn firewalls_are_recognised_across_vendors() {
        assert_eq!(classify(Some("ASA5525"), &caps(""), None), DeviceClass::Firewall);
        assert_eq!(classify(Some("FPR-2110"), &caps(""), None), DeviceClass::Firewall);
        assert_eq!(classify(Some("PA-3220"), &caps("Router"), None), DeviceClass::Firewall);
    }

    #[test]
    fn lldp_single_letter_capabilities_are_understood() {
        // Several platforms render LLDP capabilities as letters.
        assert_eq!(classify(None, &caps("R"), None), DeviceClass::Router);
        assert_eq!(classify(None, &caps("B"), None), DeviceClass::Switch);
        assert_eq!(classify(None, &caps("W"), None), DeviceClass::AccessPoint);
        assert_eq!(classify(None, &caps("T"), None), DeviceClass::Phone);
    }

    #[test]
    fn a_workstation_is_an_endpoint() {
        assert_eq!(classify(None, &caps("Station Only"), None), DeviceClass::Endpoint);
        assert_eq!(classify(None, &caps("Host"), None), DeviceClass::Endpoint);
    }

    #[test]
    fn the_version_string_is_a_last_resort() {
        // Some platforms advertise no model at all.
        assert_eq!(
            classify(None, &[], Some("Cisco Nexus Operating System (NX-OS) Software")),
            DeviceClass::Switch
        );
    }

    #[test]
    fn nothing_useful_yields_unknown_rather_than_a_guess() {
        // A wrong class is worse than an honest one: it makes a filter lie.
        assert_eq!(classify(None, &[], None), DeviceClass::Unknown);
        assert_eq!(classify(Some(""), &caps("IGMP"), None), DeviceClass::Unknown);
    }
}
