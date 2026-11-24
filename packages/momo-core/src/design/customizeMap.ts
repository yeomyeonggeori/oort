// =============================================================================
// 꾸미기 지도 (#6085, #6031 CZ-0): 「무엇을 꾸밀 수 있나」의 정본 표 하나.
//
// 설정 화면의 줄 · (앞으로의) 테마 파일의 열쇠(CZ-3) · 에이전트 명령의 허용 목록(CZ-5)이 각자 목록을 적지 않고 이 표를
// 읽게 하려는 표다. 지금은 표와 시험까지다: 아직 이 표를 읽는 제품 코드는 없고, 설정 › 모양의 줄이 이 표와 어긋나면
// 웹 시험(`customizeMapBinding.test.tsx`)이 빨갛다.
//
// 칸 다섯
//   id        항목 이름. 저장 레코드가 있는 것은 그 필드 이름을 따른다(`AppearanceV2`). 명령 이름은 CZ-5가 정한다
//   shape     값의 **닫힌** 모양. 자유 문자열 · 주소 · CSS를 받는 모양은 없다(`acceptsCustomizeValue`가 그 판정이다)
//   scope     누구에게: 나(이 기기) · 팀 기본(워크스페이스가 정한 처음 값) · 공유(팀원에게 건네 적용하게 함)
//   settings  설정 화면의 자리. 모양 페이지 안의 카드와 차례는 `APPEARANCE_LAYOUT`이 정한다
//   agent     에이전트가 바꾸자고 제안할 수 있는지
//
// 값 셋: live = 지금 된다 · planned = 아직 안 되고 계획에 있다 · none = 하지 않는다(또는 계획에 없다).
// 2026-11-20 계획 표의 「이번 · 다음 · 묶음」은 planned, 「— · 넣지 않음 · 안 함」과 표에 없는 칸은 none이다.
// 지금 모든 항목은 「나」만 live다. 저장은 전부 이 기기이고(ADR-0174 D3), 팀 기본 · 공유는 CZ-3 · CZ-8 몫이다.
// 에이전트 명령은 아직 하나도 live가 아니다: `appearance.*` 명령은 지금 서버가 거절한다(ADR-0186 293행). CZ-5가 여는
// 다섯 가지는 테마 · 화면 모드 · 강조색 · 글자 크기와 밀도 · 배경화면의 단색과 기본 제공이다.
//
// 이 파일에는 화면 문구가 없다. 줄의 이름과 설명은 지금 그 줄을 그리는 파일에 있고, 표는 그 줄을 `anchor`
// (줄 자신이나 줄 안 컨트롤의 `data-testid`)로 가리킨다. 에이전트 안내(CZ-5)의 「그 줄로 가기」도 같은 anchor를 쓸 수 있다.
//
// 항목을 더하는 법은 디자인 시스템 README §2.17이다.
// =============================================================================

import { FONT_SIZE_IDS, THREAD_LAYOUT_IDS, type SchemeChoice } from "./appearance";
import { DENSITY_DISPLAY_ORDER } from "./density";
import { FONT_NAME_MAX, FONT_NAME_PATTERN, parseFontName } from "./fontName";
import { GLASS_OPACITY_MAX, GLASS_STEP } from "./glass";
import { SIGNAL_PRESET_IDS } from "./signalIds";
import { isCatalogId, splitThemeRef } from "./themeResolve";
import { isThemeId } from "./themes";
import { PRESET_IDS, SOLID_IDS } from "./wallpaper";

// ---- 값의 모양 -------------------------------------------------------------

/**
 * 닫힌 값 모양. `string` 하나로 끝나는 모양(자유 글)은 일부러 없다. 글자를 받는 둘(`fontName` · `keyCombo`)은
 * 허용 글자 · 길이가 정해진 이름이고, CSS나 주소는 그 문법으로 쓸 수 없다.
 */
