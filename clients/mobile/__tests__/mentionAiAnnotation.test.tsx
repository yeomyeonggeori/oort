import {CLAUDE_SUBSCRIPTION_AGENT_PAUSED} from '@momo/core/features/ai/aiHubModel';
import {composerAgentNotice, mentionAnnotation} from '@momo/core/features/ai/aiMention';
import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {Dimensions, StyleSheet} from 'react-native';

import {
  Composer,
  composerColumnBudget,
  mentionAnnotationLines,
  mentionRowHeight,
  mentionSheetMaxHeight,
} from '../src/features/conversation/Composer';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// AIH-9b (#3440) — 폰 멘션 시트의 AI 보조 줄·칩·잠금과 입력창 위 한 줄.
//
// 문장은 전부 코어(`mentionAnnotation` · `composerAgentNotice`)가 만든다. 이 파일은 그
// 문장을 **기대값으로 베껴 적지 않고** 같은 코어 함수에서 읽어 비교한다 — 폰에 새 문장이
// 생겼다면 코어 값과 달라져 여기서 빨개진다. 그리고 한 번은 문자열 그대로도 못 박아
// (`코어 문장이 바뀌면 이 파일도 일부러 고친다`) 코어가 비어 가는 경우를 막는다.
// =============================================================================

const VIEWER = 'viewer-human';
const OWNER = 'owner-human';

function member(over: Partial<RosterMember> & {handle: string}): RosterMember {
  return {
    id: `id-${over.handle}`,
    workspaceId: 'ws',
    kind: 'agent',
    status: 'active',
    displayName: over.displayName ?? over.handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as unknown as RosterMember;
}

const human = member({handle: 'seongjae', kind: 'human', displayName: '곽성재'});
const teamKey = member({
  handle: 'intern',
  displayName: '김인턴',
  brain: 'team_key',
  callableBy: 'everyone',
});
const mineSub = member({
  handle: 'mine',
  displayName: '내 Claude',
  brain: 'subscription',
  callableBy: 'owner_only',
  ownerHumanId: VIEWER,
  owner: {id: VIEWER, displayName: '하늘'},
  hostOnline: true,
});
const otherSub = member({
  handle: 'sj',
  displayName: '성재의 Claude Code',
  brain: 'subscription',
  callableBy: 'owner_only',
  ownerHumanId: OWNER,
  owner: {id: OWNER, displayName: '성재'},
  hostOnline: false,
});
const otherKey = member({
  handle: 'sjkey',
  displayName: '성재 키',
  brain: 'personal_key',
  callableBy: 'owner_only',
  ownerHumanId: OWNER,
  owner: {id: OWNER, displayName: '성재'},
});
const pausedMine = member({
  handle: 'pm',
  displayName: '문의 중 Claude',
  brain: 'subscription',
  callableBy: 'owner_only',
  ownerHumanId: VIEWER,
  hostOnline: true,
  brainUnavailableReason: CLAUDE_SUBSCRIPTION_AGENT_PAUSED,
});
const oldServerAgent = member({handle: 'old', displayName: '옛 에이전트'});

const BASE_WINDOW = Dimensions.get('window');
function setWindow(next: {fontScale?: number; height?: number}) {
  const window = {...BASE_WINDOW, ...next};
  Dimensions.set({window, screen: window});
}

const store = new Map<string, string>();
beforeEach(() => {
  setWindow({fontScale: 1, height: 874});
  store.clear();
  __setNonSecretStore({
    getString: (k: string) => store.get(k),
    set: (k: string, v: string) => void store.set(k, String(v)),
    remove: (k: string) => store.delete(k),
  } as never);
});
afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
  Dimensions.set({window: BASE_WINDOW, screen: BASE_WINDOW});
});

function composer(members: RosterMember[], props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  return render(
    <Composer
      recipient="place"
      channelLabel="배포"
      directory={makeDirectory(members)}
      viewerHumanId={VIEWER}
      onSend={() => {}}
      {...props}
    />,
  );
}

const flat = (node: {props: {style?: unknown}}) => StyleSheet.flatten(node.props.style as never) as Record<string, unknown>;

