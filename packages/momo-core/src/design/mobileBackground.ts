// =============================================================================
// 커스텀 배경의 모델 — 무엇을 고를 수 있고 어떻게 저장되는가 (ADR-0189 증보 2, #3907).
//
// 배경은 **폰의 홈·대화 바닥 뒤**에만 깔린다. 고를 수 있는 것은 넷이다: 없음(기본,
// 테마의 그라데이션 바닥) / 단색 / 기본 제공(코드로 만든 그라데이션) / 내 사진. 어느
// 것이든 그 위에 모드별 scrim 이 얹혀 글자 대비를 지킨다(`scrim.ts`) — 대비는 고른
// 것이 아니라 **최악 입력**으로 보장하므로, 이 파일의 색들은 취향이고 안전장치가
// 아니다.
//
// 기본 제공 그림은 이 저장소에서 CSS 그라데이션 문자열로 만든 것이다. 바이너리 자산도
// 외부 이미지도 없고, 저작권·라이선스 귀속이 필요 없다. RN 의 `experimental_backgroundImage`
// 가 그린다(구 아키텍처에서는 그리지 못하므로 `fallback` 단색을 둔다).
//
// 저장은 이 기기 로컬이고 서버로 가지 않는다. 사진은 앱 샌드박스 안의 JPEG 한 장이고
// 레코드는 파일 **이름**만 든다(경로는 코드가 조립한다 — 저장소에 든 문자열로 임의
// 경로를 읽지 않는다).
// =============================================================================

import {WALLPAPER_PRESETS, WALLPAPER_SOLIDS, isSolidId, isPresetId, type SolidId, type PresetId} from './wallpaper';
export {SOLID_IDS, PRESET_IDS, isSolidId, isPresetId, type SolidId, type PresetId} from './wallpaper';

export const BACKGROUND_ENTRY = 'momo.mobile.background.v1';

export const SOLIDS = WALLPAPER_SOLIDS;
export const PRESETS = WALLPAPER_PRESETS;

/** 내 사진의 처리 상한 — 긴 변 1600px, JPEG, 약 1MB 이하(ADR-0189 증보 2). */
export const PHOTO_MAX_LONG_SIDE = 1600;
export const PHOTO_MAX_BYTES = 1_000_000;

export type BackgroundChoice =
  | {kind: 'none'}
  | {kind: 'solid'; id: SolidId}
  | {kind: 'preset'; id: PresetId}
  | {
      kind: 'photo';
      /** 샌드박스 디렉터리 안의 파일 이름. 경로가 아니다. */
      file: string;
      width: number;
      height: number;
    };

export const NO_BACKGROUND: BackgroundChoice = {kind: 'none'};

const PHOTO_FILE = /^bg-[0-9]{1,16}\.jpg$/;

/**
 * 저장된 원문을 읽는다. 모르는 값·깨진 JSON·경로처럼 생긴 파일 이름은 **없음**이다 —
 * 저장소에는 옛 버전이 쓴 값도 손으로 넣은 값도 들어올 수 있고, 어느 것도 화면을 잠글
 * 이유가 되지 못한다.
 */
export function parseBackground(raw: string | null | undefined): BackgroundChoice {
  if (raw == null || raw === '') return NO_BACKGROUND;
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    return NO_BACKGROUND;
  }
  if (record == null || typeof record !== 'object') return NO_BACKGROUND;
  const r = record as Record<string, unknown>;
  if (r.v !== 1) return NO_BACKGROUND;
  if (r.kind === 'solid' && isSolidId(r.id)) return {kind: 'solid', id: r.id};
  if (r.kind === 'preset' && isPresetId(r.id)) return {kind: 'preset', id: r.id};
  if (
    r.kind === 'photo' &&
    typeof r.file === 'string' &&
    PHOTO_FILE.test(r.file) &&
    typeof r.width === 'number' &&
    typeof r.height === 'number' &&
    r.width > 0 &&
    r.height > 0
  ) {
    return {kind: 'photo', file: r.file, width: r.width, height: r.height};
  }
  return NO_BACKGROUND;
}

export function serializeBackground(choice: BackgroundChoice): string {
  return JSON.stringify({v: 1, ...choice});
}

export function backgroundLabel(choice: BackgroundChoice): string {
  switch (choice.kind) {
    case 'none':
      return '기본';
    case 'solid':
      return SOLIDS[choice.id].label;
    case 'preset':
      return PRESETS[choice.id].label;
    case 'photo':
      return '내 사진';
  }
}

/** 시스템 접근성 설정이 배경을 끄는 이유. 둘 다 불투명 기본 바닥으로 돌아간다. */
export type BackgroundFallback = 'reduce-transparency' | 'increase-contrast' | 'theme-contrast';

export const BACKGROUND_FALLBACK_COPY: Readonly<Record<BackgroundFallback, string>> = {
  'theme-contrast': '이 테마에서는 배경 위 글자 대비를 지키기 어려워 기본 바닥으로 보여요.',
  'reduce-transparency': '시스템 설정이 투명 효과를 끄고 있어서 기본 바닥으로 보여요.',
  'increase-contrast': '시스템 설정이 대비를 높이고 있어서 기본 바닥으로 보여요.',
};

/** 지금 실제로 배경을 깔아도 되는가. 접근성 설정이 항상 이긴다. */
export function effectiveBackground(
  choice: BackgroundChoice,
  reduceTransparency: boolean,
  increaseContrast: boolean,
): {active: boolean; fallback: BackgroundFallback | null} {
  if (choice.kind === 'none') return {active: false, fallback: null};
  if (reduceTransparency) return {active: false, fallback: 'reduce-transparency'};
  if (increaseContrast) return {active: false, fallback: 'increase-contrast'};
  return {active: true, fallback: null};
}
