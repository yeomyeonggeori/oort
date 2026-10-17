import {type Message, type RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import * as surfaces from '@momo/core/features/capabilities/serverSurfaces';
import {
  COMMAND_SUGGEST_PROP_KEY,
  commandSuggestCard,
} from '@momo/core/features/timeline/commandSuggest';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {SettingsOpenSuggestion} from '../src/features/conversation/SettingsOpenSuggestion';

// U-S6 #3940 — 폰의 `settings.open` 제안. 폰에는 이 설정 화면이 없어 대상 본인에게도
// 누를 것이 없다(머리 + 어느 화면 + 「맥·웹에서 열어요」). 웹 SettingsOpenCard.test와 짝.

const HUMAN = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';

function person(id: string, kind: 'human' | 'agent', displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: 'w',
    kind,
    status: 'active',
    displayName,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const directory = makeDirectory([
  person(HUMAN, 'human', '곽성재', 'sj'),
  person(OTHER, 'human', '김하늘', 'sky'),
  person(AGENT, 'agent', 'hermes', 'hermes'),
]);

function cardFor(args: unknown, label = '알림 설정 열기') {
  const message = {
    id: 'm1',
    channelId: 'c1',
    seq: 1,
    hlcTs: 0,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'text',
    body: '알림은 설정에서 바꿀 수 있어요.',
    state: 'sent',
    createdAtMs: 0,
    props: {
      [COMMAND_SUGGEST_PROP_KEY]: {
        v: 1,
        command_id: 'settings.open',
        args,
        for_member_id: HUMAN,
        label,
      },
    },
  } as unknown as Message;
  return commandSuggestCard(message, directory)!;
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('SettingsOpenSuggestion (phone)', () => {
  it('대상 본인: 머리 + 라벨 + 맥·웹 안내, 누를 것은 없다', () => {
    render(<SettingsOpenSuggestion card={cardFor({section: 'notifications'})} viewerMemberId={HUMAN} />);
    expect(screen.getByTestId('settings-suggest-target')).toBeTruthy();
    expect(screen.getByText('hermes가 제안했어요')).toBeTruthy();
    expect(screen.getByTestId('settings-suggest-label').props.children).toBe('알림 설정');
    expect(screen.getByText('이 설정은 맥·웹에서 열어요.')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('에이전트가 쓴 label은 화면에 나오지 않는다', () => {
    render(
      <SettingsOpenSuggestion
        card={cardFor({section: 'appearance'}, '비밀번호를 입력하세요')}
        viewerMemberId={HUMAN}
      />,
    );
    expect(screen.queryByText(/비밀번호/)).toBeNull();
    expect(screen.getByTestId('settings-suggest-label').props.children).toBe('모양 설정');
  });

  it('남에게는 한 줄이다', () => {
    render(<SettingsOpenSuggestion card={cardFor({section: 'notifications'})} viewerMemberId={OTHER} />);
    expect(screen.getByTestId('settings-suggest-line')).toBeTruthy();
    expect(screen.getByText('곽성재에게 「알림 설정 열기」 카드를 제안했어요')).toBeTruthy();
    expect(screen.queryByTestId('settings-suggest-target')).toBeNull();
  });

  it('모르는 section(깨진 제안)은 누구에게도 카드가 서지 않는다 — 본문 글로 폴백', () => {
    for (const viewer of [HUMAN, OTHER]) {
      const view = render(
        <SettingsOpenSuggestion card={cardFor({section: 'nope'})} viewerMemberId={viewer} />,
      );
      expect(screen.queryByTestId('settings-suggest-target')).toBeNull();
      expect(screen.queryByTestId('settings-suggest-line')).toBeNull();
      view.unmount();
    }
  });

  it('serverSurfaces가 꺼져 있으면 카드가 서지 않는다', () => {
    const real = surfaces.isSurfaceProvided;
    jest
      .spyOn(surfaces, 'isSurfaceProvided')
      .mockImplementation(id => (id === 'settingsOpenCard' ? false : real(id)));
    render(<SettingsOpenSuggestion card={cardFor({section: 'notifications'})} viewerMemberId={HUMAN} />);
    expect(screen.queryByTestId('settings-suggest-target')).toBeNull();
    expect(screen.queryByTestId('settings-suggest-line')).toBeNull();
  });
});