function openSheet(text = '@') {
  fireEvent.changeText(screen.getByTestId('composer-input'), text);
}

describe('멘션 시트 — 에이전트 행의 보조 줄·칩·잠금', () => {
  it('보조 줄과 칩은 코어가 만든 문장 그대로다 — 폰에 새 문장이 없다', () => {
    composer([human, teamKey, mineSub, otherSub, otherKey, pausedMine]);
    openSheet();
    const lines = screen.getAllByTestId('mention-agent-line').map(n => n.props.children);
    const badges = screen.getAllByTestId('mention-badge').map(n => n.props.children);
    const agents = [teamKey, mineSub, otherSub, otherKey, pausedMine];
    expect(lines).toEqual(agents.map(a => mentionAnnotation(a, VIEWER)?.line));
    expect(badges).toEqual(agents.map(a => mentionAnnotation(a, VIEWER)?.badge));
    // 코어가 비어 가는 경우를 막는 못: 문자열로도 한 번 못 박는다.
    expect(lines).toEqual([
      '팀 키 · 누구나',
      '내 구독 · 나만 부를 수 있어요',
      '성재 님 개인 구독 · 성재 님만 부를 수 있어요 · 맥 꺼짐',
      '개인 키 · 성재 님만',
      '내 구독 · 나만 부를 수 있어요 · 문의 중',
    ]);
  });

  it('사람 후보와 서버가 쓰는 AI를 안 알려 준 에이전트에는 줄이 없다', () => {
    composer([human, oldServerAgent]);
    openSheet();
    expect(screen.queryAllByTestId('mention-agent-line')).toHaveLength(0);
    expect(screen.queryAllByTestId('mention-badge')).toHaveLength(0);
    // 옛 표지 「에이전트」는 줄 없는 에이전트에 그대로 선다.
    expect(screen.getByText('에이전트')).toBeTruthy();
  });

  it('못 부르는 행만 자물쇠 + 흐림이고, 눌린 동안은 흐리지 않다', () => {
    composer([teamKey, mineSub, otherSub, otherKey]);
    openSheet();
    const rows = screen.getAllByTestId('mention-option');
    const dim = (i: number, id: string) =>
      flat(within(screen.getAllByTestId('mention-option')[i]).getByTestId(id)).opacity;
    // 팀 키 · 내 구독은 흐리지 않다. 남의 구독·개인 키는 이름 묶음과 칩이 흐리다.
    expect(dim(0, 'mention-identity')).toBeUndefined();
    expect(dim(1, 'mention-badge')).toBeUndefined();
    expect(dim(2, 'mention-identity')).toBe(0.6);
    expect(dim(2, 'mention-badge')).toBe(0.6);
    expect(dim(3, 'mention-identity')).toBe(0.6);
    // 까닭을 말하는 보조 줄은 흐리지 않다 — 줄에도 행에도 opacity 가 없다.
    expect(flat(within(rows[2]).getByTestId('mention-agent-line')).opacity).toBeUndefined();
    expect(flat(rows[2]).opacity).toBeUndefined();
    expect(screen.getAllByTestId('mention-locked-mark', {includeHiddenElements: true})).toHaveLength(2);
    // 눌린(고르는) 동안은 흐림이 눌림 신호를 덮지 않는다.
    fireEvent(rows[2], 'responderGrant', {nativeEvent: {touches: []}, persist: () => {}});
    expect(dim(2, 'mention-identity')).toBeUndefined();
    expect(dim(2, 'mention-badge')).toBeUndefined();
  });

  it('잠긴 행도 고를 수 있다 — 막지 않고 위 한 줄이 말한다', () => {
    const onSend = jest.fn();
    composer([otherSub], {onSend});
    openSheet('@');
    fireEvent.press(screen.getByTestId('mention-option'));
    expect(screen.getByTestId('composer-input').props.value).toBe('@sj ');
  });

  it('읽는 라벨이 보조 줄까지 든다 — 스크린리더가 못 부름을 잃지 않는다', () => {
    composer([otherSub]);
    openSheet();
    const label = screen.getByTestId('mention-option').props.accessibilityLabel as string;
    expect(label).toContain(mentionAnnotation(otherSub, VIEWER)?.line);
    expect(label).toContain('에이전트');
  });

  it('왼쪽 칸이 자라고 칩은 첫 줄에 고정폭으로 선다', () => {
    composer([otherSub]);
    openSheet();
    const badge = screen.getByTestId('mention-badge');
    expect(flat(badge).flexShrink).toBe(0);
    expect(flat(badge).alignSelf).toBe('flex-start');
    expect(badge.props.numberOfLines).toBe(1);
    const line = screen.getByTestId('mention-agent-line');
    expect(line.props.numberOfLines).toBe(mentionAnnotationLines(1));
  });

  it('접근성 크기에서는 칩을 접고 보조 줄은 한 줄로 줄인다 — 줄은 칩의 말을 이미 한다', () => {
    setWindow({fontScale: 3.143});
    composer([otherSub]);
    openSheet();
    expect(screen.queryByTestId('mention-badge')).toBeNull();
    expect(screen.getByTestId('mention-agent-line').props.numberOfLines).toBe(1);
  });
});

