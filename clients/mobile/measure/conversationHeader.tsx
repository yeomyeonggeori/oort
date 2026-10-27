import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {RosterMember} from '@momo/core/lib/api';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Screen} from '../src/design/atoms';
import {useStyles} from '../src/design/theme';
import {font, SAFE_GUTTER, space, type Palette} from '../src/design/tokens';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';

// =============================================================================
// 대화 머리 가운데 알약의 캡처 표면 (#4319). 배송되는 `ConversationHeader` 를 그 자리 그대로 세운다 — 알약은 `onOpenInfo` 가 있을 때만 단추다.
//
//   -momoMeasure CONVHEADER-<이름>   (라이트: LIGHT-CONVHEADER-<이름>)
//
//   dm                 사람 DM(박서연, 자리 비움) — 얼굴 + 상태 점 + 이름 + 상태 낱말(「자리 비움」) 한 줄
//   dm-agent           에이전트 DM(달무리 도우미, 응답함) — 둥근 사각 얼굴 + 점 + 상태 낱말
//   channel            공개 채널(# 디자인) — `#` + 이름 + 짧은 멤버 수(「6명」)
//   channel-long-name  아주 긴 채널 이름 — 이름이 줄어 말줄임, 멤버 수는 그대로(SE 에서 찍는다)
//   dm-long-name       긴 DM 이름 — 보조 글(상태 낱말)이 이름 바닥(다섯 글자)을 지키려고 통째로 숨는다(SE 에서 찍는다)
//
// 알약이 가운데에 서는지(양쪽 칸이 같은 폭)와 머리 높이가 안 움직이는지가 사진으로 볼 것이다. 아래는 유리 띠가 비칠 가상의 대화 줄이다.
// 모든 이름은 가상 인물이다(이도현·박서연·최민수, 에이전트 달무리 도우미, 회사 달무리 스튜디오).
// =============================================================================

const WS = '00000000-0000-7000-8000-000000004b00';
const SELF_ID = '00000000-0000-7000-8000-000000004b01';
const SEOYEON_ID = '00000000-0000-7000-8000-000000004b02';
const HELPER_ID = '00000000-0000-7000-8000-000000004b03';
const LONG_ID = '00000000-0000-7000-8000-000000004b04';

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

const LONG_NAME = '달무리 스튜디오 디자인팀 도우미';

const DIRECTORY = makeDirectory([
  person({id: SELF_ID, displayName: '이도현', handle: 'dohyun', role: 'owner'}),
  person({id: SEOYEON_ID, displayName: '박서연', handle: 'seoyeon', presenceStatus: 'away'}),
  person({id: HELPER_ID, kind: 'agent', displayName: '달무리 도우미', handle: 'dalmuri-helper'}),
  person({id: LONG_ID, kind: 'agent', displayName: LONG_NAME, handle: 'dalmuri-design-helper'}),
]);

const noop = () => {};

// 대화 화면과 같다: 머리 띠가 안전 영역 윗부분을 직접 덮는다(`ConversationScreen` 의 `screen.paddingTop: 0`).
const NO_TOP = {paddingTop: 0} as const;

const LINES = [
  '오늘 배포 끝나면 알려 주세요.',
  '네, 서버를 먼저 올리고 앱은 그다음에 올릴게요.',
  '끝나면 여기에 남길게요.',
];

function Frame({children}: {children: React.ReactNode}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Screen style={NO_TOP}>
      {children}
      <View style={styles.body}>
        {LINES.map(line => (
          <Text key={line} style={styles.line}>
            {line}
          </Text>
        ))}
      </View>
    </Screen>
  );
}

export function ConversationHeaderSurface({which}: {which: string}): React.JSX.Element {
  switch (which) {
    case 'dm-agent':
      return (
        <Frame>
          <ConversationHeader
            title="달무리 도우미"
            kind="dm"
            peerId={HELPER_ID}
            peerStatusTone="ok"
            peerStatusLabel="응답함"
            directory={DIRECTORY}
            onBack={noop}
            onOpenMenu={noop}
            onOpenInfo={noop}
            railStatus="connected"
          />
        </Frame>
      );
    case 'channel':
      return (
        <Frame>
          <ConversationHeader
            title="디자인"
            memberCount="6명"
            kind="public"
            directory={DIRECTORY}
            onBack={noop}
            onOpenMenu={noop}
            onOpenInfo={noop}
            railStatus="connected"
          />
        </Frame>
      );
    case 'channel-long-name':
      return (
        <Frame>
          <ConversationHeader
            title="agent-lab-platform-engineering-oncall"
            memberCount="6명"
            kind="public"
            directory={DIRECTORY}
            onBack={noop}
            onOpenMenu={noop}
            onOpenInfo={noop}
            railStatus="connected"
          />
        </Frame>
      );
    case 'dm-long-name':
      return (
        <Frame>
          <ConversationHeader
            title={LONG_NAME}
            kind="dm"
            peerId={LONG_ID}
            peerStatusTone="ok"
            peerStatusLabel="응답함"
            directory={DIRECTORY}
            onBack={noop}
            onOpenMenu={noop}
            onOpenInfo={noop}
            railStatus="connected"
          />
        </Frame>
      );
    default:
      return (
        <Frame>
          <ConversationHeader
            title="박서연"
            kind="dm"
            peerId={SEOYEON_ID}
            peerStatusTone="warn"
            peerStatusLabel="자리 비움"
            directory={DIRECTORY}
            onBack={noop}
            onOpenMenu={noop}
            onOpenInfo={noop}
            railStatus="connected"
          />
        </Frame>
      );
  }
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.lg, gap: space.md},
    line: {fontSize: font.body, color: color.text},
  });
