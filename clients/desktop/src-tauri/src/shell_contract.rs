//! What the shell owes the web bundle for two desktop gestures (#2671) and
//! for the notification plugin's page script (#2676). Tests only: the
//! settings themselves live in `capabilities/default.json` and
//! `tauri.conf.json`.
//!
//! * **Dragging the window by its top bar.** The bundle marks its top bars
//!   with `data-tauri-drag-region` (`clients/web/src/app/sidebarPane.ts`).
//!   Pressing one makes Tauri's drag script invoke
//!   `plugin:window|start_dragging`. That command is not in `core:default`
//!   (→ `core:window:default`), so without an explicit
//!   `core:window:allow-start-dragging` the invoke is refused
//!   ("window.start_dragging not allowed") and the window stays put.
//! * **Dropping files on the composer.** The composer
//!   (`useComposerDropZone.ts`) and the sidebar reorder (`sidebarDnd.ts`) read
//!   HTML5 `dragover`/`drop`. With Tauri's default `dragDropEnabled: true`, the
//!   native handler takes every drag first (tauri-runtime-wry's handler
//!   returns `true`, so wry never calls WKWebView's own `performDragOperation`)
//!   and the page receives only `tauri://drag-drop` with paths — no HTML5
//!   events, no `File` objects. `dragDropEnabled: false` hands drags back to
//!   WebKit, which is the same path the browser build already uses. The
//!   price is WebKit's default for a drop nobody claims: the window navigates
//!   to the dropped file or link. The web bundle's `desktopDropGuard.ts`,
//!   installed only in this shell, swallows those.
//! * **The notification plugin's boot probe.** `tauri-plugin-notification`
//!   (2.3.3, `src/init-iife.js`) installs a page script in every webview. It
//!   replaces `window.Notification` and, on every platform but Windows,
//!   invokes `plugin:notification|is_permission_granted` once at document
//!   start, with no `.catch`. Without a grant the ACL refuses it
//!   ("notification.is_permission_granted not allowed") and every launch
//!   logs an unhandled rejection (#2676, measured). The banners themselves
//!   do not depend on it: mentions and approvals go through the app commands
//!   in `notification.rs`, which the capability does not gate (no app ACL
//!   manifest). So the grant is exactly the read-only probe — nothing that
//!   can post a notification or prompt.
//!
//! `clients/web/src/app/desktopShellContract.test.ts` pins the same two
//! settings from the web side, where CI runs it; this crate's tests run
//! locally (the CI cargo lane builds `server-rust` only).

use serde_json::Value;

const CAPABILITY: &str = include_str!("../capabilities/default.json");
const CONF: &str = include_str!("../tauri.conf.json");

fn permission_ids(capability: &Value) -> Vec<&str> {
    capability["permissions"]
        .as_array()
        .expect("capability permissions")
        .iter()
        .map(|p| {
            p.as_str()
                .or_else(|| p["identifier"].as_str())
                .expect("permission identifier")
        })
        .collect()
}

#[test]
fn the_main_window_capability_grants_start_dragging() {
    let capability: Value = serde_json::from_str(CAPABILITY).unwrap();
    let windows: Vec<&str> = capability["windows"]
        .as_array()
        .expect("capability windows")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(windows.contains(&"main"), "windows = {windows:?}");
    let permissions = permission_ids(&capability);
    assert!(
        permissions.contains(&"core:window:allow-start-dragging"),
        "permissions = {permissions:?}"
    );
}

#[test]
fn the_main_window_hands_file_drops_to_the_page() {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    let main = conf["app"]["windows"]
        .as_array()
        .expect("app.windows")
        .iter()
        .find(|w| w["label"].as_str().unwrap_or("main") == "main")
        .expect("main window");
    // Absent means Tauri's default, `true`.
    assert_eq!(
        main.get("dragDropEnabled"),
        Some(&Value::Bool(false)),
        "main window = {main}"
    );
}

/// Why the explicit permission is needed at all, read from the ACL that
/// `tauri_build::build()` generated for this build: the default set does not
/// carry `start_dragging`, and the permission we grant is the one that does.
#[test]
fn start_dragging_is_outside_the_core_default_set() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/gen/schemas/acl-manifests.json"
    );
    let acl: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let window = &acl["core:window"];
    let defaults: Vec<&str> = window["default_permission"]["permissions"]
        .as_array()
        .expect("core:window default set")
        .iter()
        .filter_map(Value::as_str)
        .collect();
    assert!(!defaults.contains(&"allow-start-dragging"), "{defaults:?}");
    assert_eq!(
        window["permissions"]["allow-start-dragging"]["commands"]["allow"],
        serde_json::json!(["start_dragging"])
    );
}

/// Tauri's own resolver — the code that answered "not allowed" at runtime —
/// run over the compiled capability set.
#[test]
fn tauri_resolves_start_dragging_for_the_main_window_only() {
    let mut context = crate::context();
    let authority = context.runtime_authority_mut();
    let local = tauri::ipc::Origin::Local;
    assert!(authority
        .resolve_access("plugin:window|start_dragging", "main", "main", &local)
        .is_some());
    // Controls, so the line above cannot pass by resolving everything: a
    // window command nobody granted, and the granted one on another window.
    assert!(authority
        .resolve_access("plugin:window|close", "main", "main", &local)
        .is_none());
    assert!(authority
        .resolve_access("plugin:window|start_dragging", "other", "other", &local)
        .is_none());
}

/// The plugin's page script asks one read-only question at every launch;
/// the main window may answer it, and that is the only notification
/// permission it holds (#2676).
#[test]
fn the_main_window_capability_grants_only_the_notification_probe() {
    let capability: Value = serde_json::from_str(CAPABILITY).unwrap();
    let permissions = permission_ids(&capability);
    let notification: Vec<&str> = permissions
        .iter()
        .copied()
        .filter(|p| p.starts_with("notification:"))
        .collect();
    assert_eq!(
        notification,
        ["notification:allow-is-permission-granted"],
        "permissions = {permissions:?}"
    );
}

