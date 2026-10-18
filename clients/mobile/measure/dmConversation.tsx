import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect, useRef} from 'react';
import {TextInput} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
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
  member({id: SELF, displayName: 'kwak', handle: 'kwak'}),
  member({id: GROK, kind: 'agent', displayName: 'grok', handle: 'grok'}),
]);

const NOW = Date.now();
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
  message(2, GROK, '안녕하세요, kwak님! 필요한 일 있으면 편하게 말씀해 주세요.'),
  message(3, SELF, '반가워요'),
];

export function DmConversationSurface({which}: {which: string}): React.JSX.Element {
  const inputRef = useRef<TextInput | null>(null);
  const keyboard = which.startsWith('up');
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
            recipient="person"
            channelLabel="grok"
            directory={DIRECTORY}
            draftKey="measure:dm-conversation"
            inputRef={inputRef}
            onSend={() => {}}
          />
        }
      />
    </Screen>
  );
}
