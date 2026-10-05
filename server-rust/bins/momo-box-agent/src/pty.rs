//! The PTY the owner attaches to (ADR-0197 D5 lane 2).
//!
//! In a box the shell is started by the **spawn helper** (`spawn_helper.rs`),
//! a separate process that holds `CAP_SETUID/SETGID`, never sees the host key
//! and receives nothing but a terminal size. It starts the person's shell at
//! the person's uid with every capability cleared and hands the PTY master to
//! the agent over a Unix socket. The agent itself keeps no capability at all
//! (review of #3503, M1). [`Pty::spawn`] is the local half of that: `openpty`,
//! a child that is a session leader, and — on Linux — the uid drop.
//!
//! On Linux a spawn **without** the drop is refused unless the spec says
//! `allow_same_uid`, which only tests and `SpawnTemplate::same_uid_for_tests`
//! set (L3).
//!
//! The drop (Linux, `pre_exec`, async-signal-safe calls only): `setsid`,
//! controlling tty, `setgroups([])`, `setresgid`, `setresuid`, then every
//! capability set is cleared ([`clear_capabilities`]) and `no_new_privs` is set.

use std::ffi::OsString;
use std::io;
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Largest terminal either dimension (a sanity cap, not a layout rule).
pub const MAX_DIM: u16 = 1000;

/// How long a write to a PTY that does not read may wait before it fails
/// (M2): a stalled shell must not stall the agent.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WinSize {
    pub cols: u16,
    pub rows: u16,
}

impl WinSize {
    /// `cols` and `rows` as the device's Resize frame carries them
    /// (4 bytes, big endian). Zero or absurd sizes are refused.
    pub fn from_payload(payload: &[u8]) -> Option<Self> {
        let bytes: [u8; 4] = payload.try_into().ok()?;
        let cols = u16::from_be_bytes([bytes[0], bytes[1]]);
        let rows = u16::from_be_bytes([bytes[2], bytes[3]]);
        ((1..=MAX_DIM).contains(&cols) && (1..=MAX_DIM).contains(&rows))
            .then_some(Self { cols, rows })
    }

    pub fn to_payload(self) -> [u8; 4] {
        let c = self.cols.to_be_bytes();
        let r = self.rows.to_be_bytes();
        [c[0], c[1], r[0], r[1]]
    }

    fn raw(self) -> libc::winsize {
        libc::winsize {
            ws_row: self.rows,
            ws_col: self.cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ids {
    pub uid: u32,
    pub gid: u32,
}

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: PathBuf,
    pub args: Vec<String>,
    /// The whole environment. Nothing is inherited (`env_clear`).
    pub env: Vec<(String, String)>,
    pub cwd: PathBuf,
    pub size: WinSize,
    /// Drop to these ids before `exec` (Linux). `None` keeps the caller's.
    pub drop_to: Option<Ids>,
    /// Permit `drop_to: None` on Linux. Tests only (L3).
    pub allow_same_uid: bool,
}

pub enum Read {
    Data(usize),
    Timeout,
    /// The slave side closed: the shell exited.
    Eof,
}

enum ChildHandle {
    /// Started by this process: it is also the one that reaps it.
    Local(Child),
    /// Started by the spawn helper, which reaps it.
    Remote(u32),
}

pub struct Pty {
    master: Option<OwnedFd>,
    child: Option<ChildHandle>,
}

fn cvt(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) }).map(|_| ())
}

pub(crate) fn set_nonblocking(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor we own.
    let flags = cvt(unsafe { libc::fcntl(fd, libc::F_GETFL) })?;
    cvt(unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) }).map(|_| ())
}

/// A new pseudo-terminal: `(master, slave)`, both close-on-exec from birth
/// where the OS allows it (L1: `posix_openpt(O_CLOEXEC)` and `TIOCGPTPEER`).
fn open_pair(size: WinSize) -> io::Result<(OwnedFd, OwnedFd)> {
    let winsize = size.raw();
    #[cfg(target_os = "linux")]
    {
        // SAFETY: plain libc calls; every fd is wrapped at once.
        let master = unsafe {
            let fd = cvt(libc::posix_openpt(
                libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
            ))?;
            OwnedFd::from_raw_fd(fd)
        };
        cvt(unsafe { libc::grantpt(master.as_raw_fd()) })?;
        cvt(unsafe { libc::unlockpt(master.as_raw_fd()) })?;
        cvt(unsafe { libc::ioctl(master.as_raw_fd(), libc::TIOCSWINSZ as _, &winsize) })?;
        // The slave without a path: no name to race, close-on-exec at once.
        let slave = unsafe {
            let fd = cvt(libc::ioctl(
                master.as_raw_fd(),
                libc::TIOCGPTPEER as _,
                libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC,
            ))?;
            OwnedFd::from_raw_fd(fd)
        };
        Ok((master, slave))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut master: RawFd = -1;
        let mut slave: RawFd = -1;
        // SAFETY: openpty fills the two descriptors; the winsize is valid.
        cvt(unsafe {
            libc::openpty(
                &mut master,
                &mut slave,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &winsize as *const libc::winsize as *mut libc::winsize,
            )
        })?;
        // SAFETY: both are fresh descriptors we own.
        let (master, slave) =
            unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
        set_cloexec(master.as_raw_fd())?;
        set_cloexec(slave.as_raw_fd())?;
        Ok((master, slave))
    }
}

