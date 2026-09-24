//! What the shell owes the web bundle for two desktop gestures (#2671).
//! Tests only: the settings themselves live in `capabilities/default.json`
//! and `tauri.conf.json`.
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
//!   WebKit, which is the same path the browser build already uses.
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
