import {PHOTO_MAX_BYTES, PHOTO_MAX_LONG_SIDE, type BackgroundChoice} from '@momo/core/design/mobileBackground';

// =============================================================================
// 내 사진 → 앱 샌드박스의 JPEG 한 장 (ADR-0189 증보 2, #3907).
//
// 고른 사진은 **원본을 그대로 쓰지 않는다.** 보관함의 사진은 12MP·HEIC·EXIF(위치)를
// 달고 오고, 그대로 홈 바닥 뒤에 깔면 메모리와 첫 페인트를 먹는다. 그래서 항상 재인코딩
// 한다: 긴 변 ≤ 1600px, JPEG, ~1MB 이하. 재인코딩은 EXIF 를 벗기고 HEIC 를 JPEG 로
// 정규화하는 부수 효과도 있다. 결과는 **이 기기의 앱 샌드박스 안에만** 있고 서버로
// 올라가지 않는다(업로드 경로 자체가 이 모듈에 없다).
//
// 이 파일은 순수 오케스트레이션이다 — 고르기·줄이기·크기 재기·옮기기는 포트(`PhotoPorts`)로
// 받는다. 네이티브 실제 구현은 `photoNative.ts` 에 있고, 시험은 포트를 바꿔 상한 산수와
// 실패 갈래를 잰다.
// =============================================================================

export type PickOutcome =
  | {kind: 'picked'; uri: string; width: number; height: number}
  | {kind: 'cancelled'}
  | {kind: 'denied'}
  | {kind: 'error'};

export interface PhotoPorts {
  pick(): Promise<PickOutcome>;
  /**
   * 긴 변을 `longSide` 로 줄이고(더 작으면 그대로) `quality`(0~1)의 JPEG 로 다시 쓴다.
   * `width`·`height` 는 고른 원본의 크기다(다시 읽어 재지 않는다).
   */
  shrink(
    uri: string,
    options: {longSide: number; quality: number; width: number; height: number},
  ): Promise<{uri: string; width: number; height: number}>;
  /** 바이트 수. 읽지 못하면 `null`. */
  sizeOf(uri: string): number | null;
  /** 결과 파일을 샌드박스 디렉터리의 `name` 으로 옮긴다. */
  keep(uri: string, name: string): void;
  /** 쓰지 않을 임시 파일을 지운다. 실패해도 던지지 않는다. */
  discard(uri: string): void;
  now(): number;
}

export type ImportFailure = 'cancelled' | 'denied' | 'unreadable' | 'too-large';

export type ImportOutcome =
  | {ok: true; choice: Extract<BackgroundChoice, {kind: 'photo'}>}
  | {ok: false; reason: ImportFailure};

/** 품질을 먼저 내리고, 그래도 크면 해상도를 한 단 낮춘다. 바닥은 흐려도 읽힌다(scrim 아래다). */
export const QUALITY_STEPS = [0.85, 0.7, 0.55, 0.4] as const;
export const SIDE_FACTORS = [1, 0.75, 0.56] as const;

export const IMPORT_FAILURE_COPY: Readonly<Record<ImportFailure, string | null>> = {
  cancelled: null,
  denied: '사진 보관함 접근이 꺼져 있어요. 설정에서 허용해 주세요.',
  unreadable: '이 사진을 읽지 못했어요. 다른 사진을 골라 주세요.',
  'too-large': '이 사진은 줄여도 너무 커요. 다른 사진을 골라 주세요.',
};

export async function importPhoto(ports: PhotoPorts): Promise<ImportOutcome> {
  const picked = await ports.pick();
  if (picked.kind === 'cancelled') return {ok: false, reason: 'cancelled'};
  if (picked.kind === 'denied') return {ok: false, reason: 'denied'};
  if (picked.kind === 'error') return {ok: false, reason: 'unreadable'};

  const longest = Math.max(picked.width, picked.height);
  if (!Number.isFinite(longest) || longest <= 0) return {ok: false, reason: 'unreadable'};
  const target = Math.min(PHOTO_MAX_LONG_SIDE, longest);

  let measured = false;
  for (const factor of SIDE_FACTORS) {
    const longSide = Math.max(1, Math.round(target * factor));
    for (const quality of QUALITY_STEPS) {
      let result: {uri: string; width: number; height: number};
      try {
        result = await ports.shrink(picked.uri, {
          longSide,
          quality,
          width: picked.width,
          height: picked.height,
        });
      } catch {
        return {ok: false, reason: 'unreadable'};
      }
      const size = ports.sizeOf(result.uri);
      if (size == null) {
        ports.discard(result.uri);
        continue;
      }
      measured = true;
      if (size <= PHOTO_MAX_BYTES) {
        const name = `bg-${ports.now()}.jpg`;
        ports.keep(result.uri, name);
        return {
          ok: true,
          choice: {kind: 'photo', file: name, width: result.width, height: result.height},
        };
      }
      ports.discard(result.uri);
    }
  }
  return {ok: false, reason: measured ? 'too-large' : 'unreadable'};
}