export type CustomizeShape =
  /** 정해진 id 가운데 하나. 차례는 화면의 차례다. */
  | { kind: "choice"; options: readonly string[] }
  /** 켜기 · 끄기. */
  | { kind: "toggle" }
  /** 정수 퍼센트. 실제 하한은 테마마다 더 좁을 수 있다(유리 하한, `glassRange`). */
  | { kind: "percent"; min: number; max: number; step: number }
  /** 테마 참조: 첫 파티 id 또는 카탈로그에 있는 `catalog:<id>`. `user:<id>`(내 테마)는 CZ-2가 연다. */
  | { kind: "themeRef" }
  /**
   * 배경화면 참조: 없음 · 단색 id · 기본 제공 id · 이 기기의 사진(바이트도 주소도 레코드에 들지 않는다).
   * `deviceOnly`의 갈래는 이 기기의 설정 화면에서만 받는다: 테마 파일 · 에이전트 제안 같은 바깥 값으로는 받지 않는다.
   */
  | { kind: "wallpaper"; solids: readonly string[]; presets: readonly string[]; deviceOnly: readonly "image"[] }
  /** 이 기기에 설치된 글꼴의 이름(`fontName.ts`의 허용 글자 · 길이). 빈 값은 시스템 서체다. */
  | { kind: "fontName"; pattern: string; max: number }
  /** 물리 키 하나 + ⇧ · ⌥. 키는 `KEY_COMBO_CODE_PATTERN`의 닫힌 집합이다(⌘ · Ctrl은 늘 붙는다). */
  | { kind: "keyCombo"; codePattern: string }
  /** `#rrggbb`(예약 항목만 쓴다). */
  | { kind: "hexColor" };

export type CustomizeShapeKind = CustomizeShape["kind"];

/**
 * 설정 › 단축키가 받는 물리 키. 웹 `app/shortcutBindings.ts`의 `isKnownCode`와 같은 집합이어야 한다
 * (웹 시험이 두 판정을 키 전수로 견준다).
 */
export const KEY_COMBO_CODE_PATTERN =
  "^(Key[A-Z]|Digit[0-9]|Comma|Period|Slash|Semicolon|Quote|Backslash|BracketLeft|BracketRight|Minus|Equal|Backquote|Arrow(Up|Down|Left|Right)|F([1-9]|1[0-2]))$";

// ---- 표 -------------------------------------------------------------------

export type Availability = "live" | "planned" | "none";

export interface CustomizeScope {
  /** 나: 이 기기(계정 동기화는 #4195). */
  me: Availability;
  /** 팀 기본: 워크스페이스가 정해 새 멤버가 처음 보는 값(#4196). */
  teamDefault: Availability;
  /** 공유: 테마 묶음 파일로 건넴(CZ-3). */
  share: Availability;
}

/** 설정 화면의 갈래(`clients/web/src/features/settings/settingsNav.ts`의 섹션 id). */
export type CustomizeSettingsSection = "appearance" | "shortcuts";

interface ItemBase {
  scope: CustomizeScope;
  /** 이 항목이 사는 설정 갈래. 모양 갈래의 카드 · 차례는 `APPEARANCE_LAYOUT`이 정한다. */
  settings: CustomizeSettingsSection | null;
  agent: Availability;
}

export interface LiveCustomizeItem extends ItemBase {
  status: "live";
  shape: CustomizeShape;
}

/** 「예약」 줄: 자리 · 이슈만 있다. 설정 화면에 줄이 없고(`*_OPEN = false`), 저장 칸이 정해진 것만 모양을 적는다. */
export interface ReservedCustomizeItem extends ItemBase {
  status: "reserved";
  /** 이 항목을 열 이슈. 아직 이슈가 없으면 `null`. */
  issue: number | null;
  shape?: CustomizeShape;
}

export type CustomizeItem = LiveCustomizeItem | ReservedCustomizeItem;

