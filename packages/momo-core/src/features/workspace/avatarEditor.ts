import { MEMBER_AVATAR_MAX_BYTES } from "../../lib/api";
import { parseHex } from "../../design/color";
import {
  KOMETTO_EXPRESSIONS,
  KOMETTO_EXPRESSION_NAMES,
  type KomettoExpression,
} from "../onboarding/guide";
import { judgeGlyphVisibility, type GlyphVisibility } from "./avatarContrast";
import { inspectPng } from "./avatarPng";

// =============================================================================
// 아바타 편집기의 모델 (#4261): 무엇을 어떻게 그려 한 장의 PNG로 만드는가. 웹과 폰이 같은 표를 읽는다.
//
// ## 서버를 건드리지 않는다
//
// 사진은 이미 올릴 수 있다(`members/me/avatar/uploads·complete`, ADR-0161 증보). 이모지·코메토
// 아바타는 **클라이언트가 정사각 PNG 한 장으로 그려서** 그 길로 올린다. 서버에는 「이모지
// 아바타」라는 종류가 없고 그냥 PNG다. 그래서 공개 API·DB·권한이 하나도 바뀌지 않는다.
//
// ## 그려 올린 PNG가 정본이다
//
// 이모지는 기기마다 다르게 그려진다(Apple·Noto·Segoe 의 그림이 서로 다르다). 이모지 **글자**를 저장
// 하고 보는 쪽이 다시 그리면 같은 아바타가 사람마다 다른 얼굴로 보인다(Buzz 는 SVG 안에 글자를
// 넣어 그 길을 갔다). 여기서는 반대다: 그리는 사람의 기기가 **한 번** 그리고, 그 결과 PNG 바이트가
// 서버를 거쳐 모든 사람에게 그대로 간다. 보는 쪽에는 이모지를 다시 그릴 정보가 없다.
// 이 약속은 세 곳에서 지킨다.
//   1. `composeAvatarPng` 가 내놓는 `png` 는 포트가 낸 바이트 그대로다(다시 쓰지 않는다).
//   2. 올리는 쪽(웹 편집기)은 그 바이트를 한 글자도 바꾸지 않고 올린다.
//   3. 판정한 그림과 올린 그림이 같다: 판정은 글리프를 그린 표본의 픽셀을 보고(`avatarContrast.ts`),
//      통과한 같은 계획이 곧 PNG가 된다(`planAvatar` 가 표본과 본 그림의 계획을 하나로 만든다).
//
// ## 그리기는 포트다
//
// 이 파일은 순수하다(`scripts/purity.mjs`): 기하(글꼴 크기, 코메토 자르기), 판정, 순서, 검사만 한다.
// 글꼴로 이모지를 그리고 PNG로 굽는 일은 플랫폼 몫이라 `AvatarCanvasPorts` 로 받는다. 웹의 구현은
// `clients/web/src/features/settings/avatarEditor/canvasPorts.ts` 이고, 폰은 후속 이슈가 자기 구현을
// 붙인다(폰에는 아직 아바타 올리기 자체가 없다).
// =============================================================================

export const AVATAR_PNG_SIZE = 512;
export const AVATAR_PNG_MIME = "image/png";
/** 서버로 가는 파일 이름. 이모지·이름을 싣지 않는다(서버 로그에 남는 값이다). */
export const AVATAR_PNG_FILE_NAME = "avatar.png";

/** 판정에 쓰는 표본의 한 변. 전체 크기에서 비례로 줄인 같은 그림이고, 픽셀 수가 1/16이라 칩 열다섯을 바로 잰다. */
export const AVATAR_SAMPLE_SIZE = 128;

/**
 * 이모지 글꼴 크기 / 한 변. 이모지 글리프의 상자는 글꼴 크기의 1.0~1.2배이고, 사람 아바타는 원으로
 * 잘리므로(`rounded-full`) 그 상자가 안쪽 원에 들어와야 한다: 0.56 × 1.2 / 2 × √2 = 0.475 < 0.5.
 * 시험이 이 부등식을 못 박는다.
 */
