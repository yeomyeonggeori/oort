import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useRef, useState} from 'react';
import {TextInput} from 'react-native';
import {Screen} from '../src/design/atoms';
import {THREAD_COMPOSER_PLACEHOLDER} from '@momo/core/features/chat/composerCopy';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {clearDraft, saveDraft} from '../src/features/conversation/drafts';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// DM 대화 화면 캡처 표면 (#4016). 실제 컴포넌트(머리·레이아웃·타임라인·컴포저)를 대화 화면과 같은
// 순서로 세운다. 서버·레일만 없다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure DM-CONVERSATION-<WHICH>
//   (라이트: LIGHT-DM-CONVERSATION-<WHICH>)
//
//   down        키보드 내려감 — 홈 인디케이터 safe-area 를 지키는지
//   up          키보드 올림(입력창에 포커스) — 컴포저가 키보드 바로 위에 붙는지
//   up-recovery up 에 「재연결됨」 구분선이 서 있는 상태(걷히는 규칙은 jest 가 잰다)
//
// #4179 알약 상태 — 키보드는 내려간 채, 입력창에 **초안**을 심는다(앱이 실제로 쓰는 경로):
//   typed   한 줄 글
//   multi   여러 줄 글 — 알약이 자라도 두 원이 아래 모서리와 동심인가
//   thread  스레드 답글 입력(ThreadPanel 이 `Composer` 에 주는 그 props) — 같은 알약이 같은 자인가
//   (그 밖의 이름은 빈 상태다. 초안은 MMKV 라 실행을 넘어 남으므로 매번 지우거나 덮어쓴다.)
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000c0';
const SELF = '00000000-0000-7000-8000-0000000000c1';
const GROK = '00000000-0000-7000-8000-0000000000c2';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: 'lee', handle: 'lee'}),
  member({id: GROK, kind: 'agent', displayName: 'grok', handle: 'grok'}),
]);

const NOW = Date.now();

const DRAFT_KEY = 'measure:dm-conversation';
/** #4179 — 상태 이름 → 심는 초안. 이름이 없으면 빈 상태다. */
const PILL_DRAFTS: Readonly<Record<string, string>> = {
  typed: '오늘 배포 끝나면 알려줘',
  multi: '배포 순서 정리했어요.\n1) 서버를 먼저 올리고\n2) 앱은 그다음에 올려요\n3) 끝나면 여기에 남길게요',
  thread: '확인했어요, 내일 오전에 볼게요',
};
// 대화 화면과 같다: 머리 띠가 안전 영역 윗부분을 직접 덮는다(`ConversationScreen` 의 `screen.paddingTop: 0`).
const NO_TOP = {paddingTop: 0} as const;

function message(seq: number, author: string, body: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000000d${String(seq).padStart(3, '0')}`,
    channelId: 'dm',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - (10 - seq) * 60_000,
  } as Message;
}

const MESSAGES = [
  message(1, SELF, 'ㅎㅇ'),
  message(2, GROK, '안녕하세요, lee님! 필요한 일 있으면 편하게 말씀해 주세요.'),
  message(3, SELF, '반가워요'),
];

export function DmConversationSurface({which}: {which: string}): React.JSX.Element {
  const inputRef = useRef<TextInput | null>(null);
  const keyboard = which.startsWith('up');
  // 첫 렌더 전에 한 번: `Composer` 는 첫 렌더가 이미 초안을 들고 있다. MMKV 는 앞 실행의 글을
  // 기억하므로 빈 상태도 지워서 심는다 — 지우지 않으면 빈 상태 사진에 지난 글이 비친다.
  useState(() => {
    const draft = PILL_DRAFTS[which];
    if (draft === undefined) clearDraft(DRAFT_KEY);
    else saveDraft(DRAFT_KEY, draft);
    return null;
  });
  const thread = which === 'thread';
  useEffect(() => {
    if (!keyboard) return undefined;
    const timer = setTimeout(() => inputRef.current?.focus(), 1500);
    return () => clearTimeout(timer);
  }, [keyboard]);
  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="grok"
        kind="dm"
        peerId={GROK}
        peerStatusTone="ok"
        directory={DIRECTORY}
        onBack={() => {}}
        menu={[{label: '고정', run: () => {}}]}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <Timeline
            messages={MESSAGES}
            directory={DIRECTORY}
            status="ready"
            channelKind="dm"
            myMemberId={SELF}
            nowMs={NOW}
            recoveryMarkers={
              which === 'up-recovery' ? [{id: 'r1', seq: 3, source: 'replay'}] : undefined
            }
          />
        }
        composer={
          <Composer
            recipient={thread ? 'place' : 'person'}
            channelLabel={thread ? '스레드' : 'grok'}
            directory={DIRECTORY}
            draftKey={DRAFT_KEY}
            // + 원이 서려면 첨부 대상이 있어야 한다(`Composer` 는 대상이 없으면 + 를 그리지 않는다).
            // 서버 없이도 서는 값이다 — 보낼 때까지 로컬 초안 저장소만 쓴다.
            attachmentTarget={
              thread
                ? {workspaceId: WS, channelId: 'dm', rootId: 'root'}
                : {workspaceId: WS, channelId: 'dm'}
            }
            inputRef={inputRef}
            // 스레드 답글 입력: `ThreadPanel` 이 같은 컴포넌트에 주는 문구(별도 스타일 없음).
            {...(thread
              ? {placeholder: THREAD_COMPOSER_PLACEHOLDER, sendLabel: '답글 보내기'}
              : {})}
            onSend={() => {}}
          />
        }
      />
    </Screen>
  );
}
