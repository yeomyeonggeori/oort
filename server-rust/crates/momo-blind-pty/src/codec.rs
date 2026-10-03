//! Fixed-size wire messages. The relay sees these bytes and nothing else.

use crate::Error;

pub const BOX_ID_LEN: usize = 16;
pub const DEV_PUB_LEN: usize = 33; // compressed SEC1 P-256
pub const EPH_LEN: usize = 33; // compressed SEC1 P-256
pub const NONCE_LEN: usize = 32;
pub const ED_PUB_LEN: usize = 32;
pub const SIG_LEN: usize = 64;

pub type BoxId = [u8; BOX_ID_LEN];

/// 1: device -> box (relayed). Unauthenticated; the box answers with a challenge.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hello {
    pub box_id: BoxId,
    pub dev_pub: [u8; DEV_PUB_LEN],
    pub nonce_d: [u8; NONCE_LEN],
    pub eph_d: [u8; EPH_LEN],
}

/// 2: box -> device (relayed). Signed by the host key over the full transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Challenge {
    pub box_id: BoxId,
    pub host_pub: [u8; ED_PUB_LEN],
    pub nonce_b: [u8; NONCE_LEN],
    pub eph_b: [u8; EPH_LEN],
    pub expires_ms: u64,
    pub sig_box: [u8; SIG_LEN],
}

/// 3: device -> box (relayed). P-256 ECDSA over the same transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Auth {
    pub nonce_b: [u8; NONCE_LEN],
    pub sig_dev: [u8; SIG_LEN],
}

fn take<const N: usize>(b: &mut &[u8]) -> Result<[u8; N], Error> {
    if b.len() < N {
        return Err(Error::Malformed);
    }
    let (h, t) = b.split_at(N);
    *b = t;
    h.try_into().map_err(|_| Error::Malformed)
}

fn expect_end(b: &[u8]) -> Result<(), Error> {
    if b.is_empty() {
        Ok(())
    } else {
        Err(Error::Malformed)
    }
}

impl Hello {
    pub const TAG: u8 = 1;
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = vec![Self::TAG];
        v.extend_from_slice(&self.box_id);
        v.extend_from_slice(&self.dev_pub);
        v.extend_from_slice(&self.nonce_d);
        v.extend_from_slice(&self.eph_d);
        v
    }
    pub fn from_bytes(mut b: &[u8]) -> Result<Self, Error> {
        if take::<1>(&mut b)?[0] != Self::TAG {
            return Err(Error::Malformed);
        }
        let s = Self {
            box_id: take(&mut b)?,
            dev_pub: take(&mut b)?,
            nonce_d: take(&mut b)?,
            eph_d: take(&mut b)?,
        };
        expect_end(b)?;
        Ok(s)
    }
}

impl Challenge {
    pub const TAG: u8 = 2;
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = vec![Self::TAG];
        v.extend_from_slice(&self.box_id);
        v.extend_from_slice(&self.host_pub);
        v.extend_from_slice(&self.nonce_b);
        v.extend_from_slice(&self.eph_b);
        v.extend_from_slice(&self.expires_ms.to_be_bytes());
        v.extend_from_slice(&self.sig_box);
        v
    }
    pub fn from_bytes(mut b: &[u8]) -> Result<Self, Error> {
        if take::<1>(&mut b)?[0] != Self::TAG {
            return Err(Error::Malformed);
        }
        let s = Self {
            box_id: take(&mut b)?,
            host_pub: take(&mut b)?,
            nonce_b: take(&mut b)?,
            eph_b: take(&mut b)?,
            expires_ms: u64::from_be_bytes(take(&mut b)?),
            sig_box: take(&mut b)?,
        };
        expect_end(b)?;
        Ok(s)
    }
}

impl Auth {
    pub const TAG: u8 = 3;
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut v = vec![Self::TAG];
        v.extend_from_slice(&self.nonce_b);
        v.extend_from_slice(&self.sig_dev);
        v
    }
    pub fn from_bytes(mut b: &[u8]) -> Result<Self, Error> {
        if take::<1>(&mut b)?[0] != Self::TAG {
            return Err(Error::Malformed);
        }
        let s = Self {
            nonce_b: take(&mut b)?,
            sig_dev: take(&mut b)?,
        };
        expect_end(b)?;
        Ok(s)
    }
}
