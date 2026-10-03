//! ADR-0197 S2 acceptance ②: the server route sees ciphertext only.
//!
//! The relay here is the *worst-case* server: it records every byte and writes
//! all of them to its log (raw and hex). The marker planted in the PTY plaintext
//! must still appear 0 times in logs, recorded bytes and counters. Run with
//! `RUSTFLAGS="--cfg sabotage_null_cipher"` to prove this guard can fail (it must RED).

use momo_blind_pty::harness::*;
use momo_blind_pty::session::FrameKind;
use std::io::Write;
use std::sync::{Arc, Mutex};
use tracing_subscriber::fmt::MakeWriter;

const MARKER: &str = "OORT-S2-MARKER-7f3a91c2-do-not-leak";

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);
struct W(Arc<Mutex<Vec<u8>>>);

impl Write for W {
    fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(b);
        Ok(b.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

impl<'a> MakeWriter<'a> for Capture {
    type Writer = W;
    fn make_writer(&'a self) -> W {
        W(self.0.clone())
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn count(hay: &[u8], needle: &[u8]) -> usize {
    hay.windows(needle.len()).filter(|w| *w == needle).count()
}

#[test]
fn relay_logs_metrics_and_recorded_bytes_contain_no_plaintext() {
    let cap = Capture::default();
    let sub = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_ansi(false)
        .with_writer(cap.clone())
        .finish();

    let (relay, plaintext_seen_by_endpoints) = tracing::subscriber::with_default(sub, || {
        let mut relay = BlindRelay {
            log_everything: true,
            ..Default::default()
        };
        let mut f = Fixture::new();
        let (mut dev, mut bx) = f.attach(&mut relay).unwrap();
        let mut at_endpoints = 0;
        for i in 0..20 {
            let line = format!("echo {MARKER} #{i}\n");
            let w = dev.seal(FrameKind::Data, line.as_bytes()).unwrap();
            let w = relay.forward(Dir::DeviceToBox, w).remove(0);
            let (_, got) = bx.open(&w).unwrap();
            at_endpoints += count(&got, MARKER.as_bytes());
            let w = bx.seal(FrameKind::Data, line.as_bytes()).unwrap();
            let w = relay.forward(Dir::BoxToDevice, w).remove(0);
            let (_, got) = dev.open(&w).unwrap();
            at_endpoints += count(&got, MARKER.as_bytes());
        }
        (relay, at_endpoints)
    });

    // Positive controls: the marker really crossed the wire, and the capture
    // really recorded the relay's log lines — otherwise "0" would be vacuous.
    assert_eq!(plaintext_seen_by_endpoints, 40);
    let log = cap.0.lock().unwrap().clone();
    assert!(count(&log, b"relay dump") >= 40, "log capture must be live");
    assert!(relay.seen.len() >= 40);

    let m = MARKER.as_bytes();
    let mh = hex(m);
    assert_eq!(count(&log, m), 0, "marker in relay log");
    assert_eq!(count(&log, mh.as_bytes()), 0, "hex marker in relay log");
    for (_, frame) in &relay.seen {
        assert_eq!(count(frame, m), 0, "marker in recorded frame");
    }
    // Counters carry no content-derived label: only totals exist.
    assert!(relay.frames > 0 && relay.bytes > 0);
}