const ME_ONLY: CustomizeScope = { me: "live", teamDefault: "none", share: "none" };
const ME_TEAM_SHARE: CustomizeScope = { me: "live", teamDefault: "planned", share: "planned" };
const ME_SHARE: CustomizeScope = { me: "live", teamDefault: "none", share: "planned" };
const LATER_SHARE: CustomizeScope = { me: "planned", teamDefault: "none", share: "planned" };
const LATER_TEAM_SHARE: CustomizeScope = { me: "planned", teamDefault: "planned", share: "planned" };

export const CUSTOMIZE_MAP = {
  // 카드 「색상」
  scheme: { status: "live", shape: { kind: "choice", options: ["system", "light", "dark"] satisfies readonly SchemeChoice[] }, scope: ME_TEAM_SHARE, settings: "appearance", agent: "planned" },
  theme: { status: "live", shape: { kind: "themeRef" }, scope: ME_TEAM_SHARE, settings: "appearance", agent: "planned" },
  // 「기본」(새벽) + 프리셋 넷. 저장 레코드의 직접 고른 색(`signal.custom`)은 설정 화면이 아직 받지 않는다.
  accent: { status: "live", shape: { kind: "choice", options: ["dawn", ...SIGNAL_PRESET_IDS] }, scope: ME_TEAM_SHARE, settings: "appearance", agent: "planned" },
  // 유리는 기기 성질(맥 데스크탑 앱)이라 팀 기본 · 공유에 넣지 않는다.
  glass: { status: "live", shape: { kind: "toggle" }, scope: ME_ONLY, settings: "appearance", agent: "planned" },
  glassOpacity: { status: "live", shape: { kind: "percent", min: 0, max: GLASS_OPACITY_MAX, step: GLASS_STEP }, scope: ME_ONLY, settings: "appearance", agent: "planned" },
  prominentActive: { status: "reserved", issue: 4193, shape: { kind: "toggle" }, scope: LATER_SHARE, settings: "appearance", agent: "planned" },
  // 카드 「배경」. 팀 기본 · 공유 · 에이전트는 단색 · 기본 제공만이다: 이 기기의 사진은 기기를 떠나지 않는다(`deviceOnly`).
  wallpaper: { status: "live", shape: { kind: "wallpaper", solids: SOLID_IDS, presets: PRESET_IDS, deviceOnly: ["image"] }, scope: ME_TEAM_SHARE, settings: "appearance", agent: "planned" },
  sidebarColor: { status: "reserved", issue: 4192, shape: { kind: "hexColor" }, scope: LATER_TEAM_SHARE, settings: "appearance", agent: "planned" },
  conversationBackdrop: { status: "reserved", issue: 6086, shape: { kind: "toggle" }, scope: LATER_SHARE, settings: "appearance", agent: "planned" },
  // 카드 「글꼴」. 공유는 이름만(글꼴 파일은 내려받지 않는다).
  fontSans: { status: "live", shape: { kind: "fontName", pattern: FONT_NAME_PATTERN, max: FONT_NAME_MAX }, scope: ME_SHARE, settings: "appearance", agent: "none" },
  fontMono: { status: "live", shape: { kind: "fontName", pattern: FONT_NAME_PATTERN, max: FONT_NAME_MAX }, scope: ME_SHARE, settings: "appearance", agent: "none" },
  // 카드 「대화 표시」
  fontSize: { status: "live", shape: { kind: "choice", options: FONT_SIZE_IDS }, scope: ME_SHARE, settings: "appearance", agent: "planned" },
  density: { status: "live", shape: { kind: "choice", options: DENSITY_DISPLAY_ORDER }, scope: ME_SHARE, settings: "appearance", agent: "planned" },
  // 값과 차례는 웹 `features/timeline/linkPreviewPreference.ts`의 `LINK_PREVIEW_PREFERENCES`와 같다(웹 시험이 견준다).
  linkPreview: { status: "live", shape: { kind: "choice", options: ["compact", "rich", "off"] }, scope: ME_ONLY, settings: "appearance", agent: "none" },
  // 이 기기 · 이 워크스페이스 · 이 사람에게 저장된다.
  expressionSuggest: { status: "live", shape: { kind: "toggle" }, scope: ME_ONLY, settings: "appearance", agent: "none" },
  threadLayout: { status: "reserved", issue: 4193, shape: { kind: "choice", options: THREAD_LAYOUT_IDS }, scope: LATER_SHARE, settings: "appearance", agent: "planned" },
  bubble: { status: "reserved", issue: 4307, scope: LATER_TEAM_SHARE, settings: "appearance", agent: "planned" },
  // 카드 「내 테마」(토큰 직접 고치기 · 저장 · 내보내기 · 가져오기)
  myThemes: { status: "reserved", issue: 4192, scope: LATER_TEAM_SHARE, settings: "appearance", agent: "planned" },
  // 설정 › 단축키. 줄은 등록표(`keyboardShortcuts.ts`)에서 나오므로 이 표는 갈래와 값 모양만 적는다.
  shortcuts: { status: "live", shape: { kind: "keyCombo", codePattern: KEY_COMBO_CODE_PATTERN }, scope: ME_SHARE, settings: "shortcuts", agent: "planned" },
  // 자리가 아직 없는 것
  navIcons: { status: "reserved", issue: 4260, scope: LATER_SHARE, settings: null, agent: "planned" },
  sounds: { status: "reserved", issue: null, scope: { me: "planned", teamDefault: "none", share: "none" }, settings: null, agent: "planned" },
} as const satisfies Record<string, CustomizeItem>;

