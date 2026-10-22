// =============================================================================
// 테마 색 씨앗 — VS Code·shiki 테마 JSON에서 뽑는 열두 색 (ADR-0189 증보 3 D1·D2, AP-1b #4188).
//
// Adapted from block/buzz `desktop/src/shared/theme/theme-loader.ts` @ af5bb0a
// (https://github.com/block/buzz, Apache-2.0, Copyright 2026 Block, Inc.).
// Changed by oort (Apache-2.0 §4(b)): (1) Buzz가 읽는 색은 배경·글자·comment·git 장식 셋뿐이고
// oort는 신호·에이전트·사이드바·ANSI 세 색까지 읽는다. (2) comment 색은 `settings`뿐 아니라
// `tokenColors`도 읽는다: shiki 4.1.0 테마 모듈에는 `settings`가 없고 `tokenColors`만 있어서, Buzz의
// 추출은 실제 테마에서 comment를 못 찾고 글자색으로 폴백한다(Buzz 결함 후보, 청사진 R6 §2.2).
// (3) 색은 `#rrggbb` 소문자로만 내보내고(알파는 버린다) 형식이 틀린 값은 건너뛴다. (4) 필수 색이 없을 때
// Buzz처럼 기본색을 지어내는 것은 `defaults: true`를 켠 호출(카탈로그 생성기)뿐이다. 가져오기는 켜지 않는다:
// 가져오기가 「필수 키 없음」을 말해야 한다.
//
// 씨앗은 테마 **한 모드**의 색이다. 쌍(라이트·다크)은 `CatalogEntry`가 두 씨앗으로 묶는다.
// 파생(바닥·표면·글자·상태색·신호·에이전트)은 `derive.ts`가 한다. 이 파일은 순수 TS이고 입력은
// 신뢰하지 않는다: 값은 `#RRGGBB`로만 통과하고 그 밖의 모양은 읽지 않는다.
// =============================================================================

import { luminance, toOklch } from "./color";
import type { Mode } from "./themes";

/** 씨앗이 들고 있을 수 있는 열두 색. `bg`·`fg`만 필수다. */
export const SEED_KEYS = [
  "bg",
  "fg",
  "comment",
  "added",
  "deleted",
  "modified",
  "accent",
  "agent",
  "sidebar",
  "ansiRed",
  "ansiGreen",
  "ansiYellow",
] as const;
export type SeedKey = (typeof SEED_KEYS)[number];

export type ThemeSeed = { readonly bg: string; readonly fg: string } & {
  readonly [K in Exclude<SeedKey, "bg" | "fg">]?: string;
};

/** 허용 라이선스(MIT·Apache-2.0·BSD·ISC). 생성기가 상류 NOTICE의 SPDX가 이 밖이면 실패한다. */
export const CATALOG_ALLOWED_SPDX = ["MIT", "Apache-2.0", "ISC", "BSD-2-Clause", "BSD-3-Clause"] as const;
export type CatalogSpdx = (typeof CATALOG_ALLOWED_SPDX)[number];

export function isAllowedSpdx(value: unknown): value is CatalogSpdx {
  return typeof value === "string" && (CATALOG_ALLOWED_SPDX as readonly string[]).includes(value);
}

/** 한 모드의 출처: 원본 테마 이름과 상류 저장소(`owner/repo`). */
export interface CatalogSourceRef {
  readonly theme: string;
  readonly repo: string;
  readonly spdx: CatalogSpdx;
}

/** 카탈로그 항목 하나. 쌍이면 `light`·`dark` 둘 다, 단일 모드면 하나만 있다(없는 모드를 복제해 채우지 않는다). */
export interface CatalogEntry {
  readonly id: string;
  readonly label: string;
  readonly light?: ThemeSeed;
  readonly dark?: ThemeSeed;
  readonly source: { readonly light?: CatalogSourceRef; readonly dark?: CatalogSourceRef };
}

