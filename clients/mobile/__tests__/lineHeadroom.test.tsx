import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import React from 'react';
import {PixelRatio, StyleSheet, Text, View} from 'react-native';

import {NoticeBlock, Sentence} from '../src/design/atoms';
import {headroomLineHeight, LINE_HEADROOM, withLineHeadroom} from '../src/design/lineHeadroom';
import {font, line} from '../src/design/tokens';
import {MessageBody} from '../src/features/conversation/MessageBody';
import {cleanup, render, screen} from './fixtures/darkWorld';
import {sweepHangulWord, sweepLineHeadroom} from './fixtures/hangulWord';

// =============================================================================
// 여러 줄 글의 줄 높이 여유 (#5288, #4894).
//
// 두 줄로 접힌 글이 첫 줄만 그려지고 오른쪽에서 잘리던 결함의 원인은 줄바꿈 전략이 아니라 **글 상자 높이가 float 반올림으로 줄 수의 요구보다
// 1e-4pt 낮게 내려오는 것**이다(`src/design/lineHeadroom.ts` 머리말, 시뮬레이터 실측은 `measure/sentenceWrap.tsx`). jest 에는 Yoga 도
// TextKit 도 없어 그 깎임 자체는 못 낸다 — 이 파일이 지키는 것은 **「고친 부품이 줄 높이를 화소 격자의 정수배에 두지 않는다」** 와 그 여유 값이
// 실측이 정한 두 한계 안에 있다는 것이다. 실제로 안 잘리는지는 하네스(`sentence-wrap`, `bubble-clip`)가 시뮬레이터에서 잰다.
//
// 훑기(`sweepLineHeadroom`)는 렌더 트리의 모든 글자 노드를 세므로 영어도 한국어도 같다. 한글 유무와 상관없는 결함이라서다.
// =============================================================================

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

const EN = 'An approval alert is one question, and a one-line receipt stays after you decide.';
const KO = '승인 알림은 질문 한 문장으로 오고, 결정한 뒤에는 한 줄 영수증이 남아요.';

function member(id: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind: 'agent',
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
const INTERN = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const DIRECTORY = makeDirectory([member(SELF, 'lane-tester'), member(INTERN, 'kim-intern')]);

describe('줄 높이 여유 — 함수', () => {
  it('화소 격자의 정수배인 줄 높이만 0.01pt 낮추고, 소수 줄 높이·줄 높이 없음은 그대로 둔다', () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
    expect(headroomLineHeight(23)).toBeCloseTo(22.99, 6);
    expect(headroomLineHeight(18)).toBeCloseTo(17.99, 6);
    expect(headroomLineHeight(17.3)).toBe(17.3); // 3x 에서 51.9 화소 — 올림이 이미 여유를 낸다
    expect(headroomLineHeight(23.3333)).toBe(23.3333);

    const plain = {fontSize: 16, color: '#fff'};
    expect(withLineHeadroom(plain)).toBe(plain); // 줄 높이가 없으면 같은 객체
    expect(withLineHeadroom(undefined)).toBeUndefined();
    const fractional = {fontSize: 16, lineHeight: 17.3};
    expect(withLineHeadroom(fractional)).toBe(fractional);
    // 깨뜨리면(함수가 늘 새 스타일을 낸다 / 늘 같은 스타일을 낸다) → 위 단정이 빨개진다.
  });

  it('덮어쓰는 것은 줄 높이 하나뿐이다 — 배열·거짓 값이 섞인 스타일도 같다', () => {
    jest.spyOn(PixelRatio, 'get').mockReturnValue(3);
    const base = {fontSize: font.body, color: '#123456', lineHeight: line.body};
    const out = StyleSheet.flatten(withLineHeadroom([base, false, {fontWeight: '600'}, undefined]));
    expect(out).toEqual({fontSize: font.body, color: '#123456', fontWeight: '600', lineHeight: line.body - LINE_HEADROOM});
  });

  it('여유 값은 두 한계 안에 있다 — 아래는 실측 깎임, 위는 「글 상자 높이가 그대로」다', () => {
    // 아래 한계: 깎임은 float32 한 칸이다. 절대 y 13만 pt 아래에서 칸이 2^-7 = 7.8e-3pt 이하이므로, 여유가 그보다 커야 한다.
    expect(LINE_HEADROOM).toBeGreaterThan(2 ** -7);
    // 위 한계: 글 상자 높이 = ceil(줄 수 × 줄 높이 × 배율) / 배율 (`RCTTextLayoutManager`). 여유를 뺀 높이가 같은 정수배로 올림되어야
    // 레이아웃이 안 움직인다. 줄 수 1~30, 배율 2x·3x 에서 확인한다(여유 0.01 이면 3x 에서 33줄, 2x 에서 49줄까지 같다).
    for (const scale of [2, 3]) {
      for (const lineHeight of [line.body, line.label, 16, 18]) {
        for (let lines = 1; lines <= 30; lines += 1) {
          const before = Math.ceil(lines * lineHeight * scale - 1e-9) / scale;
          const after = Math.ceil(lines * (lineHeight - LINE_HEADROOM) * scale - 1e-9) / scale;
          expect([scale, lineHeight, lines, after]).toEqual([scale, lineHeight, lines, before]);
        }
      }
    }
    // 깨뜨리면(LINE_HEADROOM 을 0.001 로 → 아래 한계, 0.2 로 → 위 한계) 각각 빨개진다.
  });
});

