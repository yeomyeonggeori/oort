// momo desktop shell (ADR-0133). Wraps the exact clients/web bundle — no forked
// UI. The shell's job is the part a webview cannot do: the four native
// integrations of ADR-0133 §2 B-group (MOMO-603).
//
//   deep link     momo://join arrives from the OS -> `momo:deep-link` event
//   discovery     _momo._tcp browse               -> `momo:discovery` event
//   notification  mentions/approvals              -> commands
//   keychain      refresh token at rest           -> commands
//   session       the refresh rotation + its proof -> commands (#3106; the
//                 webview gets the access token and a handle, never the token)
//   updater       self-replace the app bundle     -> commands + progress event
//   detect        local hosted-agent signatures   -> command (T-5; passive only)
//   harnesses     claude/codex installed + login  -> command (#2813; exit code only)
//   git reads     a pane's repo/branch/diff numbers -> command (#2855; 8 fixed reads)
//   pane signals  harness hooks -> app-only Unix socket -> the pane's channel (#2776)
//   work host     this Mac as a work host (momo-workd sidecar) -> commands (#2778)
//   device key    Secure Enclave P-256 signing key, the R2 root (#3025)
//
// Everything above is exposed to the web bundle as plain app commands and two
// events; the contract is documented in `clients/desktop/README.md` and consumed
// through `clients/web/src/lib/tauri.ts`. No product decision lives in Rust —
// what to prefill, when to notify and how a discovered server is offered are all
// the web layer's calls.

mod deeplink;
#[cfg(desktop)]
mod detect;
mod discovery;
// Eight fixed, read-only git commands in a pane's folder (ADR-0190 D3-c,
// #2855). Parsed here; only fields reach the webview.
#[cfg(desktop)]
mod git_read;
// Where harness CLIs live on this Mac (ADR-0190 D3), shared by every caller
// that resolves `claude`/`codex` to an absolute path.
#[cfg(desktop)]
mod harness_path;
// Account profile folders (#2878, ADR-0191 D1, ADR-0190 D3-f): the one
// harness+label → folder mapping, and the guarded removal after the official
// sign-out. Reachable only through the four `harness_profile_*` commands,
// which only `capabilities/harness-profile.json` grants.
#[cfg(desktop)]
mod harness_profile;
// The removal gate's structured "signed out?" check (ADR-0190 D3-d, #2878):
// `claude auth status --json` / `codex app-server` account/read, one field each.
#[cfg(desktop)]
mod profile_signout;
// `claude auth status` / `codex login status`, exit code only (#2813,
// ADR-0190 D3-a). The only harness commands the shell runs on its own.
#[cfg(desktop)]
mod harness_status;
mod keychain;
mod notification;
// The shell's own refresh rotation with the refresh-key proof (#3106,
// ADR-0146 D-7 증보 #3079): the webview asks for a rotation and gets the
// access token and a handle, never the refresh token.
#[cfg(desktop)]
mod session_refresh;
// A window close waits (bounded) for a refresh rotation in flight, so the
// rotated token reaches the keychain (#3098).
#[cfg(desktop)]
mod rotation_hold;
// Harness hook signals for pane status dots (#2776, ADR-0190 D4-b): an
// app-only Unix socket, a token per pane, a closed event table.
#[cfg(desktop)]
pub mod pane_signal;
// Handing a URL to the platform browser needs a platform browser, and the
// updater replaces an application bundle, which is not a thing that exists on
// iOS/Android — both are desktop-only and so are these modules.
#[cfg(desktop)]
mod opener;
// Opening a PDF attachment in the OS viewer (#2701): the same "hand it to the
// platform" shape as `opener`, for bytes the webview cannot show itself.
#[cfg(desktop)]
mod pdf_viewer;
// Local terminal lane (ADR-0190 D1·D2, #2772): the app process opens the PTY,
// the webview draws it. Reachable only through the five `pty_*` commands,
// which only `capabilities/pty.json` grants.
#[cfg(desktop)]
mod pty;
// Where a new session starts (ADR-0190 D3-c 증보 2026-10-01, #2775): the
// folder rule, the native folder picker and the one git write (a new
// worktree). Reachable only through three `workbench_*` commands, which only
// `capabilities/workbench-start.json` grants.
#[cfg(desktop)]
mod start_folder;
// What the capability and window config owe the web bundle's drag regions and
// file drops (#2671). Tests only.
#[cfg(test)]
mod shell_contract;
// AI 연결 Phase 1 (#2814): brings Terminal.app forward. No arguments.
#[cfg(desktop)]
mod terminal_app;
#[cfg(desktop)]
mod updater;
// This Mac as a work host (ADR-0188 D2 · R1, #2778): the `momo-workd` sidecar,
// its registration and its user-only control socket. Reachable only through
// the five `work_host_*` commands, which only `capabilities/work-host.json`
// grants.
#[cfg(target_os = "macos")]
mod work_host;
// Windows/Linux desktop: same command names, each answering
// `unsupported_platform` (no sidecar, no code-signature check there).
#[cfg(all(desktop, not(target_os = "macos")))]
#[path = "work_host_unsupported.rs"]
mod work_host;
// This Mac's human device key (ADR-0146 개정 2026-09-28 D-3·D-6·D-7, #3025):
// a Secure Enclave P-256 key, the three signed statements built in Rust, a
// native confirmation before each signature, and the root pin on workd.
// Reachable only through the eight `device_key_*` commands, which only
// `capabilities/device-key.json` grants.
#[cfg(target_os = "macos")]
mod device_key;
#[cfg(all(desktop, not(target_os = "macos")))]
#[path = "device_key_unsupported.rs"]
mod device_key;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

