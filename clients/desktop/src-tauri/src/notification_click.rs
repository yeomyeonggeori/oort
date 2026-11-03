// Notification clicks on macOS (#5059, the #4667 follow-up; ADR-0133 P2 B-group).
//
// `notification_show` is fire-and-forget: `tauri-plugin-notification`'s desktop half builds the
// banner, hands it to `mac-notification-sys` asynchronously and drops the handle, so nobody can say
// which banner was clicked. The web layer used to approximate it (arm the destination when the
// banner is shown, consume it on the next window focus, expire after 20 s), and that approximation
// moved people who ignored the banner and simply came back.
//
// This module is the other path: the shell keeps the banner's handle. `mac-notification-sys`'s
// `wait_for_click(true)` makes `send()` block until the person clicks the banner, closes it, or it
// leaves Notification Center, and says which. One named thread per banner waits; on a click it
// emits `momo:notification-click` with the `{ id, target }` the web layer gave at show time. A
// dismissed banner emits nothing, which is the whole point.
//
// The event is a global emit (`emit_click`), the same call `momo:deep-link`, `momo:discovery` and
// `momo:update-progress` use, heard by the page through `@tauri-apps/api/event`'s default
// listener (target `Any`). A labelled `emit_to("main", …)` would reach it too (tauri 2.11.5
// `event/listener.rs` `match_any_or_filter`: an `Any` listener matches every filter), so naming
// the window buys nothing; who may act on the payload is decided by the page, below.
//
// What is and is not trusted:
//   * `target` is an opaque app route the web layer built. This module only checks its SHAPE (an
//     absolute app path, bounded, no scheme, no control characters) because it holds the string for
//     as long as the banner waits. Whether it is a destination the app really made is the web
//     layer's call: it matches `id` and `target` against its own record of shown banners and
//     ignores everything else, so the payload is never used as a route as it arrives.
//   * Nothing here reads, logs or stores the banner's title or body beyond the thread's own copy.
//
// Costs, written down because they are the reason for the cap below:
//   * A blocked `send()` cannot be cancelled from outside (the crate's pending table is private);
//     only a click, a close or the banner leaving Notification Center ends it. A banner nobody
//     touches keeps its thread, and a repeating 0.5 s timer on the main run loop that reads
//     Notification Center's delivered list (an IPC call to the notification daemon), until then.
//     So the number of waits is bounded and a banner past the bound is a plain one — it still
//     shows, it just cannot report a click (`notification_show_clickable` says `plain`).
//   * The library needs the main run loop to be turning (it is: the window runs on it) and adds
//     its timer to it from this thread. `runtime-unverified` on a real notification click.

use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, LazyLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

/// Emitted when a banner this shell is waiting on is clicked.
///
/// A Tauri IPC channel name like `momo:deep-link`, kept under the old `momo:` prefix on purpose:
/// renaming it would have to happen in lockstep in `lib/tauri.ts` for no one's benefit. Every
/// window hears it; only the main window's capability lets a page listen, and the page matches
/// the payload against its own record of shown banners before it does anything with it.
pub const NOTIFICATION_CLICK_EVENT: &str = "momo:notification-click";

/// How many banners may wait for a click at once.
///
/// Small on purpose, and the first thing to adjust once it has been measured on a real Mac. Each
/// wait is a thread plus a repeating 0.5 s timer on the MAIN run loop that reads Notification
/// Center's delivered list, and a banner that has left the screen but sits unread in the list
/// keeps both until it is clicked or cleared. Eight waits is at most ~16 reads a second on the
/// main thread; 64 would be ~128. Past the limit a new banner is shown plain and the web layer
/// falls back to the old focus guess for it, so a person with a long unread list loses nothing
/// they had before. Unmeasured (`runtime-unverified`): see the stack-verification note in the
/// #5059 handoff.
pub const MAX_PENDING_CLICKS: usize = 8;

const MAX_ID_BYTES: usize = 64;
const MAX_TARGET_BYTES: usize = 512;

/// What the web layer is told when a banner is clicked.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationClick {
    /// The id the web layer minted when it showed the banner.
    pub id: String,
    /// The route the web layer asked the banner to open, echoed back unchanged.
    pub target: String,
}

/// Checks the shape of a click request. `None` means "show this banner plain": a malformed request
/// must not cost the person the banner, and the web layer only ever sends well-formed ones.
pub fn parse_click(id: String, target: String) -> Option<NotificationClick> {
    let id_ok = !id.is_empty()
        && id.len() <= MAX_ID_BYTES
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    (id_ok && is_app_route(&target)).then_some(NotificationClick { id, target })
}

