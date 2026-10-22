//! Window glass (blur-behind) and the app's native appearance — the desktop shell's half of
//! 「유리 배경」 (ADR-0189 증보 1 D4 · 증보 3 D6, AP-3 #4190).
//!
//! ## Provenance (Apache-2.0 §4)
//!
//! `window_vibrancy_set` is adapted from Buzz, `desktop/src-tauri/src/commands/window_vibrancy.rs`
//! (lines 1-108) at commit `af5bb0a` — <https://github.com/block/buzz>, Apache-2.0,
//! Copyright 2026 Block, Inc. This crate is Apache-2.0 as well (root `LICENSE`).
//!
//! Changes from the original:
//!
//! * the command is named `window_vibrancy_set` (oort's `<noun>_<verb>` command names);
//! * the material list is cut from eight names to the three oort uses (`sidebar` is the
//!   default; unknown names fall back to it exactly as in the original);
//! * the material and scheme parsing is split into pure functions with tests, because the
//!   original's only coverage was a running window;
//! * `app_theme_set` is new (Buzz never calls `set_theme`): it points the app's native
//!   appearance at the scheme the web layer is showing, so a `Sidebar` material is not
//!   blurred light under a dark app (or the reverse);
//! * error strings and comments are rewritten.
//!
//! The invariant below is the original's, kept because it is the reason the code is shaped
//! this way.
//!
//! ## Invariant
//!
//! The main window is created opaque (`tauri.conf.json` has no `transparent`) and the NSWindow
//! is never made transparent at runtime. Behind-window vibrancy renders correctly inside an
//! opaque window — Finder and Notes draw their sidebars the same way — so glass only needs the
//! WKWebView *canvas* to stop painting its own white, which this command does on the enable
//! path. When glass is turned off the canvas may stay non-drawing (wry's `drawsBackground` KVC
//! key only goes one way at runtime). That is harmless: the web layer's glass-off CSS paints an
//! opaque page again and the always-opaque NSWindow sits beneath it.
//!
//! Why not `transparent: true`? A window created transparent makes tao call
//! `NSWindow.setOpaque(false)` and `setBackgroundColor(clearColor)`, and tauri has no runtime
//! `setOpaque(true)`, so the compositor would keep blending the whole window with glass off.
//!
//! Vibrancy puts an `NSVisualEffectView` behind the webview. There is no intensity setting at
//! the OS level, only material presets; the web layer tunes how much desktop shows through by
//! changing the opacity of its own tint (`design/appearance/glass.css`).
//!
//! ## Private API
//!
//! `set_background_color` on macOS writes WKWebView's private `drawsBackground` key
//! (wry `transparent` feature, switched on by tauri's `macos-private-api` feature and the
//! `macOSPrivateApi` config entry, which must be set together). A binary that carries it
//! cannot be submitted to the Mac App Store. The desktop app ships as a notarized DMG
//! (ADR-0189 증보 3 D6); a Mac App Store build must not enable this feature.
//!
//! The commands are no-ops (`Ok(())`) off macOS so the shared web layer can call them without
//! a platform check of its own — it still checks, to tell the person the truth.

use tauri::AppHandle;
#[cfg(target_os = "macos")]
use tauri::Manager;

/// The `NSVisualEffectMaterial` names the web layer may ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Material {
    /// The Finder/Notes sidebar material. The default, and what 「유리 배경」 uses.
    Sidebar,
    UnderWindowBackground,
    HudWindow,
}

/// `material` as the web layer spelled it. Anything unknown is `Sidebar` (the original's rule).
pub fn parse_material(name: Option<&str>) -> Material {
    match name {
        Some("under-window-background") => Material::UnderWindowBackground,
        Some("hud-window") => Material::HudWindow,
        _ => Material::Sidebar,
    }
}

/// The scheme the web layer is showing. `System` hands the choice back to macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scheme {
    Light,
    Dark,
    System,
}

/// `scheme` as the web layer spelled it (`"light"`, `"dark"`, otherwise follow the system).
pub fn parse_scheme(name: &str) -> Scheme {
    match name {
        "light" => Scheme::Light,
        "dark" => Scheme::Dark,
        _ => Scheme::System,
    }
}

