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
    "keychain_available",
    "keychain_load_refresh_token",
    "keychain_store_refresh_token",
    "keychain_clear_refresh_token",
    "open_external_url",
    "open_pdf_attachment",
    "detect_hosted_agents",
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
];
