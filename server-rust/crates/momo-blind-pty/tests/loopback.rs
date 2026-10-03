//! ADR-0197 S2 acceptance ③: latency and reconnect over real TCP sockets on
//! loopback, through a relay that is a plain byte pipe. `runtime-unverified`
//! for WebSocket/TLS/Railway paths; numbers are printed, not asserted tightly.

use momo_blind_pty::codec::*;
use momo_blind_pty::harness::Fixture;
use momo_blind_pty::session::FrameKind;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

async fn put(s: &mut TcpStream, m: &[u8]) {
    s.write_all(&(m.len() as u32).to_be_bytes()).await.unwrap();
    s.write_all(m).await.unwrap();
}

async fn get(s: &mut TcpStream) -> Vec<u8> {
    let mut l = [0u8; 4];
    s.read_exact(&mut l).await.unwrap();
    let mut b = vec![0u8; u32::from_be_bytes(l) as usize];
    s.read_exact(&mut b).await.unwrap();
    b
}

/// Blind relay: accept one device connection, dial the box, copy bytes.
async fn relay(listener: TcpListener, box_addr: std::net::SocketAddr) {
    let (mut dev, _) = listener.accept().await.unwrap();
    let mut bx = TcpStream::connect(box_addr).await.unwrap();
    let _ = tokio::io::copy_bidirectional(&mut dev, &mut bx).await;
}

async fn one_connection(fx: &mut Fixture, frames: usize) -> (f64, f64) {
    let box_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let relay_l = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let (box_addr, relay_addr) = (box_l.local_addr().unwrap(), relay_l.local_addr().unwrap());
    tokio::spawn(relay(relay_l, box_addr));

    let mut dev_sock = TcpStream::connect(relay_addr).await.unwrap();
    let (hello, hs) = fx.client.hello(fx.box_id).unwrap();
    let t0 = Instant::now();
    put(&mut dev_sock, &hello.to_bytes()).await;
    let (mut box_sock, _) = box_l.accept().await.unwrap();

    // Box side (same task: the handshake is strictly alternating).
    let hello = Hello::from_bytes(&get(&mut box_sock).await).unwrap();
    let ch = fx.agent.on_hello(hello).unwrap();
    put(&mut box_sock, &ch.to_bytes()).await;
    let ch = Challenge::from_bytes(&get(&mut dev_sock).await).unwrap();
    let (auth, pending) = hs.on_challenge(ch).unwrap();
    put(&mut dev_sock, &auth.to_bytes()).await;
    let auth = Auth::from_bytes(&get(&mut box_sock).await).unwrap();
    let (mut bx, ready) = fx.agent.on_auth(auth).unwrap();
    put(&mut box_sock, &ready).await;
    let mut dev = pending.confirm(&get(&mut dev_sock).await).unwrap();
    let handshake_ms = t0.elapsed().as_secs_f64() * 1e3;

    // Echo round trips: keystroke up, echo down.
    let t1 = Instant::now();
    for i in 0..frames {
        let w = dev
            .seal(FrameKind::Data, format!("k{i}").as_bytes())
            .unwrap();
        put(&mut dev_sock, &w).await;
        let (_, p) = bx.open(&get(&mut box_sock).await).unwrap();
        let w = bx.seal(FrameKind::Data, &p).unwrap();
        put(&mut box_sock, &w).await;
        let (_, echo) = dev.open(&get(&mut dev_sock).await).unwrap();
        assert_eq!(echo, p);
    }
    (
        handshake_ms,
        t1.elapsed().as_secs_f64() * 1e3 / frames as f64,
    )
}

#[tokio::test]
async fn handshake_echo_latency_and_reconnect_over_loopback_tcp() {
    let mut fx = Fixture::new();
    let (hs1, rt1) = one_connection(&mut fx, 1000).await;
    // Reconnect: brand-new sockets and a brand-new handshake on the same agent.
    let (hs2, rt2) = one_connection(&mut fx, 1000).await;
    eprintln!(
        "S2 loopback: handshake {hs1:.2} ms / reconnect handshake {hs2:.2} ms; \
         echo round trip {rt1:.3} / {rt2:.3} ms per keystroke (device->box->device)"
    );
    assert!(hs2 < 2000.0 && rt2 < 100.0);
}
