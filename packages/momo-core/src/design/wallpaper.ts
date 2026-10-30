// =============================================================================
// 웹·데스크탑 배경화면: 고를 수 있는 것, 사진의 상한, scrim 산수, 켜도 되는지의 판정
// (ADR-0189 증보 3 D4·D6, 증보 2 D2~D7, AP-4 #4191).
//
// 배경화면은 창 바닥(사이드바 열·창 가장자리·상단 줄) 뒤에 깔리는 그림 한 장이고, 그 위에 바닥색
// 한 겹(scrim)이 얹혀 글자 대비를 지킨다. 그림은 우리가 못 보는 입력이다. 그래서 보장은 「이 그림에서
// 읽힌다」가 아니라 「어떤 그림이어도 읽힌다」이고, scrim 합성의 대비는 그림 휘도에 단조이므로 최악은
// 순흑 그림·순백 그림 두 끝이다(`scrim.ts` 머리말). 이 파일은 그 산수를 웹 창 바닥에 맞춘다.
//
// ## 폰과 공유
//
// 단색 여덟·기본 제공 여섯의 원천은 이 파일이다. AP-6(#4194)이 폰의 중복 표·모델을 걷었고,
// 폰은 `mobileBackground.ts`의 기존 저장 스키마(photo·샌드박스 파일 이름)와 이 표를 읽는다.
// 웹 사진 상한(2560·1.5MB)과 폰 상한(1600·1MB)은 각 화면에 맞춰 따로 유지한다.
// 우리 코드의 이전이라 외부 귀속은 없고, Buzz에는 배경화면이 없어 가져온 코드도 없다.
//
// ## 왜 바닥색 한 겹이고 그 불투명도는 테마·모드별 하한인가
//
// 하한은 글자 `ink`가 최악 합성 두 끝에서 7:1(AAA)을 지키는 최소 불투명도(0.01 올림)다. 4.5가 아니라 7인
// 이유는 보조·강조 글자가 잉크보다 연하게 서야 위계가 남는데, 잉크가 4.5에서 끝나면 그 아래 어떤 색도 4.5를
// 못 넘기 때문이다(증보 2 D3). 폰은 첫 파티 여섯 조합의 최댓값을 올림한 토큰 둘(0.70·0.78)을 쓰지만, 웹은
// 카탈로그·가져온 테마가 있어서 한 값으로 묶을 수 없다. 테마·모드마다 자기 하한을 구해 쓴다(`scrimFloor`).
//
// 하한이 슬라이더 최대(95%)를 넘는 테마·모드는 쓸 수 없고(사진이 5% 미만만 남는다), 0.85~0.95이면 쓸 수는 있되
// 사진이 많이 흐려진다는 힌트를 보인다. 유리(AP-3)와 같은 기준이다(증보 3 D6 「불가 판정은 하나」). 이 파일의
// 하한은 **칠해지는 면에 맞춰** 잰다: 배경화면 scrim은 바닥의 가운데 정지점(`canvas-mid`) 한 색이다.
//
// ## 순수 함수만
//
// UI·플랫폼 API·런타임 의존이 없다(`scripts/purity.mjs`). 사진을 읽고 쓰는 일은 포트로 받는다. 웹의 실제
// 구현(캔버스·IndexedDB)은 `clients/web/src/design/wallpaper/`에 있다.
// =============================================================================

import type { WallpaperRef } from "./appearance";
import {
  FIT_MARGIN,
  INK_MIN_ON_BACKDROP,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  fitForeground,
  minimumScrimAlpha,
  scrimColor,
  worstCaseBackdrops,
} from "./scrim";
import { contrast, normalizeHex } from "./color";
import { MODES, type ColorRole, type Mode, type ThemeModeSource } from "./themes";

// ---- 고를 수 있는 것 ------------------------------------------------------------

export const SOLID_IDS = ["slate", "rose", "amber", "sage", "sky", "plum", "clay", "ink"] as const;
export type SolidId = (typeof SOLID_IDS)[number];

