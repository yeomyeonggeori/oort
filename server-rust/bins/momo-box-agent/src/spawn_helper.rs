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

    pub fn from_json(text: &str) -> Option<Self> {
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
        (user.uid != 0 && user.gid != 0).then_some(())?;
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

/// `data` plus, optionally, one descriptor (SCM_RIGHTS).
fn send_with_fd(sock: RawFd, data: &[u8], fd: Option<RawFd>) -> io::Result<()> {
    let mut cbuf = [0u64; 8]; // aligned, larger than CMSG_SPACE(4)
    let mut iov = libc::iovec {
        iov_base: data.as_ptr() as *mut libc::c_void,
        iov_len: data.len(),
    };
    // SAFETY: msghdr is zero-initialised then filled with pointers that outlive the call.
    unsafe {
        let mut msg: libc::msghdr = std::mem::zeroed();
        msg.msg_iov = &mut iov;
        msg.msg_iovlen = 1;
        if let Some(fd) = fd {
            msg.msg_control = cbuf.as_mut_ptr().cast();
            msg.msg_controllen = libc::CMSG_SPACE(4) as _;
            let cmsg = libc::CMSG_FIRSTHDR(&msg);
            (*cmsg).cmsg_level = libc::SOL_SOCKET;
            (*cmsg).cmsg_type = libc::SCM_RIGHTS;
            (*cmsg).cmsg_len = libc::CMSG_LEN(4) as _;
            std::ptr::copy_nonoverlapping(
                (&fd as *const RawFd).cast::<u8>(),
                libc::CMSG_DATA(cmsg),
                4,
            );
        }
        loop {
            let n = libc::sendmsg(sock, &msg, 0);
            if n >= 0 {
                if n as usize == data.len() {
                    return Ok(());
                }
                // The descriptor travelled with the first bytes; send the rest plainly.
                let rest = &data[n as usize..];
                return write_all_fd(sock, rest);
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

/// Read exactly `buf.len()` bytes; the first `recvmsg` may carry a descriptor.
fn recv_exact_with_fd(sock: RawFd, buf: &mut [u8]) -> io::Result<Option<OwnedFd>> {
    let mut got = 0usize;
    let mut received: Option<OwnedFd> = None;
    while got < buf.len() {
        let mut cbuf = [0u64; 8];
        let mut iov = libc::iovec {
            iov_base: buf[got..].as_mut_ptr().cast(),
            iov_len: buf.len() - got,
        };
        // SAFETY: as in send_with_fd; the control buffer outlives the call.
        let n = unsafe {
            let mut msg: libc::msghdr = std::mem::zeroed();
            msg.msg_iov = &mut iov;
            msg.msg_iovlen = 1;
            msg.msg_control = cbuf.as_mut_ptr().cast();
            msg.msg_controllen = std::mem::size_of_val(&cbuf) as _;
            let n = libc::recvmsg(sock, &mut msg, 0);
            if n >= 0 {
                let mut cmsg = libc::CMSG_FIRSTHDR(&msg);
                while !cmsg.is_null() {
                    if (*cmsg).cmsg_level == libc::SOL_SOCKET
                        && (*cmsg).cmsg_type == libc::SCM_RIGHTS
                    {
                        let mut fd: RawFd = -1;
                        std::ptr::copy_nonoverlapping(
                            libc::CMSG_DATA(cmsg),
                            (&mut fd as *mut RawFd).cast::<u8>(),
                            4,
                        );
                        if fd >= 0 {
                            let owned = OwnedFd::from_raw_fd(fd);
                            // Close-on-exec at once (MSG_CMSG_CLOEXEC is Linux-only).
                            let _ = libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC);
                            if received.is_none() {
                                received = Some(owned);
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
    Ok(received)
}

/// The agent's end: asks the helper for terminals.
pub struct HelperClient {
    sock: Mutex<Option<OwnedFd>>,
    process: Mutex<Child>,
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
        })
    }

    pub fn pid(&self) -> u32 {
        self.process.lock().map_or(0, |p| p.id())
    }

    /// A new PTY of `size`, its shell started by the helper.
    pub fn spawn(&self, size: WinSize) -> io::Result<Pty> {
        let guard = self
            .sock
            .lock()
            .map_err(|_| io::Error::other("helper socket poisoned"))?;
        let sock = guard
            .as_ref()
            .ok_or_else(|| io::Error::other("helper closed"))?
            .as_raw_fd();
        write_all_fd(sock, &size.to_payload())?;
        let mut reply = [0u8; REPLY_LEN];
        let fd = recv_exact_with_fd(sock, &mut reply)?;
        match (reply[0], fd) {
            (0, Some(master)) => Pty::from_remote(
                master,
                u32::from_be_bytes([reply[1], reply[2], reply[3], reply[4]]),
            ),
            (status, _) => Err(io::Error::other(format!("spawn helper refused ({status})"))),
        }
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
        match recv_exact_with_fd(sock.as_raw_fd(), &mut request) {
            Ok(_) => {}
            Err(_) => return Ok(()), // the agent is gone
        }
        let reply = match serve_one(spec, &request, &mut shells) {
            Ok((master, pid)) => {
                let mut out = [0u8; REPLY_LEN];
                out[1..].copy_from_slice(&pid.to_be_bytes());
                send_with_fd(sock.as_raw_fd(), &out, Some(master.as_raw_fd()))
            }
            Err(status) => send_with_fd(sock.as_raw_fd(), &[status, 0, 0, 0, 0], None),
        };
        if reply.is_err() {
            return Ok(());
        }
    }
}

fn serve_one(
    spec: &HelperSpec,
    request: &[u8],
    shells: &mut Vec<Child>,
) -> Result<(OwnedFd, u32), u8> {
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
mod tests {
    use super::*;

    #[test]
    fn the_spec_round_trips_and_refuses_root() {
        let spec = HelperSpec::login_shell(
            &UserProfile::box_default(),
            vec![("PATH".into(), "/usr/bin".into())],
        );
        assert_eq!(HelperSpec::from_json(&spec.to_json()), Some(spec.clone()));
        let root = spec.to_json().replace("10001", "0");
        assert_eq!(HelperSpec::from_json(&root), None, "never a root shell");
        assert_eq!(HelperSpec::from_json("{"), None);
    }

    #[test]
    fn a_descriptor_travels_over_the_socket() {
        let mut fds = [0 as RawFd; 2];
        cvt(unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM, 0, fds.as_mut_ptr()) })
            .unwrap();
        let (a, b) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        let mut pipe = [0 as RawFd; 2];
        cvt(unsafe { libc::pipe(pipe.as_mut_ptr()) }).unwrap();
        let (r, w) = unsafe { (OwnedFd::from_raw_fd(pipe[0]), OwnedFd::from_raw_fd(pipe[1])) };
        send_with_fd(a.as_raw_fd(), &[0, 0, 0, 0, 7], Some(w.as_raw_fd())).unwrap();
        let mut reply = [0u8; REPLY_LEN];
        let got = recv_exact_with_fd(b.as_raw_fd(), &mut reply)
            .unwrap()
            .expect("fd");
        assert_eq!(reply, [0, 0, 0, 0, 7]);
        // The received descriptor is the pipe's write end.
        write_all_fd(got.as_raw_fd(), b"x").unwrap();
        let mut one = [0u8; 1];
        let n = unsafe { libc::read(r.as_raw_fd(), one.as_mut_ptr().cast(), 1) };
        assert_eq!((n, one[0]), (1, b'x'));
        // And it is close-on-exec.
        let flags = unsafe { libc::fcntl(got.as_raw_fd(), libc::F_GETFD) };
        assert_ne!(flags & libc::FD_CLOEXEC, 0);
    }
}
