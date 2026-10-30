//! Installation-wide language in the existing app-data root (ADR-0213 §5).
//! No account data, paths or UI copy are accepted from the webview.
use serde::Deserialize;
use std::path::Path;
use tauri::{
    menu::{Menu, PredefinedMenuItem as Item, Submenu, HELP_SUBMENU_ID, WINDOW_SUBMENU_ID},
    Manager,
};

const PREFERENCE_FILE: &str = "locale-preference.json";

fn valid_preference(value: &str) -> bool {
    matches!(
        value,
        "system" | "ko-KR" | "en-US" | "ja-JP" | "zh-Hans" | "zh-Hant" | "es-419" | "fr-FR"
    )
}

fn read_preference(root: &Path) -> Result<String, String> {
    let bytes = match std::fs::read(root.join(PREFERENCE_FILE)) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("system".into()),
        Err(_) => return Err("locale-read-failed".into()),
    };
    let preference: String = serde_json::from_slice(&bytes).map_err(|_| "locale-read-failed")?;
    Ok(if valid_preference(&preference) {
        preference
    } else {
        "system".into()
    })
}

fn write_preference(root: &Path, preference: &str) -> Result<(), String> {
    if !valid_preference(preference) {
        return Err("invalid-locale".into());
    }
    std::fs::create_dir_all(root).map_err(|_| "locale-write-failed")?;
    let temporary = root.join("locale-preference.tmp");
    let bytes = serde_json::to_vec(preference).map_err(|_| "locale-write-failed")?;
    std::fs::write(&temporary, bytes).map_err(|_| "locale-write-failed")?;
    std::fs::rename(temporary, root.join(PREFERENCE_FILE)).map_err(|_| "locale-write-failed".into())
}

// Sync commands execute in IPC order on the main thread: a single fixed preference file.
#[tauri::command]
pub fn locale_preference_read(app: tauri::AppHandle) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "locale-read-failed")?;
    read_preference(&root)
}

#[tauri::command]
pub fn locale_preference_write(app: tauri::AppHandle, preference: String) -> Result<(), String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "locale-write-failed")?;
    write_preference(&root, &preference)
}

/// The page formats these from core's desktop catalog. Native services/about are OS-owned.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MenuLabels {
    file: String,
    edit: String,
    view: String,
    window: String,
    help: String,
    undo: String,
    redo: String,
    cut: String,
    copy: String,
    paste: String,
    select_all: String,
    minimize: String,
    maximize: String,
    close: String,
    fullscreen: String,
    hide: String,
    hide_others: String,
    quit: String,
}

#[tauri::command]
pub fn locale_menu_set(app: tauri::AppHandle, labels: MenuLabels) -> Result<(), String> {
    let texts = [
        &labels.file,
        &labels.edit,
        &labels.view,
        &labels.window,
        &labels.help,
        &labels.undo,
        &labels.redo,
        &labels.cut,
        &labels.copy,
        &labels.paste,
        &labels.select_all,
        &labels.minimize,
        &labels.maximize,
        &labels.close,
        &labels.fullscreen,
        &labels.hide,
        &labels.hide_others,
        &labels.quit,
    ];
    if texts.iter().any(|text| {
        text.trim().is_empty() || text.len() > 256 || text.chars().any(char::is_control)
    }) {
        return Err("invalid-menu-label".into());
    }
    build_menu(&app, &labels).map_err(|_| "locale-menu-failed".into())
}

fn build_menu(app: &tauri::AppHandle, labels: &MenuLabels) -> tauri::Result<()> {
    // Match Tauri's default native menu, retaining predefined OS actions/shortcuts.
    let window = Submenu::with_id_and_items(
        app,
        WINDOW_SUBMENU_ID,
        &labels.window,
        true,
        &[
            &Item::minimize(app, Some(&labels.minimize))?,
            &Item::maximize(app, Some(&labels.maximize))?,
            &Item::close_window(app, Some(&labels.close))?,
        ],
    )?;
    let help = Submenu::with_id_and_items(
        app,
        HELP_SUBMENU_ID,
        &labels.help,
        true,
        &[
            #[cfg(not(target_os = "macos"))]
            &Item::about(app, None, None)?,
        ],
    )?;
    let menu = Menu::with_items(
        app,
        &[
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                app.package_info().name.clone(),
                true,
                &[
                    &Item::about(app, None, None)?,
                    &Item::separator(app)?,
                    &Item::services(app, None)?,
                    &Item::separator(app)?,
                    &Item::hide(app, Some(&labels.hide))?,
                    &Item::hide_others(app, Some(&labels.hide_others))?,
                    &Item::separator(app)?,
                    &Item::quit(app, Some(&labels.quit))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                &labels.file,
                true,
                &[
                    &Item::close_window(app, Some(&labels.close))?,
                    #[cfg(not(target_os = "macos"))]
                    &Item::quit(app, Some(&labels.quit))?,
                ],
            )?,
            &Submenu::with_items(
                app,
                &labels.edit,
                true,
                &[
                    &Item::undo(app, Some(&labels.undo))?,
                    &Item::redo(app, Some(&labels.redo))?,
                    &Item::separator(app)?,
                    &Item::cut(app, Some(&labels.cut))?,
                    &Item::copy(app, Some(&labels.copy))?,
                    &Item::paste(app, Some(&labels.paste))?,
                    &Item::select_all(app, Some(&labels.select_all))?,
                ],
            )?,
            #[cfg(target_os = "macos")]
            &Submenu::with_items(
                app,
                &labels.view,
                true,
                &[&Item::fullscreen(app, Some(&labels.fullscreen))?],
            )?,
            &window,
            &help,
        ],
    )?;
    app.set_menu(menu)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preference_survives_reopening_and_rejects_invalid_values() {
        let root = std::env::temp_dir().join(format!("oort-locale-test-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        assert_eq!(read_preference(&root).unwrap(), "system");
        write_preference(&root, "en-US").unwrap();
        assert_eq!(read_preference(&root).unwrap(), "en-US");
        assert!(write_preference(&root, "../other").is_err());
        assert_eq!(read_preference(&root).unwrap(), "en-US");
        std::fs::remove_file(root.join(PREFERENCE_FILE)).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn preference_commands_are_local_main_only() {
        let mut context = crate::context();
        let authority = context.runtime_authority_mut();
        for command in [
            "locale_preference_read",
            "locale_preference_write",
            "locale_menu_set",
        ] {
            assert!(authority
                .resolve_access(command, "main", "main", &tauri::ipc::Origin::Local)
                .is_some());
            assert!(authority
                .resolve_access(command, "other", "other", &tauri::ipc::Origin::Local)
                .is_none());
            assert!(authority
                .resolve_access(
                    command,
                    "main",
                    "main",
                    &tauri::ipc::Origin::Remote {
                        url: "https://example.invalid".parse().unwrap()
                    }
                )
                .is_none());
        }
    }
}
