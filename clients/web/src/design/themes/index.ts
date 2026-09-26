// DS2 테마 팔레트 (ADR-0189 D5). core에서 생성한 `palettes/<id>.css`가
// `:root[data-palette]`로 색 역할 전체를 다시 묶는다. 부트 스크립트가
// `data-palette="dawnsky"`를 찍는다(테마 선택 UI는 DS2-7 #2719).
import.meta.glob("./palettes/*.css", { eager: true });
import.meta.glob("./*.css", { eager: true });

// =============================================================================
// Accent binding catalog (ADR-0174 D1 · BZ-5a / #1868), DS2 이행 중.
//
// ADR-0189 D3: 액센트 id는 신호 프리셋으로 옮겨 간다. 이 목록의 CSS 파일은 이제
// `--accent`가 아니라 신호 네 값(`--signal`·`--on-signal`·`--signal-text`·
// `--signal-soft`)을 다시 묶고, `--accent`는 tokens.css에서 `--signal`의 별칭이다.
// 주 버튼(`--primary`)은 어떤 바인딩도 바꾸지 않는다. DS2-7이 `data-accent`를
// `data-signal`로 옮기며 이 목록을 걷는다.
//
// This module is the catalog of pre-validated bindings. Adding a theme means
// adding a CSS file whose stem is the id AND a row here; `catalog.contrast.test.ts` enumerates the files as its input, so a
// theme that is not in this list (or a list row without a file) fails closed.
//
// Dawn is always first and the default. The candidate set is a 시안 until
// 성재 confirms it. Ids are lowercase ASCII letters only — theme-boot.js,
// the capture scrape, and the theme gate share ACCENT_ID_CHAR_CLASS, and the
// catalog test pins the four together.
// =============================================================================

/** Character class shared with theme-boot.js, capture-screens.mjs, and gate-theme.mjs. */
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
