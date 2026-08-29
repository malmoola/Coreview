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
    #[error("{host} answered SNMP but returned nothing from the system group — the credentials are probably wrong for this device, or the view does not include it")]
    NothingReturned { host: String },
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
    /// The socket itself could not exchange packets. On UDP this is what an
    /// ICMP port-unreachable looks like: the host is up, nothing is bound to
    /// the SNMP port. The library reports it as "Socket receive error", which
    /// says nothing a person can act on.
    #[error("Could not exchange SNMP packets with {host}:{port}. The host is reachable, so most likely nothing is listening on that port — SNMP is off by default on most devices — or a firewall rejected it. Check SNMP is enabled and that this machine is in the device's allowed hosts.")]
    NoListener { host: String, port: u16 },
    /// Authentication was refused, which SNMPv3 reports identically whether the
    /// password is wrong or the algorithms are. Kept separate so the message
    /// can say so, because a user staring at "not authenticated" has no way to
    /// tell which of the two it is and will usually retype the password.
    #[error("{host} does not have an SNMPv3 user called {username:?}")]
    V3NoSuchUser { host: String, username: String },
    #[error("{host} refused the SNMPv3 user {username:?}. SNMPv3 reports a wrong password and a wrong algorithm the same way, so check both — the device was sent {auth} authentication and {privacy} privacy. A device where v3 is not configured at all also fails like this.")]
    V3Refused {
        host: String,
        username: String,
        auth: String,
        privacy: String,
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
                    _ => return Err(describe_v3_failure(host, port, auth, original)),
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

    // v3 engine discovery is unauthenticated, so a wrong user or a wrong
    // algorithm pair does not fail at init — it fails here, on the first real
    // request. The failure has to be described in both places or the useful
    // message never appears, which is exactly what happened the first time
    // this was pointed at a Palo Alto.
    let pdu = tokio::time::timeout(timeout, session.get_many(&refs))
        .await
        .map_err(|_| SnmpError::Timeout {
            host: host.into(),
            timeout,
        })?
        .map_err(|e| describe_v3_failure(host, port, auth, e))?;

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

    // An answer with nothing in it is not success. A device with the wrong
    // credentials, or a view that excludes the system group, replies without
    // erroring and leaves every field empty — and reporting that as a
    // successful identification puts a nameless row on the diagram and hides
    // the real problem. Seen on a UniFi switch whose v3 user did not match.
    if identity.name.is_none() && identity.description.is_none() && identity.object_id.is_none() {
        return Err(SnmpError::NothingReturned { host: host.into() });
    }

    Ok(identity)
}

/// Maps a library error to ours, separating "the socket could not talk to
/// anything" from a genuine protocol problem.
fn protocol_error(host: &str, port: u16, source: snmp2::Error) -> SnmpError {
    match source {
        snmp2::Error::Send | snmp2::Error::Receive => SnmpError::NoListener {
            host: host.into(),
            port,
        },
        other => SnmpError::Protocol {
            host: host.into(),
            source: other,
        },
    }
}

