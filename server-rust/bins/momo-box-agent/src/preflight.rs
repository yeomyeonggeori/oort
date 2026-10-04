//! What the agent checks about itself before it touches the host key
//! (ADR-0197 D1: a separate uid, no dumpable process, no core dumps).

use std::io;

use crate::pty::Ids;

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum PreflightError {
    #[error("the box-agent never runs as root (uid or gid 0)")]
    Root,
    #[error(
        "the box-agent runs as uid {0}, the same uid as the person's shell; the host key would be \
         readable by the harness (ADR-0197 D1)"
    )]
    SameUid(u32),
    #[error("the box-agent runs as gid {0}, the person's group; separate groups are required")]
    SameGid(u32),
    #[error("{name} must be a numeric id other than 0")]
    BadId { name: &'static str },
    #[error("the spawn helper's ids must differ from the agent's and the person's")]
    HelperNotSeparate,
}

/// The agent's uid and gid must be neither root's nor the person's (L9).
pub fn check_separation(agent: Ids, user: Ids) -> Result<(), PreflightError> {
    if agent.uid == 0 || agent.gid == 0 {
        return Err(PreflightError::Root);
    }
    if agent.uid == user.uid {
        return Err(PreflightError::SameUid(agent.uid));
    }
    if agent.gid == user.gid {
        return Err(PreflightError::SameGid(agent.gid));
    }
    Ok(())
}

pub const ENV_USER_UID: &str = "OORT_BOX_USER_UID";
pub const ENV_USER_GID: &str = "OORT_BOX_USER_GID";
pub const ENV_HELPER_UID: &str = "OORT_BOX_HELPER_UID";
pub const ENV_HELPER_GID: &str = "OORT_BOX_HELPER_GID";

fn read_id(
    get: &dyn Fn(&str) -> Option<String>,
    name: &'static str,
    default: u32,
) -> Result<u32, PreflightError> {
    let id = match get(name).filter(|v| !v.is_empty()) {
        None => default,
        Some(text) => text
            .parse::<u32>()
            .map_err(|_| PreflightError::BadId { name })?,
    };
    if id == 0 {
        return Err(PreflightError::BadId { name });
    }
    Ok(id)
}

/// The person's ids, fixed by the box image (defaults 10001). Never 0.
pub fn user_ids(get: &dyn Fn(&str) -> Option<String>) -> Result<Ids, PreflightError> {
    Ok(Ids {
        uid: read_id(get, ENV_USER_UID, 10001)?,
        gid: read_id(get, ENV_USER_GID, 10001)?,
    })
}

/// The spawn helper's ids (defaults 10003): a third uid and gid, so the helper
/// can read neither the host key nor the person's files.
pub fn helper_ids(
    get: &dyn Fn(&str) -> Option<String>,
    agent: Ids,
    user: Ids,
) -> Result<Ids, PreflightError> {
    let helper = Ids {
        uid: read_id(get, ENV_HELPER_UID, 10003)?,
        gid: read_id(get, ENV_HELPER_GID, 10003)?,
    };
    if [agent.uid, user.uid].contains(&helper.uid) || [agent.gid, user.gid].contains(&helper.gid) {
        return Err(PreflightError::HelperNotSeparate);
    }
    Ok(helper)
}

/// Give up every capability (the agent calls this right after it has started
/// the spawn helper, which holds the only copy). Verified, not assumed.
pub fn drop_capabilities() -> io::Result<()> {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: syscalls only.
        unsafe { crate::pty::clear_capabilities() }
    }
    #[cfg(not(target_os = "linux"))]
    {
        Ok(())
    }
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

    const P: Ids = Ids {
        uid: 10001,
        gid: 10001,
    };

    #[test]
    fn root_the_persons_uid_and_the_persons_gid_are_refused() {
        let a = |uid, gid| Ids { uid, gid };
        assert_eq!(check_separation(a(0, 10002), P), Err(PreflightError::Root));
        assert_eq!(check_separation(a(10002, 0), P), Err(PreflightError::Root));
        assert_eq!(
            check_separation(a(10001, 10002), P),
            Err(PreflightError::SameUid(10001))
        );
        assert_eq!(
            check_separation(a(10002, 10001), P),
            Err(PreflightError::SameGid(10001))
        );
        assert_eq!(check_separation(a(10002, 10002), P), Ok(()));
    }

    #[test]
    fn user_ids_default_and_reject_junk_and_zero() {
        let none = |_: &str| None;
        assert_eq!(user_ids(&none).unwrap(), P);
        let set = |n: &str| (n == ENV_USER_UID).then(|| "4242".to_string());
        assert_eq!(
            user_ids(&set).unwrap(),
            Ids {
                uid: 4242,
                gid: 10001
            }
        );
        for bad in ["root", "0", "-1"] {
            let junk = |n: &str| (n == ENV_USER_GID).then(|| bad.to_string());
            assert!(
                matches!(user_ids(&junk), Err(PreflightError::BadId { .. })),
                "{bad}"
            );
            let junk = |n: &str| (n == ENV_USER_UID).then(|| bad.to_string());
            assert!(
                matches!(user_ids(&junk), Err(PreflightError::BadId { .. })),
                "{bad}"
            );
        }
    }

    #[test]
    fn the_helper_is_a_third_uid_and_gid() {
        let agent = Ids {
            uid: 10002,
            gid: 10002,
        };
        let none = |_: &str| None;
        assert_eq!(
            helper_ids(&none, agent, P).unwrap(),
            Ids {
                uid: 10003,
                gid: 10003
            }
        );
        let same_uid = |n: &str| (n == ENV_HELPER_UID).then(|| "10002".to_string());
        assert_eq!(
            helper_ids(&same_uid, agent, P),
            Err(PreflightError::HelperNotSeparate)
        );
        let same_gid = |n: &str| (n == ENV_HELPER_GID).then(|| "10001".to_string());
        assert_eq!(
            helper_ids(&same_gid, agent, P),
            Err(PreflightError::HelperNotSeparate)
        );
        let zero = |n: &str| (n == ENV_HELPER_UID).then(|| "0".to_string());
        assert!(matches!(
            helper_ids(&zero, agent, P),
            Err(PreflightError::BadId { .. })
        ));
    }
}
