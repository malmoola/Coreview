//! Input validation. Every probe target crosses this boundary before it can
//! reach a process argument, a socket, or the resolver.

use std::net::IpAddr;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ValidationError {
    #[error("target is empty")]
    Empty,
    #[error("target exceeds 253 characters")]
    TooLong,
    #[error("target contains an illegal character: {0:?}")]
    IllegalChar(char),
    #[error("hostname label is empty or malformed: {0}")]
    BadLabel(String),
    #[error("port must be between 1 and 65535")]
    BadPort,
    #[error("interval must be between 1 and 86400 seconds")]
    BadInterval,
    #[error("timeout must be between 100 and 60000 milliseconds")]
    BadTimeout,
    #[error("threshold must be between 1 and 100")]
    BadThreshold,
    #[error("path must start with '/' and contain no control characters")]
    BadPath,
}

/// A target that has been proven safe to hand to a process argument vector.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Ip(IpAddr),
    Host(String),
}

impl Target {
    pub fn as_str(&self) -> String {
        match self {
            Target::Ip(ip) => ip.to_string(),
            Target::Host(h) => h.clone(),
        }
    }
}

impl std::fmt::Display for Target {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Parse a user-supplied target into an IP address or a DNS hostname.
///
/// Deliberately permissive about *internal* naming conventions (single-label
/// hosts like `core-sw-01`, underscores in SRV-style names, trailing dots) and
/// deliberately strict about anything that could change the meaning of an
/// argument vector or a resolver query: whitespace, quotes, shell
/// metacharacters, control characters, leading dashes.
pub fn parse_target(raw: &str) -> Result<Target, ValidationError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(ValidationError::Empty);
    }
    if trimmed.len() > 253 {
        return Err(ValidationError::TooLong);
    }

    // Accept bracketed IPv6 literals as typed in URLs: [2001:db8::1]
    let unbracketed = trimmed
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or(trimmed);

    if let Ok(ip) = unbracketed.parse::<IpAddr>() {
        return Ok(Target::Ip(ip));
    }

    // A leading '-' would be read as a flag by ping.exe.
    if trimmed.starts_with('-') {
        return Err(ValidationError::IllegalChar('-'));
    }

    let host = trimmed.strip_suffix('.').unwrap_or(trimmed);
    for c in host.chars() {
        let ok = c.is_ascii_alphanumeric() || c == '-' || c == '.' || c == '_';
        if !ok {
            return Err(ValidationError::IllegalChar(c));
        }
    }
    for label in host.split('.') {
        if label.is_empty() || label.len() > 63 {
            return Err(ValidationError::BadLabel(label.to_string()));
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err(ValidationError::BadLabel(label.to_string()));
        }
    }

    Ok(Target::Host(host.to_ascii_lowercase()))
}

pub fn validate_port(port: u32) -> Result<u16, ValidationError> {
    if port == 0 || port > 65535 {
        return Err(ValidationError::BadPort);
    }
    Ok(port as u16)
}

pub fn validate_interval(seconds: u64) -> Result<u64, ValidationError> {
    if !(1..=86_400).contains(&seconds) {
        return Err(ValidationError::BadInterval);
    }
    Ok(seconds)
}

pub fn validate_timeout(ms: u64) -> Result<u64, ValidationError> {
    if !(100..=60_000).contains(&ms) {
        return Err(ValidationError::BadTimeout);
    }
    Ok(ms)
}

pub fn validate_threshold(n: u32) -> Result<u32, ValidationError> {
    if !(1..=100).contains(&n) {
        return Err(ValidationError::BadThreshold);
    }
    Ok(n)
}

/// An HTTP/HTTPS request path, proven safe to write literally into a raw
/// request line. `None` or empty defaults to `/`. Must start with `/` (a
/// full URL is not a path) and carry no control character — a bare `\r` or
/// `\n` would let a target string split a second request into the one this
/// builds by hand.
pub fn validate_path(raw: Option<&str>) -> Result<String, ValidationError> {
    let path = match raw {
        None | Some("") => return Ok("/".to_string()),
        Some(p) => p,
    };
    if path.len() > 2048 || !path.starts_with('/') || path.chars().any(|c| c.is_control()) {
        return Err(ValidationError::BadPath);
    }
    Ok(path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_ipv4_ipv6_and_hostnames() {
        assert!(matches!(parse_target("10.10.10.1"), Ok(Target::Ip(_))));
        assert!(matches!(parse_target("2001:db8::1"), Ok(Target::Ip(_))));
        assert!(matches!(parse_target("[2001:db8::1]"), Ok(Target::Ip(_))));
        assert!(matches!(parse_target("core-sw-01"), Ok(Target::Host(_))));
        assert!(matches!(
            parse_target("firewall.example.net."),
            Ok(Target::Host(_))
        ));
        assert!(matches!(parse_target("_ldap.corp.local"), Ok(Target::Host(_))));
    }

    #[test]
    fn normalizes_case_and_trailing_dot() {
        assert_eq!(
            parse_target(" FW-HQ-01.Corp.Local. ").unwrap().as_str(),
            "fw-hq-01.corp.local"
        );
    }

    /// Test case 19: hostile input must never reach an argument vector.
    #[test]
    fn rejects_injection_shaped_input() {
        let hostile = [
            "10.0.0.1 && calc.exe",
            "10.0.0.1; shutdown -r",
            "10.0.0.1 | net user",
            "$(whoami)",
            "`id`",
            "host\nping evil",
            "host\r\nping evil",
            "10.0.0.1\"",
            "10.0.0.1'",
            "-t 10.0.0.1",
            "..",
            "a..b",
            "-leading",
            "trailing-.com",
            "",
            "   ",
        ];
        for h in hostile {
            assert!(parse_target(h).is_err(), "should have rejected {h:?}");
        }
    }

    #[test]
    fn numeric_bounds() {
        assert!(validate_port(0).is_err());
        assert!(validate_port(65_536).is_err());
        assert_eq!(validate_port(443).unwrap(), 443);
        assert!(validate_interval(0).is_err());
        assert!(validate_timeout(50).is_err());
        assert!(validate_threshold(0).is_err());
    }

    #[test]
    fn path_defaults_to_root() {
        assert_eq!(validate_path(None).unwrap(), "/");
        assert_eq!(validate_path(Some("")).unwrap(), "/");
    }

    #[test]
    fn path_accepts_a_normal_route() {
        assert_eq!(validate_path(Some("/health?deep=1")).unwrap(), "/health?deep=1");
    }

    /// A raw target string ends up on a request line this code writes by
    /// hand: `GET {path} HTTP/1.1\r\n`. A `\r` or `\n` inside the path would
    /// let it inject a second header or a whole second request.
    #[test]
    fn path_rejects_request_splitting() {
        assert!(validate_path(Some("/ok\r\nHost: evil")).is_err());
        assert!(validate_path(Some("/ok\nX-Injected: 1")).is_err());
        assert!(validate_path(Some("no-leading-slash")).is_err());
        assert!(validate_path(Some(&"/".repeat(2049))).is_err());
    }
}