/** 단색 8종. 취향이지 안전장치가 아니다: 글자 대비는 그 위의 scrim이 최악 입력으로 지킨다. */
export const WALLPAPER_SOLIDS: Readonly<Record<SolidId, { label: string; hex: string }>> = {
  slate: { label: "석판", hex: "#5B6B8C" },
  rose: { label: "장미", hex: "#C2557A" },
  amber: { label: "호박", hex: "#D9902F" },
  sage: { label: "세이지", hex: "#5E8C6A" },
  sky: { label: "하늘", hex: "#4F8FD6" },
  plum: { label: "자두", hex: "#7A4FA0" },
  clay: { label: "점토", hex: "#B4684A" },
  ink: { label: "먹", hex: "#23272F" },
};

export const PRESET_IDS = ["saebyeok", "noeul", "angae", "sup", "bam", "jinju"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/**
 * 기본 제공 그라데이션 6종. 이 저장소가 CSS 그라데이션 문자열로 만든 것이라 바이너리 자산도 외부 이미지도
 * 없고 귀속이 필요 없다(증보 2 D2). `fallback`은 그라데이션을 못 그리는 경로의 단색이다.
 */
export const WALLPAPER_PRESETS: Readonly<
  Record<PresetId, { label: string; gradient: string; fallback: string }>
> = {
  saebyeok: {
    label: "새벽",
    gradient: "linear-gradient(160deg, #F7C7A3 0%, #C9A7E8 55%, #6C7BD9 100%)",
    fallback: "#C9A7E8",
  },
  noeul: {
    label: "노을",
    gradient: "linear-gradient(180deg, #3B2A63 0%, #C2557A 62%, #F2A33A 100%)",
    fallback: "#C2557A",
  },
  angae: {
    label: "안개",
    gradient: "radial-gradient(circle at 30% 20%, #DDE7F2 0%, #8FA3BF 72%, #5F7391 100%)",
    fallback: "#8FA3BF",
  },
  sup: {
    label: "숲",
    gradient: "linear-gradient(150deg, #1F4D3A 0%, #4F8F6B 55%, #D4E7A8 100%)",
    fallback: "#4F8F6B",
  },
  bam: {
    label: "밤",
    gradient: "radial-gradient(circle at 70% 15%, #3A4A8C 0%, #131A3A 60%, #070A18 100%)",
    fallback: "#131A3A",
  },
  jinju: {
    label: "진주",
    gradient: "linear-gradient(135deg, #FFF1E6 0%, #E8EAF6 50%, #D5ECE9 100%)",
    fallback: "#E8EAF6",
  },
};

export function isSolidId(value: unknown): value is SolidId {
  return typeof value === "string" && (SOLID_IDS as readonly string[]).includes(value);
}

export function isPresetId(value: unknown): value is PresetId {
  return typeof value === "string" && (PRESET_IDS as readonly string[]).includes(value);
}

/**
 * 저장된 참조가 지금 코드가 아는 배경인가. `normalizeAppearance`는 단색·기본 제공의 id를 **문법**만 보고
 * 통과시키므로(다른 버전이 쓴 id일 수 있다), 표에 있는지는 여기서 한 번 더 묻는다. 모르는 id는 「없음」이다.
 */
export function isKnownWallpaper(ref: WallpaperRef | undefined): ref is WallpaperRef {
  if (ref === undefined) return false;
  if (ref.kind === "solid") return isSolidId(ref.id);
  if (ref.kind === "preset") return isPresetId(ref.id);
  return ref.kind === "image";
}

/** 행이 말하는 이름. 「없음」은 참조가 없는 것이다. */
export function wallpaperLabel(ref: WallpaperRef | undefined): string {
  if (!isKnownWallpaper(ref)) return WALLPAPER_COPY.none;
  if (ref.kind === "solid") return WALLPAPER_SOLIDS[ref.id as SolidId].label;
  if (ref.kind === "preset") return WALLPAPER_PRESETS[ref.id as PresetId].label;
  return WALLPAPER_COPY.photo;
}

// ---- 사진 -----------------------------------------------------------------------

/** 내 사진의 처리 상한: 긴 변 2560px, JPEG, 1.5MB 이하(증보 3 D4). 폰(1600·1MB)보다 웹 화면에 맞춘 값이다. */
export const PHOTO_MAX_LONG_SIDE = 2560;
export const PHOTO_MAX_BYTES = 1_500_000;
/** 읽기 전에 거절하는 입력의 크기. 이보다 큰 원본은 디코드만으로 메모리를 크게 먹는다. */
export const PHOTO_MAX_SOURCE_BYTES = 80_000_000;
export const PHOTO_MAX_SOURCE_PIXELS = 120_000_000;
/** 설정 화면의 작은 미리보기: 긴 변과 품질. */
export const PHOTO_THUMB_LONG_SIDE = 192;
export const PHOTO_THUMB_QUALITY = 0.7;
/** 품질을 먼저 내리고, 그래도 크면 해상도를 한 단 낮춘다. 바닥은 흐려도 읽힌다(scrim 아래다). */
export const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4] as const;
export const SIDE_FACTORS = [1, 0.75, 0.56] as const;