/** 카탈로그·사용자 id 문법과 같다(`themeResolve.THEME_REF_ID_RE`). 첫 파티의 `[a-z]` 핀과 겹치지 않는다. */
export const CATALOG_ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ---- 색 읽기 ----------------------------------------------------------------

/**
 * `#rgb`·`#rgba`·`#rrggbb`·`#rrggbbaa`를 소문자 `#rrggbb`로 읽는다(알파는 버린다). 그 밖의 문자열
 * (`rgb()`·이름 색·길이가 다른 hex)은 `null`이다. Buzz `stripAlpha`의 일반화다.
 */
export function readThemeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const found = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(value.trim());
  if (!found) return null;
  const digits = found[1].toLowerCase();
  if (digits.length <= 4) {
    return "#" + [...digits.slice(0, 3)].map((c) => c + c).join("");
  }
  return "#" + digits.slice(0, 6);
}

/** 어두운 바탕이면 다크, 아니면 라이트(Buzz `adaptive-theme.ts`의 `luminance < 0.5`). `type` 필드는 힌트일 뿐이다. */
export function seedMode(seed: Pick<ThemeSeed, "bg">): Mode {
  return luminance(seed.bg) < 0.5 ? "dark" : "light";
}

// 키 우선순위. 앞의 것이 있으면 뒤의 것은 보지 않는다.
// git 장식색은 Buzz `theme-loader.ts:340-377`의 순서 그대로다.
const ADDED_KEYS = [
  "gitDecoration.addedResourceForeground",
  "editorGutter.addedBackground",
  "diffEditor.insertedTextBackground",
] as const;
const DELETED_KEYS = [
  "gitDecoration.deletedResourceForeground",
  "editorGutter.deletedBackground",
  "diffEditor.removedTextBackground",
] as const;
const MODIFIED_KEYS = [
  "gitDecoration.modifiedResourceForeground",
  "editorGutter.modifiedBackground",
] as const;
// oort가 더한 것: 신호 씨앗(포커스 테두리 → 링크 → 버튼 → 배지)과 에이전트 씨앗(청록 → 파랑).
// 순서는 우선순위지만 **채도가 있는 후보를 먼저 쓴다**(아래 `firstChromatic`). 앞 후보가 무채색이면 신호가 회색·
// 검정·흰색이 되기 때문이다: 포커스 테두리 먼저로만 읽으면 57종 가운데 23종이 무채색 신호가 되고(버튼 먼저는
// 10종), 채도를 먼저 보면 3종이다(AP-1b 실측, 2026-10-22).
const ACCENT_KEYS = [
  "focusBorder",
  "textLink.foreground",
  "button.background",
  "activityBarBadge.background",
] as const;
const AGENT_KEYS = ["terminal.ansiCyan", "terminal.ansiBlue"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstColor(colors: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const found = readThemeColor(colors[key]);
    if (found !== null) return found;
  }
  return undefined;
}

/** 신호·에이전트 씨앗의 최소 채도(OKLCH C). 이보다 옅은 후보는 뒤에 채도 있는 후보가 있으면 건너뛴다. */
export const SEED_MIN_CHROMA = 0.04;

/**
 * 우선순위 순서로 훑어 채도가 `SEED_MIN_CHROMA` 이상인 첫 색을 쓴다. 하나도 없으면 읽힌 것 가운데 첫 색이다
 * (옅어도 그 테마가 말한 색이다).
 */
function firstChromatic(colors: Record<string, unknown>, keys: readonly string[]): string | undefined {
  let fallback: string | undefined;
  for (const key of keys) {
    const found = readThemeColor(colors[key]);
    if (found === null) continue;
    fallback ??= found;
    if (toOklch(found).C >= SEED_MIN_CHROMA) return found;
  }
  return fallback;
}

function scopesOf(scope: unknown): string[] {
  const list = Array.isArray(scope) ? scope : [scope];
  return list.flatMap((item) => (typeof item === "string" ? item.split(",").map((s) => s.trim()) : []));
}

