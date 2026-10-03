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
            || !next.signature_ok()
            || !self.current.devices.contains(&next.signer)
        {
            return Err(Error::DeviceListBadSigner);
        }
        if next.version <= self.current.version {
            return Err(Error::DeviceListRollback);
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
