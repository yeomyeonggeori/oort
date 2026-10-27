import {makeStressRoster} from '@momo/core/features/timeline/stress';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Booting} from '../App';
import {OortLoader} from '../src/design/brand/OortLoader';
import {useStyles} from '../src/design/theme';
import {font, space, type Palette} from '../src/design/tokens';
import {ConversationHeader} from '../src/features/conversation/ConversationHeader';

// =============================================================================
// 오르트 로더 캡처 표면 (#3961). 실제 컴포넌트를 그 자리 그대로 세운다.
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure OORT-LOADER-<WHICH>
//   (라이트: LIGHT-OORT-LOADER-<WHICH>)
//
//   banner-connecting     대화 머리의 연결 띠 「연결 중…」 (실제 ConversationHeader)
//   banner-disconnected   같은 띠 「연결이 끊겼습니다」
//   boot                  첫 로딩: 로그인 상태를 되살리는 화면 (실제 Booting, 라벨 있음)
//   boot-plain            첫 로딩: 앱을 여는 화면 (실제 Booting, 라벨 없음)
//   sizes                 크기별 한 장: 20(띠) · 24 · 40 · 56(첫 로딩), small 과 display 마크
//
// 움직임은 실제로 돈다. 정지 사진은 그 순간의 한 프레임이고, 움직임 증거는 화면 녹화다.
// =============================================================================

const ROSTER = makeStressRoster();
const DIRECTORY = makeDirectory(ROSTER);

export function OortLoaderSurface({which}: {which: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);

  if (which === 'boot') {
    return <Booting label="로그인 상태를 확인하는 중입니다." testID="session-restoring" />;
  }
  if (which === 'boot-plain') {
    return <Booting testID="booting" />;
  }
  if (which === 'sizes') {
    return (
      <View style={styles.screen}>
        <Text style={styles.label}>오르트 로더 · 크기별 (small 마크 ≤32pt, display 마크 &gt;32pt)</Text>
        <View style={styles.row}>
          {[20, 24, 32, 40, 56, 72].map(size => (
            <View key={size} style={styles.cell}>
              <OortLoader size={size} testID={`sizes-${size}`} />
              <Text style={styles.cap}>{size}pt</Text>
            </View>
          ))}
        </View>
      </View>
    );
  }
  const status = which === 'banner-disconnected' ? 'disconnected' : 'connecting';
  return (
    <View style={styles.screen}>
      <ConversationHeader
        title="agent-lab"
        subtitle="6명"
        kind="public"
        directory={DIRECTORY}
        onBack={() => {}}
        railStatus={status}
      />
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: color.bg},
    label: {
      fontSize: font.label,
      color: color.textMuted,
      paddingHorizontal: space.lg,
      paddingTop: 96,
      paddingBottom: space.md,
    },
    row: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'flex-end',
      gap: space.xl,
      paddingHorizontal: space.lg,
    },
    cell: {alignItems: 'center', gap: space.sm},
    cap: {fontSize: font.meta, color: color.textMuted},
  });
