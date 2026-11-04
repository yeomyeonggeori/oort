//! What the PDF child refuses to do for the rest of its life (ADR-0151 증보 6 B, #5072 — the first half of
//! review R2-4).
//!
//! The child is a function: PDF bytes on stdin, one JSON line on stdout. It needs no file by name, no socket,
//! no other program and no other process — and it parses bytes an attacker wrote. So once its limits are in place
//! (`attachment_text::confine_self`) and its watchdog thread exists, it asks the kernel to refuse those things on
//! **every thread it has** ([`lock_down`]). Whatever the parser were later talked into doing, it could not open
//! `/proc/<worker>/environ` (or any other file), reach the database or the private network, start a shell, or
//! look into the worker's memory by any of the ways the list below names.
//!
//! ## Why a system-call filter, and why nothing else
//!
//! The worker runs as an unprivileged user (`momo`, uid 10001) in a container with the runtime's default profile —
//! on Railway the agent-worker sets no `RAILWAY_RUN_UID`. There, measured on Docker's default profile: another
//! user number needs `CAP_SETUID` (`setresuid` is refused), and every namespace (`unshare` user, net, mount, pid)
//! is refused. A seccomp filter needs neither: with `no_new_privs` an unprivileged process may install one, and
//! the default profile allows `seccomp(2)`. The cost is one new crate (`seccompiler`), because the workspace forbids
//! `unsafe` and installing a filter takes a raw `seccomp(2)` call.
//!
//! ## What is refused
//!
//! A **denylist**, each call answered `EPERM` (not a kill: a call the child makes by mistake is an error it can
//! report as an unreadable file, and a call an attacker makes is a refusal he sees, not a crash he can probe).
//! Nothing here depends on the container runtime's own profile: a runtime with none (`seccomp=unconfined`, a
//! Kubernetes pod without one) leaves every line below refused.
//!
//! 1. a file by name — `open`, `openat`, `openat2`, `creat`, the handle-based `open_by_handle_at` and
//!    `name_to_handle_at`, and `open_tree`. The child's only descriptors are stdin, stdout and stderr, and they are
//!    already open;
//! 2. a change to a file by name — `unlinkat`, `mkdirat`, `renameat`, `renameat2`, `linkat`, `symlinkat`,
//!    `truncate`, `fchmodat`, `fchmodat2`, `fchownat`, `utimensat`, `mknodat`, the path forms of `setxattr` and
//!    `removexattr`, and on x86-64 the older spellings (`unlink`, `rmdir`, `mkdir`, `rename`, `link`, `symlink`,
//!    `chmod`, `chown`, `lchown`, `utime`, `utimes`, `futimesat`, `mknod`, `uselib`). Without a way to open
//!    anything there is nothing to read, but a name could still be deleted, renamed or made. **Which spelling a
//!    libc picks is the architecture's:** glibc's `rename` is `renameat` on aarch64 and `rename` on x86-64, and the
//!    first version of this list had `renameat2` for aarch64 alone — the real-kernel probe in `attachment_text`
//!    (it renames a file after the lock-down) found the hole, which is why that probe asks the kernel through
//!    `std` and not through the system-call numbers listed here;
//! 3. the network and its cousin, POSIX message queues — `socket`, `connect`, `bind`, `listen`, `accept`, `accept4`,
//!    `mq_open`, `mq_unlink` (a queue is a name another process of the same user can also open);
//! 4. another program — `execve`, `execveat`;
//! 5. another process — to look into it (`ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_open`,
//!    `pidfd_getfd`, `kcmp`, `perf_event_open`), to signal it (`kill`, `tkill`, `rt_sigqueueinfo`,
//!    `rt_tgsigqueueinfo`, `pidfd_send_signal`, and `tgkill` for every process but the child's own — `abort()`
//!    raises `SIGABRT` with `tgkill(getpid(), gettid(), …)`, so that one call stays open for the caller's own
//!    pid, and refusing `kill` while leaving `tgkill` open for any pid would have protected nothing) and to change
//!    its limits (`prlimit64` for any pid but 0, "this process", which is how `setrlimit` and `getrlimit` call it);
//! 6. the ring buffer that performs 1 and 3 without asking the filter — `io_uring_setup`, `io_uring_enter`,
//!    `io_uring_register`. (Without this group the filter would be a door with a window beside it.);
//! 7. kernel interfaces a parser has no use for and a runtime without a profile may leave open — `bpf`,
//!    `userfaultfd`, `keyctl`, `add_key`, `request_key`, `unshare`, `setns`, and the mount family (`mount`,
//!    `umount2`, `pivot_root`, `chroot`, `fsopen`, `fsmount`, `fspick`, `move_mount`, `mount_setattr`);
//! 8. turning the dump back on — `prctl(PR_SET_DUMPABLE, …)`. The child marks itself not dumpable before this
//!    filter exists; code running in it must not be able to undo that.
//!
//! ## What stays open — measured, not hoped
//!
//! On the real filter, as uid 10001 under Docker's default profile (review 1 of #5072): the metadata calls
//! (`readlinkat`, `newfstatat`, `statx`, `faccessat` — the existence, size and mode of a path, never its content),
//! `socketpair` (both ends inside the process), `memfd_create`, SysV shared memory, the other `prctl` options, and
//! the calls that disturb a same-user process without naming a file or reading it (priority, CPU affinity). Those
//! are not on the list because the allocator, the threads and stdio may legitimately reach for some of them, and
//! because they read no content and move no data out. A filter of the other kind — an allowlist — would be a list
//! of what glibc happens to call this year, and a missing entry would be a PDF that reads on one image and not on
//! the next.
//!
//! ## Which ABI a call comes through (review R1-1 of #5072)
//!
//! A filter for the wrong architecture kills the process on its first call, so the architecture is the one this
//! binary was built for (`std::env::consts::ARCH`). A call through the 32-bit ABI (`int 0x80`) carries another
//! architecture value and is killed by the filter's own architecture check. **The x32 ABI is different**: a 64-bit
//! x86 kernel built with `CONFIG_X86_X32_ABI` takes the same architecture value for a call whose number has bit 30
//! set (`__X32_SYSCALL_BIT`, `0x4000_0000`), so the numbers in the list would not match it and every refusal
//! above would be skipped. A 64-bit build never makes such a call, so the program starts with a rule that refuses
//! **every** number with that bit set ([`refuse_x32`]), whatever the architecture, instead of a second list of x32
//! numbers (which are not even `n | 0x4000_0000` for the handful of calls the x32 table numbers apart, 512–547).

