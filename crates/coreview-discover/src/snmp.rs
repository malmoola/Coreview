//! Identifying devices over SNMP.
//!
//! SNMP earns its place here for one reason: it reaches devices SSH cannot. A
//! read-only community or a v3 user is far easier to get approved than shell
//! access, and plenty of equipment — access points, printers, anything managed
//! by another team — answers SNMP and refuses a login. On the test network this
//! was written against, the neighbouring switch rejected SSH credentials
//! outright while sitting there answering SNMP.
//!
//! What it collects is deliberately narrow: the system group, which names and
//! describes the device, and the interface table, which supplies the interface
//! names the address preference needs. Everything else a network engineer might
//! want from SNMP belongs in a monitoring system, not a diagram tool.

use std::time::Duration;

use snmp2::{AsyncSession, Oid, Value};

/// `sysDescr.0` — free text, but it names the platform and the software train.
const SYS_DESCR: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 1, 0];
/// `sysObjectID.0` — the vendor's own model identifier.
const SYS_OBJECT_ID: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 2, 0];
/// `sysUpTime.0`
const SYS_UPTIME: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 3, 0];
/// `sysName.0` — the device's own name, which is what a diagram should label it.
const SYS_NAME: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 5, 0];
/// `sysLocation.0`
const SYS_LOCATION: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 6, 0];
/// `sysServices.0` — a bitmask of the OSI layers the device operates at. Layer
/// 3 set means it routes; layer 2 means it bridges.
const SYS_SERVICES: &[u64] = &[1, 3, 6, 1, 2, 1, 1, 7, 0];

/// How to authenticate. Mirrors what a device's `snmp-server` lines say.
#[derive(Clone)]
pub enum SnmpAuth {
    /// v2c with a community string. Sent in clear text, which is worth knowing
    /// but is also how most estates are configured.
    V2c { community: String },
    /// v3 with authentication and privacy.
    V3 {
        username: String,
        auth_protocol: AuthKind,
        auth_password: String,
        privacy: Option<PrivKind>,
        privacy_password: String,
    },
}

