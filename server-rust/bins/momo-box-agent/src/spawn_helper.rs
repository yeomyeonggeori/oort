//! The spawn helper (review of #3503, M1): the only process in the box that
//! can change uid, and the only thing it does is start the person's shell.
//!
//! ```text
//!   momo-box-agent (uid A, host key, relay parsing)     no capabilities
//!        |  4 bytes: cols, rows        ^ 5 bytes + the PTY master (SCM_RIGHTS)
//!        v                             |
//!   momo-box-agent spawn-helper (uid H)                 CAP_SETUID + CAP_SETGID
//!        |  fork, setgroups/setres[gu]id U, clear every capability, exec shell
//!        v
//!   the person's shell (uid U, no capability)
//! ```
//!
//! * The agent starts the helper **first**, then clears its own capabilities.
//!   A compromised agent can no longer `setuid` to the person (and read their
//!   login); it can only ask the helper for a terminal of a given size.
//! * The helper runs under a third uid `H`, so it cannot read the host key,
//!   and it is started with an empty environment and one argument: the shell,
//!   its environment and the person's ids, all fixed by the agent at start.
//!   Requests cannot change any of them.
//! * Its whole input is 4 bytes per request, validated as a window size.

use std::io;
use std::os::fd::{AsRawFd as _, FromRawFd as _, OwnedFd, RawFd};
use std::os::unix::process::CommandExt as _;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};

use crate::env::UserProfile;
use crate::pty::{Ids, Pty, SpawnSpec, WinSize};

pub const SUBCOMMAND: &str = "spawn-helper";
/// The socket's descriptor number in the helper.
const SOCKET_FD: RawFd = 3;
/// Live shells the helper keeps at once.
pub const MAX_SHELLS: usize = 4;
const REPLY_LEN: usize = 5;

/// What the helper starts, fixed when the helper starts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperSpec {
    pub user: Ids,
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub env: Vec<(String, String)>,
}

impl HelperSpec {
    /// The person's login shell from the box profile, with the (already
    /// allowlisted) environment.
    pub fn login_shell(profile: &UserProfile, env: Vec<(String, String)>) -> Self {
        Self {
            user: Ids {
                uid: profile.uid,
                gid: profile.gid,
            },
            program: PathBuf::from(&profile.shell),
            args: vec!["-l".into()],
            cwd: PathBuf::from(&profile.cwd),
            env,
        }
    }

    pub fn to_json(&self) -> String {
        json!({
            "uid": self.user.uid,
            "gid": self.user.gid,
            "program": self.program,
            "args": self.args,
            "cwd": self.cwd,
            "env": self.env,
        })
        .to_string()
    }

    /// Parse a spec for the helper running as the calling process.
    pub fn from_json(text: &str) -> Option<Self> {
        // SAFETY: getters cannot fail.
        let own = Ids {
            uid: unsafe { libc::geteuid() },
            gid: unsafe { libc::getegid() },
        };
        Self::from_json_for(text, own)
    }

    /// As [`Self::from_json`] for a helper running as `own`: a spec that names
    /// the helper's own uid or gid as the person (a shell with the helper's
    /// identity) is refused (L-C).
    pub fn from_json_for(text: &str, own: Ids) -> Option<Self> {
        let v: Value = serde_json::from_str(text).ok()?;
        let s = |k: &str| v.get(k)?.as_str().map(str::to_string);
        let env = v
            .get("env")?
            .as_array()?
            .iter()
            .map(|p| {
                Some((
                    p.get(0)?.as_str()?.to_string(),
                    p.get(1)?.as_str()?.to_string(),
                ))
            })
            .collect::<Option<Vec<_>>>()?;
        let args = v
            .get("args")?
            .as_array()?
            .iter()
            .map(|a| a.as_str().map(str::to_string))
            .collect::<Option<Vec<_>>>()?;
        let user = Ids {
            uid: u32::try_from(v.get("uid")?.as_u64()?).ok()?,
            gid: u32::try_from(v.get("gid")?.as_u64()?).ok()?,
        };
        // The helper never starts a shell as root, whatever it is told.
        (user.uid != 0 && user.gid != 0 && user.uid != own.uid && user.gid != own.gid)
            .then_some(())?;
        Some(Self {
            user,
            program: PathBuf::from(s("program")?),
            args,
            cwd: PathBuf::from(s("cwd")?),
            env,
        })
    }
}

