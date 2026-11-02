//! What the PDF child refuses to do for the rest of its life (ADR-0151 증보 6 B, #5072 — the first half of
//! review R2-4).
//!
//! The child is a function: PDF bytes on stdin, one JSON line on stdout. It needs no file by name, no socket,
//! no other program and no other process — and it parses bytes an attacker wrote. So once its limits are in place
//! (`attachment_text::confine_self`) and its watchdog thread exists, it asks the kernel to refuse those four things
//! on **every thread it has** ([`lock_down`]). Whatever the parser were later talked into doing, it could not open
//! `/proc/<worker>/environ` (or any other file), reach the database or the private network, start a shell, or look
//! into the worker's memory.
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
//! report as an unreadable file, and a call an attacker makes is a refusal he sees, not a crash he can probe):
//!
//! 1. a file by name — `open`, `openat`, `openat2`, `creat`, the handle-based `open_by_handle_at` and
//!    `name_to_handle_at`, and `open_tree`. The child's only descriptors are stdin, stdout and stderr, and they are
//!    already open;
//! 2. the network — `socket`, `connect`, `bind`, `listen`, `accept`, `accept4`;
//! 3. another program — `execve`, `execveat`;
//! 4. another process — `ptrace`, `process_vm_readv`, `process_vm_writev`, `pidfd_open`, `pidfd_getfd`, `kcmp`;
//! 5. the ring buffer that performs 1 and 2 without asking the filter — `io_uring_setup`, `io_uring_enter`,
//!    `io_uring_register`. (Without this group the filter would be a door with a window beside it.)
//!
//! Not listed: the privileged calls (`mount`, namespaces, `bpf`, `perf_event_open`, `userfaultfd` …), which a
//! process without capabilities cannot make anyway, and everything the allocator, the threads and the clock
//! need. A filter of the other kind — an allowlist — would be a list of what glibc happens to call this year, and
//! a missing entry would be a PDF that reads on one image and not on the next.
//!
//! A filter for the wrong architecture kills the process on its first call, so the architecture is the one this
//! binary was built for (`std::env::consts::ARCH`); a call through another ABI (`int 0x80`) is killed by the
//! filter's own architecture check.

/// The filter could not be built or installed. The child then reads nothing (`ConfineStep::Filter`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct LockDownError;