export type CustomizeItemId = keyof typeof CUSTOMIZE_MAP;

export const CUSTOMIZE_ITEM_IDS = Object.keys(CUSTOMIZE_MAP) as CustomizeItemId[];

export function customizeItem(id: CustomizeItemId): CustomizeItem {
  return CUSTOMIZE_MAP[id];
}

// ---- 설정 › 모양의 자리 -------------------------------------------------------

/** 줄이 서는 조건. 조건이 없는 줄은 늘 선다. */
export type AppearanceRowCondition =
  /** 맥 데스크탑 앱에서 유리를 켰고 조절할 수 있다(`GlassRows`의 `showSlider`). */
  | "glass-adjustable"
  /** 워크스페이스의 표현 보관함 안이다(앱의 설정 화면은 늘 그 안이다). */
  | "expression-store";

/** 항목이 아닌 줄의 쓰임: 미리보기 · 목록 불러오기 · 되돌리기. 값을 저장하지 않는다. */
export type AppearanceAid = "preview" | "load-list" | "reset";

export type AppearanceRow =
  | { item: CustomizeItemId; anchor: string; when?: AppearanceRowCondition }
  | { aid: AppearanceAid; anchor: string; when?: AppearanceRowCondition };

export type AppearanceCardId = "color" | "backdrop" | "font" | "display";

export interface AppearanceCard {
  card: AppearanceCardId;
  rows: readonly AppearanceRow[];
}

/**
 * 설정 › 모양에 그려지는 카드와 줄, 위에서 아래 차례. `anchor`는 그 줄(`.settings-row`) 자신이나 그 안의
 * `data-testid`다. 예약 항목은 줄이 없다: 소유 이슈가 행을 열 때(`*_OPEN = true`) 여기에 줄을 더하고 항목을 live로 바꾼다.
 */
export const APPEARANCE_LAYOUT: readonly AppearanceCard[] = [
  {
    card: "color",
    rows: [
      { item: "scheme", anchor: "theme-choice" },
      { item: "theme", anchor: "theme-style-row" },
      { item: "accent", anchor: "accent-choice" },
      { item: "glass", anchor: "glass-background-row" },
      { item: "glassOpacity", anchor: "glass-opacity-row", when: "glass-adjustable" },
      { aid: "preview", anchor: "theme-preview" },
    ],
  },
  {
    card: "backdrop",
    rows: [
      // 이름 · 되돌리기 줄과 고르기 줄, 두 줄이 한 항목이다.
      { item: "wallpaper", anchor: "wallpaper-row" },
      { item: "wallpaper", anchor: "wallpaper-choices" },
    ],
  },
  {
    card: "font",
    rows: [
      { item: "fontSans", anchor: "font-sans-input" },
      { item: "fontMono", anchor: "font-mono-input" },
      { aid: "load-list", anchor: "font-list" },
      { aid: "preview", anchor: "font-preview-row" },
      { aid: "reset", anchor: "font-reset-row" },
    ],
  },
  {
    card: "display",
    rows: [
      { item: "fontSize", anchor: "font-size-row" },
      { item: "density", anchor: "density-row" },
      { item: "linkPreview", anchor: "link-preview-choice" },
      { aid: "preview", anchor: "conversation-preview" },
      { item: "expressionSuggest", anchor: "expression-suggest-row", when: "expression-store" },
    ],
  },
];

