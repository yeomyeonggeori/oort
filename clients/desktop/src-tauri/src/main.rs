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
    // The CLI runs this binary as the `headersHelper` of its Agent Port setting
    // (#3389, ADR-0190 D3-h): one lowercase agent id as the only argument. Print
    // one JSON line and exit, before anything of the app starts.
    #[cfg(all(unix, not(any(target_os = "ios", target_os = "android"))))]
    {
        let args: Vec<String> = std::env::args().skip(1).collect();
        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        if let Some(code) = momo_desktop_lib::agent_port::run_header_helper(&args, home.as_deref())
        {
            std::process::exit(code);
        }
    }
    momo_desktop_lib::run()
}
