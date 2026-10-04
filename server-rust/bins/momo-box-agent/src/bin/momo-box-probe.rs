//! Test-only helper for `infra/personal-box/verify-m3.sh` (ADR-0197 M3). It is
//! **not shipped**: the production image does not contain it.
//!
//! It is the "person's uid" side of the uid-separation tests. Run as the
//! person it *tries* what the harness must not be able to do — read the host
//! key, replace it, read the agent's `/proc` files, ptrace the agent — and
//! prints one `name=outcome` line per attempt, so the shell script can assert
//! on every line.
//!
//! ```text
//! momo-box-probe report --key-file F --agent-pid N [--read PATH]...
//! momo-box-probe spawn-report --agent-exe P <same args>
//!                                             (as the AGENT uid, with the
//!                                              setuid/setgid ambient caps: starts
//!                                              the spawn helper like the agent does,
//!                                              drops its own caps, asks for a PTY)
//! momo-box-probe make-seal-key PATH           (runner stand-in, creates the seal key)
//! ```
//!
//! `spawn-report` goes through the real `momo_box_agent::pty` drop path: the
//! report is produced by a process the library started, so the uid, groups,
//! capabilities and environment it prints are the PTY child's, not the probe's.

#[cfg(unix)]
fn main() {
    use std::io::Write as _;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("report") => {
            report(&args[1..]);
            0
        }
        Some("spawn-report") => spawn_report(&args[1..]),
        Some("make-seal-key") => make_seal_key(args.get(1).map(String::as_str)),
        _ => {
            eprintln!("usage: momo-box-probe report|spawn-report|make-seal-key ...");
            2
        }
    };
    let _ = std::io::stdout().flush();
    std::process::exit(code);
}

#[cfg(not(unix))]
fn main() {}

#[cfg(unix)]
fn outcome<T>(result: std::io::Result<T>) -> String {
    match result {
        Ok(_) => "OK".to_string(),
        Err(e) => match e.raw_os_error() {
            Some(libc::EACCES) => "EACCES".to_string(),
            Some(libc::EPERM) => "EPERM".to_string(),
            Some(libc::ENOENT) => "ENOENT".to_string(),
            Some(libc::ESRCH) => "ESRCH".to_string(),
            Some(n) => format!("ERRNO{n}"),
            None => format!("ERR({e})"),
        },
    }
}

