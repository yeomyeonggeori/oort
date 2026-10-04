//! `momo-box-agent` entry point (ADR-0197 M3).
//!
//! ```text
//! momo-box-agent init-key   create the host key in this box if there is none,
//!                           print its public half and fingerprint
//! momo-box-agent run        preflight, load the host key, hold the box identity
//! ```
//!
//! There is no `--dev-key-file`, no `--config` and no flag that names a key
//! path: the key location comes from the box image's environment
//! (`OORT_BOX_KEY_DIR` …, the same variables `momo-workd` reads on Linux) and
//! is checked against the mount table. `run` serves nothing yet — the relay
//! route is M4 and the runner is M2 — so it holds the identity, stays
//! `pending` until the owner confirms, and waits.

use std::process::ExitCode;

#[cfg(target_os = "linux")]
mod linux {
    use std::path::PathBuf;
    use std::sync::Arc;

    use momo_blind_pty::handshake::NonceStore;
    use momo_box_agent::env::UserProfile;
    use momo_box_agent::fsgate::FsGate;
    use momo_box_agent::host::{box_id_from_text, BoxHost, MonotonicClock, Phase, SpawnTemplate};
    use momo_box_agent::preflight;
    use momo_workd::cli::host_key_fingerprint;
    use momo_workd::keystore::box_store::{BoxKeyStore, ENV_BOX_ID};
    use momo_workd::keystore::HostKey;

    const ENV_STATE_DIR: &str = "OORT_BOX_AGENT_STATE_DIR";

    fn getenv(name: &str) -> Option<String> {
        std::env::var(name).ok()
    }

    /// Everything both commands need, in the order that matters: uid first, then
    /// the process is made opaque, then (and only then) the key store opens.
    fn open_store() -> Result<(BoxKeyStore, momo_box_agent::pty::Ids), String> {
        let user = preflight::user_ids(&getenv).map_err(|e| e.to_string())?;
        // SAFETY: geteuid cannot fail.
        let euid = unsafe { libc::geteuid() };
        preflight::check_separation(euid, user.uid).map_err(|e| e.to_string())?;
        preflight::harden_process().map_err(|e| format!("hardening failed: {e}"))?;
        // Through the one filesystem door like everything else the agent reads.
        let gate = FsGate::for_box(&getenv, &UserProfile::box_default().home);
        let mountinfo = String::from_utf8(
            gate.read(std::path::Path::new("/proc/self/mountinfo"))
                .map_err(|e| format!("cannot read the mount table: {e}"))?,
        )
        .map_err(|_| "the mount table is not UTF-8".to_string())?;
        let store = BoxKeyStore::from_env(&getenv, Some(&mountinfo)).map_err(|e| e.to_string())?;
        Ok((store, user))
    }

    pub fn init_key() -> Result<(), String> {
        let (store, _) = open_store()?;
        let key = match store.load().map_err(|e| e.to_string())? {
            Some(key) => key,
            None => {
                let key = HostKey::generate().map_err(|e| e.to_string())?;
                store.store(&key, false).map_err(|e| e.to_string())?;
                key
            }
        };
        let public = key.public_key_b64();
        println!("public_key={public}");
        println!(
            "fingerprint={}",
            host_key_fingerprint(&public).unwrap_or_default()
        );
        Ok(())
    }

    pub fn run() -> Result<(), String> {
        let (store, user) = open_store()?;
        let key = store
            .load()
            .map_err(|e| e.to_string())?
            .ok_or("no host key in this box; run `momo-box-agent init-key` first")?;
        let box_id = getenv(ENV_BOX_ID)
            .as_deref()
            .and_then(box_id_from_text)
            .ok_or("OORT_BOX_ID must be the box's UUID")?;
        let profile = UserProfile {
            uid: user.uid,
            gid: user.gid,
            ..UserProfile::box_default()
        };
        let gate = FsGate::for_box(&getenv, &profile.home);
        let state_dir = PathBuf::from(
            getenv(ENV_STATE_DIR).unwrap_or_else(|| "/var/lib/oort-box/state".into()),
        );
        let nonces = match gate.read(&state_dir.join("nonces.bin")) {
            Ok(bytes) => NonceStore::from_bytes(&bytes).map_err(|e| e.to_string())?,
            Err(momo_box_agent::fsgate::FsError::Io { source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                NonceStore::default()
            }
            Err(e) => return Err(e.to_string()),
        };
        let template = SpawnTemplate::for_box(profile, std::env::vars_os().collect());
        let host = BoxHost::new(
            box_id,
            key.signing_key(),
            Arc::new(MonotonicClock::new()),
            nonces,
            template,
        );
        eprintln!(
            "momo-box-agent: phase={} key={} (relay transport lands with M4; nothing is served)",
            match host.phase() {
                Phase::Pending => "pending",
                Phase::Active => "active",
            },
            store.describe()
        );
        loop {
            std::thread::park();
        }
    }
}

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let result: Result<(), String> = match args.as_slice() {
        [c] if c == "--version" || c == "-V" => {
            println!("momo-box-agent {}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        #[cfg(target_os = "linux")]
        [c] if c == "init-key" => linux::init_key(),
        #[cfg(target_os = "linux")]
        [c] if c == "run" => linux::run(),
        #[cfg(not(target_os = "linux"))]
        [c] if c == "init-key" || c == "run" => {
            Err("momo-box-agent runs inside a Linux personal-cloud box only".to_string())
        }
        _ => Err("usage: momo-box-agent init-key | run | --version".to_string()),
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("momo-box-agent: {message}");
            ExitCode::from(2)
        }
    }
}
