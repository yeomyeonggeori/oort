//! What the agent checks about itself before it touches the host key
//! (ADR-0197 D1: a separate uid, no dumpable process, no core dumps).

use std::io;

use crate::pty::Ids;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PreflightError {
    #[error("the box-agent never runs as root")]
    Root,
    #[error(
        "the box-agent runs as uid {0}, the same uid as the person's shell; the host key would be \
         readable by the harness (ADR-0197 D1)"
    )]
    SameUid(u32),
    #[error("{name} must be a numeric id")]
    BadId { name: &'static str },
}

/// The agent's uid must be neither root nor the person's.
pub fn check_separation(agent_uid: u32, user_uid: u32) -> Result<(), PreflightError> {
    if agent_uid == 0 {
        return Err(PreflightError::Root);
    }
    if agent_uid == user_uid {
        return Err(PreflightError::SameUid(agent_uid));
    }
    Ok(())
}

pub const ENV_USER_UID: &str = "OORT_BOX_USER_UID";
pub const ENV_USER_GID: &str = "OORT_BOX_USER_GID";

/// The person's ids, fixed by the box image (defaults 10001).
pub fn user_ids(get: &dyn Fn(&str) -> Option<String>) -> Result<Ids, PreflightError> {
    let read = |name: &'static str| match get(name).filter(|v| !v.is_empty()) {
        None => Ok(10001u32),
        Some(text) => text
            .parse::<u32>()
            .map_err(|_| PreflightError::BadId { name }),
    };
    Ok(Ids {
        uid: read(ENV_USER_UID)?,
        gid: read(ENV_USER_GID)?,
    })
}

/// Make the process opaque to the person's uid and to crash tooling:
/// not dumpable (so `/proc/<pid>/{mem,environ,fd}` and ptrace belong to root,
/// not to a same-uid process), no core files, no new privileges.
pub fn harden_process() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: plain prctl calls with integer arguments.
        if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
        if unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    let zero = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: a valid rlimit.
    if unsafe { libc::setrlimit(libc::RLIMIT_CORE, &zero) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_and_the_persons_uid_are_refused() {
        assert_eq!(check_separation(0, 10001), Err(PreflightError::Root));
        assert_eq!(
            check_separation(10001, 10001),
            Err(PreflightError::SameUid(10001))
        );
        assert_eq!(check_separation(10002, 10001), Ok(()));
    }

    #[test]
    fn user_ids_default_and_reject_junk() {
        let none = |_: &str| None;
        assert_eq!(
            user_ids(&none).unwrap(),
            Ids {
                uid: 10001,
                gid: 10001
            }
        );
        let set = |n: &str| (n == ENV_USER_UID).then(|| "4242".to_string());
        assert_eq!(
            user_ids(&set).unwrap(),
            Ids {
                uid: 4242,
                gid: 10001
            }
        );
        let junk = |n: &str| (n == ENV_USER_GID).then(|| "root".to_string());
        assert!(matches!(user_ids(&junk), Err(PreflightError::BadId { .. })));
    }
}
