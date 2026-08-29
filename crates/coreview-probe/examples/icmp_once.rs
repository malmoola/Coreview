//! Runs one real ICMP check and prints how it was read.
//!
//! The parsers are unit-tested against captured output; this is for asking a
//! real network what it actually says — an unplugged device on the local LAN
//! answers differently from one that is merely unroutable.
//!
//!     CV_TARGET=192.168.14.250 cargo run -p coreview-probe --example icmp_once
use coreview_probe::icmp::probe_icmp;

#[tokio::main]
async fn main() {
    let target = std::env::var("CV_TARGET").expect("set CV_TARGET");
    let started = std::time::Instant::now();
    let r = probe_icmp("one", &target, 1000, 0).await;
    println!("target   : {target}");
    println!("outcome  : {:?}", r.outcome);
    println!("rtt      : {:?} ms", r.rtt_ms);
    println!("summary  : {}", r.summary);
    println!("took     : {} ms", started.elapsed().as_millis());
}
