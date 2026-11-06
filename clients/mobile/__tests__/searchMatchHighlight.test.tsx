import {contrast} from '@momo/core/design/color';
import type {RosterMember} from '@momo/core/lib/api';
import type {Expression} from '@momo/core/features/expressions/types';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen, within} from '@testing-library/react-native';
import React from 'react';
import {StyleSheet} from 'react-native';

import {THEMES} from '../src/design/ds2Tokens';
import {FixedScheme} from '../src/design/theme';
import {darkPalette, lightPalette, paletteFrom} from '../src/design/tokens';
import {BUBBLE_MIN_CONTRAST, bubbleFor, searchMatchFor} from '../src/features/conversation/bubble';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {ExpressionText, ExpressionTextContext} from '../src/features/expressions/ExpressionText';
import {queryRanges} from '../src/features/search/localSearch';
import {SearchMatchContext} from '../src/features/search/MatchedText';

// 표식(이모티콘 자리)은 그림이 아니라 자리표시 글자로만 확인한다 — 이 파일이 재는 것은 칠하기이지 이미지 로딩이 아니다.
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {Text} = jest.requireActual('react-native');
  return {ExpressionImage: () => <Text testID="expression-image">[표현]</Text>};
});

// =============================================================================
// 말풍선 본문 안의 찾은 글자 강조 (#5384).
//
// 대화 안 검색으로 착지한 메시지는 행 틴트(1.5초)만 있었다. 이제 고른 결과의 말풍선 **본문 안**에서 찾은 글자가 칠해진다. 이 파일이 묻는 것:
//
//   1. 범위 찾기 - 대소문자를 접고(서버가 ILIKE), 겹치지 않게 전부, 코드포인트 위치로.
//   2. 칩 색 - 어떤 테마·스킴의 내 말풍선(신호색)과 남 말풍선에서도 말풍선과 갈려 보이고 글자가 4.5:1 을 지킨다.
//   3. 본문에서만 - 인용 머리·코드 블록·인라인 코드는 칠해지지 않는다. 이모티콘 표식은 잘리지 않는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';

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

afterEach(cleanup);

const matches = (): string[] =>
  screen.queryAllByTestId('message-search-match').map(node => node.props.children as string);