export interface DecodedPhoto<H> {
  handle: H;
  /** 디코드한 원본의 크기(회전을 반영한 뒤). */
  width: number;
  height: number;
}

export interface EncodedPhoto<B> {
  bytes: B;
  /** 바이트 수. */
  size: number;
  width: number;
  height: number;
}

/**
 * 사진을 읽고 줄이는 일의 포트. 웹의 실제 구현은 `createImageBitmap` → 캔버스 → `toBlob` → `stripJpegMetadata`다.
 * 시험은 가짜 포트로 계단의 산수와 실패 갈래를 잰다. `decode`는 읽지 못하면 `null`이고, `encode`는 JPEG로 다시
 * 쓰지 못하면(또는 메타데이터를 걷지 못한 출력이면) `null`이다. 항상 다시 쓰므로 원본의 EXIF(위치 포함)가 벗겨지고,
 * 인코더가 쓴 메타데이터는 포트가 걷는다(`jpegMetadata.ts`).
 */
export interface PhotoPorts<S, H, B> {
  decode(source: S): Promise<DecodedPhoto<H> | null>;
  /** 긴 변을 `longSide`로 줄이고(더 작으면 그대로) `quality`(0~1)의 JPEG로 다시 쓴다. */
  encode(handle: H, options: { longSide: number; quality: number }): Promise<EncodedPhoto<B> | null>;
  /** 디코드한 그림을 놓는다. 던지지 않는다. */
  release(handle: H): void;
  now(): number;
}

export type ImportFailure = "unreadable" | "too-large";

export type ImportOutcome<B> =
  | {
      ok: true;
      photo: EncodedPhoto<B> & { thumb: EncodedPhoto<B> | null; rev: number };
    }
  | { ok: false; reason: ImportFailure };

/**
 * 고른 사진 한 장을 상한 안으로 줄인다. 원본을 그대로 쓰지 않는다: 보관함의 사진은 12MP·HEIC·EXIF(위치)를
 * 달고 오고, 그대로 창 바닥 뒤에 깔면 메모리와 첫 페인트를 먹는다. 항상 다시 쓰는 것이 원본의 EXIF를 벗기고
 * HEIC를 JPEG로 정규화하는 길이다.
 *
 * 더 작은 사진은 키우지 않는다(`target = min(상한, 긴 변)`). 계단의 끝까지 가도 크면 거절한다.
 */