/// Empty every capability set of the calling thread (permitted, effective,
/// inheritable, ambient) and verify it. Async-signal-safe: it only issues
/// syscalls, so it may run between `fork` and `exec`.
#[cfg(target_os = "linux")]
pub(crate) unsafe fn clear_capabilities() -> io::Result<()> {
    #[repr(C)]
    struct Header {
        version: u32,
        pid: i32,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct Data {
        effective: u32,
        permitted: u32,
        inheritable: u32,
    }
    const LINUX_CAPABILITY_VERSION_3: u32 = 0x2008_0522;

    cvt(libc::prctl(
        libc::PR_CAP_AMBIENT,
        libc::PR_CAP_AMBIENT_CLEAR_ALL as libc::c_ulong,
        0,
        0,
        0,
    ))?;
    // Bounding set: needs CAP_SETPCAP, which a box does not grant; best effort.
    for cap in 0..64 {
        let _ = libc::prctl(libc::PR_CAPBSET_DROP, cap as libc::c_ulong, 0, 0, 0);
    }
    let header = Header {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    let empty = [Data {
        effective: 0,
        permitted: 0,
        inheritable: 0,
    }; 2];
    cvt(libc::syscall(libc::SYS_capset, &header, empty.as_ptr()) as libc::c_int)?;
    let mut now = [Data {
        effective: 1,
        permitted: 1,
        inheritable: 1,
    }; 2];
    let header = Header {
        version: LINUX_CAPABILITY_VERSION_3,
        pid: 0,
    };
    cvt(libc::syscall(libc::SYS_capget, &header, now.as_mut_ptr()) as libc::c_int)?;
    if now
        .iter()
        .any(|d| d.effective != 0 || d.permitted != 0 || d.inheritable != 0)
    {
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
    Ok(())
}

/// Everything after the uid change. Calls only async-signal-safe functions and
/// allocates nothing (it runs between `fork` and `exec`).
#[cfg(target_os = "linux")]
pub(crate) unsafe fn drop_privileges(ids: Ids) -> io::Result<()> {
    cvt(libc::setgroups(0, std::ptr::null()))?;
    cvt(libc::setresgid(ids.gid, ids.gid, ids.gid))?;
    cvt(libc::setresuid(ids.uid, ids.uid, ids.uid))?;
    // The capabilities this process was handed so it could do exactly this
    // must not survive exec into the person's shell.
    clear_capabilities()?;
    if libc::getuid() != ids.uid || libc::geteuid() != ids.uid || libc::getgid() != ids.gid {
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
    // Setting uid back is now impossible: no capability, and no_new_privs below.
    if libc::setuid(0) == 0 {
        return Err(io::Error::from_raw_os_error(libc::EPERM));
    }
    Ok(())
}

impl Pty {
    /// Start the program on a new PTY, as this process.
    pub fn spawn(spec: &SpawnSpec) -> io::Result<Self> {
        #[cfg(target_os = "linux")]
        if spec.drop_to.is_none() && !spec.allow_same_uid {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "refusing to start a shell at the agent's own uid (no drop_to)",
            ));
        }
        let (master, slave) = open_pair(spec.size)?;
        set_nonblocking(master.as_raw_fd())?;

        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .env_clear()
            .envs(
                spec.env
                    .iter()
                    .map(|(n, v)| (OsString::from(n), OsString::from(v))),
            )
            .current_dir(&spec.cwd)
            .stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        let drop_to = spec.drop_to;
        #[cfg(not(target_os = "linux"))]
        if drop_to.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "dropping to the person's uid is Linux-only (the box)",
            ));
        }
        // SAFETY: the closure uses only async-signal-safe libc calls.
        unsafe {
            command.pre_exec(move || {
                cvt(libc::setsid())?;
                cvt(libc::ioctl(0, libc::TIOCSCTTY as _, 0))?;
                #[cfg(target_os = "linux")]
                {
                    if let Some(ids) = drop_to {
                        drop_privileges(ids)?;
                    }
                    cvt(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))?;
                }
                #[cfg(not(target_os = "linux"))]
                let _ = drop_to;
                Ok(())
            });
        }
        let child = command.spawn()?;
        drop(slave);
        Ok(Self {
            master: Some(master),
            child: Some(ChildHandle::Local(child)),
        })
    }

    /// A PTY started elsewhere (the spawn helper): the master and the shell's pid.
    pub(crate) fn from_remote(master: OwnedFd, pid: u32) -> io::Result<Self> {
        set_nonblocking(master.as_raw_fd())?;
        Ok(Self {
            master: Some(master),
            child: Some(ChildHandle::Remote(pid)),
        })
    }

    /// Give up the master and the child without hanging the terminal up (the
    /// helper sends the master to the agent and keeps the child to reap it).
    pub(crate) fn detach(mut self) -> io::Result<(OwnedFd, Child)> {
        match (self.master.take(), self.child.take()) {
            (Some(master), Some(ChildHandle::Local(child))) => Ok((master, child)),
            _ => Err(io::Error::other(
                "only a locally started pty can be detached",
            )),
        }
    }

    fn fd(&self) -> RawFd {
        self.master.as_ref().map_or(-1, |m| m.as_raw_fd())
    }

    pub fn child_id(&self) -> u32 {
        match self.child.as_ref() {
            Some(ChildHandle::Local(c)) => c.id(),
            Some(ChildHandle::Remote(pid)) => *pid,
            None => 0,
        }
    }

    /// Write to the terminal. The master is non-blocking: a shell that never
    /// reads makes this fail with `TimedOut` after [`WRITE_TIMEOUT`] instead of
    /// blocking the caller (M2).
    pub fn write_all(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        let deadline = Instant::now() + WRITE_TIMEOUT;
        while !bytes.is_empty() {
            // SAFETY: valid pointer/length of a live slice, owned descriptor.
            let n = unsafe { libc::write(self.fd(), bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 {
                bytes = &bytes[n as usize..];
                continue;
            }
            let error = io::Error::last_os_error();
            match error.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => {
                    let left = deadline.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return Err(io::Error::new(
                            io::ErrorKind::TimedOut,
                            "the terminal did not accept input in time",
                        ));
                    }
                    let mut poll = libc::pollfd {
                        fd: self.fd(),
                        events: libc::POLLOUT,
                        revents: 0,
                    };
                    // SAFETY: one valid pollfd.
                    unsafe { libc::poll(&mut poll, 1, left.as_millis().clamp(1, 1000) as i32) };
                }
                _ => return Err(error),
            }
        }
        Ok(())
    }

    /// Write as much as the terminal accepts **right now** and return how many bytes that was (0 when it accepts
    /// none). Never waits: the caller keeps the rest and reads the terminal's output meanwhile, so a large paste
    /// into a program that echoes cannot deadlock against its own output (ADR-0197 M4).
    pub fn try_write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        loop {
            // SAFETY: valid pointer/length of a live slice, owned descriptor.
            let n = unsafe { libc::write(self.fd(), bytes.as_ptr().cast(), bytes.len()) };
            if n >= 0 {
                return Ok(n as usize);
            }
            let error = io::Error::last_os_error();
            match error.kind() {
                io::ErrorKind::Interrupted => continue,
                io::ErrorKind::WouldBlock => return Ok(0),
                _ => return Err(error),
            }
        }
    }

    /// Read up to `buf.len()` bytes, waiting at most `timeout_ms`.
    pub fn read_timeout(&mut self, buf: &mut [u8], timeout_ms: i32) -> io::Result<Read> {
        let mut poll = libc::pollfd {
            fd: self.fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, timeout_ms) };
        if ready < 0 {
            let e = io::Error::last_os_error();
            return if e.kind() == io::ErrorKind::Interrupted {
                Ok(Read::Timeout)
            } else {
                Err(e)
            };
        }
        if ready == 0 {
            return Ok(Read::Timeout);
        }
        // SAFETY: valid buffer, owned descriptor.
        let n = unsafe { libc::read(self.fd(), buf.as_mut_ptr().cast(), buf.len()) };
        if n < 0 {
            let e = io::Error::last_os_error();
            // Linux reports a closed slave as EIO.
            return match (e.raw_os_error(), e.kind()) {
                (Some(libc::EIO), _) => Ok(Read::Eof),
                (_, io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) => Ok(Read::Timeout),
                _ => Err(e),
            };
        }
        Ok(if n == 0 {
            Read::Eof
        } else {
            Read::Data(n as usize)
        })
    }

    pub fn resize(&mut self, size: WinSize) -> io::Result<()> {
        let winsize = size.raw();
        // SAFETY: TIOCSWINSZ reads a winsize from the pointer.
        cvt(unsafe { libc::ioctl(self.fd(), libc::TIOCSWINSZ as _, &winsize) })?;
        Ok(())
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        // Closing the master hangs the terminal up: the kernel sends SIGHUP to
        // the foreground process group, which works across uids. A box agent
        // cannot signal the person's processes directly (different uid, no
        // CAP_KILL, and it should not have one), so this is the way it ends a
        // shell. Where the uids match (a Mac, tests) the group is also killed.
        drop(self.master.take());
        let Some(ChildHandle::Local(mut child)) = self.child.take() else {
            return; // a remote child is the helper's to reap
        };
        let pgid = child.id() as libc::pid_t;
        // SAFETY: signalling our own child's group; failure (EPERM across
        // uids) is expected and ignored.
        unsafe {
            libc::killpg(pgid, libc::SIGHUP);
            libc::killpg(pgid, libc::SIGKILL);
        }
        for _ in 0..30 {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // Never block on a shell that ignores the hangup, never leave a zombie
        // either (L4): a detached thread waits for it whenever it ends.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}