fn cvt(rc: libc::c_int) -> io::Result<libc::c_int> {
    if rc < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(rc)
    }
}

/// `data` plus any number of descriptors (SCM_RIGHTS). Production sends zero
/// or one; the test sends many to prove the receiver owns every one.
fn send_with_fds(sock: RawFd, data: &[u8], fds: &[RawFd]) -> io::Result<()> {
    let mut cbuf = [0u64; 64]; // aligned, larger than CMSG_SPACE(4 * 100)
    let mut iov = libc::iovec {
        iov_base: data.as_ptr() as *mut libc::c_void,
        iov_len: data.len(),
    };
    let bytes = std::mem::size_of_val(fds);
    // SAFETY: msghdr is zero-initialised then filled with pointers that outlive the call.
    unsafe {
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        if !fds.is_empty() {
            msg.msg_control = cbuf.as_mut_ptr().cast();
            msg.msg_controllen = libc::CMSG_SPACE(bytes as u32) as _;
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(bytes as u32) as _;
            std::ptr::copy_nonoverlapping(fds.as_ptr().cast::<u8>(), libc::CMSG_DATA(cmsg), bytes);
        }
        loop {
            let n = libc::sendmsg(sock, &msg, 0);
            if n >= 0 {
                if n as usize == data.len() {
                    return Ok(());
                }
                // The descriptors travelled with the first bytes; send the rest plainly.
                return write_all_fd(sock, &data[n as usize..]);
            }
            let e = io::Error::last_os_error();
            if e.kind() != io::ErrorKind::Interrupted {
                return Err(e);
            }
        }
    }
}

fn write_all_fd(sock: RawFd, mut bytes: &[u8]) -> io::Result<()> {
    while !bytes.is_empty() {
        // SAFETY: valid slice, open socket.
        let n = unsafe { libc::write(sock, bytes.as_ptr().cast(), bytes.len()) };
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

/// Read exactly `buf.len()` bytes. Returns **every** descriptor that arrived
/// (M-A of the #3503 re-review): all are wrapped as `OwnedFd` the moment they
/// are taken from the message, so none can leak, and each is close-on-exec
/// (`MSG_CMSG_CLOEXEC` on Linux, `fcntl` elsewhere). A truncated control
/// message (`MSG_CTRUNC`: more descriptors than the buffer holds, the kernel
/// has already closed the excess) is an error.
fn recv_exact_with_fds(sock: RawFd, buf: &mut [u8]) -> io::Result<Vec<OwnedFd>> {
    #[cfg(target_os = "linux")]
    const RECV_FLAGS: libc::c_int = libc::MSG_CMSG_CLOEXEC;
    #[cfg(not(target_os = "linux"))]
    const RECV_FLAGS: libc::c_int = 0;
    let mut got = 0usize;
    let mut received: Vec<OwnedFd> = Vec::new();
    let mut truncated = false;
    while got < buf.len() {
        let mut cbuf = [0u64; 8];
        let mut iov = libc::iovec {
            iov_base: buf[got..].as_mut_ptr().cast(),
            iov_len: buf.len() - got,
        };
        // SAFETY: as in send_with_fds; the control buffer outlives the call and
        // every descriptor found in it is owned exactly once.
        let n = unsafe {
            let mut msg: libc::msghdr = std::mem::zeroed();
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = cbuf.as_mut_ptr().cast();
            msg.msg_controllen = std::mem::size_of_val(&cbuf) as _;
            let n = libc::recvmsg(sock, &mut msg, RECV_FLAGS);
            if n >= 0 {
                truncated |= msg.msg_flags & libc::MSG_CTRUNC != 0;
                let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
                while !cmsg.is_null() {
                    if (*cmsg).cmsg_level == libc::SOL_SOCKET
                        && (*cmsg).cmsg_type == libc::SCM_RIGHTS
                    {
                        // Never read past the control buffer, whatever cmsg_len claims
                        // (a truncated message may report more than it holds).
                        let data = libc::CMSG_DATA(cmsg);
                        let end = cbuf.as_ptr() as usize + std::mem::size_of_val(&cbuf);
                        let room = end.saturating_sub(data as usize);
                        let claimed =
                            ((*cmsg).cmsg_len as usize).saturating_sub(libc::CMSG_LEN(0) as usize);
                        let payload = claimed.min(room);
                        for i in 0..payload / 4 {
                            let mut fd: RawFd = -1;
                            std::ptr::copy_nonoverlapping(
                                data.add(i * 4),
                                (&mut fd as *mut RawFd).cast::<u8>(),
                                4,
                            );
                            if fd >= 0 {
                                let _ = libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                                received.push(OwnedFd::from_raw_fd(fd));
                            }
                        }
                    }
                    cmsg = libc::CMSG_NXTHDR(&msg, cmsg);
                }
            }
            n
        };
        if n < 0 {
            let e = io::Error::last_os_error();
            if e.kind() == io::ErrorKind::Interrupted {
                continue;
            }
            return Err(e);
        }
        if n == 0 {
            return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "peer closed"));
        }
        got += n as usize;
    }
    if truncated {
        // `received` drops here: everything that did arrive is closed.
        return Err(io::Error::other(
            "control message truncated (too many descriptors)",
        ));
    }
    Ok(received)
}