/// An absolute path inside the app: starts with one `/`, no scheme, no `//` host form, no
/// backslash, no control character, bounded.
fn is_app_route(target: &str) -> bool {
    target.len() <= MAX_TARGET_BYTES
        && target.starts_with('/')
        && !target.starts_with("//")
        && !target.contains('\\')
        && !target.chars().any(char::is_control)
}

/// A count of banners that are waiting, with a ceiling.
pub struct ClickWaits {
    cap: usize,
    active: AtomicUsize,
}

impl ClickWaits {
    pub const fn new(cap: usize) -> Self {
        Self {
            cap,
            active: AtomicUsize::new(0),
        }
    }

    /// A place to wait, or `None` at the ceiling. Never blocks and holds no lock: the slot is a
    /// counter increment that its drop undoes.
    pub fn try_acquire(self: &Arc<Self>) -> Option<ClickSlot> {
        let mut seen = self.active.load(Ordering::Acquire);
        loop {
            if seen >= self.cap {
                return None;
            }
            match self.active.compare_exchange_weak(
                seen,
                seen + 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    return Some(ClickSlot {
                        waits: Arc::clone(self),
                    })
                }
                Err(now) => seen = now,
            }
        }
    }

    /// How many places are taken right now. Tests read it; nothing in the shell needs to.
    #[cfg(test)]
    pub fn active(&self) -> usize {
        self.active.load(Ordering::Acquire)
    }
}

/// One waiting banner's place. Released when dropped, which for a wait is when its thread ends
/// (by return or by panic) or when the thread could not be started at all.
pub struct ClickSlot {
    waits: Arc<ClickWaits>,
}

impl Drop for ClickSlot {
    fn drop(&mut self) {
        self.waits.active.fetch_sub(1, Ordering::AcqRel);
    }
}

/// How a banner's wait ended, as far as this module cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waited {
    /// The person clicked the banner itself.
    Click,
    /// Closed, cleared from Notification Center, or gone: nothing to report.
    Dismissed,
    /// Nothing was shown. Only reachable if the library refuses to send.
    Failed,
}

/// The work of one wait, handed to whatever starts the thread.
pub type Job = Box<dyn FnOnce() + Send + 'static>;

/// Starts the wait for one banner, or says it could not.
///
/// `true` means the wait owns the banner: the caller must NOT also show it. `false` means nothing
/// was started and no slot is held, so the caller shows a plain banner. The three closures and the
/// spawner are parameters so the rules (a click emits once with its target, a dismissal emits
/// nothing, a failed send falls back to a plain banner, the slot is held for the whole wait and
/// released however the thread ends) are tested without a notification centre: no test may call
/// the real `send()`, which posts a real banner and blocks until somebody clicks it.
pub fn take_over<S, E, F, SP>(
    waits: &Arc<ClickWaits>,
    click: NotificationClick,
    send: S,
    emit: E,
    fallback: F,
    spawn: SP,
) -> bool
where
    S: FnOnce() -> Waited + Send + 'static,
    E: FnOnce(NotificationClick) + Send + 'static,
    F: FnOnce() + Send + 'static,
    SP: FnOnce(Job) -> io::Result<()>,
{
    let Some(slot) = waits.try_acquire() else {
        return false;
    };
    let job = Box::new(move || {
        // Held until this closure ends, however it ends.
        let _slot = slot;
        match send() {
            Waited::Click => emit(click),
            Waited::Dismissed => {}
            Waited::Failed => fallback(),
        }
    });
    // A spawner that fails drops the job, and the slot with it.
    spawn(job).is_ok()
}

/// The real spawner: a named thread, detached. Never the main thread (a sync command runs there,
/// and the library would nest a run loop inside the window's) and never an async worker (it
/// blocks for as long as the banner sits unread).
pub fn spawn_named(job: Job) -> io::Result<()> {
    std::thread::Builder::new()
        .name("oort-notification-click".into())
        .spawn(job)
        .map(drop)
}

/// Tells the page a banner was clicked. See the header for why this is a global emit.
pub fn emit_click<R: Runtime>(app: &AppHandle<R>, click: &NotificationClick) -> tauri::Result<()> {
    app.emit(NOTIFICATION_CLICK_EVENT, click)
}

/// A banner this shell waits on was clicked: bring the window back first — since #5196 the red button only
/// puts it away, and a click on a mention's banner that opens nothing would be a banner that lies — then
/// tell the page where to go.
pub fn deliver_click<R: Runtime>(app: &AppHandle<R>, click: &NotificationClick) {
    crate::main_window::bring_forward(app);
    if let Err(error) = emit_click(app, click) {
        eprintln!("[oort] notification click not delivered: {error}");
    }
}

