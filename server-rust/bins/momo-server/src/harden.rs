//! Process hardening for a server that relays a person's terminal (ADR-0197 threat T9).
//!
//! The relay is blind by construction, but a crash dump of the **process** could still hold bytes that were in
//! flight (a frame in a queue, a ticket, a request body). The server therefore asks the kernel for no core file and
//! no dump at all: `RLIMIT_CORE = 0`, and on Linux `PR_SET_DUMPABLE = 0` (which also closes ptrace-by-the-same-uid
//! and `/proc/<pid>/mem` for other accounts). Called once at start by `main`. Deployment runbooks add the host's
//! `kernel.core_pattern` and kdump off; this is the part the process can do for itself.

/// Disable core files and, on Linux, make the process non-dumpable. Returns whether both took effect.
pub fn disable_core_dumps() -> bool {
    let limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid rlimit struct; setting a lower limit needs no privilege.
    let core_off = unsafe { libc::setrlimit(libc::RLIMIT_CORE, &limit) } == 0;
    #[cfg(target_os = "linux")]
    let dumpable_off = {
        // SAFETY: PR_SET_DUMPABLE with 0 takes no pointers.
        unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) == 0 }
    };
    #[cfg(not(target_os = "linux"))]
    let dumpable_off = true;
    core_off && dumpable_off
}

/// The soft core-file limit now in force (`None` when it cannot be read).
pub fn core_limit() -> Option<u64> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid out-pointer.
    (unsafe { libc::getrlimit(libc::RLIMIT_CORE, &mut limit) } == 0).then_some(limit.rlim_cur as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn core_files_are_off_after_the_call() {
        assert!(disable_core_dumps());
        assert_eq!(core_limit(), Some(0));
        #[cfg(target_os = "linux")]
        {
            // SAFETY: PR_GET_DUMPABLE takes no pointers.
            assert_eq!(unsafe { libc::prctl(libc::PR_GET_DUMPABLE, 0, 0, 0, 0) }, 0);
        }
    }
}
