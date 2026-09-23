//! The agent's process tree, so the end of a session reaches everything the
//! agent started (#2602 L-1, #2607).
//!
//! The adapter runs in its own process group, but what it starts need not stay
//! there: codex runs every shell command after `setsid()` (a new session and a
//! new group), and macOS has no parent-death signal. A group signal misses
//! those, and once the adapter exits they are re-parented to launchd and can no
//! longer be found through it. So the host keeps a **census** of the tree —
//! every descendant it has seen, by pid and start time — refreshed on every
//! session tick and again when the session ends, and signals each member on
//! its own. A pid is signalled only while it still names the process that was
//! seen (same start time), so a recycled pid is never hit.
//!
//! What the census cannot see: a descendant that is started and detached
//! (double fork) entirely between two censuses, which is one session tick.

use std::collections::{HashMap, HashSet};

/// What the host needs to know about one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProcInfo {
    pub ppid: i32,
    /// Start time in the platform's own unit; only compared for equality.
    pub started: u64,
    pub zombie: bool,
}

#[cfg(target_os = "macos")]
pub fn info(pid: i32) -> Option<ProcInfo> {
    if pid <= 0 {
        return None;
    }
    // SAFETY: an all-zero `proc_bsdinfo` is a valid value of this plain C
    // struct, and `proc_pidinfo` writes at most `size` bytes into it.
    let mut bsd: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
    let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
    let written = unsafe {
        libc::proc_pidinfo(
            pid,
            libc::PROC_PIDTBSDINFO,
            0,
            (&mut bsd as *mut libc::proc_bsdinfo).cast(),
            size,
        )
    };
    if written != size {
        return None;
    }
    Some(ProcInfo {
        ppid: bsd.pbi_ppid as i32,
        started: bsd
            .pbi_start_tvsec
            .wrapping_mul(1_000_000)
            .wrapping_add(bsd.pbi_start_tvusec),
        zombie: bsd.pbi_status == libc::SZOMB,
    })
}