/// The system calls the child refuses, by name (the name is for a failing test's message, not for the filter).
#[cfg(target_os = "linux")]
fn denied() -> Vec<(&'static str, libc::c_long)> {
    let common: Vec<(&'static str, libc::c_long)> = vec![
        // 1. a file by name
        ("openat", libc::SYS_openat),
        ("openat2", libc::SYS_openat2),
        ("open_by_handle_at", libc::SYS_open_by_handle_at),
        ("name_to_handle_at", libc::SYS_name_to_handle_at),
        ("open_tree", libc::SYS_open_tree),
        // 2. the network
        ("socket", libc::SYS_socket),
        ("connect", libc::SYS_connect),
        ("bind", libc::SYS_bind),
        ("listen", libc::SYS_listen),
        ("accept", libc::SYS_accept),
        ("accept4", libc::SYS_accept4),
        // 3. another program
        ("execve", libc::SYS_execve),
        ("execveat", libc::SYS_execveat),
        // 4. another process
        ("ptrace", libc::SYS_ptrace),
        ("process_vm_readv", libc::SYS_process_vm_readv),
        ("process_vm_writev", libc::SYS_process_vm_writev),
        ("pidfd_open", libc::SYS_pidfd_open),
        ("pidfd_getfd", libc::SYS_pidfd_getfd),
        ("kcmp", libc::SYS_kcmp),
        // 5. the ring buffer that does 1 and 2 without asking
        ("io_uring_setup", libc::SYS_io_uring_setup),
        ("io_uring_enter", libc::SYS_io_uring_enter),
        ("io_uring_register", libc::SYS_io_uring_register),
    ];
    // the older spellings of "open a file" exist on x86-64 only (aarch64 has `openat` alone)
    #[cfg(target_arch = "x86_64")]
    let older = [("open", libc::SYS_open), ("creat", libc::SYS_creat)];
    #[cfg(not(target_arch = "x86_64"))]
    let older: [(&'static str, libc::c_long); 0] = [];
    common.into_iter().chain(older).collect()
}

/// The compiled filter: [`denied`] answered `EPERM`, everything else allowed.
#[cfg(target_os = "linux")]
fn program() -> Result<seccompiler::BpfProgram, LockDownError> {
    use seccompiler::{SeccompAction, SeccompFilter, SeccompRule};
    use std::collections::BTreeMap;

    // an empty rule list is "this call, whatever its arguments"
    let rules: BTreeMap<i64, Vec<SeccompRule>> = denied()
        .into_iter()
        .map(|(_, number)| (number, Vec::new()))
        .collect();
    SeccompFilter::new(
        rules,
        SeccompAction::Allow,
        SeccompAction::Errno(libc::EPERM as u32),
        std::env::consts::ARCH
            .try_into()
            .map_err(|_| LockDownError)?,
    )
    .map_err(|_| LockDownError)?
    .try_into()
    .map_err(|_| LockDownError)
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

    // `seccomp_data`: the call number at offset 0, the architecture at offset 4
    const SECCOMP_RET_ALLOW: u32 = 0x7fff_0000;
    const SECCOMP_RET_ERRNO: u32 = 0x0005_0000;
    const SECCOMP_RET_KILL_PROCESS: u32 = 0x8000_0000;
    #[cfg(target_arch = "x86_64")]
    const AUDIT_ARCH_THIS: u32 = 0xC000_003E;
    #[cfg(target_arch = "aarch64")]
    const AUDIT_ARCH_THIS: u32 = 0xC000_00B7;

    /// What the kernel would answer a call `number` made through `arch`: the classic BPF the compiler emits is
    /// four instructions (load a word of `seccomp_data`, jump if equal, jump, return), run here the way the
    /// kernel runs them. A program with any other instruction is a program this test does not understand, and
    /// it fails instead of guessing.
    fn answer(program: &[seccompiler::sock_filter], number: i64, arch: u32) -> u32 {
        const LD_W_ABS: u16 = 0x20;
        const JMP_JEQ_K: u16 = 0x15;
        const JMP_JA: u16 = 0x05;
        const RET_K: u16 = 0x06;
        let (mut accumulator, mut at) = (0u32, 0usize);
        for _ in 0..program.len() * 2 {
            let step = &program[at];
            at += 1;
            match step.code {
                LD_W_ABS => {
                    accumulator = match step.k {
                        0 => number as u32,
                        4 => arch,
                        other => panic!("the filter reads seccomp_data at {other}"),
                    }
                }
                JMP_JEQ_K => {
                    at += usize::from(if accumulator == step.k {
                        step.jt
                    } else {
                        step.jf
                    })
                }
                JMP_JA => at += step.k as usize,
                RET_K => return step.k,
                other => panic!("an instruction this test does not run: {other:#x}"),
            }
        }
        panic!("the filter does not end");
    }

    /// The compiled filter, run on every call it must refuse and on the calls a PDF read cannot do without.
    /// The refused list is written **here**, apart from [`denied`], by the group it belongs to: a call dropped
    /// from the filter (or one that never made it in) is a line of this list answered `ALLOW`. What the kernel
    /// does with the filter is held by `attachment_text`'s probe, for the calls a probe can make.
    #[test]
    fn every_refused_call_is_answered_eperm_and_the_calls_a_read_needs_are_allowed() {
        let program = program().expect("the filter compiles");
        let eperm = SECCOMP_RET_ERRNO | libc::EPERM as u32;
        let common: Vec<(&str, i64)> = vec![
            // a file by name
            ("openat", libc::SYS_openat),
            ("openat2", libc::SYS_openat2),
            ("open_by_handle_at", libc::SYS_open_by_handle_at),
            ("name_to_handle_at", libc::SYS_name_to_handle_at),
            ("open_tree", libc::SYS_open_tree),
            // the network
            ("socket", libc::SYS_socket),
            ("connect", libc::SYS_connect),
            ("bind", libc::SYS_bind),
            ("listen", libc::SYS_listen),
            ("accept", libc::SYS_accept),
            ("accept4", libc::SYS_accept4),
            // another program
            ("execve", libc::SYS_execve),
            ("execveat", libc::SYS_execveat),
            // another process
            ("ptrace", libc::SYS_ptrace),
            ("process_vm_readv", libc::SYS_process_vm_readv),
            ("process_vm_writev", libc::SYS_process_vm_writev),
            ("pidfd_open", libc::SYS_pidfd_open),
            ("pidfd_getfd", libc::SYS_pidfd_getfd),
            ("kcmp", libc::SYS_kcmp),
            // the ring buffer that does the first two without asking
            ("io_uring_setup", libc::SYS_io_uring_setup),
            ("io_uring_enter", libc::SYS_io_uring_enter),
            ("io_uring_register", libc::SYS_io_uring_register),
        ];
        #[cfg(target_arch = "x86_64")]
        let older = [("open", libc::SYS_open), ("creat", libc::SYS_creat)];
        #[cfg(not(target_arch = "x86_64"))]
        let older: [(&str, i64); 0] = [];
        let refused: Vec<(&str, i64)> = common.into_iter().chain(older).collect();
        for (name, number) in &refused {
            assert_eq!(
                answer(&program, *number, AUDIT_ARCH_THIS),
                eperm,
                "{name} must be refused with EPERM"
            );
        }
        // everything the allocator, a thread's sleep, the clock, the signal setup of the runtime and the
        // output of the answer use: allowed, or a PDF reads on one image and not on the next
        let allowed: Vec<(&str, i64)> = vec![
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
            ("sigaltstack", libc::SYS_sigaltstack),
            ("sched_yield", libc::SYS_sched_yield),
            ("exit_group", libc::SYS_exit_group),
            ("tgkill", libc::SYS_tgkill),
            ("gettid", libc::SYS_gettid),
            ("getpid", libc::SYS_getpid),
            ("ioctl", libc::SYS_ioctl),
            ("fcntl", libc::SYS_fcntl),
            ("newfstatat", libc::SYS_newfstatat),
            ("statx", libc::SYS_statx),
            ("prlimit64", libc::SYS_prlimit64),
            ("clone3", libc::SYS_clone3),
        ];
        for (name, number) in &allowed {
            assert_eq!(
                answer(&program, *number, AUDIT_ARCH_THIS),
                SECCOMP_RET_ALLOW,
                "{name} must be allowed"
            );
        }
        // a call made through another ABI is not this filter's to judge: the process ends
        assert_eq!(
            answer(&program, libc::SYS_read, AUDIT_ARCH_THIS ^ 1),
            SECCOMP_RET_KILL_PROCESS,
            "another architecture's call must end the process"
        );
    }

    /// The filter has no hole of arguments: a call it refuses is refused whatever it is given, and the program is
    /// small enough to be one the kernel accepts (4096 instructions at most).
    #[test]
    fn the_filter_is_small_and_has_no_argument_conditions() {
        let program = program().expect("the filter compiles");
        assert!(program.len() < 4096, "{} instructions", program.len());
        // the only words of `seccomp_data` it reads are the call number and the architecture
        for step in &program {
            if step.code == 0x20 {
                assert!(
                    step.k == 0 || step.k == 4,
                    "reads seccomp_data at {}",
                    step.k
                );
            }
        }
    }
}