export async function importPhoto<S, H, B>(
  ports: PhotoPorts<S, H, B>,
  source: S,
  sourceBytes: number
): Promise<ImportOutcome<B>> {
  if (!Number.isFinite(sourceBytes) || sourceBytes <= 0) return { ok: false, reason: "unreadable" };
  if (sourceBytes > PHOTO_MAX_SOURCE_BYTES) return { ok: false, reason: "too-large" };

  let decoded: DecodedPhoto<H> | null;
  try {
    decoded = await ports.decode(source);
  } catch {
    decoded = null;
  }
  if (decoded === null) return { ok: false, reason: "unreadable" };

  try {
    const { width, height } = decoded;
    const longest = Math.max(width, height);
    if (!Number.isFinite(longest) || longest <= 0 || !Number.isFinite(width * height)) {
      return { ok: false, reason: "unreadable" };
    }
    if (width * height > PHOTO_MAX_SOURCE_PIXELS) return { ok: false, reason: "too-large" };

    const target = Math.min(PHOTO_MAX_LONG_SIDE, longest);
    let measured = false;
    for (const factor of SIDE_FACTORS) {
      const longSide = Math.max(1, Math.round(target * factor));
      for (const quality of QUALITY_STEPS) {
        let encoded: EncodedPhoto<B> | null;
        try {
          encoded = await ports.encode(decoded.handle, { longSide, quality });
        } catch {
          return { ok: false, reason: "unreadable" };
        }
        if (encoded === null || !Number.isFinite(encoded.size)) continue;
        measured = true;
        if (encoded.size > PHOTO_MAX_BYTES) continue;
        let thumb: EncodedPhoto<B> | null = null;
        try {
          thumb = await ports.encode(decoded.handle, {
            longSide: Math.min(PHOTO_THUMB_LONG_SIDE, longest),
            quality: PHOTO_THUMB_QUALITY,
          });
        } catch {
          thumb = null;
        }
        return { ok: true, photo: { ...encoded, thumb, rev: ports.now() } };
      }
    }
    return { ok: false, reason: measured ? "too-large" : "unreadable" };
  } finally {
    ports.release(decoded.handle);
  }
}

// ---- scrim과 글자 보정 ------------------------------------------------------------

/** 바닥 위에 직접 서는 글자 역할(4.5 + 여유). 유리(AP-3)와 같은 목록이다. */
export const WALLPAPER_TEXT_ROLES = [
  "ink-muted",
  "signal-text",
  "agent",
  "ok",
  "warn",
  "danger",
] as const satisfies readonly ColorRole[];
/** 글자 없는 표식(아이콘·신호 채움, 3 + 여유). */
export const WALLPAPER_NON_TEXT_ROLES = ["icon", "signal"] as const satisfies readonly ColorRole[];
export type WallpaperTextRole = (typeof WALLPAPER_TEXT_ROLES)[number];
export type WallpaperNonTextRole = (typeof WALLPAPER_NON_TEXT_ROLES)[number];
export type WallpaperFittedRole = WallpaperTextRole | WallpaperNonTextRole;
/** 보정한 신호 채움 위 글자는 채움에 맞춰 다시 고른다. 보정 대상은 아니지만 변수는 싣는다. */
export const WALLPAPER_VAR_ROLES = [...WALLPAPER_TEXT_ROLES, ...WALLPAPER_NON_TEXT_ROLES, "on-signal"] as const;
export type WallpaperVarRole = (typeof WALLPAPER_VAR_ROLES)[number];

/** 하한이 이 퍼센트를 넘으면 쓸 수 없다(슬라이더 최대와 같은 값, 증보 3 D6). 0.95는 쓸 수 있고 0.96은 못 쓴다. */
export const WALLPAPER_USABLE_MAX_PERCENT = 95;
/** 하한이 이 퍼센트 이상이면 쓸 수는 있되 사진이 많이 흐려진다. */
export const WALLPAPER_BLURRY_MIN_PERCENT = 85;

/** 한 테마 × 모드에서 배경화면 산수가 읽는 값. 첫 파티·카탈로그·가져온 테마가 같은 모양으로 채운다. */
export interface WallpaperTokens {
  /** 바닥의 가운데 정지점(`canvas-mid`). scrim의 색이다. */
  canvas: string;
  /** 본문 잉크. 하한을 정하는 글자다. */
  ink: string;
  /** `on-primary`. 보정한 신호 채움 위 글자를 다시 고를 때 후보다. */
  onPrimary: string;
  /** 보정 전 `on-signal`. */
  onSignal: string;
  /** 보정 대상 역할의 현재 값. */
  roles: Readonly<Record<WallpaperFittedRole, string>>;
}

