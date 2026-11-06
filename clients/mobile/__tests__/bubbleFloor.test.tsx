import 'react-native-url-polyfill/auto';
import {contrast, oklabDistance} from '@momo/core/design/color';
import {catalogEntries, deriveCatalogMode} from '@momo/core/design/deriveCatalog';
import {SIGNAL_PRESETS} from '@momo/core/design/signal';
import {cleanup, render} from '@testing-library/react-native';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import SurfacesHarness from '../measure/surfaces';
import {resolveAppearance} from '../src/design/appearanceState';
import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {darkPalette, lightPalette, type Palette} from '../src/design/tokens';
import {conversationFloor, otherBubbleFill} from '../src/features/conversation/bubble';

// =============================================================================
// #5421 (폰 디자인 검수 6a M1, owner 2026-11-06 「추천대로」) — 밝은 테마에서도 상대 말풍선이 대화 바탕과 갈려 보인다.
//
// 뿌리: `otherBubbleFill` 은 「바닥(`bg`)에서 더 도드라지는 쪽」을 골랐는데, 대화 목록이 **실제로 서는 바닥**은 라이트에서 `surface`(위 25% 에서
// `canvasTop` 이 `surface` 로 건너가고 그 아래는 평평한 `surface`)였다. dawnsky 라이트에서 고른 면이 `surface`(#fffefc)라 말풍선이 바탕과 같은 값이 되었고,
// 인용 Q4 의 「카드 윗칸 머리」는 머리 띠만 위가 둥근 회색 탭처럼 떠 있었다.
//
// 이 파일이 재는 것(전부 **그려진 값** 또는 팔레트 전수 — 문장·이름이 아니다):
//   1. 모든 테마·스킴·신호색·카탈로그 팔레트에서 남 말풍선 면이 **실제 대화 바닥**과 정본 §2.2 두 자(대비 ≥ 1.05 · OKLab ≥ 0.02)를 넘는다.
//   2. 다크·이미지 바닥은 값이 그대로다(옛 규칙과 같은 면을 고른다) — 「어두운 테마 값은 바꾸지 않는다」를 주장이 아니라 숫자로.
//   3. 측정 하네스 `quote-q4` 를 그려 보면 바닥 끝 색이 앱의 대화 바닥과 같고, 일반·인용·내 말풍선과 머리 띠가 두 스킴에서 자를 넘는다.
//   4. 화면(`ConversationScreen`)이 같은 함수에서 바닥을 읽는다 — 식을 다시 적지 않는다.
//
// 못 재는 것: 시뮬레이터·실기기 렌더(`runtime-unverified` — 캡처는 PR 본문), 실제 `ConversationScreen` 을 통째로 그린 바탕(소스 단정으로만).
// =============================================================================

/** 정본 `docs/design-system/README.md` §2.2 「그릇의 생존」 두 자. */
const RULER = {contrast: 1.05, oklab: 0.02};

const passesRuler = (a: string, b: string): boolean =>
  contrast(a, b) >= RULER.contrast && oklabDistance(a, b) >= RULER.oklab;

const fmt = (a: string, b: string): string =>
  `${a}↔${b} 대비 ${contrast(a, b).toFixed(3)} · OKLab ${oklabDistance(a, b).toFixed(3)}`;

type FloorPalette = Pick<Palette, 'mode' | 'backdrop' | 'surface' | 'surfacePressed' | 'bg'>;

/**
 * 모든 테마·모드·신호색 조합(내장) + 카탈로그 팔레트. **카탈로그 행은 손으로 지은 객체라 `mode`·`backdrop` 이 따로 없다** — 빠뜨리면
 * `conversationFloor` 가 조용히 `bg` 로 읽어, 라이트 행을 옛 바닥으로 재면서 초록이 되는 가드가 된다. 그래서 여기서 둘을 채운다.
 */
function allPalettes(): Array<readonly [string, FloorPalette]> {
  const builtin = DS2_COMBOS.flatMap(([theme, mode]) =>
    [null, ...Object.keys(SIGNAL_PRESETS)].map(
      preset =>
        [
          `${theme}/${mode}/${preset ?? 'default'}`,
          resolveAppearance(theme, mode, preset ? ({preset} as never) : null).palette,
        ] as const,
    ),
  );
  const catalog = catalogEntries().flatMap(entry =>
    (['light', 'dark'] as const).flatMap(mode => {
      const derived = deriveCatalogMode(entry.id, mode);
      if (!derived) return [];
      const t = derived.tokens as unknown as {
        color: Record<string, string>;
        derived: Record<string, string>;
        canvas: string[];
      };
      const palette: FloorPalette = {
        mode,
        backdrop: 'canvas',
        surface: t.color.surface as string,
        surfacePressed: t.derived['surface-pressed'] as string,
        bg: t.canvas[1] as string,
      };
      return [[`catalog:${entry.id}/${mode}`, palette] as const];
    }),
  );
  return [...builtin, ...catalog];
}

