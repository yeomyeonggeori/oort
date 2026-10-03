//! Mutual-authentication handshake. Box-agent is the responder and verifies
//! the owner device's signature itself; the device verifies the box against a
//! host key that is runner-attested and owner-endorsed. The relay is not
//! consulted by either side.

use crate::codec::*;
use crate::crypto::{
    self, derive_keys, signed_bytes, Ephemeral, Transcript, ROLE_BOX, ROLE_DEVICE,
};
use crate::session::{FrameKind, Role, Session};
use crate::trust::*;
use crate::{Error, CHALLENGE_TTL_MS, MAX_PENDING};
use ed25519_dalek::SigningKey as EdSigningKey;
use p256::ecdsa::SigningKey as DevSigningKey;
use std::collections::HashMap;
use std::sync::Arc;

/// Monotonic millisecond clock the box-agent trusts (ADR-0197: not wall time).
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> u64;
}

/// Spent challenge nonces with their expiry (entries are pruned once the
/// challenge could no longer be answered anyway). Persisted across box-agent
/// restarts: a replayed Auth is then reported as `ChallengeReplayed` even if the
/// in-memory pending set was lost.
#[derive(Clone, Debug, Default)]
pub struct NonceStore {
    used: HashMap<[u8; NONCE_LEN], u64>,
}

const STORE_ENTRY: usize = NONCE_LEN + 8;

impl NonceStore {
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v: Vec<_> = self.used.iter().collect();
        v.sort();
        v.into_iter()
            .flat_map(|(n, e)| n.iter().copied().chain(e.to_be_bytes()))
            .collect()
    }
    pub fn from_bytes(b: &[u8]) -> Result<Self, Error> {
        if !b.len().is_multiple_of(STORE_ENTRY) {
            return Err(Error::Malformed);
        }
        let mut used = HashMap::new();
        for c in b.chunks_exact(STORE_ENTRY) {
            let n: [u8; NONCE_LEN] = c[..NONCE_LEN].try_into().map_err(|_| Error::Malformed)?;
            let e = u64::from_be_bytes(c[NONCE_LEN..].try_into().map_err(|_| Error::Malformed)?);
            used.insert(n, e);
        }
        Ok(Self { used })
    }
    pub fn contains(&self, n: &[u8; NONCE_LEN]) -> bool {
        self.used.contains_key(n)
    }
    pub fn len(&self) -> usize {
        self.used.len()
    }
    pub fn is_empty(&self) -> bool {
        self.used.is_empty()
    }
    fn spend(&mut self, n: [u8; NONCE_LEN], expires_ms: u64, now_ms: u64) {
        self.used.retain(|_, e| *e >= now_ms);
        self.used.insert(n, expires_ms);
    }
}

struct Pending {
    eph: Ephemeral,
    hello: Hello,
    expires_ms: u64,
}

pub struct BoxAgent {
    box_id: BoxId,
    host: EdSigningKey,
    devices: DeviceListState,
    pending: HashMap<[u8; NONCE_LEN], Pending>,
    used: NonceStore,
    clock: Arc<dyn Clock>,
}

impl BoxAgent {
    pub fn new(
        box_id: BoxId,
        host: EdSigningKey,
        devices: DeviceListState,
        used: NonceStore,
        clock: Arc<dyn Clock>,
    ) -> Result<Self, Error> {
        // A list signed for another box must never provision this one.
        if devices.list().box_id != box_id {
            return Err(Error::WrongBox);
        }
        Ok(Self {
            box_id,
            host,
            devices,
            pending: HashMap::new(),
            used,
            clock,
        })
    }
    pub fn box_id(&self) -> BoxId {
        self.box_id
    }
    pub fn host_pub(&self) -> [u8; ED_PUB_LEN] {
        self.host.verifying_key().to_bytes()
    }
    pub fn nonce_store(&self) -> &NonceStore {
        &self.used
    }
    pub fn device_list_version(&self) -> u64 {
        self.devices.version()
    }
    /// Device list update relayed by the server; only an owner signature on a
    /// higher version changes anything.
    pub fn on_device_list(&mut self, list: DeviceList) -> Result<(), Error> {
        self.devices.accept(list)
    }

    /// The list the box actually enforces. The box sends this to the device as
    /// the first control frame after `Ready` (M4); the device audits it with
    /// [`DeviceClient::audit_box_list`] before sending any input.
    pub fn device_list(&self) -> &DeviceList {
        self.devices.list()
    }