#[cfg(unix)]
fn flag(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

#[cfg(unix)]
fn report(args: &[String]) {
    use std::io::Read as _;
    // SAFETY: plain getters.
    let (uid, euid, gid) = unsafe { (libc::getuid(), libc::geteuid(), libc::getgid()) };
    println!("uid={uid}");
    println!("euid={euid}");
    println!("gid={gid}");
    let mut groups = [0 as libc::gid_t; 64];
    // SAFETY: a valid buffer of the stated length.
    let n = unsafe { libc::getgroups(64, groups.as_mut_ptr()) };
    println!(
        "groups={}",
        groups[..n.max(0) as usize]
            .iter()
            .map(|g| g.to_string())
            .collect::<Vec<_>>()
            .join(",")
    );
    if let Ok(status) = std::fs::read_to_string("/proc/self/status") {
        for line in status.lines() {
            for key in [
                "CapInh",
                "CapPrm",
                "CapEff",
                "CapBnd",
                "CapAmb",
                "NoNewPrivs",
                "Seccomp",
            ] {
                if let Some(rest) = line.strip_prefix(&format!("{key}:")) {
                    println!("{key}={}", rest.trim());
                }
            }
        }
    }
    for (name, _) in std::env::vars_os().filter_map(|(n, v)| Some((n.into_string().ok()?, v))) {
        println!("envname={name}");
    }
    if let Some(key_file) = flag(args, "--key-file") {
        println!(
            "read_key={}",
            outcome(std::fs::File::open(&key_file).and_then(|mut f| {
                let mut s = String::new();
                f.read_to_string(&mut s)
            }))
        );
        let dir = std::path::Path::new(&key_file)
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        println!(
            "list_key_dir={}",
            outcome(std::fs::read_dir(&dir).map(|d| d.count()))
        );
        println!(
            "overwrite_key={}",
            outcome(
                std::fs::OpenOptions::new()
                    .write(true)
                    .truncate(true)
                    .open(&key_file)
            )
        );
        println!(
            "create_in_key_dir={}",
            outcome(std::fs::File::create(dir.join("planted.key")))
        );
        println!(
            "rename_key={}",
            outcome(std::fs::rename(&key_file, dir.join("moved.key")))
        );
        println!("unlink_key={}", outcome(std::fs::remove_file(&key_file)));
    }
    if let Some(pid) = flag(args, "--agent-pid").and_then(|p| p.parse::<i32>().ok()) {
        for file in ["environ", "mem", "maps", "cmdline"] {
            let path = format!("/proc/{pid}/{file}");
            println!(
                "proc_{file}={}",
                outcome(std::fs::File::open(path).and_then(|mut f| {
                    let mut buf = [0u8; 16];
                    f.read(&mut buf)
                }))
            );
        }
        println!(
            "proc_fd={}",
            outcome(std::fs::read_dir(format!("/proc/{pid}/fd")).map(|d| d.count()))
        );
        println!(
            "proc_exe={}",
            outcome(std::fs::read_link(format!("/proc/{pid}/exe")))
        );
        println!("ptrace_agent={}", ptrace_attach(pid));
        println!("ptrace_own_child={}", ptrace_own_child());
    }
    let mut i = 0;
    while i + 1 < args.len() {
        if args[i] == "--read" {
            println!(
                "read[{}]={}",
                args[i + 1],
                outcome(std::fs::File::open(&args[i + 1]).and_then(|mut f| {
                    let mut buf = [0u8; 16];
                    f.read(&mut buf)
                }))
            );
            i += 1;
        }
        i += 1;
    }
    // Descriptors this process holds (none but 0,1,2 may leak from the agent or
    // the helper into the person's shell).
    if let Ok(dir) = std::fs::read_dir("/proc/self/fd") {
        let mut fds: Vec<i32> = dir
            .flatten()
            .filter(|e| {
                // the descriptor read_dir itself holds points at /proc/<pid>/fd
                std::fs::read_link(e.path())
                    .map(|t| !t.to_string_lossy().starts_with("/proc/"))
                    .unwrap_or(false)
            })
            .filter_map(|e| e.file_name().to_string_lossy().parse().ok())
            .collect();
        fds.sort_unstable();
        println!(
            "open_fds={}",
            fds.iter()
                .map(|f| f.to_string())
                .collect::<Vec<_>>()
                .join(",")
        );
    }
    // SAFETY: getppid cannot fail.
    let ppid = unsafe { libc::getppid() };
    println!("ppid_uid={}", proc_uid(ppid));
    println!("kill_parent={}", kill_check(ppid));
    if let Some(pid) = flag(args, "--agent-pid").and_then(|p| p.parse::<i32>().ok()) {
        println!("kill_agent={}", kill_check(pid));
        println!("agent_uid={}", proc_uid(pid));
        if let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) {
            println!(
                "agent_cmdline={}",
                String::from_utf8_lossy(&raw)
                    .trim_end_matches('\0')
                    .replace('\0', " ")
            );
        }
        if let Ok(status) = std::fs::read_to_string(format!("/proc/{pid}/status")) {
            for line in status.lines() {
                for key in ["CapPrm", "CapEff", "CapAmb"] {
                    if let Some(rest) = line.strip_prefix(&format!("{key}:")) {
                        println!("agent_{key}={}", rest.trim());
                    }
                }
            }
        }
    }
    println!("report=done");
}

/// `kill(pid, 0)`: may this process signal that one? (EPERM = no.)
#[cfg(unix)]
fn kill_check(pid: i32) -> String {
    // SAFETY: signal 0 only checks permission.
    let rc = unsafe { libc::kill(pid, 0) };
    if rc == 0 {
        "OK".to_string()
    } else {
        outcome::<()>(Err(std::io::Error::last_os_error()))
    }
}

/// The real uid of a process from its world-readable `/proc/<pid>/status`.
#[cfg(unix)]
fn proc_uid(pid: i32) -> String {
    std::fs::read_to_string(format!("/proc/{pid}/status"))
        .ok()
        .and_then(|s| {
            s.lines()
                .find_map(|l| {
                    l.strip_prefix("Uid:")
                        .map(|r| r.split_whitespace().next().map(str::to_string))
                })
                .flatten()
        })
        .unwrap_or_else(|| "?".to_string())
}

/// `OK` only if the attach really happened (and is undone); otherwise the errno.
#[cfg(target_os = "linux")]
fn ptrace_attach(pid: i32) -> String {
    // SAFETY: ptrace with integer arguments; a successful attach is detached.
    unsafe {
        if libc::ptrace(libc::PTRACE_ATTACH, pid, 0, 0) == -1 {
            return outcome::<()>(Err(std::io::Error::last_os_error()));
        }
        let mut status = 0;
        libc::waitpid(pid, &mut status, 0);
        libc::ptrace(libc::PTRACE_DETACH, pid, 0, 0);
    }
    "OK".to_string()
}

