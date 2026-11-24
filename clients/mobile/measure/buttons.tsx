import React from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {
  DangerButton,
  OutlineButton,
  PrimaryButton,
  QuietButton,
  type ButtonProps,
} from '../src/design/atoms';
import {useStyles} from '../src/design/theme';
import {font, line, SAFE_GUTTER, space, type Palette} from '../src/design/tokens';

// =============================================================================
// 폰 단추 네 종류 전시 (#6075) — 부품 장부 「폰 단추」 절의 견본 자리. 실제 공용 부품(`design/atoms.tsx`)을 그대로 세운다.
//
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure BUTTONS          (어둡게)
//   xcrun simctl launch booted app.momo.ios --args -momoMeasure LIGHT-BUTTONS    (밝게)
//
//   buttons          종류 4(주 · 보조 · 조용한 · 위험) × 상태(쉼 · 잠김 · 진행 중) + 크기(기본 44 · 작게 38) + 막대 끝(flush)
//
// 눌림(0.6)은 손가락이 닿아 있는 동안만이라 정지 사진에 없다 — 값은 `__tests__/buttonFamily.test.tsx` 가 잰다. 낱말은 고정 견본이다.
// =============================================================================

type Face = (buttonProps: ButtonProps) => React.JSX.Element;

const ROWS: ReadonlyArray<readonly [string, Face, string, string]> = [
  ['주', PrimaryButton, '저장', '저장 중'],
  ['보조', OutlineButton, '취소', '취소 중'],
  ['조용한', QuietButton, '열기', '여는 중'],
  ['위험', DangerButton, '나가기', '나가는 중'],
];

const noop = () => {};

export function ButtonsSurface(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.body, {paddingTop: insets.top + space.md, paddingBottom: insets.bottom + space.xl}]}
      testID="buttons-surface">
      <Text style={styles.title}>단추 네 종류 · 쉼 / 잠김 / 진행 중</Text>
      {ROWS.map(([name, Button, label, busyLabel]) => (
        <View key={name} style={styles.group} testID={`buttons-${name}`}>
          <Text style={styles.caption}>{name}</Text>
          <View style={styles.row}>
            <Button label={label} onPress={noop} />
            <Button label={label} disabled onPress={noop} />
            <Button label={label} busy busyLabel={busyLabel} onPress={noop} />
          </View>
        </View>
      ))}
      <Text style={styles.caption}>크기 · 기본 44 / 작게 38 (누르는 자리 44)</Text>
      <View style={styles.row}>
        <PrimaryButton label="승인" onPress={noop} />
        <PrimaryButton label="승인" size="small" onPress={noop} />
        <OutlineButton label="다시 불러오기" size="small" onPress={noop} />
      </View>
      <Text style={styles.caption}>넓은 자리 · 줄을 채운 주 · 보조</Text>
      <PrimaryButton label="다음" onPress={noop} />
      <OutlineButton label="다른 방법으로" onPress={noop} />
      <Text style={styles.caption}>막대 끝의 조용한 단추(flush)</Text>
      <View style={styles.bar}>
        <QuietButton flush="start" label="뒤로" onPress={noop} />
        <QuietButton flush="end" label="한국어" accessory="expand" onPress={noop} />
      </View>
    </ScrollView>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    screen: {flex: 1, backgroundColor: color.bg},
    body: {paddingHorizontal: SAFE_GUTTER, gap: space.md},
    title: {fontSize: font.heading, lineHeight: line.heading, fontWeight: '600', color: color.text},
    group: {gap: space.sm},
    caption: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    row: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
    bar: {
      flexDirection: 'row',
      justifyContent: 'space-between',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
  });
