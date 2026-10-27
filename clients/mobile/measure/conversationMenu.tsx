import {CHANNEL_MUTE_FAILURE} from '@momo/core/features/channels/model';
import {pinListHeaderLabel} from '@momo/core/features/timeline/pins';
import React from 'react';

import {ConversationMenuSheet} from '../src/features/conversation/ConversationMenuSheet';
import {conversationMenuActionItems} from '../src/features/conversation/conversationMenu';
import type {ChannelRowTarget} from '../src/features/sidebar/channelRowActions';
import {Backdrop} from './sheetKit';

// =============================================================================
// 대화 머리 ⋮ 시트의 캡처 표면 (#4319). 배송되는 `ConversationMenuSheet` 에 고정 데이터를 건넨다 — 항목은 화면과 같은 길(`conversationMenuActionItems`,
// 코어 표를 거른 답)로 만든다.
//
//   -momoMeasure CONVMENU-<이름>   (라이트: LIGHT-CONVMENU-<이름>)
//
//   dm             사람 DM(박서연) — 고정한 메시지 › · 알림 끄기 · 대화 닫기. 정보 행은 없다(그 화면을 가진 호출자만 문을 단다)
//   agent          에이전트 DM(달무리 도우미) — 위에 작업 맡기기 › 가 더해진다
//   channel        채널(#디자인, 관리자) — 고정한 메시지 › · 알림 끄기 · 채널 나가기(위험색)
//   channel-leave  같은 채널의 나가기 확인 단계(「이 채널에서 나갈까요?」 + 취소 · 채널 나가기)
//   mute-failure   알림 끄기가 거절된 뒤 — 시트가 열린 채 그 자리에서 이유를 말한다
//
// 시트는 `Modal` 이라 한 프레임에 하나만 선다 — 표면 하나가 시트 하나다. 모든 이름은 가상 인물이다(이도현·박서연, 에이전트 달무리 도우미,
// 회사 달무리 스튜디오).
// =============================================================================

const noop = () => {};

const CAUGHT_UP = {
  channelId: 'dm-seoyeon',
  lastReadSeq: 9,
  latestSeq: 9,
  unreadCount: 0,
  mentionCount: 0,
  markedUnreadBeforeSeq: null,
} as ChannelRowTarget['readState'];

// 관리자라서 「채널 나가기」까지 선다 — `canLeaveChannel` 은 소유자·관리자만 낸다.
const CHANNEL_TARGET: ChannelRowTarget = {
  channel: {id: 'ch-design', kind: 'public', topic: ''},
  title: '디자인',
  muted: false,
  selfRole: 'admin',
  readState: CAUGHT_UP,
};

const DM_TARGET: ChannelRowTarget = {
  channel: {id: 'dm-seoyeon', kind: 'dm', topic: ''},
  title: '박서연',
  muted: false,
  selfRole: 'member',
  readState: CAUGHT_UP,
  closeOffered: true,
};

const AGENT_TARGET: ChannelRowTarget = {
  ...DM_TARGET,
  channel: {id: 'dm-helper', kind: 'dm', topic: ''},
  title: '달무리 도우미',
};

function Sheet({
  target,
  delegate = false,
  confirmingLeave = false,
  error = null,
}: {
  target: ChannelRowTarget;
  delegate?: boolean;
  confirmingLeave?: boolean;
  error?: string | null;
}): React.JSX.Element {
  return (
    <Backdrop>
      <ConversationMenuSheet
        title={target.title}
        kind={target.channel.kind}
        pinLabel={pinListHeaderLabel(2, 'ready')}
        onOpenPins={noop}
        onDelegateWork={delegate ? noop : undefined}
        items={conversationMenuActionItems(target)}
        confirmingLeave={confirmingLeave}
        isPending={() => false}
        error={error}
        leave={{pending: false, error: null}}
        onRun={noop}
        onConfirmLeave={noop}
        onCancelLeave={noop}
        onClose={noop}
      />
    </Backdrop>
  );
}

export function ConversationMenuSurface({which}: {which: string}): React.JSX.Element {
  switch (which) {
    case 'agent':
      return <Sheet target={AGENT_TARGET} delegate />;
    case 'channel':
      return <Sheet target={CHANNEL_TARGET} />;
    case 'channel-leave':
      return <Sheet target={CHANNEL_TARGET} confirmingLeave />;
    case 'mute-failure':
      return <Sheet target={CHANNEL_TARGET} error={CHANNEL_MUTE_FAILURE} />;
    default:
      return <Sheet target={DM_TARGET} />;
  }
}
