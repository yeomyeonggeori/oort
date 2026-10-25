import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {Message, RosterMember} from '@momo/core/lib/api';
import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {ThemeControl} from '../src/design/ThemeControl';
import {ThemeProvider, themeChoiceLabel, useStyles, useTheme} from '../src/design/theme';
import {font, space, type Palette} from '../src/design/tokens';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {NON_SECRET_KEYS, nonSecretStore} from '../src/storage/kv';

// =============================================================================
// 화면 모드 — **진짜 프로바이더**가 서는 캡처 표면 (#4526).
//
//   xcrun simctl launch <UDID> app.momo.ios --args -momoMeasure THEME-LIVE -RCT_jsLocation 127.0.0.1:$PORT
//
// 다른 표면은 모두 `FixedScheme` 으로 스킴을 못 박아 찍는다(`measure/root.ts` — 같은 명령이 기기
// 상태에 따라 다른 색을 찍으면 사진은 증거가 아니라 일화가 된다). 그래서 「아무도 안 골랐을 때
// 무엇이 되는가」「고른 것이 다음 실행에도 남는가」는 그 표면들로는 찍을 수 없다. 이 표면은 안쪽에
// 진짜 `ThemeProvider`(진짜 MMKV, 진짜 시스템 추종)를 세워 바깥의 못 박힘을 이긴다 — 가장 가까운
// 컨텍스트가 이긴다.
//
// 그러므로 **이 표면의 사진은 기기 상태가 증거다**: 시뮬레이터를 다크로 두고, 앱을 지운 직후(저장이
// 없는 상태)에 띄우면 라이트로 서야 하고, `시스템` 을 누르면 기기를 따라 다크가 되며, 앱을 끄고
// 다시 띄워도 그 선택이 남는다. 캡션 한 줄이 그 세 사실(기기·화면·저장)을 사진에 적는다.
//
// 인물과 회사는 가상이다(이도현·박서연, 달무리 스튜디오).
// =============================================================================

const WS = '00000000-0000-7000-8000-000000004526';
const SELF = '00000000-0000-7000-8000-000000004a01';
const OTHER = '00000000-0000-7000-8000-000000004a02';
const NOW = 1_700_000_000_000;

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member(SELF, '이도현', 'dohyun'),
  member(OTHER, '박서연', 'seoyeon'),
]);

function message(id: string, seq: number, author: string, body: string): Message {
  return {
    id,
    channelId: 'ch-studio',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: NOW + seq * 60_000,
  };
}

const MESSAGES: readonly Message[] = [
  message('m1', 1, OTHER, '스튜디오 회의록 정리해서 올렸어요.'),
  message('m2', 2, SELF, '확인했어요. 오후에 이어서 볼게요.'),
];

const ACTIONS = {
  myMemberId: SELF,
  onToggleReaction: async () => {},
  onEdit: async () => {},
  onDelete: async () => {},
};

/** 저장소에 외양 레코드가 있는가 — 「한 번도 안 고름」과 「고른 뒤」를 사진에 적는다. */
function storedLine(): string {
  try {
    const store = nonSecretStore();
    const current = store.getString(NON_SECRET_KEYS.appearance);
    if (current) {
      const scheme = (JSON.parse(current) as {scheme?: string}).scheme ?? '?';
      return `저장: 있음(${scheme})`;
    }
    return store.getString(NON_SECRET_KEYS.themeChoice) ? '저장: 있음(옛 키)' : '저장: 없음 — 안 고름';
  } catch {
    return '저장: 읽을 수 없음';
  }
}

function Content(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {choice, scheme, systemScheme} = useTheme();
  const name = (s: 'light' | 'dark') => (s === 'dark' ? '다크' : '라이트');
  return (
    <View style={styles.root}>
      <Text style={styles.caption} testID="theme-live-caption">
        {`기기 ${name(systemScheme)} · 화면 ${name(scheme)} · 고른 것 ${themeChoiceLabel(choice)} · ${storedLine()}`}
      </Text>
      <ScrollView contentContainerStyle={styles.scroll}>
        {MESSAGES.map((item, index) => (
          <MessageRow
            key={item.id}
            message={item}
            startsGroup={index === 0 || MESSAGES[index - 1].authorMemberId !== item.authorMemberId}
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW + 600_000}
            actions={ACTIONS}
          />
        ))}
        <View style={styles.control}>
          <ThemeControl />
        </View>
      </ScrollView>
    </View>
  );
}

export function ThemeLiveSurface(): React.JSX.Element {
  return (
    <ThemeProvider>
      <Content />
    </ThemeProvider>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, backgroundColor: color.bg, paddingTop: 56},
    // 하네스 자신의 캡션은 제품이 아니라 사진의 설명이라 토큰을 든다(라이트에서도 읽힌다).
    caption: {
      fontSize: font.meta,
      color: color.textMuted,
      paddingHorizontal: space.lg,
      paddingBottom: space.sm,
    },
    scroll: {paddingBottom: 48},
    control: {paddingHorizontal: space.lg, paddingTop: space.lg},
  });
