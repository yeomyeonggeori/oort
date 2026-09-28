//! The Secure Enclave half — ADR-0146 개정 2026-09-28 D-1·D-3.
//!
//! One P-256 key, generated **inside** the Secure Enclave and never anywhere
//! else:
//!
//! * token `kSecAttrTokenIDSecureEnclave` — there is no software branch in this
//!   file. A Mac without an enclave, an unsigned build, or a signed build
//!   without the `keychain-access-groups` entitlement gets a named refusal
//!   (`unsupported` / `unsigned_build` / `entitlement_missing`), never a key
//!   that would look the same to the server and to workd.
//! * access control `PrivateKeyUsage | UserPresence`, accessibility
//!   `WhenUnlockedThisDeviceOnly` — Touch ID, or the login password on a Mac
//!   without it; never synchronised, never in a backup restored elsewhere.
//! * the data-protection keychain, always with the **app-only** access group
//!   `<TEAM>.app.momo.desktop.devicekey`, passed explicitly. The workd sidecar
//!   is not entitled to it: the person's key and the host key are different
//!   keys in different processes (D-3).
//!
//! The reuse window (D-3, ≤300 s) is an [`AuthWindow`]: one evaluated
//! `LAContext` kept on the signing thread and handed to every signature for at
//! most that long, then invalidated. `touchIDAuthenticationAllowableReuseDuration`
//! is set to **0**: Apple's header documents it as reuse of a lock-screen
//! unlock ("It does not allow reusing previous biometric matches in
//! application"), so a non-zero value would let unlocking the Mac stand in for
//! the first signature's Touch ID (security review M2).
//!
//! Every Apple call here is `runtime-unverified` until an owner-approved signed
//! build runs on a Mac with Touch ID (M7).

use std::ffi::c_void;
use std::time::{Duration, Instant};

use core_foundation::base::{CFType, TCFType};
use core_foundation::boolean::CFBoolean;
use core_foundation::data::CFData;
use core_foundation::dictionary::CFDictionary;
use core_foundation::error::CFError;
use core_foundation::number::CFNumber;
use core_foundation::string::CFString;
use core_foundation_sys::base::{CFOptionFlags, CFTypeRef};
use core_foundation_sys::dictionary::CFDictionaryRef;
use core_foundation_sys::string::CFStringRef;
use objc2::msg_send;
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject};
use objc2_foundation::NSString;
use security_framework::access_control::{ProtectionMode, SecAccessControl};
use security_framework::key::{Algorithm, SecKey};
use security_framework::os::macos::code_signing::{Flags, SecCode};
use security_framework_sys::access_control::{
    kSecAccessControlPrivateKeyUsage, kSecAccessControlUserPresence,
};
use security_framework_sys::item::{
    kSecAttrAccessControl, kSecAttrAccessGroup, kSecAttrIsPermanent, kSecAttrKeyClass,
    kSecAttrKeyClassPrivate, kSecAttrKeySizeInBits, kSecAttrKeyType,
    kSecAttrKeyTypeECSECPrimeRandom, kSecAttrLabel, kSecAttrTokenID, kSecAttrTokenIDSecureEnclave,
    kSecClass, kSecClassKey, kSecPrivateKeyAttrs, kSecReturnRef, kSecUseAuthenticationContext,
    kSecUseDataProtectionKeychain,
};
use security_framework_sys::keychain_item::SecItemCopyMatching;

use super::payload;

/// The access group without the team prefix. Declared only by the signed
/// app's `Entitlements.app.plist`, which `publish_next_build.sh` applies with
/// the embedded Developer ID provisioning profile (#3025); never by the
/// bundler's `Entitlements.plist`, which also signs the workd sidecar.
pub const ACCESS_GROUP_SUFFIX: &str = "app.momo.desktop.devicekey";
/// The key's application tag: one key per Mac user per app.
pub const KEY_TAG: &[u8] = b"app.momo.desktop.devicekey.p256-signing-v1";
const KEY_LABEL: &str = "oort device key (P-256, Secure Enclave)";
/// The device key's access: Touch ID / login password per signature (D-3),
/// readable only while unlocked.
pub const KEY_ACCESS_FLAGS: CFOptionFlags =
    kSecAccessControlPrivateKeyUsage | kSecAccessControlUserPresence;