export const AVATAR_EMOJI_SCALE = 0.56;

/** 한 변에 대한 비율로 적은 정사각 자르기. 폰의 에셋(600px)과 웹(576px)이 같은 비율을 쓴다. */
export interface SquareCrop {
  readonly x: number;
  readonly y: number;
  readonly size: number;
}

/**
 * 코메토 표정 컷(`docs/brand/kometto/faces/`, 576px 투명 컷) 중 머리와 얼굴을 담는 자르기.
 * 흉상 전체(0, 0, 1)는 24px 사이드바에서 얼굴 창이 검은 점으로 뭉개지므로, 얼굴 창과 후드를 키운 이 자르기를
 * 쓴다: 얼굴 중심이 원의 한가운데에서 조금 왼쪽 아래(0.46, 0.53)에 서고, 왼쪽 위에는 배경색이 보인다(배경을
 * 고르는 뜻이 남는다). 몸통이 투명하게 사라지는 아래쪽 띠(페이드)는 자르기 밖이라 페이드를 자르는 일도 없다.
 * 그림은 새로 그리지 않았고 정본 컷의 자르기와 배경색 조합뿐이다(이슈 #4261 「자르기·배경색 조합까지」).
 */
export const AVATAR_PRESET_CROP: SquareCrop = { x: 0.025, y: 0.105, size: 0.8 };

export type AvatarPresetId = KomettoExpression;

/** 프리셋 id 여섯: 코메토 표정 정본의 id 그대로다(새 이름을 만들지 않는다). 순서가 화면의 순서다. */
export const AVATAR_PRESET_IDS: readonly AvatarPresetId[] = KOMETTO_EXPRESSIONS;

export function isAvatarPresetId(value: unknown): value is AvatarPresetId {
  return typeof value === "string" && (AVATAR_PRESET_IDS as readonly string[]).includes(value);
}

/** 보조기술이 읽는 이름. 「코메토 기쁨」꼴이다. */
export function avatarPresetLabel(id: AvatarPresetId): string {
  return `코메토 ${KOMETTO_EXPRESSION_NAMES[id]}`;
}

/** 그림 한 장의 알맹이: 이모지 하나 또는 코메토 표정 하나. 배경은 따로 고른다. */
export type AvatarGlyph =
  | { readonly kind: "emoji"; readonly emoji: string }
  | { readonly kind: "preset"; readonly preset: AvatarPresetId };

/** 편집기가 한 장으로 굽는 초안. `bg` 는 소문자 `#rrggbb` 다(`normalizeFreeColor` 가 만든다). */
export type AvatarDraft = AvatarGlyph & { readonly bg: string };

export type AvatarForeground =
  | { readonly kind: "emoji"; readonly text: string; readonly fontPx: number }
  | { readonly kind: "art"; readonly art: AvatarPresetId; readonly crop: SquareCrop };

export interface AvatarPlan {
  readonly size: number;
  readonly bg: string;
  readonly foreground: AvatarForeground;
}

/** 글리프 → 한 변이 `size` 인 층에 그릴 앞면. 표본과 본 그림이 같은 함수에서 나와서 비율이 같다. */
export function planGlyph(glyph: AvatarGlyph, size: number): AvatarForeground {
  switch (glyph.kind) {
    case "emoji":
      return { kind: "emoji", text: glyph.emoji, fontPx: Math.round(size * AVATAR_EMOJI_SCALE) };
    case "preset":
      return { kind: "art", art: glyph.preset, crop: AVATAR_PRESET_CROP };
  }
}

/**
 * 초안 → 그리기 계획. **본 그림과 표본이 같은 함수에서 나온다**: 크기만 다르고 비율은 같으므로
 * 판정한 그림이 곧 올라가는 그림이다.
 */
export function planAvatar(draft: AvatarDraft, size: number): AvatarPlan {
  return { size, bg: draft.bg, foreground: planGlyph(draft, size) };
}