#[cfg(target_os = "macos")]
pub fn children(pid: i32) -> Vec<i32> {
    if pid <= 0 {
        return Vec::new();
    }
    let mut capacity = 64usize;
    loop {
        let mut buffer: Vec<libc::pid_t> = vec![0; capacity];
        let bytes = (capacity * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        // SAFETY: the buffer holds `capacity` pids; the call returns how many
        // it wrote (libproc `proc_listchildpids`), or -1.
        let count = unsafe { libc::proc_listchildpids(pid, buffer.as_mut_ptr().cast(), bytes) };
        if count < 0 {
            return Vec::new();
        }
        let count = count as usize;
        if count < capacity || capacity >= 1 << 16 {
            buffer.truncate(count.min(capacity));
            buffer.retain(|child| *child > 0);
            return buffer;
        }
        capacity *= 4;
    }
}

#[cfg(target_os = "linux")]
pub fn info(pid: i32) -> Option<ProcInfo> {
    if pid <= 0 {
        return None;
    }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // `pid (comm) state ppid …`: the command may hold spaces and parentheses,
    // so fields are counted from the last `)`.
    let rest = stat.get(stat.rfind(')')? + 1..)?;
    let fields: Vec<&str> = rest.split_whitespace().collect();
    Some(ProcInfo {
        ppid: fields.get(1)?.parse().ok()?,
        // Field 22 of the whole line: the 20th after the command.
        started: fields.get(19)?.parse().ok()?,
        zombie: fields.first() == Some(&"Z"),
    })
}

#[cfg(target_os = "linux")]
pub fn children(pid: i32) -> Vec<i32> {
    if pid <= 0 {
        return Vec::new();
    }
    let mut found: Vec<i32> = Vec::new();
    let mut listed = false;
    if let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) {
        for task in tasks.flatten() {
            if let Ok(list) = std::fs::read_to_string(task.path().join("children")) {
                listed = true;
                found.extend(
                    list.split_whitespace()
                        .filter_map(|child| child.parse::<i32>().ok()),
                );
            }
        }
    }
    if !listed {
        // A kernel without `/proc/<pid>/task/<tid>/children`: scan every
        // process for its parent.
        if let Ok(entries) = std::fs::read_dir("/proc") {
            for entry in entries.flatten() {
                let Some(candidate) = entry
                    .file_name()
                    .to_str()
                    .and_then(|name| name.parse::<i32>().ok())
                else {
                    continue;
                };
                if info(candidate).is_some_and(|process| process.ppid == pid) {
                    found.push(candidate);
                }
            }
        }
    }
    found
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn info(_pid: i32) -> Option<ProcInfo> {
    None
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub fn children(_pid: i32) -> Vec<i32> {
    Vec::new()
}

/// Every process the agent has started, as far as the host has seen.
#[derive(Debug)]
pub struct ProcessTree {
    root: i32,
    root_started: Option<u64>,
    members: HashMap<i32, u64>,
}

impl ProcessTree {
    pub fn new(root: i32) -> Self {
        Self {
            root,
            root_started: info(root).map(|process| process.started),
            members: HashMap::new(),
        }
    }

    fn is_same(pid: i32, started: u64) -> bool {
        info(pid).is_some_and(|process| process.started == started)
    }

    /// Walk from the root and from every member that is still the process
    /// that was seen, and remember each descendant found. Members that are
    /// gone (or whose pid now names another process) are forgotten.
    pub fn census(&mut self) {
        let mut frontier: Vec<i32> = Vec::new();
        if self
            .root_started
            .is_some_and(|started| Self::is_same(self.root, started))
        {
            frontier.push(self.root);
        }
        frontier.extend(
            self.members
                .iter()
                .filter(|(pid, started)| Self::is_same(**pid, **started))
                .map(|(pid, _)| *pid),
        );
        let mut visited: HashSet<i32> = HashSet::new();
        while let Some(parent) = frontier.pop() {
            if !visited.insert(parent) {
                continue;
            }
            for child in children(parent) {
                if child == self.root {
                    continue;
                }
                let Some(process) = info(child) else { continue };
                if process.ppid != parent {
                    continue;
                }
                self.members.insert(child, process.started);
                frontier.push(child);
            }
        }
        self.members
            .retain(|pid, started| info(*pid).is_some_and(|p| p.started == *started && !p.zombie));
    }

    /// Send `signal` to every member that is still the process that was seen.
    pub fn signal_members(&self, signal: i32) {
        for (pid, started) in &self.members {
            if Self::is_same(*pid, *started) {
                // SAFETY: plain syscall; the pid was just confirmed to be the
                // member that was seen.
                unsafe {
                    libc::kill(*pid, signal);
                }
            }
        }
    }

    /// The members still running (not exited, not a zombie).
    pub fn running(&self) -> Vec<i32> {
        let mut pids: Vec<i32> = self
            .members
            .iter()
            .filter(|(pid, started)| {
                info(**pid).is_some_and(|process| process.started == **started && !process.zombie)
            })
            .map(|(pid, _)| *pid)
            .collect();
        pids.sort_unstable();
        pids
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_census_finds_a_grandchild_and_signals_only_the_tree() {
        // root: a shell that starts a background sleep and waits for it.
        let mut root = std::process::Command::new("/bin/sh")
            .args(["-c", "sleep 30 & wait"])
            .spawn()
            .expect("spawn sh");
        let root_pid = root.id() as i32;
        let me = std::process::id() as i32;
        assert_eq!(info(root_pid).expect("root is visible").ppid, me);

        let mut tree = ProcessTree::new(root_pid);
        let mut grandchild = None;
        for _ in 0..100 {
            tree.census();
            if let Some(pid) = tree.running().first().copied() {
                grandchild = Some(pid);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        let grandchild = grandchild.expect("the census found the background sleep");
        let seen = info(grandchild).unwrap();
        assert_eq!(seen.ppid, root_pid);
        assert!(children(root_pid).contains(&grandchild));
        assert!(
            !tree.running().contains(&root_pid),
            "the root is not a member"
        );

        tree.signal_members(libc::SIGKILL);
        // Gone well before its 30 s run would end on its own.
        let mut gone = false;
        for _ in 0..100 {
            if info(grandchild)
                .is_none_or(|process| process.zombie || process.started != seen.started)
            {
                gone = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(gone, "the member signal reached the grandchild");
        assert!(tree.running().is_empty(), "the tree is gone");
        root.wait().expect("the shell ends once its sleep is gone");
    }
}