/// The version this build reports, e.g. `0.1.0-next.1`.
///
/// Comes from `tauri.conf.json > version` unless the publish script overrode it
/// with `--config`. The updater compares that same string against the manifest,
/// so what a tester reads on screen and what decides "is there a new build"
/// cannot disagree — except a local release still shows the committed baseline
/// and does not check the channel (#1281). A bug report that names a version is
/// worth several that say "the latest one".
#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    app.package_info().version.to_string()
}

/// The compiled app context: config, embedded assets and the resolved
/// capability ACL. One function so the tests can ask Tauri's own resolver
/// what this build allows (`shell_contract.rs`) — the macro may only expand
/// once per crate.
fn context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Opened only by `start_folder` on the Rust side; no capability grants
        // a `dialog:*` permission to the webview.
        .plugin(tauri_plugin_dialog::init())
        .manage(updater::UpdaterState::default())
        .manage(pty::PtyState::default())
        .manage(work_host::WorkHostState::default())
        .manage(device_key::DeviceKeyState::default())
        .manage(rotation_hold::RotationHold::default())
        .manage(session_refresh::SessionShell::default())
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    rotation_hold::on_close_requested(window, api);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            deeplink::deep_link_take_pending,
            discovery::discovery_start,
            discovery::discovery_stop,
            notification::notification_permission,
            notification::notification_request_permission,
            notification::notification_show,
            notification::dock_badge_set,
            keychain::keychain_available,
            keychain::keychain_refresh_token_handle,
            keychain::keychain_store_refresh_token,
            keychain::keychain_clear_refresh_token,
            rotation_hold::session_rotation_begin,
            rotation_hold::session_rotation_end,
            session_refresh::session_refresh_attempt,
            session_refresh::session_revoke,
            opener::open_external_url,
            pdf_viewer::open_pdf_attachment,
            detect::detect_hosted_agents,
            harness_status::detect_local_harnesses,
            terminal_app::open_terminal_app,
            app_version,
            updater::updater_check,
            updater::updater_install,
            updater::updater_relaunch,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_ack,
            git_read::workbench_git_read,
            start_folder::workbench_folder_pick,
            start_folder::workbench_folder_inspect,
            start_folder::workbench_worktree_create,
            harness_profile::harness_profile_list,
            harness_profile::harness_profile_create,
            harness_profile::harness_profile_status,
            harness_profile::harness_profile_remote_status,
            harness_profile::harness_profile_remove,
            work_host::work_host_status,
            work_host::work_host_register,
            work_host::work_host_start,
            work_host::work_host_stop,
            work_host::work_host_forget,
            work_host::work_host_set_remote_profile,
            work_host::work_host_prepare_remote_profile,
            device_key::device_key_status,
            device_key::device_key_create,
            device_key::device_key_bind_root,
            device_key::device_key_sign_control,
            device_key::device_key_sign_endorse,
            device_key::device_key_sign_revoke,
            device_key::device_key_deliver_revocation,
            device_key::device_key_sign_rebind,
            device_key::device_key_reset_signature_requirement,
        ]);

    #[cfg(not(desktop))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        deeplink::deep_link_take_pending,
        discovery::discovery_start,
        discovery::discovery_stop,
        notification::notification_permission,
        notification::notification_request_permission,
        notification::notification_show,
        keychain::keychain_available,
        keychain::keychain_store_refresh_token,
        keychain::keychain_clear_refresh_token,
        app_version,
    ]);

    // A (re)loaded main page cannot reach the sessions the previous page
    // opened (their channels died with it), so they end here (#2824 M3).
    #[cfg(desktop)]
    let builder = builder.on_page_load(|webview, payload| {
        if webview.label() == "main" && payload.event() == tauri::webview::PageLoadEvent::Started {
            if let Some(state) = webview.try_state::<pty::PtyState>() {
                state.0.kill_all();
            }
            // Rotations the previous page opened can never end now (#3098).
            if let Some(hold) = webview.try_state::<rotation_hold::RotationHold>() {
                hold.reset();
            }
        }
    });

    builder
        .manage(deeplink::DeepLinkState::default())
        .manage(discovery::DiscoveryState::default())
        .setup(|app| {
            // A registered host starts with the app (ADR-0188 D2, #2778).
            #[cfg(desktop)]
            work_host::start_if_registered(app.handle());
            // PDF copies a previous run left behind lose their removal timers
            // with that run; sweep the stale ones now (#2701 R1, review M-3).
            #[cfg(desktop)]
            if let Ok(cache) = app.path().app_cache_dir() {
                pdf_viewer::sweep_cache(&cache);
            }
            // Pane status hooks (#2776). A failed bind only means no status
            // dots beyond the process lifecycle; the terminal still works.
            #[cfg(desktop)]
            {
                let path = pane_signal::socket_path();
                match pane_signal::bind(&path) {
                    Ok(listener) => {
                        let manager = app.state::<pty::PtyState>().0.clone();
                        manager.set_hook_socket(path);
                        pane_signal::serve(listener, manager);
                    }
                    Err(e) => eprintln!("[oort] pane signal socket unavailable: {e}"),
                }
            }
            // Windows and Linux hand a deep link to a NEW process as an argv
            // entry rather than to the running one, and the scheme has to be
            // registered with the OS at runtime there. macOS registers it from
            // the bundle's Info.plist and rejects the runtime call outright.
            #[cfg(any(windows, target_os = "linux"))]
            {
                let _ = app.deep_link().register_all();
            }

            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let Some(state) = handle.try_state::<deeplink::DeepLinkState>() else {
                    return;
                };
                for url in event.urls() {
                    state.deliver(&handle, &url);
                }
            });

            // Cold start, Windows/Linux: the launch URL arrived as an argv entry
            // and the plugin recorded it while ITS setup ran, before the listener
            // above existed — so the only way to see it is to ask. On macOS this
            // is a no-op (the launch URL arrives later, as a `RunEvent::Opened`,
            // and reaches the listener), which is why it cannot double-deliver.
            // Either way `deliver` buffers until the webview announces itself:
            // clicking an invite with the app closed has to work.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                let state = app.state::<deeplink::DeepLinkState>();
                let handle = app.handle();
                for url in urls {
                    state.deliver(handle, &url);
                }
            }

            Ok(())
        })
        .build(context())
        .expect("error while building momo desktop shell")
        .run(|_app, _event| {
            // Closing the app ends every local terminal's process group
            // (#2772). `Exit` rather than `ExitRequested`: the latter can be
            // vetoed, the former is the last event before the process ends.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = _event {
                if let Some(state) = _app.try_state::<pty::PtyState>() {
                    state.0.kill_all();
                    if let Some(path) = state.0.hook_socket() {
                        pane_signal::remove(path);
                    }
                }
                // The work host is the app's child in this stage (ADR-0188
                // D2): it stops with the app.
                if let Some(host) = _app.try_state::<work_host::WorkHostState>() {
                    host.stop_now();
                }
            }
        });
}
