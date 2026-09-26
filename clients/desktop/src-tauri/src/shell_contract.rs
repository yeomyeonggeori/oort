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

/// The build declares an app ACL manifest (#2772), so app commands are gated
/// like plugin commands: the banners (`notification_show` and friends) run
/// because `default.json` grants them, not because nothing checks. The
/// notification permission granted above still maps to the probe only.
#[test]
fn app_commands_are_gated_by_the_capability() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/gen/schemas/acl-manifests.json"
    );
    let acl: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let keys: Vec<&String> = acl.as_object().expect("acl manifests").keys().collect();
    assert!(keys.iter().any(|k| *k == "__app-acl__"), "keys = {keys:?}");
    assert_eq!(
        acl["notification"]["permissions"]["allow-is-permission-granted"]["commands"]["allow"],
        serde_json::json!(["is_permission_granted"])
    );
    let mut context = crate::context();
    let authority = context.runtime_authority_mut();
    let local = tauri::ipc::Origin::Local;
    assert!(authority
        .resolve_access("notification_show", "main", "main", &local)
        .is_some());
    // Control: a command no capability grants is refused, which is only true
    // once the app manifest exists.
    assert!(authority
        .resolve_access("not_a_command", "main", "main", &local)
        .is_none());
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

/// The shipped CSP runs only the bundle's own scripts: no remote script, no
/// inline script, no eval — the webview that holds the PTY commands never
/// executes code a server sent (#2772, #2794 review M4).
#[test]
fn the_shipped_csp_runs_only_bundled_scripts() {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    let csp = conf["app"]["security"]["csp"]
        .as_str()
        .expect("app.security.csp");
    assert_eq!(csp_directive(csp, "default-src"), ["'self'"]);
    assert_eq!(csp_directive(csp, "script-src"), ["'self'"]);
    assert_eq!(csp_directive(csp, "frame-src"), ["'none'"]);
    assert_eq!(csp_directive(csp, "worker-src"), ["'none'"]);
    // `dangerousDisableAssetCspModification` or a null CSP would undo the above.
    assert!(conf["app"]["security"]
        .get("dangerousDisableAssetCspModification")
        .is_none());
}

// ---------------------------------------------------------------------------
// Local terminal lane (ADR-0190 D1, #2772)
// ---------------------------------------------------------------------------

const PTY_CAPABILITY: &str = include_str!("../capabilities/pty.json");
const BUILD_RS: &str = include_str!("../build.rs");
const LIB_RS: &str = include_str!("lib.rs");
const PTY_COMMANDS: [&str; 5] = [
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "pty_ack",
];

/// Commands inside one `generate_handler![...]` block, `module::` stripped.
fn handler_blocks(src: &str) -> Vec<Vec<String>> {
    src.split("generate_handler![")
        .skip(1)
        .map(|rest| {
            rest[..rest.find(']').expect("handler block end")]
                .split(',')
                .map(|c| c.trim().rsplit("::").next().unwrap().to_string())
                .filter(|c| !c.is_empty())
                .collect()
        })
        .collect()
}

fn quoted_list(src: &str, start: &str) -> Vec<String> {
    let rest = &src[src.find(start).expect(start)..];
    let body = &rest[..rest.find("];").expect("list end")];
    body.lines()
        .map(str::trim)
        .filter(|l| l.starts_with('"'))
        .map(|l| l.trim_end_matches(',').trim_matches('"').to_string())
        .collect()
}

