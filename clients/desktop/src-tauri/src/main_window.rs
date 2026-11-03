// The main window's way back and way out (#5195 · #5196, ADR-0133 B-group).
//
// Until now the red button (and Cmd+W) ended the app: the only window closed, tauri exited. With the
// menu-bar icon up (#5193) the app has somewhere to live without a window, so the button only puts the
// window away and the app stays — it keeps its realtime connection, so mentions still arrive as banners,
// and the Dock badge and the menu-bar dot keep following. Quitting is the menu's 「oort 종료」 (the
// tray's) and Cmd+Q: AppKit `terminate:`, which never asks the window anything and so never reaches this
// file (`rotation_hold.rs` says what that path does and does not wait for).
//
// Everything that decides what a close means is `decide_close`, called from one place, `on_close_requested`.
// `rotation_hold.rs` no longer has a `CloseRequested` handler of its own: it is the state a close may have to
// wait for, and `hide_then_destroy_after_rotation` is what it does when the close really ends the app.
//
//   the red button / Cmd+W
//     the app can stay (the menu-bar icon is up AND the page's app shell is up: someone is signed in)
//       fullscreen            leave fullscreen, keep the window (hiding a fullscreen window would leave an
//                             empty Space behind; a second press then puts the window away)
//       otherwise             hide the window, keep the app, tell the page once (`window-hidden`)
//     nothing to stay for (not signed in, no icon yet, another OS than macOS)
//       no rotation open      close and exit, as it always did
//       a rotation open       hide at once, destroy when the rotation ends or the cap passes (#3098)
//       a close is waiting    swallow this one
//
// A refresh rotation needs no wait while the app stays: the page is alive (only hidden), so its request
// and its keychain write finish by themselves. That is why the staying branch never touches the hold.
//
// Ways back in (the window is only hidden, the app is running): the tray's 「oort 열기」 and every other
// tray pick that needs the page, the Dock icon (a Reopen), a clicked banner, an invite link. All of them
// are `bring_forward`.
//
// `runtime-unverified`: what AppKit does with the window (the order-out, the Dock reopen, the Space), whether
// WebKit keeps a hidden page's socket and timers lively enough for banners, and the banner click. The tests
// measure the decisions and, through tauri's mock runtime, that a close request really is answered the way
// `decide_close` says.

use tauri::{AppHandle, CloseRequestApi, Emitter, Manager, Runtime, Window, WindowEvent};

use crate::rotation_hold::{self, CloseDecision, RotationHold};
use crate::tray::{TrayAction, TrayState, TRAY_ACTION_EVENT};

#[cfg(test)]
thread_local! {
    /// How many times this thread brought the window forward. Tests read it: a mock window cannot say
    /// whether it was shown, but "was it asked to be" is the decision under test.
    static FORWARDED: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

#[cfg(test)]
pub fn forwarded() -> u32 {
    FORWARDED.with(|count| count.get())
}

/// The main window to the front: shown, un-minimized, focused, and the app un-hidden (Cmd+H). Safe to
/// call when it is already in front.
pub fn bring_forward<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(test)]
    FORWARDED.with(|count| count.set(count.get() + 1));
    #[cfg(target_os = "macos")]
    let _ = app.show();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// What the red button / Cmd+W does with this request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseAction {
    /// Hide the window; the app stays and the page is told.
    HideAndStay,
    /// The app stays, but this window is fullscreen: leave fullscreen and keep the window.
    LeaveFullscreen,
    /// Let it close; the last window going ends the app.
    CloseNow,
    /// Hide now and destroy the window when the open refresh rotation ends (#3098).
    HideThenEnd,
    /// A deferred close is already waiting: ignore this one.
    Swallow,
}

/// The one table. `stays`: the app has somewhere to live without a window (`TrayState::keeps_app_running`).
/// `fullscreen`: the window is fullscreen now. `rotation` is asked **only** when the app does not stay,
/// because asking is not free: `RotationHold::defer_close` marks a deferred close as running.
pub fn decide_close(
    stays: bool,
    fullscreen: bool,
    rotation: impl FnOnce() -> CloseDecision,
) -> CloseAction {
    if stays {
        return if fullscreen {
            CloseAction::LeaveFullscreen
        } else {
            CloseAction::HideAndStay
        };
    }
    match rotation() {
        CloseDecision::CloseNow => CloseAction::CloseNow,
        CloseDecision::Wait => CloseAction::HideThenEnd,
        CloseDecision::AlreadyWaiting => CloseAction::Swallow,
    }
}

/// `on_window_event` for the whole app. Only the main window's close request is ours.
pub fn on_window_event<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        if window.label() == "main" {
            on_close_requested(window, api);
        }
    }
}