pub const KEY_PROTECTION: ProtectionMode = ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly;

/// The refresh key (#3106, ADR-0146 D-7 증보 #3079): a SECOND enclave key,
/// a different item (its own tag) in the same app-only group. It signs only
/// `momo.human.refresh_proof.v1` (`session_refresh::proof`), in the background
/// with no dialog, so it has `PrivateKeyUsage` and nothing else — no
/// presence, no biometry — and `AfterFirstUnlockThisDeviceOnly`, so a refresh
/// of a locked Mac overnight still signs (a refusal there would read as a
/// sign-out under `require`). It has no trust role: the server keeps it in
/// `session_refresh_key`, never in `member_device_key`.
pub const REFRESH_KEY_TAG: &[u8] = b"app.momo.desktop.refreshkey.p256-v1";
const REFRESH_KEY_LABEL: &str = "oort refresh key (P-256, Secure Enclave)";
pub const REFRESH_KEY_ACCESS_FLAGS: CFOptionFlags = kSecAccessControlPrivateKeyUsage;
pub const REFRESH_KEY_PROTECTION: ProtectionMode =
    ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly;

/// D-3: the reuse window is 0–300 s and defaults to 300.
pub const REUSE_WINDOW_MAX_SECS: u64 = 300;
pub const REUSE_WINDOW_DEFAULT_SECS: u64 = 300;

const ERR_SEC_MISSING_ENTITLEMENT: i64 = -34018;
const ERR_SEC_ITEM_NOT_FOUND: i32 = -25300;
const ERR_SEC_USER_CANCELED: i64 = -128;
const ERR_SEC_AUTH_FAILED: i64 = -25293;
const ERR_SEC_UNIMPLEMENTED: i64 = -4;
const ERR_SEC_NOT_AVAILABLE: i64 = -25291;
/// `LAErrorUserCancel`, `LAErrorSystemCancel`, `LAErrorAppCancel`, `LAErrorUserFallback`.
const LA_CANCELS: [i64; 4] = [-2, -4, -9, -3];

#[link(name = "Security", kind = "framework")]
extern "C" {
    static kSecAttrApplicationTag: CFStringRef;
    static kSecCodeInfoTeamIdentifier: CFStringRef;
    fn SecCodeCopySigningInformation(
        code: *const c_void,
        flags: u32,
        information: *mut CFDictionaryRef,
    ) -> i32;
}

// LAContext lives in LocalAuthentication; objc2 looks the class up by name.
#[link(name = "LocalAuthentication", kind = "framework")]
extern "C" {}

/// Named refusals. None of them carries key material; every one of them ends
/// the operation — there is no fallback key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EnclaveError {
    /// No Secure Enclave, or the platform refused to make an enclave key.
    Unsupported(&'static str),
    /// Not team-signed (a local development build): no access group exists.
    UnsignedBuild,
    /// Signed, but `keychain-access-groups` (and its provisioning profile)
    /// are missing: errSecMissingEntitlement (-34018).
    EntitlementMissing,
    Absent,
    Cancelled,
    AuthFailed,
    Failed(String),
}

impl EnclaveError {
    pub fn code(&self) -> String {
        match self {
            EnclaveError::Unsupported(why) => format!("device_key_unsupported: {why}"),
            EnclaveError::UnsignedBuild => "device_key_unsigned_build".into(),
            EnclaveError::EntitlementMissing => "device_key_entitlement_missing".into(),
            EnclaveError::Absent => "device_key_absent".into(),
            EnclaveError::Cancelled => "device_key_cancelled".into(),
            EnclaveError::AuthFailed => "device_key_auth_failed".into(),
            EnclaveError::Failed(why) => format!("device_key_failed: {why}"),
        }
    }

    /// A status word for `device_key_status` (no detail).
    pub fn support(&self) -> &'static str {
        match self {
            EnclaveError::Unsupported(_) => "unsupported",
            EnclaveError::UnsignedBuild => "unsigned_build",
            EnclaveError::EntitlementMissing => "entitlement_missing",
            EnclaveError::Absent => "absent",
            _ => "error",
        }
    }
}

