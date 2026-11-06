import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import React from 'react';
import {View} from 'react-native';

import {MessageBody} from '../src/features/conversation/MessageBody';
import {cleanup, render, screen} from './fixtures/darkWorld';
import {sweepHangulWord} from './fixtures/hangulWord';

// =============================================================================
// 말풍선 본문의 한국어는 어절 단위로 꺾인다 (#5313, #5288 의 같은 규칙).
//
// 5c 검증은 말풍선 본문 한국어가 글자 단위로 꺾이는 것(「두었으/니」·「오/전 9시」)을 관찰했다. 앱 안의 다른 글(`Sentence`·`NoticeBlock`·입력창)은 이미
// `lineBreakStrategyIOS="hangul-word"` 인데 말풍선 문단만 맨 `Text` 였다. 이 시험은 말풍선의 **모든 산문 글자 노드**(평문 · 마크다운 문단 · 목록 항목)가
// 그 속성을 드는지 렌더 트리 전체에서 센다(`fixtures/hangulWord.ts` - 이름 허용 목록이 아니다). 실제로 어절에서 꺾이는지·긴 낱말이 넘치지 않는지는 jest 에
// TextKit 이 없어 못 잰다 — 시뮬레이터 하네스(`measure/bubbleClip.tsx`, `bubble-clip-check.mjs compare`)가 전후 숫자로 잰다.
// =============================================================================

afterEach(() => {
  cleanup();
});

function member(id: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: handle,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const SELF = '11111111-1111-4111-8111-111111111111';
const PEER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DIRECTORY = makeDirectory([member(SELF, 'lane-tester'), member(PEER, 'dohyun')]);

// 코드 블록의 「복사하기」는 낱말 하나짜리 단추 이름이라 꺾일 일이 없다 - 산문이 아니므로 센 뒤에 뺀다.
const CODE_COPY_LABEL = '복사하기';

const bodies: [string, string, 'mine' | 'other' | null][] = [
  ['평문 한국어(마크업 없음)', '오늘 오후 세 시에 디자인 리뷰가 있어요. 자료는 공유 폴더에 올려 두었으니 미리 한번 훑어보세요.', 'other'],
  [
    '마크다운 문단(굵게·인라인 코드·링크·멘션) + 번호·글머리 목록',
    '**공지** `배포` 일정이에요. [문서](https://example.com/a)를 읽고 @dohyun 에게 알려 주세요.\n\n- 디자인 리뷰는 월요일 오후에 진행해요\n- 배포 리허설은 수요일 오전에 해요\n\n1. 먼저 서버를 올려요\n2. 앱은 그다음이에요',
    'mine',
  ],
  ['산문 + 코드 블록 + 산문', '이렇게 돌려요.\n\n```bash\n./deploy.sh --dry-run\n```\n\n끝나면 알려 주세요.', 'other'],
];

describe('말풍선 본문 - 어절 줄바꿈 (#5313)', () => {
  it.each(bodies)('한글이 든 산문 글자 노드는 모두 hangul-word 다 - %s', (_name, body, bubble) => {
    render(
      <View testID="root">
        <MessageBody body={body} bubble={bubble} directory={DIRECTORY} selfMemberId={SELF} />
      </View>,
    );
    const swept = sweepHangulWord(screen.getByTestId('root'));
    // 빈 훑기가 아니다: 한글이 든 가장 바깥 글자 노드를 실제로 센다(목록 장면은 문단 + 항목 넷 이상).
    expect(swept.checked).toBeGreaterThanOrEqual(1);
    expect(swept.missing.filter(text => text !== CODE_COPY_LABEL)).toEqual([]);
    // 깨뜨리면: MessageBody 의 평문 `Text`·마크다운 문단 `Text`·목록 항목 `Text` 의 `lineBreakStrategyIOS` 를 지운다 → 해당 글자가 missing 에 든다.
  });
});
