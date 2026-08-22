// Passive local-agent detection (T-5 / #1655, E4·E5).
//
// The desktop shell can see files and process names; the webview cannot, and
// must not be handed a generic "does this path exist" oracle. This module is
// therefore an ALLOWLIST: the signatures live here as literals, the command
// returns one observation per signature, and anything not on the list is
// invisible. Product copy (the invite sentence, the prefilled name) lives in
// `packages/momo-core/src/features/hostedAgents/detect.ts` under the same ids.
//
// Signatures are passive by contract (packet §0-2):
//   - app bundle path
//   - bundle identifier inside an Info.plist we already opened
//   - running process *name* (`ps -axc`)
// Driving the other app, or probing its debug ports, is not representable
// here. Adding either would have to pass a source test that forbids those
// strings.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[cfg(target_os = "macos")]
use std::fs;
#[cfg(target_os = "macos")]
use std::process::Command;

use serde::Serialize;

/// Keep in lockstep with `HOSTED_AGENT_SIGNATURES` in momo-core `detect.ts`.
const SIGNATURES: &[Signature] = &[Signature {
    id: "grok",
    bundle_paths: &["/Applications/Grok Bot.app"],
    bundle_ids: &["com.anysphere.sand"],
    process_names: &["Grok Bot"],
}];

struct Signature {
    id: &'static str,
    bundle_paths: &'static [&'static str],
    bundle_ids: &'static [&'static str],
    process_names: &'static [&'static str],
}

/// One allowlisted id, observed. Never carries product copy or a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostedAgentProbe {
    pub id: String,
    pub bundle_present: bool,
    pub process_running: bool,
}

pub struct ObservationIndex {
    pub paths: HashSet<PathBuf>,
    pub bundle_ids: HashSet<String>,
    pub process_names: HashSet<String>,
}

impl ObservationIndex {
    fn bundle_present(&self, signature: &Signature) -> bool {
        signature
            .bundle_paths
            .iter()
            .any(|path| self.paths.contains(Path::new(path)))
            || signature
                .bundle_ids
                .iter()
                .any(|id| self.bundle_ids.contains(*id))
    }

    fn process_running(&self, signature: &Signature) -> bool {
        signature
            .process_names
            .iter()
            .any(|name| self.process_names.contains(*name))
    }
}

pub fn probes_from_index(index: &ObservationIndex) -> Vec<HostedAgentProbe> {
    SIGNATURES
        .iter()
        .map(|signature| HostedAgentProbe {
            id: signature.id.to_string(),
            bundle_present: index.bundle_present(signature),
            process_running: index.process_running(signature),
        })
        .collect()
}

fn probe_hosted_agents() -> Vec<HostedAgentProbe> {
    probes_from_index(&live_index())
}

/// Best-effort. An IO failure is "not found", never an error the UI should show.
#[tauri::command]
pub async fn detect_hosted_agents() -> Vec<HostedAgentProbe> {
    tauri::async_runtime::spawn_blocking(probe_hosted_agents)
        .await
        .unwrap_or_default()
}