describe('남 말풍선 면 ↔ 실제 대화 바닥 (#5421)', () => {
  it('모든 팔레트에서 말풍선 면이 대화 바닥과 §2.2 두 자를 넘는다', () => {
    const all = allPalettes();
    const bad: string[] = [];
    let light = 0;
    for (const [name, p] of all) {
      // 바닥은 팔레트에서 읽은 사실이다 — 함수가 아니라 화면 배경의 정의(라이트 = surface, 그 밖 = bg)로 세운다.
      const floor = p.mode === 'light' ? p.surface : p.bg;
      if (p.mode === 'light') light += 1;
      const fill = otherBubbleFill(p);
      if (!passesRuler(fill, floor)) bad.push(`${name} ${fmt(fill, floor)}`);
    }
    expect(bad).toEqual([]);
    // 라이트 행이 충분히 있어야 이 전수가 아무것도 안 재는 초록이 아니다(카탈로그 라이트 행 포함).
    expect(light).toBeGreaterThan(20);
    expect(all.length).toBeGreaterThan(60);
    // 깨뜨리면: `otherBubbleFill` 이 바닥을 `p.bg` 로 읽으면 → dawnsky 라이트 신호색 조합 전부가 대비 1.000 으로 빨강.
  });

  it('dawnsky 라이트 — 면이 surface(바닥과 같은 #fffefc)가 아니라 surfacePressed 로 서고, 숫자는 1.26 · 0.078 이다', () => {
    const fill = otherBubbleFill(lightPalette);
    expect(fill).toBe(lightPalette.surfacePressed);
    expect(fill).not.toBe(lightPalette.surface);
    expect(contrast(fill, conversationFloor(lightPalette))).toBeGreaterThan(1.25);
    expect(oklabDistance(fill, conversationFloor(lightPalette))).toBeGreaterThan(0.07);
  });

  it('다크·이미지 바닥은 값이 그대로다 — 옛 규칙(바닥 = bg)과 같은 면을 고른다', () => {
    const legacy = (p: FloorPalette): string =>
      contrast(p.surface, p.bg) > contrast(p.surfacePressed, p.bg) ? p.surface : p.surfacePressed;
    const same: string[] = [];
    let checked = 0;
    for (const [name, p] of allPalettes()) {
      if (p.mode !== 'dark') continue;
      checked += 1;
      if (otherBubbleFill(p) !== legacy(p)) same.push(name);
    }
    // 사용자 배경 이미지 위에서는 모드와 무관하게 바닥이 bg 한 장이다(`ConversationScreen` 의 `backgroundColor: color.bg`).
    for (const [theme, mode] of DS2_COMBOS) {
      const onImage = resolveAppearance(theme, mode, null, true).palette;
      checked += 1;
      if (onImage.backdrop !== 'image' || otherBubbleFill(onImage) !== legacy(onImage)) {
        same.push(`${theme}/${mode}/image`);
      }
    }
    expect(same).toEqual([]);
    expect(checked).toBeGreaterThan(30);
    // 깨뜨리면: `conversationFloor` 가 다크에서도 `surface` 를 돌려주면 → 다크 팔레트가 옛 선택과 갈려 빨강.
  });

  it('스레드 판(바닥 = bg 한 장)에서도 기본 팔레트의 말풍선은 두 자를 넘는다', () => {
    for (const [name, p] of [
      ['light', lightPalette],
      ['dark', darkPalette],
    ] as const) {
      const fill = otherBubbleFill(p);
      expect(`${name} ${passesRuler(fill, p.bg)} ${fmt(fill, p.bg)}`).toContain(`${name} true`);
    }
  });
});

// -----------------------------------------------------------------------------
// 측정 하네스를 그려 본 값
// -----------------------------------------------------------------------------

interface Node {
  props?: {style?: unknown; testID?: string};
  children?: unknown;
}

function walk(node: unknown, visit: (n: Node) => void): void {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object') return;
  visit(node as Node);
  walk((node as Node).children, visit);
}

const styleOf = (n: Node): Record<string, unknown> =>
  (StyleSheet.flatten(n.props?.style as never) ?? {}) as Record<string, unknown>;

interface Drawn {
  /** 하네스 바닥 그라디언트의 끝 색(위 25% 정지점 — 그 아래는 평평하다). */
  floorEnd: string | null;
  bubbles: Array<{bg: string; head: string | null}>;
}

