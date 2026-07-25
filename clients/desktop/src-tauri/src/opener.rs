// Open an external link in the OS browser.
//
// The web bundle renders `브라우저에서 열기` on commit/PR artifact cards. In a
// browser tab that is an ordinary `target="_blank"` anchor. Inside this shell it
// is not: wry does not implement WKWebView's `createWebViewWith`, so a new-window
// request is dropped and the labelled action does nothing at all — a dead button
// in the desktop build only (MOMO-620 R1 H3).
//
// So the shell does the part the webview cannot, which is where OS behaviour
// belongs (ADR-0133 §2, design-taste-web §1). This is deliberately an APP
// command rather than tauri-plugin-opener: the plugin's surface is "open a path,
// a file or a URL with any handler", and the only thing this product needs is
// "hand one https URL to the default browser". A command that can do exactly
// that cannot be talked into doing anything else by a compromised webview.
//
// The URL is re-validated HERE and not only in TypeScript. `clients/web` already
// refuses anything that is not a credential-free https address, but a native
// command must not inherit its caller's discipline: this is the boundary where
// webview-supplied data becomes an OS process argument.

use std::process::Command;

/// Longest address this command will hand to the OS. Real commit and PR links
/// are far below it; anything longer is not a link somebody typed.
const MAX_URL_LEN: usize = 2_048;

/// https only, no whitespace, no control or quoting characters.
///
/// The argument goes to `exec` as one argv entry, never through a shell, so this
/// is defence in depth rather than the only guard. It still matters: on Windows
/// the launcher IS a shell, and `https://` plus "no whitespace, no quotes" is
/// what keeps that entry from becoming a second command.
fn is_openable(url: &str) -> bool {
    if url.len() > MAX_URL_LEN || !url.starts_with("https://") {
        return false;
    }
    !url.chars().any(|c| {
        c.is_whitespace() || c.is_control() || c == '"' || c == '\'' || c == '&' || c == '|'
    })
}

/// Hand one https URL to the platform browser.
///
/// `async` on purpose: a synchronous `#[tauri::command]` runs on the main
/// thread, and waiting there on a child process would freeze the window for as
/// long as `open` takes to answer.
///
/// Errors are returned rather than swallowed. The card shows an inline failure
/// with the address so the person can copy it, which is only possible if this
/// side admits the launch did not happen.
#[tauri::command]
pub async fn open_external_url(url: String) -> Result<(), String> {
    if !is_openable(&url) {
        return Err("refused: not a plain https url".to_string());
    }

    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = Command::new("/usr/bin/open");
        // `--` so a URL can never be read as an option to `open`.
        c.arg("--");
        c
    };

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("cmd");
        // The empty string is `start`'s title argument; without it `start` reads
        // the URL as the window title and opens nothing.
        c.args(["/C", "start", ""]);
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command.arg(&url);

    match command.status() {
        Ok(status) if status.success() => Ok(()),
        Ok(status) => Err(format!("browser launcher failed: {status}")),
        Err(error) => Err(format!("browser launcher failed: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::is_openable;

    #[test]
    fn accepts_a_plain_https_link() {
        assert!(is_openable(
            "https://github.com/Dawn-kim-official/momo/pull/803"
        ));
    }

    #[test]
    fn refuses_everything_that_is_not_plain_https() {
        for url in [
            "http://github.com/x/y",
            "file:///etc/passwd",
            "momo://join?code=1",
            "javascript:alert(1)",
            "https://example.com/a b",
            "https://example.com/a\nopen -a Calculator",
            "https://example.com/a&calc",
            "https://example.com/a|calc",
            "https://example.com/\"x\"",
        ] {
            assert!(!is_openable(url), "{url} must be refused");
        }
    }

    #[test]
    fn refuses_an_absurdly_long_url() {
        let long = format!("https://example.com/{}", "a".repeat(4_096));
        assert!(!is_openable(&long));
    }
}
