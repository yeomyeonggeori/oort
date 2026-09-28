// Closing the window must not cut a refresh rotation in half (#3098).
//
// The refresh token is single-use (MOMO-300): the server revokes the presented
// token as it answers, and since #3065 a spent token coming back reads as
// theft. The rotation runs in the webview (`clients/web/src/lib/session.ts`
// `exclusiveRotation`) and its new token reaches the keychain through
// `keychain_store_refresh_token`. Closing the only window destroys the webview,
// and with it the request in the air or the keychain write queued behind it —
// the keychain keeps a token the server has already revoked, and the next
// launch signs the person out.
//
// The smallest fix is a hold, not moving the rotation into Rust: the web layer
// brackets each rotation with `session_rotation_begin`/`_end`, and a close
// request that arrives while one is open is deferred. The window is hidden at
// once (to the person, the app has closed) and destroyed when the rotation
// ends or `CLOSE_WAIT_CAP` passes, whichever is first. The cap is enforced
// here, not in JS, because the party that can force the window shut must own
// the bound: a webview that never calls `_end` cannot keep the app alive.
//
// Since #3106 the desktop's rotation itself runs in the shell
// (`session_refresh_attempt`): the POST and the keychain write are Rust, and
// the attempt holds this same hold through `shell_rotation()`. That count is
// separate from the webview's `begin`/`end`, because a page reload (`reset`)
// ends the webview's rotations but not a POST the shell still has in the air.
// The webview still brackets its rotation (the core's retry loop around the
// attempts), which stays harmless.
//
// Scope, stated plainly: this covers closing the window (the red button,
// Cmd+W), which on this single-window app is also how it quits via the window.
// It does NOT cover Cmd+Q / the app menu's Quit: that is AppKit `terminate:`,
// which tao 0.35 answers from `applicationWillTerminate` straight into
// `RunEvent::Exit` (tao-0.35.3/src/platform_impl/macos/app_delegate.rs:131),
// with no `ExitRequested` to veto — and blocking there would deadlock, because
// the webview's IPC to `keychain_store_refresh_token` needs the main thread.

use std::sync::{Condvar, Mutex, MutexGuard};
use std::time::Duration;

/// How long a close waits for an open rotation. The worst case for one
/// rotation once its POST has left: the request deadline (the shell's
/// `session_refresh::REFRESH_REQUEST_TIMEOUT` and the core's
/// `REQUEST_TIMEOUT_MS`, both 15 s) plus the bounded keychain flush
/// (`KEYCHAIN_WAIT_MS`, 5 s, clients/web/src/lib/session.ts).
/// Anything the core itself would still be waiting for is waited for; nothing
/// longer. The window is already hidden, so the wait is not something the
/// person sits through.
pub const CLOSE_WAIT_CAP: Duration = Duration::from_secs(20);

#[derive(Default)]
struct Inner {
    /// Rotations the webview began and has not ended.
    open: u32,
    /// Rotations the shell itself has in flight (#3106). Not cleared by a
    /// page reload: the shell's POST outlives the page.
    shell_open: u32,
    /// A deferred close is already waiting; further close clicks are ignored.
    closing: bool,
}

/// Managed state: how many rotations the webview has open.
#[derive(Default)]
pub struct RotationHold {
    inner: Mutex<Inner>,
    idle: Condvar,
}

impl RotationHold {
    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A poisoned lock only means a panic elsewhere; the counter is still
        // meaningful and a close must never panic over it.
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn begin(&self) {
        let mut inner = self.lock();
        inner.open = inner.open.saturating_add(1);
    }

    /// Never underflows: an `_end` without a `_begin` (a page that reloaded
    /// between the two) is a no-op.
    pub fn end(&self) {
        let mut inner = self.lock();
        inner.open = inner.open.saturating_sub(1);
        if inner.busy() == 0 {
            self.idle.notify_all();
        }
    }