/// OSStatus / CFError code → refusal. Pure, so the "no fallback" mapping is
/// tested without an enclave.
pub fn classify(code: i64, during: &'static str) -> EnclaveError {
    match code {
        ERR_SEC_MISSING_ENTITLEMENT => EnclaveError::EntitlementMissing,
        c if c == i64::from(ERR_SEC_ITEM_NOT_FOUND) => EnclaveError::Absent,
        ERR_SEC_USER_CANCELED => EnclaveError::Cancelled,
        c if LA_CANCELS.contains(&c) && during == "sign" => EnclaveError::Cancelled,
        ERR_SEC_AUTH_FAILED => EnclaveError::AuthFailed,
        ERR_SEC_UNIMPLEMENTED | ERR_SEC_NOT_AVAILABLE if during == "create" => {
            EnclaveError::Unsupported("no_secure_enclave")
        }
        other => EnclaveError::Failed(format!("{during} {other}")),
    }
}

/// `<TEAM>.app.momo.desktop.devicekey`, or `UnsignedBuild`. The team is read
/// from this binary's own signature, so a same-user process cannot configure
/// a different group.
pub fn access_group() -> Result<String, EnclaveError> {
    let team = own_team_identifier().map_err(EnclaveError::Failed)?;
    access_group_for(team.as_deref())
}

pub fn access_group_for(team: Option<&str>) -> Result<String, EnclaveError> {
    match team {
        Some(team)
            if team.len() == 10
                && team
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()) =>
        {
            Ok(format!("{team}.{ACCESS_GROUP_SUFFIX}"))
        }
        Some(_) => Err(EnclaveError::Failed("team identifier shape".into())),
        None => Err(EnclaveError::UnsignedBuild),
    }
}

fn own_team_identifier() -> Result<Option<String>, String> {
    let code =
        SecCode::for_self(Flags::empty()).map_err(|error| format!("SecCodeCopySelf: {error}"))?;
    let mut info: CFDictionaryRef = std::ptr::null();
    // SAFETY: `code` is live; `info` is a valid out pointer that, on success,
    // holds a +1 dictionary owned below. `kSecCSSigningInformation` = 1 << 1.
    let status = unsafe {
        SecCodeCopySigningInformation(
            code.as_concrete_TypeRef() as *const c_void,
            1 << 1,
            &mut info,
        )
    };
    if status != 0 || info.is_null() {
        // An unsigned binary still answers; a failure here is not "unsigned".
        return Err(format!("SecCodeCopySigningInformation: {status}"));
    }
    // SAFETY: Copy rule.
    let info: CFDictionary = unsafe { CFDictionary::wrap_under_create_rule(info) };
    // SAFETY: an immutable framework constant.
    let key = unsafe { kSecCodeInfoTeamIdentifier };
    let Some(value) = info.find(key as *const c_void) else {
        return Ok(None);
    };
    // SAFETY: documented as a CFString.
    let team = unsafe { CFString::wrap_under_get_rule(*value as CFStringRef) }.to_string();
    Ok((!team.is_empty()).then_some(team))
}

fn key_of(raw: CFStringRef) -> CFString {
    // SAFETY: framework constants are immortal CFStrings.
    unsafe { CFString::wrap_under_get_rule(raw) }
}

fn private_key_query(
    tag: &[u8],
    group: &str,
    context: Option<&AnyObject>,
) -> CFDictionary<CFString, CFType> {
    let mut pairs: Vec<(CFString, CFType)> = vec![
        // SAFETY (all `unsafe` reads below): immutable framework constants.
        (
            key_of(unsafe { kSecClass }),
            key_of(unsafe { kSecClassKey }).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrKeyClass }),
            key_of(unsafe { kSecAttrKeyClassPrivate }).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrApplicationTag }),
            CFData::from_buffer(tag).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrAccessGroup }),
            CFString::new(group).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrTokenID }),
            key_of(unsafe { kSecAttrTokenIDSecureEnclave }).into_CFType(),
        ),
        (
            key_of(unsafe { kSecUseDataProtectionKeychain }),
            CFBoolean::true_value().into_CFType(),
        ),
        (
            key_of(unsafe { kSecReturnRef }),
            CFBoolean::true_value().into_CFType(),
        ),
    ];
    if let Some(context) = context {
        // SAFETY: an Objective-C object is a valid CFTypeRef for retain/release.
        let value =
            unsafe { CFType::wrap_under_get_rule(context as *const AnyObject as CFTypeRef) };
        pairs.push((key_of(unsafe { kSecUseAuthenticationContext }), value));
    }
    CFDictionary::from_CFType_pairs(&pairs)
}

