import {contrast} from '@momo/core/design/color';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import {FixedScheme} from '../src/design/theme';
import {darkPalette, lightPalette, type Palette} from '../src/design/tokens';
import {ReplyHomeLine} from '../src/features/conversation/ReplyHomeLine';
import {flat, member, message, OTHER_ID, SELF_ID} from './testkit';

// =============================================================================
// 「↳ ○○님 스레드에 답글」 줄 — 원문 발췌 글자 대비 (#5294, 화면 검수 5a H1).
//
// 대화에 선 답글의 둘째 줄(원문 발췌)은 이 답글이 **어느 글의 스레드인지** 알려 주는 내용이라 뜻을 나르는 글자다. 첫 판은 `textFaint`
// (밝음 3.76:1 · 어두움 3.89:1, 본문 AA 4.5 미달)로 그렸다. 웹 짝은 두 줄 모두 `ink-muted` 다. 그려진 트리에서 글자색을 읽어 줄이 서는 두
// 바탕(`bg` · `surface`) 위에서 잰다 — 토큰 이름을 단정하면 토큰 값이 바뀌어도 초록이라 값으로 재야 한다.
// =============================================================================

const DIRECTORY = makeDirectory([
  member({id: SELF_ID, displayName: '이서준', handle: 'seojun'}),
  member({id: OTHER_ID, displayName: '김인턴', handle: 'intern-kim'}),
]);
const ROOT = message(10, {id: 'root-1', body: '그건 배포 뒤에 봅시다', authorMemberId: OTHER_ID});

const MIN = 4.5;

afterEach(cleanup);

describe.each([
  ['light', lightPalette],
  ['dark', darkPalette],
] as ReadonlyArray<readonly ['light' | 'dark', Palette]>)('답글 줄 원문 발췌 글자 대비 — %s (#5294)', (scheme, palette) => {
  it.each([
    ['누를 수 있는 줄(스레드를 열 곳이 있다)', true],
    ['문장인 줄(루트가 불러온 범위 위에 있어 열 곳이 없다)', false],
  ])('%s: 발췌가 줄이 서는 두 바탕 위에서 4.5:1 이상이다', (_label, pressable) => {
    render(
      <FixedScheme scheme={scheme}>
        <ReplyHomeLine
          rootId="root-1"
          root={ROOT}
          directory={DIRECTORY}
          myMemberId={SELF_ID}
          {...(pressable ? {onOpen: () => {}} : {})}
        />
      </FixedScheme>,
    );
    const excerpt = flat(screen.getByTestId('reply-marker-excerpt').props.style);
    expect(typeof excerpt.color).toBe('string');
    // 줄이 서는 바탕은 둘이다(대화 바닥 `bg`, 카드·눌림 면 `surface`) — 어느 쪽에서도 읽혀야 한다.
    for (const backdrop of [palette.bg, palette.surface]) {
      expect(contrast(String(excerpt.color), backdrop)).toBeGreaterThanOrEqual(MIN);
    }
    // 깨뜨리면: ReplyHomeLine 의 excerpt 색을 `textFaint` 로 되돌리면 → 밝음 3.24/3.76 · 어두움 3.89 로 빨갛다.
  });
});