    /// The shell's own rotation (#3106): held until the guard drops.
    pub fn shell_rotation(&self) -> ShellRotation<'_> {
        let mut inner = self.lock();
        inner.shell_open = inner.shell_open.saturating_add(1);
        ShellRotation { hold: self }
    }

    fn end_shell(&self) {
        let mut inner = self.lock();
        inner.shell_open = inner.shell_open.saturating_sub(1);
        if inner.busy() == 0 {
            self.idle.notify_all();
        }
    }

    /// The page that opened the rotations is gone (reload); none of them can
    /// ever end, so none of them may hold a close.
    pub fn reset(&self) {
        let mut inner = self.lock();
        inner.open = 0;
        if inner.busy() == 0 {
            self.idle.notify_all();
        }
    }

    /// A close request arrived. `Wait`: defer it, and this caller is the one
    /// that waits — it hides the window and calls `wait_idle`. `CloseNow`:
    /// nothing is open. `AlreadyWaiting`: a deferred close is running; swallow
    /// this one.
    pub fn defer_close(&self) -> CloseDecision {
        let mut inner = self.lock();
        if inner.closing {
            CloseDecision::AlreadyWaiting
        } else if inner.busy() == 0 {
            CloseDecision::CloseNow
        } else {
            inner.closing = true;
            CloseDecision::Wait
        }
    }

    /// Blocks until no rotation is open or `cap` has passed. `true` when the
    /// rotations finished, `false` when the cap cut them off.
    pub fn wait_idle(&self, cap: Duration) -> bool {
        let inner = self.lock();
        let (inner, timeout) = self
            .idle
            .wait_timeout_while(inner, cap, |inner| inner.busy() > 0)
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        drop(inner);
        !timeout.timed_out()
    }
}

impl Inner {
    fn busy(&self) -> u32 {
        self.open.saturating_add(self.shell_open)
    }
}

/// One shell rotation in flight; ends it on drop (any return path, a panic).
pub struct ShellRotation<'a> {
    hold: &'a RotationHold,
}

