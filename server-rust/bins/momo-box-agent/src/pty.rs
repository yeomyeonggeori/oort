//! The PTY the owner attaches to (ADR-0197 D5 lane 2).
//!
//! `libc::openpty` + a child that is a session leader on the slave side. In a
//! box the child is dropped to the **person's uid** before `exec` (the agent
//! keeps its own uid and the host key with it, D1); everywhere else (a Mac in
//! development, the loopback tests) it stays at the caller's uid.
//!
//! The drop (Linux, `pre_exec`, async-signal-safe calls only): `setsid`,
//! controlling tty, `setgroups([])`, `setresgid`, `setresuid`, then the agent's
//! capabilities are cleared (`PR_CAP_AMBIENT_CLEAR_ALL`, bounding set where
//! allowed, `capset` to empty) and `no_new_privs` is set. The child ends with
//! `CapPrm/CapEff/CapInh/CapAmb = 0`; `verify-m3.sh` reads them from inside.

use std::ffi::OsString;
use std::io;
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

/// Largest terminal either dimension (a sanity cap, not a layout rule).
pub const MAX_DIM: u16 = 1000;

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
}

pub enum Read {
    Data(usize),
    Timeout,
    /// The slave side closed: the shell exited.
    Eof,
}

pub struct Pty {
    master: Option<OwnedFd>,
    child: Child,
}

fn cvt(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

/// Everything after the uid change. Calls only async-signal-safe functions and
/// allocates nothing (it runs between `fork` and `exec`).
#[cfg(target_os = "linux")]
unsafe fn drop_privileges(ids: Ids) -> io::Result<()> {
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

    cvt(libc::setgroups(0, std::ptr::null()))?;
    cvt(libc::setresgid(ids.gid, ids.gid, ids.gid))?;
    cvt(libc::setresuid(ids.uid, ids.uid, ids.uid))?;
    // The agent's ambient capabilities (setuid/setgid, handed to it so it can
    // do exactly this) must not survive exec into the person's shell.
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
    pub fn spawn(spec: &SpawnSpec) -> io::Result<Self> {
        let mut master: RawFd = -1;
        let mut slave: RawFd = -1;
        let winsize = spec.size.raw();
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
        cvt(unsafe { libc::fcntl(master.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) })?;
        cvt(unsafe { libc::fcntl(slave.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) })?;

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
            child,
        })
    }

    fn fd(&self) -> RawFd {
        self.master.as_ref().map_or(-1, |m| m.as_raw_fd())
    }

    pub fn child_id(&self) -> u32 {
        self.child.id()
    }

    pub fn write_all(&mut self, mut bytes: &[u8]) -> io::Result<()> {
        while !bytes.is_empty() {
            // SAFETY: valid pointer/length of a live slice, owned descriptor.
            let n = unsafe { libc::write(self.fd(), bytes.as_ptr().cast(), bytes.len()) };
            if n < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            bytes = &bytes[n as usize..];
        }
        Ok(())
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
            return if e.raw_os_error() == Some(libc::EIO) {
                Ok(Read::Eof)
            } else {
                Err(e)
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

    pub fn try_wait(&mut self) -> io::Result<Option<std::process::ExitStatus>> {
        self.child.try_wait()
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
        let pgid = self.child.id() as libc::pid_t;
        // SAFETY: signalling our own child's group; failure (EPERM across
        // uids) is expected and ignored.
        unsafe {
            libc::killpg(pgid, libc::SIGHUP);
            libc::killpg(pgid, libc::SIGKILL);
        }
        // Never block on a shell that ignores the hangup.
        for _ in 0..30 {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