/** 설정 화면에서 항목의 자리(카드와 그 카드 안 첫 줄의 차례). 모양 갈래 밖이거나 줄이 없으면 `null`. */
export function appearancePlace(id: CustomizeItemId): { card: AppearanceCardId; index: number } | null {
  for (const card of APPEARANCE_LAYOUT) {
    const index = card.rows.findIndex((row) => "item" in row && row.item === id);
    if (index >= 0) return { card: card.card, index };
  }
  return null;
}

// ---- 값 판정 ---------------------------------------------------------------

const KEY_COMBO_CODE_RE = new RegExp(KEY_COMBO_CODE_PATTERN);
const WALLPAPER_IMAGE_FIELDS = new Set(["kind", "width", "height", "rev"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => keys.has(key));
}

/**
 * 이 모양이 받는 값인가. 모르는 열쇠가 붙은 객체 · 주소 · CSS 조각은 어느 모양도 받지 않는다. 아직 부르는 제품 코드는
 * 없다: 테마 파일 가져오기(CZ-3)와 에이전트 제안(CZ-5)이 바깥 값을 들일 때 쓰도록 둔 판정이다.
 *
 * `from`: `"this-device"`는 이 기기의 설정 화면이 고른 값, `"outside"`(기본)는 파일 · 에이전트처럼 기기 밖에서 온 값이다.
 * 바깥 값은 기기 전용 갈래(이 기기의 사진)를 받지 않는다.
 */
export function acceptsCustomizeValue(
  shape: CustomizeShape,
  value: unknown,
  from: "this-device" | "outside" = "outside"
): boolean {
  switch (shape.kind) {
    case "choice":
      return typeof value === "string" && shape.options.includes(value);
    case "toggle":
      return typeof value === "boolean";
    case "percent":
      return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= shape.min &&
        value <= shape.max &&
        (value - shape.min) % shape.step === 0
      );
    case "themeRef": {
      if (isThemeId(value)) return true;
      const ref = splitThemeRef(value);
      return ref !== null && ref.namespace === "catalog" && isCatalogId(ref.id);
    }
    case "wallpaper": {
      if (value === null) return true;
      if (!isPlainObject(value)) return false;
      if (value.kind === "solid" || value.kind === "preset") {
        const ids = value.kind === "solid" ? shape.solids : shape.presets;
        return hasOnlyKeys(value, new Set(["kind", "id"])) && typeof value.id === "string" && ids.includes(value.id);
      }
      if (value.kind === "image") {
        if (from === "outside" && shape.deviceOnly.includes("image")) return false;
        return (
          hasOnlyKeys(value, WALLPAPER_IMAGE_FIELDS) &&
          ["width", "height", "rev"].every((key) => value[key] === undefined || Number.isInteger(value[key]))
        );
      }
      return false;
    }
    case "fontName":
      return typeof value === "string" && parseFontName(value).ok;
    case "keyCombo":
      return (
        isPlainObject(value) &&
        hasOnlyKeys(value, new Set(["code", "shift", "alt"])) &&
        typeof value.code === "string" &&
        KEY_COMBO_CODE_RE.test(value.code) &&
        typeof value.shift === "boolean" &&
        typeof value.alt === "boolean"
      );
    case "hexColor":
      return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value);
  }
}