/// The enclave key's handle, or `None`. Finding the handle needs no
/// authentication; using it to sign does.
pub fn find(group: &str, context: Option<&AnyObject>) -> Result<Option<SecKey>, EnclaveError> {
    find_tagged(KEY_TAG, group, context)
}

/// The refresh key's handle, or `None` (#3106). Signing with it needs no
/// authentication either.
pub fn find_refresh_key(group: &str) -> Result<Option<SecKey>, EnclaveError> {
    find_tagged(REFRESH_KEY_TAG, group, None)
}

fn find_tagged(
    tag: &[u8],
    group: &str,
    context: Option<&AnyObject>,
) -> Result<Option<SecKey>, EnclaveError> {
    let query = private_key_query(tag, group, context);
    let mut out: CFTypeRef = std::ptr::null();
    // SAFETY: a valid query dictionary and out pointer.
    let status = unsafe { SecItemCopyMatching(query.as_concrete_TypeRef(), &mut out) };
    match status {
        0 if !out.is_null() => {
            // SAFETY: kSecReturnRef on a key query answers a +1 SecKeyRef.
            Ok(Some(unsafe { SecKey::wrap_under_create_rule(out as _) }))
        }
        ERR_SEC_ITEM_NOT_FOUND => Ok(None),
        other => Err(classify(i64::from(other), "find")),
    }
}

/// Create the key. Refuses when one exists (a second key would silently
/// replace the root every paired phone was endorsed by).
pub fn create(group: &str) -> Result<SecKey, EnclaveError> {
    create_tagged(KEY_TAG, KEY_LABEL, KEY_PROTECTION, KEY_ACCESS_FLAGS, group)
}

/// Create the refresh key (#3106). Refuses when one exists, like `create`.
pub fn create_refresh_key(group: &str) -> Result<SecKey, EnclaveError> {
    create_tagged(
        REFRESH_KEY_TAG,
        REFRESH_KEY_LABEL,
        REFRESH_KEY_PROTECTION,
        REFRESH_KEY_ACCESS_FLAGS,
        group,
    )
}

fn create_tagged(
    tag: &[u8],
    label: &str,
    protection: ProtectionMode,
    flags: CFOptionFlags,
    group: &str,
) -> Result<SecKey, EnclaveError> {
    if find_tagged(tag, group, None)?.is_some() {
        return Err(EnclaveError::Failed("already_exists".into()));
    }
    let access = SecAccessControl::create_with_protection(Some(protection), flags)
        .map_err(|error| EnclaveError::Failed(format!("access control {}", error.code())))?;
    let private: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[
        (
            key_of(unsafe { kSecAttrIsPermanent }),
            CFBoolean::true_value().into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrApplicationTag }),
            CFData::from_buffer(tag).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrLabel }),
            CFString::new(label).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrAccessGroup }),
            CFString::new(group).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrAccessControl }),
            access.into_CFType(),
        ),
    ]);
    let attributes: CFDictionary<CFString, CFType> = CFDictionary::from_CFType_pairs(&[
        (
            key_of(unsafe { kSecAttrKeyType }),
            key_of(unsafe { kSecAttrKeyTypeECSECPrimeRandom }).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrKeySizeInBits }),
            CFNumber::from(256i32).into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrTokenID }),
            key_of(unsafe { kSecAttrTokenIDSecureEnclave }).into_CFType(),
        ),
        (
            key_of(unsafe { kSecUseDataProtectionKeychain }),
            CFBoolean::true_value().into_CFType(),
        ),
        (
            key_of(unsafe { kSecAttrAccessGroup }),
            CFString::new(group).into_CFType(),
        ),
        (
            key_of(unsafe { kSecPrivateKeyAttrs }),
            private.into_CFType(),
        ),
    ]);
    #[allow(deprecated)]
    let key = SecKey::generate(attributes.to_untyped())
        .map_err(|error: CFError| classify(error.code() as i64, "create"))?;
    Ok(key)
}

