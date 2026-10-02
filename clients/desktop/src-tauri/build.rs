fn main() {
    // Channel artifacts are the only builds allowed to talk to the updater
    // manifest (#1281). `cargo tauri build` locally (release, unsigned) still
    // reports `tauri.conf.json`'s baseline version (`0.1.0-next.1`), which the
    // live manifest always outranks — so a local release would otherwise offer
    // to replace newer HEAD with the last published bundle. The publish script
    // is the only path that sets this.
    println!("cargo:rerun-if-env-changed=MOMO_CHANNEL_BUILD");
    println!("cargo:rustc-check-cfg=cfg(momo_channel_build)");
    if std::env::var("MOMO_CHANNEL_BUILD").ok().as_deref() == Some("1") {
        println!("cargo:rustc-cfg=momo_channel_build");
    }
    // Declaring the app's commands turns on Tauri's ACL for app commands
    // (#2772): from here on a command runs only if a capability grants it to
    // the calling window and origin. Every existing command is granted to the
    // main window in `capabilities/default.json`; the PTY commands are granted
    // only in `capabilities/pty.json` (local origin, the main webview, no
    // remote URLs). `shell_contract.rs` checks this list against `lib.rs`'s
    // handler table, so a new command that is not listed here fails a test
    // instead of failing at runtime.
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");
}

/// Every `#[tauri::command]` registered in `src/lib.rs`, desktop and mobile.
const APP_COMMANDS: &[&str] = &[
    "deep_link_take_pending",
    "discovery_start",
    "discovery_stop",
    "notification_permission",
    "notification_request_permission",
    "notification_show",
    // Dock badge = the web side's needs-me count (#3339). Desktop only;
    // granted to the main window in capabilities/default.json.
    "dock_badge_set",
    "keychain_available",
    // Desktop: the webview's handle for the stored token (#3106).
    "keychain_refresh_token_handle",
    "keychain_store_refresh_token",
    "keychain_clear_refresh_token",
    // A window close waits for a refresh rotation in flight (#3098).
    "session_rotation_begin",
    "session_rotation_end",
    // The shell's own rotation and logout revocation (#3106).
    "session_refresh_attempt",
    "session_revoke",
    "open_external_url",
    "open_pdf_attachment",
    "detect_hosted_agents",
    // Local harness detection (#2813): no arguments, exit codes only.
    "detect_local_harnesses",
    // AI 연결 Phase 1 (#2814): bring Terminal.app forward. No arguments.
    "open_terminal_app",
    "app_version",
    "updater_check",
    "updater_install",
    "updater_relaunch",
    // Local terminal lane (ADR-0190 D1). Granted only by capabilities/pty.json.
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "pty_ack",
    // Local git reads (ADR-0190 D3-c, #2855). Granted only by
    // capabilities/git-read.json.
    "workbench_git_read",
    // Where a new session starts (ADR-0190 D3-c 증보 2026-10-01, #2775).
    // Granted only by capabilities/workbench-start.json.
    "workbench_folder_pick",
    "workbench_folder_inspect",
    "workbench_worktree_create",
    // Account profile folders (ADR-0191 D1, ADR-0190 D3-f, #2878). Granted
    // only by capabilities/harness-profile.json.
    "harness_profile_list",
    "harness_profile_create",
    "harness_profile_status",
    // The same probe against this Mac's 「원격 작업」 account folder (#3157).
    "harness_profile_remote_status",
    "harness_profile_remove",
    // This Mac as a work host (ADR-0188 D2, #2778). Granted only by
    // capabilities/work-host.json.
    "work_host_status",
    "work_host_register",
    "work_host_start",
    "work_host_stop",
    "work_host_forget",
    // This Mac's 「원격 작업」 account (#3033 workd op, #3157). Granted only by
    // capabilities/work-host.json.
    "work_host_set_remote_profile",
    "work_host_prepare_remote_profile",
    // This Mac's human device key (ADR-0146 개정 R2-E5, #3025). Granted only
    // by capabilities/device-key.json.
    "device_key_status",
    "device_key_create",
    "device_key_bind_root",
    "device_key_sign_control",
    "device_key_sign_endorse",
    "device_key_sign_revoke",
    "device_key_deliver_revocation",
    "device_key_sign_rebind",
    "device_key_reset_signature_requirement",
];

// The momo-workd helper bundle (`binaries/momo-workd.app`, #3084) is read only
// by the bundler (`bundle.macOS.files`), never by tauri-build, so `cargo test`
// and `clippy` need no placeholder. `scripts/desktop/build_workd_sidecar.sh`
// builds it first on `cargo tauri build` (beforeBuildCommand).
