import type {Message} from '@momo/core/lib/api';
import {contrast} from '@momo/core/design/color';
import {catalogEntries, deriveCatalogMode} from '@momo/core/design/deriveCatalog';
import {SIGNAL_PRESETS} from '@momo/core/design/signal';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, render, screen} from './fixtures/darkWorld';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';

import {resolveAppearance} from '../src/design/appearanceState';
import {DS2_COMBOS} from '../src/design/ds2Tokens';
import {color, ds2Radius, SAFE_GUTTER} from '../src/design/tokens';
import {bubbleFor, BUBBLE_MIN_CONTRAST, otherBubbleFill} from '../src/features/conversation/bubble';
import {CONV} from '../src/features/conversation/convDesign';
import {LandedTintFade} from '../src/features/conversation/LandedTintFade';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {MessageRow, PendingRow, rowPressedBackground} from '../src/features/conversation/MessageRow';
import {
  blendOver,
  PRESS_FACE_MIN_CONTRAST,
  pressFace,
  ROW_FACE,
} from '../src/features/conversation/rowFace';
import {flat, member} from './testkit';

// =============================================================================
// #4300 — 폰 말풍선(Buzz 식) + 눌림·착지 강조 면.
//
// 각 단정은 일부러 구현을 깨 봐서 빨개지는 것을 확인했다. 결과표는 PR 본문(= progress.md
// 「사보타주」). 각 `it` 끝 「깨뜨리면」이 그 사보타주다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '네네',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

const ACTIONS = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};

