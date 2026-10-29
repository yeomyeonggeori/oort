import {CHANNEL_MUTE_FAILURE} from '@momo/core/features/channels/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import React from 'react';
import {StyleSheet, View} from 'react-native';

import {useStyles} from '../src/design/theme';
import {type Palette} from '../src/design/tokens';
import {
  ConversationInfoPage,
  type ConversationInfoPageProps,
} from '../src/features/conversation/ConversationInfoPage';
import {conversationInfoActionItems} from '../src/features/conversation/conversationMenu';
import {AvatarViewer} from '../src/features/directory/AvatarViewer';
import type {ChannelRowTarget} from '../src/features/sidebar/channelRowActions';
import {PHOTO} from './profileSheet';

// =============================================================================
// 대화·채널 정보 페이지의 캡처 표면 (#4319). 배송되는 `ConversationInfoPage` 에 고정 데이터를 건넨다 — 항목은 화면과 같은 길
// (`conversationInfoActionItems`, 코어 표를 거른 답)로 만든다.
//
//   -momoMeasure INFOPAGE-<이름>   (라이트: LIGHT-INFOPAGE-<이름>)
//
//   dm          사람 DM(박서연, 사진 없음) — 이니셜 얼굴(단추 아님) · 자리 비움 칩 · 한 줄 상태 · 알림 · 복사 셋 · 대화 닫기
//   dm-photo    사진이 있는 사람 — 같은 모양인데 큰 얼굴이 눌려 크게 보기가 된다
//   dm-agent    에이전트 DM(달무리 도우미) — 둥근 사각 얼굴 · 생존 칩 · 「○○님이 관리」 · 「에이전트 정보 ›」
//   channel     공개 채널(# 디자인, 관리자) — 큰 `#` 얼굴 · 「6명 · 달무리 도우미 참여 중」 · 주제 · 알림 · 복사 셋 · 채널 나가기(위험색)
//   channel-leave 같은 채널의 나가기 확인 단계
//   viewer      사진 크게 보기(`AvatarViewer`) — 정보 페이지 위에 선 전체 화면
//
// 페이지는 `EdgeSwipeBack` 층(`enter="push"`)이라 들어올 때 오른쪽에서 밀려 들어온다 — 캡처는 멎은 뒤를 찍는다.
// 사진은 **합성 그라데이션**(`profileSheet.tsx` 의 `PHOTO`)이다. 모든 이름은 가상 인물이다(이도현·박서연·최민수, 에이전트 달무리 도우미,
// 회사 달무리 스튜디오).
// =============================================================================

const WS = '00000000-0000-7000-8000-000000004c00';
const SELF_ID = '00000000-0000-7000-8000-000000004c01';
const NOW = Date.UTC(2026, 9, 27, 3, 0);

function person(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    role: 'member',
    channelCount: 2,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const SELF = person({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: 'owner'});
const SEOYEON = person({
  id: '00000000-0000-7000-8000-000000004c02',
  displayName: '박서연',
  handle: 'seoyeon',
  presenceStatus: 'away',
  statusEmoji: '📅',
  statusText: '회의 중',
  statusExpiresAtMs: NOW + 60 * 60_000,
});
const SEOYEON_PHOTO = person({...SEOYEON, avatarUrl: PHOTO});
const HELPER = person({
  id: '00000000-0000-7000-8000-000000004c03',
  kind: 'agent',
  displayName: '달무리 도우미',
  handle: 'dalmuri-helper',
  ownerHumanId: SELF_ID,
});

const DIRECTORY = makeDirectory([SELF, SEOYEON, HELPER]);
const DIRECTORY_PHOTO = makeDirectory([SELF, SEOYEON_PHOTO, HELPER]);

const CAUGHT_UP = {
  channelId: 'x',
  lastReadSeq: 9,
  latestSeq: 9,
  unreadCount: 0,
  mentionCount: 0,
  markedUnreadBeforeSeq: null,
} as ChannelRowTarget['readState'];

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

const noop = () => {};

function props(over: Partial<ConversationInfoPageProps>): ConversationInfoPageProps {
  return {
    kind: 'dm',
    title: '박서연',
    directory: DIRECTORY,
    items: conversationInfoActionItems(DM_TARGET),
    confirmingLeave: false,
    isPending: () => false,
    error: null,
    leave: {pending: false, error: null},
    onRun: noop,
    onConfirmLeave: noop,
    onCancelLeave: noop,
    onClose: noop,
    peer: SEOYEON,
    status: {tone: 'warn', label: '자리 비움'},
    nowMs: NOW,
    ...over,
  };
}

const CHANNEL_PROPS: Partial<ConversationInfoPageProps> = {
  kind: 'public',
  title: '디자인',
  items: conversationInfoActionItems(CHANNEL_TARGET),
  peer: null,
  status: null,
  subtitle: '6명 · 달무리 도우미 참여 중',
  topic: '다음 배포 일정과 디자인 검수를 이야기해요.',
};

function Frame({children}: {children: React.ReactNode}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <View style={styles.frame}>{children}</View>;
}

export function ConversationInfoPageSurface({which}: {which: string}): React.JSX.Element {
  switch (which) {
    case 'dm-photo':
      return (
        <Frame>
          <ConversationInfoPage
            {...props({directory: DIRECTORY_PHOTO, peer: SEOYEON_PHOTO, onEnlargeAvatar: noop})}
          />
        </Frame>
      );
    case 'dm-agent':
      return (
        <Frame>
          <ConversationInfoPage
            {...props({
              title: '달무리 도우미',
              items: conversationInfoActionItems(AGENT_TARGET),
              peer: HELPER,
              status: {tone: 'ok', label: '응답함 3분 전'},
              onOpenAgent: noop,
            })}
          />
        </Frame>
      );
    case 'channel':
      return (
        <Frame>
          <ConversationInfoPage {...props(CHANNEL_PROPS)} />
        </Frame>
      );
    case 'channel-leave':
      return (
        <Frame>
          <ConversationInfoPage {...props({...CHANNEL_PROPS, confirmingLeave: true})} />
        </Frame>
      );
    case 'mute-failure':
      return (
        <Frame>
          <ConversationInfoPage {...props({...CHANNEL_PROPS, error: CHANNEL_MUTE_FAILURE})} />
        </Frame>
      );
    case 'viewer':
      return (
        <Frame>
          <ConversationInfoPage
            {...props({directory: DIRECTORY_PHOTO, peer: SEOYEON_PHOTO, onEnlargeAvatar: noop})}
          />
          <AvatarViewer uri={PHOTO} label="박서연 프로필 사진" onClose={noop} />
        </Frame>
      );
    default:
      return (
        <Frame>
          <ConversationInfoPage {...props({})} />
        </Frame>
      );
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 페이지는 대화 화면을 덮는 한 겹(`position: absolute`)이다 — 부모가 화면 전체여야 한다.
    frame: {flex: 1, backgroundColor: color.bg},
  });
