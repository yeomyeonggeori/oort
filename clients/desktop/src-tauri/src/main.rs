// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // A harness hook runs this binary as a tiny client (#2776): forward two
    // event names to the app's pane-signal socket and exit 0, before anything
    // of the app (window, plugins, single instance) starts.
    #[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        if args.first().map(String::as_str) == Some(momo_desktop_lib::pane_signal::HOOK_FLAG) {
            std::process::exit(momo_desktop_lib::pane_signal::run_client(&args[1..]));
        }
    }
    momo_desktop_lib::run()
}
