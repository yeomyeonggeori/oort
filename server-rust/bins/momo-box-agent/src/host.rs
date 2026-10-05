//! The box host: registration state, owner confirmation, attach, PTY.
//!
//! **Inactive until the owner confirms (ADR-0197 D2, ADR-0192 D2).** A
//! [`BoxHost`] starts [`Phase::Pending`]. In that phase it answers no `Hello`,
//! accepts no device list from anywhere, and opens no PTY. It becomes
//! [`Phase::Active`] only when the owner's first signed device list arrives
//! from the runner-local mount ([`RunnerLocalOwnerList`]) and the server has
//! already registered this host as `scope = "member"`. After that the blind
//! relay protocol (`momo-blind-pty`) decides every attach itself: the server
//! is never consulted, and a server-supplied list changes nothing without an
//! owner signature.
//!
//! **PTY lane (D5 lane 2).** An attached owner device sends a Resize frame to
//! say how big its terminal is; that first authenticated frame opens the PTY.
//! Input before it is refused. There is no ACP here and no second lane.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Instant;

use ed25519_dalek::SigningKey;
use momo_blind_pty::codec::{Auth, BoxId, Challenge, Hello, BOX_ID_LEN, ED_PUB_LEN};
use momo_blind_pty::handshake::{BoxAgent, Clock, NonceStore};
use momo_blind_pty::session::{FrameKind, Session};
use momo_blind_pty::trust::{DeviceList, DeviceListState};
use momo_blind_pty::{Error as ProtocolError, MAX_PAYLOAD};
use serde_json::Value;

use crate::env::{child_env, UserProfile};
use crate::fsgate::{FsError, FsGate};
use crate::pty::{Pty, Read, SpawnSpec, WinSize};
use crate::register::{check_registered, RegisterError, Registered};
use crate::spawn_helper::HelperClient;

/// At most this many owner devices attached to one box at once (D5: 2). M4
/// makes it configurable; the box never serves more.
pub const MAX_ATTACHED: usize = 2;