/// The 33-byte compressed SEC1 public key.
pub fn public_key(key: &SecKey) -> Result<[u8; payload::P256_PUBLIC_KEY_LEN], EnclaveError> {
    let x963 = key
        .public_key()
        .and_then(|public| public.external_representation())
        .ok_or_else(|| EnclaveError::Failed("public key".into()))?;
    payload::compress_x963_public_key(x963.bytes())
        .ok_or_else(|| EnclaveError::Failed("public key encoding".into()))
}

/// ECDSA P-256 / SHA-256 over `message`, DER as the enclave returns it.
pub fn sign_der(key: &SecKey, message: &[u8]) -> Result<Vec<u8>, EnclaveError> {
    key.create_signature(Algorithm::ECDSASignatureMessageX962SHA256, message)
        .map_err(|error| classify(error.code() as i64, "sign"))
}

// ---- the reuse window -------------------------------------------------------

/// Clamp a configured window into D-3's 0–300 s.
pub fn clamp_window(secs: u64) -> Duration {
    Duration::from_secs(secs.min(REUSE_WINDOW_MAX_SECS))
}

/// One `LAContext` reused for at most `window` after the signature that
/// authenticated it. Lives on the signing thread only (not `Send`).
pub struct AuthWindow {
    window: Duration,
    held: Option<(Retained<AnyObject>, Instant)>,
}

impl AuthWindow {
    pub fn new(window: Duration) -> Self {
        Self {
            window: window.min(Duration::from_secs(REUSE_WINDOW_MAX_SECS)),
            held: None,
        }
    }

    pub fn window(&self) -> Duration {
        self.window
    }

    /// Whether a context authenticated at `at` may still be used `now`.
    pub fn reusable(window: Duration, at: Instant, now: Instant) -> bool {
        !window.is_zero() && now.saturating_duration_since(at) < window
    }

    /// The context for the next signature: the held one if still inside the
    /// window, else a fresh one (the old one is invalidated first).
    pub fn context(&mut self, reason: &str) -> Result<Retained<AnyObject>, EnclaveError> {
        if let Some((context, at)) = &self.held {
            if Self::reusable(self.window, *at, Instant::now()) {
                return Ok(context.clone());
            }
        }
        self.forget();
        new_context(reason)
    }

    /// After a signature succeeded with `context`: start (or keep) its window.
    /// The window counts from the authentication, not from the last use.
    pub fn authenticated(&mut self, context: Retained<AnyObject>) {
        let fresh = match &self.held {
            Some((held, _)) => !std::ptr::eq(&**held, &*context),
            None => true,
        };
        if fresh && !self.window.is_zero() {
            self.held = Some((context, Instant::now()));
        } else if self.window.is_zero() {
            invalidate(&context);
        }
    }

    /// Drop the held context (a failed signature, a key change, app exit).
    pub fn forget(&mut self) {
        if let Some((context, _)) = self.held.take() {
            invalidate(&context);
        }
    }
}

impl Drop for AuthWindow {
    fn drop(&mut self) {
        self.forget();
    }
}

fn new_context(reason: &str) -> Result<Retained<AnyObject>, EnclaveError> {
    let class =
        AnyClass::get(c"LAContext").ok_or(EnclaveError::Unsupported("no LocalAuthentication"))?;
    // SAFETY: `+[LAContext new]` returns a +1 instance; the setters take an
    // NSTimeInterval (f64) and an NSString.
    unsafe {
        let context: Retained<AnyObject> = msg_send![class, new];
        // Never a lock-screen unlock in place of this signature's own check.
        let _: () = msg_send![&*context, setTouchIDAuthenticationAllowableReuseDuration: 0.0f64];
        let reason = NSString::from_str(reason);
        let _: () = msg_send![&*context, setLocalizedReason: &*reason];
        Ok(context)
    }
}

