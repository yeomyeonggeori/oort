import type {RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {Composer} from '../src/features/conversation/Composer';

// =============================================================================
// 한글이 깨지지 않음을, 측정으로.
//
// Spike #837 gate 1 typed `안녕하세요` by hand on 성재's iPhone 17 (iOS 26.5.1)
// with both Korean layouts, through five composer shapes. Four produced the
// word. The fifth — identical except that it applied the value one tick late
// (`setTimeout(() => setValue(next), 0)`) — produced
// `ㅇㅏㄴㄴㅕㅇㅎㅏㅅㅔㅇㅛ` on the standard layout and `ㅇ|·ㄴㄴ··|ㅇㅎ|·ㅅ·` on
// the 10-key. The jamo never combined at all.
//
// A device is not available in CI, and a simulator cannot answer this question
// either (it takes input from the Mac's hardware keyboard and never enters the
// iOS composition path). So what is reproduced here is not the IME — it is the
// **property the IME needs from us**, which is the half that can regress:
//
//   the value React renders after keystroke N is exactly the value keystroke N
//   produced, in the same tick, with nothing in between.
//
// The transitions below are not invented. Every one of them was captured on the
// device and is pinned in `clients/mobile-spike/__tests__/gate1_composition.test.ts`;
// the notable ones are the 받침 이동 rows (`안녕핫` + ㅔ → `안녕하세`, where one
// keystroke legitimately produces two syllables) and the 10-key rows where the
// composing tail widens to two characters and folds back.
//
// 주 판정은 `finalMatches` — the final string equals the target. The invariant
// count is the auxiliary signal, and the spike proved why it can only ever be
// auxiliary: the broken async case had ZERO violations, because a value that
// never combines never takes anything back.
// =============================================================================

/** 표준(쿼티) — 12 keystrokes, as measured. */
const STANDARD: string[] = [
  'ㅇ',
  '아',
  '안',
  '안ㄴ',
  '안녀',
  '안녕',
  '안녕ㅎ',
  '안녕하',
  '안녕핫', // ㅅ lands as a 받침
  '안녕하세', // ㅔ moves it to the next syllable's 초성 — one key, two syllables
  '안녕하셍',
  '안녕하세요',
];

/** 10키(천지인) — the composing tail widens to two characters and folds back. */
const TEN_KEY: string[] = [
  'ㅇ',
  '아',
  '안',
  '안ㄴ',
  '안녀',
  '안녕',
  '안녕ㅎ',
  '안녕하',
  '안녕핫',
  '안녕하ㅅ·', // tail is TWO characters here
  '안녕하서',
  '안녕하세',
  '안녕하셍',
  '안녕하세ㅇ·',
  '안녕하세요',
];

const TARGET = '안녕하세요';

function commonPrefixLength(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i;
}

/**
 * The corrected invariant from the spike: only characters BEHIND the composing
 * tail disappearing counts as breakage. The tail is at most two characters (the
 * 10-key rows above prove it), and a keystroke ADDING two syllables is normal
 * Korean (받침 이동), so `added` is not counted at all.
 */
function suspicious(from: string, to: string): boolean {
  const common = commonPrefixLength(from, to);
  return from.length - common > 2;
}

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

/** 60 members: gate 1 case C's load, which re-filters on every keystroke. */
const CROWD = makeDirectory(
  Array.from({length: 60}, (_, i) =>
    member({
      id: `member-${i}`,
      displayName: `동료${i}`,
      handle: `mate${i}`,
    }),
  ),
);

const EMPTY = makeDirectory([]);

afterEach(cleanup);

/**
 * Type `sequence` into the composer, asserting after EVERY keystroke that the
 * rendered value is already the one that keystroke produced.
 *
 * This is the whole test. `fireEvent.changeText` flushes React synchronously,
 * so if the component put a timer, a queue, a store or a request between the
 * event and the value, the assertion on the NEXT line sees the previous string
 * and fails. That is precisely the shape that broke on the device.
 */
function typeAndTrack(sequence: string[]): {
  final: string;
  violations: number;
} {
  const input = screen.getByTestId('composer-input');
  let previous = '';
  let violations = 0;
  for (const value of sequence) {
    fireEvent.changeText(input, value);
    // Synchronous: no waitFor, no act flush, no await.
    expect(screen.getByTestId('composer-input').props.value).toBe(value);
    if (suspicious(previous, value)) violations += 1;
    previous = value;
  }
  return {final: previous, violations};
}

describe('컴포저 value 는 동기다 (스파이크 게이트 1 실측 재현)', () => {
  it('표준 키보드 조합이 최종값과 정확히 일치한다', () => {
    render(
      <Composer channelLabel="general" directory={EMPTY} onSend={() => {}} />,
    );
    const result = typeAndTrack(STANDARD);
    // 주 판정.
    expect(result.final).toBe(TARGET);
    // 보조 신호.
    expect(result.violations).toBe(0);
  });

  it('10키 다글자 조합 꼬리도 최종값과 일치한다', () => {
    render(
      <Composer channelLabel="general" directory={EMPTY} onSend={() => {}} />,
    );
    const result = typeAndTrack(TEN_KEY);
    expect(result.final).toBe(TARGET);
    expect(result.violations).toBe(0);
  });

  it('조합 중 멘션 후보 60건이 매 타 리렌더돼도 깨지지 않는다 (케이스 C)', () => {
    // The device measured this exact load passing, and it passed *because* the
    // value was synchronous. The list is opened with an `@` first so the
    // candidate filter really does run on every following keystroke.
    render(
      <Composer channelLabel="general" directory={CROWD} onSend={() => {}} />,
    );
    const input = screen.getByTestId('composer-input');
    fireEvent.changeText(input, '@');
    expect(screen.getByTestId('mention-list')).toBeTruthy();

    // Now type the word after the mention token, with the list live.
    let previous = '@';
    let violations = 0;
    for (const value of STANDARD.map(v => `@mate1 ${v}`)) {
      fireEvent.changeText(input, value);
      expect(screen.getByTestId('composer-input').props.value).toBe(value);
      if (suspicious(previous, value)) violations += 1;
      previous = value;
    }
    expect(previous).toBe(`@mate1 ${TARGET}`);
    expect(violations).toBe(0);
  });

  it('조합이 백스페이스로 풀려도 앞이 되돌아가지 않는다', () => {
    render(
      <Composer channelLabel="general" directory={EMPTY} onSend={() => {}} />,
    );
    const result = typeAndTrack(['한', '하', 'ㅎ', '']);
    expect(result.final).toBe('');
    expect(result.violations).toBe(0);
  });
});

describe('보내기', () => {
  it('보낸 뒤 입력창을 즉시 비운다', () => {
    const sent: string[] = [];
    render(
      <Composer
        channelLabel="general"
        directory={EMPTY}
        onSend={body => sent.push(body)}
      />,
    );
    typeAndTrack(STANDARD);
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(sent).toEqual([TARGET]);
    // The echo row carries the message from here; a composer that stayed full
    // while its message was visible below would read as if nothing happened.
    expect(screen.getByTestId('composer-input').props.value).toBe('');
  });

  it('공백만 있는 입력은 보내지 않는다', () => {
    const sent: string[] = [];
    render(
      <Composer
        channelLabel="general"
        directory={EMPTY}
        onSend={body => sent.push(body)}
      />,
    );
    fireEvent.changeText(screen.getByTestId('composer-input'), '   ');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(sent).toEqual([]);
  });

  it('멘션을 고르면 핸들이 동기로 들어간다', () => {
    render(
      <Composer channelLabel="general" directory={CROWD} onSend={() => {}} />,
    );
    const input = screen.getByTestId('composer-input');
    fireEvent.changeText(input, '@mate1');
    fireEvent.press(screen.getAllByTestId('mention-option')[0]);
    // Handle, never display name: the server routes on `@handle`, and a display
    // name with a space in it would look right and call nobody.
    expect(screen.getByTestId('composer-input').props.value).toBe('@mate1 ');
  });
});