    pub fn on_hello(&mut self, hello: Hello) -> Result<Challenge, Error> {
        if hello.box_id != self.box_id {
            return Err(Error::WrongBox);
        }
        // Unlisted devices get no challenge: no ECDH, no state, no oracle.
        if !self.devices.contains(&hello.dev_pub) {
            return Err(Error::UnknownDevice);
        }
        let now = self.clock.now_ms();
        self.pending.retain(|_, p| p.expires_ms >= now);
        if self.pending.len() >= MAX_PENDING {
            return Err(Error::TooManyPending);
        }
        let eph = Ephemeral::generate()?;
        let nonce_b = crypto::random::<NONCE_LEN>()?;
        let expires_ms = now + CHALLENGE_TTL_MS;
        let t = transcript(
            &hello,
            &self.box_id,
            &self.host_pub(),
            nonce_b,
            eph.public,
            expires_ms,
        );
        let sig_box = sign_ed(&self.host, &signed_bytes(ROLE_BOX, &t.hash()));
        let ch = Challenge {
            box_id: self.box_id,
            host_pub: self.host_pub(),
            nonce_b,
            eph_b: eph.public,
            expires_ms,
            sig_box,
        };
        self.pending.insert(
            nonce_b,
            Pending {
                eph,
                hello,
                expires_ms,
            },
        );
        Ok(ch)
    }

    /// Returns the established session and the sealed `Ready` frame to send.
    pub fn on_auth(&mut self, auth: Auth) -> Result<(Session, Vec<u8>), Error> {
        // Spent first (survives restarts), then take-once from pending; a wrong
        // signature also burns the challenge.
        if self.used.contains(&auth.nonce_b) {
            return Err(Error::ChallengeReplayed);
        }
        let p = self
            .pending
            .remove(&auth.nonce_b)
            .ok_or(Error::ChallengeUnknown)?;
        let now = self.clock.now_ms();
        self.used.spend(auth.nonce_b, p.expires_ms, now);
        if now > p.expires_ms {
            return Err(Error::Expired);
        }
        // Re-check at auth time: a device removed since Hello must not attach.
        if !self.devices.contains(&p.hello.dev_pub) {
            return Err(Error::UnknownDevice);
        }
        let t = transcript(
            &p.hello,
            &self.box_id,
            &self.host_pub(),
            auth.nonce_b,
            p.eph.public,
            p.expires_ms,
        );
        let th = t.hash();
        if !verify_dev(
            &p.hello.dev_pub,
            &signed_bytes(ROLE_DEVICE, &th),
            &auth.sig_dev,
        ) {
            return Err(Error::BadDeviceSignature);
        }
        let shared = p.eph.agree(&p.hello.eph_d)?;
        let mut s = Session::new(Role::Box, derive_keys(&shared, &th), th);
        // The Ready frame carries the list this box enforces, inside the encrypted
        // channel, so the device can audit it before sending any input.
        let ready = s.seal(
            crate::session::FrameKind::Ready,
            &self.devices.list().to_bytes(),
        )?;
        Ok((s, ready))
    }
}

fn transcript(
    hello: &Hello,
    box_id: &BoxId,
    host_pub: &[u8; ED_PUB_LEN],
    nonce_b: [u8; NONCE_LEN],
    eph_b: [u8; EPH_LEN],
    expires_ms: u64,
) -> Transcript {
    Transcript {
        box_id: *box_id,
        host_pub: *host_pub,
        dev_pub: hello.dev_pub,
        nonce_d: hello.nonce_d,
        nonce_b,
        eph_d: hello.eph_d,
        eph_b,
        expires_ms,
    }
}

/// The owner's device. Holds the typed-in runner fingerprint and its pins.
pub struct DeviceClient {
    sk: DevSigningKey,
    runner_fp: Option<[u8; 32]>,
    owner: DeviceListState,
    pins: HashMap<BoxId, HostPin>,
}

impl DeviceClient {
    pub fn new(sk: DevSigningKey, owner: DeviceListState) -> Self {
        Self {
            sk,
            runner_fp: None,
            owner,
            pins: HashMap::new(),
        }
    }
    pub fn dev_pub(&self) -> [u8; DEV_PUB_LEN] {
        dev_pub(&self.sk)
    }
    /// The value the member typed in from the runner operator (out-of-band).
    pub fn set_runner_fingerprint(&mut self, fp: [u8; 32]) {
        self.runner_fp = Some(fp);
    }
    pub fn on_device_list(&mut self, list: DeviceList) -> Result<(), Error> {
        self.owner.accept(list)
    }

    /// Standalone form of the audit that [`PendingDevice::confirm`] enforces.
    pub fn audit_box_list(&self, box_id: &BoxId, list: &DeviceList) -> Result<(), Error> {
        audit(&self.owner, box_id, list)
    }

    fn check_runner(
        &self,
        box_id: &BoxId,
        host_pub: &[u8; ED_PUB_LEN],
        runner_pub: &[u8; ED_PUB_LEN],
        attestation: &[u8; SIG_LEN],
    ) -> Result<[u8; 32], Error> {
        let fp = self.runner_fp.ok_or(Error::HostNotPinned)?;
        let got = crypto::sha256(&[runner_pub]);
        if got != fp {
            return Err(Error::RunnerFingerprintMismatch);
        }
        if !verify_attestation(runner_pub, box_id, host_pub, attestation) {
            return Err(Error::HostNotAttested);
        }
        Ok(fp)
    }

