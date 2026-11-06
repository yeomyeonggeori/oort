import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {ReactionMap} from '@momo/core/features/timeline/reactions';
import React, {useRef, useState} from 'react';
import {TextInput, View} from 'react-native';
import {Screen} from '../src/design/atoms';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {CONV} from '../src/features/conversation/convDesign';
import {Timeline} from '../src/features/conversation/Timeline';
import type {MessageRowActions} from '../src/features/conversation/MessageRow';

// =============================================================================
// 길게 눌러 「고치기」 -> 편집 시트 -> 저장 -> 「수정됨」 (#5417) - Maestro `5417-edit-from-sheet-live` 의 표면.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure EDIT-LIVE -RCT_jsLocation 127.0.0.1:<metro>
//   maestro --udid <udid> test clients/mobile/maestro/5417-edit-from-sheet-live.yaml
//
// 시트가 닫히는 중에 다른 시트를 띄우면 iOS 가 제시를 거절하는 결함(#5417)은 서버와 무관하다 - 대화 화면이 세우는 그대로(머리 · 타임라인 · 컴포저 · 행 동작
// `actions`)에 **저장이 실제로 글을 바꾸는** 행 동작만 얹는다: `onEdit` 이 그 글의 본문을 바꾸고 `state: 'edited'` 와 고친 시각을 단다(서버가 하는 일의 모형).
// 시트를 따로 그리지 않는다 - 길게 누르기도, 「고치기」 누르기도, 편집 시트가 서는 것도 앱의 실제 길이다. 전부 지어낸 인물·문구다.
//
// 내 글(`TARGET_BODY`)을 길게 누르면 시트 맨 위 줄이 「고치기」다. 남의 글(이도현)은 그 줄이 없다.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000e0';
const SELF = '00000000-0000-7000-8000-0000000000e1';
const PEER = '00000000-0000-7000-8000-0000000000e2';
const CHANNEL = 'edit-live-capture';
const DRAFT_KEY = 'measure:edit-live';
const NO_TOP = {paddingTop: 0} as const;

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
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: PEER, displayName: '이도현', handle: 'dohyun'}),
]);

const NOW = Date.now();

function message(seq: number, author: string, body: string, ageSec: number): Message {
  return {
    id: `00000000-0000-7000-8000-00000000d${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - ageSec * 1000,
  } as Message;
}

/** Maestro 가 길게 누르는 내 글. 흐름 머리말의 `TARGET` 과 같은 글이다. */
const TARGET_BODY = '회의 시간은 3시로 정했어요';

// 고칠 내 글은 **맨 끝이 아니다** - 마지막 행 꼬리(「수정됨」)는 컴포저 바로 위에 붙어 사진에서 가려지기 쉽다. 뒤에 남의 글이 하나 더 서면 꼬리가 온전히 보인다.
const ALL: Message[] = [
  message(1, PEER, '내일 회의 시간 정해졌나요', 900),
  message(2, SELF, TARGET_BODY, 700),
  message(3, PEER, '네 기다릴게요', 300),
];

const NO_REACTIONS: ReactionMap = {};

export function EditLiveSurface(): React.JSX.Element {
  const inputRef = useRef<TextInput | null>(null);
  const [messages, setMessages] = useState<Message[]>(ALL);
  const actions = useRef<MessageRowActions>({
    myMemberId: SELF,
    onToggleReaction: async () => {},
    // 서버가 하는 일의 모형: 본문을 바꾸고 「고침」 상태와 고친 시각을 단다. 던지지 않으니 편집 시트는 저장 뒤 닫힌다.
    onEdit: async (target, body) => {
      setMessages(previous =>
        previous.map(entry =>
          entry.id === target.id
            ? ({...entry, body, state: 'edited', editedAtMs: Date.now()} as Message)
            : entry,
        ),
      );
    },
    onDelete: async () => {},
  }).current;

  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="이도현"
        kind="dm"
        peerId={PEER}
        directory={DIRECTORY}
        onBack={() => {}}
        onOpenMenu={() => {}}
        onOpenInfo={() => {}}
        railStatus="connected"
      />
      <ConversationLayout
        list={
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            channelKind="dm"
            channelId={CHANNEL}
            myMemberId={SELF}
            nowMs={NOW}
            actions={actions}
            pending={[]}
            reactions={NO_REACTIONS}
            tailGap={CONV.conversationTail}
            jumpPills
          />
        }
        composer={
          <View collapsable={false}>
            <Composer
              recipient="person"
              channelLabel="이도현"
              directory={DIRECTORY}
              draftKey={DRAFT_KEY}
              attachmentTarget={{workspaceId: WS, channelId: CHANNEL}}
              inputRef={inputRef}
              onSend={() => {}}
            />
          </View>
        }
      />
    </Screen>
  );
}