describe('멘션 시트 높이 — 두 줄 행에 맞춘 산식', () => {
  const H = 874;
  const SCALES = [1, 1.3, 1.6, 2, 2.143, 3.143, 3.571];

  it('보조 줄이 없는 시트의 산식은 그대로다', () => {
    for (const fs of SCALES) {
      expect(mentionRowHeight(fs)).toBe(mentionRowHeight(fs, false));
      expect(mentionSheetMaxHeight(fs, H)).toBe(mentionSheetMaxHeight(fs, H, false));
    }
    expect(mentionRowHeight(1)).toBe(44);
  });

  it('보조 줄 행은 이름 한 줄 + 보조 줄 + 여백이고 바닥은 엄지 44다', () => {
    // (15 + 17 × 2) × 1 + 8 = 57
    expect(mentionRowHeight(1, true)).toBe(57);
    expect(mentionRowHeight(1, true)).toBeGreaterThan(mentionRowHeight(1, false));
    // 줄 수가 1 로 줄면 행도 준다 — 글자가 커져도 행이 두 줄로 부풀지 않는다.
    expect(mentionAnnotationLines(1.3)).toBe(2);
    expect(mentionAnnotationLines(1.6)).toBe(1);
    for (const fs of SCALES) expect(mentionRowHeight(fs, true)).toBeGreaterThanOrEqual(44);
  });

  it('시트 상한은 온전한 행의 정수배이고 바닥은 한 행이다', () => {
    for (const fs of SCALES) {
      for (const h of [667, 812, 874, 956]) {
        const row = mentionRowHeight(fs, true);
        const max = mentionSheetMaxHeight(fs, h, true);
        expect(max / row).toBeCloseTo(Math.round(max / row), 6);
        expect(max).toBeGreaterThanOrEqual(row);
        expect(max).toBeLessThanOrEqual(4 * row);
      }
    }
  });

  it('바닥(한 행)이 아닌 모든 자리에서 도크가 대화 열 안에 든다', () => {
    for (const fs of SCALES) {
      for (const h of [667, 736, 812, 874, 956]) {
        const budget = composerColumnBudget(fs, h, true);
        const row = mentionRowHeight(fs, true);
        const dock = budget.mentions + budget.composer + budget.dockChrome;
        if (budget.mentions > row) expect(dock).toBeLessThanOrEqual(budget.column + 1e-6);
      }
    }
  });

  it('기준 창(874pt · 기본 크기)에서 두 줄 행 시트는 세 행이다', () => {
    expect(mentionSheetMaxHeight(1, H, true)).toBe(3 * 57);
  });

  it('시트가 실제로 칠하는 maxHeight 가 이 산식이다 — 보조 줄이 있을 때만', () => {
    setWindow({fontScale: 1, height: H});
    composer([otherSub, teamKey]);
    openSheet();
    expect(flat(screen.getByTestId('mention-list')).maxHeight).toBe(
      mentionSheetMaxHeight(1, H, true),
    );
  });

  it('사람만 있는 시트의 maxHeight 는 옛 산식이다', () => {
    setWindow({fontScale: 1, height: H});
    composer([human]);
    openSheet();
    expect(flat(screen.getByTestId('mention-list')).maxHeight).toBe(
      mentionSheetMaxHeight(1, H, false),
    );
  });

  it('보조 줄 시트의 모든 행이 같은 최소 높이다 — 사람 행도', () => {
    setWindow({fontScale: 1, height: H});
    composer([human, otherSub]);
    openSheet();
    const rows = screen.getAllByTestId('mention-option');
    for (const row of rows) {
      expect(flat(row).minHeight).toBe(mentionRowHeight(1, true));
    }
  });
});

