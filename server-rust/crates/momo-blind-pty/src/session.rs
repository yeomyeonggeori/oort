//! Post-handshake record layer: AES-256-GCM, one key per direction, strict
//! counters. Any failure poisons the session; a reconnect is a new handshake.

use crate::crypto::{self, DirKeys};
use crate::{Error, MAX_PAYLOAD};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Device,
    Box,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
    Data = 0,
    Resize = 1,
    /// Authenticated end-of-stream; without it a relay can truncate silently.
    Close = 2,
    /// First frame box -> device: proves the box derived the same keys.
    Ready = 3,
}

impl FrameKind {
    fn from_u8(b: u8) -> Result<Self, Error> {
        match b {
            0 => Ok(Self::Data),
            1 => Ok(Self::Resize),
            2 => Ok(Self::Close),
            3 => Ok(Self::Ready),
            _ => Err(Error::Malformed),
        }
    }
}

pub struct Session {
    send_key: [u8; 32],
    recv_key: [u8; 32],
    send_dir: u8,
    recv_dir: u8,
    transcript: [u8; 32],
    send_ctr: u64,
    recv_ctr: u64,
    dead: bool,
    peer_closed: bool,
    /// Device side only: the box's Ready frame has not arrived yet.
    awaiting_ready: bool,
}

impl Session {
    pub(crate) fn new(role: Role, keys: DirKeys, transcript: [u8; 32]) -> Self {
        let (send_key, recv_key, send_dir, recv_dir) = match role {
            Role::Device => (keys.d2b, keys.b2d, 1, 2),
            Role::Box => (keys.b2d, keys.d2b, 2, 1),
        };
        Self {
            send_key,
            recv_key,
            send_dir,
            recv_dir,
            transcript,
            send_ctr: 0,
            recv_ctr: 0,
            dead: false,
            peer_closed: false,
            awaiting_ready: role == Role::Device,
        }
    }

    fn aad(&self, dir: u8, ctr: u64) -> Vec<u8> {
        let mut a = self.transcript.to_vec();
        a.push(dir);
        a.extend_from_slice(&ctr.to_be_bytes());
        a
    }

    /// Wire frame = counter (8, clear) || AEAD(kind || payload).
    pub fn seal(&mut self, kind: FrameKind, payload: &[u8]) -> Result<Vec<u8>, Error> {
        if self.dead {
            return Err(Error::Closed);
        }
        if payload.len() > MAX_PAYLOAD {
            return Err(Error::TooLarge);
        }
        let ctr = self.send_ctr;
        self.send_ctr = ctr.checked_add(1).ok_or(Error::Counter)?;
        let mut pt = vec![kind as u8];
        pt.extend_from_slice(payload);
        let ct = crypto::seal(&self.send_key, ctr, &self.aad(self.send_dir, ctr), &pt);
        let mut out = ctr.to_be_bytes().to_vec();
        out.extend_from_slice(&ct);
        Ok(out)
    }

    pub fn open(&mut self, frame: &[u8]) -> Result<(FrameKind, Vec<u8>), Error> {
        if self.dead || self.peer_closed {
            return Err(Error::Closed);
        }
        let r = self.open_inner(frame);
        if r.is_err() {
            self.dead = true;
        }
        r
    }

    fn open_inner(&mut self, frame: &[u8]) -> Result<(FrameKind, Vec<u8>), Error> {
        if frame.len() < 8 {
            return Err(Error::Malformed);
        }
        let ctr = u64::from_be_bytes(frame[..8].try_into().map_err(|_| Error::Malformed)?);
        if ctr != self.recv_ctr {
            return Err(Error::Counter);
        }
        let pt = crypto::open(
            &self.recv_key,
            ctr,
            &self.aad(self.recv_dir, ctr),
            &frame[8..],
        )?;
        let (&k, payload) = pt.split_first().ok_or(Error::Malformed)?;
        let kind = FrameKind::from_u8(k)?;
        if self.awaiting_ready != (kind == FrameKind::Ready) {
            // Ready must be the first frame the device sees, and only then.
            return Err(Error::Malformed);
        }
        self.awaiting_ready = false;
        self.recv_ctr += 1;
        if kind == FrameKind::Close {
            self.peer_closed = true;
        }
        Ok((kind, payload.to_vec()))
    }

    /// True once an authenticated Close arrived. A stream that ends without it
    /// was cut by the transport (or the relay).
    pub fn peer_closed(&self) -> bool {
        self.peer_closed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (Session, Session) {
        let keys = || DirKeys {
            d2b: [1; 32],
            b2d: [2; 32],
        };
        (
            Session::new(Role::Device, keys(), [7; 32]),
            Session::new(Role::Box, keys(), [7; 32]),
        )
    }

    #[test]
    fn device_refuses_anything_but_ready_as_the_first_box_frame() {
        let (mut dev, mut bx) = pair();
        let first = bx.seal(FrameKind::Data, b"not ready").unwrap();
        assert_eq!(dev.open(&first), Err(Error::Malformed));
    }

    #[test]
    fn ready_is_accepted_once_and_only_first() {
        let (mut dev, mut bx) = pair();
        let r = bx.seal(FrameKind::Ready, &[]).unwrap();
        assert_eq!(dev.open(&r).unwrap().0, FrameKind::Ready);
        let again = bx.seal(FrameKind::Ready, &[]).unwrap();
        assert_eq!(dev.open(&again), Err(Error::Malformed));
    }
}
