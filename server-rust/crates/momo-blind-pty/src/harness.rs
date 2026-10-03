//! Test harness: the oort server's PTY route, modelled as an adversary that
//! only ever handles opaque bytes, plus fixed-key fixtures.
//!
//! Fixed seeds below are **test vectors, not secrets**; they sign nothing real.

use crate::codec::*;
use crate::handshake::{BoxAgent, Clock, DeviceClient, NonceStore};
use crate::session::{FrameKind, Session};
use crate::trust::*;
use crate::Error;
use ed25519_dalek::SigningKey as EdSigningKey;
use p256::ecdsa::SigningKey as DevSigningKey;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dir {
    DeviceToBox,
    BoxToDevice,
}

/// What the (untrusted) server route does with each message. It returns the
/// messages that actually get delivered: none (drop), one, or several.
pub trait Relay {
    fn forward(&mut self, dir: Dir, msg: Vec<u8>) -> Vec<Vec<u8>>;
}

/// The route as designed: forwards bytes, logs only direction and size.
#[derive(Default)]
pub struct BlindRelay {
    pub frames: u64,
    pub bytes: u64,
    /// Worst case: a server that records every byte it handles and also
    /// writes them all to its log (hex, so even binary shows up).
    pub log_everything: bool,
    pub seen: Vec<(Dir, Vec<u8>)>,
}

impl Relay for BlindRelay {
    fn forward(&mut self, dir: Dir, msg: Vec<u8>) -> Vec<Vec<u8>> {
        self.frames += 1;
        self.bytes += msg.len() as u64;
        // The production route's contract: bytes and time only.
        tracing::info!(dir = ?dir, bytes = msg.len(), "relay forward");
        if self.log_everything {
            let hex: String = msg.iter().map(|b| format!("{b:02x}")).collect();
            tracing::info!(dir = ?dir, raw = %String::from_utf8_lossy(&msg), hex = %hex, "relay dump");
            self.seen.push((dir, msg.clone()));
        }
        vec![msg]
    }
}

/// Relay driven by a closure, for one-off adversaries.
pub struct FnRelay<F: FnMut(Dir, Vec<u8>) -> Vec<Vec<u8>>>(pub F);

impl<F: FnMut(Dir, Vec<u8>) -> Vec<Vec<u8>>> Relay for FnRelay<F> {
    fn forward(&mut self, dir: Dir, msg: Vec<u8>) -> Vec<Vec<u8>> {
        (self.0)(dir, msg)
    }
}

/// Manually advanced monotonic clock.
#[derive(Default)]
pub struct ManualClock(AtomicU64);

impl ManualClock {
    pub fn advance(&self, ms: u64) {
        self.0.fetch_add(ms, Ordering::SeqCst);
    }
}

impl Clock for ManualClock {
    fn now_ms(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct Fixture {
    pub box_id: BoxId,
    pub runner: Runner,
    pub host: EdSigningKey,
    pub dev_a: DevSigningKey,
    pub dev_b: DevSigningKey,
    pub clock: Arc<ManualClock>,
    pub agent: BoxAgent,
    /// Device A, already pinned to the box (fingerprint compared).
    pub client: DeviceClient,
    pub list_v1: DeviceList,
}

pub fn dev_key(byte: u8) -> DevSigningKey {
    DevSigningKey::from_slice(&[byte; 32]).expect("test scalar")
}

impl Fixture {
    pub fn new() -> Self {
        Self::with_nonce_store(NonceStore::default())
    }

    pub fn with_nonce_store(store: NonceStore) -> Self {
        let box_id = [9u8; BOX_ID_LEN];
        let runner = Runner::from_seed([1; 32]);
        let host = EdSigningKey::from_bytes(&[2; 32]);
        let dev_a = dev_key(3);
        let dev_b = dev_key(4);
        let clock = Arc::new(ManualClock::default());
        let list_v1 = DeviceList::sign(box_id, 1, vec![dev_pub(&dev_a)], &dev_a);
        let agent = BoxAgent::new(
            box_id,
            host.clone(),
            DeviceListState::bootstrap(list_v1.clone()).expect("list"),
            store,
            clock.clone(),
        );
        let mut client = DeviceClient::new(
            dev_a.clone(),
            DeviceListState::bootstrap(list_v1.clone()).expect("list"),
        );
        client.set_runner_fingerprint(runner.fingerprint());
        let host_pub = host.verifying_key().to_bytes();
        client
            .pin_host(
                box_id,
                host_pub,
                runner.public(),
                runner.attest_host(&box_id, &host_pub),
            )
            .expect("pin");
        Self {
            box_id,
            runner,
            host,
            dev_a,
            dev_b,
            clock,
            agent,
            client,
            list_v1,
        }
    }

    /// Run hello -> challenge -> auth -> ready across `relay`.
    pub fn attach(&mut self, relay: &mut dyn Relay) -> Result<(Session, Session), Error> {
        attach(&self.client, &mut self.agent, relay)
    }
}

impl Default for Fixture {
    fn default() -> Self {
        Self::new()
    }
}

fn first(v: Vec<Vec<u8>>) -> Result<Vec<u8>, Error> {
    v.into_iter().next().ok_or(Error::Closed)
}

/// Full attach. Returns (device session, box session) or the first refusal.
pub fn attach(
    client: &DeviceClient,
    agent: &mut BoxAgent,
    relay: &mut dyn Relay,
) -> Result<(Session, Session), Error> {
    let box_id = agent_box_id(agent);
    let (hello, hs) = client.hello(box_id)?;
    let hello = Hello::from_bytes(&first(relay.forward(Dir::DeviceToBox, hello.to_bytes()))?)?;
    let ch = agent.on_hello(hello)?;
    let ch = Challenge::from_bytes(&first(relay.forward(Dir::BoxToDevice, ch.to_bytes()))?)?;
    let (auth, mut dev) = hs.on_challenge(ch)?;
    let auth = Auth::from_bytes(&first(relay.forward(Dir::DeviceToBox, auth.to_bytes()))?)?;
    let (boxs, ready) = agent.on_auth(auth)?;
    let ready = first(relay.forward(Dir::BoxToDevice, ready))?;
    let (kind, _) = dev.open(&ready)?;
    if kind != FrameKind::Ready {
        return Err(Error::Malformed);
    }
    Ok((dev, boxs))
}

fn agent_box_id(agent: &BoxAgent) -> BoxId {
    agent.box_id()
}