describe('줄 높이 여유 — 렌더 트리 훑기 (영어·한국어 문장)', () => {
  it('`Sentence` 는 영어도 한국어도 줄 높이에 여유가 있다 — 배열 스타일·중첩 글자·줄 수 제한까지', () => {
    const base = {fontSize: font.body, lineHeight: line.body};
    render(
      <View testID="root">
        <Sentence style={base} testID="en">{EN}</Sentence>
        <Sentence style={base} testID="ko">{KO}</Sentence>
        <Sentence style={[base, {color: '#222'}]} testID="mix">
          {'승인 alert 는 '}
          <Text style={{fontWeight: '700'}}>one-line</Text>
          {' 영수증을 남겨요.'}
        </Sentence>
        <Sentence style={base} numberOfLines={2} testID="clamped">{EN}</Sentence>
        <Sentence style={{fontSize: font.label, lineHeight: line.label}} testID="label">{'Settings'}</Sentence>
      </View>,
    );
    const swept = sweepLineHeadroom(screen.getByTestId('root'));
    expect(swept.checked).toBeGreaterThanOrEqual(5); // 다섯 글자 노드 모두 줄 높이를 가졌고 다 셌다(중첩 글자는 바깥에 든다)
    expect(swept.exposed).toEqual([]);
    // 한국어 어절 줄바꿈은 그대로다 — 줄 높이 여유가 줄바꿈 전략을 건드리지 않는다.
    const hangul = sweepHangulWord(screen.getByTestId('root'));
    expect(hangul.checked).toBeGreaterThanOrEqual(2);
    expect(hangul.missing).toEqual([]);
    expect(screen.getByTestId('ko').props.lineBreakStrategyIOS).toBe('hangul-word');
    // 깨뜨리면: `Sentence` 가 style 을 그냥 넘긴다(withLineHeadroom 제거) → exposed 에 다섯 글자가 모두 든다(수리 전의 모습).
  });

  it('`NoticeBlock` 의 제목·설명도 같다 — 줄 높이가 있는 글자(설명)는 여유가 있다', () => {
    render(
      <View testID="root">
        <NoticeBlock headline="This server does not do that yet" detail={EN} />
        <NoticeBlock headline="이 서버는 아직 그걸 하지 않습니다" detail={KO} />
      </View>,
    );
    const swept = sweepLineHeadroom(screen.getByTestId('root'));
    expect(swept.checked).toBeGreaterThanOrEqual(2); // 설명 둘(제목은 자연 줄 높이라 줄 높이 값이 없다)
    expect(swept.exposed).toEqual([]);
    expect(sweepHangulWord(screen.getByTestId('root')).missing).toEqual([]);
    // 깨뜨리면: NoticeBlock 의 두 글자에서 withLineHeadroom 을 뺀다 → exposed 에 설명 둘이 든다.
  });

  it('훑기는 빈 훑기가 아니다 — 여유 없는 글자를 실제로 센다(대조)', () => {
    render(
      <View testID="root">
        <Text style={{fontSize: font.body, lineHeight: line.body}}>{EN}</Text>
        <Text style={{fontSize: font.body}}>{'no explicit line height'}</Text>
      </View>,
    );
    const swept = sweepLineHeadroom(screen.getByTestId('root'));
    expect(swept.checked).toBe(1);
    expect(swept.exposed).toEqual([`${EN.slice(0, 40)} (${line.body})`]);
  });
});

describe('줄 높이 여유 — 렌더 트리 훑기 (말풍선)', () => {
  const bubbles: [string, string, 'mine' | 'other' | null][] = [
    ['영어 + 멘션 (5a 의 글)', '@kim-intern MAESTRO TEXT MAESTRO SLOW phone lane stop check', 'mine'],
    ['한국어 문단', '오늘 오후 세 시에 디자인 리뷰가 있어요. 자료는 공유 폴더에 올려 두었으니 미리 한번 훑어보세요.', 'other'],
    ['영어 문단 + 목록', 'Here is the plan:\n\n- review on Monday afternoon\n- rehearsal on Wednesday morning\n\n1. first\n2. second', 'other'],
    ['평문 영어(마크업 없음)', EN, 'mine'],
    ['줄 보기(말풍선 없음)', EN, null],
    ['코드 블록', '```\nline one\nline two\n```', 'other'],
  ];
  it.each(bubbles)('말풍선 글은 줄 높이에 여유가 있다 — %s', (_name, body, bubble) => {
    render(
      <View testID="root">
        <MessageBody body={body} bubble={bubble} directory={DIRECTORY} selfMemberId={SELF} />
      </View>,
    );
    const swept = sweepLineHeadroom(screen.getByTestId('root'));
    expect(swept.checked).toBeGreaterThanOrEqual(1);
    expect(swept.exposed).toEqual([]);
    // 깨뜨리면: MessageBody 의 `paragraph`·`listText`·`listMarker`·`code` 줄 높이를 `line.body`/`line.code` 로 되돌린다 → 해당 글자가 exposed 에 든다.
  });
});