/// The filter could not be built or installed. The child then reads nothing (`ConfineStep::Filter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LockDownError;

/// `__X32_SYSCALL_BIT`: set in the number of a call made through the x32 ABI.
#[cfg(target_os = "linux")]
const X32_SYSCALL_BIT: u32 = 0x4000_0000;

// the classic-BPF instructions this module reads and writes (the compiler emits the rest)
#[cfg(target_os = "linux")]
const BPF_LD_W_ABS: u16 = 0x20;
#[cfg(target_os = "linux")]
const BPF_JEQ_K: u16 = 0x15;
#[cfg(target_os = "linux")]
const BPF_JGE_K: u16 = 0x35;
#[cfg(target_os = "linux")]
const BPF_RET_K: u16 = 0x06;
/// `seccomp_data.arch`'s offset, and `seccomp_data.nr`'s.
#[cfg(target_os = "linux")]
const SECCOMP_DATA_NR: u32 = 0;
#[cfg(target_os = "linux")]
const SECCOMP_DATA_ARCH: u32 = 4;
#[cfg(target_os = "linux")]
const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
#[cfg(target_os = "linux")]
const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;

/// `fchmodat2` (Linux 6.6) has the same number on every architecture and not every `libc` release names it.
#[cfg(target_os = "linux")]
const SYS_FCHMODAT2: libc::c_long = 452;

/// `renameat` on aarch64 (the generic table's 38, which that architecture keeps: `__ARCH_WANT_RENAMEAT`). glibc's
/// `rename` calls it there, and `libc` has no constant of that name for the gnu aarch64 target.
#[cfg(all(target_os = "linux", target_arch = "aarch64"))]
const SYS_RENAMEAT_AARCH64: libc::c_long = 38;

