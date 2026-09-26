//! What a signed build needs before a huddle can open the microphone
//! (#2761, ADR-0122 D-H3).
//!
//! * `NSMicrophoneUsageDescription` in `Info.plist`. It is the sentence in the
//!   macOS permission prompt, and TCC refuses an app that asks for the
//!   microphone without one.
//! * `com.apple.security.device.audio-input` in the entitlements the bundler
//!   signs with. The bundler signs with the hardened runtime by default, and
//!   under it TCC denies the microphone without a prompt when this entitlement
//!   is missing.
//! * `tauri.conf.json > bundle > macOS > entitlements` pointing at that file.
//!   Without the pointer the file exists and nothing signs with it.
//!
//! None of these fail a debug run or a unit test, and an unsigned dev build
//! does not apply the hardened runtime, so the gap only shows in the DMG. The
//! same contract is pinned from the web side in
//! `clients/web/src/app/desktopMicPermission.test.ts`, which CI runs.

use serde_json::Value;

const INFO_PLIST: &str = include_str!("../Info.plist");
const CONF: &str = include_str!("../tauri.conf.json");
const AUDIO_INPUT: &str = "com.apple.security.device.audio-input";

/// The value element that follows `<key>{key}</key>`, with XML comments
/// skipped. `None` when the key is absent.
fn value_after_key<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
    let marker = format!("<key>{key}</key>");
    let mut rest = &plist[plist.find(&marker)? + marker.len()..];
    loop {
        rest = rest.trim_start();
        if let Some(after) = rest.strip_prefix("<!--") {
            rest = &after[after.find("-->")? + 3..];
            continue;
        }
        let end = if rest.starts_with("<string>") {
            rest.find("</string>")? + "</string>".len()
        } else {
            rest.find('>')? + 1
        };
        return Some(&rest[..end]);
    }
}

fn mac_bundle(conf: &Value) -> &Value {
    &conf["bundle"]["macOS"]
}

#[test]
fn info_plist_explains_the_microphone_prompt() {
    let value = value_after_key(INFO_PLIST, "NSMicrophoneUsageDescription")
        .expect("Info.plist has no NSMicrophoneUsageDescription");
    let text = value
        .strip_prefix("<string>")
        .and_then(|v| v.strip_suffix("</string>"))
        .expect("NSMicrophoneUsageDescription is not a <string>")
        .trim();
    assert!(!text.is_empty(), "NSMicrophoneUsageDescription is empty");
    // The prompt says why, in the app's language, and that it is huddles only.
    assert!(text.contains("허들"), "prompt does not mention 허들: {text}");
    assert!(text.contains("마이크"), "prompt does not mention 마이크: {text}");
    assert!(
        !text.contains('—') && !text.contains('–'),
        "user-visible copy has an em-dash: {text}"
    );
}

#[test]
fn the_bundler_signs_with_an_entitlements_file() {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    let path = mac_bundle(&conf)["entitlements"]
        .as_str()
        .expect("tauri.conf.json bundle.macOS.entitlements is not set");
    let full = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    assert!(full.is_file(), "entitlements file missing: {}", full.display());
}

#[test]
fn the_entitlements_grant_audio_input() {
    let conf: Value = serde_json::from_str(CONF).unwrap();
    let path = mac_bundle(&conf)["entitlements"]
        .as_str()
        .expect("tauri.conf.json bundle.macOS.entitlements is not set");
    let file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path);
    let plist = std::fs::read_to_string(&file).expect("read entitlements");
    assert_eq!(
        value_after_key(&plist, AUDIO_INPUT),
        Some("<true/>"),
        "{} does not set {AUDIO_INPUT} to true",
        file.display()
    );
}

#[test]
fn the_hardened_runtime_stays_on() {
    // The entitlement only matters under the hardened runtime, and notarization
    // requires the runtime. Tauri defaults it to true; turning it off would make
    // the local build look fine and the notarized one fail.
    let conf: Value = serde_json::from_str(CONF).unwrap();
    assert_ne!(
        mac_bundle(&conf)["hardenedRuntime"],
        Value::Bool(false),
        "bundle.macOS.hardenedRuntime must not be false"
    );
}

#[test]
fn value_after_key_reads_past_comments_and_rejects_absence() {
    let plist = "<dict><key>a</key><!-- note --><true/><key>b</key>\n\t<string>x</string></dict>";
    assert_eq!(value_after_key(plist, "a"), Some("<true/>"));
    assert_eq!(value_after_key(plist, "b"), Some("<string>x</string>"));
    assert_eq!(value_after_key(plist, "c"), None);
    assert_eq!(
        value_after_key("<key>a</key><false/>", "a"),
        Some("<false/>")
    );
}
