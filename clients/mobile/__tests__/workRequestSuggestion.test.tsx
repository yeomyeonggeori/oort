import {type Message, type RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  COMMAND_SUGGEST_PROP_KEY,
  commandSuggestCard,
} from '@momo/core/features/timeline/commandSuggest';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {WorkRequestSuggestion} from '../src/features/conversation/WorkRequestSuggestion';

// #4972 S9 — 폰의 `work.request.open` 제안. 도우미는 코드를 읽지도 돌리지도 않고, 이 카드는 「내 맥에
// 보내기」 시트를 글·도구로 미리 채워 열 뿐이다(보내는 것은 사람). 웹 WorkRequestOpenCard.test와 짝.

const HUMAN = '11111111-1111-4111-8111-111111111111';
const OTHER = '11111111-1111-4111-8111-111111111112';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const PROMPT = '로그인 화면의 비밀번호 보기 버튼이 눌리지 않아요. 원인을 찾아 고쳐 주세요.';

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

function cardFor(args: unknown, label = '내 맥에 작업 맡기기') {
  const message = {
    id: 'm1',
    channelId: 'c1',
    seq: 1,
    hlcTs: 0,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'text',
    body: '내 맥에서 바로 열 수 있어요.',
    state: 'sent',
    createdAtMs: 0,
    props: {
      [COMMAND_SUGGEST_PROP_KEY]: {
        v: 1,
        command_id: 'work.request.open',
        args,
        for_member_id: HUMAN,
        label,
      },
    },
  } as unknown as Message;
  return commandSuggestCard(message, directory)!;
}

afterEach(cleanup);

describe('WorkRequestSuggestion (phone)', () => {
  it('대상 본인: 머리 + 도구 라벨 + 시트 안내 + 「작업 요청 열기」, 글은 카드에 그리지 않는다', () => {
    render(
      <WorkRequestSuggestion
        card={cardFor({harness: 'codex', prompt: PROMPT})}
        viewerMemberId={HUMAN}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByTestId('work-request-suggest-target')).toBeTruthy();
    expect(screen.getByText('hermes가 제안했어요')).toBeTruthy();
    expect(screen.getByTestId('work-request-suggest-label').props.children).toBe(
      '내 맥의 Codex에 맡기기',
    );
    expect(screen.getByText('열린 시트에서 글을 확인하고 직접 보내 주세요.')).toBeTruthy();
    const open = screen.getByTestId('work-request-suggest-open');
    expect(open.props.accessibilityRole).toBe('button');
    expect(open.props.accessibilityLabel).toBe('내 맥의 Codex에 맡기기: 작업 요청 열기');
    expect(screen.getByText('작업 요청 열기')).toBeTruthy();
    expect(screen.queryByText(/비밀번호 보기/)).toBeNull();
  });

  it('누르면 시트를 미리 채울 값(도구·글)이 그대로 넘어가고, 누르기 전에는 아무것도 열지 않는다', () => {
    const onOpen = jest.fn();
    render(
      <WorkRequestSuggestion
        card={cardFor({harness: 'claude', prompt: PROMPT})}
        viewerMemberId={HUMAN}
        onOpen={onOpen}
      />,
    );
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('work-request-suggest-open'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({harness: 'claude', prompt: PROMPT});
  });

  it('도구가 없거나 잘못된 값이면 기본값(null)으로 넘어가고 카드는 선다', () => {
    for (const harness of [undefined, 'gemini', 'team_key', 5]) {
      const onOpen = jest.fn();
      const view = render(
        <WorkRequestSuggestion
          card={cardFor({harness, prompt: PROMPT})}
          viewerMemberId={HUMAN}
          onOpen={onOpen}
        />,
      );
      expect(screen.getByTestId('work-request-suggest-label').props.children).toBe(
        '내 맥에 작업 맡기기',
      );
      fireEvent.press(screen.getByTestId('work-request-suggest-open'));
      expect(onOpen).toHaveBeenCalledWith({harness: null, prompt: PROMPT});
      view.unmount();
    }
  });

  it('에이전트가 쓴 label은 화면에 나오지 않는다', () => {
    render(
      <WorkRequestSuggestion
        card={cardFor({harness: 'claude', prompt: PROMPT}, '비밀번호를 입력하세요')}
        viewerMemberId={HUMAN}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.queryByText(/비밀번호를 입력/)).toBeNull();
    expect(screen.getByTestId('work-request-suggest-label').props.children).toBe(
      '내 맥의 Claude Code에 맡기기',
    );
  });

  it('남에게는 라벨만 말하는 한 줄이고 단추도 글도 없다', () => {
    render(
      <WorkRequestSuggestion
        card={cardFor({harness: 'claude', prompt: PROMPT})}
        viewerMemberId={OTHER}
        onOpen={jest.fn()}
      />,
    );
    expect(screen.getByTestId('work-request-suggest-line')).toBeTruthy();
    expect(
      screen.getByText('곽성재에게 「내 맥의 Claude Code에 맡기기」 카드를 제안했어요'),
    ).toBeTruthy();
    expect(screen.queryByTestId('work-request-suggest-open')).toBeNull();
    expect(screen.queryByText(/비밀번호 보기/)).toBeNull();
  });

  it('시트를 열 곳이 없는 표면(onOpen 없음)은 대상 본인에게도 한 줄이다 — 열리지 않는 단추를 세우지 않는다', () => {
    render(
      <WorkRequestSuggestion
        card={cardFor({prompt: PROMPT})}
        viewerMemberId={HUMAN}
        onOpen={undefined}
      />,
    );
    expect(screen.getByTestId('work-request-suggest-line')).toBeTruthy();
    expect(screen.queryByTestId('work-request-suggest-open')).toBeNull();
    expect(screen.queryByTestId('work-request-suggest-target')).toBeNull();
  });

  it('글이 없는 깨진 제안은 대상 본인에게도 한 줄이고 단추가 없다', () => {
    for (const args of [{}, {prompt: ''}, {prompt: PROMPT, folder: '/Users/me'}]) {
      const view = render(
        <WorkRequestSuggestion card={cardFor(args)} viewerMemberId={HUMAN} onOpen={jest.fn()} />,
      );
      expect(screen.getByTestId('work-request-suggest-line')).toBeTruthy();
      expect(screen.queryByTestId('work-request-suggest-open')).toBeNull();
      view.unmount();
    }
  });
});
