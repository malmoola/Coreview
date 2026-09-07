//! HTTP and HTTPS probing.
//!
//! No HTTP client dependency: a health check needs nothing more than "open a
//! connection, send one request line, read the status line" — so that is
//! all this does, hand-rolled over the same `TcpStream` the TCP probe uses,
//! wrapped in TLS for `Https`. 2xx and 3xx are healthy; anything else means
//! the server answered but the application behind it is not, which the
//! operator asked to distinguish rather than have collapsed into "down"
//! with a generic message.

use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;
use tokio_rustls::TlsConnector;

use crate::net::classify_connect_error;
use crate::types::{Outcome, ProbeResult};
use crate::validate::{parse_target, validate_path, validate_port};

/// 200-399 counts as healthy: the server is up and answering. A drill wants
/// proof the application on the backup site is alive and serving, not a full
/// synthetic transaction — a 401 or a 404 still means the process behind it
/// is running.
fn is_healthy_status(code: u16) -> bool {
    (200..400).contains(&code)
}

/// The status code out of a response's first line, e.g. `HTTP/1.1 200 OK`.
fn parse_status_line(line: &str) -> Option<u16> {
    line.trim().split(' ').nth(1)?.parse().ok()
}

/// Never read more than this looking for a status line — a health check
/// reads nothing else, and an oversized or endless response should time out
/// as a probe failure, not grow an unbounded buffer.
const MAX_STATUS_LINE_BYTES: usize = 8192;

async fn read_status_line<S: AsyncRead + Unpin>(stream: &mut S) -> std::io::Result<String> {
    let mut buf = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        if buf.len() >= MAX_STATUS_LINE_BYTES {
            break;
        }
        if stream.read(&mut byte).await? == 0 {
            break;
        }
        buf.push(byte[0]);
        if buf.ends_with(b"\n") {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn request_line(host: &str, path: &str) -> String {
    format!("GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Coreview\r\nConnection: close\r\n\r\n")
}

/// Timeout-bounded HTTP GET. `port` defaults to 80.
pub async fn probe_http(
    probe_id: &str,
    raw_target: &str,
    port: Option<u32>,
    path: Option<&str>,
    timeout_ms: u64,
    now_ms: i64,
) -> ProbeResult {
    let target = match parse_target(raw_target) {
        Ok(t) => t,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };
    let port = match validate_port(port.unwrap_or(80)) {
        Ok(p) => p,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };
    let path = match validate_path(path) {
        Ok(p) => p,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };

    let host = target.as_str();
    let addr = format!("{host}:{port}");
    let started = Instant::now();
    let deadline = Duration::from_millis(timeout_ms);

    let mut stream = match timeout(deadline, TcpStream::connect(&addr)).await {
        Err(_) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::Timeout,
                &format!("Connection to {addr} timed out"),
            )
        }
        Ok(Err(e)) => {
            let (outcome, summary) = classify_connect_error(&e, port);
            return ProbeResult::failed(probe_id, now_ms, outcome, &summary);
        }
        Ok(Ok(s)) => s,
    };

    finish_http_exchange(probe_id, &mut stream, &host, &path, deadline, started, now_ms).await
}

/// Timeout-bounded HTTPS GET. `port` defaults to 443. `ignore_cert_errors`
/// skips certificate validation entirely — for a backup site on an internal
/// CA or a self-signed endpoint, where a failover drill cares whether the
/// application answers, not whether the certificate chains to a public
/// root. Left off, a bad certificate is reported as `CertificateError`
/// rather than folded into a generic connection failure.
pub async fn probe_https(
    probe_id: &str,
    raw_target: &str,
    port: Option<u32>,
    path: Option<&str>,
    ignore_cert_errors: bool,
    timeout_ms: u64,
    now_ms: i64,
) -> ProbeResult {
    let target = match parse_target(raw_target) {
        Ok(t) => t,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };
    let port = match validate_port(port.unwrap_or(443)) {
        Ok(p) => p,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };
    let path = match validate_path(path) {
        Ok(p) => p,
        Err(e) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::InvalidTarget, &e.to_string())
        }
    };

    let host = target.as_str();
    let addr = format!("{host}:{port}");
    let started = Instant::now();
    let deadline = Duration::from_millis(timeout_ms);

    let tcp = match timeout(deadline, TcpStream::connect(&addr)).await {
        Err(_) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::Timeout,
                &format!("Connection to {addr} timed out"),
            )
        }
        Ok(Err(e)) => {
            let (outcome, summary) = classify_connect_error(&e, port);
            return ProbeResult::failed(probe_id, now_ms, outcome, &summary);
        }
        Ok(Ok(s)) => s,
    };

    let server_name = match rustls_pki_types::ServerName::try_from(host.clone()) {
        Ok(n) => n,
        Err(e) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::InvalidTarget,
                &format!("Not a usable TLS server name: {e}"),
            )
        }
    };

    let connector = TlsConnector::from(tls_config(ignore_cert_errors));
    let mut stream = match timeout(deadline, connector.connect(server_name, tcp)).await {
        Err(_) => {
            return ProbeResult::failed(probe_id, now_ms, Outcome::Timeout, "TLS handshake timed out")
        }
        Ok(Err(e)) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::CertificateError,
                &format!("TLS handshake failed: {e}"),
            )
        }
        Ok(Ok(s)) => s,
    };

    finish_http_exchange(probe_id, &mut stream, &host, &path, deadline, started, now_ms).await
}

