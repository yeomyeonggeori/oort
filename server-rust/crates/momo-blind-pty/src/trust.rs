//! Trust anchors: runner attestation, owner endorsement, owner device list.

use crate::codec::*;
use crate::crypto::sha256;
use crate::{Error, SCHEMA};
use ed25519_dalek::{Signer as _, SigningKey as EdSigningKey, VerifyingKey as EdVerifyingKey};
use p256::ecdsa::signature::Signer as _;
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{Signature, SigningKey as DevSigningKey, VerifyingKey as DevVerifyingKey};

pub fn dev_pub(sk: &DevSigningKey) -> [u8; DEV_PUB_LEN] {
    let ep = sk.verifying_key().to_sec1_point(true);
    ep.as_bytes()
        .try_into()
        .expect("compressed P-256 point is 33 bytes")
}

pub fn verify_dev(pubkey: &[u8; DEV_PUB_LEN], msg: &[u8], sig: &[u8; SIG_LEN]) -> bool {
    let (Ok(vk), Ok(sig)) = (
        DevVerifyingKey::from_sec1_bytes(pubkey),
        Signature::from_slice(sig),
    ) else {
        return false;
    };
    vk.verify(msg, &sig).is_ok()
}

pub fn sign_dev(sk: &DevSigningKey, msg: &[u8]) -> [u8; SIG_LEN] {
    let sig: Signature = sk.sign(msg);
    sig.to_bytes().into()
}

pub fn verify_ed(pubkey: &[u8; ED_PUB_LEN], msg: &[u8], sig: &[u8; SIG_LEN]) -> bool {
    let Ok(vk) = EdVerifyingKey::from_bytes(pubkey) else {
        return false;
    };
    vk.verify_strict(msg, &ed25519_dalek::Signature::from_bytes(sig))
        .is_ok()
}

pub fn sign_ed(sk: &EdSigningKey, msg: &[u8]) -> [u8; SIG_LEN] {
    sk.sign(msg).to_bytes()
}

/// The runner VM's signing key. Its fingerprint is shown on the runner console
/// only and travels to members out-of-band (ADR-0197 D5).
pub struct Runner {
    sk: EdSigningKey,
}

impl Runner {
    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            sk: EdSigningKey::from_bytes(&seed),
        }
    }
    pub fn public(&self) -> [u8; ED_PUB_LEN] {
        self.sk.verifying_key().to_bytes()
    }
    pub fn fingerprint(&self) -> [u8; 32] {
        sha256(&[&self.public()])
    }
    /// Generation-time proof that this runner created `host_pub` for `box_id`.
    pub fn attest_host(&self, box_id: &BoxId, host_pub: &[u8; ED_PUB_LEN]) -> [u8; SIG_LEN] {
        sign_ed(&self.sk, &attest_bytes(box_id, host_pub))
    }
}

fn attest_bytes(box_id: &BoxId, host_pub: &[u8; ED_PUB_LEN]) -> Vec<u8> {
    let mut v = format!("{SCHEMA}/host_attest").into_bytes();
    v.extend_from_slice(box_id);
    v.extend_from_slice(host_pub);
    v
}

pub fn verify_attestation(
    runner_pub: &[u8; ED_PUB_LEN],
    box_id: &BoxId,
    host_pub: &[u8; ED_PUB_LEN],
    attestation: &[u8; SIG_LEN],
) -> bool {
    verify_ed(runner_pub, &attest_bytes(box_id, host_pub), attestation)
}

/// ADR-0197 M4 (증보 2): the box-agent proves to the **runner** that it holds the one-time pairing code (which only
/// the runner and the box know) without sending the code anywhere. The server relays this MAC and cannot verify it.
pub const REGISTER_MAC_LABEL: &str = "momo.box.register.v1";
pub const REGISTER_MAC_LEN: usize = 32;

fn register_mac_input(box_id: &BoxId, host_pub: &[u8; ED_PUB_LEN]) -> Vec<u8> {
    let mut v = REGISTER_MAC_LABEL.as_bytes().to_vec();
    v.extend_from_slice(box_id);
    v.extend_from_slice(host_pub);
    v
}

/// `HMAC-SHA256(code, "momo.box.register.v1" ‖ box_id ‖ host_pub)`.
pub fn registration_mac(
    code: &[u8],
    box_id: &BoxId,
    host_pub: &[u8; ED_PUB_LEN],
) -> [u8; REGISTER_MAC_LEN] {
    use hmac::{Hmac, Mac};
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(code).expect("HMAC takes any key length");
    mac.update(&register_mac_input(box_id, host_pub));
    mac.finalize().into_bytes().into()
}

