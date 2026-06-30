# MomoMac Xcode Host

This directory contains the release-oriented thin host app for M4 packaging.
It intentionally stays separate from the SwiftPM-only `MomoMacDevApp`.

- Target/scheme: `MomoMac`
- Bundle ID: `com.dawnkim.momo`
- Local SwiftPM package products: `MomoMac` and `MomoCore`
- Signing: disabled for local build gates with `CODE_SIGNING_ALLOWED=NO`
- Hardened runtime: enabled in Debug and Release build settings
- Entitlements: sandbox + outbound network client capability

TODO(#179): Follow-up M4 signing tickets must replace local unsigned builds with
Developer ID/App Store signing settings, validate notarization, and confirm the
final release entitlement set before distribution.