/** 첫 파티 표나 파생 엔진의 한 모드(`ThemeModeSource`)를 산수의 입력으로 옮긴다. */
export function wallpaperTokensOf(source: Pick<ThemeModeSource, "canvas" | "color">): WallpaperTokens {
  const color = source.color;
  return {
    canvas: source.canvas[1],
    ink: color.ink,
    onPrimary: color["on-primary"],
    onSignal: color["on-signal"],
    roles: {
      "ink-muted": color["ink-muted"],
      "signal-text": color["signal-text"],
      agent: color.agent,
      ok: color.ok,
      warn: color.warn,
      danger: color.danger,
      icon: color.icon,
      signal: color.signal,
    },
  };
}

export type WallpaperVerdict = "ok" | "blurry" | "unavailable";

export interface WallpaperTreatment {
  mode: Mode;
  /** 잉크 7:1의 최소 불투명도(0~1, 0.01 단위). 1이면 불투명으로도 못 지킨다. */
  floor: number;
  /** 깔 scrim의 불투명도. 하한과 같다. */
  alpha: number;
  verdict: WallpaperVerdict;
  /** `#rrggbbaa`. 바닥색에 `alpha`를 달았다. */
  scrim: string;
  /** 최악 합성 위로 명도만 옮긴 역할과 그 위의 `on-signal`. */
  roles: Readonly<Record<WallpaperVarRole, string>>;
}

/**
 * 한 테마 × 모드에서 배경화면을 어떻게 깔지: scrim의 불투명도(= 하한), 쓸 수 있는지, 바닥에 직접 서는
 * 글자·표식의 보정값.
 *
 * 보정은 하한에서 멈추지 않고 `FIT_MARGIN`을 얹은 값까지 간다(실제 사진은 글자 가장자리 주변 대비가
 * 흔들린다). 색상각과 채도는 그대로이고 명도만 옮긴다(라이트는 더 어둡게, 다크는 더 밝게). 잉크는 손대지
 * 않는다: 불투명도 자체가 7:1을 지킨다. 신호 채움은 움직이므로 그 위 글자는 원래 `on-signal`, 잉크,
 * `on-primary` 중 대비가 가장 큰 쪽으로 다시 고른다. 라이트에서 어두운 글자를 쓰는 테마(예: 노을띠)는
 * 채움이 어두워지면 대비가 줄기 때문이다.
 */
export function wallpaperTreatment(tokens: WallpaperTokens, mode: Mode): WallpaperTreatment {
  const floor = minimumScrimAlpha(tokens.canvas, tokens.ink, INK_MIN_ON_BACKDROP);
  const percent = Math.round(floor * 100);
  const verdict: WallpaperVerdict =
    percent > WALLPAPER_USABLE_MAX_PERCENT
      ? "unavailable"
      : percent >= WALLPAPER_BLURRY_MIN_PERCENT
        ? "blurry"
        : "ok";
  const alpha = floor;
  const hosts = worstCaseBackdrops(tokens.canvas, alpha);
  const roles = {} as Record<WallpaperVarRole, string>;
  for (const role of WALLPAPER_TEXT_ROLES) {
    roles[role] = fitForeground(tokens.roles[role], hosts, TEXT_MIN_ON_BACKDROP + FIT_MARGIN, mode);
  }
  for (const role of WALLPAPER_NON_TEXT_ROLES) {
    roles[role] = fitForeground(tokens.roles[role], hosts, NON_TEXT_MIN_ON_BACKDROP + FIT_MARGIN, mode);
  }
  roles["on-signal"] = bestOn(roles.signal, [tokens.onSignal, tokens.ink, tokens.onPrimary]);
  return { mode, floor, alpha, verdict, scrim: scrimColor(tokens.canvas, alpha), roles };
}

/** 채움 위에서 대비가 가장 큰 글자색(소문자 hex). 원래 후보(첫째)가 4.5를 지키면 그대로 둔다. */
function bestOn(fill: string, candidates: readonly string[]): string {
  const [original, ...rest] = candidates;
  if (contrast(original, fill) >= TEXT_MIN_ON_BACKDROP) return normalizeHex(original);
  return normalizeHex(
    rest.reduce((best, next) => (contrast(next, fill) > contrast(best, fill) ? next : best), original)
  );
}

// ---- 지금 실제로 깔아도 되는가 -----------------------------------------------------

