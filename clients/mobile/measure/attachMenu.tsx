import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React, {useEffect} from 'react';
import {Screen} from '../src/design/atoms';
import {
  attachmentSurfaceKey,
  setPickerIssue,
} from '../src/features/attachments/draftStore';
import {Composer} from '../src/features/conversation/Composer';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {Timeline} from '../src/features/conversation/Timeline';

// =============================================================================
// 첨부 메뉴 캡처 표면 (#4180). 실제 컴포넌트(머리·레이아웃·타임라인·컴포저)를 대화 화면과 같은 순서로
// 세운다. 서버·레일만 없다. 컴포저에는 `attachmentTarget` 을 준다 — 없으면 + 가 서지 않는다.
//
//   xcrun simctl launch <udid> app.momo.ios --args -momoMeasure ATTACH-MENU-<WHICH>
//   (라이트: LIGHT-ATTACH-MENU-<WHICH>)
//
//   idle    메뉴가 닫힌 대화. 여는 것은 Maestro 의 실제 탭이다(`maestro/100-attach-menu-capture.yaml`).
//   denied  카메라 권한 거부 뒤의 트레이. 거부는 시스템 알림을 거쳐야 하는 일이라 같은 상태를
//           `setPickerIssue` 로 심는다 — 컴포저가 실제 길에서 부르는 그 함수다. 실제 길은
//           `maestro/100-attach-menu-capture.yaml` 가 아니라 카메라 행을 눌러 시스템 알림에서 「허용 안 함」.
//
// 뒤에 말풍선이 넉넉해야 카드의 흐림이 보인다: 위쪽에 긴 글, 아래쪽에 짧은 글 여러 개.
// =============================================================================

const WS = '00000000-0000-7000-8000-0000000000e0';
const SELF = '00000000-0000-7000-8000-0000000000e1';
const GROK = '00000000-0000-7000-8000-0000000000e2';
const CHANNEL = 'attach-menu-capture';

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
  member({id: GROK, kind: 'agent', displayName: '김인턴', handle: 'intern'}),
]);

const NOW = Date.now();
// 대화 화면과 같다: 머리 띠가 안전 영역 윗부분을 직접 덮는다(`ConversationScreen` 의 `screen.paddingTop: 0`).
const NO_TOP = {paddingTop: 0} as const;

function message(seq: number, author: string, body: string): Message {
  return {
    id: `00000000-0000-7000-8000-00000000f${String(seq).padStart(3, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW - (12 - seq) * 60_000,
  } as Message;
}

const MESSAGES = [
  message(
    1,
    GROK,
    '금주 이후 일정\n- 10월 16~18일: 등록된 일정 없음.\n\n업무\n- 마감·진행·지연 업무 없음(지난주~2주 뒤 조회, 등록 0건).\n\n다음 일정은 오후 2시예요. 휴가 중이라 일정과 겹치니, 참석 여부만 확인해 보시면 좋겠어요.',
  ),
  message(2, SELF, '13시 외부 출근'),
  message(3, GROK, '확인했어요. 오후 일정은 그대로 둘게요.'),
  message(4, SELF, '18시 퇴근'),
  message(5, GROK, '알겠어요. 내일 아침 일정도 정리해 둘까요?'),
  message(6, SELF, '응, 부탁해요'),
];

const TARGET = {workspaceId: WS, channelId: CHANNEL};

export function AttachMenuSurface({which}: {which: string}): React.JSX.Element {
  useEffect(() => {
    if (which !== 'denied') return;
    setPickerIssue(attachmentSurfaceKey(TARGET), 'camera-permission-denied');
  }, [which]);
  return (
    <Screen style={NO_TOP}>
      <ConversationHeader
        title="김인턴"
        kind="dm"
        peerId={GROK}
        peerStatusTone="ok"
        directory={DIRECTORY}
        onBack={() => {}}
        onOpenMenu={() => {}}
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
          />
        }
        composer={
          <Composer
            recipient="person"
            channelLabel="김인턴"
            directory={DIRECTORY}
            draftKey="measure:attach-menu"
            attachmentTarget={TARGET}
            onSend={() => {}}
          />
        }
      />
    </Screen>
  );
}
