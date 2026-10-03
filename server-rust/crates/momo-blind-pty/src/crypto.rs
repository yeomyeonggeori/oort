//! Thin wrappers over existing crates. No primitive is implemented here.

use crate::codec::*;
use crate::{Error, SCHEMA};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use p256::ecdh::diffie_hellman;
use p256::elliptic_curve::sec1::ToSec1Point as _;
use p256::{PublicKey, SecretKey};
use sha2::{Digest, Sha256};

pub fn random<const N: usize>() -> Result<[u8; N], Error> {
    let mut b = [0u8; N];
    getrandom::getrandom(&mut b).map_err(|_| Error::Entropy)?;
    Ok(b)
}

/// Ephemeral P-256 key pair. The secret is built from raw OS entropy, retrying
/// the (2^-128) out-of-range case.
pub struct Ephemeral {
    secret: SecretKey,
    pub public: [u8; EPH_LEN],
}

impl Ephemeral {
    pub fn generate() -> Result<Self, Error> {
        loop {
            let seed = random::<32>()?;
            if let Ok(secret) = SecretKey::from_slice(&seed) {
                let enc = secret.public_key().to_sec1_point(true);
                let public: [u8; EPH_LEN] =
                    enc.as_bytes().try_into().map_err(|_| Error::Malformed)?;
                return Ok(Self { secret, public });
            }
        }
    }
    pub fn agree(&self, peer: &[u8; EPH_LEN]) -> Result<[u8; 32], Error> {
        let peer = PublicKey::from_sec1_bytes(peer).map_err(|_| Error::Malformed)?;
        let shared = diffie_hellman(self.secret.to_nonzero_scalar(), peer.as_affine());
        let mut out = [0u8; 32];
        out.copy_from_slice(shared.raw_secret_bytes().as_ref());
        Ok(out)
    }
}

/// Everything both endpoints bind into signatures and keys.
pub struct Transcript {
    pub box_id: BoxId,
    pub host_pub: [u8; ED_PUB_LEN],
    pub dev_pub: [u8; DEV_PUB_LEN],
    pub nonce_d: [u8; NONCE_LEN],
    pub nonce_b: [u8; NONCE_LEN],
    pub eph_d: [u8; EPH_LEN],
    pub eph_b: [u8; EPH_LEN],
    pub expires_ms: u64,
}

impl Transcript {
    /// All fields are fixed-length, so plain concatenation is unambiguous.
    pub fn hash(&self) -> [u8; 32] {
        let mut h = Sha256::new();
        h.update(SCHEMA.as_bytes());
        h.update(b"/transcript");
        h.update(self.box_id);
        h.update(self.host_pub);
        h.update(self.dev_pub);
        h.update(self.nonce_d);
        h.update(self.nonce_b);
        h.update(self.eph_d);
        h.update(self.eph_b);
        h.update(self.expires_ms.to_be_bytes());
        h.finalize().into()
    }
}

/// Byte string each side signs. Distinct role labels stop a signature made for
/// one role from being replayed as the other.
pub fn signed_bytes(role: &str, transcript_hash: &[u8; 32]) -> Vec<u8> {
    let mut v = format!("{SCHEMA}/{role}").into_bytes();
    v.extend_from_slice(transcript_hash);
    v
}

pub const ROLE_BOX: &str = "box_sig";
pub const ROLE_DEVICE: &str = "attach_sig";

pub struct DirKeys {
    pub d2b: [u8; 32],
    pub b2d: [u8; 32],
}

pub fn derive_keys(shared: &[u8; 32], transcript_hash: &[u8; 32]) -> DirKeys {
    let hk = Hkdf::<Sha256>::new(Some(transcript_hash), shared);
    let mut d2b = [0u8; 32];
    let mut b2d = [0u8; 32];
    // 32 bytes is far below the HKDF-SHA256 output limit, so expand cannot fail.
    hk.expand(format!("{SCHEMA}/key/d2b").as_bytes(), &mut d2b)
        .expect("hkdf length");
    hk.expand(format!("{SCHEMA}/key/b2d").as_bytes(), &mut b2d)
        .expect("hkdf length");
    DirKeys { d2b, b2d }
}

pub fn seal(key: &[u8; 32], counter: u64, aad: &[u8], plaintext: &[u8]) -> Vec<u8> {
    #[cfg(sabotage_null_cipher)]
    {
        let _ = (key, counter, aad);
        return plaintext.to_vec();
    }
    #[allow(unreachable_code)]
    {
        let c = Aes256Gcm::new(key.into());
        c.encrypt(
            &nonce(counter),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("aes-gcm encrypt cannot fail for in-memory buffers")
    }
}

pub fn open(key: &[u8; 32], counter: u64, aad: &[u8], ct: &[u8]) -> Result<Vec<u8>, Error> {
    #[cfg(sabotage_null_cipher)]
    {
        let _ = (key, counter, aad);
        return Ok(ct.to_vec());
    }
    #[allow(unreachable_code)]
    {
        let c = Aes256Gcm::new(key.into());
        c.decrypt(&nonce(counter), Payload { msg: ct, aad })
            .map_err(|_| Error::Decrypt)
    }
}

/// 96-bit nonce = 4 zero bytes || 64-bit counter. Safe because each direction
/// has its own key and the key is fresh for every handshake.
fn nonce(counter: u64) -> Nonce<<Aes256Gcm as aes_gcm::aead::AeadCore>::NonceSize> {
    let mut n = [0u8; 12];
    n[4..].copy_from_slice(&counter.to_be_bytes());
    *Nonce::from_slice(&n)
}

pub fn sha256(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
