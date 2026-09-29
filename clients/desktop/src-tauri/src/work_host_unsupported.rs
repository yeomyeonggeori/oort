// The work host commands on a desktop platform without the sidecar (#2778).
// ADR-0188 D2's host is the macOS app: its app ↔ workd channel is checked by
// code signature, which only macOS has here. The command names exist so the
// handler table is one list; each answers `unsupported_platform`.

#[derive(Default)]
pub struct WorkHostState;

impl WorkHostState {
    pub fn stop_now(&self) {}
}

pub fn start_if_registered(_app: &tauri::AppHandle) {}

const UNSUPPORTED: &str = "unsupported_platform";

#[tauri::command]
pub async fn work_host_status() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn work_host_register() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn work_host_start() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn work_host_stop() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn work_host_forget() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn work_host_set_remote_profile() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn work_host_prepare_remote_profile() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

/// The remote-work sign-in folder needs the sidecar: nothing here.
pub fn remote_profile_for_pty(
    _app: &tauri::AppHandle,
    _harness: &str,
    _label: &str,
) -> Result<(&'static str, std::path::PathBuf), String> {
    Err(UNSUPPORTED.into())
}