fn all_capabilities() -> Vec<(String, Value)> {
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities");
    let mut out: Vec<(String, Value)> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json" || x == "toml"))
        .map(|p| {
            let text = std::fs::read_to_string(&p).unwrap();
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            let value = serde_json::from_str(&text).unwrap_or_else(|e| panic!("{name}: {e}"));
            (name, value)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// Every registered command is in the app manifest and granted to the main
/// window. With the manifest on, a command missing from either list is
/// refused at runtime, which a user sees as a dead button.
#[test]
fn every_registered_command_is_declared_and_granted() {
    let manifest = quoted_list(BUILD_RS, "const APP_COMMANDS");
    let blocks = handler_blocks(LIB_RS);
    assert_eq!(blocks.len(), 2, "desktop and mobile handler tables");
    let mut context = crate::context();
    let authority = context.runtime_authority_mut();
    let local = tauri::ipc::Origin::Local;
    for command in blocks.iter().flatten() {
        assert!(
            manifest.contains(command),
            "{command} not in build.rs APP_COMMANDS"
        );
        assert!(
            authority
                .resolve_access(command, "main", "main", &local)
                .is_some(),
            "{command} is not granted to the main window"
        );
    }
    for command in &manifest {
        assert!(
            blocks.iter().flatten().any(|c| c == command),
            "{command} is declared but not registered"
        );
    }
    // The PTY commands are desktop-only: the mobile table does not carry them.
    let desktop = blocks
        .iter()
        .find(|b| b.contains(&"updater_check".to_string()))
        .unwrap();
    let mobile = blocks
        .iter()
        .find(|b| !b.contains(&"updater_check".to_string()))
        .unwrap();
    for command in PTY_COMMANDS {
        assert!(desktop.iter().any(|c| c == command), "{command}");
        assert!(!mobile.iter().any(|c| c == command), "{command}");
    }
}

/// Tauri's resolver: the PTY commands answer the main window's bundled
/// origin, and nobody else — not a remote page loaded into the same window,
/// not another window, not another webview.
#[test]
fn tauri_grants_the_pty_commands_to_the_local_main_window_only() {
    let mut context = crate::context();
    let authority = context.runtime_authority_mut();
    let local = tauri::ipc::Origin::Local;
    // A hostile page, the team server's own origin (what a navigation to a
    // server-sent link would load), and a plain http origin.
    let remotes = [
        "https://evil.example/",
        "https://oort-team.up.railway.app/",
        "http://127.0.0.1:8080/",
    ];
    for command in PTY_COMMANDS {
        assert!(
            authority
                .resolve_access(command, "main", "main", &local)
                .is_some(),
            "{command} local main"
        );
        for url in remotes {
            let remote = tauri::ipc::Origin::Remote {
                url: url.parse().unwrap(),
            };
            assert!(
                authority
                    .resolve_access(command, "main", "main", &remote)
                    .is_none(),
                "{command} from {url}"
            );
        }
        assert!(authority
            .resolve_access(command, "other", "other", &local)
            .is_none());
        assert!(authority
            .resolve_access(command, "main", "embedded", &local)
            .is_none());
    }
}

/// The capability files themselves: only `pty.json` grants a PTY command, it
/// names the main window only, and no capability opens anything to remote
/// URLs. Widening any of these is RED here before it is a hole.
#[test]
fn only_the_local_terminal_capability_grants_pty_and_none_is_remote() {
    let caps = all_capabilities();
    let names: Vec<&str> = caps.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(
        names,
        ["default.json", "pty.json"],
        "new capability file: review it here"
    );
    for (name, cap) in &caps {
        assert!(cap.get("remote").is_none(), "{name} has a remote entry");
        assert_ne!(cap.get("local"), Some(&Value::Bool(false)), "{name}");
        let pty: Vec<&str> = permission_ids(cap)
            .into_iter()
            .filter(|p| p.contains("pty"))
            .collect();
        if name == "pty.json" {
            assert_eq!(
                pty,
                [
                    "allow-pty-spawn",
                    "allow-pty-write",
                    "allow-pty-resize",
                    "allow-pty-kill",
                    "allow-pty-ack"
                ]
            );
        } else {
            assert!(pty.is_empty(), "{name} grants {pty:?}");
        }
    }
    let pty: Value = serde_json::from_str(PTY_CAPABILITY).unwrap();
    // The main window's own webview, not "any webview in the main window".
    assert_eq!(pty["webviews"], serde_json::json!(["main"]));
    assert!(
        pty.get("windows").is_none(),
        "a window grant covers child webviews"
    );
    assert_eq!(
        permission_ids(&pty).len(),
        PTY_COMMANDS.len(),
        "pty.json grants only the PTY"
    );
}

/// Rust source with comments removed and string/char literal contents blanked,
/// so prose and messages cannot trip the checks below and code cannot hide in
/// them. Line structure is kept.
fn code_only(src: &str) -> String {
    let b: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let blank = |c: char| if c == '\n' { '\n' } else { ' ' };
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                out.push(blank(b[i]));
                i += 1;
            }
            i += 2;
        } else if (c == 'r' || (c == 'b' && next == Some('r')))
            && !b
                .get(i.wrapping_sub(1))
                .is_some_and(|p| p.is_alphanumeric() || *p == '_')
            && {
                let mut j = i + if c == 'b' { 2 } else { 1 };
                while b.get(j) == Some(&'#') {
                    j += 1;
                }
                b.get(j) == Some(&'"')
            }
        {
            // Raw string: r"..", r#".."#, br#".."#
            i += if c == 'b' { 2 } else { 1 };
            let mut hashes = 0;
            while b[i] == '#' {
                hashes += 1;
                i += 1;
            }
            i += 1; // opening quote
            out.push('"');
            loop {
                if i >= b.len() {
                    break;
                }
                if b[i] == '"' && (0..hashes).all(|k| b.get(i + 1 + k) == Some(&'#')) {
                    i += 1 + hashes;
                    break;
                }
                out.push(blank(b[i]));
                i += 1;
            }
            out.push('"');
        } else if c == '"' {
            out.push('"');
            i += 1;
            while i < b.len() && b[i] != '"' {
                if b[i] == '\\' {
                    out.push(' ');
                    i += 1;
                }
                if i < b.len() {
                    out.push(blank(b[i]));
                    i += 1;
                }
            }
            out.push('"');
            i += 1;
        } else if c == '\'' && next == Some('\\') {
            // '\n', '\'', '\\', '\u{..}'
            i += 2;
            while i < b.len() && b[i] != '\'' {
                i += 1;
            }
            i += 1;
            out.push_str("' '");
        } else if c == '\'' && b.get(i + 2) == Some(&'\'') {
            i += 3;
            out.push_str("' '");
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// The contents of every string literal (plain and raw), comments skipped,
/// one per line.
fn string_contents(src: &str) -> String {
    let b: Vec<char> = src.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let next = b.get(i + 1).copied();
        if c == '/' && next == Some('/') {
            while i < b.len() && b[i] != '\n' {
                i += 1;
            }
        } else if c == '/' && next == Some('*') {
            i += 2;
            while i + 1 < b.len() && !(b[i] == '*' && b[i + 1] == '/') {
                i += 1;
            }
            i += 2;
        } else if (c == 'r' || (c == 'b' && next == Some('r')))
            && !b
                .get(i.wrapping_sub(1))
                .is_some_and(|p| p.is_alphanumeric() || *p == '_')
            && {
                let mut j = i + if c == 'b' { 2 } else { 1 };
                while b.get(j) == Some(&'#') {
                    j += 1;
                }
                b.get(j) == Some(&'"')
            }
        {
            i += if c == 'b' { 2 } else { 1 };
            let mut hashes = 0;
            while b[i] == '#' {
                hashes += 1;
                i += 1;
            }
            i += 1;
            while i < b.len() {
                if b[i] == '"' && (0..hashes).all(|k| b.get(i + 1 + k) == Some(&'#')) {
                    i += 1 + hashes;
                    break;
                }
                out.push(b[i]);
                i += 1;
            }
            out.push('\n');
        } else if c == '"' {
            i += 1;
            while i < b.len() && b[i] != '"' {
                if b[i] == '\\' {
                    out.push(b[i]);
                    i += 1;
                }
                if i < b.len() {
                    out.push(b[i]);
                    i += 1;
                }
            }
            out.push('\n');
            i += 1;
        } else if c == '\'' && next == Some('\\') {
            i += 2;
            while i < b.len() && b[i] != '\'' {
                i += 1;
            }
            i += 1;
        } else if c == '\'' && b.get(i + 2) == Some(&'\'') {
            i += 3;
        } else {
            i += 1;
        }
    }
    out
}

fn idents(code: &str) -> Vec<&str> {
    code.split(|c: char| !(c.is_alphanumeric() || c == '_'))
        .filter(|t| !t.is_empty())
        .collect()
}

/// Every `.rs` under `src/`, recursively, relative path → source.
fn crate_sources() -> Vec<(String, String)> {
    fn walk(dir: &std::path::Path, root: &std::path::Path, out: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                walk(&path, root, out);
            } else if path.extension().is_some_and(|x| x == "rs") {
                let rel = path
                    .strip_prefix(root)
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                out.push((rel, std::fs::read_to_string(&path).unwrap()));
            }
        }
    }
    let root = std::path::Path::new(concat!(env!("CARGO_MANIFEST_DIR"), "/src"));
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

/// An identifier that names the PTY module or anything it exports.
/// Every API that registers script to run in a webview at page load (tauri
/// 2.11 webview/window builders and plugin builder, wry 0.55). Such script
/// runs with the bundled (local) origin, so it would pass the PTY capability
/// just like `eval` (#2824 re-review Medium).
const INIT_SCRIPT_APIS: &[&str] = &[
    "initialization_script",
    "initialization_script_for_all_frames",
    "append_invoke_initialization_script",
    "with_initialization_script",
    "with_initialization_script_for_main_only",
    "js_init_script",
    "js_init_script_on_all_frames",
];

fn is_pty_ident(token: &str) -> bool {
    token == "pty"
        || token.starts_with("pty_")
        || token.starts_with("Pty")
        || token == "portable_pty"
        || [
            "SpawnRequest",
            "SpawnPlan",
            "HostFacts",
            "Program",
            "plan_spawn",
            "build_command",
            "native_pty_system",
            "CommandBuilder",
        ]
        .contains(&token)
}

/// ADR-0190 D1: nothing but the webview's own command calls opens, writes,
/// resizes or kills a PTY.
///
/// * Across the whole crate (`src/**`, recursively), identifiers that name the
///   module or its items — `pty`, `pty_*`, `Pty*`, `portable_pty`, the spawn
///   types — appear only in `pty.rs`, in this test file, and in `lib.rs` on
///   the exact lines below. An alias (`use crate::pty as term`), a new
///   submodule, or a deep-link/discovery handler that reached the PTY would
///   have to name it somewhere else — RED.
/// * `pty.rs` itself uses no event, listener, emitter, socket or network API
///   (by identifier, so UFCS and `emit_to` count), and each of its commands is
///   `async` (a sync command runs on the main thread — #2824 review H1).
#[test]
fn nothing_but_the_command_table_reaches_the_pty() {
    const LIB_ALLOWED: &[&str] = &[
        "mod pty;",
        "pty::pty_spawn,",
        "pty::pty_write,",
        "pty::pty_resize,",
        "pty::pty_kill,",
        "pty::pty_ack,",
        ".manage(pty::PtyState::default())",
        "if let Some(state) = _app.try_state::<pty::PtyState>() {",
        "if let Some(state) = webview.try_state::<pty::PtyState>() {",
    ];
    let sources = crate_sources();
    assert!(sources.iter().any(|(n, _)| n == "pty.rs"));
    for (name, src) in &sources {
        let code = code_only(src);
        match name.as_str() {
            "pty.rs" | "shell_contract.rs" => {}
            "lib.rs" => {
                for line in code.lines() {
                    if idents(line).into_iter().any(is_pty_ident) {
                        assert!(
                            LIB_ALLOWED.contains(&line.trim()),
                            "lib.rs reaches the PTY: {}",
                            line.trim()
                        );
                    }
                }
            }
            _ => {
                let hits: Vec<&str> = idents(&code)
                    .into_iter()
                    .filter(|t| is_pty_ident(t))
                    .collect();
                assert!(hits.is_empty(), "{name} reaches the PTY: {hits:?}");
            }
        }
    }

    // No other module may inject script into a webview or carry a PTY
    // command name in a string: local-origin JS injected by, say, the deep
    // link handler would pass the capability (#2824 R2 N-M1).
    for (name, src) in &sources {
        if name == "pty.rs" || name == "shell_contract.rs" {
            continue;
        }
        let code = code_only(src);
        let injected: Vec<&str> = idents(&code)
            .into_iter()
            .filter(|t| {
                [
                    "eval",
                    "eval_with_callback",
                    "evaluate_script",
                    "with_webview",
                ]
                .contains(t)
                    || INIT_SCRIPT_APIS.contains(t)
            })
            .collect();
        assert!(injected.is_empty(), "{name} injects script: {injected:?}");
        let strings = string_contents(src);
        for needle in ["pty_", "__TAURI_INTERNALS__", "__TAURI_INVOKE__", "invoke("] {
            assert!(
                !strings.contains(needle),
                "{name} carries {needle:?} in a string"
            );
        }
    }

    // App exit and page (re)load end every session.
    let lib = code_only(LIB_RS);
    for arm in [
        "if let tauri::RunEvent::Exit = _event {",
        "payload.event() == tauri::webview::PageLoadEvent::Started",
    ] {
        let at = lib
            .find(arm)
            .unwrap_or_else(|| panic!("lib.rs lacks {arm}"));
        assert!(
            lib[at..]
                .lines()
                .take(5)
                .any(|l| l.trim() == "state.0.kill_all();"),
            "{arm} must kill every PTY session"
        );
    }

    let pty_src = &sources.iter().find(|(n, _)| n == "pty.rs").unwrap().1;
    let pty = code_only(
        &pty_src[..pty_src
            .find("#[cfg(test)]\nmod tests")
            .unwrap_or(pty_src.len())],
    );
    let banned = [
        "listen",
        "listen_any",
        "once",
        "once_any",
        "unlisten",
        "Listener",
        "emit",
        "emit_to",
        "emit_filter",
        "emit_str",
        "Emitter",
        "eval",
        "net",
        "TcpListener",
        "TcpStream",
        "UdpSocket",
        "UnixListener",
        "UnixStream",
        "UnixDatagram",
        "reqwest",
        "hyper",
        "on_open_url",
        "deep_link",
        "deeplink",
        "discovery",
    ];
    let used: Vec<&str> = idents(&pty)
        .into_iter()
        .filter(|t| banned.contains(t) || INIT_SCRIPT_APIS.contains(t))
        .collect();
    assert!(used.is_empty(), "pty.rs uses {used:?}");

    // Exactly the five commands leave the module. `pty_write` must be sync:
    // only sync commands run in IPC arrival order, and keystroke order is
    // the contract (#2824 R2 — async measured ~42% adjacent swaps). Every
    // other command must be async: they may block, and a sync command runs
    // on the main thread (#2824 H1).
    let lines: Vec<&str> = pty.lines().map(str::trim).collect();
    let mut commands = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if *line == "#[tauri::command]" || line.starts_with("#[tauri::command(") {
            let decl = lines[i + 1..]
                .iter()
                .find(|l| !l.starts_with("#[") && !l.is_empty())
                .unwrap();
            let (sync, rest) = match (
                decl.strip_prefix("pub async fn "),
                decl.strip_prefix("pub fn "),
            ) {
                (Some(rest), _) => (false, rest),
                (None, Some(rest)) => (true, rest),
                _ => panic!("unexpected command declaration: {decl}"),
            };
            let name = rest.split(['(', '<']).next().unwrap().to_string();
            if name == "pty_write" {
                assert!(sync, "pty_write must be sync (input order): {decl}");
                assert!(!line.contains("async"), "{line}");
            } else {
                assert!(!sync, "{name} must be async (off the main thread): {decl}");
            }
            commands.push(name);
        }
    }
    // The sync one only enqueues: no PTY I/O, no sleeping, no spawning.
    let write_body = &pty[pty.find("pub fn pty_write(").unwrap()..];
    let write_body = &write_body[..write_body.find("\n}\n").unwrap()];
    for banned in ["write_all", "sleep", "spawn", "wait", "lock()"] {
        assert!(!write_body.contains(banned), "pty_write body uses {banned}");
    }
    let enqueue = &pty[pty.find("pub fn write(&self").unwrap()..];
    let enqueue = &enqueue[..enqueue.find("\n    }\n").unwrap()];
    for banned in ["write_all", "flush", "sleep", "master", ".recv"] {
        assert!(!enqueue.contains(banned), "PtyManager::write uses {banned}");
    }
    assert_eq!(commands, PTY_COMMANDS, "pty.rs commands");
}

#[test]
fn the_source_filter_sees_through_comments_and_strings() {
    let code = code_only(
        "let a = \"pty::x // not a comment\"; // pty in a comment\nlet b = r#\"emit_to\"#; let c = '\"'; /* TcpListener */ let d = pty;",
    );
    let ids = idents(&code);
    assert_eq!(ids.iter().filter(|t| is_pty_ident(t)).count(), 1, "{code}");
    assert!(
        !ids.contains(&"emit_to") && !ids.contains(&"TcpListener"),
        "{code}"
    );
    assert!(ids.contains(&"d"), "{code}");
    let strings = string_contents(
        "// \"pty_spawn\" in a comment\nlet a = \"x\"; let b = r#\"invoke('pty_spawn')\"#; let c = '\"';",
    );
    assert!(strings.contains("invoke('pty_spawn')"), "{strings}");
    assert_eq!(strings.matches("pty_").count(), 1, "{strings}");
}
