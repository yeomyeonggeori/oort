import.meta.glob("./*.css", { eager: true });

// =============================================================================
// Accent binding catalog (ADR-0174 D1 · BZ-5a / #1868).
//
// Components still consume `--accent` / `--accent-soft` / `--on-accent`. This
// module is the catalog of pre-validated bindings that may rebind those three
// tokens. Adding a theme means adding a CSS file whose stem is the id AND a
// row here; `catalog.contrast.test.ts` enumerates the files as its input, so a
// theme that is not in this list (or a list row without a file) fails closed.
//
// Dawn is always first and the default. The candidate set is a 시안 until
// 성재 confirms it. Ids are lowercase ASCII letters only — theme-boot.js and
// the capture scrape share ACCENT_ID_CHAR_CLASS, and the catalog test pins
// the three together.
// =============================================================================

/** Character class shared with public/theme-boot.js and capture-screens.mjs. */
export const ACCENT_ID_CHAR_CLASS = "a-z";
export const ACCENT_ID_RE = new RegExp(`^[${ACCENT_ID_CHAR_CLASS}]+$`);

export const ACCENT_THEMES = [
  { id: "dawn", label: "새벽" },
  { id: "seongun", label: "성운" },
  { id: "hongyeom", label: "홍염" },
  { id: "hyeseong", label: "혜성" },
  { id: "gamram", label: "감람" },
] as const;

export type AccentId = (typeof ACCENT_THEMES)[number]["id"];

export const DEFAULT_ACCENT_ID: AccentId = ACCENT_THEMES[0].id;

export const ACCENT_ATTRIBUTE = "data-accent";

export function isAccentId(value: string | null | undefined): value is AccentId {
  return ACCENT_THEMES.some((theme) => theme.id === value);
}

export function normalizeAccentId(raw: string | null | undefined): AccentId {
  return isAccentId(raw) ? raw : DEFAULT_ACCENT_ID;
}