fn on_close_requested<R: Runtime>(window: &Window<R>, api: &CloseRequestApi) {
    let app = window.app_handle();
    let stays = app
        .try_state::<TrayState>()
        .is_some_and(|tray| tray.keeps_app_running());
    // A window that cannot say is not fullscreen: the worst that costs is the plain hide below.
    let fullscreen = window.is_fullscreen().unwrap_or(false);
    let action = decide_close(stays, fullscreen, || {
        match window.try_state::<RotationHold>() {
            Some(hold) => hold.defer_close(),
            None => CloseDecision::CloseNow,
        }
    });
    match action {
        CloseAction::HideAndStay => {
            // Hide first. A window that cannot be hidden must not be kept alive and visible by a close
            // that was swallowed: let the close go through, as it always did.
            if window.hide().is_ok() {
                api.prevent_close();
                tell_page_window_hidden(app);
            }
        }
        CloseAction::LeaveFullscreen => {
            api.prevent_close();
            let _ = window.set_fullscreen(false);
        }
        CloseAction::CloseNow => {}
        CloseAction::Swallow => api.prevent_close(),
        CloseAction::HideThenEnd => rotation_hold::hide_then_destroy_after_rotation(window, api),
    }
}

/// Tells the page the window was put away into the menu bar, so it can say so once (the first time the
/// person closes the window). The same event the tray's picks use: the page has one listener for what the
/// menu-bar side tells it.
fn tell_page_window_hidden<R: Runtime>(app: &AppHandle<R>) {
    if let Err(error) = app.emit(TRAY_ACTION_EVENT, &TrayAction::WindowHidden) {
        eprintln!("[oort] window-hidden not delivered: {error}");
    }
}