/** 배경이 꺼진 이유(행의 문장을 고른다). 선택은 어느 이유에서도 지우지 않는다. */
export type WallpaperOffReason =
  | "reduce-transparency"
  | "increase-contrast"
  | "unavailable"
  | "unresolved"
  | "no-photo";

export interface WallpaperDecisionInput {
  ref: WallpaperRef | undefined;
  /** 지금 모드의 판정. 테마의 색을 못 읽었으면 `null`. */
  verdict: WallpaperVerdict | null;
  /** 시스템 「투명도 줄이기」. */
  reduceTransparency: boolean;
  /** 시스템 「대비 높이기」. */
  increaseContrast: boolean;
  /** 사진이 읽혀서 그릴 수 있는가(사진이 아닌 종류에서는 쓰지 않는다). */
  photoReady: boolean;
}

export interface WallpaperDecision {
  /** 실제로 깔아도 되는가. */
  live: boolean;
  /** 꺼진 이유. 고른 것이 없거나 깔려 있으면 `null`. */
  reason: WallpaperOffReason | null;
}

/**
 * 순서가 곧 우선순위다: 시스템 접근성 > 테마 불가 > 사진 준비. 시스템 설정이 항상 이긴다. 투명도 줄이기나
 * 대비 높이기를 켠 사람이 그것을 필요로 하는 이유가 바로 배경 위의 글자이기 때문이다(증보 2 D5).
 */
export function resolveWallpaper(input: WallpaperDecisionInput): WallpaperDecision {
  const off = (reason: WallpaperOffReason | null): WallpaperDecision => ({ live: false, reason });
  if (!isKnownWallpaper(input.ref)) return off(null);
  if (input.reduceTransparency) return off("reduce-transparency");
  if (input.increaseContrast) return off("increase-contrast");
  if (input.verdict === null) return off("unresolved");
  if (input.verdict === "unavailable") return off("unavailable");
  if (input.ref.kind === "image" && !input.photoReady) return off("no-photo");
  return { live: true, reason: null };
}

// ---- 유리와의 관계 ---------------------------------------------------------------

/**
 * 배경화면이 고른 상태면 유리(AP-3)는 쓸 수 없다. 둘 다 같은 창 바닥 층을 쓰고, 사진 위에 네이티브 블러를
 * 겹치면 최악 합성 보장이 깨진다(증보 3 결정 9). 「고른 상태」는 지금 실제로 깔렸는가가 아니라 **선택**이다.
 * 시스템 접근성이 배경을 꺼도, 이 테마에서 쓸 수 없어도 유리 역시 같은 이유로 꺼지기 때문이고, 선택을 풀
 * 때까지 유리를 켜 둘 이유가 없기 때문이다. AP-3의 `GlassInput.wallpaper`가 이 판정을 읽는다.
 */
export function wallpaperBlocksGlass(ref: WallpaperRef | undefined): boolean {
  return ref !== undefined;
}

// ---- 문장 ----------------------------------------------------------------------

export const WALLPAPER_COPY = {
  label: "배경화면",
  description:
    "사이드바 뒤와 창 가장자리에 깔려요. 글자가 읽히도록 반투명 면이 한 겹 얹혀서 사진이 조금 흐리게 보여요.",
  none: "기본",
  noneDetail: "테마의 바닥 그대로예요.",
  solid: "단색",
  preset: "기본 제공",
  photo: "내 사진",
  pickPhoto: "사진 고르기",
  pickAnotherPhoto: "다른 사진 고르기",
  busyPhoto: "사진을 줄이고 있어요",
  reset: "기본으로",
  privacy: "사진은 이 기기에만 저장되고 서버로는 올라가지 않아요.",
  replaceNote: "다른 배경을 고르면 이 기기에 저장한 사진은 지워져요.",
} as const;

/** 배경을 끈 이유를 한 줄로. 앞의 둘은 폰과 같은 문장이다(증보 2 D5). */
export const WALLPAPER_OFF_COPY: Readonly<Record<WallpaperOffReason, string>> = {
  "reduce-transparency": "시스템 설정이 투명 효과를 끄고 있어서 기본 바닥으로 보여요.",
  "increase-contrast": "시스템 설정이 대비를 높이고 있어서 기본 바닥으로 보여요.",
  unavailable: "이 테마에서는 글자 대비 때문에 배경화면을 쓸 수 없어요.",
  unresolved: "이 테마의 색을 읽지 못해서 기본 바닥으로 보여요.",
  "no-photo": "저장한 사진을 불러오지 못해서 기본 바닥으로 보여요.",
};

