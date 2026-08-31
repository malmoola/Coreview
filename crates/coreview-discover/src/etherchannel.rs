//! Which physical ports are bundled, from `show etherchannel summary`.
//!
//! Two switches joined by two cables in a LAG are one logical link, and a
//! diagram that draws two is wrong in the way that matters most: it says
//! there are two failure domains where there is one. This reads the bundle
//! table so the drawing can say Po1 once instead of Gi1/0/11 twice.
//!
//! Observation, not inference: D-014 rejected guessing a bundle from
//! consecutive port numbers, and this is the answer to it — the switch's own
//! statement of what is aggregated. The fixture below is verbatim from the
//! lab's Catalyst 9300 (16.12/17.x prints the same shape).

/// One aggregated link, as the switch reports it.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortChannel {
    /// The bundle's own name, e.g. `Po1`.
    pub name: String,
    /// `LACP`, `PAgP` or `-` for static ("on") bundles.
    pub protocol: String,
    /// Member ports as the switch writes them, e.g. `Gi1/0/11` — flags like
    /// `(P)` are stripped, membership is not judged: a suspended member is
    /// still cabled, and the diagram draws cables.
    pub members: Vec<String>,
}

/// Reads `show etherchannel summary`.
///
/// The table starts after the `Group  Port-channel  Protocol    Ports`
/// header. A bundle with many members wraps onto continuation lines that
/// carry only ports; those belong to the bundle above them.
pub fn parse_etherchannel_summary(text: &str) -> Vec<PortChannel> {
    let mut out: Vec<PortChannel> = Vec::new();
    let mut in_table = false;
    for line in text.lines() {
        let trimmed = line.trim();
        if !in_table {
            if trimmed.starts_with("Group") && trimmed.contains("Port-channel") {
                in_table = true;
            }
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('-') || trimmed.starts_with('+') {
            continue;
        }
        let fields: Vec<&str> = trimmed.split_whitespace().collect();
        // A bundle row leads with the numeric group id.
        if fields.first().is_some_and(|f| f.chars().all(|c| c.is_ascii_digit())) {
            if fields.len() < 2 {
                continue;
            }
            let name = fields[1]
                .split('(')
                .next()
                .unwrap_or(fields[1])
                .to_string();
            let protocol = fields.get(2).unwrap_or(&"-").to_string();
            let members = fields[3..].iter().filter_map(|p| member(p)).collect();
            out.push(PortChannel { name, protocol, members });
        } else if let Some(last) = out.last_mut() {
            // Continuation: more member ports for the bundle above.
            last.members.extend(fields.iter().filter_map(|p| member(p)));
        }
    }
    out
}

/// `Gi1/0/11(P)` -> `Gi1/0/11`. Anything without a slash is not a port —
/// it keeps a stray word on a mangled line out of the member list.
fn member(field: &str) -> Option<String> {
    let port = field.split('(').next().unwrap_or(field);
    port.contains('/').then(|| port.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verbatim from the lab 9300, 2026-08-31 — Po1 over Gi1/0/11 + Gi1/0/12
    /// to the 3850, which prints the identical table from its side.
    const NINE_THREE_HUNDRED: &str = "\
Flags:  D - down        P - bundled in port-channel
        I - stand-alone s - suspended
        H - Hot-standby (LACP only)
        R - Layer3      S - Layer2
        U - in use      f - failed to allocate aggregator

        M - not in use, minimum links not met
        u - unsuitable for bundling
        w - waiting to be aggregated
        d - default port

        A - formed by Auto LAG


Number of channel-groups in use: 1
Number of aggregators:           1

Group  Port-channel  Protocol    Ports
------+-------------+-----------+-----------------------------------------------
1      Po1(SU)         LACP        Gi1/0/11(P)     Gi1/0/12(P)
";

    #[test]
    fn reads_the_lab_bundle() {
        let got = parse_etherchannel_summary(NINE_THREE_HUNDRED);
        assert_eq!(
            got,
            vec![PortChannel {
                name: "Po1".into(),
                protocol: "LACP".into(),
                members: vec!["Gi1/0/11".into(), "Gi1/0/12".into()],
            }]
        );
    }

    #[test]
    fn continuation_lines_belong_to_the_bundle_above() {
        let text = "\
Group  Port-channel  Protocol    Ports
------+-------------+-----------+------
1      Po1(SU)         LACP        Gi1/0/1(P)      Gi1/0/2(P)
                                   Gi1/0/3(P)      Gi1/0/4(P)
2      Po2(SD)          -          Gi1/0/5(D)
";
        let got = parse_etherchannel_summary(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].members, vec!["Gi1/0/1", "Gi1/0/2", "Gi1/0/3", "Gi1/0/4"]);
        assert_eq!(got[1].name, "Po2");
        assert_eq!(got[1].protocol, "-");
        assert_eq!(got[1].members, vec!["Gi1/0/5"]);
    }

    #[test]
    fn an_empty_table_is_no_bundles() {
        // The 2960CX before the lab had a LAG: "Number of channel-groups in
        // use: 0" and no rows.
        let text = "Number of channel-groups in use: 0\n\nGroup  Port-channel  Protocol    Ports\n------+-------------+-----------+------\n";
        assert!(parse_etherchannel_summary(text).is_empty());
    }
}