describe('입력창 위 한 줄 — 답하지 않을 에이전트를 부르는 글', () => {
  it('남의 구독을 부르는 글이면 코어 문장이 선다', () => {
    composer([teamKey, otherSub]);
    fireEvent.changeText(screen.getByTestId('composer-input'), '@sj 배포 확인해 줘');
    const notice = screen.getByTestId('composer-agent-notice');
    expect(notice.props.children).toBe(composerAgentNotice([otherSub], VIEWER));
    expect(notice.props.children).toBe(
      '성재의 Claude Code는 성재 님만 부를 수 있어요. 보내도 답하지 않아요.',
    );
  });

  it('문의 중인 내 에이전트를 부르는 글이면 이유를 말한다', () => {
    composer([pausedMine]);
    fireEvent.changeText(screen.getByTestId('composer-input'), '@pm 안녕 ');
    expect(screen.getByTestId('composer-agent-notice').props.children).toBe(
      composerAgentNotice([pausedMine], VIEWER),
    );
  });

  it('부를 수 있는 에이전트·사람만 부르면 없다 (실패할 수 있는 가드)', () => {
    composer([teamKey, mineSub, human, otherSub]);
    fireEvent.changeText(screen.getByTestId('composer-input'), '@intern @mine @seongjae 안녕 ');
    expect(screen.queryByTestId('composer-agent-notice')).toBeNull();
  });

  it('보는 사람을 모르면 남의 것으로 읽지 않는다', () => {
    composer([otherSub], {viewerHumanId: null});
    fireEvent.changeText(screen.getByTestId('composer-input'), '@sj 안녕 ');
    expect(screen.queryByTestId('composer-agent-notice')).toBeNull();
  });

  it('글을 고쳐 멘션을 지우면 한 줄도 사라진다', () => {
    composer([otherSub]);
    const input = screen.getByTestId('composer-input');
    fireEvent.changeText(input, '@sj 안녕 ');
    expect(screen.getByTestId('composer-agent-notice')).toBeTruthy();
    fireEvent.changeText(input, '안녕 ');
    expect(screen.queryByTestId('composer-agent-notice')).toBeNull();
  });

  it('두 줄까지만 서고 라벨이 문장 전부를 읽는다', () => {
    composer([otherSub]);
    fireEvent.changeText(screen.getByTestId('composer-input'), '@sj 안녕 ');
    const notice = screen.getByTestId('composer-agent-notice');
    expect(notice.props.numberOfLines).toBe(2);
    expect(notice.props.accessibilityLabel).toBe(notice.props.children);
  });

  it('두 줄 한 줄이 가장 큰 글자에서도 입력창 상한 뒤 열에 든다 — 도크 예산', () => {
    for (const fs of [1, 2.143, 3.143, 3.571]) {
      for (const h of [812, 874, 956]) {
        const b = composerColumnBudget(fs, h);
        const noticeMax = 2 * 17 * fs; // 두 줄 × line.meta × 글자 배수
        expect(b.composer + b.dockChrome + noticeMax).toBeLessThanOrEqual(b.column);
      }
    }
  });

  it('후보 시트가 열린 동안은 서지 않는다 — 도크가 열 안에 들게', () => {
    composer([otherSub]);
    fireEvent.changeText(screen.getByTestId('composer-input'), '@sj 안녕 @');
    expect(screen.getByTestId('mention-list')).toBeTruthy();
    expect(screen.queryByTestId('composer-agent-notice')).toBeNull();
  });
});