#[cfg(target_os = "macos")]
fn native_material(material: Material) -> ::window_vibrancy::NSVisualEffectMaterial {
    use ::window_vibrancy::NSVisualEffectMaterial;
    match material {
        Material::Sidebar => NSVisualEffectMaterial::Sidebar,
        Material::UnderWindowBackground => NSVisualEffectMaterial::UnderWindowBackground,
        Material::HudWindow => NSVisualEffectMaterial::HudWindow,
    }
}

/// Turn the blur-behind layer of the main window on or off.
///
/// On: any earlier layer is cleared first (`apply_vibrancy` appends a tagged view on every
/// call while `clear_vibrancy` removes only one, so repeated enables would stack blur views),
/// the blur is installed, and only then is the webview canvas made transparent. In that order a
/// failure of the second step leaves vibrancy behind an opaque page, never a see-through page.
/// Either half-state corrects itself on the next call.
///
/// Off: the layer is removed. Nothing else is undone, see the invariant above.
///
/// Runs on the main thread (a plain, non-async command): AppKit views are touched here and
/// `apply_vibrancy` refuses any other thread.
#[tauri::command]
pub fn window_vibrancy_set(
    #[allow(unused_variables)] enabled: bool,
    #[allow(unused_variables)] material: Option<String>,
    #[allow(unused_variables)] app: AppHandle,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use ::window_vibrancy::{apply_vibrancy, clear_vibrancy};

        let window = app
            .get_webview_window("main")
            .ok_or_else(|| "main window not found".to_string())?;

        if !enabled {
            clear_vibrancy(&window).map_err(|e| e.to_string())?;
            return Ok(());
        }

        let material = native_material(parse_material(material.as_deref()));
        let _ = clear_vibrancy(&window);
        apply_vibrancy(&window, material, None, None).map_err(|e| e.to_string())?;

        // The webview layer only: `WebviewWindow::set_background_color` also writes the
        // NSWindow layer, which has to stay opaque.
        let webview: &tauri::Webview<_> = window.as_ref();
        webview
            .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[cfg(not(target_os = "macos"))]
    {
        Ok(())
    }
}

/// Point the app's native appearance at the scheme the web layer shows (`"light"`, `"dark"`),
/// or give it back to the system (`"system"`, or anything else).
///
/// Why: the `Sidebar` material blurs light or dark by the window's *effective appearance*, not
/// by the page. A page pinned to dark on a light macOS would otherwise sit on a light, washed
/// out blur. (Legibility does not depend on it: the tint's contrast is worked out for pure
/// black and pure white behind it, which bounds every blur.) The web layer asks only while
/// glass is on and the scheme is pinned, because the app appearance also decides the page's
/// `prefers-color-scheme`.
#[tauri::command]
pub fn app_theme_set(scheme: String, app: AppHandle) -> Result<(), String> {
    let theme = match parse_scheme(&scheme) {
        Scheme::Light => Some(tauri::Theme::Light),
        Scheme::Dark => Some(tauri::Theme::Dark),
        Scheme::System => None,
    };
    app.set_theme(theme);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn material_names_map_and_unknown_names_fall_back_to_sidebar() {
        assert_eq!(parse_material(None), Material::Sidebar);
        assert_eq!(parse_material(Some("sidebar")), Material::Sidebar);
        assert_eq!(
            parse_material(Some("under-window-background")),
            Material::UnderWindowBackground
        );
        assert_eq!(parse_material(Some("hud-window")), Material::HudWindow);
        // Names that Buzz accepts but oort does not: they must not reach AppKit.
        for name in [
            "popover",
            "menu",
            "titlebar",
            "fullscreen-ui",
            "header-view",
            "",
        ] {
            assert_eq!(parse_material(Some(name)), Material::Sidebar, "{name}");
        }
    }

    #[test]
    fn scheme_names_map_and_anything_else_is_the_system() {
        assert_eq!(parse_scheme("light"), Scheme::Light);
        assert_eq!(parse_scheme("dark"), Scheme::Dark);
        assert_eq!(parse_scheme("system"), Scheme::System);
        // A webview that sends a typo must not pin the app to one appearance.
        for name in ["", "Dark", "LIGHT", "auto", "dark "] {
            assert_eq!(parse_scheme(name), Scheme::System, "{name:?}");
        }
    }
}
