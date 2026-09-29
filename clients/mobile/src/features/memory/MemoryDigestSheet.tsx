import type {
  MemoryDigest,
  MemoryEvidenceLink,
} from '@momo/core/features/memory/model';
import React from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Sentence} from '../../design/atoms';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {
  digestSourceLine,
  RECEIPT_CLOSE,
  RECEIPT_CLOSE_A11Y,
  RECEIPT_ONLY_READABLE,
  WITHHELD_EXPLAIN,
  withheldLine,
} from './copy';
import {EvidencePills} from './EvidencePills';
import {digestLines} from './model';

// =============================================================================
// 기억 목록 시트 — 「기억 n개 참고」 칩과 요약 카드의 「더 보기」가 함께 쓴다.
//
// 내용은 서버가 내 권한으로 걸러 준 요약뿐이다. 보류는 **개수와 이유만** 말하고
// 내용을 그리지 않는다(ADR-0196 D7). 근거를 누르면 시트가 닫히고 부른 쪽이 그
// 메시지로 데려간다.
// =============================================================================

const EVIDENCE_IN_SHEET = 5;

export function MemoryDigestSheet({
  title,
  summary,
  digests,
  withheld,
  listShorter,
  onClose,
  onOpenEvidence,
  testID = 'memory-sheet',
}: {
  title: string;
  /** 제목 아래 한 줄. */
  summary?: string;
  digests: readonly MemoryDigest[];
  /** 서버가 준 보류 개수(양수)일 때만. 없으면 줄을 세우지 않는다. */
  withheld: number | null;
  /** 실린 수보다 목록이 짧을 때 붙이는 한 줄(이유는 말하지 않는다). */
  listShorter: boolean;
  onClose: () => void;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {height: windowHeight} = useWindowDimensions();
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID={testID}>
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel={RECEIPT_CLOSE_A11Y}
          onPress={onClose}
          testID={`${testID}-backdrop`}
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, space.md),
              maxHeight: windowHeight * 0.85,
            },
          ]}>
          <View style={styles.grabber} />
          <View style={styles.head}>
            <View style={styles.headText}>
              <Text accessibilityRole="header" style={styles.title}>
                {title}
              </Text>
              {summary ? <Sentence style={styles.summary}>{summary}</Sentence> : null}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={RECEIPT_CLOSE_A11Y}
              onPress={onClose}
              style={({pressed}) => [styles.close, pressed && styles.pressed]}
              testID={`${testID}-close`}>
              <Text style={styles.closeLabel}>{RECEIPT_CLOSE}</Text>
            </Pressable>
          </View>
          <ScrollView bounces={false} testID={`${testID}-scroll`}>
            {digests.map((digest, index) => (
              <View
                key={digest.id}
                style={[styles.item, index > 0 && styles.itemSeparated]}
                testID={`${testID}-item-${index + 1}`}>
                {digestLines(digest).map((row, rowIndex) => (
                  <Sentence key={rowIndex} style={styles.itemLine}>
                    {row}
                  </Sentence>
                ))}
                <Text style={styles.itemMeta}>
                  {digestSourceLine(digest.sourceCount)}
                </Text>
                <EvidencePills
                  links={digest.evidence}
                  max={EVIDENCE_IN_SHEET}
                  onOpen={onOpenEvidence}
                  testID={`${testID}-evidence-${index + 1}`}
                />
              </View>
            ))}
            {listShorter ? (
              <Sentence style={styles.note} testID={`${testID}-only-readable`}>
                {RECEIPT_ONLY_READABLE}
              </Sentence>
            ) : null}
            {withheld !== null ? (
              <View style={styles.withheld} testID={`${testID}-withheld`}>
                <Text style={styles.withheldTitle}>{withheldLine(withheld)}</Text>
                <Sentence style={styles.note}>{WITHHELD_EXPLAIN}</Sentence>
              </View>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1, justifyContent: 'flex-end'},
    backdrop: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: color.scrim,
    },
    sheet: {
      backgroundColor: color.surface,
      borderTopLeftRadius: 16,
      borderTopRightRadius: 16,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.sm,
    },
    grabber: {
      alignSelf: 'center',
      width: 36,
      height: 4,
      borderRadius: radius.pill,
      backgroundColor: color.border,
      marginBottom: space.md,
    },
    head: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
    headText: {flex: 1, gap: space.xs, paddingBottom: space.md},
    title: {fontSize: font.body, color: color.text, fontWeight: '700'},
    summary: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    close: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {opacity: 0.6},
    closeLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
    item: {gap: space.sm, paddingVertical: space.md},
    itemSeparated: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    itemLine: {fontSize: font.label, lineHeight: line.label, color: color.text},
    itemMeta: {fontSize: font.meta, lineHeight: line.meta, color: color.textFaint},
    note: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    withheld: {
      gap: space.xs,
      paddingVertical: space.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
    },
    withheldTitle: {fontSize: font.label, color: color.text, fontWeight: '600'},
  });