describe('queryRanges — 찾은 말이 글 안에서 어디인가', () => {
  it('대소문자를 접어 전부 찾고(서버는 ILIKE), 겹치지 않게 왼쪽부터 센다', () => {
    expect(queryRanges('Deploy 후 deploy, DEPLOY', 'deploy')).toEqual([
      [0, 6],
      [9, 15],
      [17, 23],
    ]);
    // 겹치는 자리는 한 번만 센다.
    expect(queryRanges('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });

  it('위치는 코드포인트다 — 앞에 이모지가 있어도 한 칸씩 밀리지 않는다', () => {
    // '😀'는 UTF-16 코드 단위로는 둘이다. `slice` 로 끊으면 강조가 한 칸 밀린다.
    expect(queryRanges('😀 배포 😀 배포', '배포')).toEqual([
      [2, 4],
      [7, 9],
    ]);
  });

  it('질의가 비었거나 글에 없으면 비어 있다 — 앞뒤 공백은 다듬는다', () => {
    expect(queryRanges('배포 일정', '')).toEqual([]);
    expect(queryRanges('배포 일정', '   ')).toEqual([]);
    expect(queryRanges('배포 일정', '롤백')).toEqual([]);
    expect(queryRanges('배포 일정', ' 일정 ')).toEqual([[3, 5]]);
  });
});

describe('searchMatchFor — 모든 테마·스킴의 내 말풍선과 남 말풍선에서 읽힌다', () => {
  const combos = Object.keys(THEMES).flatMap(theme =>
    (['light', 'dark'] as const).map(mode => [theme, mode] as const),
  );

  it.each(combos)('%s/%s — 칩은 말풍선과 갈려 보이고 글자는 4.5:1 을 지킨다', (theme, mode) => {
    const palette = paletteFrom(theme as never, mode);
    const tokens = bubbleFor(palette);
    for (const [name, tone, mine] of [
      ['내', tokens.mine, true],
      ['남', tokens.other, false],
    ] as const) {
      const {fill} = searchMatchFor(palette, tone, mine);
      // 칩을 못 세우는 팔레트는 없어야 한다 — 물러나는 길(굵게만)은 깨진 개인 색을 위한 것이다.
      expect([name, fill !== null]).toEqual([name, true]);
      expect(contrast(fill as string, tone.bg)).toBeGreaterThanOrEqual(1.12);
      expect(contrast(tone.fg, fill as string)).toBeGreaterThanOrEqual(BUBBLE_MIN_CONTRAST);
    }
  });

  it('대비를 지키는 칩이 없는 말풍선(깨진 개인 색)은 칩 없이 물러난다 — 대비가 먼저다', () => {
    // 글자와 채움이 거의 같은 색이면 어떤 칩도 4.5:1 을 못 지킨다.
    expect(searchMatchFor(darkPalette, {bg: '#808080', fg: '#818181'}, true).fill).toBeNull();
  });
});

describe.each([
  ['dark', darkPalette],
  ['light', lightPalette],
] as const)('%s — MessageBody 본문 안 강조', (scheme, palette) => {
  const otherTone = bubbleFor(palette).other;
  const mineTone = bubbleFor(palette).mine;

  it('찾은 글자만 굵게 칠해지고 나머지 글자는 그대로다 — 남 말풍선', () => {
    render(
      <FixedScheme scheme={scheme}>
        <MessageBody body="오늘 저녁 배포 끝나면 배포 결과 알려 주세요" bubble="other" searchMatch="배포" />
      </FixedScheme>,
    );
    expect(matches()).toEqual(['배포', '배포']);
    const style = StyleSheet.flatten(screen.getAllByTestId('message-search-match')[0].props.style);
    expect(style.fontWeight).toBe('700');
    expect(style.backgroundColor).toBe(searchMatchFor(palette, otherTone, false).fill);
    // 칠하는 조각이 글을 쪼개도 말풍선의 글자를 이어 읽으면 원문이다.
    expect(screen.getByTestId('message-bubble')).toHaveTextContent('오늘 저녁 배포 끝나면 배포 결과 알려 주세요');
  });

  it('내 말풍선(신호색)에서는 말풍선과 다른 채움이 선다', () => {
    render(
      <FixedScheme scheme={scheme}>
        <MessageBody body="배포 끝나면 알려 주세요" bubble="mine" searchMatch="배포" />
      </FixedScheme>,
    );
    const style = StyleSheet.flatten(screen.getByTestId('message-search-match').props.style);
    expect(style.backgroundColor).toBe(searchMatchFor(palette, mineTone, true).fill);
    expect(style.backgroundColor).not.toBe(mineTone.bg);
  });

  it('찾은 말을 안 주면 칠하지 않는다 — 평소 행은 그대로다', () => {
    render(
      <FixedScheme scheme={scheme}>
        <MessageBody body="배포 끝나면 알려 주세요" bubble="other" />
      </FixedScheme>,
    );
    expect(matches()).toEqual([]);
  });
});

describe('본문 글자에서만 칠한다', () => {
  const BODY = [
    '**배포** 전에 확인해요',
    '',
    '- 배포 목록 정리',
    '- 롤백 계획',
    '',
    '`배포` 명령은 이렇게',
    '',
    '```sh',
    'deploy --prod 배포',
    '```',
    '',
    '[배포 문서](https://momo.example/deploy)',
  ].join('\n');

  it('굵게·목록·링크 안의 글자는 칠하고, 인라인 코드·코드 블록은 칠하지 않는다', () => {
    render(
      <FixedScheme scheme="dark">
        <MessageBody body={BODY} bubble="other" searchMatch="배포" />
      </FixedScheme>,
    );
    // 굵게(1) + 목록 첫 항목(1) + 링크(1) = 3. 인라인 코드와 코드 블록의 「배포」는 코드 그대로다.
    expect(matches()).toEqual(['배포', '배포', '배포']);
    expect(within(screen.getByTestId('message-code-block')).queryByTestId('message-search-match')).toBeNull();
    expect(within(screen.getByTestId('message-inline-code')).queryByTestId('message-search-match')).toBeNull();
    expect(within(screen.getByTestId('message-link')).getAllByTestId('message-search-match')).toHaveLength(1);
  });

  it('인용 머리의 원문은 칠하지 않는다 — 본문 부분에만(#5381 머리가 말풍선 안에 있다)', () => {
    render(
      <FixedScheme scheme="dark">
        <MessageBody
          body="네 배포 끝났어요"
          bubble="other"
          searchMatch="배포"
          quoteHead={{
            block: {
              kind: 'ready',
              targetId: 'orig-1',
              targetSeq: 4,
              authorMemberId: OTHER,
              lines: ['오늘 저녁 배포 일정 확인'],
              truncated: false,
              quotesAnother: false,
              edited: false,
            },
            directory: DIRECTORY,
          }}
        />
      </FixedScheme>,
    );
    // 머리의 원문에도 「배포」가 있지만 칠해진 것은 본문의 하나뿐이다.
    expect(within(screen.getByTestId('quote-body')).queryByTestId('message-search-match')).toBeNull();
    expect(matches()).toEqual(['배포']);
  });
});

describe('이모티콘 표식은 잘리지 않는다', () => {
  const MARKER = '12';
  const EXPRESSION = {id: 'e1', name: 'party'} as unknown as Expression;

  it('표식 안의 숫자가 찾은 말과 같아도 표식은 그림 자리로 남고, 표식 밖의 같은 글자만 칠해진다', () => {
    render(
      <ExpressionTextContext.Provider value={new Map([[MARKER, EXPRESSION]])}>
        <SearchMatchContext.Provider value={{query: '12', style: {fontWeight: '700'}}}>
          <ExpressionText text={`a${MARKER} 12 b`} />
        </SearchMatchContext.Provider>
      </ExpressionTextContext.Provider>,
    );
    expect(screen.getAllByTestId('expression-image')).toHaveLength(1);
    expect(matches()).toEqual(['12']);
  });
});
