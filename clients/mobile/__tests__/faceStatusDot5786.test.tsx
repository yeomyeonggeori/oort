import {blend} from '@momo/core/design/scrim';
import {statusBadgeGeometry} from '@momo/core/features/presence/statusBadge';
import type {StatusDotTone} from '@momo/core/features/presence/statusDot';
import type {Member} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {cleanup, render, screen} from './fixtures/darkWorld';
import {darkPalette, lightPalette} from '../src/design/tokens';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {CONV} from '../src/features/conversation/convDesign';
import {FaceStatusDot} from '../src/features/presence/StatusDot';
import {homeRowGround} from '../src/screens/SidebarScreen';

// =============================================================================
// 폰 얼굴 점 (#5786 수리 1회차, design-review r1 M3·M4·H2).
//
//   M4  사보타주가 초록이던 셋을 잡는다: 대화 머리가 넘기는 얼굴 크기(P1), 초승달의 덜어 내는 원의 기하(P2), 꺼짐 고리의
//       두께(P3 — 0 이면 점이 바탕색으로 사라진다).
//   M3  고리(틈)와 모양의 빈 곳은 얼굴이 서는 **바탕 색**이다. 홈 줄은 면이 아니라 바닥 위라 면색 고리가 흰 테로 보였다.
//   H2  에이전트 경고는 채운 원이다 — 사람의 자리 비움(초승달)과 같은 그림이 아니다.
// =============================================================================

afterEach(cleanup);

const flat = (style: unknown) => StyleSheet.flatten(style as never) as Record<string, unknown>;
const HIDDEN = {includeHiddenElements: true} as const;

/** 점 하나를 그려 네 자리(표식·틈·초승달·가로 줄)의 스타일을 읽고 내린다. */
function dot(props: {face?: number; tone: StatusDotTone; subject?: 'human' | 'agent'; ground?: string}) {
  const view = render(
    <View style={{width: props.face ?? 28, height: props.face ?? 28}}>
      <FaceStatusDot face={props.face ?? 28} tone={props.tone} subject={props.subject} ground={props.ground} testID="d" />
    </View>,
  );
  const q = (id: string) => {
    const node = view.queryByTestId(id, HIDDEN);
    return node === null ? null : flat(node.props.style);
  };
  const out = {mark: q('d')!, gap: q('d-gap')!, moon: q('d-moon'), bar: q('d-bar')};
  view.unmount();
  return out;
}

describe('얼굴 점의 기하 (r1 M4 P2·P3)', () => {
  it('초승달: 덜어 내는 원은 점의 왼쪽 위 — 중심 25%·25%, 반지름 37.5%(웹 마스크와 같은 기하)', () => {
    for (const face of [28, 32]) {
      const {dot: d} = statusBadgeGeometry(face);
      const {moon} = dot({face, tone: 'warn'});
      expect(moon).toMatchObject({left: -d / 8, top: -d / 8, width: (d * 3) / 4, height: (d * 3) / 4});
    }
  });

  it('꺼짐: 속 빈 고리의 두께 = 틈(0 이면 점이 바탕색으로 사라진다), 선은 textFaint', () => {
    const {gap} = statusBadgeGeometry(28);
    const {mark} = dot({tone: 'muted'});
    expect(gap).toBeGreaterThan(0);
    expect(mark.borderWidth).toBe(gap);
    expect(darkPalette.textFaint).toBe(mark.borderColor);
  });

  it('채운 점은 고리가 없다(두께 0)', () => {
    expect(dot({tone: 'ok'}).mark.borderWidth).toBe(0);
  });
});

