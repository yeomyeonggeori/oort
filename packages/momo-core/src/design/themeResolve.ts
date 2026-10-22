// =============================================================================
// 테마 참조(ThemeRef)와 모드 판정 — 골격 (AP-1a #4186, 청사진 §5.2-a·f).
//
// 이 파일은 **문법과 판정 규칙**만 든다. 카탈로그(`catalog:<id>`가 실제로 어떤 모드를
// 갖는지)는 AP-1b(#4188)가 `modesOf`의 기본 조회에 채운다. 그래서 규칙을 가짜 단일
// 모드 참조로도 잴 수 있도록 조회 함수를 인자로 받는다(`ModesLookup`).
//
// | 저장 문자열 | 뜻 | 루트 `data-palette` |
// |---|---|---|
// | `dawnsky` · `graphite` · `noeul` | 첫 파티 3종(손으로 맞춘 정적 CSS) | 그 id |
// | `catalog:<id>` | 카탈로그 테마(런타임 파생, AP-1b) | `derived` |
// | `user:<id>` | 사용자 테마(런타임 파생, AP-5) | `derived` |
//
// 첫 파티 id의 문자 집합 핀(`THEME_ID_RE = /^[a-z]+$/`, 부트·캡처·게이트가 공유)은
// **넓히지 않는다**. 카탈로그·사용자 id는 `:` 뒤의 별도 문법이라 그 핀을 지나지
// 않는다(청사진 §5.2-f).
//
// 단일 모드 규칙(Buzz `resolveSystemTheme`·`handleModeSelect`의 개념):
//   · 테마가 한 모드뿐이면 유효 스킴은 그 모드다. 사람이 고른 스킴이 시스템이든 반대
//     모드든 마찬가지다: 다크 단독 테마를 라이트로 그릴 길이 없다.
//   · 이때 루트 `data-theme`를 그 모드로 못 박아야 폼 컨트롤·스크롤바의
//     `color-scheme`이 어긋나지 않는다(양쪽에 같은 값을 넣기만 하면 OS가 라이트일 때
//     다크 단독 테마의 스크롤바가 밝게 그려진다).
// =============================================================================

import type { SchemeChoice } from "./appearance";
import { DEFAULT_THEME_ID, MODES, isThemeId, type Mode, type ThemeId } from "./themes";

export type ThemeRef = ThemeId | `catalog:${string}` | `user:${string}`;

/** 카탈로그·사용자 id 문법. 소문자·숫자와 하이픈(양끝·연속 하이픈 없음). */
export const THEME_REF_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const THEME_REF_ID_MAX = 40;

export const THEME_REF_NAMESPACES = ["catalog", "user"] as const;
export type ThemeRefNamespace = (typeof THEME_REF_NAMESPACES)[number];

/** 첫 파티가 아닌 테마가 루트 `data-palette`에 찍는 값. 정적 CSS가 없어 `:root` 기본이 받는다. */
export const DERIVED_PALETTE = "derived" as const;
export type PaletteId = ThemeId | typeof DERIVED_PALETTE;

/** 네임스페이스 참조를 쪼갠다. 문법이 틀리면 `null`. 멤버십(실제 카탈로그에 있는가)은 보지 않는다. */
export function splitThemeRef(
  value: unknown
): { namespace: ThemeRefNamespace; id: string } | null {
  if (typeof value !== "string") return null;
  const colon = value.indexOf(":");
  if (colon <= 0) return null;
  const namespace = value.slice(0, colon);
  const id = value.slice(colon + 1);
  if (namespace !== "catalog" && namespace !== "user") return null;
  if (id.length === 0 || id.length > THEME_REF_ID_MAX || !THEME_REF_ID_RE.test(id)) return null;
  return { namespace, id };
}

export function isThemeRef(value: unknown): value is ThemeRef {
  return isThemeId(value) || splitThemeRef(value) !== null;
}

/**
 * 저장된 값을 참조로 읽는다. 문법이 틀리면 기본 테마다(청사진 §5.3-d 「모르는 값은
 * dawnsky」). AP-1b가 카탈로그 멤버십 검사를 여기에 더한다.
 */
export function normalizeThemeRef(raw: unknown): ThemeRef {
  return isThemeRef(raw) ? raw : DEFAULT_THEME_ID;
}

export function paletteOf(ref: ThemeRef): PaletteId {
  return isThemeId(ref) ? ref : DERIVED_PALETTE;
}

export type ModeSet = readonly Mode[];

/** 참조가 가진 모드를 돌려주는 조회. 모르는 참조는 `null`(양쪽으로 본다). */
export type ModesLookup = (ref: ThemeRef) => ModeSet | null | undefined;

/**
 * 테마가 가진 모드. 첫 파티 3종은 언제나 둘 다다. 그 밖의 참조는 조회가 말하는 대로
 * 이고, 조회가 없거나 모르면 둘 다로 본다(깨진 데이터가 화면을 한 모드에 가두지 않게).
 * 결과는 `MODES` 순서(라이트, 다크)·중복 없음이다.
 */
export function modesOf(ref: ThemeRef, lookup?: ModesLookup): ModeSet {
  if (isThemeId(ref)) return MODES;
  const found = lookup?.(ref);
  if (!found) return MODES;
  const present = MODES.filter((mode) => found.includes(mode));
  return present.length === 0 ? MODES : present;
}

/**
 * 루트 `data-theme`에 찍을 유효 스킴. `null`은 「찍지 않는다」(시스템을 따른다).
 * 단일 모드 테마는 사람이 고른 스킴과 무관하게 그 모드로 못 박는다.
 */
export function effectiveScheme(choice: SchemeChoice, modes: ModeSet): Mode | null {
  if (modes.length === 1) return modes[0];
  if (choice === "light" || choice === "dark") return choice;
  return null;
}