/// Turns a v3 authentication failure into something actionable.
///
/// Anything else is passed through unchanged: a timeout or a socket problem is
/// already clear, and rewording it would only hide the cause.
fn describe_v3_failure(host: &str, port: u16, auth: &SnmpAuth, source: snmp2::Error) -> SnmpError {
    let SnmpAuth::V3 {
        username,
        auth_protocol,
        privacy,
        ..
    } = auth
    else {
        return protocol_error(host, port, source);
    };

    match source {
        // The device knows its own user list, and this is the one case where
        // it says so plainly. Worth its own message: no amount of checking
        // algorithms will help.
        snmp2::Error::AuthFailure(snmp2::v3::AuthErrorKind::UsernameMismatch) => {
            SnmpError::V3NoSuchUser {
                host: host.into(),
                username: username.clone(),
            }
        }
        snmp2::Error::AuthFailure(_) => SnmpError::V3Refused {
            host: host.into(),
            username: username.clone(),
            auth: format!("{auth_protocol:?}").to_lowercase(),
            privacy: privacy
                .map(|p| format!("{p:?}").to_lowercase())
                .unwrap_or_else(|| "none".into()),
        },
        other => protocol_error(host, port, other),
    }
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
    fn a_refused_v3_user_is_told_it_could_be_either_thing() {
        // Found on a Palo Alto: twelve algorithm pairs all reported "not
        // authenticated", which is what a device with no v3 user configured
        // says and also what a wrong algorithm says. Someone reading it will
        // retype the password, which is the one thing that will not help.
        let auth = SnmpAuth::V3 {
            username: "palo".into(),
            auth_protocol: AuthKind::Sha1,
            auth_password: "secret".into(),
            privacy: Some(PrivKind::Aes128),
            privacy_password: "secret".into(),
        };
        let err = describe_v3_failure(
            "10.1.1.1",
            161,
            &auth,
            snmp2::Error::AuthFailure(snmp2::v3::AuthErrorKind::NotAuthenticated),
        );
        let msg = err.to_string();
        assert!(msg.contains("palo"), "{msg}");
        assert!(msg.contains("sha1") && msg.contains("aes128"), "it must name what was tried: {msg}");
        assert!(msg.contains("not configured at all"), "the third possibility: {msg}");
        assert!(!msg.contains("secret"), "the password leaked: {msg}");
    }

    #[test]
    fn a_username_the_device_does_not_have_says_exactly_that() {
        // The device knows its own user list, and no amount of trying
        // algorithms would help here.
        let auth = SnmpAuth::V3 {
            username: "nobody".into(),
            auth_protocol: AuthKind::Sha1,
            auth_password: "secret".into(),
            privacy: None,
            privacy_password: String::new(),
        };
        let err = describe_v3_failure(
            "10.1.1.1",
            161,
            &auth,
            snmp2::Error::AuthFailure(snmp2::v3::AuthErrorKind::UsernameMismatch),
        );
        assert!(matches!(err, SnmpError::V3NoSuchUser { .. }), "{err}");
        assert!(err.to_string().contains("nobody"));
    }

    /// "Socket receive error" is what the library says when an ICMP
    /// port-unreachable comes back, which is the ordinary case of SNMP simply
    /// being switched off. It was reaching the operator verbatim.
    #[test]
    fn nothing_listening_says_so_instead_of_socket_receive_error() {
        let auth = SnmpAuth::V2c { community: "public".into() };
        for source in [snmp2::Error::Receive, snmp2::Error::Send] {
            let err = describe_v3_failure("192.168.14.195", 161, &auth, source);
            assert!(matches!(err, SnmpError::NoListener { .. }), "{err}");
            let msg = err.to_string();
            assert!(msg.contains("192.168.14.195:161"), "{msg}");
            assert!(msg.contains("nothing is listening"), "{msg}");
            assert!(!msg.contains("Socket receive error"), "{msg}");
        }
    }

    #[test]
    fn a_non_authentication_error_is_passed_through_unchanged() {
        // A timeout or socket problem is already clear; rewording it hides the
        // cause.
        let auth = SnmpAuth::V2c { community: "public".into() };
        let err = describe_v3_failure("10.1.1.1", 161, &auth, snmp2::Error::AsnParse);
        assert!(matches!(err, SnmpError::Protocol { .. }));

        // And a v3 user hitting something that is not an auth problem.
        let v3 = SnmpAuth::V3 {
            username: "x".into(),
            auth_protocol: AuthKind::Sha1,
            auth_password: "y".into(),
            privacy: None,
            privacy_password: String::new(),
        };
        assert!(matches!(
            describe_v3_failure("10.1.1.1", 161, &v3, snmp2::Error::AsnParse),
            SnmpError::Protocol { .. }
        ));
    }

    #[test]
    fn an_empty_identity_is_not_a_successful_identification() {
        // The check that turns "answered with nothing" into an error rather
        // than a nameless device on the diagram.
        let empty = SnmpIdentity::default();
        assert!(empty.name.is_none() && empty.description.is_none() && empty.object_id.is_none());

        // Anything real is enough to keep.
        let named = SnmpIdentity { name: Some("SW1".into()), ..Default::default() };
        assert!(named.name.is_some());
    }

    #[test]
    fn nothing_useful_stays_unknown() {
        assert_eq!(classify_identity(&SnmpIdentity::default()), DeviceClass::Unknown);
    }
}
