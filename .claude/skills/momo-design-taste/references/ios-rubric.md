# oort iOS design rubric

This reference is the canonical iOS variant of oort design taste. iOS surfaces
are companions for receiving, reading, replying, and making decisions. They do
not imitate the macOS window or attempt desktop feature parity.

## Binary rules

- Start with Apple HIG and native SwiftUI controls. Prefer `NavigationStack`,
  `List`, `Form`, `LabeledContent`, system sheets, alerts, menus, and toolbars.
- Support Dynamic Type using semantic text styles. Do not use fixed font sizes,
  custom fonts, or fixed-height text containers.
- Use semantic colors and the app tint only. Do not use raw RGB or hex colors in
  views, decorative gradients, or hard-coded light and dark backgrounds.
- Use SF Symbols for functional icons. Emoji are content, not controls.
- Every interactive control needs a clear accessibility label. Important smoke
  paths also receive stable accessibility identifiers.
- User-visible strings must not contain em dash or en dash characters.
- Loading, empty, failure, offline, and success states must be explicit for every
  network-backed surface.
- Respect Reduce Motion. Motion communicates a state change and is never
  decorative or perpetual.
- Use sheets for focused, dismissible tasks. Keep primary navigation in
  `NavigationStack`; do not reproduce navigation with custom overlays.
- Preserve readable margins and touch targets. Check long Korean and English
  content at accessibility text sizes before review.

## iOS AI-tells

| Avoid | Use instead |
| --- | --- |
| Web-page cards around every section | `List` or `Form` sections with system separators |
| Custom tab bars or floating navigation pills | System `TabView` and `NavigationStack` |
| Gradient hero headers and glass panels | Navigation title, toolbar, semantic system background |
| Oversized onboarding carousel | Short task-focused form with progressive disclosure |
| Decorative sparkle, robot, or brain iconography | A relevant SF Symbol tied to an actual action or status |
| Chat bubbles that visually separate agents from people | Shared message anatomy with a small identity treatment |
| Toast stacks and snackbar queues | Inline error, alert, confirmation dialog, or system notification |
| Full-screen custom loading animation | `ProgressView` with a precise status label |
| Fixed viewport or webview-like layout | Adaptive SwiftUI layout with Dynamic Type and safe areas |

## Review evidence

- Build and test on an available iPhone simulator selected at runtime.
- Check portrait layout at the default and an accessibility Dynamic Type size.
- Check light and dark appearances.
- Verify VoiceOver labels and the complete login or primary task path.
- Search newly added user-visible strings for em dash and en dash characters.
- Record any intentionally deferred state or device-class coverage in the PR.