/// The bundle a banner is attributed to. The same choice the plugin makes for a plain banner:
/// a dev run has no bundle of its own, so macOS is told it is Terminal.
pub fn application_identity(is_dev: bool, identifier: &str) -> &str {
    if is_dev {
        "com.apple.Terminal"
    } else {
        identifier
    }
}

/// The wait itself: shows the banner and blocks until it is clicked, closed or gone. **Posts a
/// real notification.** Only `show_with_click` reaches it.
fn wait_for_click(title: &str, body: &str) -> Waited {
    use mac_notification_sys::{Notification, NotificationResponse};

    let mut notification = Notification::new();
    notification.title(title).message(body).wait_for_click(true);
    match notification.send() {
        Ok(NotificationResponse::Click) => Waited::Click,
        // Close button, reply and action button are not offered; `None` is a banner that
        // disappeared without being touched.
        Ok(_) => Waited::Dismissed,
        Err(_) => Waited::Failed,
    }
}

static WAITS: LazyLock<Arc<ClickWaits>> =
    LazyLock::new(|| Arc::new(ClickWaits::new(MAX_PENDING_CLICKS)));

/// Shows `title`/`body` as a banner whose click is reported, if a wait can be started. `false`
/// means the caller shows it plain.
pub fn show_with_click<R: Runtime>(
    app: &AppHandle<R>,
    title: String,
    body: Option<String>,
    click: NotificationClick,
) -> bool {
    // Attribution first and synchronously, exactly as the plugin does for a plain banner. The
    // library's own default (a lookup of an app named "use_default", then Finder) would otherwise
    // claim the process-wide slot, and `set_application` can be called once. After this call
    // `send()` has no way left to fail for lack of an application.
    let _ = mac_notification_sys::set_application(application_identity(
        tauri::is_dev(),
        &app.config().identifier,
    ));

    let body = body.unwrap_or_default();
    let (fallback_app, fallback_title, fallback_body) = (app.clone(), title.clone(), body.clone());
    let emitter = app.clone();
    take_over(
        &WAITS,
        click,
        move || wait_for_click(&title, &body),
        move |click| deliver_click(&emitter, &click),
        move || {
            let _ =
                crate::notification::show_plain(&fallback_app, fallback_title, Some(fallback_body));
        },
        spawn_named,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::sync::Mutex;
    use std::thread::JoinHandle;

    fn click() -> NotificationClick {
        NotificationClick {
            id: "n-abc123-1".into(),
            target: "/c/00000000-0000-7000-8000-00000000020a?msg=ab".into(),
        }
    }

    type Handles = mpsc::Receiver<JoinHandle<()>>;

    /// A spawner that runs the job on a real thread and hands its handle back for joining.
    fn threaded() -> (impl FnOnce(Job) -> io::Result<()>, Handles) {
        let (handles, rx) = mpsc::channel();
        let spawn = move |job: Job| {
            let _ = handles.send(std::thread::spawn(job));
            Ok(())
        };
        (spawn, rx)
    }

    /// A clicked banner brings the window back (it may be put away, #5196) and tells the page once,
    /// with the id and route the page gave.
    #[test]
    fn a_clicked_banner_brings_the_window_back_and_reaches_the_page_once() {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen_any(NOTIFICATION_CLICK_EVENT, move |event| {
            tx.send(event.payload().to_owned()).unwrap();
        });
        let before = crate::main_window::forwarded();
        deliver_click(app.handle(), &click());
        assert_eq!(crate::main_window::forwarded(), before + 1);
        let got: serde_json::Value =
            serde_json::from_str(&rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap())
                .unwrap();
        assert_eq!(
            got,
            serde_json::json!({
                "id": "n-abc123-1",
                "target": "/c/00000000-0000-7000-8000-00000000020a?msg=ab"
            })
        );
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
    }

    // ---- shape of the request ------------------------------------------------

    #[test]
    fn accepts_the_routes_the_web_layer_builds() {
        for target in [
            "/c/00000000-0000-7000-8000-00000000020a",
            "/c/00000000-0000-7000-8000-00000000020a?msg=019f96a4",
            "/c/00000000-0000-7000-8000-00000000020a?msg=019f96a4&thread=00000000-0000-7000-8000-000000000311",
            "/inbox?filter=mentions",
        ] {
            let parsed = parse_click("n-abc123-1".into(), target.into());
            assert_eq!(
                parsed,
                Some(NotificationClick {
                    id: "n-abc123-1".into(),
                    target: target.into(),
                }),
                "{target}"
            );
        }
    }

    #[test]
    fn refuses_a_target_that_is_not_an_app_path() {
        let long = format!("/{}", "a".repeat(MAX_TARGET_BYTES));
        for target in [
            "",
            "c/abc",
            "//evil.example/c/abc",
            "https://evil.example/c/abc",
            "javascript:alert(1)",
            "/\\evil.example",
            "/c/abc\n",
            "/c/ab\u{0}c",
            long.as_str(),
        ] {
            assert_eq!(
                parse_click("n-abc123-1".into(), target.into()),
                None,
                "{target:?}"
            );
        }
        // The bound is on bytes, and the longest accepted target sits exactly on it.
        let edge = format!("/{}", "a".repeat(MAX_TARGET_BYTES - 1));
        assert!(parse_click("n-abc123-1".into(), edge).is_some());
    }

    #[test]
    fn refuses_an_id_that_is_not_a_plain_token() {
        let long = "a".repeat(MAX_ID_BYTES + 1);
        for id in [
            "",
            "has space",
            "with/slash",
            "한글",
            "tab\t",
            long.as_str(),
        ] {
            assert_eq!(parse_click(id.into(), "/c/abc".into()), None, "{id:?}");
        }
        assert!(parse_click("a".repeat(MAX_ID_BYTES), "/c/abc".into()).is_some());
    }

    #[test]
    fn the_event_carries_exactly_id_and_target() {
        assert_eq!(
            serde_json::to_value(click()).unwrap(),
            serde_json::json!({
                "id": "n-abc123-1",
                "target": "/c/00000000-0000-7000-8000-00000000020a?msg=ab",
            })
        );
        assert_eq!(NOTIFICATION_CLICK_EVENT, "momo:notification-click");
    }

    #[test]
    fn a_dev_run_is_terminal_and_a_bundle_is_itself() {
        assert_eq!(
            application_identity(true, "app.momo.desktop"),
            "com.apple.Terminal"
        );
        assert_eq!(
            application_identity(false, "app.momo.desktop"),
            "app.momo.desktop"
        );
    }

    // ---- the ceiling ---------------------------------------------------------

    #[test]
    fn slots_stop_at_the_ceiling_and_come_back_when_dropped() {
        let waits = Arc::new(ClickWaits::new(2));
        let first = waits.try_acquire().expect("first");
        let second = waits.try_acquire().expect("second");
        assert_eq!(waits.active(), 2);
        assert!(
            waits.try_acquire().is_none(),
            "a third wait must be refused"
        );
        drop(first);
        assert_eq!(waits.active(), 1);
        let third = waits.try_acquire().expect("a freed slot is reusable");
        assert!(waits.try_acquire().is_none());
        drop((second, third));
        assert_eq!(waits.active(), 0);
    }

    #[test]
    fn the_shipped_ceiling_is_small() {
        // Written as a number so loosening it is a visible edit (see MAX_PENDING_CLICKS).
        assert_eq!(MAX_PENDING_CLICKS, 8);
    }

    // ---- what a wait does ----------------------------------------------------

    #[test]
    fn a_click_emits_once_with_the_target_and_frees_the_slot() {
        let waits = Arc::new(ClickWaits::new(1));
        let (spawn, handles) = threaded();
        let (emitted, rx) = mpsc::channel();
        let fell_back = Arc::new(Mutex::new(false));
        let flag = Arc::clone(&fell_back);
        let started = take_over(
            &waits,
            click(),
            || Waited::Click,
            move |c| emitted.send(c).unwrap(),
            move || *flag.lock().unwrap() = true,
            spawn,
        );
        assert!(started);
        handles.recv().unwrap().join().unwrap();
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), vec![click()]);
        assert!(!*fell_back.lock().unwrap(), "a click is not a failure");
        assert_eq!(waits.active(), 0);
    }

    #[test]
    fn a_dismissed_banner_emits_nothing_and_shows_nothing_more() {
        let waits = Arc::new(ClickWaits::new(1));
        let (spawn, handles) = threaded();
        let (emitted, rx) = mpsc::channel();
        let fell_back = Arc::new(Mutex::new(false));
        let flag = Arc::clone(&fell_back);
        assert!(take_over(
            &waits,
            click(),
            || Waited::Dismissed,
            move |c| emitted.send(c).unwrap(),
            move || *flag.lock().unwrap() = true,
            spawn,
        ));
        handles.recv().unwrap().join().unwrap();
        assert_eq!(rx.try_iter().count(), 0, "a dismissal must never navigate");
        assert!(!*fell_back.lock().unwrap());
        assert_eq!(waits.active(), 0);
    }

    #[test]
    fn a_failed_send_shows_a_plain_banner_and_emits_nothing() {
        let waits = Arc::new(ClickWaits::new(1));
        let (spawn, handles) = threaded();
        let (emitted, rx) = mpsc::channel();
        let fell_back = Arc::new(Mutex::new(false));
        let flag = Arc::clone(&fell_back);
        assert!(take_over(
            &waits,
            click(),
            || Waited::Failed,
            move |c| emitted.send(c).unwrap(),
            move || *flag.lock().unwrap() = true,
            spawn,
        ));
        handles.recv().unwrap().join().unwrap();
        assert_eq!(rx.try_iter().count(), 0);
        assert!(
            *fell_back.lock().unwrap(),
            "nothing was shown, so a plain banner must be"
        );
        assert_eq!(waits.active(), 0);
    }

    #[test]
    fn the_slot_is_held_for_the_whole_wait() {
        let waits = Arc::new(ClickWaits::new(1));
        let (release, gate) = mpsc::channel::<()>();
        let (spawn, handles) = threaded();
        let (emitted, rx) = mpsc::channel();
        assert!(take_over(
            &waits,
            click(),
            move || {
                gate.recv().unwrap();
                Waited::Click
            },
            move |c| emitted.send(c).unwrap(),
            || {},
            spawn,
        ));
        // Still waiting: the ceiling is in force, so a second banner is not taken over.
        assert_eq!(waits.active(), 1);
        let refused = take_over(
            &waits,
            click(),
            || panic!("a refused wait must never send"),
            |_| panic!("a refused wait must never emit"),
            || panic!("a refused wait must never fall back"),
            |_| panic!("a refused wait must never spawn"),
        );
        assert!(!refused);
        assert_eq!(rx.try_iter().count(), 0);
        release.send(()).unwrap();
        handles.recv().unwrap().join().unwrap();
        assert_eq!(rx.try_iter().collect::<Vec<_>>(), vec![click()]);
        assert_eq!(waits.active(), 0);
    }

    #[test]
    fn a_wait_that_panics_still_frees_its_slot() {
        let waits = Arc::new(ClickWaits::new(1));
        let (spawn, handles) = threaded();
        assert!(take_over(
            &waits,
            click(),
            || panic!("the library blew up"),
            |_| {},
            || {},
            spawn,
        ));
        assert!(handles.recv().unwrap().join().is_err());
        assert_eq!(waits.active(), 0);
        assert!(
            waits.try_acquire().is_some(),
            "the banner after a crash must still wait"
        );
    }

    #[test]
    fn a_thread_that_cannot_start_leaves_no_slot_and_is_not_taken_over() {
        let waits = Arc::new(ClickWaits::new(1));
        let started = take_over(
            &waits,
            click(),
            || panic!("never sent"),
            |_| panic!("never emitted"),
            || panic!("never fell back"),
            |_job| Err(io::Error::other("no threads left")),
        );
        assert!(!started, "the caller must show the banner plain");
        assert_eq!(waits.active(), 0);
    }

    /// Through Tauri's real event bus (the mock runtime), the way the page listens by default
    /// (`listen_any` = target `Any`): the name is a valid event name (Tauri refuses others at
    /// runtime, which the literal-string test above cannot see), the listener is called once, and
    /// the payload on the wire is exactly `{ id, target }`.
    #[test]
    fn the_click_event_reaches_a_page_listener_once_with_exactly_id_and_target() {
        use tauri::Listener;

        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen_any(NOTIFICATION_CLICK_EVENT, move |event| {
            tx.send(event.payload().to_owned()).unwrap();
        });

        emit_click(app.handle(), &click()).unwrap();

        let payload = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the page's listener was not called");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&payload).unwrap(),
            serde_json::json!({
                "id": "n-abc123-1",
                "target": "/c/00000000-0000-7000-8000-00000000020a?msg=ab",
            })
        );
        // Exactly once.
        assert!(rx
            .recv_timeout(std::time::Duration::from_millis(50))
            .is_err());
    }

    #[test]
    fn the_real_spawner_runs_the_job_on_a_named_thread() {
        let (tx, rx) = mpsc::channel();
        spawn_named(Box::new(move || {
            tx.send(std::thread::current().name().map(str::to_owned))
                .unwrap();
        }))
        .unwrap();
        let name = rx
            .recv_timeout(std::time::Duration::from_secs(5))
            .expect("the job ran");
        assert_eq!(name.as_deref(), Some("oort-notification-click"));
    }
}