/// A click on the Dock icon (macOS `Reopen`). When some window is already visible AppKit does the rest;
/// when none is (the window is put away or minimized) it is ours to bring back.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn on_reopen<R: Runtime>(app: &AppHandle<R>, has_visible_windows: bool) {
    if reopen_needs_window(has_visible_windows) {
        bring_forward(app);
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn reopen_needs_window(has_visible_windows: bool) -> bool {
    !has_visible_windows
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::rc::Rc;
    use std::sync::mpsc;
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::{Listener, RunEvent};

    // ---- the table ----

    /// What the hold would answer, written as a plain function so a table can name it.
    type Hold = Option<fn() -> CloseDecision>;

    #[test]
    fn the_red_button_decides_by_whether_the_app_can_stay_and_then_by_the_rotation() {
        use CloseAction::*;
        // (the app stays, the window is fullscreen, what the hold would answer) -> what happens
        let table: [(bool, bool, Hold, CloseAction); 7] = [
            // The app stays: the window goes away, a fullscreen one only leaves fullscreen first. The
            // rotation is not asked (`None` panics if it is): the page stays alive, nothing to wait for.
            (true, false, None, HideAndStay),
            (true, true, None, LeaveFullscreen),
            // Nothing to stay for: the close is the one it always was.
            (false, false, Some(|| CloseDecision::CloseNow), CloseNow),
            (false, false, Some(|| CloseDecision::Wait), HideThenEnd),
            (
                false,
                false,
                Some(|| CloseDecision::AlreadyWaiting),
                Swallow,
            ),
            // Fullscreen only matters while the app stays.
            (false, true, Some(|| CloseDecision::CloseNow), CloseNow),
            (false, true, Some(|| CloseDecision::Wait), HideThenEnd),
        ];
        for (stays, fullscreen, hold, want) in table {
            let got = decide_close(stays, fullscreen, || match hold {
                Some(ask) => ask(),
                None => panic!("the rotation hold was asked while the app stays"),
            });
            assert_eq!(got, want, "stays={stays} fullscreen={fullscreen}");
        }
    }

    #[test]
    fn the_dock_icon_brings_the_window_back_only_when_none_is_visible() {
        let app = tauri::test::mock_app();
        let before = forwarded();
        on_reopen(app.handle(), true);
        assert_eq!(forwarded(), before, "a window is already visible");
        on_reopen(app.handle(), false);
        assert_eq!(forwarded(), before + 1, "none is: bring it back");
    }

    // ---- a close request, answered by tauri's mock runtime ----
    //
    // The mock runtime has two quirks the helper below works around. A `close()` before the loop runs only
    // removes the window (no `CloseRequested` is sent), so the button is pressed from `Ready`, once the
    // loop is up. And the mock never calls the closures given to `Builder::on_window_event` (its
    // `on_window_event` is a stub), so the loop's callback hands the close request to `on_window_event`
    // itself — the same function `lib.rs` installs — with the real `CloseRequestApi` tauri built for it.

    /// A mock app with the main window up, and the tray's answer to "can the app stay" set by hand (the
    /// real answer needs a status item).
    fn app_with_main_window(staying: bool) -> tauri::App<MockRuntime> {
        let app = mock_builder()
            .manage(TrayState::default())
            .manage(RotationHold::default())
            .build(mock_context(noop_assets()))
            .unwrap();
        app.state::<TrayState>().set_staying_for_test(staying);
        tauri::WebviewWindowBuilder::new(&app, "main", tauri::WebviewUrl::default())
            .build()
            .unwrap();
        app
    }

    #[derive(Default, Debug)]
    struct Run {
        /// For each pass of the loop after the close: was the main window still there?
        window_after_each_pass: Vec<bool>,
        exit_requested: bool,
    }

    /// Presses the red button and runs tauri's mock loop. The loop ends by itself only when the last
    /// window is gone, so `give_up_after` passes later the window is taken down by hand: a window that
    /// was never going to leave still ends the test, as a failed assertion and not as a hang.
    /// `on_first_pass` runs once the close request has been answered.
    fn press_red_button(
        app: tauri::App<MockRuntime>,
        give_up_after: usize,
        on_first_pass: impl FnOnce(&tauri::AppHandle<MockRuntime>) + 'static,
    ) -> Run {
        let seen = Rc::new(RefCell::new(Run::default()));
        let record = seen.clone();
        let mut first = Some(on_first_pass);
        app.run(move |handle, event| match event {
            RunEvent::Ready => handle.get_webview_window("main").unwrap().close().unwrap(),
            RunEvent::WindowEvent { label, event, .. } => {
                // `Manager::get_window` is behind tauri's `unstable` feature; the window under the webview
                // window is the same one.
                if let Some(window) = handle
                    .get_webview_window(&label)
                    .map(|webview_window| webview_window.as_ref().window())
                {
                    on_window_event(&window, &event);
                }
            }
            RunEvent::ExitRequested { .. } => record.borrow_mut().exit_requested = true,
            RunEvent::MainEventsCleared => {
                let window = handle.get_webview_window("main");
                let passes = {
                    let mut run = record.borrow_mut();
                    run.window_after_each_pass.push(window.is_some());
                    run.window_after_each_pass.len()
                };
                if let Some(first) = first.take() {
                    first(handle);
                }
                if passes >= give_up_after {
                    if let Some(window) = window {
                        let _ = window.destroy();
                    }
                }
            }
            _ => {}
        });
        Rc::try_unwrap(seen).unwrap().into_inner()
    }

    /// Everything the shell tells the page on the tray's channel, parsed.
    fn page_hears(app: &tauri::App<MockRuntime>) -> mpsc::Receiver<serde_json::Value> {
        let (tx, rx) = mpsc::channel();
        app.listen_any(TRAY_ACTION_EVENT, move |event| {
            tx.send(serde_json::from_str(event.payload()).unwrap())
                .unwrap();
        });
        rx
    }

    /// The app stays: the red button does not end it (the window is only put away), the page is told
    /// exactly once, and the rotation hold is left alone — a later close that does end the app still waits
    /// for the rotation that was open the whole time.
    #[test]
    fn the_red_button_keeps_the_app_running_while_it_has_somewhere_to_stay() {
        let app = app_with_main_window(true);
        app.state::<RotationHold>().begin();
        let heard = page_hears(&app);
        let run = press_red_button(app, 1, |handle| {
            let hold = handle.state::<RotationHold>();
            assert_eq!(
                hold.defer_close(),
                CloseDecision::Wait,
                "the staying close marked a deferred close as running"
            );
        });
        assert_eq!(run.window_after_each_pass, [true], "the window was closed");
        let wait = std::time::Duration::from_secs(5);
        assert_eq!(
            heard.recv_timeout(wait).unwrap(),
            serde_json::json!({ "action": "window-hidden" })
        );
        assert!(heard
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
    }

    /// Nothing to stay for (not signed in, no icon): the close ends the app as it always did.
    #[test]
    fn the_red_button_still_ends_the_app_when_nothing_keeps_it() {
        let app = app_with_main_window(false);
        let heard = page_hears(&app);
        let run = press_red_button(app, 3, |_| {});
        assert!(run.window_after_each_pass.is_empty(), "{run:?}");
        assert!(
            run.exit_requested,
            "the last window went and the app did not exit"
        );
        assert!(heard
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
    }

    /// Nothing to stay for and a refresh rotation open: the old guarantee (#3098). The window is put away
    /// at once, stays until the rotation ends, and only then goes — which ends the app.
    #[test]
    fn a_close_that_ends_the_app_still_waits_for_an_open_rotation() {
        let app = app_with_main_window(false);
        app.state::<RotationHold>().begin();
        let run = press_red_button(app, 3, |handle| handle.state::<RotationHold>().end());
        assert_eq!(
            run.window_after_each_pass,
            [true],
            "the window must outlive the close request while the rotation is open, and be gone right after it ends"
        );
        assert!(run.exit_requested);
    }
}