/// The agent's end: asks the helper for terminals.
pub struct HelperClient {
    sock: Mutex<Option<OwnedFd>>,
    process: Mutex<Child>,
    /// Set after any I/O failure on the socket (L-A): the connection is closed
    /// and never reused, so a late reply cannot be read as a later session's
    /// master. The agent must start a new helper to continue.
    poisoned: std::sync::atomic::AtomicBool,
}

impl HelperClient {
    /// Start `exe spawn-helper <spec>` under `helper_ids`. The caller must
    /// hold `CAP_SETUID/SETGID` (ambient) at this moment and should clear its
    /// own capabilities right after (`preflight::drop_capabilities`).
    pub fn start(exe: &Path, spec: &HelperSpec, helper_ids: Ids) -> io::Result<Self> {
        let mut fds = [0 as RawFd; 2];
        // SAFETY: socketpair fills two descriptors.
        cvt(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) })?;
        // SAFETY: fresh descriptors we own.
        let (mine, theirs) =
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        for fd in [mine.as_raw_fd(), theirs.as_raw_fd()] {
            cvt(unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) })?;
        }
        let tv = libc::timeval {
            tv_sec: 10,
            tv_usec: 0,
        };
        // A helper that stops answering must not hang the agent.
        cvt(unsafe {
            libc::setsockopt(
                mine.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_RCVTIMEO,
                (&tv as *const libc::timeval).cast(),
                std::mem::size_of::<libc::timeval>() as _,
            )
        })?;
        let child_end = theirs.as_raw_fd();
        let mut command = Command::new(exe);
        command
            .arg(SUBCOMMAND)
            .arg(spec.to_json())
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null());
        // SAFETY: only async-signal-safe libc calls between fork and exec.
        unsafe {
            command.pre_exec(move || {
                if child_end == SOCKET_FD {
                    cvt(libc::fcntl(SOCKET_FD, libc::F_SETFD, 0))?;
                } else {
                    cvt(libc::dup2(child_end, SOCKET_FD))?;
                }
                #[cfg(target_os = "linux")]
                {
                    cvt(libc::setgroups(0, std::ptr::null()))?;
                    cvt(libc::setresgid(
                        helper_ids.gid,
                        helper_ids.gid,
                        helper_ids.gid,
                    ))?;
                    cvt(libc::setresuid(
                        helper_ids.uid,
                        helper_ids.uid,
                        helper_ids.uid,
                    ))?;
                }
                #[cfg(not(target_os = "linux"))]
                let _ = helper_ids;
                Ok(())
            });
        }
        let process = command.spawn()?;
        drop(theirs);
        Ok(Self {
            sock: Mutex::new(Some(mine)),
            process: Mutex::new(process),
            poisoned: std::sync::atomic::AtomicBool::new(false),
        })
    }

    pub fn pid(&self) -> u32 {
        self.process.lock().map_or(0, |p| p.id())
    }

    /// A new PTY of `size`, its shell started by the helper.
    pub fn spawn(&self, size: WinSize) -> io::Result<Pty> {
        use std::sync::atomic::Ordering;
        let mut guard = self
            .sock
            .lock()
            .map_err(|_| io::Error::other("helper socket poisoned"))?;
        let Some(fd) = guard.as_ref().map(|f| f.as_raw_fd()) else {
            return Err(io::Error::other(
                "the spawn helper connection was closed; start a new helper",
            ));
        };
        let exchange = (|| {
            write_all_fd(fd, &size.to_payload())?;
            let mut reply = [0u8; REPLY_LEN];
            let fds = recv_exact_with_fds(fd, &mut reply)?;
            Ok::<_, io::Error>((reply, fds))
        })();
        let (reply, mut fds) = match exchange {
            Ok(done) => done,
            Err(e) => {
                // Timeout, EOF, truncation: the stream's state is unknown.
                self.poisoned.store(true, Ordering::SeqCst);
                drop(guard.take());
                return Err(e);
            }
        };
        match (reply[0], fds.len()) {
            (0, 1) => Pty::from_remote(
                fds.remove(0),
                u32::from_be_bytes([reply[1], reply[2], reply[3], reply[4]]),
            ),
            (0, _) => {
                // A success carries exactly one descriptor; anything else is a
                // protocol violation, and the stream cannot be trusted.
                self.poisoned.store(true, Ordering::SeqCst);
                drop(guard.take());
                Err(io::Error::other(
                    "spawn helper sent an unexpected descriptor count",
                ))
            }
            (status, _) => Err(io::Error::other(format!("spawn helper refused ({status})"))),
        }
    }

    /// Test hook for `momo-box-probe` (M-A): send a valid request that carries
    /// `n` extra pipe descriptors and return the helper's status byte (4 =
    /// refused). A real agent never does this.
    #[doc(hidden)]
    pub fn flood_for_test(&self, n: usize) -> io::Result<u8> {
        let guard = self
            .sock
            .lock()
            .map_err(|_| io::Error::other("helper socket poisoned"))?;
        let fd = guard
            .as_ref()
            .ok_or_else(|| io::Error::other("closed"))?
            .as_raw_fd();
        let mut held = Vec::new();
        for _ in 0..n {
            let mut p = [0 as RawFd; 2];
            cvt(unsafe { libc::pipe(p.as_mut_ptr()) })?;
            held.push(unsafe { OwnedFd::from_raw_fd(p[0]) });
            held.push(unsafe { OwnedFd::from_raw_fd(p[1]) });
        }
        let raws: Vec<RawFd> = held.iter().map(|f| f.as_raw_fd()).collect();
        send_with_fds(fd, &WinSize { cols: 80, rows: 24 }.to_payload(), &raws)?;
        let mut reply = [0u8; REPLY_LEN];
        let fds = recv_exact_with_fds(fd, &mut reply)?;
        if fds.is_empty() {
            Ok(reply[0])
        } else {
            Err(io::Error::other("unexpected descriptor"))
        }
    }

    /// Whether this client gave up its connection after a failure.
    pub fn is_poisoned(&self) -> bool {
        self.poisoned.load(std::sync::atomic::Ordering::SeqCst)
    }
}