/// Positive control: the probe can ptrace a process it may legitimately trace
/// (its own child), so an `EPERM` above is the box's doing, not a broken probe.
#[cfg(target_os = "linux")]
fn ptrace_own_child() -> String {
    let Ok(mut child) = std::process::Command::new("sleep").arg("5").spawn() else {
        return "NOSPAWN".to_string();
    };
    let result = ptrace_attach(child.id() as i32);
    let _ = child.kill();
    let _ = child.wait();
    result
}

#[cfg(all(unix, not(target_os = "linux")))]
fn ptrace_attach(_pid: i32) -> String {
    "UNSUPPORTED".to_string()
}

#[cfg(all(unix, not(target_os = "linux")))]
fn ptrace_own_child() -> String {
    "UNSUPPORTED".to_string()
}

/// What the agent does at start, then asks for a `report` PTY: start the spawn
/// helper while holding the capabilities, drop them, and request a terminal.
/// The report is produced by the shell-side process the helper started, so the
/// uid, groups, capabilities, descriptors and environment it prints are the
/// PTY child's.
#[cfg(unix)]
fn spawn_report(args: &[String]) -> i32 {
    use momo_box_agent::env::{child_env, UserProfile};
    use momo_box_agent::preflight::drop_capabilities;
    use momo_box_agent::pty::{Ids, Read, WinSize};
    use momo_box_agent::spawn_helper::{HelperClient, HelperSpec};

    let num = |name: &str, default: u32| {
        flag(args, name)
            .and_then(|v| v.parse().ok())
            .unwrap_or(default)
    };
    let mut profile = UserProfile::box_default();
    profile.uid = num("--user-uid", profile.uid);
    profile.gid = num("--user-gid", profile.gid);
    let helper_ids = Ids {
        uid: num("--helper-uid", 10003),
        gid: num("--helper-gid", 10003),
    };
    let exe = flag(args, "--agent-exe").unwrap_or_else(|| "/usr/local/bin/momo-box-agent".into());
    let me = std::env::current_exe().expect("own path");
    let mut spec = HelperSpec::login_shell(
        &profile,
        // The caller's environment is the *polluted* one on purpose; the child
        // only gets what the allowlist admits.
        child_env(&profile, None, std::env::vars_os()),
    );
    spec.program = me;
    spec.args = std::iter::once("report".to_string())
        .chain(args.iter().cloned())
        .collect();
    spec.cwd = flag(args, "--cwd").unwrap_or_else(|| "/work".into()).into();
    let helper = match HelperClient::start(std::path::Path::new(&exe), &spec, helper_ids) {
        Ok(h) => h,
        Err(e) => {
            println!("helper_start={}", outcome::<()>(Err(e)));
            return 1;
        }
    };
    println!("helper_pid={}", helper.pid());
    match drop_capabilities() {
        Ok(()) => println!("agent_drop_capabilities=OK"),
        Err(e) => println!("agent_drop_capabilities={}", outcome::<()>(Err(e))),
    }
    // SAFETY: plain getters/setters; after the drop, setuid to the person must fail.
    let (cap_eff, can_setuid) = unsafe {
        let eff = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|s| {
                s.lines()
                    .find_map(|l| l.strip_prefix("CapEff:").map(|r| r.trim().to_string()))
            })
            .unwrap_or_default();
        (eff, libc::setuid(profile.uid) == 0)
    };
    println!("agent_CapEff_after_drop={cap_eff}");
    println!("agent_can_setuid_after_drop={can_setuid}");
    let mut pty = match helper.spawn(WinSize { cols: 80, rows: 24 }) {
        Ok(pty) => pty,
        Err(e) => {
            println!("spawn={}", outcome::<()>(Err(e)));
            return 1;
        }
    };
    let mut buf = vec![0u8; 8192];
    let mut out = Vec::new();
    for _ in 0..200 {
        match pty.read_timeout(&mut buf, 100) {
            Ok(Read::Data(n)) => out.extend_from_slice(&buf[..n]),
            Ok(Read::Timeout) => {}
            Ok(Read::Eof) | Err(_) => break,
        }
    }
    // The tty turns "\n" into "\r\n"; the report is line based.
    print!("{}", String::from_utf8_lossy(&out).replace('\r', ""));
    0
}

/// What the runner does for the host key's seal key (M2): 32 random bytes in a
/// private file on tmpfs. Here only so the container test has one.
#[cfg(unix)]
fn make_seal_key(path: Option<&str>) -> i32 {
    let Some(path) = path else {
        eprintln!("make-seal-key PATH");
        return 2;
    };
    match momo_workd::keystore::box_store::create_seal_key(std::path::Path::new(path)) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("make-seal-key: {e}");
            1
        }
    }
}