fn live_index() -> ObservationIndex {
    #[cfg(target_os = "macos")]
    {
        ObservationIndex {
            paths: live_bundle_paths(),
            bundle_ids: live_bundle_ids(),
            process_names: live_process_names(),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        ObservationIndex {
            paths: HashSet::new(),
            bundle_ids: HashSet::new(),
            process_names: HashSet::new(),
        }
    }
}

#[cfg(target_os = "macos")]
fn live_bundle_paths() -> HashSet<PathBuf> {
    SIGNATURES
        .iter()
        .flat_map(|signature| signature.bundle_paths.iter())
        .filter_map(|path| {
            let path = PathBuf::from(path);
            path.exists().then_some(path)
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn applications_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/Applications")];
    if let Some(home) = std::env::var_os("HOME") {
        dirs.push(PathBuf::from(home).join("Applications"));
    }
    dirs
}

#[cfg(target_os = "macos")]
fn live_bundle_ids() -> HashSet<String> {
    let wanted: HashSet<&str> = SIGNATURES
        .iter()
        .flat_map(|signature| signature.bundle_ids.iter().copied())
        .collect();
    let mut found = HashSet::new();
    for dir in applications_dirs() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("app") {
                continue;
            }
            let Some(bytes) = fs::read(path.join("Contents/Info.plist")).ok() else {
                continue;
            };
            for id in &wanted {
                if plist_contains_bundle_id(&bytes, id) {
                    found.insert((*id).to_string());
                }
            }
            if found.len() == wanted.len() {
                return found;
            }
        }
    }
    found
}

/// XML Info.plist or a binary plist that still stores the id as UTF-8 bytes.
/// We only look for allowlisted ids, so a coincidental substring in some other
/// app's plist cannot enlarge the result set past the allowlist.
fn plist_contains_bundle_id(bytes: &[u8], id: &str) -> bool {
    bytes
        .windows(id.len())
        .any(|window| window == id.as_bytes())
}

#[cfg(target_os = "macos")]
fn live_process_names() -> HashSet<String> {
    let output = Command::new("/bin/ps")
        .args(["-axc", "-o", "comm="])
        .output();
    let Ok(output) = output else {
        return HashSet::new();
    };
    if !output.status.success() {
        return HashSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn empty_index() -> ObservationIndex {
        ObservationIndex {
            paths: HashSet::new(),
            bundle_ids: HashSet::new(),
            process_names: HashSet::new(),
        }
    }

    #[test]
    fn v1_allowlist_is_grok_bot_only() {
        assert_eq!(SIGNATURES.len(), 1);
        assert_eq!(SIGNATURES[0].id, "grok");
        assert_eq!(SIGNATURES[0].bundle_paths, &["/Applications/Grok Bot.app"]);
        assert_eq!(SIGNATURES[0].bundle_ids, &["com.anysphere.sand"]);
        assert_eq!(SIGNATURES[0].process_names, &["Grok Bot"]);
    }

    #[test]
    fn missing_everything_is_a_negative_probe_not_an_empty_list() {
        let probes = probes_from_index(&empty_index());
        assert_eq!(
            probes,
            vec![HostedAgentProbe {
                id: "grok".into(),
                bundle_present: false,
                process_running: false,
            }]
        );
    }

    #[test]
    fn bundle_path_or_bundle_id_or_process_is_enough() {
        let mut by_path = empty_index();
        by_path
            .paths
            .insert(PathBuf::from("/Applications/Grok Bot.app"));
        assert!(probes_from_index(&by_path)[0].bundle_present);

        let mut by_id = empty_index();
        by_id.bundle_ids.insert("com.anysphere.sand".into());
        assert!(probes_from_index(&by_id)[0].bundle_present);

        let mut by_proc = empty_index();
        by_proc.process_names.insert("Grok Bot".into());
        assert!(probes_from_index(&by_proc)[0].process_running);
    }

    #[test]
    fn unknown_paths_and_ids_do_not_count() {
        let mut index = empty_index();
        index
            .paths
            .insert(PathBuf::from("/Applications/Cursor.app"));
        index.bundle_ids.insert("com.todesktop.cursor".into());
        index.process_names.insert("Cursor".into());
        let probe = &probes_from_index(&index)[0];
        assert!(!probe.bundle_present);
        assert!(!probe.process_running);
    }

    #[test]
    fn plist_match_is_the_allowlisted_id() {
        let xml = br#"<?xml version="1.0"?>
        <plist><dict>
          <key>CFBundleIdentifier</key>
          <string>com.anysphere.sand</string>
        </dict></plist>"#;
        assert!(plist_contains_bundle_id(xml, "com.anysphere.sand"));
        assert!(!plist_contains_bundle_id(xml, "com.anysphere.cursor"));
        assert!(!plist_contains_bundle_id(
            b"\0\0binary",
            "com.anysphere.sand"
        ));
    }

    #[test]
    fn source_has_no_cdp_or_port_scan() {
        let src = include_str!("detect.rs");
        let production = src.split("#[cfg(test)]").next().expect("production source");
        let port = format!("{}{}", "92", "22");
        for needle in [
            port.as_str(),
            "chrome-debugging",
            "/json/version",
            "localhost:",
        ] {
            assert!(
                !production.contains(needle),
                "passive detector must not mention {needle}"
            );
        }
    }
}