function drawQuoteQ4(scheme: 'light' | 'dark'): Drawn {
  const view = render(<SurfacesHarness name="quote-q4" scheme={scheme} />);
  const drawn: Drawn = {floorEnd: null, bubbles: []};
  walk(view.toJSON(), node => {
    const image = styleOf(node).experimental_backgroundImage;
    if (typeof image === 'string' && drawn.floorEnd === null) {
      drawn.floorEnd = /(#[0-9a-f]{6}) 25%\)$/i.exec(image)?.[1] ?? null;
    }
    if (node.props?.testID === 'message-bubble') {
      let head: string | null = null;
      walk(node.children, inner => {
        if (inner.props?.testID === 'quote-block' && head === null) {
          head = String(styleOf(inner).backgroundColor);
        }
      });
      drawn.bubbles.push({bg: String(styleOf(node).backgroundColor), head});
    }
  });
  view.unmount();
  return drawn;
}

afterEach(() => cleanup());

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
] as ReadonlyArray<readonly ['light' | 'dark', Palette]>)('측정 하네스 quote-q4 — %s (#5421)', (scheme, palette) => {
  it('바닥 끝 색이 앱의 대화 바닥이다 — 하네스가 color.bg 를 깔지 않는다', () => {
    const {floorEnd} = drawQuoteQ4(scheme);
    // 화면 배경의 정의: 라이트 = surface(종이), 다크 = bg. 함수를 거치지 않은 값으로 세운다.
    expect(floorEnd?.toLowerCase()).toBe((scheme === 'light' ? palette.surface : palette.bg).toLowerCase());
    // 라이트에서 옛 하네스 바닥(`bg`)과 갈려야 이 단정이 옛 사진(바닥만 달라 시안대로 보이던 사진)을 잡는다.
    if (scheme === 'light') expect(floorEnd?.toLowerCase()).not.toBe(palette.bg.toLowerCase());
    // 깨뜨리면: 하네스 `conversationFloor` 스타일이 끝 색을 `color.bg` 로 → 라이트 첫 단정이 빨강.
  });

  it('일반·인용·내 말풍선과 머리 띠가 바닥·말풍선과 §2.2 두 자를 넘는다', () => {
    const {floorEnd, bubbles} = drawQuoteQ4(scheme);
    expect(floorEnd).not.toBeNull();
    // 일반 1 + 인용 남 1 + 인용 내 1 + 지워진 원본 1.
    expect(bubbles).toHaveLength(4);
    expect(bubbles.filter(b => b.head === null)).toHaveLength(1);
    const bad: string[] = [];
    bubbles.forEach((b, i) => {
      if (!passesRuler(b.bg, floorEnd as string)) bad.push(`#${i} 말풍선↔바닥 ${fmt(b.bg, floorEnd as string)}`);
      if (b.head !== null && !passesRuler(b.head, b.bg)) bad.push(`#${i} 머리 띠↔말풍선 ${fmt(b.head, b.bg)}`);
    });
    // 남 말풍선(일반·인용·지워진 원본)은 같은 면이고 내 말풍선은 신호색이다 — 둘이 서로도 갈린다.
    const others = bubbles.filter(b => b.bg.toLowerCase() === otherBubbleFill(palette).toLowerCase());
    expect(others).toHaveLength(3);
    const mine = bubbles.find(b => !others.includes(b));
    expect(mine?.bg.toLowerCase()).toBe(palette.accent.toLowerCase());
    if (mine) {
      if (!passesRuler(mine.bg, others[0]?.bg as string)) bad.push(`내↔남 말풍선 ${fmt(mine.bg, others[0]?.bg as string)}`);
    }
    expect(bad).toEqual([]);
    // 깨뜨리면: `otherBubbleFill` 이 바닥을 `p.bg` 로 읽으면 → 라이트에서 일반 말풍선이 바닥과 같은 #fffefc 라 첫 항목이 빨강.
  });
});

describe('화면이 같은 바닥을 읽는다 (#5421)', () => {
  it('ConversationScreen 의 screen 배경이 conversationFloor 를 읽고, 라이트 분기를 다시 적지 않는다', () => {
    const source = fs.readFileSync(path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'), 'utf8');
    const screenBlock = /screen: \{[\s\S]*?\n {2}\},/.exec(source)?.[0] ?? '';
    expect(screenBlock).toContain('experimental_backgroundImage');
    expect(screenBlock).toContain('conversationFloor(color)');
    expect(screenBlock).not.toMatch(/mode === 'light'/);
    // 깨뜨리면: screen 배경 끝 색을 `color.bg` 나 인라인 `color.mode === 'light' ? …` 로 되돌리면 → 빨강.
  });
});
