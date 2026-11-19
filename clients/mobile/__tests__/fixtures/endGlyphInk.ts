import {readFileSync} from 'fs';
import path from 'path';
import {inflateSync} from 'zlib';

import {screen} from '@testing-library/react-native';
import {Image, StyleSheet, type ImageSourcePropType} from 'react-native';

// =============================================================================
// 줄 끝 열의 잉크를 **그림 파일에서** 잰다 (#5791).
//
// 줄 끝 글리프(셰브론·펼침·복사·✓·종·빗금 종)는 칸 안의 잉크 여백이 그림마다 다르다. 부품은 그 여백을 표로 들고 보정하는데, 표를
// 같은 숫자로 다시 적는 시험은 아이콘을 다시 구우면 못 잡는다(#5776 검수 M3). 그래서 여기서는 렌더된 `Image` 의 `source` 가 가리키는
// **실제 PNG**(@2x·@3x)를 디스크에서 읽어 알파 경계를 재고, 렌더된 여백·이동과 더해 잉크가 줄의 어디에 서는지 계산한다.
//
// - PNG 는 node 내장 `zlib` 로 직접 푼다(새 의존 없음). 8비트 RGBA·인터레이스 없음만 받고, 그 밖이면 던진다 — 다른 형식으로 다시
//   구운 그림을 조용히 잘못 읽지 않는다.
// - 잉크 = 알파 ≥ 50%(`INK_ALPHA`). 반 넘게 덮인 화소가 도형 안이다. 시뮬레이터 캡처 측정(`cap5791/tools/measure.py`)도 같은
//   문턱(바탕→아이콘 색 대비의 50%)을 쓴다.
// - jest 의 그림 변환기(`@react-native/jest-preset` `assetFileTransformer`)는 `require('x.png')` 를 `{testUri}` 로 바꾼다 — 경로는
//   `react-native/jest/` 에서 본 상대 경로다. 그래서 시험이 파일 이름을 손으로 적지 않고 부품이 실제로 그린 그림을 따라간다.
// =============================================================================

export type AssetScale = 2 | 3;

type Node = ReturnType<typeof screen.getByTestId>;

/** 잉크 문턱(알파 0~255). */
export const INK_ALPHA = 128;

/** 그림 칸 가장자리에서 잉크까지의 거리(화소). */
export type InkGaps = {left: number; right: number; top: number; bottom: number};

const PNG_SIGNATURE = '89504e470d0a1a0a';

/** 8비트 RGBA PNG 의 가로·세로·알파 평면. */
export function readPngAlpha(file: string): {width: number; height: number; alpha: Uint8Array} {
  const buf = readFileSync(file);
  if (buf.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error(`${file}: PNG 서명이 아니다`);
  }
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  for (let at = 8; at + 8 <= buf.length; ) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const data = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const depth = data[8];
      const colour = data[9];
      const interlace = data[12];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(
          `${file}: 8비트 RGBA·인터레이스 없음만 읽는다(깊이 ${depth}·색 유형 ${colour}·인터레이스 ${interlace})`,
        );
      }
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    at += 12 + length;
  }
  if (width === 0 || height === 0 || idat.length === 0) throw new Error(`${file}: IHDR·IDAT 가 없다`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4;
  const stride = width * bpp;
  if (raw.length !== height * (stride + 1)) throw new Error(`${file}: 풀린 길이가 맞지 않는다`);
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const lineAt = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const left = x >= bpp ? out[y * stride + x - bpp] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const upLeft = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      let value = raw[lineAt + x];
      switch (filter) {
        case 0:
          break;
        case 1:
          value += left;
          break;
        case 2:
          value += up;
          break;
        case 3:
          value += Math.floor((left + up) / 2);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
          break;
        }
        default:
          throw new Error(`${file}: 모르는 줄 필터 ${filter}`);
      }
      out[y * stride + x] = value % 256;
    }
  }
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) alpha[i] = out[i * bpp + 3];
  return {width, height, alpha};
}