/** 코드포인트 수. 이모지는 ZWJ 열이라 UTF-16 길이로 재면 틀린다. */
function codePointCount(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** 이모지 한 개(ZWJ·피부색·깃발 열 포함)의 코드포인트 상한. 가장 긴 가족 이모지가 일곱 개다. */
const EMOJI_MAX_CODE_POINTS = 16;

/** 입력 색을 소문자 `#rrggbb` 로. `#abc`·`abc`·`#aabbcc`·`aabbcc` 만 받고 나머지는 `null`. */
export function normalizeFreeColor(input: string): string | null {
  const trimmed = input.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{3}$/.test(trimmed)) {
    const expanded = [...trimmed].map((digit) => digit + digit).join("");
    return `#${expanded.toLowerCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(trimmed)) return `#${trimmed.toLowerCase()}`;
  return null;
}

/**
 * 글리프가 그릴 수 있는 꼴인가. 사유를 말하지 않는다: 이 값들은 UI 가 고른 것(피커의 이모지, 프리셋 칸)이라
 * 어긋나면 사용자가 고칠 입력이 아니라 호출 쪽의 버그다.
 */
export function isValidAvatarGlyph(glyph: AvatarGlyph): boolean {
  if (glyph.kind === "emoji") {
    const text = glyph.emoji.trim();
    return text !== "" && codePointCount(text) <= EMOJI_MAX_CODE_POINTS;
  }
  return isAvatarPresetId(glyph.preset);
}

/** 초안이 그릴 수 있는 꼴인가: 글리프가 그릴 수 있고 배경이 `#rrggbb` 다. */
export function isValidAvatarDraft(draft: AvatarDraft): boolean {
  return parseHex(draft.bg) !== null && isValidAvatarGlyph(draft);
}

// ---- 그리기 포트 ---------------------------------------------------------------

/**
 * 플랫폼이 구현하는 그리기 동작. `Layer` 는 호스트의 정사각 그림판(웹은 캔버스)이고, 이 파일은
 * 안을 모른다. 모든 메서드는 던지지 않는 쪽으로 구현한다(못 하면 `null`/`false`).
 */
export interface AvatarCanvasPorts<Layer> {
  /** 투명한 정사각 그림판. 만들 수 없으면 `null`. */
  createLayer(size: number): Layer | null;
  /** 전체를 한 색으로 칠한다(불투명). */
  fillBackground(layer: Layer, hex: string): void;
  /**
   * 한가운데에 글리프를 그린다. 글자는 **잉크 상자**를 층의 가운데에 맞추고(글꼴마다 기준선이
   * 다르다), 코메토는 정본 컷을 `crop` 으로 잘라 층 전체에 맞춘다. 그리지 못하면 `false`.
   */
  paintForeground(layer: Layer, foreground: AvatarForeground): Promise<boolean>;
  /** 층의 RGBA(곧은 알파). 읽을 수 없으면 `null`. */
  readPixels(layer: Layer): ArrayLike<number> | null;
  /** PNG 로 굽는다. 못 하면 `null`. 이 바이트가 정본이다. */
  toPng(layer: Layer): Promise<Uint8Array | null>;
  release?(layer: Layer): void;
}

export type AvatarComposeFailure =
  | "invalid-draft"
  | "no-canvas"
  | "paint-failed"
  | "blank"
  | "low-contrast"
  | "invalid-color"
  | "encode-failed"
  | "bad-output";

export type AvatarSample =
  | { readonly ok: true; readonly pixels: ArrayLike<number> }
  | { readonly ok: false; readonly reason: "no-canvas" | "paint-failed" };

/** 글리프만(배경 없이) 표본 크기로 그려 픽셀을 읽는다. 판정의 입력이다. */
export async function sampleAvatarForeground<Layer>(
  ports: AvatarCanvasPorts<Layer>,
  glyph: AvatarGlyph
): Promise<AvatarSample> {
  if (!isValidAvatarGlyph(glyph)) return { ok: false, reason: "paint-failed" };
  const foreground = planGlyph(glyph, AVATAR_SAMPLE_SIZE);
  const layer = ports.createLayer(AVATAR_SAMPLE_SIZE);
  if (layer === null) return { ok: false, reason: "no-canvas" };
  try {
    if (!(await ports.paintForeground(layer, foreground))) {
      return { ok: false, reason: "paint-failed" };
    }
    const pixels = ports.readPixels(layer);
    return pixels === null ? { ok: false, reason: "paint-failed" } : { ok: true, pixels };
  } finally {
    ports.release?.(layer);
  }
}

/** 초안과 표본으로 판정한다. 표본이 없으면 그려지지 않은 것(`blank`)이다. */
export function judgeAvatarDraft(
  draft: AvatarDraft,
  pixels: ArrayLike<number> | null
): GlyphVisibility {
  if (pixels === null) return { ok: false, reason: "blank", share: 0 };
  return judgeGlyphVisibility(pixels, draft.bg);
}

export type AvatarRender =
  | {
      readonly ok: true;
      /** 포트가 굽은 PNG 그대로의 바이트. 정본이다. */
      readonly png: Uint8Array;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly reason: AvatarComposeFailure };

/**
 * 판정 없이 PNG 를 굽는다: 미리보기가 **묻히는 조합도 그대로 보여 주기** 위한 길이다(왜 안 되는지가
 * 눈에 보인다). 올리는 길은 이 함수가 아니라 `composeAvatarPng` 를 쓴다.
 *
 * `size` 는 미리보기 알갱이(작은 그림 여섯 장 등)가 줄여 그리게 하는 자리이고, 올리는 길은 늘 기본값 512다.
 */
export async function renderAvatarPng<Layer>(
  ports: AvatarCanvasPorts<Layer>,
  draft: AvatarDraft,
  size: number = AVATAR_PNG_SIZE
): Promise<AvatarRender> {
  if (!isValidAvatarDraft(draft)) return { ok: false, reason: "invalid-draft" };
  const plan = planAvatar(draft, size);
  const layer = ports.createLayer(size);
  if (layer === null) return { ok: false, reason: "no-canvas" };
  try {
    ports.fillBackground(layer, plan.bg);
    if (!(await ports.paintForeground(layer, plan.foreground))) {
      return { ok: false, reason: "paint-failed" };
    }
    const png = await ports.toPng(layer);
    if (png === null || png.byteLength === 0) return { ok: false, reason: "encode-failed" };
    // 포트가 PNG 가 아닌 것(SVG·빈 응답)이나 엉뚱한 크기를 내놓으면 올리지 않는다.
    const info = inspectPng(png);
    if (
      info === null ||
      info.width !== size ||
      info.height !== size ||
      png.byteLength > MEMBER_AVATAR_MAX_BYTES
    ) {
      return { ok: false, reason: "bad-output" };
    }
    return { ok: true, png, width: info.width, height: info.height };
  } finally {
    ports.release?.(layer);
  }
}

export type AvatarCompose =
  | {
      readonly ok: true;
      readonly png: Uint8Array;
      readonly width: number;
      readonly height: number;
      /** 판정이 잰 보이는 면적 비율. */
      readonly share: number;
    }
  | { readonly ok: false; readonly reason: AvatarComposeFailure };

/**
 * **올리는 길**: 판정을 통과한 초안만 PNG 가 된다. UI 가 저장 단추를 막더라도 이 함수가 한 번 더
 * 막는다(UI 의 상태와 저장이 어긋나도 묻히는 그림이 서버로 가지 않는다).
 */
export async function composeAvatarPng<Layer>(
  ports: AvatarCanvasPorts<Layer>,
  draft: AvatarDraft
): Promise<AvatarCompose> {
  if (!isValidAvatarDraft(draft)) return { ok: false, reason: "invalid-draft" };
  const sample = await sampleAvatarForeground(ports, draft);
  if (!sample.ok) return { ok: false, reason: sample.reason };
  const visibility = judgeAvatarDraft(draft, sample.pixels);
  if (!visibility.ok) return { ok: false, reason: visibility.reason };
  const rendered = await renderAvatarPng(ports, draft);
  return rendered.ok ? { ...rendered, share: visibility.share } : rendered;
}

// ---- 문구 ----------------------------------------------------------------------

/**
 * 편집기의 말. 웹 대화상자와 폰 화면이 같은 문장을 읽는다(같은 사유는 두 클라가 같은 말을 한다).
 * 사진 올리기의 오류 문구(`memberAvatarCopy`)는 웹에 있고, 여기는 새로 생긴 말뿐이다.
 */
export const AVATAR_EDITOR_COPY = {
  title: "아바타 바꾸기",
  description: "다른 멤버에게도 이 모습으로 보여요. 사진이 없으면 이름의 첫 글자가 보여요.",
  modeLegend: "아바타 종류",
  modes: { photo: "사진", emoji: "이모지", preset: "코메토" },
  previewLegend: "실제 크기 미리보기",
  previewSizes: { sidebar: "사이드바", message: "메시지", profile: "프로필" },
  photoPick: "사진 고르기",
  photoChange: "다른 사진 고르기",
  photoHint: "PNG, JPG, GIF, WebP. 5MB까지 올릴 수 있어요.",
  photoEmpty: "사진을 고르면 미리보기가 바뀌어요.",
  photoReadFailed: "이 사진을 읽지 못했어요. 다른 이미지를 골라 주세요.",
  emojiEmpty: "이모지를 고르면 미리보기가 바뀌어요.",
  presetLegend: "코메토 표정",
  presetHint: "코메토의 표정을 골라요. 코메토는 진한 배경에서 잘 보여요.",
  colorLegend: "배경색",
  colorFreeLabel: "직접 입력",
  colorFreeHint: "#RRGGBB 꼴로 적어요.",
  colorBlockedHint: "흐린 색은 지금 고른 그림이 묻혀서 고를 수 없어요.",
  save: "아바타 저장",
  saving: "올리는 중",
  cancel: "취소",
  reset: "기본으로 되돌리기",
  resetQuestion: "아바타를 지우고 이름의 첫 글자로 돌아가요.",
  resetConfirm: "되돌리기",
  resetBusy: "되돌리는 중",
  resetFailed: "아바타를 되돌리지 못했어요. 연결을 확인하고 다시 시도해 주세요.",
  offline: "연결이 끊겨 지금은 아바타를 바꿀 수 없어요.",
  doneSavedPhoto: "프로필 사진을 바꿨어요.",
  doneUploadedPhoto: "프로필 사진을 올렸어요.",
  doneSaved: "아바타를 바꿨어요.",
  doneReset: "기본 아바타로 돌아갔어요.",
  emojiLowContrast: "이 색 위에서는 이모지가 잘 안 보여요. 다른 색을 골라 주세요.",
  presetLowContrast: "이 색 위에서는 코메토가 잘 안 보여요. 다른 색을 골라 주세요.",
  emojiBlank: "이 기기에서는 이 이모지를 그리지 못했어요. 다른 이모지를 골라 주세요.",
  invalidColor: "색은 #RRGGBB 꼴로 적어 주세요.",
  drawFailed: "아바타를 그리지 못했어요. 잠시 뒤에 다시 시도해 주세요.",
} as const;

/** 판정·그리기 실패를 화면 문장으로. 같은 사유는 두 클라가 같은 말을 한다. */
export function avatarComposeFailureMessage(
  reason: AvatarComposeFailure,
  kind: AvatarDraft["kind"]
): string {
  switch (reason) {
    case "low-contrast":
      return kind === "preset"
        ? AVATAR_EDITOR_COPY.presetLowContrast
        : AVATAR_EDITOR_COPY.emojiLowContrast;
    case "blank":
      return kind === "preset" ? AVATAR_EDITOR_COPY.drawFailed : AVATAR_EDITOR_COPY.emojiBlank;
    case "invalid-color":
      return AVATAR_EDITOR_COPY.invalidColor;
    default:
      return AVATAR_EDITOR_COPY.drawFailed;
  }
}
