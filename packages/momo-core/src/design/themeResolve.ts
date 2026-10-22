// =============================================================================
// 테마 참조(ThemeRef)와 모드 판정 (AP-1a #4186 골격, AP-1b #4188이 카탈로그를 채웠다. 청사진 §5.2-a·f).
//
// 이 파일은 **문법과 판정 규칙**을 든다. `catalog:<id>`가 실제로 있는지·어떤 모드를 갖는지는 카탈로그 **색인**
// (`themeCatalogIndex.generated.ts`: id·모드 한 줄, 원문 약 0.6KB)이 답한다. 씨앗 표(`themeCatalog.generated.ts`)는 읽지
// 않는다: 이 파일은 메인 번들에 들어가고 씨앗 표는 갤러리와 함께 지연 로드된다. 규칙을 가짜 단일 모드 참조로도
// 잴 수 있도록 조회 함수는 여전히 인자로 받는다(`ModesLookup`, 기본은 카탈로그 색인).
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
import { THEME_CATALOG_INDEX } from "./themeCatalogIndex.generated";
import { DEFAULT_THEME_ID, MODES, THEME_LABELS, isThemeId, type Mode, type ThemeId } from "./themes";

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

/** 문법만 본다(카탈로그에 있는지는 `normalizeThemeRef`가 본다). */
export function isThemeRef(value: unknown): value is ThemeRef {
  return isThemeId(value) || splitThemeRef(value) !== null;
}

export type ModeSet = readonly Mode[];

const MODE_SETS: Readonly<Record<string, ModeSet>> = { l: ["light"], d: ["dark"], b: MODES };

/** 색인 한 줄(`"<id>:<l|d|b> …"`)을 id → 모드로 푼다. 갤러리 순서(id 순)가 Map의 삽입 순서다. */
const CATALOG_MODES: ReadonlyMap<string, ModeSet> = new Map(
  THEME_CATALOG_INDEX.split(" ").map((item) => [item.slice(0, -2), MODE_SETS[item.slice(-1)]])
);

/** 카탈로그 항목 id 전부, 갤러리 순서(id 순)다. */
export const CATALOG_IDS: readonly string[] = [...CATALOG_MODES.keys()];

export function isCatalogId(id: string): boolean {
  return CATALOG_MODES.has(id);
}

/**
 * 저장된 값을 참조로 읽는다. 문법이 틀리거나 카탈로그에 없는 `catalog:` id면 기본 테마다(청사진 §5.3-d
 * 「모르는 값은 dawnsky」). `user:` 참조는 문법만 본다: 사용자 테마의 목록은 웹 저장소(AP-5)가 알고 core는 모른다.
 */
export function normalizeThemeRef(raw: unknown): ThemeRef {
  if (isThemeId(raw)) return raw;
  const parts = splitThemeRef(raw);
  if (parts === null) return DEFAULT_THEME_ID;
  if (parts.namespace === "catalog" && !CATALOG_MODES.has(parts.id)) return DEFAULT_THEME_ID;
  return raw as ThemeRef;
}

export function paletteOf(ref: ThemeRef): PaletteId {
  return isThemeId(ref) ? ref : DERIVED_PALETTE;
}

/** 참조가 가진 모드를 돌려주는 조회. 모르는 참조는 `null`(양쪽으로 본다). */
export type ModesLookup = (ref: ThemeRef) => ModeSet | null | undefined;

/** 기본 조회: 카탈로그 색인. `user:` 참조와 카탈로그에 없는 id는 모른다(`undefined`). */
export const catalogModesLookup: ModesLookup = (ref) => {
  const parts = splitThemeRef(ref);
  return parts?.namespace === "catalog" ? CATALOG_MODES.get(parts.id) : undefined;
};

/**
 * 테마가 가진 모드. 첫 파티 3종은 언제나 둘 다다. 그 밖의 참조는 조회가 말하는 대로이고(기본은 카탈로그
 * 색인), 모르면 둘 다로 본다(깨진 데이터가 화면을 한 모드에 가두지 않게). 결과는 `MODES` 순서(라이트, 다크)·중복
 * 없음이다.
 */
export function modesOf(ref: ThemeRef, lookup: ModesLookup | undefined = catalogModesLookup): ModeSet {
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

// ---- 단일 모드 규칙 (청사진 §5.2-a, Buzz `handleModeSelect`) -------------------------------------------
//
// 규칙 2·3(색 모드를 바꿀 때)은 메인 번들의 색 모드 컨트롤이 부르므로 여기 있다. 규칙 1(테마를 고를 때)과 갤러리
// 목록은 갤러리 청크만 쓰므로 `themeGallery.ts`에 따로 둔다(이 파일은 메인 번들에 실린다).
//
// 카탈로그는 라이트·다크 짝을 **한 항목**으로 묶으므로(`themeCatalogIndex`) 「짝」은 항목 안의 두 모드다.
// 모드가 하나뿐인 항목은 짝이 없고, 그 모드를 가진 첫 테마는 첫 파티 새벽하늘이다(첫 파티가 갤러리 맨 앞이고
// 셋 다 두 모드를 가진다).

/** 색 모드를 바꿨는데 지금 테마가 그 모드로 설 수 없어 다른 테마로 옮기는 일. */
export interface ThemeMove {
  readonly from: ThemeRef;
  readonly to: ThemeRef;
  /** `needs-pair`: 시스템으로 바꿨는데 짝이 없다. `needs-mode`: 라이트·다크로 바꿨는데 그 모드가 없다. */
  readonly why: "needs-pair" | "needs-mode";
  /** `needs-mode`일 때 필요했던 모드. */
  readonly mode: Mode | null;
}

/**
 * 규칙 2·3. 색 모드를 `next`로 바꿀 때 지금 테마를 어디로 옮겨야 하는가(옮길 필요가 없으면 `null`).
 * 두 모드를 다 가진 테마는 어느 모드로 바꿔도 그대로다.
 */
export function themeMoveForScheme(
  theme: ThemeRef,
  next: SchemeChoice,
  lookup?: ModesLookup
): ThemeMove | null {
  const modes = modesOf(theme, lookup);
  if (modes.length > 1) return null;
  if (next === "system") return { from: theme, to: DEFAULT_THEME_ID, why: "needs-pair", mode: null };
  if (modes.includes(next)) return null;
  return { from: theme, to: DEFAULT_THEME_ID, why: "needs-mode", mode: next };
}

const MODE_NAMES: Readonly<Record<Mode, string>> = { light: "라이트", dark: "다크" };

/** 규칙 2·3이 테마를 옮겼을 때의 한 줄. */
export function moveNotice(move: ThemeMove): string {
  // 떠나는 테마의 이름은 카탈로그 라벨(지연 청크)이라 메인 번들이 모른다: 「이 테마」로 말한다. 옮겨 간 곳은 첫 파티다.
  const to = isThemeId(move.to) ? THEME_LABELS[move.to] : move.to;
  return move.why === "needs-pair"
    ? `이 테마는 한쪽 모드만 있어서 ${to}로 바꿨어요.`
    : `이 테마에는 ${MODE_NAMES[move.mode ?? "light"]}가 없어서 ${to}로 바꿨어요.`;
}
