//! The native confirmation before every signature (ADR-0146 개정 「위험과
//! 미검증」: 웹뷰 XSS와 데스크탑 서명).
//!
//! A script in the webview can call the sign commands; inside the Touch ID
//! reuse window nothing else would stop it. So the shell shows an `NSAlert` —
//! drawn by AppKit, outside the webview, unreachable from page script — with
//! the text [`super::payload::Statement::summary`] built from the very
//! statement it is about to sign.
//!
//! **No key confirms.** A dialog a script raises while the person is typing
//! must not be accepted by the Return key they were about to press: 취소 is
//! the first button and answers Escape, the confirm button has no key
//! equivalent, so confirming takes a deliberate click.

use std::sync::mpsc;

use objc2::MainThreadMarker;
use objc2_app_kit::{NSAlert, NSAlertSecondButtonReturn, NSAlertStyle, NSApplication};
use objc2_foundation::NSString;

use super::payload::Summary;

/// Ask on the main thread and wait. Must not be called from the main thread
/// (the signing worker calls it). Anything but an explicit confirm is "no".
pub fn ask(app: &tauri::AppHandle, summary: Summary) -> bool {
    let (tx, rx) = mpsc::channel();
    let posted = app.run_on_main_thread(move || {
        let _ = tx.send(run_alert(&summary));
    });
    if posted.is_err() {
        return false;
    }
    rx.recv().unwrap_or(false)
}

fn run_alert(summary: &Summary) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str(&summary.title));
    alert.setInformativeText(&NSString::from_str(&summary.body));
    // Cancel first, bound to Escape; the confirm button answers no key.
    let cancel = alert.addButtonWithTitle(&NSString::from_str("취소"));
    cancel.setKeyEquivalent(&NSString::from_str("\u{1b}"));
    let confirm = alert.addButtonWithTitle(&NSString::from_str(&summary.confirm));
    confirm.setKeyEquivalent(&NSString::from_str(""));
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    alert.runModal() == NSAlertSecondButtonReturn
}