    /// First contact: after the runner fingerprint matched what the member
    /// typed, this device endorses the host key (owner signature).
    pub fn pin_host(
        &mut self,
        box_id: BoxId,
        host_pub: [u8; ED_PUB_LEN],
        runner_pub: [u8; ED_PUB_LEN],
        attestation: [u8; SIG_LEN],
    ) -> Result<HostPin, Error> {
        let fp = self.check_runner(&box_id, &host_pub, &runner_pub, &attestation)?;
        let sig_owner = sign_dev(
            &self.sk,
            &HostPin::endorse_bytes(&box_id, &host_pub, &fp, &attestation),
        );
        let pin = HostPin {
            box_id,
            host_pub,
            runner_pub,
            attestation,
            signer_dev: self.dev_pub(),
            sig_owner,
        };
        self.store_pin(pin.clone())?;
        Ok(pin)
    }

    /// A pin served by the server (or another device). Re-verifies both proofs.
    pub fn import_pin(&mut self, pin: HostPin) -> Result<(), Error> {
        let fp = self.check_runner(
            &pin.box_id,
            &pin.host_pub,
            &pin.runner_pub,
            &pin.attestation,
        )?;
        let msg = HostPin::endorse_bytes(&pin.box_id, &pin.host_pub, &fp, &pin.attestation);
        if !self.owner.contains(&pin.signer_dev)
            || !verify_dev(&pin.signer_dev, &msg, &pin.sig_owner)
        {
            return Err(Error::HostNotEndorsed);
        }
        self.store_pin(pin)
    }

    fn store_pin(&mut self, pin: HostPin) -> Result<(), Error> {
        match self.pins.get(&pin.box_id) {
            Some(old) if old.host_pub != pin.host_pub => Err(Error::HostKeyChanged),
            _ => {
                self.pins.insert(pin.box_id, pin);
                Ok(())
            }
        }
    }

    /// Start an attach. Refuses unless the box's host key is pinned, which in
    /// turn required the runner fingerprint comparison.
    pub fn hello(&self, box_id: BoxId) -> Result<(Hello, DeviceHandshake), Error> {
        let pin = self.pins.get(&box_id).ok_or(Error::HostNotPinned)?;
        let eph = Ephemeral::generate()?;
        let hello = Hello {
            box_id,
            dev_pub: self.dev_pub(),
            nonce_d: crypto::random()?,
            eph_d: eph.public,
        };
        Ok((
            hello.clone(),
            DeviceHandshake {
                owner: self.owner.clone(),
                sk: self.sk.clone(),
                pinned_host: pin.host_pub,
                hello,
                eph,
            },
        ))
    }
}

/// Catches a box provisioned (by a compromised server) with an extra or
/// substituted owner device, or one belonging to someone else: the list must be
/// for this box, signed by a device the owner already knows, and every listed
/// device must be one the owner already knows.
fn audit(owner: &DeviceListState, box_id: &BoxId, list: &DeviceList) -> Result<(), Error> {
    if list.box_id != *box_id
        || !list.signature_ok()
        || !owner.contains(&list.signer)
        || list.devices.iter().any(|d| !owner.contains(d))
    {
        return Err(Error::BoxListUntrusted);
    }
    Ok(())
}

pub struct DeviceHandshake {
    owner: DeviceListState,
    sk: DevSigningKey,
    pinned_host: [u8; ED_PUB_LEN],
    hello: Hello,
    eph: Ephemeral,
}

impl DeviceHandshake {
    pub fn on_challenge(self, ch: Challenge) -> Result<(Auth, PendingDevice), Error> {
        if ch.box_id != self.hello.box_id {
            return Err(Error::WrongBox);
        }
        if ch.host_pub != self.pinned_host {
            return Err(Error::HostKeyChanged);
        }
        let t = transcript(
            &self.hello,
            &ch.box_id,
            &ch.host_pub,
            ch.nonce_b,
            ch.eph_b,
            ch.expires_ms,
        );
        let th = t.hash();
        if !verify_ed(&ch.host_pub, &signed_bytes(ROLE_BOX, &th), &ch.sig_box) {
            return Err(Error::BadHostSignature);
        }
        let sig_dev = sign_dev(&self.sk, &signed_bytes(ROLE_DEVICE, &th));
        let shared = self.eph.agree(&ch.eph_b)?;
        let session = Session::new(Role::Device, derive_keys(&shared, &th), th);
        Ok((
            Auth {
                nonce_b: ch.nonce_b,
                sig_dev,
            },
            PendingDevice {
                session,
                owner: self.owner,
                box_id: ch.box_id,
            },
        ))
    }
}

/// A device-side session that cannot send yet. The only way to a usable
/// [`Session`] is [`PendingDevice::confirm`], which opens the box's `Ready`
/// frame (proof it derived the same keys) and audits the device list it carries.
pub struct PendingDevice {
    session: Session,
    owner: DeviceListState,
    box_id: BoxId,
}

impl PendingDevice {
    pub fn confirm(mut self, ready_frame: &[u8]) -> Result<Session, Error> {
        let (kind, payload) = self.session.open(ready_frame)?;
        if kind != FrameKind::Ready {
            return Err(Error::Malformed);
        }
        let list = DeviceList::from_bytes(&payload)?;
        audit(&self.owner, &self.box_id, &list)?;
        Ok(self.session)
    }
}
