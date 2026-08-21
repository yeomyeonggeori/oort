// Self-update (ADR-0133 P2, MOMO-606).
//
// ADR-0133 decided the Tauri updater instead of Sparkle (#736). What that buys
// is that the *app replaces itself*: the alpha channel's "download a zip, drag
// it over the old app, relaunch" is three manual steps a tester can get wrong,
// and every one of them is a chance to end up running a build nobody can
// identify from a bug report.
//
// Trust chain, end to end:
//
//   minisign   the manifest names a `.app.tar.gz` and its detached signature.
//              The public key is compiled into this binary from tauri.conf.json,
//              the private key never leaves `~/.momo-secrets/` and is not in
//              this repo. A tampered payload fails signature verification before
//              anything is unpacked, so a compromised GitHub Pages host still
//              cannot ship code to a tester.
//   Developer  the payload inside is the SAME signed + notarized + stapled
//   ID         bundle the download page serves, so Gatekeeper's answer after a
//              self-update is identical to the answer after a manual install.
//
// Split into three commands rather than one "update now", because each of the
// three is a different decision for the person at the keyboard:
//
//   updater_check      is there one? (silent, may run on a timer)
//   updater_install    download + swap the bundle on disk (slow, cancellable by
//                      simply not calling relaunch)
//   updater_relaunch   restart into it, when THEY are ready
//
// The last one matters on macOS: `download_and_install` replaces the bundle
// under the running process, which keeps running from the old (now unlinked)
// image until it exits. Restarting is therefore a separate, user-timed act —
// yanking the app out from under someone mid-sentence would be the one thing an
// auto-updater must never do.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

/// Download progress, emitted while `updater_install` runs.
pub const PROGRESS_EVENT: &str = "momo:update-progress";

/// The update found by the last `updater_check`, held so `updater_install` does
/// not have to hit the network a second time (and cannot race into installing a
/// *different* build than the one the user was shown).
#[derive(Default)]
pub struct UpdaterState {
    pending: Mutex<Option<Update>>,
}

/// What the web side renders. Deliberately not the plugin's own type: this is a
/// bridge contract documented in `clients/desktop/README.md`, and it should not
/// change shape because a dependency did.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AvailableUpdate {
    /// The version being offered, e.g. `0.1.0-next.2`.
    pub version: String,
    /// The version running right now, so the badge can show "0.1.0-next.1 → …".
    pub current_version: String,
    /// Release notes from the manifest's `notes`. May be absent.
    pub notes: Option<String>,
    /// The manifest's `pub_date`, verbatim (RFC 3339). Read from the raw JSON
    /// rather than reformatted, so the string the operator published is the
    /// string the tester sees.
    pub published_at: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DownloadProgress {
    pub downloaded: u64,
    /// Absent when the server did not send a Content-Length.
    pub total: Option<u64>,
}

/// Whether this build must NOT self-update — the channel guard (#1281, W-B2-5).
///
/// A local build reports the version baked into `tauri.conf.json` —
/// `0.1.0-next.1` — which the published manifest, several `next.N` ahead, always
/// outranks. An unguarded check therefore offers to "update" it *down* to the
/// last released bundle, replacing newer local code with older published code.
/// There is nothing a local build can meaningfully self-update to, so the check
/// is skipped before it touches the network.
///
/// W-B2-5 (#1280) covered `tauri dev` and `tauri build --debug`. That left a
/// hole: `cargo tauri build` (release, no channel flag) is `is_dev=false` and
/// `debug=false`, so it fell through and rolled back. Bumping the committed
/// version to the last published `next.N` would only last until the next
/// publish; `publish_next_build.sh` already injects the version via `--config`
/// and deliberately does not commit `tauri.conf.json` each time. So the durable
/// split is the compile-time channel flag, not the version string.
///
/// Only a channel artifact (`MOMO_CHANNEL_BUILD=1`, set solely by
/// `scripts/publish_next_build.sh`) is exempt: it is a signed, version-injected
/// release whose job is to follow the manifest.
///
///   `tauri dev`                         is_dev debug !channel -> skip
///   `tauri build --debug`               !is_dev debug !channel -> skip
///   `cargo tauri build` (local release) !is_dev !debug !channel -> skip
///   `publish_next_build.sh`             !is_dev !debug  channel -> check
///
/// Split from the runtime facts so the branch is unit-testable without an
/// `AppHandle` or a network.
const fn update_check_disabled(is_dev: bool, debug: bool, channel_build: bool) -> bool {
    is_dev || debug || !channel_build
}