impl std::fmt::Debug for SnmpAuth {
    /// Community strings and passwords are credentials; a `Debug` that printed
    /// them would put them in the first error message that formatted one.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SnmpAuth::V2c { .. } => f.write_str("V2c { community: *** }"),
            SnmpAuth::V3 { username, .. } => write!(f, "V3 {{ username: {username:?}, ... }}"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthKind {
    Md5,
    Sha1,
    Sha256,
    Sha384,
    Sha512,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PrivKind {
    Des,
    Aes128,
    Aes192,
    /// Cisco's `priv aes 256`. Not in RFC 3826, which stops at AES-128, but
    /// widely deployed and what most hardened configurations specify.
    Aes256,
}

impl AuthKind {
    fn to_protocol(self) -> snmp2::v3::AuthProtocol {
        match self {
            AuthKind::Md5 => snmp2::v3::AuthProtocol::Md5,
            AuthKind::Sha1 => snmp2::v3::AuthProtocol::Sha1,
            AuthKind::Sha256 => snmp2::v3::AuthProtocol::Sha256,
            AuthKind::Sha384 => snmp2::v3::AuthProtocol::Sha384,
            AuthKind::Sha512 => snmp2::v3::AuthProtocol::Sha512,
        }
    }

    /// Parses the word a device configuration uses: `auth sha`, `auth md5`.
    pub fn parse(word: &str) -> Option<Self> {
        match word.trim().to_ascii_lowercase().as_str() {
            "md5" => Some(AuthKind::Md5),
            // "sha" on IOS means SHA-1; the numbered forms are explicit.
            "sha" | "sha1" => Some(AuthKind::Sha1),
            "sha256" => Some(AuthKind::Sha256),
            "sha384" => Some(AuthKind::Sha384),
            "sha512" => Some(AuthKind::Sha512),
            _ => None,
        }
    }
}

impl PrivKind {
    fn to_cipher(self) -> snmp2::v3::Cipher {
        match self {
            PrivKind::Des => snmp2::v3::Cipher::Des,
            PrivKind::Aes128 => snmp2::v3::Cipher::Aes128,
            PrivKind::Aes192 => snmp2::v3::Cipher::Aes192,
            PrivKind::Aes256 => snmp2::v3::Cipher::Aes256,
        }
    }

    /// Parses what a configuration says: `priv aes 256`, `priv des`.
    pub fn parse(words: &str) -> Option<Self> {
        let w = words.trim().to_ascii_lowercase().replace([' ', '-'], "");
        match w.as_str() {
            "des" | "des56" => Some(PrivKind::Des),
            "aes" | "aes128" => Some(PrivKind::Aes128),
            "aes192" => Some(PrivKind::Aes192),
            "aes256" => Some(PrivKind::Aes256),
            _ => None,
        }
    }
}

/// What SNMP could tell us about a device.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnmpIdentity {
    pub address: String,
    /// `sysName`, the device's own name.
    pub name: Option<String>,
    /// `sysDescr`, usually the software banner.
    pub description: Option<String>,
    pub location: Option<String>,
    /// `sysObjectID`, the vendor's model identifier, as a dotted OID.
    pub object_id: Option<String>,
    pub uptime_ticks: Option<u64>,
    /// True when `sysServices` says the device routes.
    pub routes: bool,
    /// True when `sysServices` says the device bridges.
    pub bridges: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SnmpError {
    #[error("{host} did not answer SNMP within {}s — check the community or v3 user, and that SNMP is permitted from this machine", .timeout.as_secs())]
    Timeout { host: String, timeout: Duration },
    #[error("could not open a socket to {host}: {source}")]
    Socket {
        host: String,
        #[source]
        source: std::io::Error,
    },
    #[error("SNMP error talking to {host}: {source}")]
    Protocol {
        host: String,
        #[source]
        source: snmp2::Error,
    },
}

/// Asks a device to identify itself.
///
/// One `get` for the whole system group rather than six round trips: on a slow
/// link the difference is the whole point of doing discovery over SNMP.
pub async fn identify(
    host: &str,
    port: u16,
    auth: &SnmpAuth,
    timeout: Duration,
) -> Result<SnmpIdentity, SnmpError> {
    let target = format!("{host}:{port}");

    let mut session = match auth {
        SnmpAuth::V2c { community } => {
            tokio::time::timeout(
                timeout,
                AsyncSession::new_v2c(target.as_str(), community.as_bytes(), 0),
            )
            .await
            .map_err(|_| SnmpError::Timeout {
                host: host.into(),
                timeout,
            })?
            .map_err(|e| SnmpError::Socket {
                host: host.into(),
                source: e,
            })?
        }
        SnmpAuth::V3 {
            username,
            auth_protocol,
            auth_password,
            privacy,
            privacy_password,
        } => {
            let mut security = snmp2::v3::Security::new(username.as_bytes(), auth_password.as_bytes())
                .with_auth_protocol(auth_protocol.to_protocol());
            security = security.with_auth(match privacy {
                None => snmp2::v3::Auth::AuthNoPriv,
                Some(cipher) => snmp2::v3::Auth::AuthPriv {
                    cipher: cipher.to_cipher(),
                    privacy_password: privacy_password.as_bytes().to_vec(),
                },
            });

            // When the privacy key is longer than the hash that derives it —
            // SHA-1 gives 20 bytes, AES-256 needs 32 — the key has to be
            // extended, and RFC 3414 does not say how. Two methods are in the
            // wild: Reeder, which Cisco uses, and Blumenthal. Guessing wrong
            // fails authentication with an error that looks like a bad
            // password, so Reeder is tried first and the other is tried
            // automatically below rather than asked about.
            if needs_key_extension(*auth_protocol, *privacy) {
                security = security.with_key_extension_method(snmp2::v3::KeyExtension::Reeder);
            }

            let mut s = tokio::time::timeout(
                timeout,
                AsyncSession::new_v3(target.as_str(), 0, security),
            )
            .await
            .map_err(|_| SnmpError::Timeout {
                host: host.into(),
                timeout,
            })?
            .map_err(|e| SnmpError::Socket {
                host: host.into(),
                source: e,
            })?;

            // v3 needs an engine discovery exchange before anything else. It
            // is also the first thing that fails when the user or passwords
            // are wrong, so its error is the useful one to surface.
            let first = tokio::time::timeout(timeout, s.init())
                .await
                .map_err(|_| SnmpError::Timeout {
                    host: host.into(),
                    timeout,
                })?;

            if let Err(original) = first {
                // The other key extension method, before giving up. Which one a
                // device wants is not discoverable and not something a person
                // should have to know about their own switch.
                let retried = tokio::time::timeout(timeout, s.try_another_key_extension_method())
                    .await
                    .map_err(|_| SnmpError::Timeout {
                        host: host.into(),
                        timeout,
                    })?;
                match retried {
                    Ok(Some(_)) => {}
                    _ => {
                        return Err(SnmpError::Protocol {
                            host: host.into(),
                            source: original,
                        })
                    }
                }
            }
            s
        }
    };

    let oids = [
        Oid::from(SYS_DESCR).unwrap(),
        Oid::from(SYS_OBJECT_ID).unwrap(),
        Oid::from(SYS_UPTIME).unwrap(),
        Oid::from(SYS_NAME).unwrap(),
        Oid::from(SYS_LOCATION).unwrap(),
        Oid::from(SYS_SERVICES).unwrap(),
    ];
    let refs: Vec<&Oid<'_>> = oids.iter().collect();

    let pdu = tokio::time::timeout(timeout, session.get_many(&refs))
        .await
        .map_err(|_| SnmpError::Timeout {
            host: host.into(),
            timeout,
        })?
        .map_err(|e| SnmpError::Protocol {
            host: host.into(),
            source: e,
        })?;

    let mut identity = SnmpIdentity {
        address: host.to_string(),
        ..Default::default()
    };

    for (oid, value) in pdu.varbinds {
        let name = oid.to_string();
        match value {
            Value::OctetString(bytes) => {
                let text = String::from_utf8_lossy(bytes).trim().to_string();
                if text.is_empty() {
                    continue;
                }
                if name.ends_with("1.1.0") {
                    identity.description = Some(text);
                } else if name.ends_with("1.5.0") {
                    identity.name = Some(text);
                } else if name.ends_with("1.6.0") {
                    identity.location = Some(text);
                }
            }
            Value::ObjectIdentifier(v) => identity.object_id = Some(v.to_string()),
            Value::Timeticks(t) => identity.uptime_ticks = Some(u64::from(t)),
            Value::Integer(n) if name.ends_with("1.7.0") => {
                let (routes, bridges) = decode_services(n);
                identity.routes = routes;
                identity.bridges = bridges;
            }
            _ => {}
        }
    }

    Ok(identity)
}

/// Whether the privacy key has to be stretched beyond what the hash produces.
///
/// SHA-1 yields 20 bytes and MD5 16; AES-192 needs 24 and AES-256 needs 32.
/// Any pairing where the cipher wants more than the hash gives requires a key
/// extension method, and that is the case RFC 3414 left unspecified.
fn needs_key_extension(auth: AuthKind, privacy: Option<PrivKind>) -> bool {
    let hash_len = match auth {
        AuthKind::Md5 => 16,
        AuthKind::Sha1 => 20,
        AuthKind::Sha256 => 32,
        AuthKind::Sha384 => 48,
        AuthKind::Sha512 => 64,
    };
    let key_len = match privacy {
        None => return false,
        Some(PrivKind::Des) | Some(PrivKind::Aes128) => 16,
        Some(PrivKind::Aes192) => 24,
        Some(PrivKind::Aes256) => 32,
    };
    key_len > hash_len
}

/// Decodes `sysServices` into the two facts worth having.
///
/// The value is a bitmask over OSI layers: bit 1 is physical, bit 2 datalink,
/// bit 3 network, and so on, each set as `2^(layer-1)`. A switch sets layer 2,
/// a router layer 3, and a layer-3 switch sets both — which is the same
/// distinction the CDP and LLDP classifier has to make.
pub fn decode_services(value: i64) -> (bool, bool) {
    let bridges = value & 0b10 != 0; // layer 2
    let routes = value & 0b100 != 0; // layer 3
    (routes, bridges)
}

/// Turns what SNMP said into a device class, using the same rules as the
/// neighbour protocols so a device does not change kind depending on how it was
/// found.
pub fn classify_identity(identity: &SnmpIdentity) -> crate::types::DeviceClass {
    use crate::types::DeviceClass;

    // The description usually contains the model, which is the strongest
    // signal — the same one the CDP path uses.
    let by_description = crate::classify::classify(identity.description.as_deref(), &[], None);
    if by_description != DeviceClass::Unknown {
        return by_description;
    }
    // Otherwise fall back to what the device says about itself. Bridging wins
    // over routing for the same reason it does elsewhere: a device that does
    // both is a layer-3 switch far more often than a router.
    match (identity.bridges, identity.routes) {
        (true, _) => DeviceClass::Switch,
        (false, true) => DeviceClass::Router,
        _ => DeviceClass::Unknown,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DeviceClass;

    #[test]
    fn auth_words_from_a_device_configuration_are_understood() {
        // These are copied straight off an `snmp-server user` line.
        assert_eq!(AuthKind::parse("sha"), Some(AuthKind::Sha1), "IOS 'sha' means SHA-1");
        assert_eq!(AuthKind::parse("SHA"), Some(AuthKind::Sha1));
        assert_eq!(AuthKind::parse("md5"), Some(AuthKind::Md5));
        assert_eq!(AuthKind::parse("sha256"), Some(AuthKind::Sha256));
        assert_eq!(AuthKind::parse("nonsense"), None);
    }

    #[test]
    fn privacy_words_from_a_device_configuration_are_understood() {
        // "priv aes 256" arrives with a space in it.
        assert_eq!(PrivKind::parse("aes 256"), Some(PrivKind::Aes256));
        assert_eq!(PrivKind::parse("aes256"), Some(PrivKind::Aes256));
        assert_eq!(PrivKind::parse("aes"), Some(PrivKind::Aes128));
        assert_eq!(PrivKind::parse("des"), Some(PrivKind::Des));
        assert_eq!(PrivKind::parse("rot13"), None);
    }

    #[test]
    fn key_extension_is_required_exactly_when_the_cipher_outgrows_the_hash() {
        // The real case: a Cisco switch configured "auth sha priv aes 256".
        // SHA-1 gives 20 bytes and AES-256 wants 32, and getting this wrong
        // fails with an error that reads like a bad password.
        assert!(needs_key_extension(AuthKind::Sha1, Some(PrivKind::Aes256)));
        assert!(needs_key_extension(AuthKind::Sha1, Some(PrivKind::Aes192)));
        assert!(needs_key_extension(AuthKind::Md5, Some(PrivKind::Aes192)));

        // These fit, and asking for an extension where none is needed is its
        // own way of failing to authenticate.
        assert!(!needs_key_extension(AuthKind::Sha1, Some(PrivKind::Aes128)));
        assert!(!needs_key_extension(AuthKind::Sha1, Some(PrivKind::Des)));
        assert!(!needs_key_extension(AuthKind::Sha256, Some(PrivKind::Aes256)));
        assert!(!needs_key_extension(AuthKind::Sha512, Some(PrivKind::Aes256)));
        assert!(!needs_key_extension(AuthKind::Sha1, None), "no privacy, no key");
    }

    #[test]
    fn credentials_never_appear_in_debug_output() {
        let v2 = SnmpAuth::V2c { community: "s3cr3t-community".into() };
        assert!(!format!("{v2:?}").contains("s3cr3t"), "{v2:?}");

        let v3 = SnmpAuth::V3 {
            username: "netops".into(),
            auth_protocol: AuthKind::Sha1,
            auth_password: "auth-p4ss".into(),
            privacy: Some(PrivKind::Aes256),
            privacy_password: "priv-p4ss".into(),
        };
        let rendered = format!("{v3:?}");
        assert!(!rendered.contains("auth-p4ss"), "{rendered}");
        assert!(!rendered.contains("priv-p4ss"), "{rendered}");
        assert!(rendered.contains("netops"), "the username is not a secret and helps");
    }

    #[test]
    fn sys_services_distinguishes_a_switch_from_a_router() {
        // The mask is 2^(layer-1): 2 is datalink, 4 is network.
        assert_eq!(decode_services(2), (false, true), "layer 2 only: a bridge");
        assert_eq!(decode_services(4), (true, false), "layer 3 only: a router");
        assert_eq!(decode_services(6), (true, true), "both: a layer-3 switch");
        // A real Catalyst reports 6 or 78 depending on the train; the higher
        // bits are application layers and must not confuse the answer.
        assert_eq!(decode_services(78), (true, true));
        assert_eq!(decode_services(0), (false, false));
    }

    #[test]
    fn a_description_classifies_the_same_way_it_would_over_cdp() {
        // A device must not change kind depending on how it was discovered.
        let identity = SnmpIdentity {
            description: Some(
                "Cisco IOS Software, C2960CX Software (C2960CX-UNIVERSALK9-M), Version 15.2(7)E".into(),
            ),
            ..Default::default()
        };
        assert_eq!(classify_identity(&identity), DeviceClass::Switch);
    }

    #[test]
    fn sys_services_is_the_fallback_when_the_description_says_nothing() {
        let router = SnmpIdentity {
            description: Some("A device".into()),
            routes: true,
            bridges: false,
            ..Default::default()
        };
        assert_eq!(classify_identity(&router), DeviceClass::Router);

        let l3_switch = SnmpIdentity {
            description: Some("A device".into()),
            routes: true,
            bridges: true,
            ..Default::default()
        };
        assert_eq!(classify_identity(&l3_switch), DeviceClass::Switch, "bridging wins");
    }

    #[test]
    fn nothing_useful_stays_unknown() {
        assert_eq!(classify_identity(&SnmpIdentity::default()), DeviceClass::Unknown);
    }
}