/// Constant-time check of [`registration_mac`].
pub fn verify_registration_mac(
    code: &[u8],
    box_id: &BoxId,
    host_pub: &[u8; ED_PUB_LEN],
    mac: &[u8],
) -> bool {
    use hmac::{Hmac, Mac};
    let Ok(mut expected) = <Hmac<sha2::Sha256> as Mac>::new_from_slice(code) else {
        return false;
    };
    expected.update(&register_mac_input(box_id, host_pub));
    expected.verify_slice(mac).is_ok()
}

/// A host key that carries both proofs a device needs: the runner made it and
/// an owner device endorsed it. The server may store and serve this record; it
/// cannot mint one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPin {
    pub box_id: BoxId,
    pub host_pub: [u8; ED_PUB_LEN],
    pub runner_pub: [u8; ED_PUB_LEN],
    pub attestation: [u8; SIG_LEN],
    pub signer_dev: [u8; DEV_PUB_LEN],
    pub sig_owner: [u8; SIG_LEN],
}

impl HostPin {
    pub fn endorse_bytes(
        box_id: &BoxId,
        host_pub: &[u8; ED_PUB_LEN],
        runner_fp: &[u8; 32],
        attestation: &[u8; SIG_LEN],
    ) -> Vec<u8> {
        let mut v = format!("{SCHEMA}/host_pin").into_bytes();
        v.extend_from_slice(box_id);
        v.extend_from_slice(host_pub);
        v.extend_from_slice(runner_fp);
        v.extend_from_slice(attestation);
        v
    }
    pub fn runner_fp(&self) -> [u8; 32] {
        sha256(&[&self.runner_pub])
    }

    /// Wire form the server stores opaquely and serves back (ADR-0197 M4 증보 2):
    /// `box_id 16 ‖ host_pub 32 ‖ runner_pub 32 ‖ attestation 64 ‖ signer_dev 33 ‖ sig_owner 64`.
    pub const WIRE_LEN: usize = BOX_ID_LEN + ED_PUB_LEN + ED_PUB_LEN + SIG_LEN + DEV_PUB_LEN + SIG_LEN;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(Self::WIRE_LEN);
        v.extend_from_slice(&self.box_id);
        v.extend_from_slice(&self.host_pub);
        v.extend_from_slice(&self.runner_pub);
        v.extend_from_slice(&self.attestation);
        v.extend_from_slice(&self.signer_dev);
        v.extend_from_slice(&self.sig_owner);
        v
    }

    pub fn from_bytes(b: &[u8]) -> Result<Self, Error> {
        if b.len() != Self::WIRE_LEN {
            return Err(Error::Malformed);
        }
        let mut at = 0;
        let mut take = |n: usize| {
            let part = &b[at..at + n];
            at += n;
            part
        };
        Ok(Self {
            box_id: take(BOX_ID_LEN).try_into().map_err(|_| Error::Malformed)?,
            host_pub: take(ED_PUB_LEN).try_into().map_err(|_| Error::Malformed)?,
            runner_pub: take(ED_PUB_LEN).try_into().map_err(|_| Error::Malformed)?,
            attestation: take(SIG_LEN).try_into().map_err(|_| Error::Malformed)?,
            signer_dev: take(DEV_PUB_LEN).try_into().map_err(|_| Error::Malformed)?,
            sig_owner: take(SIG_LEN).try_into().map_err(|_| Error::Malformed)?,
        })
    }
}

/// Owner-signed, versioned list of devices allowed to attach.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceList {
    pub box_id: BoxId,
    pub version: u64,
    pub devices: Vec<[u8; DEV_PUB_LEN]>,
    pub signer: [u8; DEV_PUB_LEN],
    pub sig: [u8; SIG_LEN],
}

