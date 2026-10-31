import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useState} from 'react';
import {ScrollView, Settings, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {usePalette} from '../src/design/theme';
import {MessageActionSheet} from '../src/features/conversation/MessageActionSheet';
import {MessageRow, PendingRow, rowPressedBackground} from '../src/features/conversation/MessageRow';
import {ROW_FACE} from '../src/features/conversation/rowFace';
import {setServerBase} from '../src/storage/serverBase';

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
//   landed   착지해 서 있는 행(`landed`) — 실제 `rowLanded`(경고색 10% 이하의 면, 테두리 없음 — #4949).
//   fade     착지가 풀리는 순간(`landed` true → false) 이후 덮개가 녹는 중. 풀리는 시각은 로그 없이
//            실행 3초 뒤이고, 240ms 동안 녹는다 — 캡처는 연속으로 찍는다.
//   row      줄 보기(`layout:'row'`, 예전 평면 행) — 같은 대화를 `FixedScheme bubble` 로 못 박아 찍는다(#4383).
//   arrive   보낸 글이 올라오는 등장(#4383) — 실행 1.5초 뒤 낙관적 메아리 하나가 마운트되고 180ms 동안
//            올라온다. 녹화(`simctl io recordVideo`)로 찍는다. `arrive-row` 는 줄 보기에서 같은 장면.
//   photo    글 없이 사진만 보낸 메시지(#4294): 사진 1장 · 사진 3장.
//            받는 쪽 행이 사진 아래에 「※ 내용 없는 메시지」를 같이 세우는가(수리 전) 세우지 않는가(수리 후).
//            첨부 바이트는 `measure/photo-stub.mjs` 가 답한다 — 서버 주소는 `-momoPhotoStub 127.0.0.1:<포트>`
//            (없으면 스텁의 기본 포트 18993). 포트를 인자로 받는 것은 같은 Mac 의 다른 캡처와 포트가 겹치지
//            않게 하려는 것이다.
//   photo-sheet  같은 대화 위에 「사진만 보낸 메시지」(둘째 행)의 액션 시트를 연 상태 — 시트 미리보기 한 줄.
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

// ---- 사진만 보낸 메시지 (#4294) ---------------------------------------------------------------
//
// 글이 비어 있고(`body: ''`) 첨부만 있다. 사진 바이트는 `photo-stub.mjs` 가 대신 답한다(단색 PNG,
// 사진 속 사람·글자 없음). 사진만 보낸 메시지는 **자기 머리(이름·시각)를 가진 별개의 메시지**로 세운다 —
// 앞 메시지에 묶이면 사진 아래의 한 줄이 어느 메시지의 것인지 사진만 봐서는 가려지지 않는다.
// 글도 첨부도 없는 행(대조: 예전 문장이 그대로 서야 한다)은 시험이 지키고, 이 표면에는 세우지 않는다.
const PHOTO_STUB_DEFAULT = 'http://127.0.0.1:18993';

function photoStubBase(): string {
  const value = Settings.get('momoPhotoStub');
  return typeof value === 'string' && value !== '' ? `http://${value}` : PHOTO_STUB_DEFAULT;
}

function attachment(id: string, name: string, mime = 'image/png') {
  return {id, name, mime, sizeBytes: 48_000};
}

const PHOTO_ENTRIES: Entry[] = [
  {m: msg(1, DOHYUN, '오픈 준비 사진 보내요'), head: true},
  {m: msg(2, DOHYUN, '', {attachments: [attachment('photo-a', '입구.png')]} as never), head: true},
  {m: msg(3, ME, '잘 나왔네요'), head: true},
  {
    m: msg(4, SEOYEON, '', {
      attachments: [attachment('photo-b', '내부1.png'), attachment('photo-c', '내부2.png'), attachment('photo-a', '내부3.png')],
    } as never),
    head: true,
  },
];

const SHEET_AVAILABILITY = {reply: true, quote: true, react: true, pin: true, edit: false, delete: false};

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
  const [sentOn, setSentOn] = useState(false);
  useEffect(() => {
    if (!which.startsWith('arrive')) return undefined;
    const t = setTimeout(() => setSentOn(true), 1500);
    return () => clearTimeout(t);
  }, [which]);
  const pressIdx = which === 'press' ? [2] : which === 'press-pair' ? [2, 3] : [];
  const landIdx = which === 'landed' || which === 'fade' ? 2 : -1;
  const photo = which === 'photo' || which === 'photo-sheet';
  // 첫 렌더 전에 한 번: 사진 타일은 마운트 직후 내려받기를 시작한다. 주소는 MMKV 에 남으므로 내려갈 때 지운다.
  useState(() => {
    if (photo) setServerBase(photoStubBase());
    return null;
  });
  useEffect(
    () => () => {
      if (photo) setServerBase(null);
    },
    [photo],
  );
  const entries = photo ? PHOTO_ENTRIES : which.startsWith('arrive') ? ENTRIES.slice(-3) : ENTRIES;
  return (
    <Screen>
      <ScrollView>
        {entries.map((e, i) => {
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
        {sentOn ? (
          <PendingRow
            pending={
              {
                clientMsgId: 'c-4383-arrive', channelId: 'ch', authorMemberId: ME,
                body: '방금 보낸 글이에요. 입력창에서 올라와 자리에 앉아요.',
                createdAtMs: NOW, sinceSeq: 7, status: 'sending',
              } as never
            }
            startsGroup
            directory={DIRECTORY}
          />
        ) : null}
      </ScrollView>
      {which === 'photo-sheet' ? (
        <MessageActionSheet
          message={PHOTO_ENTRIES[1].m}
          chips={[]}
          availability={SHEET_AVAILABILITY}
          authorLabel="이도현"
          onClose={() => {}}
          onToggleReaction={() => {}}
          onReply={() => {}}
          onQuote={() => {}}
          onCopy={() => {}}
          onPin={() => {}}
          onEdit={() => {}}
          onDelete={() => {}}
        />
      ) : null}
    </Screen>
  );
}

