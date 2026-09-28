// The device key commands on a desktop platform without the Secure Enclave
// path (#3025). ADR-0146 개정 D-3's key is the macOS app's; the command names
// exist so the handler table is one list, and each answers
// `unsupported_platform` — never a software key.

#[derive(Default)]
pub struct DeviceKeyState;

pub fn pin_after_start(_app: &tauri::AppHandle) {}

const UNSUPPORTED: &str = "unsupported_platform";

#[tauri::command]
pub async fn device_key_status() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_create() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_bind_root() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_sign_control() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_sign_endorse() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_sign_revoke() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_deliver_revocation() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}

#[tauri::command]
pub async fn device_key_sign_rebind() -> Result<(), String> {
    Err(UNSUPPORTED.into())
}
