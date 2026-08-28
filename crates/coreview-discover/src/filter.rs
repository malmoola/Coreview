//! Choosing which discovered devices you actually want.
//!
//! Discovery on a real network finds far more than anyone wants to draw: every
//! phone, every access point, every laptop that happened to be plugged in. The
//! workflow this supports is discover-then-filter-then-build — the crawl
//! collects everything it can see, and nothing reaches the diagram until it
//! has passed a filter the user set.
//!
//! Two separate ideas share this module and must not be confused:
//!
//! * `should_crawl` — may the crawler *connect* to this device and ask it for
//!   neighbours? Getting this wrong wastes connection attempts and can walk
//!   the crawl out of the estate you meant to survey.
//! * `matches` — should this device appear in the *results*? Getting this
//!   wrong only changes what you see, and is freely adjustable after the fact.
//!
//! A device can pass one and not the other. An access point should usually be
//! shown but not crawled into; a switch in a subnet you excluded should be
//! neither.

use coreview_probe::sweep::{within_any, Cidr};

use crate::types::{DeviceClass, Neighbor};

/// What the user wants out of a discovery run.
///
/// Every field is "unset means allow everything", so a default filter is a
/// pass-through and a UI can start permissive.
#[derive(Debug, Clone, Default)]
pub struct DiscoveryFilter {
    /// Only devices with an address inside one of these subnets. Empty means
    /// no subnet restriction.
    pub subnets: Vec<Cidr>,
    /// Only these classes. Empty means every class.
    pub classes: Vec<DeviceClass>,
    /// Substring match on name, address or platform, case-insensitive. Empty
    /// means no text restriction.
    pub search: String,
    /// Addresses or subnets to exclude outright, applied after everything
    /// else. This is the "not that one" escape hatch.
    pub exclude_subnets: Vec<Cidr>,
    /// Device names to exclude, matched case-insensitively as substrings.
    pub exclude_names: Vec<String>,
    /// Classes the crawler may connect to. Empty means the infrastructure
    /// default rather than "everything" — connecting to every discovered
    /// endpoint is never what someone meant.
    pub crawl_classes: Vec<DeviceClass>,
}

impl DiscoveryFilter {
    /// A filter that lets everything through, for "show me what is out there".
    pub fn permissive() -> Self {
        Self::default()
    }

    /// The common case: infrastructure only, inside these subnets.
    pub fn infrastructure_in(subnets: Vec<Cidr>) -> Self {
        Self {
            subnets,
            classes: DeviceClass::INFRASTRUCTURE.to_vec(),
            ..Self::default()
        }
    }

    /// Whether a discovered device should appear in the results.
    pub fn matches(&self, n: &Neighbor) -> bool {
        if !self.classes.is_empty() && !self.classes.contains(&n.class) {
            return false;
        }
        if !self.subnets.is_empty() && !self.has_address_in(n, &self.subnets) {
            return false;
        }
        if !self.exclude_subnets.is_empty() && self.has_address_in(n, &self.exclude_subnets) {
            return false;
        }
        let name_lower = n.short_name.to_ascii_lowercase();
        let id_lower = n.device_id.to_ascii_lowercase();
        if self
            .exclude_names
            .iter()
            .any(|e| !e.is_empty() && (name_lower.contains(&e.to_ascii_lowercase()) || id_lower.contains(&e.to_ascii_lowercase())))
        {
            return false;
        }
        if !self.search.trim().is_empty() && !self.matches_search(n) {
            return false;
        }
        true
    }

    /// Whether the crawler may connect to this device and ask it for its
    /// neighbours.
    ///
    /// Stricter than `matches` on purpose. Subnet limits are enforced here
    /// even when the device would be shown, because the subnet list is how a
    /// user says "stay inside my estate" — the Python original had exactly
    /// this check, and without it a crawl follows a WAN link into somebody
    /// else's network.
    pub fn should_crawl(&self, n: &Neighbor) -> bool {
        let allowed = if self.crawl_classes.is_empty() {
            DeviceClass::INFRASTRUCTURE.to_vec()
        } else {
            self.crawl_classes.clone()
        };
        if !allowed.contains(&n.class) {
            return false;
        }
        if !self.exclude_subnets.is_empty() && self.has_address_in(n, &self.exclude_subnets) {
            return false;
        }
        let name_lower = n.short_name.to_ascii_lowercase();
        if self
            .exclude_names
            .iter()
            .any(|e| !e.is_empty() && name_lower.contains(&e.to_ascii_lowercase()))
        {
            return false;
        }
        // A device with no address cannot be crawled whatever the filter says.
        if n.addresses.is_empty() {
            return false;
        }
        if self.subnets.is_empty() {
            return true;
        }
        self.has_address_in(n, &self.subnets)
    }

