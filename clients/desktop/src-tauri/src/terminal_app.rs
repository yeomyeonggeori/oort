// Open the OS terminal app (#2814 OB2-8, ADR-0193 D2 Phase 1).
//
// The AI 연결 step asks a person to log in to an official CLI (`claude`,
// `codex login`) or to run a one-line connection command. oort does not run
// either for them: the login belongs to the CLI (ADR-0193 D2), and the shell
// already runs exactly two CLI commands, the status probes in
// `harness_status.rs` (ADR-0190 D3 증보). This command adds no third one.
//
// So the whole surface is: bring Terminal.app to the front. The webview copies
// the command to the clipboard itself; the person pastes it.
//
//   open_terminal_app  (no arguments)  -> ()
//
// The boundary:
// 1. **No arguments.** Nothing the webview sends reaches a process: the command
//    takes no parameters, and program and argv are literals below. A
//    compromised page can at most bring Terminal to the front.
// 2. **No shell.** `/usr/bin/open` is run by absolute path, directly.
// 3. **macOS only.** Elsewhere the command refuses; the page keeps the copy
//    button, which is the whole instruction on those platforms.

use std::process::Command;

/// The complete argv. `-a Terminal` names the app; there is no document or
/// script argument, so Terminal opens a plain login shell window.
#[cfg(target_os = "macos")]
pub const OPEN_TERMINAL_ARGV: (&str, &[&str]) = ("/usr/bin/open", &["-a", "Terminal"]);

/// `async` with the wait on `spawn_blocking`, like `open_external_url`: a slow
/// `open` must not park the main thread or an async worker.
#[tauri::command]
pub async fn open_terminal_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let (program, args) = OPEN_TERMINAL_ARGV;
        let mut command = Command::new(program);
        command.args(args);
        let status = tauri::async_runtime::spawn_blocking(move || command.status())
            .await
            .map_err(|error| format!("terminal launcher did not run: {error}"))?;
        match status {
            Ok(status) if status.success() => Ok(()),
            Ok(status) => Err(format!("terminal launcher failed: {status}")),
            Err(error) => Err(format!("terminal launcher failed: {error}")),
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = Command::new;
        Err("unsupported: open the terminal and paste the copied command".to_string())
    }
}

#[cfg(test)]
mod tests {
    const SRC: &str = include_str!("terminal_app.rs");

    fn code_only() -> String {
        SRC.split("#[cfg(test)]")
            .next()
            .unwrap_or_default()
            .lines()
            .filter(|line| !line.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn the_command_takes_no_arguments() {
        assert!(
            code_only().contains("pub async fn open_terminal_app() -> Result<(), String>"),
            "open_terminal_app must stay parameterless"
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_argv_is_the_literal_open_a_terminal() {
        assert_eq!(
            super::OPEN_TERMINAL_ARGV,
            ("/usr/bin/open", &["-a", "Terminal"][..])
        );
    }

    #[test]
    fn no_cli_or_shell_is_started_from_here() {
        let code = code_only();
        for needle in [
            "\"claude\"",
            "\"codex\"",
            "\"sh\"",
            "\"-c\"",
            "do script",
            "osascript",
            ".command",
        ] {
            assert!(
                !code.contains(needle),
                "{needle} must not appear in terminal_app.rs code"
            );
        }
        assert_eq!(code.matches("Command::new(program)").count(), 1);
    }
}