impl Drop for HelperClient {
    fn drop(&mut self) {
        // Close the socket FIRST: that is what ends the helper's loop (it runs
        // under another uid, so this process could not signal it anyway).
        if let Ok(mut sock) = self.sock.lock() {
            drop(sock.take());
        }
        if let Ok(mut p) = self.process.lock() {
            for _ in 0..100 {
                if matches!(p.try_wait(), Ok(Some(_))) {
                    return;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            // It did not leave within a second although its socket is closed
            // (it runs under another uid, so `kill` may be refused). Never
            // block the caller on it.
            let _ = p.kill();
        }
    }
}

/// The helper's loop. Runs in the `spawn-helper` process until the agent
/// closes the socket. Linux only: elsewhere there is no uid to drop to.
pub fn serve(spec: &HelperSpec) -> io::Result<()> {
    crate::preflight::harden_process()?;
    // SAFETY: descriptor 3 is the socket the agent passed us.
    let sock = unsafe { OwnedFd::from_raw_fd(SOCKET_FD) };
    cvt(unsafe { libc::fcntl(SOCKET_FD, libc::F_SETFD, libc::FD_CLOEXEC) })?;
    let mut shells: Vec<Child> = Vec::new();
    loop {
        shells.retain_mut(|c| matches!(c.try_wait(), Ok(None)));
        let mut poll = libc::pollfd {
            fd: sock.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // SAFETY: one valid pollfd.
        let ready = unsafe { libc::poll(&mut poll, 1, 1000) };
        if ready == 0
            || (ready < 0 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted)
        {
            continue;
        }
        let mut request = [0u8; 4];
        let fds = match recv_exact_with_fds(sock.as_raw_fd(), &mut request) {
            Ok(fds) => fds,
            Err(_) => return Ok(()), // the agent is gone, or sent something it must not
        };
        let reply = match serve_one(spec, &request, fds.len(), &mut shells) {
            Ok((master, pid)) => {
                let mut out = [0u8; REPLY_LEN];
                out[1..].copy_from_slice(&pid.to_be_bytes());
                send_with_fds(sock.as_raw_fd(), &out, &[master.as_raw_fd()])
            }
            Err(status) => send_with_fds(sock.as_raw_fd(), &[status, 0, 0, 0, 0], &[]),
        };
        if reply.is_err() {
            return Ok(());
        }
    }
}

/// One request. A request carries a window size and **nothing else**: any
/// descriptor attached to it is refused (the received ones are already closed).
fn serve_one(
    spec: &HelperSpec,
    request: &[u8],
    attached_fds: usize,
    shells: &mut Vec<Child>,
) -> Result<(OwnedFd, u32), u8> {
    if attached_fds != 0 {
        return Err(4);
    }
    let size = WinSize::from_payload(request).ok_or(1u8)?;
    if shells.len() >= MAX_SHELLS {
        return Err(2);
    }
    let pty = Pty::spawn(&SpawnSpec {
        program: spec.program.clone(),
        args: spec.args.clone(),
        env: spec.env.clone(),
        cwd: spec.cwd.clone(),
        size,
        drop_to: Some(spec.user),
        allow_same_uid: false,
    })
    .map_err(|_| 3u8)?;
    let pid = pty.child_id();
    let (master, child) = pty.detach().map_err(|_| 3u8)?;
    shells.push(child);
    Ok((master, pid))
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// The descriptor table is per process: tests that count it must not overlap
    /// with tests that open descriptors.
    pub(crate) static FD_TABLE: std::sync::Mutex<()> = std::sync::Mutex::new(());

    const OWN: Ids = Ids {
        uid: 10003,
        gid: 10003,
    };

    fn pair() -> (OwnedFd, OwnedFd) {
        let mut fds = [0 as RawFd; 2];
        cvt(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) })
            .unwrap();
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    }

    fn pipes(n: usize) -> Vec<OwnedFd> {
        (0..n)
            .flat_map(|_| {
                let mut p = [0 as RawFd; 2];
                cvt(unsafe { libc::pipe(p.as_mut_ptr()) }).unwrap();
                unsafe { [OwnedFd::from_raw_fd(p[0]), OwnedFd::from_raw_fd(p[1])] }
            })
            .collect()
    }

    /// Open descriptors of this process (Linux and macOS), via the fd table.
    fn open_fd_count() -> usize {
        (0..4096)
            .filter(|fd| unsafe { libc::fcntl(*fd, libc::F_GETFD) } != -1)
            .count()
    }

    #[test]
    fn the_spec_round_trips_and_refuses_root_and_the_helpers_own_ids() {
        let spec = HelperSpec::login_shell(
            &UserProfile::box_default(),
            vec![("PATH".into(), "/usr/bin".into())],
        );
        assert_eq!(
            HelperSpec::from_json_for(&spec.to_json(), OWN),
            Some(spec.clone())
        );
        let root = spec.to_json().replace("10001", "0");
        assert_eq!(
            HelperSpec::from_json_for(&root, OWN),
            None,
            "never a root shell"
        );
        assert_eq!(HelperSpec::from_json_for("{", OWN), None);
        // A shell with the helper's own identity (L-C).
        let as_helper = spec.to_json().replace("10001", "10003");
        assert_eq!(HelperSpec::from_json_for(&as_helper, OWN), None);
        let own_uid_only = Ids { uid: 10001, gid: 7 };
        assert_eq!(
            HelperSpec::from_json_for(&spec.to_json(), own_uid_only),
            None
        );
        let own_gid_only = Ids { uid: 7, gid: 10001 };
        assert_eq!(
            HelperSpec::from_json_for(&spec.to_json(), own_gid_only),
            None
        );
    }

    #[test]
    fn a_descriptor_travels_over_the_socket() {
        let _fd_table = FD_TABLE.lock().unwrap_or_else(|e| e.into_inner());
        let (a, b) = pair();
        let mut it = pipes(1).into_iter();
        let (r, w) = (it.next().unwrap(), it.next().unwrap());
        send_with_fds(a.as_raw_fd(), &[0, 0, 0, 0, 7], &[w.as_raw_fd()]).unwrap();
        let mut reply = [0u8; REPLY_LEN];
        let mut got = recv_exact_with_fds(b.as_raw_fd(), &mut reply).unwrap();
        assert_eq!((reply, got.len()), ([0, 0, 0, 0, 7], 1));
        let got = got.remove(0);
        write_all_fd(got.as_raw_fd(), b"x").unwrap();
        let mut one = [0u8; 1];
        let n = unsafe { libc::read(r.as_raw_fd(), one.as_mut_ptr().cast(), 1) };
        assert_eq!((n, one[0]), (1, b'x'));
        let flags = unsafe { libc::fcntl(got.as_raw_fd(), libc::F_GETFD) };
        assert_ne!(flags & libc::FD_CLOEXEC, 0, "close-on-exec");
    }

    /// M-A: a message carrying several descriptors hands the receiver ALL of
    /// them as owned, close-on-exec descriptors; dropping them leaves no leak.
    #[test]
    fn every_descriptor_in_a_message_is_owned_cloexec_and_closed_on_drop() {
        let _fd_table = FD_TABLE.lock().unwrap_or_else(|e| e.into_inner());
        let (a, b) = pair();
        let held = pipes(5); // 10 descriptors to send
        let raws: Vec<RawFd> = held.iter().map(|f| f.as_raw_fd()).collect();
        send_with_fds(a.as_raw_fd(), &[1, 2, 3, 4], &raws).unwrap();
        let before = open_fd_count();
        let mut request = [0u8; 4];
        let got = recv_exact_with_fds(b.as_raw_fd(), &mut request).unwrap();
        assert_eq!(got.len(), 10, "all of them, not just the first");
        assert_eq!(open_fd_count(), before + 10);
        for fd in &got {
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
            assert_ne!(flags & libc::FD_CLOEXEC, 0);
        }
        drop(got);
        assert_eq!(open_fd_count(), before, "nothing leaked after the drop");
    }

    /// More descriptors than the control buffer holds: an error, and the
    /// descriptors that did arrive are closed (nothing leaks).
    // Linux: the kernel closes the descriptors a too-small control buffer cannot
    // hold. BSD/macOS leaves them open in the process, which is why the helper
    // (Linux only) is where this guarantee matters.
    #[cfg(target_os = "linux")]
    #[test]
    fn an_over_long_descriptor_list_is_an_error_and_leaks_nothing() {
        let _fd_table = FD_TABLE.lock().unwrap_or_else(|e| e.into_inner());
        let (a, b) = pair();
        let held = pipes(40); // 80 descriptors > what 64 bytes of control data hold
        let raws: Vec<RawFd> = held.iter().map(|f| f.as_raw_fd()).collect();
        send_with_fds(a.as_raw_fd(), &[1, 2, 3, 4], &raws).unwrap();
        let before = open_fd_count();
        let mut request = [0u8; 4];
        assert!(recv_exact_with_fds(b.as_raw_fd(), &mut request).is_err());
        assert_eq!(
            open_fd_count(),
            before,
            "the descriptors that arrived were closed"
        );
    }

    #[test]
    fn a_request_that_carries_descriptors_is_refused_without_starting_anything() {
        let spec = HelperSpec::login_shell(&UserProfile::box_default(), vec![]);
        let mut shells = Vec::new();
        for n in [1usize, 2, 9] {
            assert_eq!(
                serve_one(
                    &spec,
                    &WinSize { cols: 80, rows: 24 }.to_payload(),
                    n,
                    &mut shells
                )
                .err(),
                Some(4)
            );
        }
        assert!(shells.is_empty());
    }

    /// L-A: after any failed exchange the connection is closed and never reused,
    /// so a late reply cannot be read as a later session's master. (The helper
    /// here exits at once, so the first request sees EOF.)
    #[cfg(target_os = "macos")]
    #[test]
    fn a_failed_exchange_poisons_the_client() {
        let _fd_table = FD_TABLE.lock().unwrap_or_else(|e| e.into_inner());
        let spec = HelperSpec::login_shell(&UserProfile::box_default(), vec![]);
        let client =
            HelperClient::start(Path::new("/usr/bin/true"), &spec, Ids { uid: 1, gid: 1 }).unwrap();
        assert!(!client.is_poisoned());
        let size = WinSize { cols: 80, rows: 24 };
        assert!(client.spawn(size).is_err());
        assert!(client.is_poisoned());
        let again = client.spawn(size).err().expect("no reuse").to_string();
        assert!(again.contains("start a new helper"), "{again}");
    }
}