#[derive(Debug, thiserror::Error)]
pub enum HostError {
    #[error("this host is not registered yet")]
    NotRegistered,
    #[error("inactive: the owner has not confirmed this host")]
    NotConfirmed,
    #[error("the owner is already confirmed")]
    AlreadyConfirmed,
    #[error("the owner's device list is for another box or host")]
    WrongBox,
    #[error("too many attached sessions on this box")]
    TooManyAttached,
    #[error("the terminal is not open: the first frame must be a Resize")]
    NotOpened,
    #[error("malformed terminal frame")]
    BadFrame,
    #[error(transparent)]
    Register(#[from] RegisterError),
    #[error("protocol: {0}")]
    Protocol(#[from] ProtocolError),
    #[error(transparent)]
    Gate(#[from] FsError),
    #[error("pty: {0}")]
    Pty(#[from] std::io::Error),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Phase {
    /// Registered or not, the owner has not confirmed: nothing is served.
    Pending,
    Active,
}

/// Monotonic time for challenge expiry (D5: a clock the box trusts, not a
/// wall clock the server could move).
pub struct MonotonicClock(Instant);

impl MonotonicClock {
    pub fn new() -> Self {
        Self(Instant::now())
    }
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self::new()
    }
}

impl Clock for MonotonicClock {
    fn now_ms(&self) -> u64 {
        self.0.elapsed().as_millis() as u64
    }
}

/// The owner's first device list, as the runner placed it on the box (a
/// read-only mount the runner generates, D2). It is the only thing that can
/// confirm a host; the server cannot make one.
pub struct RunnerLocalOwnerList(DeviceList);

impl RunnerLocalOwnerList {
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, HostError> {
        Ok(Self(DeviceList::from_bytes(bytes)?))
    }

    pub fn from_runner_mount(gate: &FsGate, path: &Path) -> Result<Self, HostError> {
        Self::from_bytes(&gate.read(path)?)
    }
}

/// How the person's shell is started.
#[derive(Clone)]
pub struct SpawnTemplate {
    mode: SpawnMode,
}

#[derive(Clone)]
enum SpawnMode {
    /// The box: the spawn helper (the only process with CAP_SETUID/SETGID)
    /// starts the shell at the person's uid; this process holds no capability.
    Helper(Arc<HelperClient>),
    /// A shell at the caller's own uid. Development and tests only: on Linux
    /// `Pty::spawn` refuses it unless `allow_same_uid` is set, and only
    /// [`SpawnTemplate::same_uid_for_tests`] sets that.
    SameUid {
        profile: UserProfile,
        parent_env: Vec<(OsString, OsString)>,
        program: Option<(PathBuf, Vec<String>)>,
    },
}

impl SpawnTemplate {
    pub fn for_box(helper: Arc<HelperClient>) -> Self {
        Self {
            mode: SpawnMode::Helper(helper),
        }
    }

    /// **Not for a box.** Starts the shell at this process's uid.
    pub fn same_uid_for_tests(
        profile: UserProfile,
        parent_env: Vec<(OsString, OsString)>,
        program: Option<(PathBuf, Vec<String>)>,
    ) -> Self {
        Self {
            mode: SpawnMode::SameUid {
                profile,
                parent_env,
                program,
            },
        }
    }

    /// The spawn helper stopped answering (L-A). Always `false` for the same-uid test template.
    pub fn is_poisoned(&self) -> bool {
        match &self.mode {
            SpawnMode::Helper(helper) => helper.is_poisoned(),
            SpawnMode::SameUid { .. } => false,
        }
    }

    fn open(&self, size: WinSize) -> std::io::Result<Pty> {
        match &self.mode {
            SpawnMode::Helper(helper) => helper.spawn(size),
            SpawnMode::SameUid {
                profile,
                parent_env,
                program,
            } => {
                let (program, args) = program
                    .clone()
                    .unwrap_or_else(|| (PathBuf::from(&profile.shell), vec!["-l".to_string()]));
                Pty::spawn(&SpawnSpec {
                    program,
                    args,
                    env: child_env(profile, None, parent_env.clone()),
                    cwd: PathBuf::from(&profile.cwd),
                    size,
                    drop_to: None,
                    allow_same_uid: true,
                })
            }
        }
    }
}

/// Counts attached sessions; releases its slot when the session is dropped.
struct Slot(Arc<AtomicUsize>);

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

pub struct BoxHost {
    box_id: BoxId,
    host: SigningKey,
    clock: Arc<dyn Clock>,
    nonces: Option<NonceStore>,
    registered: Option<Registered>,
    agent: Option<BoxAgent>,
    template: SpawnTemplate,
    attached: Arc<AtomicUsize>,
}

impl BoxHost {
    pub fn new(
        box_id: BoxId,
        host: SigningKey,
        clock: Arc<dyn Clock>,
        nonces: NonceStore,
        template: SpawnTemplate,
    ) -> Self {
        Self {
            box_id,
            host,
            clock,
            nonces: Some(nonces),
            registered: None,
            agent: None,
            template,
            attached: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub fn phase(&self) -> Phase {
        if self.agent.is_some() {
            Phase::Active
        } else {
            Phase::Pending
        }
    }

    /// The person's terminal cannot be started any more: the spawn helper is poisoned and this process holds no
    /// capability to start another (ADR-0197 M4, review L-A).
    pub fn helper_poisoned(&self) -> bool {
        self.template.is_poisoned()
    }

    pub fn host_public_key(&self) -> [u8; ED_PUB_LEN] {
        self.host.verifying_key().to_bytes()
    }

    pub fn registered(&self) -> Option<&Registered> {
        self.registered.as_ref()
    }

    /// Record the server's answer to the registration request. A scope other
    /// than `member`, another type or another key is an error and records
    /// nothing. Registering never activates the host.
    pub fn record_registration(&mut self, answer: &Value) -> Result<(), HostError> {
        use base64::Engine as _;
        let key_b64 =
            base64::engine::general_purpose::STANDARD.encode(self.host.verifying_key().to_bytes());
        self.registered = Some(check_registered(answer, &key_b64)?);
        Ok(())
    }

    /// The owner confirms: install their first device list. Needs a recorded
    /// registration, and the list must be for this box.
    pub fn confirm_owner(&mut self, list: RunnerLocalOwnerList) -> Result<(), HostError> {
        if self.agent.is_some() {
            return Err(HostError::AlreadyConfirmed);
        }
        if self.registered.is_none() {
            return Err(HostError::NotRegistered);
        }
        if list.0.box_id != self.box_id {
            return Err(HostError::WrongBox);
        }
        let devices = DeviceListState::bootstrap(list.0)?;
        let nonces = self.nonces.take().ok_or(HostError::AlreadyConfirmed)?;
        self.agent = Some(BoxAgent::new(
            self.box_id,
            self.host.clone(),
            devices,
            nonces,
            self.clock.clone(),
        )?);
        Ok(())
    }

    fn active(&mut self) -> Result<&mut BoxAgent, HostError> {
        self.agent.as_mut().ok_or(HostError::NotConfirmed)
    }

    /// A device list relayed by the server. Pending hosts refuse it outright;
    /// an active host applies only an owner-signed `version + 1`.
    pub fn on_device_list(&mut self, list: DeviceList) -> Result<(), HostError> {
        Ok(self.active()?.on_device_list(list)?)
    }

    pub fn on_hello(&mut self, hello: Hello) -> Result<Challenge, HostError> {
        Ok(self.active()?.on_hello(hello)?)
    }

    /// Finish the handshake. Returns the attachment (no PTY yet) and the
    /// sealed `Ready` frame to send to the device.
    pub fn on_auth(&mut self, auth: Auth) -> Result<(Attachment, Vec<u8>), HostError> {
        if self.attached.load(Ordering::SeqCst) >= MAX_ATTACHED {
            return Err(HostError::TooManyAttached);
        }
        let template = self.template.clone();
        let (session, ready) = self.active()?.on_auth(auth)?;
        self.attached.fetch_add(1, Ordering::SeqCst);
        Ok((
            Attachment {
                session,
                pty: None,
                template,
                finished: false,
                pending_input: Vec::new(),
                blocked_since: None,
                _slot: Slot(self.attached.clone()),
            },
            ready,
        ))
    }

    /// The spent-nonce store to persist (D5: it survives a restart).
    pub fn nonce_store_bytes(&self) -> Option<Vec<u8>> {
        match (&self.agent, &self.nonces) {
            (Some(agent), _) => Some(agent.nonce_store().to_bytes()),
            (None, Some(store)) => Some(store.to_bytes()),
            _ => None,
        }
    }

    pub fn box_id(&self) -> BoxId {
        self.box_id
    }
}

/// `OORT_BOX_ID` is a UUID; the protocol's box id is its 16 bytes.
pub fn box_id_from_text(text: &str) -> Option<BoxId> {
    let id = uuid::Uuid::parse_str(text.trim()).ok()?;
    let bytes: [u8; BOX_ID_LEN] = *id.as_bytes();
    Some(bytes)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Inbound {
    /// First Resize: the PTY is open.
    Opened,
    Resized,
    Input,
    /// The device sent an authenticated Close; the PTY is gone.
    Closed,
}

/// Input the terminal has not accepted yet may grow to this much before the attach is cut (a paste into a
/// program that never reads). Above the largest burst a person pastes; far below anything that matters to memory.
pub const MAX_PENDING_INPUT: usize = 256 * 1024;
/// How long the terminal may accept none of the pending input before the attach is cut.
pub const INPUT_STALL: std::time::Duration = std::time::Duration::from_secs(3);

/// One authenticated attach: a protocol session and, once the device has said
/// how big its terminal is, a PTY.
pub struct Attachment {
    session: Session,
    pty: Option<Pty>,
    template: SpawnTemplate,
    finished: bool,
    /// Input the terminal has not taken yet. Written without waiting, between reads of the terminal's output, so
    /// neither direction can block the other.
    pending_input: Vec<u8>,
    blocked_since: Option<Instant>,
    _slot: Slot,
}

impl Attachment {
    pub fn is_open(&self) -> bool {
        self.pty.is_some()
    }

    pub fn pty_child_id(&self) -> Option<u32> {
        self.pty.as_ref().map(Pty::child_id)
    }

    /// One frame from the device. Any protocol failure poisons the session
    /// (the caller drops the attachment and the relay connection).
    pub fn on_frame(&mut self, frame: &[u8]) -> Result<Inbound, HostError> {
        let (kind, payload) = self.session.open(frame)?;
        match kind {
            FrameKind::Resize => {
                let size = WinSize::from_payload(&payload).ok_or(HostError::BadFrame)?;
                match self.pty.as_mut() {
                    Some(pty) => {
                        pty.resize(size)?;
                        Ok(Inbound::Resized)
                    }
                    None => {
                        self.pty = Some(self.template.open(size)?);
                        Ok(Inbound::Opened)
                    }
                }
            }
            FrameKind::Data => {
                if self.pty.is_none() {
                    return Err(HostError::NotOpened);
                }
                if self.pending_input.len() + payload.len() > MAX_PENDING_INPUT {
                    return Err(HostError::Pty(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "the terminal is not taking input",
                    )));
                }
                self.pending_input.extend_from_slice(&payload);
                self.flush_input()?;
                Ok(Inbound::Input)
            }
            FrameKind::Close => {
                self.pty = None;
                self.finished = true;
                Ok(Inbound::Closed)
            }
            // `Session::open` already refuses a Ready on the box side.
            FrameKind::Ready => Err(HostError::BadFrame),
        }
    }

    /// Write what the terminal will take now; keep the rest. No progress for [`INPUT_STALL`] while input waits is the
    /// terminal not reading (`TimedOut`, the same verdict the blocking write gave at M3).
    fn flush_input(&mut self) -> Result<(), HostError> {
        let Some(pty) = self.pty.as_mut() else {
            return Ok(());
        };
        while !self.pending_input.is_empty() {
            let written = pty.try_write(&self.pending_input)?;
            if written == 0 {
                let since = *self.blocked_since.get_or_insert_with(Instant::now);
                if since.elapsed() > INPUT_STALL {
                    return Err(HostError::Pty(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "the terminal did not accept input in time",
                    )));
                }
                return Ok(());
            }
            self.blocked_since = None;
            self.pending_input.drain(..written);
        }
        self.blocked_since = None;
        Ok(())
    }

    /// Output ready within `wait_ms`, sealed as frames for the device. When
    /// the shell exits the last frame is an authenticated `Close`.
    pub fn pump(&mut self, wait_ms: i32) -> Result<Vec<Vec<u8>>, HostError> {
        let mut frames = Vec::new();
        if self.finished {
            return Ok(frames);
        }
        self.flush_input()?;
        let Some(pty) = self.pty.as_mut() else {
            return Ok(frames);
        };
        let mut buf = vec![0u8; MAX_PAYLOAD.min(8192)];
        let mut wait = wait_ms;
        loop {
            match pty.read_timeout(&mut buf, wait)? {
                Read::Data(n) => {
                    frames.push(self.session.seal(FrameKind::Data, &buf[..n])?);
                    // Drain what is already there without waiting again.
                    wait = 0;
                }
                Read::Timeout => break,
                Read::Eof => {
                    frames.push(self.session.seal(FrameKind::Close, &[])?);
                    self.finished = true;
                    self.pty = None;
                    break;
                }
            }
            if frames.len() >= 64 {
                break;
            }
        }
        Ok(frames)
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }
}
