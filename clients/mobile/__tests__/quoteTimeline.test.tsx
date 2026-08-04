import type {Message, RosterMember} from '@momo/core/lib/api';
import {QUOTE_DELETED_TEXT} from '@momo/core/features/timeline/quote';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import type {MessageRowActions} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 인용이 **목록 위에서** 성립하는가 (ADR-0148 · goal B3 M1).
//
// 앞의 두 파일은 블록 하나와 행 하나를 본다. 여기서 보는 것은 목록만이 답할 수
// 있는 세 가지다:
//
//   1. **라이브로 온 인용을 화면에 있는 행에서 푼다.** `message.new` 프레임에는
//      `reply_to` 가 없다 — outbox 행은 한 번 쓰이고 영원히 재생되므로 본문을
//      실으면 그것이 곧 규칙 3 이 금지한 스냅샷이다. 그래서 프레임은 id 만 나르고,
//      목록이 자기가 이미 든 행에서 푼다. **요청 없이.**
//   2. **못 풀면 못 풀었다고 말한다.** 삭제가 아니다. 이 둘을 접는 순간 화면은
//      멀쩡한 메시지를 지워졌다고 말하기 시작한다.
//   3. **낙관적 메아리가 자기 인용을 먼저 그린다.** 없으면 seq 가 도착할 때
//      블록이 자라나고, 읽던 사람 눈 밑에서 본문이 밀린다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;
const ORIGINAL_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(over: Partial<Message> & {id: string; seq: number}): Message {
  return {
    channelId: 'ch',
    hlcTs: over.seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '본문',
    state: 'sent',
    createdAtMs: BASE_MS + over.seq * 1000,
    ...over,
  };
}

const ORIGINAL = message({
  id: ORIGINAL_ID,
  seq: 4,
  body: '배포 로그 확인했습니다',
});

const ACTIONS: MessageRowActions = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
  onJumpToQuoted: () => {},
};

function timeline(
  messages: Message[],
  pending: PendingMessage[] = [],
  actions?: MessageRowActions,
): ReturnType<typeof render> {
  return render(
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      pending={pending}
      myMemberId={SELF}
      nowMs={BASE_MS + 60_000}
      actions={actions}
    />,
  );
}

afterEach(cleanup);

describe('라이브로 온 인용', () => {
  it('화면에 있는 행에서 풀고, 아무것도 조회하지 않는다', () => {
    const fetchSpy = jest.spyOn(global, 'fetch' as never);
    timeline([
      ORIGINAL,
      // 실시간 프레임이 만든 행: `replyToId` 만 있고 `replyTo` 는 없다.
      message({id: 'msg-2', seq: 5, replyToId: ORIGINAL_ID, body: '확인'}),
    ]);
    expect(screen.getByTestId('quote-body').props.children).toEqual([
      '배포 로그 확인했습니다',
      '',
    ]);
    expect(screen.queryByTestId('quote-unresolved')).toBeNull();
    // 이 클라이언트에서 조회를 셀 수 있는 자리는 전역 `fetch` 하나뿐이다 —
    // `projectShape.test.ts` 가 `src/` 안의 직접 fetch 를 이미 금지하므로,
    // 여기서 0 이면 코어를 경유한 조회도 없다는 뜻이다.
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('원본이 이 화면에 없으면 삭제가 아니라 「아직 못 불러왔다」다', () => {
    timeline([
      message({id: 'msg-2', seq: 5, replyToId: ORIGINAL_ID, body: '확인'}),
    ]);
    expect(screen.getByTestId('quote-unresolved')).toBeTruthy();
    expect(screen.queryByText(QUOTE_DELETED_TEXT)).toBeNull();
  });

  it('서버가 페이지에 동봉한 인용을 그대로 쓴다 — 지워진 원본까지', () => {
    // 히스토리 경로. 원본이 목록에 **없어도** 서버가 실어 준 값이 있으므로
    // 「못 불러왔다」가 아니다.
    timeline([
      message({
        id: 'msg-2',
        seq: 5,
        body: '확인',
        replyToId: ORIGINAL_ID,
        replyTo: {
          id: ORIGINAL_ID,
          seq: 4,
          authorMemberId: OTHER,
          type: 'text',
          state: 'deleted',
          deletedAtMs: BASE_MS,
        },
      }),
    ]);
    expect(screen.getByTestId('quote-tombstone').props.children).toBe(
      QUOTE_DELETED_TEXT,
    );
    expect(screen.queryByTestId('quote-unresolved')).toBeNull();
  });

  it('문을 그릴지는 목록이 답한다 — 원본이 로드된 범위 안에 있을 때만', () => {
    // 행은 자기 밖을 모른다. 무엇이 로드돼 있는지는 페이지를 든 목록만 안다.
    const withOriginal = timeline(
      [
        ORIGINAL,
        message({id: 'msg-2', seq: 5, replyToId: ORIGINAL_ID, body: '확인'}),
      ],
      [],
      ACTIONS,
    );
    expect(screen.getByTestId('quote-block').props.accessibilityRole).toBe(
      'button',
    );
    withOriginal.unmount();

    timeline(
      [message({id: 'msg-2', seq: 5, replyToId: ORIGINAL_ID, body: '확인'})],
      [],
      ACTIONS,
    );
    expect(
      screen.getByTestId('quote-block').props.accessibilityRole,
    ).toBeUndefined();
  });
});

describe('낙관적 메아리', () => {
  it('보내는 중에도 자기 인용을 그린다 — seq 가 온 뒤에 자라나지 않게', () => {
    timeline(
      [ORIGINAL],
      [
        {
          clientMsgId: 'c-1',
          channelId: 'ch',
          authorMemberId: SELF,
          body: '확인했습니다',
          createdAtMs: BASE_MS + 9_000,
          sinceSeq: 4,
          status: 'sending',
          replyToId: ORIGINAL_ID,
        },
      ],
    );
    expect(screen.getByTestId('pending-row')).toBeTruthy();
    expect(screen.getByTestId('quote-body').props.children).toEqual([
      '배포 로그 확인했습니다',
      '',
    ]);
  });

  it('인용 없는 전송에는 블록도 없다', () => {
    timeline(
      [ORIGINAL],
      [
        {
          clientMsgId: 'c-1',
          channelId: 'ch',
          authorMemberId: SELF,
          body: '확인했습니다',
          createdAtMs: BASE_MS + 9_000,
          sinceSeq: 4,
          status: 'sending',
        },
      ],
    );
    expect(screen.getByTestId('pending-row')).toBeTruthy();
    expect(screen.queryByTestId('quote-block')).toBeNull();
  });
});