function row(over: Partial<React.ComponentProps<typeof MessageRow>> = {}) {
  return (
    <MessageRow
      message={message()}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      actions={ACTIONS}
      {...over}
    />
  );
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
const SRC = (name: string) =>
  fs.readFileSync(path.resolve(__dirname, '../src/features/conversation', name), 'utf8');

afterEach(cleanup);

/** 눌린 상태의 `rowInner` 스타일 — Pressable 의 style 함수를 `pressed: true` 로 부른다. */
function pressedStyle() {
  const pressable = screen.UNSAFE_root.findAll(
    (node: {props?: Record<string, any>}) => node.props?.testID === 'message-press' && typeof node.props.style === 'function',
  )[0];
  const fn = pressable.props.style as (s: {pressed: boolean}) => unknown;
  return flat(fn({pressed: true}));
}

// -----------------------------------------------------------------------------
// 눌림·착지 강조 면
// -----------------------------------------------------------------------------

describe('행 강조 면 — 화면 끝에서 띄운 둥근 면', () => {
  it('바깥 + 안쪽 = 옛 거터, 모서리는 DS2 행 사다리다 — 말풍선 모서리를 읽지 않는다', () => {
    expect(ROW_FACE.outer + ROW_FACE.inner).toBe(SAFE_GUTTER);
    expect(ROW_FACE.radius).toBe(ds2Radius.row);
    // 말풍선 모서리(#4307 에서 owner 가 키울 수 있다)와 **다른 값이고**, 읽는 길도 없다.
    expect(CONV.bubbleRadius).not.toBe(ROW_FACE.radius);
    const code = codeOnly(SRC('rowFace.ts')) + codeOnly(SRC('LandedTintFade.tsx'));
    expect(code).not.toMatch(/bubble/i);
    // 깨뜨리면: ROW_FACE.radius 를 CONV.bubbleRadius 로 → 위 두 단정이 빨개진다.
  });

  it('세 겹(눌림 · 서 있는 착지 · 물러나는 덮개)이 같은 상자·같은 모서리다', () => {
    const view = render(row({landed: true}));
    const bowl = flat(screen.getByTestId('message-row').props.style);
    // 서 있는 착지 = 그릇의 배경. 그릇이 화면 끝에서 outer 떨어진 둥근 상자다.
    expect(bowl.marginHorizontal).toBe(ROW_FACE.outer);
    expect(bowl.borderRadius).toBe(ROW_FACE.radius);
    expect(bowl.backgroundColor).toBe(color.warnSurface);
    // 서 있는 착지의 테두리 — 그릇을 꽉 채우는 절대 배치 + warnBorder 1px + 같은 모서리.
    const edge = flat(screen.getByTestId('message-row-landed-edge').props.style);
    expect(edge).toMatchObject({top: 0, right: 0, bottom: 0, left: 0});
    expect(edge.borderRadius).toBe(bowl.borderRadius);
    expect(edge.borderWidth).toBe(ROW_FACE.edge);
    expect(edge.borderColor).toBe(color.warnBorder);

    // 눌림 = 그릇 안쪽 Pressable 이 같은 상자를 꽉 채운다(마진 없음 = 그릇과 같은 경계).
    const pressed = pressedStyle();
    expect(pressed.borderRadius).toBe(bowl.borderRadius);
    expect(pressed.marginHorizontal).toBeUndefined();
    expect(pressed.paddingHorizontal).toBe(ROW_FACE.inner);
    expect(pressed.backgroundColor).toBe(rowPressedBackground(color));

    // 물러나는 덮개 = 그릇을 네 변 0 으로 꽉 채우는 절대 배치 + 같은 모서리.
    view.rerender(row({landed: false}));
    const fade = flat(screen.getByTestId('message-row-landed-fade').props.style);
    expect(fade).toMatchObject({top: 0, right: 0, bottom: 0, left: 0});
    expect(fade.borderRadius).toBe(bowl.borderRadius);
    expect(fade.backgroundColor).toBe(bowl.backgroundColor);
    // 덮개도 같은 테두리를 든 채 녹는다 — 테두리만 먼저 사라지거나 늦게 남지 않는다.
    expect(fade.borderWidth).toBe(edge.borderWidth);
    expect(fade.borderColor).toBe(edge.borderColor);
    // 서 있는 착지가 끝나면 테두리 덧그림도 함께 빠진다(덮개가 이어받는다).
    expect(screen.queryByTestId('message-row-landed-edge')).toBeNull();
    // 깨뜨리면(각각): 그릇 borderRadius 제거 · rowInner borderRadius 제거 · 덮개 borderRadius 제거
    //                 · 덮개를 다른 값으로 → 해당 줄만 빨개진다.
  });

  it('아바타·이름·본문이 강조 면 가장자리에 닿지 않고, 본문 x 는 옛 자리 그대로다', () => {
    render(row({startsGroup: true}));
    const bowl = flat(screen.getByTestId('message-row').props.style);
    const inner = flat(screen.getByTestId('message-press').props.style);
    // 화면 왼쪽 끝 → 내용: 바깥 마진 + 안쪽 패딩 = 옛 거터 16 + 아바타 40 + 간격 10 = 66.
    expect(Number(bowl.marginHorizontal) + Number(inner.paddingLeft)).toBe(
      SAFE_GUTTER + CONV.avatar + CONV.avatarGap,
    );
    // 면 가장자리 → 내용 시작 ≥ 안쪽 여백 10(아바타는 절대 배치 left 가 같은 값).
    expect(Number(inner.paddingLeft) - CONV.avatar - CONV.avatarGap).toBe(ROW_FACE.inner);
    expect(inner.paddingHorizontal).toBe(ROW_FACE.inner);
    // 아바타 칸은 면 안쪽 여백만큼 안에서 시작한다(옛 SAFE_GUTTER 가 아니다 — 그릇이 6 안쪽).
    const slot = flat(screen.getByTestId('message-avatar-slot').props.style);
    expect(slot.left).toBe(ROW_FACE.inner);
    // 깨뜨리면: rowAvatar.left 를 SAFE_GUTTER 로 되돌리면 아바타가 6 어긋난다.
  });

  it('PendingRow(낙관적 메아리)도 같은 그릇·같은 안쪽 여백을 진다', () => {
    render(
      <PendingRow
        pending={{
          clientMsgId: 'c-1',
          channelId: 'ch',
          authorMemberId: SELF,
          body: '보내는 중',
          status: 'sending',
        } as never}
        startsGroup
        directory={DIRECTORY}
      />,
    );
    const bowl = flat(screen.getByTestId('pending-row').props.style);
    expect(bowl.marginHorizontal).toBe(ROW_FACE.outer);
  });
});

describe('눌림 틴트 — 강조색 10%, 안 보이는 테마만 surface', () => {
  it('기본 팔레트에서는 강조색 10% 알파 틴트다', () => {
    expect(rowPressedBackground(color)).toBe(color.accent + '1a');
    // 깨뜨리면: pressFace 가 항상 surface 를 돌려주게 → 빨강.
  });

  it('틴트 합성면이 바닥에서 안 갈리면(바닥 한계 미만) surface 로 물러난다', () => {
    // accent 가 바닥과 거의 같은 가상 팔레트 — 틴트는 눈에 안 보인다.
    const face = pressFace({accent: '#101010', bg: '#111111', surface: '#222222'});
    expect(face).toEqual({color: '#222222', fellBack: true});
    // 깨뜨리면: 문턱 비교를 항상 참으로 → 이 줄 빨강.
  });

  const COMBOS = [
    ...DS2_COMBOS.flatMap(([theme, mode]) =>
      [null, ...Object.keys(SIGNAL_PRESETS)].map(preset => {
        const p = resolveAppearance(theme, mode, preset ? {preset} as never : null).palette;
        return [`${theme}/${mode}/${preset ?? 'default'}`, p] as const;
      }),
    ),
    ...catalogEntries().flatMap(e =>
      (['light', 'dark'] as const).flatMap(mode => {
        const d = deriveCatalogMode(e.id, mode);
        if (!d) return [];
        const t = d.tokens as unknown as {
          color: Record<string, string>;
          derived: Record<string, string>;
          canvas: string[];
        };
        return [
          [
            `catalog:${e.id}/${mode}`,
            {
              accent: t.color.signal,
              onAccent: t.color['on-signal'],
              surface: t.color.surface,
              surfacePressed: t.derived['surface-pressed'],
              text: t.color.ink,
              bg: t.canvas[1],
              warnSurface: t.color['warn-soft'],
            },
          ] as const,
        ];
      }),
    ),
  ];

  const LANDED_FACE_MIN_CONTRAST = 1.1;
  /** 면(warnSurface)만으로는 바닥과 안 갈리는 테마 — 내장 3테마 라이트. 테두리가 경계를 세운다. */
  const FACE_ALONE_WEAK = new Set([
    'dawnsky/light/default',
    'graphite/light/default',
    'noeul/light/default',
    ...Object.keys(SIGNAL_PRESETS).flatMap(id => [
      `dawnsky/light/${id}`,
      `graphite/light/${id}`,
      `noeul/light/${id}`,
    ]),
  ]);
  /** 테두리(warnBorder 1px)가 바닥에서 이만큼은 갈려야 면이 약한 테마에서도 경계가 선다. */
  const LANDED_EDGE_MIN_CONTRAST = 1.2;

  it('조합 수가 많다 — 내장 3 테마 × 2 모드 × (기본 + 프리셋) + 카탈로그 전체', () => {
    expect(COMBOS.length).toBeGreaterThan(60);
  });

  it('모든 조합에서 눌림 면이 바닥에서 보이고, 내 말풍선 뒤에서도 착지 면이 갈린다', () => {
    const fellBack: string[] = [];
    for (const [name, p] of COMBOS) {
      const face = pressFace(p);
      if (face.fellBack) {
        fellBack.push(name);
        // 물러난 테마는 surface 가 최소한 바닥과 갈려야 한다(1.0 이면 눌림이 안 보인다).
        expect(`${name} ${contrast(p.surface, p.bg) > 1.0}`).toBe(`${name} true`);
      } else {
        const seen = blendOver(p.accent, p.bg, 0.1);
        expect(`${name} ${contrast(seen, p.bg) >= PRESS_FACE_MIN_CONTRAST}`).toBe(`${name} true`);
      }
      // 착지 면: 바닥과 갈리고(경계가 보인다), 내 말풍선(강조색)과도 갈린다.
      const warn = (p as {warnSurface?: string}).warnSurface;
      if (warn !== undefined) {
        // 착지 면은 내 말풍선(강조색)과 갈린다.
        expect(`${name} ${contrast(p.accent, warn) >= 3}`).toBe(`${name} true`);
        // 착지 면이 바닥에서 보이는가. 내장 3 테마의 라이트는 `warnSurface` 만으로는 바닥과
        // 1.02~1.04:1 이라 경계가 안 선다 — planner 결정(2026-10-25): `warnBorder` 1px 헤어라인을
        // 더한다. 면이 약한 조합의 목록은 고정하고(목록 밖에서 약해지면 빨강), 그 조합마다
        // 테두리가 바닥에서 갈리는지를 잰다. 약점은 더 이상 「알려진 약점」이 아니다.
        const weak = contrast(warn, p.bg) < LANDED_FACE_MIN_CONTRAST;
        expect(`${name} weak=${weak}`).toBe(`${name} weak=${FACE_ALONE_WEAK.has(name)}`);
        const edge = (p as {warnBorder?: string}).warnBorder;
        if (weak) {
          expect(edge).toBeDefined();
          const c = contrast(edge as string, p.bg);
          expect(`${name} edge=${c >= LANDED_EDGE_MIN_CONTRAST}`).toBe(`${name} edge=true`);
        }
      }
    }
    // 눈으로 볼 수 있게 이름을 남긴다 — 물러난 테마가 늘면 이 목록이 증거다.
    expect(fellBack.length).toBeLessThan(COMBOS.length / 4);
  });
});

// -----------------------------------------------------------------------------
// 말풍선
// -----------------------------------------------------------------------------

describe('말풍선 — 토큰으로만 그린다', () => {
  it('내 글은 강조색 말풍선 + onAccent 글자다', () => {
    render(row({message: message({authorMemberId: SELF, body: '내가 쓴 글'})}));
    const mine = flat(screen.getByTestId('message-bubble').props.style);
    expect(mine.backgroundColor).toBe(color.accent);
    expect(flat(screen.getByText('내가 쓴 글').props.style).color).toBe(color.onAccent);
  });

  it('남 글(사람·에이전트)은 표면 말풍선 + 본문 글자다', () => {
    render(row({message: message({authorMemberId: OTHER, body: '남이 쓴 글'})}));
    const other = flat(screen.getByTestId('message-bubble').props.style);
    expect(other.backgroundColor).toBe(otherBubbleFill(color));
    expect(flat(screen.getByText('남이 쓴 글').props.style).color).toBe(color.text);
    // 깨뜨리면: 내 글/남 글 판정을 뒤집으면 두 시험 모두 빨강(색 뒤바뀜 사보타주).
  });

  it('왼쪽 정렬·내용 폭 — 짧은 글은 좁고, 내 글도 오른쪽으로 보내지 않는다', () => {
    render(row({message: message({authorMemberId: SELF, body: '네네'})}));
    const style = flat(screen.getByTestId('message-bubble').props.style);
    expect(style.alignSelf).toBe('flex-start');
    expect(style.maxWidth).toBe('100%');
    expect(style.marginLeft).toBeUndefined();
    expect(style.borderRadius).toBe(CONV.bubbleRadius);
    expect(style.paddingHorizontal).toBe(CONV.bubblePadX);
    expect(style.paddingVertical).toBe(CONV.bubblePadY);
    // 깨뜨리면: alignSelf 를 'stretch'/'flex-end' 로 → 빨강.
  });

  it('말풍선 모서리는 행 강조 면 모서리와 따로다', () => {
    render(row());
    expect(flat(screen.getByTestId('message-bubble').props.style).borderRadius).toBe(
      CONV.bubbleRadius,
    );
    expect(flat(screen.getByTestId('message-row').props.style).borderRadius).toBe(ROW_FACE.radius);
  });

  it('코드 블록은 말풍선에 가두지 않는다 — 앞뒤 산문만 각자 말풍선에 든다', () => {
    render(
      <MessageBody
        bubble="other"
        body={'먼저 이걸 돌려 보세요.\n\n```sh\necho hi\n```\n\n그다음 알려 주세요.'}
      />,
    );
    const bubbles = screen.getAllByTestId('message-bubble');
    expect(bubbles).toHaveLength(2);
    const code = screen.getByTestId('message-code-block');
    for (const bubble of bubbles) {
      expect(bubble.findAll((n: unknown) => n === code)).toHaveLength(0);
    }
    // 코드 상자가 말풍선의 padding 을 물지 않는다: 부모 중에 말풍선이 없다.
    let node = code as unknown as {parent: unknown; props?: {testID?: string}} | null;
    while (node) {
      expect(node.props?.testID).not.toBe('message-bubble');
      node = node.parent as typeof node;
    }
    // 깨뜨리면: 'code' 갈래를 run 에 넣으면(전부 한 말풍선) 위 단정이 빨강.
  });

  it('말풍선 안 링크·인라인 코드는 말풍선 잉크로 읽힌다(내 글: 신호색 채움 위)', () => {
    render(
      <MessageBody
        bubble="mine"
        body={'`npm test` 와 [문서](https://example.com) 를 봐 주세요'}
      />,
    );
    expect(flat(screen.getByTestId('message-link').props.style).color).toBe(color.onAccent);
    const code = flat(screen.getByTestId('message-inline-code').props.style);
    expect(code.backgroundColor).toBe(color.onAccent + '2e');
  });

  it('말풍선 밖(bubble 없음)은 예전 그대로다 — 말풍선이 생기지 않는다', () => {
    render(<MessageBody body={'평문 하나'} />);
    expect(screen.queryByTestId('message-bubble')).toBeNull();
  });

  it('카드·첨부는 말풍선 밖이다 — 말풍선은 본문(MessageBody)만 감싼다', () => {
    const code = codeOnly(SRC('MessageRow.tsx'));
    // 말풍선 prop 은 MessageBody 에만 걸리고 AgentCard·ArtifactCard·AttachmentList 에는 없다.
    const uses = code.match(/bubble=/g) ?? [];
    expect(uses).toHaveLength(2); // 확정 행 + 낙관적 메아리
    expect(code).not.toMatch(/<(AgentCard|ArtifactCard|AttachmentList)[^>]*bubble/);
  });

  it('낙관적 메아리는 내 말풍선이다(서버 사본이 대체해도 모양이 안 바뀐다 — 흐리지 않는다, #4455)', () => {
    render(
      <PendingRow
        pending={{
          clientMsgId: 'c-1',
          channelId: 'ch',
          authorMemberId: SELF,
          body: '보내는 중',
          status: 'sending',
        } as never}
        startsGroup
        directory={DIRECTORY}
      />,
    );
    const style = flat(screen.getByTestId('message-bubble').props.style);
    expect(style.backgroundColor).toBe(color.accent);
    // 정상 전송의 메아리는 서버 사본과 같은 불투명도다 — 0.6 에서 1.0 으로 튀면 그것이 곧 색 깜빡임이다.
    expect(style.opacity).toBeUndefined();
  });

  it('실패한 메아리만 흐리다 (실패 줄은 예전 그대로)', () => {
    render(
      <PendingRow
        pending={{
          clientMsgId: 'c-1',
          channelId: 'ch',
          authorMemberId: SELF,
          body: '못 보낸 글',
          status: 'failed',
        } as never}
        startsGroup
        directory={DIRECTORY}
      />,
    );
    const style = flat(screen.getByTestId('message-bubble').props.style);
    expect(style.backgroundColor).toBe(color.accent);
    expect(style.opacity).toBe(0.6);
  });
});

describe('말풍선 토큰 — 덮어쓰기와 대비', () => {
  it('layout·radius 덮어쓰기를 받고, 범위를 벗어나면 기본으로 돌아간다', () => {
    expect(bubbleFor(color, {layout: 'row'}).layout).toBe('row');
    expect(bubbleFor(color).layout).toBe('bubble');
    expect(bubbleFor(color, {radius: 24}).radius).toBe(24);
    expect(bubbleFor(color, {radius: 99}).radius).toBe(CONV.bubbleRadius);
    // 깨뜨리면: layout 갈래를 'bubble' 고정으로 → 첫 줄 빨강.
  });

  it('대비를 못 지키는 덮어쓰기는 통째로 버린다(반쪽만 먹이지 않는다)', () => {
    const t = bubbleFor(color, {mine: {bg: '#ffffff', fg: '#fefefe'}});
    expect(t.mine).toEqual({bg: color.accent, fg: color.onAccent});
    const ok = bubbleFor(color, {mine: {bg: '#000000', fg: '#ffffff'}});
    expect(ok.mine).toEqual({bg: '#000000', fg: '#ffffff'});
    // 깨뜨리면: 대비 검사를 지우면 첫 줄 빨강.
  });

  it('모든 조합에서 두 말풍선의 글자 대비가 4.5:1 이상이다', () => {
    const bad: string[] = [];
    const all = [
      ...DS2_COMBOS.flatMap(([theme, mode]) =>
        [null, ...Object.keys(SIGNAL_PRESETS)].map(preset => [
          `${theme}/${mode}/${preset ?? 'default'}`,
          resolveAppearance(theme, mode, preset ? ({preset} as never) : null).palette,
        ] as const),
      ),
      ...catalogEntries().flatMap(e =>
        (['light', 'dark'] as const).flatMap(mode => {
          const d = deriveCatalogMode(e.id, mode);
          if (!d) return [];
          const t = d.tokens as unknown as {
            color: Record<string, string>;
            derived: Record<string, string>;
            canvas: string[];
          };
          return [
            [
              `catalog:${e.id}/${mode}`,
              {
                accent: t.color.signal,
                onAccent: t.color['on-signal'],
                surface: t.color.surface,
                surfacePressed: t.derived['surface-pressed'],
                text: t.color.ink,
                bg: t.canvas[1],
              },
            ] as const,
          ];
        }),
      ),
    ];
    for (const [name, p] of all) {
      const b = bubbleFor(p as never);
      if (contrast(b.mine.fg, b.mine.bg) < BUBBLE_MIN_CONTRAST) bad.push(`${name} mine`);
      if (contrast(b.other.fg, b.other.bg) < BUBBLE_MIN_CONTRAST) bad.push(`${name} other`);
    }
    expect(bad).toEqual([]);
    expect(all.length).toBeGreaterThan(60);
    // 깨뜨리면: 내 말풍선 글자를 text 로(onAccent 대신) → 다수 조합이 빨강.
  });
});

// 덮개 단독 렌더 — 모서리가 컴포넌트 자체의 것임을 한 번 더(행 밖에서도).
describe('LandedTintFade 단독', () => {
  it('덮개 자체가 둥근 모서리를 든다', () => {
    const view = render(<LandedTintFade landed />);
    view.rerender(<LandedTintFade landed={false} />);
    act(() => {});
    const fade = screen.queryByTestId('message-row-landed-fade');
    if (fade) expect(flat(fade.props.style).borderRadius).toBe(ROW_FACE.radius);
  });
});