describe('고리·빈 곳 = 얼굴이 서는 바탕 (r1 M3)', () => {
  const GROUND = darkPalette.bg;

  it('넘긴 바탕이 틈 고리·초승달·가로 줄·꺼짐 고리 속을 모두 칠한다', () => {
    expect(dot({tone: 'ok', ground: GROUND}).gap.backgroundColor).toBe(GROUND);
    expect(dot({tone: 'warn', ground: GROUND}).moon!.backgroundColor).toBe(GROUND);
    expect(dot({tone: 'danger', ground: GROUND}).bar!.backgroundColor).toBe(GROUND);
    expect(dot({tone: 'muted', ground: GROUND}).mark.backgroundColor).toBe(GROUND);
  });

  it('바탕을 넘기지 않으면 면(surface) — 대화 머리 알약·새 메시지 카드', () => {
    expect(dot({tone: 'ok'}).gap.backgroundColor).toBe(darkPalette.surface);
  });

  it('홈 줄의 바탕: 쉬는 줄 = 바닥(bg), 눌린 줄 = 눌림 면, 고른 줄 = 바닥 위 유리(불투명으로 합성)', () => {
    for (const palette of [lightPalette, darkPalette]) {
      expect(homeRowGround(palette, false, false)).toBe(palette.bg);
      expect(homeRowGround(palette, false, true)).toBe(palette.surfacePressed);
      expect(homeRowGround(palette, true, true)).toBe(palette.surfacePressed);
      const selected = homeRowGround(palette, true, false);
      expect(selected).toMatch(/^#[0-9a-f]{6}$/i);
      const alpha = parseInt(palette.glass.slice(7, 9), 16) / 255;
      expect(selected).toBe(blend(palette.glass.slice(0, 7), palette.bg, alpha));
    }
    // 밝게의 바닥은 면이 아니다 — 그래서 면색 고리가 흰 테였다.
    expect(lightPalette.bg).not.toBe(lightPalette.surface);
  });
});

describe('모양은 뜻 — 에이전트 경고는 채운 원 (r1 H2)', () => {
  it('사람 자리 비움 = 초승달, 에이전트 경고 = 채운 주황(초승달·가로 줄 없음)', () => {
    const human = dot({tone: 'warn', subject: 'human'});
    expect(human.moon).not.toBeNull();
    const agent = dot({tone: 'warn', subject: 'agent'});
    expect(agent.moon).toBeNull();
    expect(agent.bar).toBeNull();
    expect(agent.mark.backgroundColor).toBe(darkPalette.warn);
  });
});

describe('대화 머리 (r1 M4 P1·H2)', () => {
  const HUMAN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
  const AGENT = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
  const member = (over: Partial<Member>): never =>
    ({id: HUMAN, workspaceId: 'ws', kind: 'human', handle: 'dohyun', displayName: '이도현', role: 'member', ...over}) as never;
  const DIRECTORY = makeDirectory([
    member({}),
    member({id: AGENT, kind: 'agent', handle: 'intern-kim', displayName: '김인턴'}),
  ]);
  const header = (peerId: string, tone: StatusDotTone) =>
    render(
      <ConversationHeader
        title="이도현"
        kind="dm"
        peerId={peerId}
        peerStatusTone={tone}
        peerStatusLabel="자리 비움"
        directory={DIRECTORY}
        onBack={() => {}}
        onOpenMenu={() => {}}
        railStatus="connected"
      />,
    );

  it('얼굴 점의 크기는 머리 얼굴(CONV.titleFace)에서 정해진다', () => {
    header(HUMAN, 'ok');
    const {dot: d, gap} = statusBadgeGeometry(CONV.titleFace);
    const face = flat(screen.getByTestId('conversation-title-face').props.style);
    expect(face).toMatchObject({width: CONV.titleFace, height: CONV.titleFace});
    expect(flat(screen.getByTestId('conversation-title-status-dot', HIDDEN).props.style)).toMatchObject({width: d, height: d});
    expect(flat(screen.getByTestId('conversation-title-status-dot-gap', HIDDEN).props.style)).toMatchObject({
      width: d + 2 * gap,
      right: -gap,
      bottom: -gap,
    });
  });

  it('사람 상대의 자리 비움은 초승달, 에이전트 상대의 경고는 채운 원', () => {
    const human = header(HUMAN, 'warn');
    expect(human.queryByTestId('conversation-title-status-dot-moon', HIDDEN)).not.toBeNull();
    human.unmount();
    const agent = header(AGENT, 'warn');
    expect(agent.queryByTestId('conversation-title-status-dot', HIDDEN)).not.toBeNull();
    expect(agent.queryByTestId('conversation-title-status-dot-moon', HIDDEN)).toBeNull();
  });
});