/// The part `probe_http` and `probe_https` share once they have a connected
/// stream — plain or TLS-wrapped makes no difference from here on, since
/// both implement `AsyncRead`/`AsyncWrite`.
async fn finish_http_exchange<S>(
    probe_id: &str,
    stream: &mut S,
    host: &str,
    path: &str,
    deadline: Duration,
    started: Instant,
    now_ms: i64,
) -> ProbeResult
where
    S: AsyncRead + AsyncWrite + Unpin,
{
    let request = request_line(host, path);
    if timeout(deadline, stream.write_all(request.as_bytes())).await.is_err() {
        return ProbeResult::failed(probe_id, now_ms, Outcome::Timeout, "Request timed out");
    }

    let line = match timeout(deadline, read_status_line(stream)).await {
        Err(_) => {
            return ProbeResult::failed(
                probe_id,
                now_ms,
                Outcome::Timeout,
                "Waiting for a response timed out",
            )
        }
        Ok(Err(e)) => return ProbeResult::failed(probe_id, now_ms, Outcome::OsError, &e.to_string()),
        Ok(Ok(l)) => l,
    };

    let Some(code) = parse_status_line(&line) else {
        return ProbeResult::failed(
            probe_id,
            now_ms,
            Outcome::OsError,
            &format!("No parseable HTTP status line: {line:?}"),
        );
    };

    let rtt = started.elapsed().as_secs_f64() * 1000.0;
    if is_healthy_status(code) {
        ProbeResult {
            probe_id: probe_id.to_string(),
            timestamp_ms: now_ms,
            outcome: Outcome::Success,
            rtt_ms: Some(rtt),
            resolved: vec![],
            summary: format!("HTTP {code}, {rtt:.0} ms"),
            error_message: None,
        }
    } else {
        ProbeResult {
            probe_id: probe_id.to_string(),
            timestamp_ms: now_ms,
            outcome: Outcome::HttpError,
            rtt_ms: Some(rtt),
            resolved: vec![],
            summary: format!("HTTP {code}"),
            error_message: Some(format!("HTTP {code}")),
        }
    }
}

/// `ignore_cert_errors` builds a client config with a verifier that accepts
/// anything; otherwise the standard WebPKI verifier against Mozilla's root
/// list (bundled via `webpki-roots` rather than the OS trust store, so
/// behaviour does not vary between Windows and Linux builds).
fn tls_config(ignore_cert_errors: bool) -> Arc<rustls::ClientConfig> {
    if ignore_cert_errors {
        let cfg = rustls::ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(AcceptAnyCert))
            .with_no_client_auth();
        Arc::new(cfg)
    } else {
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        let cfg = rustls::ClientConfig::builder()
            .with_root_certificates(roots)
            .with_no_client_auth();
        Arc::new(cfg)
    }
}

/// A verifier that accepts any certificate, for `ignore_cert_errors`. Used
/// only when a probe explicitly opts in — per-probe, never a default — for
/// an internal CA or self-signed endpoint where the thing worth proving is
/// "the application answers", not "the certificate chains to a public root".
#[derive(Debug)]
struct AcceptAnyCert;

impl rustls::client::danger::ServerCertVerifier for AcceptAnyCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls_pki_types::CertificateDer<'_>,
        _intermediates: &[rustls_pki_types::CertificateDer<'_>],
        _server_name: &rustls_pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls_pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls_pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        rustls::crypto::aws_lc_rs::default_provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_status_line() {
        assert_eq!(parse_status_line("HTTP/1.1 200 OK\r\n"), Some(200));
        assert_eq!(parse_status_line("HTTP/1.0 404 Not Found"), Some(404));
        assert_eq!(parse_status_line("HTTP/1.1 301 Moved Permanently"), Some(301));
    }

    #[test]
    fn rejects_garbage_status_lines() {
        assert_eq!(parse_status_line(""), None);
        assert_eq!(parse_status_line("not an http response"), None);
        assert_eq!(parse_status_line("HTTP/1.1"), None);
    }

    #[test]
    fn success_range_is_2xx_and_3xx_only() {
        assert!(!is_healthy_status(199));
        assert!(is_healthy_status(200));
        assert!(is_healthy_status(301));
        assert!(is_healthy_status(399));
        assert!(!is_healthy_status(400));
        assert!(!is_healthy_status(404));
        assert!(!is_healthy_status(500));
    }

    #[test]
    fn request_line_has_no_stray_crlf_from_a_clean_path() {
        let r = request_line("example.com", "/health");
        assert_eq!(r, "GET /health HTTP/1.1\r\nHost: example.com\r\nUser-Agent: Coreview\r\nConnection: close\r\n\r\n");
    }

    /// A live round trip against loopback: no server framework, just a raw
    /// TCP listener writing a real status line, proving the client side
    /// actually parses what a real socket hands back rather than only what
    /// a hand-typed string looks like.
    #[tokio::test]
    async fn a_real_socket_round_trip_reports_success() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n")
                .await;
        });
        let result = probe_http("p1", &addr.ip().to_string(), Some(addr.port() as u32), None, 2000, 0)
            .await;
        assert_eq!(result.outcome, Outcome::Success);
        assert_eq!(result.summary, format!("HTTP 204, {:.0} ms", result.rtt_ms.unwrap()));
    }

    #[tokio::test]
    async fn a_5xx_is_reported_as_http_error_not_down_with_no_reason() {
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(b"HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n")
                .await;
        });
        let result = probe_http("p1", &addr.ip().to_string(), Some(addr.port() as u32), None, 2000, 0)
            .await;
        assert_eq!(result.outcome, Outcome::HttpError);
        assert_eq!(result.summary, "HTTP 503");
    }

    #[tokio::test]
    async fn nothing_listening_is_refused_not_down_with_no_reason() {
        // Bind and drop to get a port nothing is listening on.
        use tokio::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        drop(listener);
        let result = probe_http("p1", &addr.ip().to_string(), Some(addr.port() as u32), None, 500, 0)
            .await;
        assert_eq!(result.outcome, Outcome::Refused);
    }
}
