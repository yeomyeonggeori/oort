import fs from 'fs';
import path from 'path';
import type {Message, RosterMember} from '@momo/core/lib/api';
import type {EchoPins, PendingMessage} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// #5624 검수 1회차 M2 — 폰 화면 배선을 지킨다.
//
// `echoSkewGrouping.test` 는 훅의 출력으로 코어 빌더를 **직접** 부르므로, 훅 → 화면 → 목록으로 넘기는 줄이 빠져도 통과했다(검수 사보타주
// C·C2 GREEN). 여기서는 진짜 `ThreadPanel` → 진짜 `Timeline` → 진짜 행을 그리고, 그려진 행에 머리(작성자 줄의 시각 `row-time`)가 섰는지를
// 읽는다. 대화 화면(`ConversationScreen`)은 그리는 데 세계 전체(세션·실시간·푸시·서버 대역)가 필요해서, 같은 `Timeline` 에 두 값을
// 넘기는 줄을 소스에서 잰다 — `Timeline` 이 그 두 값으로 행을 묶는 것은 위 스레드 시험이 그린 화면으로 잰다.
//
// 장면: 내 답글 둘(서버 10:47:30 · 10:48:00.1)과 날아가는 답글 에코 하나(기기 10:46:50). 장부는 둘째 확정본이 에코 때 10:47:59.8이었다고
// 말하고, 서버 시계는 기기보다 90초 앞선다. 배선이 살아 있으면 둘째 답글과 에코가 이어진 줄이고, 빠지면 둘 다 머리다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const at = (m: number, s: number, ms = 0) => new Date(2026, 10, 9, 10, m, s, ms).getTime();

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([member(SELF, '곽성재', 'seongjae'), member(OTHER, '김인턴', 'intern-kim')]);

function message(seq: number, over: Partial<Message>): Message {
  return {
    id: `00000000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: `${seq}번째`,
    state: 'sent',
    createdAtMs: at(40, 0),
    ...over,
  };
}

const ROOT = message(10, {id: ROOT_ID, authorMemberId: OTHER, body: '배포는 금요일에 합니다.', createdAtMs: at(40, 0)});
const FIRST = message(11, {rootId: ROOT_ID, body: '47분의 답글', createdAtMs: at(47, 30)});
const BOUNDARY = message(12, {rootId: ROOT_ID, body: '경계의 답글', createdAtMs: at(48, 0, 100)});
const ECHO: PendingMessage = {
  clientMsgId: 'client-echo',
  channelId: 'ch',
  authorMemberId: SELF,
  body: '날아가는 답글',
  createdAtMs: at(46, 50),
  sinceSeq: 12,
  status: 'sending',
  rootId: ROOT_ID,
};
const BODIES = [FIRST.body!, BOUNDARY.body!, ECHO.body];

/** `ThreadPanel` 이 실제로 읽는 만큼의 `useTimeline`(`threadSelfSend.test` 와 같은 모양) + 장부와 시계 차이. */
function Harness({echoPins, serverOffsetMs}: {echoPins: EchoPins; serverOffsetMs: number}): React.JSX.Element {
  const timeline = React.useMemo<UseTimelineResult>(
    () =>
      ({
        state: {messages: [ROOT, FIRST, BOUNDARY], oldestSeq: ROOT.seq, newestSeq: BOUNDARY.seq},
        status: 'ready',
        resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
        recoveryMarkers: [],
        pending: [],
        echoPins,
        serverOffsetMs,
        send: async () => {},
        resend: async () => {},
        toggleReaction: async () => {},
        editBody: async () => {},
        removeMessage: async () => {},
        loadReplies: async () => {},
        sendReply: async () => {},
        repliesPending: () => [ECHO],
        loadOlder: async () => {},
        reload: () => {},
        loadingOlder: false,
        reachedStart: true,
        reactions: {},
      }) as unknown as UseTimelineResult,
    [echoPins, serverOffsetMs],
  );
  return (
    <ThreadPanel
      root={ROOT}
      timeline={timeline}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={at(49, 0)}
      onClose={() => {}}
    />
  );
}

/** 그려진 행마다 머리(작성자 줄의 시각)가 섰는가 — 본문 → 머리인가. */
function headsOnScreen(): Record<string, boolean> {
  const heads: Record<string, boolean> = {};
  const rows = [...screen.queryAllByTestId('message-row'), ...screen.queryAllByTestId('pending-row')];
  for (const row of rows) {
    for (const body of BODIES) {
      if (within(row).queryAllByText(body).length > 0) heads[body] = within(row).queryAllByTestId('row-time', {includeHiddenElements: true}).length > 0;
    }
  }
  return heads;
}

afterEach(cleanup);

describe('#5624 M2 폰 스레드 — 장부와 시계 차이가 그려진 답글까지 닿는다', () => {
  it('장부가 이어진 줄이라 말한 확정본과, 차이를 더하면 같은 분인 답글 에코가 모두 머리 없이 그려진다', () => {
    render(
      <Harness
        echoPins={new Map([[BOUNDARY.id.toLowerCase(), {atMs: at(47, 59, 800), clientMsgId: 'client-boundary'}]])}
        serverOffsetMs={90_000}
      />,
    );
    expect(headsOnScreen()).toEqual({'47분의 답글': true, '경계의 답글': false, '날아가는 답글': false});
  });

  it('대조: 장부가 비고 차이가 0이면 같은 답글들이 서버·기기 시각으로 묶여 둘 다 머리다(장면이 배선을 가른다)', () => {
    render(<Harness echoPins={new Map()} serverOffsetMs={0} />);
    expect(headsOnScreen()).toEqual({'47분의 답글': true, '경계의 답글': true, '날아가는 답글': true});
  });
});

describe('#5624 M2 폰 대화 화면 — 같은 `Timeline` 에 장부와 시계 차이를 넘긴다', () => {
  const SCREEN = fs.readFileSync(path.resolve(__dirname, '../src/screens/ConversationScreen.tsx'), 'utf8');
  const code = SCREEN.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('대화 목록 `<Timeline …>` 의 속성에 훅의 `echoPins`·`serverOffsetMs` 가 그대로 들어간다', () => {
    // 대화 목록은 `pending={timeline.pending}` 을 받는 `<Timeline` 하나다. 그 요소의 속성 덩어리만 떼어 본다.
    const element = code.match(/<Timeline\b(?:(?!\/>|<Timeline\b)[\s\S])*?pending=\{timeline\.pending\}(?:(?!\/>)[\s\S])*\/>/);
    expect(element).not.toBeNull();
    expect(element![0]).toMatch(/\bechoPins=\{timeline\.echoPins\}/);
    expect(element![0]).toMatch(/\bserverOffsetMs=\{timeline\.serverOffsetMs\}/);
  });
});
