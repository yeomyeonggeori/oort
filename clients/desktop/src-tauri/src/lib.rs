// momo desktop shell (ADR-0133). Wraps the exact clients/web bundle — no forked
// UI. The shell's job is the part a webview cannot do: the four native
// integrations of ADR-0133 §2 B-group (MOMO-603).
//
//   deep link     momo://join arrives from the OS -> `momo:deep-link` event
//   discovery     _momo._tcp browse               -> `momo:discovery` event
//   notification  mentions/approvals              -> commands
//   keychain      refresh token at rest           -> commands
//
// Everything above is exposed to the web bundle as plain app commands and two
// events; the contract is documented in `clients/desktop/README.md` and consumed
// through `clients/web/src/lib/tauri.ts`. No product decision lives in Rust —
// what to prefill, when to notify and how a discovered server is offered are all
// the web layer's calls.

mod deeplink;
mod discovery;
mod keychain;
mod notification;

use tauri::Manager;
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .manage(deeplink::DeepLinkState::default())
        .manage(discovery::DiscoveryState::default())
        .setup(|app| {
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
        .invoke_handler(tauri::generate_handler![
            deeplink::deep_link_take_pending,
            discovery::discovery_start,
            discovery::discovery_stop,
            notification::notification_permission,
            notification::notification_request_permission,
            notification::notification_show,
            keychain::keychain_available,
            keychain::keychain_load_refresh_token,
            keychain::keychain_store_refresh_token,
            keychain::keychain_clear_refresh_token,
        ])
        .run(tauri::generate_context!())
        .expect("error while running momo desktop shell");
}
