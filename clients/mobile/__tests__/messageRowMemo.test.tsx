import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';

import {
  MESSAGE_ROW_COMPARED_PROPS,
  sameMessageRowProps,
  type MessageRowProps,
} from '../src/features/conversation/MessageRow';

// =============================================================================
// memo 비교자가 **모든 prop 을 본다** (1R M2)
//
// `MessageRow` 는 `React.memo` 로 감싸여 있고, 그 비교자는 필드를 손으로 열거한다
// (`sameMessageRowProps`). 빠르고 읽히지만 그 형태에는 조용한 결함이 붙는다:
// prop 이 하나 늘어도 비교자는 컴파일되고, 그 순간 이 행은 그 값이 바뀌어도 다시
// 그려지지 않는 행이 된다. **성능 결함이 아니라 정확성 결함**이고, 화면에는 옛
// 값이 남는다.
//
// `MESSAGE_ROW_COMPARED_PROPS` 가 그 절반을 잠근다 — prop 이 늘면 빌드가 멈추므로
// 아무도 모르게 지나갈 수 없다. 나머지 절반이 이 파일이다: 목록에 적힌 모든 키에
// 대해 **그 값만 바꾼 두 props 를 비교자가 다르다고 말하는가**를 묻는다.
//
// 그래서 열한 번째 prop 을 추가하면 두 번 걸린다. 먼저 타입이(목록에 적어라),
// 그 다음 이 테스트가(비교자에 넣어라). 목록에만 적고 비교자를 잊는 것이 정확히
// 이 파일이 막는 실패다.
//
// 순회는 `Object.keys` 가 아니라 **키마다 손으로 쓴 변형**으로 한다: 무엇을
// "바뀐 값"으로 볼지는 타입이 답해 줄 수 없고, 그 판단이야말로 새 prop 을 넣는
// 사람이 해야 하는 일이기 때문이다. `Record<keyof MessageRowProps, …>` 이므로
// 여기서도 하나라도 빠지면 컴파일되지 않는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const BASE_MS = 1_700_000_000_000;

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

const DIRECTORY = makeDirectory([member({id: SELF}), member({id: OTHER})]);
/** 값은 같고 **동일성만 다른** 디렉터리. 이 prop 은 동일성으로 본다. */
const OTHER_DIRECTORY = makeDirectory([member({id: SELF}), member({id: OTHER})]);

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

const BASE: MessageRowProps = {
  message: message(1),
  startsGroup: true,
  directory: DIRECTORY,
  chips: [{emoji: '👍', count: 1, mine: false}],
  pausedRepeat: undefined,
  nowMs: BASE_MS,
  onResend: () => {},
  actions: undefined,
  rollup: {replyCount: 1, lastReplySeq: 9, lastReplyAtMs: BASE_MS},
  replyParent: undefined,
  approvalGates: new Map([
    ['ap-1', {approvalId: 'ap-1', reversible: false, expiresAtMs: null}],
  ]),
  approvalReceipts: new Map(),
  approvalOffline: false,
  onApprovalSettled: () => {},
  quote: {
    kind: 'ready',
    targetId: 'orig-1',
    targetSeq: 4,
    authorMemberId: OTHER,
    lines: ['배포 로그 확인했습니다'],
    truncated: false,
    quotesAnother: false,
    edited: false,
  },
};

/**
 * 키마다 "이것이 바뀌면 행이 달라 보인다"의 한 예.
 *
 * `chips`·`rollup`·`quote` 는 **값**만 바꾼다(새 배열/새 객체이되 내용이 같으면
 * 같아야 하므로, 내용을 바꾸지 않으면 이 테스트는 아무것도 묻지 못한다). 나머지는
 * 동일성만 바꾸어도 충분하다 — 그것이 그 prop 들의 계약이다.
 */
