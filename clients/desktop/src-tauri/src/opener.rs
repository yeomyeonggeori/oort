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

/// Characters that mean something to a command interpreter and NOTHING to a
/// valid URL: RFC 3986 requires every one of them to be percent-encoded, so
/// refusing them costs no real link.
///
/// The set is the reason the R1 list was half a guard. It stopped `&` and `|`
/// but let `<`, `>` and `^` through, and `>` is the redirection operator: a
/// launcher that reaches a shell would have written a file instead of opening a
/// page. `%` is deliberately NOT here, because percent-encoding is the most
/// common shape a real link arrives in; the Windows path below stops going
/// through `cmd` instead, so there is no `%VAR%` expansion left to defend
/// against.
const SHELL_METACHARACTERS: [char; 7] = ['"', '\'', '&', '|', '<', '>', '^'];

/// https only, no whitespace, no control characters, no shell metacharacters.
///
/// The argument goes to `exec` as one argv entry, never through a shell, so this
/// is defence in depth rather than the only guard. It still matters: this is the
/// boundary where webview-supplied data becomes an OS process argument, and the
/// launcher on the other side is a different program on every platform.
fn is_openable(url: &str) -> bool {
    if url.len() > MAX_URL_LEN || !url.starts_with("https://") {
        return false;
    }
    !url.chars()
        .any(|c| c.is_whitespace() || c.is_control() || SHELL_METACHARACTERS.contains(&c))
}

/// Hand one https URL to the platform browser.
///
/// `async` on purpose: a synchronous `#[tauri::command]` runs on the main
/// thread, and waiting there on a child process would freeze the window for as
/// long as the launcher takes to answer.
///
/// The wait itself goes to `spawn_blocking`. `Command::status()` blocks the
/// thread it is called on, and inside an async command that thread is an async
/// runtime worker: R1 moved the wait off the main thread and parked a worker
/// instead, which is a smaller version of the same bug (a slow `open` would
/// stall unrelated commands sharing the pool).
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

    // NOT `cmd /C start`. That path is a command interpreter, so the URL is
    // parsed twice: `%…%` pairs expand as environment variables, which quietly
    // corrupts exactly the percent-encoded links this product sends most often,
    // and any metacharacter that slipped the filter above would be read as
    // syntax. rundll32 is invoked through CreateProcess with the URL as a plain
    // argument, so there is no second parse to defend.
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = Command::new("rundll32.exe");
        c.arg("url.dll,FileProtocolHandler");
        c
    };

    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = Command::new("xdg-open");

    command.arg(&url);

    let status = tauri::async_runtime::spawn_blocking(move || command.status())
        .await
        .map_err(|error| format!("browser launcher did not run: {error}"))?;

    match status {
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
            "oort://join?code=1",
            "momo://join?code=1",
            "javascript:alert(1)",
            "https://example.com/a b",
            "https://example.com/a\nopen -a Calculator",
            "https://example.com/a&calc",
            "https://example.com/a|calc",
            "https://example.com/\"x\"",
            // R2 M5: every one of these is a shell operator and none of them is
            // legal unencoded in a URL.
            "https://example.com/a>out.txt",
            "https://example.com/a<in.txt",
            "https://example.com/a^b",
        ] {
            assert!(!is_openable(url), "{url} must be refused");
        }
    }

    #[test]
    fn accepts_the_percent_encoding_a_real_link_arrives_with() {
        // The Windows launcher no longer goes through cmd, so `%` needs no
        // filtering, and filtering it would have broken the common case: a
        // branch name with a slash or a query value with a space.
        assert!(is_openable(
            "https://github.com/Dawn-kim-official/momo/tree/feat%2F803-artifact-cards"
        ));
        assert!(is_openable(
            "https://example.com/search?q=momo%20diff%20card"
        ));
    }

    #[test]
    fn refuses_an_absurdly_long_url() {
        let long = format!("https://example.com/{}", "a".repeat(4_096));
        assert!(!is_openable(&long));
    }
}
