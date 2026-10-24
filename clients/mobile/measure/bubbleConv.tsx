import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useState} from 'react';
import {ScrollView, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {usePalette} from '../src/design/theme';
import {MessageRow, rowPressedBackground} from '../src/features/conversation/MessageRow';
import {ROW_FACE} from '../src/features/conversation/rowFace';

// =============================================================================
// 말풍선 대화 + 눌림·착지 강조 면 캡처 표면 (#4300). 실제 `MessageRow` 를 세운다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure BUBBLE-<WHICH>
//   (라이트: LIGHT-BUBBLE-<WHICH>)
//
//   mix      짧은 글·긴 글·코드 섞인 글·묶음 연속·내 글·반응·인용·답글 N개
//   press    둘째 행이 눌린 면을 입는다(시뮬레이터는 손가락을 댄 채 있을 수 없다). 눌린 면은
//            **같은 심볼**(`rowPressedBackground`)과 `ROW_FACE` 로 깐다 — 색·상자를 베껴 적지 않는다.
//   press-pair  이웃한 두 행이 동시에 눌린 면을 입는다(이웃 면이 맞붙는지 보는 최악 장면).
//   landed   착지해 서 있는 행(`landed`) — 실제 `rowLanded` + 테두리.
//   fade     착지가 풀리는 순간(`landed` true → false) 이후 덮개가 녹는 중. 풀리는 시각은 로그 없이
//            실행 3초 뒤이고, 240ms 동안 녹는다 — 캡처는 연속으로 찍는다.
//
// 이름·문구는 가상이다(달무리 스튜디오).
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000043c0';
const ME = '00000000-0000-7000-8000-0000000043c1';
const DOHYUN = '00000000-0000-7000-8000-0000000043c2';
const SEOYEON = '00000000-0000-7000-8000-0000000043c3';
const AGENT = '00000000-0000-7000-8000-0000000043c4';
const NOW = Date.now();

function member(id: string, kind: 'human' | 'agent', name: string): RosterMember {
  return {
    id, workspaceId: WS, kind, status: 'active', displayName: name, handle: name,
    channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([
  member(ME, 'human', '나'),
  member(DOHYUN, 'human', '이도현'),
  member(SEOYEON, 'human', '박서연'),
  member(AGENT, 'agent', '코메토'),
]);

function msg(seq: number, author: string, body: string, extra: Partial<Message> = {}): Message {
  return {
    id: `00000000-0000-7000-8000-00000000f${String(seq).padStart(3, '0')}`,
    channelId: 'ch', seq, hlcTs: seq, hlcCount: 0, authorMemberId: author, type: 'text',
    body, state: 'sent', createdAtMs: NOW - (30 - seq) * 60_000, ...extra,
  } as Message;
}

const CODE = '배포 스크립트는 이렇게 돌려요.\n\n```bash\n./deploy.sh --env staging --dry-run\n```\n\n끝나면 알려 주세요.';
const LONG =
  '이번 주 일정은 월요일에 디자인 리뷰, 수요일에 배포 리허설, 금요일에 회고예요. 리허설 전에 체크리스트를 한 번 더 돌려 보고, 막히는 곳이 있으면 스레드에 남겨 주세요.';

// [message, startsGroup, extras]
type Entry = {m: Message; head: boolean; chips?: {emoji: string; count: number; mine: boolean}[]; rollup?: {replyCount: number; lastReplySeq: number; lastReplyAtMs: number}; quote?: unknown};
const ENTRIES: Entry[] = [
  {m: msg(1, DOHYUN, '네네'), head: true},
  {m: msg(2, DOHYUN, LONG), head: false},
  {m: msg(3, ME, '확인했어요'), head: true, chips: [{emoji: '👍', count: 3, mine: true}, {emoji: '🎉', count: 1, mine: false}]},
  {m: msg(4, ME, '리허설은 수요일 오후로 잡을게요.'), head: false},
  {m: msg(5, AGENT, CODE), head: true},
  {
    m: msg(6, SEOYEON, '로그는 스레드에 정리했어요', {replyCount: 4} as never),
    head: true,
    rollup: {replyCount: 4, lastReplySeq: 9, lastReplyAtMs: NOW - 120_000},
  },
  {
    m: msg(7, ME, '좋아요, 그대로 가요'),
    head: true,
    quote: {kind: 'ready', targetId: msg(6, SEOYEON, '').id, targetSeq: 6, authorMemberId: SEOYEON, lines: ['로그는 스레드에 정리했어요'], truncated: false},
  },
];

function Press({children}: {children: React.ReactNode}) {
  const color = usePalette();
  return (
    <View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute', top: 0, bottom: 0, left: ROW_FACE.outer, right: ROW_FACE.outer,
          borderRadius: ROW_FACE.radius, backgroundColor: rowPressedBackground(color),
        }}
      />
      {children}
    </View>
  );
}

export function BubbleSurface({which}: {which: string}): React.JSX.Element {
  const [landedOn, setLandedOn] = useState(which === 'landed' || which === 'fade');
  useEffect(() => {
    if (which !== 'fade') return undefined;
    const t = setTimeout(() => setLandedOn(false), 3000);
    return () => clearTimeout(t);
  }, [which]);
  const pressIdx = which === 'press' ? [2] : which === 'press-pair' ? [2, 3] : [];
  const landIdx = which === 'landed' || which === 'fade' ? 2 : -1;
  return (
    <Screen>
      <ScrollView>
        {ENTRIES.map((e, i) => {
          const row = (
            <MessageRow
              key={e.m.id}
              message={e.m}
              startsGroup={e.head}
              directory={DIRECTORY}
              chips={e.chips ?? []}
              rollup={e.rollup as never}
              quote={e.quote as never}
              landed={i === landIdx ? landedOn : false}
              nowMs={NOW}
              actions={{
                myMemberId: ME,
                onToggleReaction: async () => {},
                onOpenThread: () => {},
              } as never}
            />
          );
          return pressIdx.includes(i) ? <Press key={e.m.id}>{row}</Press> : row;
        })}
      </ScrollView>
    </Screen>
  );
}