const CHANGED: Record<keyof MessageRowProps, Partial<MessageRowProps>> = {
  message: {message: message(2)},
  startsGroup: {startsGroup: false},
  directory: {directory: OTHER_DIRECTORY},
  chips: {chips: [{emoji: '👍', count: 2, mine: false}]},
  // 이슈 #1112. 고정 여부가 바뀌면 행 메뉴의 낱말이 바뀐다 — 스칼라라 동일성이
  // 곧 값이고, 비교자가 이것을 안 보면 고정한 행이 계속 「고정하기」라고 말한다.
  pinned: {pinned: true},
  pausedRepeat: {pausedRepeat: 3},
  // 접힌 묘비의 수(감사 M-1)와 착지 표시(#1076). 둘 다 스칼라라 값이 곧
  // 동일성이고, 둘 다 **화면에 보이는 것**을 바꾸므로 비교자가 반드시 봐야 한다.
  deletedRepeat: {deletedRepeat: 3},
  landed: {landed: true},
  nowMs: {nowMs: BASE_MS + 60_000},
  onResend: {onResend: () => {}},
  actions: {
    actions: {
      myMemberId: SELF,
      onToggleReaction: async () => {},
      onEdit: async () => {},
      onDelete: async () => {},
    },
  },
  rollup: {rollup: {replyCount: 2, lastReplySeq: 10, lastReplyAtMs: BASE_MS}},
  replyParent: {replyParent: message(1)},
  // 원본이 **수정되면** 인용도 따라 바뀐다(ADR-0148 규칙 3: 참조이지 사본이
  // 아니다). 그 변화는 새 페이지가 실어 오는 새 객체로 도착하므로, 값으로 보지
  // 않으면 행은 옛 본문을 그대로 들고 앉아 있게 된다.
  quote: {
    quote: {
      kind: 'ready',
      targetId: 'orig-1',
      targetSeq: 4,
      authorMemberId: OTHER,
      lines: ['고쳐 쓴 원문'],
      truncated: false,
      quotesAnother: false,
      edited: true,
    },
  },
  // 두 표는 **동일성**으로 본다(`directory` 와 같은 취급). 화면이 `useMemo` 로
  // 붙잡으므로 승인이 실제로 바뀔 때만 새 표가 된다.
  approvalGates: {approvalGates: new Map()},
  approvalReceipts: {
    approvalReceipts: new Map([
      ['ap-1', {note: '승인을 기록했습니다.', status: 'approved'}],
    ]),
  },
  approvalOffline: {approvalOffline: true},
  // 원장 표면의 유무. 스칼라이고 **문장을 바꾼다** — 코어 `approvalCardNote` 가
  // 이 값으로 「지금 못 보낸다」와 「다른 데서 하세요」를 가르므로, 비교자가 이
  // 값을 안 보면 서버 표면이 바뀌어도 카드가 옛 문장을 그대로 든다.
  approvalsProvided: {approvalsProvided: false},
  onApprovalSettled: {onApprovalSettled: () => {}},
};

describe('memo 비교자는 모든 prop 을 본다', () => {
  it('아무것도 바뀌지 않으면 같다 — 그래야 이 memo 가 값을 한다', () => {
    expect(sameMessageRowProps(BASE, {...BASE})).toBe(true);
  });

  it('값이 같은 새 chips / rollup / quote 는 같다 — 얕은 비교였다면 여기서 실패한다', () => {
    // `chipsFor` 는 새 배열을, `rollupFor` 는 새 객체를 렌더마다 돌려준다. 인용
    // 미리보기도 호출부가 페이지의 `replyTo` 를 풀어 만드는 새 객체다. 이 단정이
    // memo 가 실제로 무언가를 사는 유일한 이유다.
    expect(
      sameMessageRowProps(BASE, {
        ...BASE,
        chips: [{emoji: '👍', count: 1, mine: false}],
        rollup: {replyCount: 1, lastReplySeq: 9, lastReplyAtMs: BASE_MS},
        quote: {
          kind: 'ready',
          targetId: 'orig-1',
          targetSeq: 4,
          authorMemberId: OTHER,
          lines: ['배포 로그 확인했습니다'],
          truncated: false,
          quotesAnother: false,
          edited: false,
        },
      }),
    ).toBe(true);
  });

  it('인용이 지워지면 다르다 — 묘비 전환을 memo 가 가리면 안 된다', () => {
    // 갈래가 바뀌는 것은 화면에 반드시 보여야 하는 변화다. 그리고 그 반대편도
    // 마찬가지다: 못 푼 인용(`unresolved`)이 풀리는 순간을 memo 가 가리면, 원본이
    // 스크롤로 로드된 뒤에도 「아직 못 불러왔다」가 남는다.
    expect(
      sameMessageRowProps(BASE, {
        ...BASE,
        quote: {
          kind: 'deleted',
          targetId: 'orig-1',
          targetSeq: 4,
          authorMemberId: OTHER,
        },
      }),
    ).toBe(false);
    expect(
      sameMessageRowProps(BASE, {
        ...BASE,
        quote: {kind: 'unresolved', targetId: 'orig-1', targetSeq: null},
      }),
    ).toBe(false);
  });

  it('인용이 없는 행에서 null 과 undefined 는 같다', () => {
    // `rollup` 과 반대다(바로 아래 단정이 그 차이를 지킨다). 인용에는 「이 표면은
    // 인용을 안 그린다」와 「서버의 것을 쓰라」의 구별이 없다 — 둘 다 「아무것도
    // 인용하지 않는다」 하나뿐이므로, 갈라 두면 memo 만 헛되이 놓친다.
    expect(
      sameMessageRowProps({...BASE, quote: null}, {...BASE, quote: undefined}),
    ).toBe(true);
  });

  it.each(
    (Object.keys(MESSAGE_ROW_COMPARED_PROPS) as (keyof MessageRowProps)[]).map(
      key => [key] as const,
    ),
  )('%s 가 바뀌면 다르다고 말한다', key => {
    expect(sameMessageRowProps(BASE, {...BASE, ...CHANGED[key]})).toBe(false);
  });

  it('null 과 undefined 인 rollup 은 서로 다르다', () => {
    // `null` 은 "이 표면에는 롤업이 없다"이고 `undefined` 는 "서버의 것을 쓰라"다.
    // 둘을 같다고 하면 행이 서버 롤업으로 되돌아가는 것을 memo 가 가려 버린다.
    expect(
      sameMessageRowProps(
        {...BASE, rollup: null},
        {...BASE, rollup: undefined},
      ),
    ).toBe(false);
  });
});