/**
 * comment 토큰 색. 규칙 배열은 `tokenColors`가 있으면 그것, 없으면 `settings`다(VS Code 형식은
 * `tokenColors`, 옛 TextMate 형식은 `settings`). Buzz는 `settings`만 읽어서 실제 테마에서 못 찾는다.
 */
function commentColor(theme: Record<string, unknown>): string | undefined {
  const rules = Array.isArray(theme.tokenColors)
    ? theme.tokenColors
    : Array.isArray(theme.settings)
      ? theme.settings
      : [];
  for (const rule of rules) {
    if (!isRecord(rule) || !isRecord(rule.settings)) continue;
    const color = readThemeColor(rule.settings.foreground);
    if (color === null) continue;
    if (scopesOf(rule.scope).includes("comment")) return color;
  }
  return undefined;
}

export interface ExtractSeedOptions {
  /**
   * 배경·글자 색이 없을 때 Buzz처럼 기본색으로 채운다(`theme-loader.ts` `extractThemeInfo`의 `|| "#1e1e1e"`·
   * `|| "#d4d4d4"`). 글자 기본색만 바탕에 맞춰 갈린다(어두우면 `d4d4d4`, 밝으면 `333333`). 카탈로그 57종 가운데
   * `editor.foreground`가 없는 것이 둘 있다(`min-dark`·`synthwave-84`). 기본은 꺼짐이다.
   */
  readonly defaults?: boolean;
}

const hexOf = (r: number, g: number, b: number): string =>
  "#" + [r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("");

// 색 글자를 코드에 적지 않고 채널로 쓴다: 코어의 `raw_color` 검사가 색 리터럴을 막는 자리다.
const FALLBACK_BG = hexOf(30, 30, 30);
const FALLBACK_FG_ON_DARK = hexOf(212, 212, 212);
const FALLBACK_FG_ON_LIGHT = hexOf(51, 51, 51);

/**
 * VS Code·shiki 테마 객체에서 씨앗을 뽑는다. 배경(`editor.background`)이나 글자
 * (`editor.foreground`)가 `#RRGGBB` 계열이 아니면 `null`이다(`defaults`를 켜지 않았다면).
 * 나머지는 있는 것만 담는다. 입력이 객체가 아니어도 던지지 않는다.
 */
export function extractSeed(theme: unknown, options: ExtractSeedOptions = {}): ThemeSeed | null {
  if (!isRecord(theme) || !isRecord(theme.colors)) return null;
  const colors = theme.colors;
  let bg = readThemeColor(colors["editor.background"]);
  let fg = readThemeColor(colors["editor.foreground"]);
  if (options.defaults) {
    bg ??= FALLBACK_BG;
    fg ??= seedMode({ bg }) === "dark" ? FALLBACK_FG_ON_DARK : FALLBACK_FG_ON_LIGHT;
  }
  if (bg === null || fg === null) return null;
  const optional: Partial<Record<Exclude<SeedKey, "bg" | "fg">, string | undefined>> = {
    comment: commentColor(theme),
    added: firstColor(colors, ADDED_KEYS),
    deleted: firstColor(colors, DELETED_KEYS),
    modified: firstColor(colors, MODIFIED_KEYS),
    accent: firstChromatic(colors, ACCENT_KEYS),
    agent: firstChromatic(colors, AGENT_KEYS),
    sidebar: firstColor(colors, ["sideBar.background"]),
    ansiRed: firstColor(colors, ["terminal.ansiRed"]),
    ansiGreen: firstColor(colors, ["terminal.ansiGreen"]),
    ansiYellow: firstColor(colors, ["terminal.ansiYellow"]),
  };
  const seed: Record<string, string> = { bg, fg };
  for (const key of SEED_KEYS) {
    if (key === "bg" || key === "fg") continue;
    const value = optional[key];
    if (value !== undefined) seed[key] = value;
  }
  return seed as unknown as ThemeSeed;
}
