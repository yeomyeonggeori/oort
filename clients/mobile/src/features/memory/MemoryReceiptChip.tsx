import type {MemoryEvidenceLink} from '@momo/core/features/memory/model';
import React, {useState} from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {font, radius, slopTo, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {
  receiptChipA11y,
  receiptChipLabel,
  receiptSheetSummary,
  RECEIPT_SHEET_TITLE,
} from './copy';
import {MemoryDigestSheet} from './MemoryDigestSheet';
import {receiptChipModel, receiptSheetModel} from './model';
import {useRunMemoryReceipt} from './queries';

// =============================================================================
// 「기억 n개 참고」 칩 (plan.md §5 V2 / ADR-0196 D7) — 에이전트 답 아래.
//
// n은 서버가 센 `servedCount`다. 참고한 기억이 없으면(영수증이 없거나 0) 칩을 세우지
// 않는다. 영수증을 못 읽어도 답을 가리지 않으므로 오류도 조용히 칩이 없다.
// 눌러서 여는 시트는 읽기 전용이다(폰은 V2 읽기까지).
// =============================================================================

const CHIP_HEIGHT = 28;

export function MemoryReceiptChipView({
  count,
  onPress,
}: {
  count: number;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={receiptChipA11y(count)}
      hitSlop={{top: slopTo(CHIP_HEIGHT), bottom: slopTo(CHIP_HEIGHT)}}
      onPress={onPress}
      style={({pressed}) => [styles.chip, pressed && styles.pressed]}
      testID="memory-receipt-chip">
      <Text style={styles.label}>{receiptChipLabel(count)}</Text>
    </Pressable>
  );
}

export function MemoryReceiptChip({
  workspaceId,
  runId,
  onOpenEvidence,
}: {
  workspaceId: string;
  runId: string;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
}): React.JSX.Element | null {
  const receipt = useRunMemoryReceipt(workspaceId, runId);
  const [open, setOpen] = useState(false);
  const chip = receiptChipModel(receipt.data);
  if (chip === null || !receipt.data) return null;
  const sheet = receiptSheetModel(receipt.data);
  return (
    <>
      <MemoryReceiptChipView count={chip.count} onPress={() => setOpen(true)} />
      {open ? (
        <MemoryDigestSheet
          title={RECEIPT_SHEET_TITLE}
          summary={receiptSheetSummary(sheet.count)}
          digests={sheet.digests}
          withheld={sheet.withheld}
          listShorter={sheet.listShorter}
          onClose={() => setOpen(false)}
          onOpenEvidence={link => {
            setOpen(false);
            onOpenEvidence?.(link);
          }}
        />
      ) : null}
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    chip: {
      alignSelf: 'flex-start',
      marginTop: space.xs,
      minHeight: CHIP_HEIGHT,
      paddingHorizontal: space.md,
      justifyContent: 'center',
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.agentSurface,
    },
    pressed: {opacity: 0.6},
    label: {fontSize: font.meta, color: color.text, fontWeight: '600'},
  });