fn invalidate(context: &AnyObject) {
    // SAFETY: `-[LAContext invalidate]` takes no arguments.
    unsafe {
        let _: () = msg_send![context, invalidate];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// "No software fallback" (ADR-0146 D-1, mission): every refusal the
    /// platform can give maps to a named error. Sabotage: route -34018 to
    /// `Absent` and the status screen would offer "create a key" on a build
    /// that can never hold one — this goes RED.
    #[test]
    fn every_platform_refusal_is_named_and_none_reads_as_a_key() {
        assert_eq!(classify(-34018, "find"), EnclaveError::EntitlementMissing);
        assert_eq!(classify(-34018, "create"), EnclaveError::EntitlementMissing);
        assert_eq!(classify(-34018, "sign"), EnclaveError::EntitlementMissing);
        assert_eq!(classify(-25300, "find"), EnclaveError::Absent);
        assert_eq!(classify(-128, "sign"), EnclaveError::Cancelled);
        assert_eq!(classify(-2, "sign"), EnclaveError::Cancelled);
        assert_eq!(classify(-25293, "sign"), EnclaveError::AuthFailed);
        assert_eq!(
            classify(-4, "create"),
            EnclaveError::Unsupported("no_secure_enclave")
        );
        assert!(matches!(classify(-50, "create"), EnclaveError::Failed(_)));
        for code in [-34018, -25300, -128, -25293, -4, -50] {
            for during in ["find", "create", "sign"] {
                let error = classify(code, during);
                assert!(error.code().starts_with("device_key_"), "{error:?}");
            }
        }
    }

    /// The body of the plist element right after `<key>{key}</key>`.
    fn plist_value<'a>(plist: &'a str, key: &str) -> Option<&'a str> {
        let marker = format!("<key>{key}</key>");
        let rest = plist[plist.find(&marker)? + marker.len()..].trim_start();
        let (open, close) = if rest.starts_with("<array>") {
            ("<array>", "</array>")
        } else if rest.starts_with("<string>") {
            ("<string>", "</string>")
        } else {
            return Some(&rest[..rest.find('>')? + 1]);
        };
        Some(rest[open.len()..rest.find(close)?].trim())
    }

    /// The signed app's entitlements (#3025): `Entitlements.app.plist` is what
    /// `publish_next_build.sh` re-signs the outer .app with, after embedding
    /// the provisioning profile. `Entitlements.plist` is what the bundler signs
    /// the app with before that, so it stays free of the restricted keys.
    #[test]
    fn only_the_signed_app_entitlements_declare_the_device_key_group() {
        const APP: &str = include_str!("../../Entitlements.app.plist");
        const BASE: &str = include_str!("../../Entitlements.plist");
        const CONF: &str = include_str!("../../tauri.conf.json");

        let identifier = serde_json::from_str::<serde_json::Value>(CONF).unwrap()["identifier"]
            .as_str()
            .unwrap()
            .to_owned();
        let team =
            plist_value(APP, "com.apple.developer.team-identifier").expect("team-identifier");
        assert_eq!(
            plist_value(APP, "com.apple.application-identifier"),
            Some(format!("{team}.{identifier}").as_str())
        );
        assert_eq!(
            plist_value(APP, "keychain-access-groups"),
            Some(format!("<string>{}</string>", access_group_for(Some(team)).unwrap()).as_str()),
            "the app declares exactly the device-key group"
        );
        // A superset of the bundler's plist: the re-sign replaces it.
        assert_eq!(
            plist_value(BASE, "com.apple.security.device.audio-input"),
            Some("<true/>")
        );
        assert_eq!(
            plist_value(APP, "com.apple.security.device.audio-input"),
            Some("<true/>")
        );
        for restricted in [
            "keychain-access-groups",
            "com.apple.application-identifier",
            "com.apple.developer.team-identifier",
        ] {
            assert_eq!(
                plist_value(BASE, restricted),
                None,
                "Entitlements.plist (the bundler's plist) must not hold {restricted}"
            );
        }
    }

    /// The momo-workd helper bundle's entitlements (#3084):
    /// `publish_next_build.sh` signs `Contents/Helpers/momo-workd.app` with
    /// `Entitlements.workd.plist` under its own App ID and profile. Both
    /// profiles allow `<TEAM>.*`, so these files are what keep the host key's
    /// group and the device-key group apart (D-3): each side declares exactly
    /// its own group and never the other's.
    #[test]
    fn the_workd_helper_declares_only_its_own_group_and_the_app_never_holds_it() {
        const APP: &str = include_str!("../../Entitlements.app.plist");
        const WORKD: &str = include_str!("../../Entitlements.workd.plist");
        const CONF: &str = include_str!("../../tauri.conf.json");

        let conf = serde_json::from_str::<serde_json::Value>(CONF).unwrap();
        let identifier = conf["identifier"].as_str().unwrap();
        let team = plist_value(WORKD, "com.apple.developer.team-identifier").expect("team");
        assert_eq!(
            Some(team),
            plist_value(APP, "com.apple.developer.team-identifier")
        );
        let workd_id = format!("{team}.{identifier}.workd");
        assert_eq!(
            plist_value(WORKD, "com.apple.application-identifier"),
            Some(workd_id.as_str())
        );
        assert_eq!(
            plist_value(WORKD, "keychain-access-groups"),
            Some(format!("<string>{workd_id}</string>").as_str()),
            "the helper declares exactly workd's group"
        );
        let device_group = access_group_for(Some(team)).unwrap();
        assert!(
            !WORKD.contains(&format!("<string>{device_group}</string>")),
            "the helper must not hold the device-key group (D-3)"
        );
        assert!(
            !APP.contains(&format!("<string>{workd_id}</string>")),
            "the app must not hold workd's group"
        );
        // Nothing the helper does not need: no microphone, no other key.
        assert_eq!(WORKD.matches("<key>").count(), 3, "{WORKD}");
        // The helper ships where work_host.rs looks for it.
        assert_eq!(
            conf["bundle"]["macOS"]["files"],
            serde_json::json!({ "Helpers/momo-workd.app": "binaries/momo-workd.app" })
        );
    }

    /// #3106: the two enclave keys are different items with different
    /// access. The instruction key keeps presence on every signature; the
    /// refresh key has no presence (a background refresh cannot show a
    /// dialog) and stays usable while the Mac is locked. Sabotage: give the
    /// refresh key `KEY_TAG` and a refresh would find — and try to use — the
    /// Touch ID key; give the device key `REFRESH_KEY_ACCESS_FLAGS` and an
    /// instruction would sign without Touch ID. Either goes RED here.
    #[test]
    fn the_refresh_key_is_another_item_without_presence_and_the_device_key_keeps_it() {
        assert_ne!(REFRESH_KEY_TAG, KEY_TAG);
        assert!(!REFRESH_KEY_TAG.starts_with(KEY_TAG) && !KEY_TAG.starts_with(REFRESH_KEY_TAG));
        assert_eq!(REFRESH_KEY_ACCESS_FLAGS, kSecAccessControlPrivateKeyUsage);
        assert_eq!(REFRESH_KEY_ACCESS_FLAGS & kSecAccessControlUserPresence, 0);
        assert_eq!(
            KEY_ACCESS_FLAGS,
            kSecAccessControlPrivateKeyUsage | kSecAccessControlUserPresence
        );
        assert!(matches!(
            REFRESH_KEY_PROTECTION,
            ProtectionMode::AccessibleAfterFirstUnlockThisDeviceOnly
        ));
        assert!(matches!(
            KEY_PROTECTION,
            ProtectionMode::AccessibleWhenUnlockedThisDeviceOnly
        ));
    }

    #[test]
    fn the_access_group_needs_a_team_and_is_the_app_only_one() {
        assert_eq!(access_group_for(None), Err(EnclaveError::UnsignedBuild));
        assert_eq!(
            access_group_for(Some("ABCDE12345")).unwrap(),
            "ABCDE12345.app.momo.desktop.devicekey"
        );
        assert!(access_group_for(Some("abc")).is_err());
        assert!(access_group_for(Some("ABCDE12345.x")).is_err());
        // Not the workd host key's service (`app.momo.desktop.workd`).
        assert_ne!(ACCESS_GROUP_SUFFIX, "app.momo.desktop.workd");
    }

    #[test]
    fn the_reuse_window_is_at_most_five_minutes_and_zero_means_every_time() {
        assert_eq!(clamp_window(3600), Duration::from_secs(300));
        assert_eq!(clamp_window(120), Duration::from_secs(120));
        let at = Instant::now();
        let w = Duration::from_secs(300);
        assert!(AuthWindow::reusable(w, at, at + Duration::from_secs(299)));
        assert!(!AuthWindow::reusable(w, at, at + Duration::from_secs(300)));
        assert!(!AuthWindow::reusable(Duration::ZERO, at, at));
        assert_eq!(
            AuthWindow::new(Duration::from_secs(900)).window(),
            Duration::from_secs(300)
        );
    }
}
