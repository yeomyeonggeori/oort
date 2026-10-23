import { buildPng, rgbaBuffer } from "@momo/core/features/workspace/__fixtures__/avatarFixture";
import type { AvatarCanvasPorts, AvatarForeground } from "@momo/core/features/workspace/avatarEditor";

// 아바타 편집기 시험용 가짜 그림판 (#4261). jsdom 에는 캔버스가 없으므로 시험은 이 포트를 꽂는다. 진짜 캔버스에서의
// 동작(그려진 PNG 의 모서리·가운데 맞춤·판정)은 `canvasPorts.browser.test.ts` 가 진짜 브라우저로 잰다.
//
// 포트가 굽는 PNG 는 **호출마다 다른 바이트**다(payload 가 번호를 든다). 그래서 시험은 「서버로 가는 바이트가 저장을 누른 뒤에
// 포트가 구운 그 바이트인가」를 한 글자 단위로 가릴 수 있다(미리보기가 구운 다른 PNG 와 섞이지 않는다).

export interface FakeLayer {
  readonly size: number;
  bg: string | null;
  foreground: AvatarForeground | null;
}

export interface FakeAvatarPortsOptions {
  /**
   * 표본 층이 읽혀 주는 글리프 픽셀(RGBA). 함수이면 표본 호출 번호(0부터)마다 다른 답을 줄 수 있다: 화면의 판정과 저장 길의
   * 판정이 어긋나는 경우를 흉내 낸다.
   */
  glyph?: ArrayLike<number> | null | ((sampleIndex: number) => ArrayLike<number> | null);
  noCanvas?: boolean;
  paintOk?: boolean;
}

/** 표본(128²)에서 노란 얼굴처럼 밝은 그림이 면적 15%를 채운다: 진한 배경에서 서고 연한 배경에 묻힌다. */
export const BRIGHT_GLYPH = rgbaBuffer(128 * 128, [{ rgb: [255, 204, 77], count: 2400 }]);
/** 어두운 하트처럼 짙은 그림: 연한 배경에서 서고 진한 배경에 묻힌다. */
export const DARK_GLYPH = rgbaBuffer(128 * 128, [{ rgb: [30, 30, 34], count: 2400 }]);

export function fakeAvatarPorts(options: FakeAvatarPortsOptions = {}) {
  const log: string[] = [];
  const outputs: { size: number; bytes: Uint8Array }[] = [];
  let samples = 0;
  let pngs = 0;
  const ports: AvatarCanvasPorts<FakeLayer> = {
    createLayer(size) {
      if (options.noCanvas) return null;
      log.push(`create:${size}`);
      return { size, bg: null, foreground: null };
    },
    fillBackground(layer, hex) {
      layer.bg = hex;
      log.push(`fill:${layer.size}:${hex}`);
    },
    async paintForeground(layer, foreground) {
      layer.foreground = foreground;
      log.push(`paint:${layer.size}:${foreground.kind}`);
      return options.paintOk !== false;
    },
    readPixels(layer) {
      log.push(`read:${layer.size}`);
      const glyph = options.glyph === undefined ? BRIGHT_GLYPH : options.glyph;
      const index = samples;
      samples += 1;
      return typeof glyph === "function" ? glyph(index) : glyph;
    },
    async toPng(layer) {
      pngs += 1;
      log.push(`png:${layer.size}`);
      const bytes = buildPng({ width: layer.size, height: layer.size, payload: [pngs & 255, pngs >> 8, 7, 7] });
      outputs.push({ size: layer.size, bytes });
      return bytes;
    },
    release(layer) {
      log.push(`release:${layer.size}`);
    },
  };
  return {
    ports: ports as AvatarCanvasPorts<unknown>,
    log,
    outputs,
    /** 지금까지 구운 512 PNG 의 개수. 저장 직전에 적어 두고, 그 뒤에 구워진 것만 본다. */
    mark: () => outputs.length,
    since: (mark: number) => outputs.slice(mark).filter((entry) => entry.size === 512).map((entry) => entry.bytes),
    samples: () => samples,
  };
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
