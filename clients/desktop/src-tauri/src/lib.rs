// momo desktop shell (ADR-0133 P0 spike). Wraps the exact clients/web-spike
// bundle — no forked UI. Native integrations (deep-link, mDNS, keychain,
// notification, updater) are deliberately NOT here: they are P2 per the
// migration plan §2 B-group. This spike only proves "one codebase, two
// runtimes" and desktop performance.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running momo desktop shell");
}