/// Ask the manifest whether there is a newer build. `Ok(None)` = up to date.
///
/// Errors are returned rather than swallowed: unlike discovery, a failed update
/// check is worth saying out loud — "I could not reach the update server" and
/// "you are on the latest build" must never look the same, or a stalled channel
/// is invisible until someone files the bug that was fixed a week ago.
#[tauri::command]
pub async fn updater_check(app: AppHandle) -> Result<Option<AvailableUpdate>, String> {
    // Channel guard (#1281 / W-B2-5): a local/dev build reports `next.1`, which
    // the published manifest (`next.N`) always outranks, so an unguarded check
    // would offer to downgrade it to the last release. Report "up to date"
    // without a network call — the most honest state for a build with nothing
    // to update to — and clear any pending download. Only a channel artifact
    // (`MOMO_CHANNEL_BUILD=1`) falls through.
    if update_check_disabled(
        tauri::is_dev(),
        cfg!(debug_assertions),
        cfg!(momo_channel_build),
    ) {
        eprintln!("[momo] updater: local/dev/debug build — skipping update check");
        let state = app.state::<UpdaterState>();
        *state.pending.lock().expect("updater state poisoned") = None;
        return Ok(None);
    }

    let updater = app.updater().map_err(|error| error.to_string())?;
    let found = updater.check().await.map_err(|error| error.to_string())?;

    let state = app.state::<UpdaterState>();
    let Some(update) = found else {
        *state.pending.lock().expect("updater state poisoned") = None;
        return Ok(None);
    };

    let info = AvailableUpdate {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        published_at: update
            .raw_json
            .get("pub_date")
            .and_then(|value| value.as_str())
            .map(str::to_owned),
    };
    *state.pending.lock().expect("updater state poisoned") = Some(update);
    Ok(Some(info))
}

/// Download the pending update, verify its signature and swap the bundle.
///
/// Does NOT relaunch — see the module header. Emits `momo:update-progress`
/// while it runs so the button can stop being a spinner with no numbers.
#[tauri::command]
pub async fn updater_install(app: AppHandle) -> Result<(), String> {
    // Taken, not borrowed: an update can only be installed once, and holding the
    // lock across the download would deadlock a second click instead of telling
    // it there is nothing to do.
    let pending = {
        let state = app.state::<UpdaterState>();
        let mut slot = state.pending.lock().expect("updater state poisoned");
        slot.take()
    };
    let Some(update) = pending else {
        return Err("no update is pending — run updater_check first".into());
    };

    let mut downloaded: u64 = 0;
    let progress_app = app.clone();
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = progress_app.emit(PROGRESS_EVENT, DownloadProgress { downloaded, total });
            },
            || {},
        )
        .await;

    if let Err(error) = result {
        // A failed install is recoverable by checking again; leaving the slot
        // empty would make the retry button do nothing.
        return Err(error.to_string());
    }
    Ok(())
}

/// Restart into the installed build. Never returns.
#[tauri::command]
pub fn updater_relaunch(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::update_check_disabled;

    // The channel guard's whole truth table (#1281 / W-B2-5). The one row that
    // must stay `false` is a published channel artifact — everything else is a
    // build the published manifest would downgrade, so it must skip the check.
    #[test]
    fn channel_release_is_the_only_build_that_checks() {
        // is_dev=false, debug=false, channel=true — `publish_next_build.sh`.
        // This is the ONLY build allowed through to the network.
        assert!(!update_check_disabled(false, false, true));
    }

    #[test]
    fn local_release_without_channel_flag_is_guarded() {
        // `cargo tauri build` (release): the W-B2-5 hole. Same flags as a
        // production bundle except the compile-time channel bit.
        assert!(update_check_disabled(false, false, false));
    }

    #[test]
    fn dev_and_debug_builds_are_guarded() {
        // `tauri dev`: dev server, debug assertions on.
        assert!(update_check_disabled(true, true, false));
        assert!(update_check_disabled(true, true, true));
        // `tauri build --debug`: real bundle but debug assertions on.
        assert!(update_check_disabled(false, true, false));
        assert!(update_check_disabled(false, true, true));
        // A dev-server run compiled without debug assertions is still dev.
        assert!(update_check_disabled(true, false, false));
        assert!(update_check_disabled(true, false, true));
    }
}