/// The system calls the child refuses whatever they are given, by name (the name is for a failing test's
/// message, not for the filter). The two calls it refuses only for some arguments are [`argument_rules`].
#[cfg(target_os = "linux")]
fn denied() -> Vec<(&'static str, libc::c_long)> {
    let common: Vec<(&'static str, libc::c_long)> = vec![
        // 1. a file by name
        ("openat", libc::SYS_openat),
        ("openat2", libc::SYS_openat2),
        ("open_by_handle_at", libc::SYS_open_by_handle_at),
        ("name_to_handle_at", libc::SYS_name_to_handle_at),
        ("open_tree", libc::SYS_open_tree),
        // 2. a change to a file by name
        ("unlinkat", libc::SYS_unlinkat),
        ("mkdirat", libc::SYS_mkdirat),
        ("renameat2", libc::SYS_renameat2),
        ("linkat", libc::SYS_linkat),
        ("symlinkat", libc::SYS_symlinkat),
        ("truncate", libc::SYS_truncate),
        ("fchmodat", libc::SYS_fchmodat),
        ("fchmodat2", SYS_FCHMODAT2),
        ("fchownat", libc::SYS_fchownat),
        ("utimensat", libc::SYS_utimensat),
        ("mknodat", libc::SYS_mknodat),
        ("setxattr", libc::SYS_setxattr),
        ("lsetxattr", libc::SYS_lsetxattr),
        ("removexattr", libc::SYS_removexattr),
        ("lremovexattr", libc::SYS_lremovexattr),
        // 3. the network, and message queues
        ("socket", libc::SYS_socket),
        ("connect", libc::SYS_connect),
        ("bind", libc::SYS_bind),
        ("listen", libc::SYS_listen),
        ("accept", libc::SYS_accept),
        ("accept4", libc::SYS_accept4),
        ("mq_open", libc::SYS_mq_open),
        ("mq_unlink", libc::SYS_mq_unlink),
        // 4. another program
        ("execve", libc::SYS_execve),
        ("execveat", libc::SYS_execveat),
        // 5. another process: look into it, signal it
        ("ptrace", libc::SYS_ptrace),
        ("process_vm_readv", libc::SYS_process_vm_readv),
        ("process_vm_writev", libc::SYS_process_vm_writev),
        ("pidfd_open", libc::SYS_pidfd_open),
        ("pidfd_getfd", libc::SYS_pidfd_getfd),
        ("kcmp", libc::SYS_kcmp),
        ("perf_event_open", libc::SYS_perf_event_open),
        ("kill", libc::SYS_kill),
        ("tkill", libc::SYS_tkill),
        ("rt_sigqueueinfo", libc::SYS_rt_sigqueueinfo),
        ("rt_tgsigqueueinfo", libc::SYS_rt_tgsigqueueinfo),
        ("pidfd_send_signal", libc::SYS_pidfd_send_signal),
        // 6. the ring buffer that does 1 and 3 without asking
        ("io_uring_setup", libc::SYS_io_uring_setup),
        ("io_uring_enter", libc::SYS_io_uring_enter),
        ("io_uring_register", libc::SYS_io_uring_register),
        // 7. kernel interfaces a parser has no use for
        ("bpf", libc::SYS_bpf),
        ("userfaultfd", libc::SYS_userfaultfd),
        ("keyctl", libc::SYS_keyctl),
        ("add_key", libc::SYS_add_key),
        ("request_key", libc::SYS_request_key),
        ("unshare", libc::SYS_unshare),
        ("setns", libc::SYS_setns),
        ("mount", libc::SYS_mount),
        ("umount2", libc::SYS_umount2),
        ("pivot_root", libc::SYS_pivot_root),
        ("chroot", libc::SYS_chroot),
        ("fsopen", libc::SYS_fsopen),
        ("fsmount", libc::SYS_fsmount),
        ("fspick", libc::SYS_fspick),
        ("move_mount", libc::SYS_move_mount),
        ("mount_setattr", libc::SYS_mount_setattr),
    ];
    // the older spellings exist on x86-64 only (aarch64 has the `*at` forms alone)
    #[cfg(target_arch = "x86_64")]
    let older = [
        ("open", libc::SYS_open),
        ("creat", libc::SYS_creat),
        ("unlink", libc::SYS_unlink),
        ("rmdir", libc::SYS_rmdir),
        ("mkdir", libc::SYS_mkdir),
        ("rename", libc::SYS_rename),
        ("renameat", libc::SYS_renameat),
        ("link", libc::SYS_link),
        ("symlink", libc::SYS_symlink),
        ("chmod", libc::SYS_chmod),
        ("chown", libc::SYS_chown),
        ("lchown", libc::SYS_lchown),
        ("utime", libc::SYS_utime),
        ("utimes", libc::SYS_utimes),
        ("futimesat", libc::SYS_futimesat),
        ("mknod", libc::SYS_mknod),
        ("uselib", libc::SYS_uselib),
    ];
    #[cfg(target_arch = "aarch64")]
    let older = [("renameat", SYS_RENAMEAT_AARCH64)];
    #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
    let older: [(&'static str, libc::c_long); 0] = [];
    common.into_iter().chain(older).collect()
}

/// The calls the child refuses only for some arguments, because the same call is one it or glibc makes for it:
/// `prctl(PR_SET_DUMPABLE, …)` for any value (group 8); `prlimit64` with a pid other than 0, which is "this
/// process" (group 5; `getrlimit` and `setrlimit` pass 0); and `tgkill` whose thread-group id is not `own_pid`
/// (group 5; `abort()` signals the caller's own process). `own_pid` is the child's pid, known when the filter is
/// built in the child, after it was started.
#[cfg(target_os = "linux")]
fn argument_rules(
    own_pid: u32,
) -> Result<Vec<(i64, Vec<seccompiler::SeccompRule>)>, LockDownError> {
    use seccompiler::{SeccompCmpArgLen, SeccompCmpOp, SeccompCondition, SeccompRule};
    let rule = |index: u8, op: SeccompCmpOp, value: u64| {
        SeccompCondition::new(index, SeccompCmpArgLen::Dword, op, value)
            .and_then(|condition| SeccompRule::new(vec![condition]))
            .map(|rule| vec![rule])
            .map_err(|_| LockDownError)
    };
    Ok(vec![
        (
            libc::SYS_prctl,
            rule(0, SeccompCmpOp::Eq, libc::PR_SET_DUMPABLE as u64)?,
        ),
        (libc::SYS_prlimit64, rule(0, SeccompCmpOp::Ne, 0)?),
        (
            libc::SYS_tgkill,
            rule(0, SeccompCmpOp::Ne, u64::from(own_pid))?,
        ),
    ])
}

/// Put "refuse every call whose number has bit 30 set" in front of a compiled program, right behind the
/// architecture check the compiler opens it with. The check is the three instructions this function expects (load
/// the architecture, jump over the next instruction when it is ours, kill otherwise); a program that starts
/// otherwise is one this function does not understand, and it is an error — the child then reads nothing.
#[cfg(target_os = "linux")]
fn refuse_x32(compiled: seccompiler::BpfProgram) -> Result<seccompiler::BpfProgram, LockDownError> {
    use seccompiler::sock_filter;
    let opens_with_the_architecture_check = compiled.len() > 3
        && (compiled[0].code, compiled[0].k) == (BPF_LD_W_ABS, SECCOMP_DATA_ARCH)
        && (compiled[1].code, compiled[1].jt, compiled[1].jf) == (BPF_JEQ_K, 1, 0)
        && (compiled[2].code, compiled[2].k) == (BPF_RET_K, SECCOMP_RET_KILL_PROCESS);
    if !opens_with_the_architecture_check {
        return Err(LockDownError);
    }
    let mut program = Vec::with_capacity(compiled.len() + 3);
    program.extend_from_slice(&compiled[..3]);
    // load the number; at or above the x32 bit: fall into the refusal; below it: skip it
    program.push(sock_filter {
        code: BPF_LD_W_ABS,
        jt: 0,
        jf: 0,
        k: SECCOMP_DATA_NR,
    });
    program.push(sock_filter {
        code: BPF_JGE_K,
        jt: 0,
        jf: 1,
        k: X32_SYSCALL_BIT,
    });
    program.push(sock_filter {
        code: BPF_RET_K,
        jt: 0,
        jf: 0,
        k: SECCOMP_RET_ERRNO | libc::EPERM as u32,
    });
    program.extend_from_slice(&compiled[3..]);
    Ok(program)
}

/// The compiled filter: [`denied`] and [`argument_rules`] answered `EPERM`, everything else allowed, and every x32
/// number refused ([`refuse_x32`]).
#[cfg(target_os = "linux")]
fn program() -> Result<seccompiler::BpfProgram, LockDownError> {
    use seccompiler::{SeccompAction, SeccompFilter, SeccompRule};
    use std::collections::BTreeMap;

    // an empty rule list is "this call, whatever its arguments"
    let mut rules: BTreeMap<i64, Vec<SeccompRule>> = denied()
        .into_iter()
        .map(|(_, number)| (number, Vec::new()))
        .collect();
    rules.extend(argument_rules(std::process::id())?);
    let compiled = SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        std::env::consts::ARCH
            .try_into()
            .map_err(|_| LockDownError)?,
    )
    .map_err(|_| LockDownError)?
    .try_into()
    .map_err(|_| LockDownError)?;
    refuse_x32(compiled)
}

/// Refuse [`denied`] on every thread of this process, for the rest of its life. Irreversible, and it sets
/// `no_new_privs` first (the crate does), which is what lets an unprivileged process do it.
#[cfg(target_os = "linux")]
pub(crate) fn lock_down() -> Result<(), LockDownError> {
    seccompiler::apply_filter_all_threads(&program()?).map_err(|_| LockDownError)
}

/// Other platforms have no such filter and the image is Linux: nothing to refuse, nothing to fail.
#[cfg(not(target_os = "linux"))]
pub(crate) fn lock_down() -> Result<(), LockDownError> {
    Ok(())
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    // `seccomp_data`: the call number at offset 0, the architecture at offset 4, the instruction pointer at 8, the
    // six arguments at 16, 24, … (a 64-bit word each)
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH_THIS: u32 = 0xC000_003E;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH_THIS: u32 = 0xC000_00B7;

    /// What the kernel would answer a call `number` made through `arch` with `args`: the classic BPF the compiler
    /// emits is a handful of instructions (load a word of `seccomp_data`, mask it, compare, jump, return), run
    /// here the way the kernel runs them. A program with any other instruction is a program this test does not
    /// understand, and it fails instead of guessing.
    fn answer(program: &[seccompiler::sock_filter], number: i64, arch: u32, args: [u64; 6]) -> u32 {
        const ALU_AND_K: u16 = 0x54;
        const JMP_JGT_K: u16 = 0x25;
        const JMP_JA: u16 = 0x05;
        let mut data = Vec::with_capacity(64);
        data.extend_from_slice(&(number as u32).to_le_bytes());
        data.extend_from_slice(&arch.to_le_bytes());
        data.extend_from_slice(&0u64.to_le_bytes());
        for arg in args {
            data.extend_from_slice(&arg.to_le_bytes());
        }
        let (mut accumulator, mut at) = (0u32, 0usize);
        for _ in 0..program.len() * 2 {
            let step = &program[at];
            at += 1;
            match step.code {
                BPF_LD_W_ABS => {
                    let from = step.k as usize;
                    accumulator = u32::from_le_bytes(
                        data.get(from..from + 4)
                            .unwrap_or_else(|| panic!("the filter reads seccomp_data at {from}"))
                            .try_into()
                            .unwrap(),
                    );
                }
                ALU_AND_K => accumulator &= step.k,
                BPF_JEQ_K => {
                    at += usize::from(if accumulator == step.k {
                        step.jt
                    } else {
                        step.jf
                    })
                }
                JMP_JGT_K => {
                    at += usize::from(if accumulator > step.k {
                        step.jt
                    } else {
                        step.jf
                    })
                }
                BPF_JGE_K => {
                    at += usize::from(if accumulator >= step.k {
                        step.jt
                    } else {
                        step.jf
                    })
                }
                JMP_JA => at += step.k as usize,
                BPF_RET_K => return step.k,
                other => panic!("an instruction this test does not run: {other:#x}"),
            }
        }
        panic!("the filter does not end");
    }

    /// The call as `answer` asks it, with arguments that match no argument rule.
    fn plain(program: &[seccompiler::sock_filter], number: i64) -> u32 {
        // pid 0 and an option no rule names: the arguments of an ordinary call
        answer(program, number, AUDIT_ARCH_THIS, [0, 0, 0, 0, 0, 0])
    }

    /// The refused calls, written **here**, apart from [`denied`], by the group each belongs to. A call dropped from
    /// the filter (or one that never made it in) is a line of this list answered `ALLOW`.
    fn refused_calls() -> Vec<(&'static str, i64)> {
        let common: Vec<(&'static str, i64)> = vec![
            // a file by name
            ("openat", libc::SYS_openat),
            ("openat2", libc::SYS_openat2),
            ("open_by_handle_at", libc::SYS_open_by_handle_at),
            ("name_to_handle_at", libc::SYS_name_to_handle_at),
            ("open_tree", libc::SYS_open_tree),
            // a change to a file by name
            ("unlinkat", libc::SYS_unlinkat),
            ("mkdirat", libc::SYS_mkdirat),
            ("renameat2", libc::SYS_renameat2),
            ("linkat", libc::SYS_linkat),
            ("symlinkat", libc::SYS_symlinkat),
            ("truncate", libc::SYS_truncate),
            ("fchmodat", libc::SYS_fchmodat),
            ("fchmodat2", 452),
            ("fchownat", libc::SYS_fchownat),
            ("utimensat", libc::SYS_utimensat),
            ("mknodat", libc::SYS_mknodat),
            ("setxattr", libc::SYS_setxattr),
            ("lsetxattr", libc::SYS_lsetxattr),
            ("removexattr", libc::SYS_removexattr),
            ("lremovexattr", libc::SYS_lremovexattr),
            // the network, and message queues
            ("socket", libc::SYS_socket),
            ("connect", libc::SYS_connect),
            ("bind", libc::SYS_bind),
            ("listen", libc::SYS_listen),
            ("accept", libc::SYS_accept),
            ("accept4", libc::SYS_accept4),
            ("mq_open", libc::SYS_mq_open),
            ("mq_unlink", libc::SYS_mq_unlink),
            // another program
            ("execve", libc::SYS_execve),
            ("execveat", libc::SYS_execveat),
            // another process: look into it
            ("ptrace", libc::SYS_ptrace),
            ("process_vm_readv", libc::SYS_process_vm_readv),
            ("process_vm_writev", libc::SYS_process_vm_writev),
            ("pidfd_open", libc::SYS_pidfd_open),
            ("pidfd_getfd", libc::SYS_pidfd_getfd),
            ("kcmp", libc::SYS_kcmp),
            ("perf_event_open", libc::SYS_perf_event_open),
            // another process: signal it
            ("kill", libc::SYS_kill),
            ("tkill", libc::SYS_tkill),
            ("rt_sigqueueinfo", libc::SYS_rt_sigqueueinfo),
            ("rt_tgsigqueueinfo", libc::SYS_rt_tgsigqueueinfo),
            ("pidfd_send_signal", libc::SYS_pidfd_send_signal),
            // the ring buffer that does the first and the network without asking
            ("io_uring_setup", libc::SYS_io_uring_setup),
            ("io_uring_enter", libc::SYS_io_uring_enter),
            ("io_uring_register", libc::SYS_io_uring_register),
            // kernel interfaces a parser has no use for
            ("bpf", libc::SYS_bpf),
            ("userfaultfd", libc::SYS_userfaultfd),
            ("keyctl", libc::SYS_keyctl),
            ("add_key", libc::SYS_add_key),
            ("request_key", libc::SYS_request_key),
            ("unshare", libc::SYS_unshare),
            ("setns", libc::SYS_setns),
            ("mount", libc::SYS_mount),
            ("umount2", libc::SYS_umount2),
            ("pivot_root", libc::SYS_pivot_root),
            ("chroot", libc::SYS_chroot),
            ("fsopen", libc::SYS_fsopen),
            ("fsmount", libc::SYS_fsmount),
            ("fspick", libc::SYS_fspick),
            ("move_mount", libc::SYS_move_mount),
            ("mount_setattr", libc::SYS_mount_setattr),
        ];
        #[cfg(target_arch = "x86_64")]
        let older = [
            ("open", libc::SYS_open),
            ("creat", libc::SYS_creat),
            ("unlink", libc::SYS_unlink),
            ("rmdir", libc::SYS_rmdir),
            ("mkdir", libc::SYS_mkdir),
            ("rename", libc::SYS_rename),
            ("renameat", libc::SYS_renameat),
            ("link", libc::SYS_link),
            ("symlink", libc::SYS_symlink),
            ("chmod", libc::SYS_chmod),
            ("chown", libc::SYS_chown),
            ("lchown", libc::SYS_lchown),
            ("utime", libc::SYS_utime),
            ("utimes", libc::SYS_utimes),
            ("futimesat", libc::SYS_futimesat),
            ("mknod", libc::SYS_mknod),
            ("uselib", libc::SYS_uselib),
        ];
        // aarch64 keeps `renameat` (38), and glibc's `rename` is that call there
        #[cfg(target_arch = "aarch64")]
        let older = [("renameat", 38i64)];
        #[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
        let older: [(&'static str, i64); 0] = [];
        common.into_iter().chain(older).collect()
    }

    /// Everything the allocator, a thread's sleep, the clock, the signal setup of the runtime and the output of the
    /// answer use: allowed, or a PDF reads on one image and not on the next.
    fn allowed_calls() -> Vec<(&'static str, i64)> {
        vec![
            ("read", libc::SYS_read),
            ("write", libc::SYS_write),
            ("close", libc::SYS_close),
            ("mmap", libc::SYS_mmap),
            ("munmap", libc::SYS_munmap),
            ("mremap", libc::SYS_mremap),
            ("mprotect", libc::SYS_mprotect),
            ("madvise", libc::SYS_madvise),
            ("brk", libc::SYS_brk),
            ("futex", libc::SYS_futex),
            ("clock_gettime", libc::SYS_clock_gettime),
            ("clock_nanosleep", libc::SYS_clock_nanosleep),
            ("getrandom", libc::SYS_getrandom),
            ("rt_sigaction", libc::SYS_rt_sigaction),
            ("rt_sigprocmask", libc::SYS_rt_sigprocmask),
            ("rt_sigreturn", libc::SYS_rt_sigreturn),
            ("sigaltstack", libc::SYS_sigaltstack),
            ("sched_yield", libc::SYS_sched_yield),
            ("exit", libc::SYS_exit),
            ("exit_group", libc::SYS_exit_group),
            ("gettid", libc::SYS_gettid),
            ("getpid", libc::SYS_getpid),
            ("ioctl", libc::SYS_ioctl),
            ("fcntl", libc::SYS_fcntl),
            ("newfstatat", libc::SYS_newfstatat),
            ("statx", libc::SYS_statx),
            ("set_robust_list", libc::SYS_set_robust_list),
            ("clone3", libc::SYS_clone3),
            ("clone", libc::SYS_clone),
        ]
    }

    /// The compiled filter, run on every call it must refuse and on the calls a PDF read cannot do without.
    /// What the kernel does with the filter is held by `attachment_text`'s probe, for the calls a probe can make.
    #[test]
    fn every_refused_call_is_answered_eperm_and_the_calls_a_read_needs_are_allowed() {
        let program = program().expect("the filter compiles");
        let eperm = SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let refused = refused_calls();
        let not_refused: Vec<&str> = refused
            .iter()
            .filter(|(_, number)| plain(&program, *number) != eperm)
            .map(|(name, _)| *name)
            .collect();
        assert!(
            not_refused.is_empty(),
            "{} of {} calls on the list are not refused with EPERM: {not_refused:?}",
            not_refused.len(),
            refused.len()
        );
        let allowed = allowed_calls();
        let not_allowed: Vec<&str> = allowed
            .iter()
            .filter(|(_, number)| plain(&program, *number) != SECCOMP_RET_ALLOW)
            .map(|(name, _)| *name)
            .collect();
        assert!(
            not_allowed.is_empty(),
            "{} of {} calls a read needs are not allowed: {not_allowed:?}",
            not_allowed.len(),
            allowed.len()
        );
        // a call through another architecture is not this filter's to judge: the process ends
        assert_eq!(
            answer(&program, libc::SYS_read, AUDIT_ARCH_THIS ^ 1, [0; 6]),
            SECCOMP_RET_KILL_PROCESS,
            "another architecture's call must end the process"
        );
    }

    /// The calls refused only for some arguments: `prctl` with `PR_SET_DUMPABLE` (any value — the child set the
    /// flag before the filter existed, and nothing running in it may turn the dump back on), `prlimit64` for a pid
    /// that is not 0 (the caller's own, which is how `getrlimit` and `setrlimit` ask), and `tgkill` for a process
    /// that is not the caller's own (`abort()` raises its signal at itself).
    #[test]
    fn prctl_prlimit_and_tgkill_are_refused_for_their_dangerous_arguments_only() {
        let program = program().expect("the filter compiles");
        let eperm = SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let call = |number: i64, args: [u64; 6]| answer(&program, number, AUDIT_ARCH_THIS, args);
        for value in [0, 1, 2] {
            assert_eq!(
                call(
                    libc::SYS_prctl,
                    [libc::PR_SET_DUMPABLE as u64, value, 0, 0, 0, 0]
                ),
                eperm,
                "prctl(PR_SET_DUMPABLE, {value})"
            );
        }
        for option in [libc::PR_GET_DUMPABLE, libc::PR_SET_NAME, libc::PR_GET_NAME] {
            assert_eq!(
                call(libc::SYS_prctl, [option as u64, 0, 0, 0, 0, 0]),
                SECCOMP_RET_ALLOW,
                "prctl option {option} is the runtime's and the allocator's"
            );
        }
        assert_eq!(
            call(libc::SYS_prlimit64, [0, libc::RLIMIT_AS as u64, 0, 0, 0, 0]),
            SECCOMP_RET_ALLOW,
            "prlimit64 for the caller's own pid (0) is getrlimit and setrlimit"
        );
        for pid in [1u64, 2, 4242, 0x7fff_ffff] {
            assert_eq!(
                call(
                    libc::SYS_prlimit64,
                    [pid, libc::RLIMIT_AS as u64, 0, 0, 0, 0]
                ),
                eperm,
                "prlimit64 for pid {pid}"
            );
        }
        // a signal: to this very process (what `abort()` does) it is the runtime's; to any other it is the
        // worker's death (SIGKILL reaches a whole process whichever thread is named)
        let own = u64::from(std::process::id());
        for tid in [own, own + 1, own + 7] {
            assert_eq!(
                call(libc::SYS_tgkill, [own, tid, libc::SIGABRT as u64, 0, 0, 0]),
                SECCOMP_RET_ALLOW,
                "tgkill({own}, {tid}, SIGABRT): a signal to a thread of this process"
            );
        }
        for other in [1u64, own + 1, own.wrapping_sub(1), 0] {
            assert_eq!(
                call(
                    libc::SYS_tgkill,
                    [other, other, libc::SIGKILL as u64, 0, 0, 0]
                ),
                eperm,
                "tgkill({other}, {other}, SIGKILL): the signal that would end another process"
            );
        }
    }

    /// R1-1 of #5072's review: on a 64-bit x86 kernel built with the x32 ABI, a call whose number has bit 30 set
    /// arrives with the architecture value the filter accepts, and its number matches nothing on the list. Every
    /// number with that bit set is refused — each refused call's x32 twin, each allowed call's (a 64-bit build
    /// never makes one), and the numbers 512–547 the x32 table gives its own entries (`execve` is 520 there, not
    /// 59) — while the native numbers keep the answers they had.
    #[test]
    fn every_call_through_the_x32_door_is_refused_and_the_native_ones_keep_their_answers() {
        let program = program().expect("the filter compiles");
        let eperm = SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let x32 = |number: i64| number | i64::from(X32_SYSCALL_BIT);
        // the refused calls first: these are the ones the review counted (every name on the list, through the door)
        let refused = refused_calls();
        let through_the_door: Vec<&str> = refused
            .iter()
            .filter(|(_, number)| plain(&program, x32(*number)) != eperm)
            .map(|(name, _)| *name)
            .collect();
        assert!(
            through_the_door.is_empty(),
            "{} of {} refused calls pass when called by their x32 number (`n | 0x4000_0000`): {through_the_door:?}",
            through_the_door.len(),
            refused.len()
        );
        let allowed = allowed_calls();
        let allowed_through: Vec<&str> = allowed
            .iter()
            .filter(|(_, number)| plain(&program, x32(*number)) != eperm)
            .map(|(name, _)| *name)
            .collect();
        assert!(
            allowed_through.is_empty(),
            "{} of {} allowed calls pass by their x32 number: {allowed_through:?}",
            allowed_through.len(),
            allowed.len()
        );
        let own: Vec<i64> = (512..=547)
            .filter(|number| plain(&program, x32(*number)) != eperm)
            .collect();
        assert!(
            own.is_empty(),
            "{} of 36 calls the x32 table numbers apart (512–547; `execve` is 520 there) pass: {own:?}",
            own.len()
        );
        // the door is the bit and nothing below it: the native numbers answer as before
        assert_eq!(plain(&program, libc::SYS_read), SECCOMP_RET_ALLOW);
        assert_eq!(plain(&program, libc::SYS_openat), eperm);
        // the architecture check still comes first: a stranger's x32-looking call is not this filter's to judge
        assert_eq!(
            answer(&program, x32(libc::SYS_read), AUDIT_ARCH_THIS ^ 1, [0; 6]),
            SECCOMP_RET_KILL_PROCESS
        );
    }

    /// A program the compiler wrote differently from what [`refuse_x32`] expects is an error and not a program
    /// without the x32 refusal.
    #[test]
    fn a_program_that_does_not_open_with_the_architecture_check_is_not_given_a_door_to_leave_open()
    {
        let mut program = program().expect("the filter compiles");
        // the compiled program minus its first instruction no longer opens with the check
        program.remove(0);
        assert_eq!(refuse_x32(program), Err(LockDownError));
        assert_eq!(refuse_x32(Vec::new()), Err(LockDownError));
    }

    /// The program is small enough to be one the kernel accepts (4096 instructions at most).
    #[test]
    fn the_filter_is_small_enough_for_the_kernel() {
        let program = program().expect("the filter compiles");
        assert!(program.len() < 4096, "{} instructions", program.len());
    }
}