/** 쓸 수는 있지만 범위가 좁은 테마·모드의 힌트(하한 0.85~0.95). */
export const WALLPAPER_BLURRY_COPY = "이 테마에서는 글자 대비 때문에 사진이 많이 흐려져요.";

/**
 * 창이 이 폭보다 좁으면(폰 폭, 600px 미만) 판이 창 자체가 되어 바닥이 보이지 않는다: 사이드바는 자기 바탕이 있는 서랍이고 본문은 판이다.
 * 그래서 CSS는 이 폭 미만에서 아무것도 하지 않고(`wallpaper.css`의 `@media (width >= 600px)`), 설정 행은 그 사실을 말한다.
 */
export const WALLPAPER_MIN_WINDOW_PX = 600;
export const WALLPAPER_NARROW_COPY = "창이 좁아서 지금은 배경화면이 보이지 않아요. 넓은 창에서는 보여요.";

/** 사이드바에 띠가 있는 테마(노을띠): 띠가 위에 서서 사진은 가장자리에만 보인다. */
export const WALLPAPER_BAND_COPY = "이 테마는 사이드바에 띠가 있어서 배경화면이 창 가장자리에만 보여요.";

/** 사진을 가져오지 못한 이유. 취소는 문장이 없다. */
export const IMPORT_FAILURE_COPY: Readonly<Record<ImportFailure | "save-failed", string>> = {
  unreadable: "이 사진을 읽지 못했어요. 다른 사진을 골라 주세요.",
  "too-large": "이 사진은 줄여도 너무 커요. 다른 사진을 골라 주세요.",
  "save-failed": "사진을 이 기기에 저장하지 못했어요. 저장 공간을 확인하고 다시 시도해 주세요.",
};

// ---- CSS 변수 ------------------------------------------------------------------

/**
 * 웹이 루트에 꽂는 변수의 이름. `light-dark()`는 색만 받고 불투명도 같은 숫자는 못 받으므로 scrim도 알파가
 * 든 색(`#rrggbbaa`)으로 싣고, 모드별 변수 둘을 정적 CSS(`design/appearance/wallpaper.css`)가 `light-dark()`로
 * 묶는다. 그래서 스킴 전환을 JS가 따라가지 않아도 된다.
 */
export const WALLPAPER_VARS = {
  scrim: (mode: Mode): string => `--wallpaper-scrim-${mode}`,
  role: (role: WallpaperVarRole, mode: Mode): string => `--wallpaper-${role}-${mode}`,
} as const;

/**
 * 두 모드의 처리 결과를 루트 변수 표로 만든다. 한 모드만 있는 테마(카탈로그의 단일 모드)는 있는 모드의
 * 값을 두 칸에 싣는다. 쓸 수 없는 모드(`unavailable`)의 값도 싣는다: 그 모드에서 켜지지 않는 것은 JS가
 * 루트의 `data-wallpaper-live`로 정하고, 변수가 비면 `light-dark()`가 통째로 무효가 되어 모드가 바뀐
 * 한 프레임 동안 규칙이 깨진다.
 */
export function wallpaperVars(
  treatments: Readonly<Partial<Record<Mode, WallpaperTreatment>>>
): Record<string, string> {
  const vars: Record<string, string> = {};
  const present = MODES.filter((mode) => treatments[mode] !== undefined);
  if (present.length === 0) return vars;
  for (const mode of MODES) {
    const treatment = treatments[mode] ?? treatments[present[0]];
    if (treatment === undefined) continue;
    vars[WALLPAPER_VARS.scrim(mode)] = treatment.scrim;
    for (const role of WALLPAPER_VAR_ROLES) vars[WALLPAPER_VARS.role(role, mode)] = treatment.roles[role];
  }
  return vars;
}
