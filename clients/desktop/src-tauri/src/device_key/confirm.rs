//! The native confirmation before every signature (ADR-0146 개정 「위험과
//! 미검증」: 웹뷰 XSS와 데스크탑 서명).
//!
//! A script in the webview can call the sign commands; inside the Touch ID
//! reuse window nothing else would stop it. So the shell shows an `NSAlert` —
//! drawn by AppKit, outside the webview, unreachable from page script — with
//! the text [`super::payload::Statement::summary`] built from the very
//! statement it is about to sign.
//!
//! When the statement carries free text (an instruction, a first prompt),
//! the whole text sits in a read-only scrolling view under the body, so every
//! signed character is on screen, not only its first line.
//!
//! **A click in the first moment does not count.** A script can raise the
//! dialog under a pointer that is about to click; a confirm that lands within
//! [`MIN_VISIBLE`] of the dialog appearing shows the dialog again instead.
//!
//! **No key confirms.** A dialog a script raises while the person is typing
//! must not be accepted by the Return key they were about to press: 취소 is
//! the first button and answers Escape, the confirm button has no key
//! equivalent, so confirming takes a deliberate click.

use std::sync::mpsc;
use std::time::{Duration, Instant};

use objc2::{MainThreadMarker, MainThreadOnly as _};
use objc2_app_kit::{
    NSAlert, NSAlertSecondButtonReturn, NSAlertStyle, NSApplication, NSScrollView, NSTextView,
};
use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

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

/// How long the dialog must have been on screen before a confirm counts.
pub const MIN_VISIBLE: Duration = Duration::from_millis(700);

/// Whether a confirm that came `after` the dialog appeared is a deliberate one.
pub fn counts(after: Duration) -> bool {
    after >= MIN_VISIBLE
}

fn run_alert(summary: &Summary) -> bool {
    let Some(mtm) = MainThreadMarker::new() else {
        return false;
    };
    // Bounded: a person who keeps clicking instantly still gets an answer.
    for _ in 0..5 {
        let shown = Instant::now();
        let confirmed = show_once(mtm, summary);
        if !confirmed {
            return false;
        }
        if counts(shown.elapsed()) {
            return true;
        }
    }
    false
}

fn full_text_view(mtm: MainThreadMarker, text: &str) -> objc2::rc::Retained<NSScrollView> {
    let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(420.0, 160.0));
    let scroll = NSScrollView::initWithFrame(NSScrollView::alloc(mtm), frame);
    scroll.setHasVerticalScroller(true);
    scroll.setBorderType(objc2_app_kit::NSBorderType::BezelBorder);
    let view = NSTextView::initWithFrame(NSTextView::alloc(mtm), frame);
    view.setString(&NSString::from_str(text));
    view.setEditable(false);
    view.setSelectable(true);
    scroll.setDocumentView(Some(&view));
    scroll
}

fn show_once(mtm: MainThreadMarker, summary: &Summary) -> bool {
    let alert = NSAlert::new(mtm);
    alert.setAlertStyle(NSAlertStyle::Warning);
    alert.setMessageText(&NSString::from_str(&summary.title));
    alert.setInformativeText(&NSString::from_str(&summary.body));
    // Cancel first, bound to Escape; the confirm button answers no key.
    let cancel = alert.addButtonWithTitle(&NSString::from_str("취소"));
    cancel.setKeyEquivalent(&NSString::from_str("\u{1b}"));
    let confirm = alert.addButtonWithTitle(&NSString::from_str(&summary.confirm));
    confirm.setKeyEquivalent(&NSString::from_str(""));
    if let Some(text) = &summary.full_text {
        let view = full_text_view(mtm, text);
        alert.setAccessoryView(Some(&view));
    }
    let app = NSApplication::sharedApplication(mtm);
    #[allow(deprecated)]
    app.activateIgnoringOtherApps(true);
    alert.runModal() == NSAlertSecondButtonReturn
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_confirm_in_the_first_moment_does_not_count() {
        assert!(!counts(Duration::from_millis(0)));
        assert!(!counts(Duration::from_millis(699)));
        assert!(counts(Duration::from_millis(700)));
    }
}