    fn has_address_in(&self, n: &Neighbor, subnets: &[Cidr]) -> bool {
        n.addresses.iter().any(|a| within_any(&a.ip, subnets))
    }

    fn matches_search(&self, n: &Neighbor) -> bool {
        let q = self.search.trim().to_ascii_lowercase();
        n.short_name.to_ascii_lowercase().contains(&q)
            || n.device_id.to_ascii_lowercase().contains(&q)
            || n.platform.as_deref().unwrap_or("").to_ascii_lowercase().contains(&q)
            || n.addresses.iter().any(|a| a.ip.contains(&q))
    }

    /// Applies the filter to a list, keeping order.
    pub fn apply<'a>(&self, all: &'a [Neighbor]) -> Vec<&'a Neighbor> {
        all.iter().filter(|n| self.matches(n)).collect()
    }
}

/// A count of what a discovery run found, by class.
///
/// The filter UI needs this to say "Switch (12)" beside each checkbox, and it
/// has to be computed on the *unfiltered* set or the numbers change as you
/// tick boxes, which is maddening.
pub fn count_by_class(all: &[Neighbor]) -> Vec<(DeviceClass, usize)> {
    DeviceClass::ALL
        .iter()
        .map(|c| (*c, all.iter().filter(|n| n.class == *c).count()))
        .filter(|(_, n)| *n > 0)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DeviceAddress, Protocol};
    use coreview_probe::sweep::parse_cidr;

    fn device(name: &str, ip: &str, class: DeviceClass) -> Neighbor {
        Neighbor {
            device_id: format!("{name}.lab.example.com"),
            short_name: name.to_string(),
            addresses: if ip.is_empty() {
                vec![]
            } else {
                vec![DeviceAddress::new(ip)]
            },
            local_interface: Some("Gi0/1".into()),
            remote_interface: Some("Gi0/2".into()),
            platform: Some("WS-C2960".into()),
            capabilities: vec!["Switch".into()],
            version: None,
            class,
            discovered_by: Protocol::Cdp,
        }
    }

    fn estate() -> Vec<Neighbor> {
        vec![
            device("CORE-1", "10.1.1.1", DeviceClass::Switch),
            device("EDGE-RTR", "10.1.1.2", DeviceClass::Router),
            device("AP-FLOOR2", "10.9.9.5", DeviceClass::AccessPoint),
            device("SEP0011", "10.9.9.6", DeviceClass::Phone),
            device("PARTNER-SW", "192.168.50.1", DeviceClass::Switch),
        ]
    }

    #[test]
    fn a_default_filter_lets_everything_through() {
        let f = DiscoveryFilter::permissive();
        assert_eq!(f.apply(&estate()).len(), 5);
    }

    #[test]
    fn filtering_by_class_is_the_headline_case() {
        // "Show me switches and routers, not the four hundred phones."
        let f = DiscoveryFilter {
            classes: vec![DeviceClass::Switch, DeviceClass::Router],
            ..Default::default()
        };
        let kept: Vec<_> = f.apply(&estate()).iter().map(|n| n.short_name.clone()).collect();
        assert_eq!(kept, vec!["CORE-1", "EDGE-RTR", "PARTNER-SW"]);
    }

    #[test]
    fn filtering_by_subnet_keeps_the_survey_inside_the_estate() {
        let f = DiscoveryFilter {
            subnets: vec![parse_cidr("10.1.1.0/24").unwrap()],
            ..Default::default()
        };
        let kept: Vec<_> = f.apply(&estate()).iter().map(|n| n.short_name.clone()).collect();
        assert_eq!(kept, vec!["CORE-1", "EDGE-RTR"]);
    }

    #[test]
    fn class_and_subnet_filters_combine() {
        let f = DiscoveryFilter::infrastructure_in(vec![parse_cidr("10.0.0.0/8").unwrap()]);
        let kept: Vec<_> = f.apply(&estate()).iter().map(|n| n.short_name.clone()).collect();
        // AP and phone fail on class; PARTNER-SW fails on subnet.
        assert_eq!(kept, vec!["CORE-1", "EDGE-RTR"]);
    }

    #[test]
    fn search_matches_name_address_and_platform() {
        let all = estate();
        let by_name = DiscoveryFilter { search: "core".into(), ..Default::default() };
        assert_eq!(by_name.apply(&all).len(), 1);

        let by_ip = DiscoveryFilter { search: "10.9.9.".into(), ..Default::default() };
        assert_eq!(by_ip.apply(&all).len(), 2);

        let by_platform = DiscoveryFilter { search: "2960".into(), ..Default::default() };
        assert_eq!(by_platform.apply(&all).len(), 5);
    }

    #[test]
    fn exclusions_win_over_inclusions() {
        let f = DiscoveryFilter {
            subnets: vec![parse_cidr("10.0.0.0/8").unwrap()],
            exclude_subnets: vec![parse_cidr("10.9.9.0/24").unwrap()],
            ..Default::default()
        };
        let kept: Vec<_> = f.apply(&estate()).iter().map(|n| n.short_name.clone()).collect();
        assert_eq!(kept, vec!["CORE-1", "EDGE-RTR"]);
    }

    #[test]
    fn a_name_can_be_excluded() {
        let f = DiscoveryFilter {
            exclude_names: vec!["partner".into()],
            ..Default::default()
        };
        assert_eq!(f.apply(&estate()).len(), 4);
    }

    #[test]
    fn crawling_defaults_to_infrastructure_even_with_no_filter_set() {
        // Connecting to every discovered endpoint is never what someone meant.
        let f = DiscoveryFilter::permissive();
        let all = estate();
        assert!(f.should_crawl(&all[0]), "a switch should be crawled");
        assert!(f.should_crawl(&all[1]), "a router should be crawled");
        assert!(!f.should_crawl(&all[2]), "an access point should not");
        assert!(!f.should_crawl(&all[3]), "a phone should not");
    }

    #[test]
    fn a_subnet_limit_stops_the_crawl_leaving_the_estate() {
        // Without this a crawl follows a WAN link into somebody else's
        // network. The Python original had exactly this check.
        let f = DiscoveryFilter {
            subnets: vec![parse_cidr("10.0.0.0/8").unwrap()],
            ..Default::default()
        };
        let all = estate();
        assert!(f.should_crawl(&all[0]));
        assert!(!f.should_crawl(&all[4]), "192.168.50.1 is outside the estate");
    }

    #[test]
    fn showing_a_device_and_crawling_into_it_are_different_questions() {
        // An access point belongs on the diagram but must not be connected to.
        let f = DiscoveryFilter::permissive();
        let ap = &estate()[2];
        assert!(f.matches(ap), "it should be drawn");
        assert!(!f.should_crawl(ap), "but not crawled into");
    }

    #[test]
    fn a_device_with_no_address_cannot_be_crawled() {
        let f = DiscoveryFilter::permissive();
        let orphan = device("NO-IP-SW", "", DeviceClass::Switch);
        assert!(f.matches(&orphan), "it is a real adjacency worth drawing");
        assert!(!f.should_crawl(&orphan), "but there is nothing to connect to");
    }

    #[test]
    fn class_counts_come_from_the_unfiltered_set() {
        // Counts beside the filter checkboxes must not change as boxes are
        // ticked, or the numbers are unusable.
        let counts = count_by_class(&estate());
        assert_eq!(counts.iter().find(|(c, _)| *c == DeviceClass::Switch).unwrap().1, 2);
        assert_eq!(counts.iter().find(|(c, _)| *c == DeviceClass::Phone).unwrap().1, 1);
        // Classes with nothing in them are not offered.
        assert!(!counts.iter().any(|(c, _)| *c == DeviceClass::Camera));
    }
}