impl DeviceList {
    fn signed_bytes(box_id: &BoxId, version: u64, devices: &[[u8; DEV_PUB_LEN]]) -> Vec<u8> {
        let mut v = format!("{SCHEMA}/devlist").into_bytes();
        v.extend_from_slice(box_id);
        v.extend_from_slice(&version.to_be_bytes());
        v.extend_from_slice(&(devices.len() as u32).to_be_bytes());
        for d in devices {
            v.extend_from_slice(d);
        }
        v
    }
    pub fn sign(
        box_id: BoxId,
        version: u64,
        mut devices: Vec<[u8; DEV_PUB_LEN]>,
        signer: &DevSigningKey,
    ) -> Self {
        devices.sort();
        devices.dedup();
        let sig = sign_dev(signer, &Self::signed_bytes(&box_id, version, &devices));
        Self {
            box_id,
            version,
            devices,
            signer: dev_pub(signer),
            sig,
        }
    }
    pub const MAX_DEVICES: usize = 16;

    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = self.box_id.to_vec();
        v.extend_from_slice(&self.version.to_be_bytes());
        v.extend_from_slice(&(self.devices.len() as u32).to_be_bytes());
        for d in &self.devices {
            v.extend_from_slice(d);
        }
        v.extend_from_slice(&self.signer);
        v.extend_from_slice(&self.sig);
        v
    }

    pub fn from_bytes(b: &[u8]) -> Result<Self, Error> {
        let fixed = BOX_ID_LEN + 8 + 4;
        if b.len() < fixed + DEV_PUB_LEN + SIG_LEN {
            return Err(Error::Malformed);
        }
        let n = u32::from_be_bytes(
            b[BOX_ID_LEN + 8..fixed]
                .try_into()
                .map_err(|_| Error::Malformed)?,
        ) as usize;
        if n > Self::MAX_DEVICES || b.len() != fixed + n * DEV_PUB_LEN + DEV_PUB_LEN + SIG_LEN {
            return Err(Error::Malformed);
        }
        let mut devices = Vec::with_capacity(n);
        for i in 0..n {
            let s = fixed + i * DEV_PUB_LEN;
            devices.push(
                b[s..s + DEV_PUB_LEN]
                    .try_into()
                    .map_err(|_| Error::Malformed)?,
            );
        }
        let s = fixed + n * DEV_PUB_LEN;
        Ok(Self {
            box_id: b[..BOX_ID_LEN].try_into().map_err(|_| Error::Malformed)?,
            version: u64::from_be_bytes(
                b[BOX_ID_LEN..BOX_ID_LEN + 8]
                    .try_into()
                    .map_err(|_| Error::Malformed)?,
            ),
            devices,
            signer: b[s..s + DEV_PUB_LEN]
                .try_into()
                .map_err(|_| Error::Malformed)?,
            sig: b[s + DEV_PUB_LEN..]
                .try_into()
                .map_err(|_| Error::Malformed)?,
        })
    }

    /// Shape every accepted list must have: non-empty (an empty list locks the
    /// box forever) and small enough to fit the Ready frame.
    pub(crate) fn well_formed(&self) -> bool {
        !self.devices.is_empty() && self.devices.len() <= Self::MAX_DEVICES
    }

    pub(crate) fn signature_ok(&self) -> bool {
        verify_dev(
            &self.signer,
            &Self::signed_bytes(&self.box_id, self.version, &self.devices),
            &self.sig,
        )
    }
}

/// Current accepted list. Used by the box-agent (authoritative) and by devices.
#[derive(Clone, Debug)]
pub struct DeviceListState {
    current: DeviceList,
}

impl DeviceListState {
    /// Provisioning-time pin (runner-local, not via the server). The list must
    /// be self-consistent: signed by a device it lists.
    pub fn bootstrap(list: DeviceList) -> Result<Self, Error> {
        if list.version == 0 || !list.signature_ok() || !list.devices.contains(&list.signer) {
            return Err(Error::DeviceListBadSigner);
        }
        Ok(Self { current: list })
    }
    /// A later list is accepted only if its version is strictly higher **and**
    /// it is signed by a device on the *currently accepted* list. Server
    /// relay of any list therefore changes nothing without an owner signature.
    pub fn accept(&mut self, next: DeviceList) -> Result<(), Error> {
        if next.box_id != self.current.box_id
            || !next.well_formed()
            || !next.signature_ok()
            || !self.current.devices.contains(&next.signer)
        {
            return Err(Error::DeviceListBadSigner);
        }
        if next.version <= self.current.version {
            return Err(Error::DeviceListRollback);
        }
        // Exactly +1: a (stolen) listed device cannot jump the counter to
        // u64::MAX and freeze every later update.
        if next.version != self.current.version + 1 {
            return Err(Error::DeviceListGap);
        }
        self.current = next;
        Ok(())
    }
    pub fn list(&self) -> &DeviceList {
        &self.current
    }
    pub fn contains(&self, dev: &[u8; DEV_PUB_LEN]) -> bool {
        self.current.devices.contains(dev)
    }
    pub fn version(&self) -> u64 {
        self.current.version
    }
}