/** 그림의 크기와 잉크 여백(화소). 잉크가 하나도 없으면 던진다. */
export function inkGaps(file: string): InkGaps & {width: number; height: number} {
  const {width, height, alpha} = readPngAlpha(file);
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] >= INK_ALPHA) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0) throw new Error(`${file}: 잉크가 없다`);
  return {width, height, left: minX, right: width - 1 - maxX, top: minY, bottom: height - 1 - maxY};
}

const RN_JEST_DIR = path.resolve(require.resolve('react-native/package.json'), '../jest/');

/** 부품이 그린 `source`(jest 에서는 `{testUri}`)가 가리키는 그 배율의 PNG 경로. */
export function assetFile(source: ImageSourcePropType, scale: AssetScale): string {
  const uri = (source as {testUri?: unknown}).testUri;
  if (typeof uri !== 'string' || !uri.endsWith('.png')) {
    throw new Error(`그림 출처가 PNG 가 아니다: ${JSON.stringify(source)}`);
  }
  return path.resolve(RN_JEST_DIR, uri).replace(/\.png$/, `@${scale}x.png`);
}

type StyleLike = {
  width?: unknown;
  height?: unknown;
  marginRight?: unknown;
  transform?: ReadonlyArray<Record<string, unknown>>;
};

const flat = (node: Node): StyleLike =>
  (StyleSheet.flatten(node.props.style) ?? {}) as StyleLike;

const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/**
 * 줄의 **마지막** 그림(줄 끝 글리프)이 선 자리(화소).
 *
 * - `insetPx`: 잉크 오른쪽 끝이 줄의 안쪽 여백 끝에서 안쪽으로 떨어진 거리. 그림과 그 조상(줄 자신은 빼고)의 `marginRight` 합에 그림의
 *   오른쪽 잉크 여백을 더한다. 줄 끝 요소는 오른쪽 여백 끝에 붙어 서므로(`flexDirection: 'row'` 의 마지막 자식) 이것이 잉크 자리다.
 * - `centerPx`: 잉크 세로 가운데가 그림 칸 가운데에서 아래로 떨어진 거리. 칸은 줄 가운데에 선다(`alignItems: 'center'`).
 * - 180° 돈 그림(펼친 ⌃)은 왼쪽·오른쪽, 위·아래 여백이 바뀐다.
 *
 * 그림이 칸보다 크거나 작게 그려지면(배율 맞춤이 아니면) 잉크 자리를 알 수 없으므로 던진다.
 */
export function endGlyphInk(
  row: Node,
  scale: AssetScale,
): {file: string; insetPx: number; centerPx: number} {
  const images = row.findAll((node: Node) => node.type === Image, {deep: true});
  const glyph = images[images.length - 1];
  if (!glyph) throw new Error(`줄(${String(row.props.testID)})에 끝 글리프가 없다`);
  const file = assetFile(glyph.props.source as ImageSourcePropType, scale);
  const gaps = inkGaps(file);
  const style = flat(glyph);
  if (num(style.width) * scale !== gaps.width || num(style.height) * scale !== gaps.height) {
    throw new Error(
      `${path.basename(file)}: ${gaps.width}x${gaps.height} 그림이 ${String(style.width)}x${String(style.height)}pt 칸에 1:1 로 서지 않는다`,
    );
  }
  const transform = style.transform ?? [];
  const flipped = transform.some(step => step.rotate === '180deg');
  const translateY = transform.reduce((sum, step) => sum + num(step.translateY), 0);
  let margin = num(style.marginRight);
  for (let node = glyph.parent; node && node !== row; node = node.parent) {
    // 호스트 요소만 센다 — 감싼 컴포넌트와 호스트가 같은 `style` 을 함께 들고 있어 두 번 세지 않게.
    if (typeof node.type === 'string') margin += num(flat(node).marginRight);
  }
  const right = flipped ? gaps.left : gaps.right;
  const top = flipped ? gaps.bottom : gaps.top;
  const bottom = flipped ? gaps.top : gaps.bottom;
  return {
    file: path.basename(file),
    insetPx: Math.round((margin * scale + right) * 1000) / 1000,
    centerPx: Math.round((translateY * scale + (top - bottom) / 2) * 1000) / 1000,
  };
}