impl Drop for ShellRotation<'_> {
    fn drop(&mut self) {
        self.hold.end_shell();
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CloseDecision {
    CloseNow,
    Wait,
    AlreadyWaiting,
}

/// A refresh rotation's POST is about to leave (#3098).
#[tauri::command]
pub fn session_rotation_begin(hold: tauri::State<'_, RotationHold>) {
    hold.begin();
}

/// That rotation is over and its token, if any, is written.
#[tauri::command]
pub fn session_rotation_end(hold: tauri::State<'_, RotationHold>) {
    hold.end();
}

/// `on_window_event` for `CloseRequested` on the main window.
pub fn on_close_requested<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    api: &tauri::CloseRequestApi,
) {
    use tauri::Manager;
    let Some(hold) = window.try_state::<RotationHold>() else {
        return;
    };
    match hold.defer_close() {
        CloseDecision::CloseNow => {}
        CloseDecision::AlreadyWaiting => api.prevent_close(),
        CloseDecision::Wait => {
            api.prevent_close();
            let _ = window.hide();
            let window = window.clone();
            std::thread::spawn(move || {
                if let Some(hold) = window.try_state::<RotationHold>() {
                    if !hold.wait_idle(CLOSE_WAIT_CAP) {
                        eprintln!("[oort] closing with a refresh rotation still open after {CLOSE_WAIT_CAP:?}");
                    }
                }
                // `destroy`, not `close`: no second CloseRequested to answer.
                let _ = window.destroy();
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    #[test]
    fn nothing_open_closes_at_once() {
        let hold = RotationHold::default();
        assert_eq!(hold.defer_close(), CloseDecision::CloseNow);
    }

    #[test]
    fn an_open_rotation_defers_the_close_and_the_wait_ends_when_it_does() {
        // The window-close-during-a-slow-refresh case: the response is still
        // on its way when the close arrives; the close must outlive it.
        let hold = Arc::new(RotationHold::default());
        hold.begin();
        assert_eq!(hold.defer_close(), CloseDecision::Wait);
        assert_eq!(hold.defer_close(), CloseDecision::AlreadyWaiting);

        let rotation = {
            let hold = hold.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(150)); // server + keychain
                hold.end();
            })
        };
        let started = Instant::now();
        assert!(
            hold.wait_idle(Duration::from_secs(5)),
            "the rotation ended first"
        );
        let waited = started.elapsed();
        assert!(
            waited >= Duration::from_millis(140),
            "returned before the rotation ended: {waited:?}"
        );
        assert!(
            waited < Duration::from_secs(2),
            "held past the rotation's end: {waited:?}"
        );
        rotation.join().unwrap();
    }

    #[test]
    fn a_rotation_that_never_ends_is_cut_off_at_the_cap() {
        let hold = RotationHold::default();
        hold.begin();
        let started = Instant::now();
        assert!(!hold.wait_idle(Duration::from_millis(100)));
        assert!(started.elapsed() >= Duration::from_millis(95));
    }

    #[test]
    fn overlapping_rotations_hold_until_the_last_one_ends() {
        let hold = RotationHold::default();
        hold.begin();
        hold.begin();
        hold.end();
        assert!(
            !hold.wait_idle(Duration::from_millis(30)),
            "one is still open"
        );
        hold.end();
        assert!(hold.wait_idle(Duration::from_millis(30)));
    }

    #[test]
    fn an_end_without_a_begin_does_not_underflow() {
        let hold = RotationHold::default();
        hold.end();
        hold.begin();
        assert_eq!(
            hold.defer_close(),
            CloseDecision::Wait,
            "the begin still counts"
        );
    }

    #[test]
    fn a_reload_releases_rotations_that_can_no_longer_end() {
        let hold = RotationHold::default();
        hold.begin();
        hold.reset();
        assert!(hold.wait_idle(Duration::from_millis(10)));
        assert_eq!(hold.defer_close(), CloseDecision::CloseNow);
    }

    /// #3106: a reload ends the webview's rotations, not the shell's POST.
    /// Sabotage: clear `shell_open` in `reset` and the close below destroys
    /// the window with the shell's rotation still in the air — RED.
    #[test]
    fn a_reload_does_not_release_the_shells_own_rotation() {
        let hold = RotationHold::default();
        let shell = hold.shell_rotation();
        hold.begin();
        hold.reset();
        assert_eq!(hold.defer_close(), CloseDecision::Wait);
        assert!(
            !hold.wait_idle(Duration::from_millis(20)),
            "the shell's rotation is open"
        );
        drop(shell);
        assert!(hold.wait_idle(Duration::from_millis(20)));
    }

    #[test]
    fn the_cap_covers_the_shells_own_rotation() {
        let bound = crate::session_refresh::REFRESH_REQUEST_TIMEOUT;
        assert!(CLOSE_WAIT_CAP >= bound, "{CLOSE_WAIT_CAP:?} < {bound:?}");
    }

    #[test]
    fn the_cap_covers_the_cores_own_bound_on_one_rotation() {
        // REQUEST_TIMEOUT_MS (15 s) + KEYCHAIN_WAIT_MS (5 s). If either grows,
        // this cap would cut off a rotation the core is still waiting for.
        let core = include_str!("../../../../packages/momo-core/src/lib/http.ts");
        let web = include_str!("../../../web/src/lib/session.ts");
        let ms = |src: &str, name: &str| -> u64 {
            let line = src
                .lines()
                .find(|l| l.contains(&format!("{name} =")))
                .unwrap_or_else(|| panic!("{name} not found"));
            line.split('=')
                .nth(1)
                .unwrap()
                .trim()
                .trim_end_matches(';')
                .replace('_', "")
                .parse()
                .unwrap()
        };
        let bound = ms(core, "REQUEST_TIMEOUT_MS") + ms(web, "KEYCHAIN_WAIT_MS");
        assert!(
            CLOSE_WAIT_CAP >= Duration::from_millis(bound),
            "{CLOSE_WAIT_CAP:?} < {bound} ms"
        );
    }
}
