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
    ensure_workd_sidecar();
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
    // A window close waits for a refresh rotation in flight (#3098).
    "session_rotation_begin",
    "session_rotation_end",
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
    // Account profile folders (ADR-0191 D1, ADR-0190 D3-f, #2878). Granted
    // only by capabilities/harness-profile.json.
    "harness_profile_list",
    "harness_profile_create",
    "harness_profile_status",
    "harness_profile_remove",
    // This Mac as a work host (ADR-0188 D2, #2778). Granted only by
    // capabilities/work-host.json.
    "work_host_status",
    "work_host_register",
    "work_host_start",
    "work_host_stop",
    "work_host_forget",
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
];

/// `tauri.conf.json > bundle > externalBin` names `binaries/momo-workd`, and
/// tauri-build copies `binaries/momo-workd-<target triple>` next to the app's
/// executable on EVERY build — `cargo test` and `clippy` included — failing if
/// it is missing. The real binary is built by
/// `scripts/desktop/build_workd_sidecar.sh`, which `cargo tauri build` runs
/// first (`beforeBuildCommand`). For every other build a placeholder stands
/// in: a script that exits 78 and says how to build the sidecar. The app
/// reads only a Mach-O as the sidecar (`work_host::is_mach_o`), so a
/// placeholder shows as 「이 빌드에는 작업 호스트가 없습니다」, and
/// `build_workd_sidecar.sh --verify-bundle` fails a bundle that carries one.
fn ensure_workd_sidecar() {
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
    let path = dir.join(format!("momo-workd-{target}"));
    println!("cargo:rerun-if-changed={}", path.display());
    if path.exists() {
        return;
    }
    std::fs::create_dir_all(&dir).expect("create binaries/");
    std::fs::write(
        &path,
        "#!/bin/sh\n# momo-workd placeholder (build.rs). Build the real sidecar:\n\
         #   scripts/desktop/build_workd_sidecar.sh\n\
         echo 'momo-workd sidecar not built: scripts/desktop/build_workd_sidecar.sh' >&2\n\
         exit 78\n",
    )
    .expect("write the momo-workd placeholder");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))
            .expect("chmod the momo-workd placeholder");
    }
    println!(
        "cargo:warning=momo-workd sidecar placeholder written at {} (run scripts/desktop/build_workd_sidecar.sh for the real one)",
        path.display()
    );
}
