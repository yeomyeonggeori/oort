import type {Message, RosterMember} from '@momo/core/lib/api';

import {BASE_MS, OTHER_ID} from './ids';

/**
 * 로스터 한 명. 기본은 활동 중인 사람 하나이고, 넘긴 값이 이긴다.
 *
 * 이 트리에서 가장 많이 복제된 도구다(59개 파일이 같은 몸통을 각자 선언했다). 몸통은
 * 그중 가장 흔한 형태(39개 파일에서 글자 그대로 같았다) 그대로라서, 지역 선언을 이것으로
 * 바꿔도 시험이 보는 값은 같다.
 */
export function member(over: Partial<RosterMember> & {id: string}): RosterMember {
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

/**
 * 글 메시지 한 건. `seq` 하나로 id·순서·시각이 서로 어긋나지 않게 정해지고, 나머지는
 * 넘긴 값이 이긴다. 시각은 `BASE_MS` 에서 `seq` 초씩 흐른다.
 */
export function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER_ID,
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}