/// Tauri's own resolver — the code that answered "not allowed" at launch —
/// run over the compiled capability set.
#[test]
fn tauri_resolves_the_notification_probe_and_nothing_that_posts() {
    let mut context = crate::context();
    let authority = context.runtime_authority_mut();
    let local = tauri::ipc::Origin::Local;
    assert!(authority
        .resolve_access(
            "plugin:notification|is_permission_granted",
            "main",
            "main",
            &local
        )
        .is_some());
    // Controls: the plugin commands that post a banner or prompt stay closed
    // (a `notification:default` grant would open all of them), and the probe
    // is not granted to a window this capability does not name.
    for command in [
        "plugin:notification|notify",
        "plugin:notification|request_permission",
    ] {
        assert!(
            authority
                .resolve_access(command, "main", "main", &local)
                .is_none(),
            "{command} must stay refused"
        );
    }
    assert!(authority
        .resolve_access(
            "plugin:notification|is_permission_granted",
            "other",
            "other",
            &local
        )
        .is_none());
}

/// Why the banners never needed a notification grant: they are app commands
/// (`notification_show` and friends), and app commands are gated only once
/// the build declares an app ACL manifest. If one is ever added, those
/// commands need explicit grants too — this test is where that shows up.
#[test]
fn app_commands_are_not_gated_by_the_capability() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/gen/schemas/acl-manifests.json"
    );
    let acl: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let keys: Vec<&String> = acl.as_object().expect("acl manifests").keys().collect();
    assert!(!keys.iter().any(|k| *k == "__app-acl__"), "keys = {keys:?}");
    // The permission granted above maps to the probe command and nothing else.
    assert_eq!(
        acl["notification"]["permissions"]["allow-is-permission-granted"]["commands"]["allow"],
        serde_json::json!(["is_permission_granted"])
    );
}

/// The traffic lights and the sidebar toggle share one centre line (#2700).
///
/// The lights are native (`trafficLightPosition`), the toggle sits in the
/// middle of the web bundle's `app-titlebar` row. Neither knows the other, so
/// a change to either side alone drifts them apart while both sides' own tests
/// stay green. Measured 2026-09-25 (macOS 27.0 26A428, tauri-runtime-wry
/// 2.11.4 / tao 0.35.3, Retina window capture): the light's visible centre is
/// `y - 2` pt (y 14 → 12.0, y 21.5 → 19.5). The row is `--spacing-control-lg`
/// tall, border-box, with a 1px bottom border, so the toggle's centre is
/// `(control-lg - 1) / 2` = 19.5. Before the fix they were 7.5pt apart.
/// `clients/web/src/app/desktopShellContract.test.ts` pins the same relation
/// from the web side, where CI runs it.
#[test]
fn the_traffic_lights_share_the_titlebar_toggles_centre_line() {
    const TOKENS: &str = include_str!("../../../web/src/design/tokens.css");
    const LIGHT_CENTRE_MINUS_Y: f64 = -2.0;

    let conf: Value = serde_json::from_str(CONF).unwrap();
    let main = conf["app"]["windows"]
        .as_array()
        .expect("app.windows")
        .iter()
        .find(|w| w["label"].as_str().unwrap_or("main") == "main")
        .expect("main window");
    // The relation only holds with the lights floating over the web content.
    assert_eq!(main["titleBarStyle"], "Overlay", "main window = {main}");
    assert_eq!(main["hiddenTitle"], true, "main window = {main}");

    let control_lg: f64 = TOKENS
        .lines()
        .find_map(|l| l.trim().strip_prefix("--spacing-control-lg:"))
        .and_then(|v| v.trim().strip_suffix("px;"))
        .expect("--spacing-control-lg in tokens.css")
        .trim()
        .parse()
        .unwrap();
    let toggle_centre = (control_lg - 1.0) / 2.0;
    let y = main["trafficLightPosition"]["y"]
        .as_f64()
        .expect("trafficLightPosition.y");
    let light_centre = y + LIGHT_CENTRE_MINUS_Y;
    assert!(
        (light_centre - toggle_centre).abs() <= 1.0,
        "lights centre {light_centre}pt vs toggle centre {toggle_centre}pt"
    );
}

fn csp_directive<'a>(csp: &'a str, name: &str) -> Vec<&'a str> {
    csp.split(';')
        .map(|part| part.split_whitespace().collect::<Vec<_>>())
        .find(|tokens| tokens.first() == Some(&name))
        .map(|tokens| tokens[1..].to_vec())
        .unwrap_or_default()
}

/// Tauri 2's invoke first tries `fetch(ipc://localhost/<cmd>)`
/// (`http://ipc.localhost` on Windows/Android). A `connect-src` that refuses
/// it makes every command fall back to the postMessage JSON path, which cannot
/// carry a raw body: `open_pdf_attachment` then answers "expected raw bytes"
/// in the shipped bundle (#2701 R1, security review H-1).
#[test]
fn the_shipped_csp_lets_the_ipc_protocol_through() {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    let csp = conf["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp");
    let connect = csp_directive(csp, "connect-src");
    assert!(connect.contains(&"ipc:"), "connect-src = {connect:?}");
    assert!(
        connect.contains(&"http://ipc.localhost"),
        "connect-src = {connect:?}"
    );
    // Control: opening the IPC transport did not open an embed or worker path.
    assert_eq!(csp_directive(csp, "frame-src"), ["'none'"]);
    assert_eq!(csp_directive(csp, "object-src"), ["'none'"]);
}
