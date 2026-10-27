import type {
  MemoryDigest,
  MemoryEvidenceLink,
} from '@momo/core/features/memory/model';
import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {PageSheet, usePageSheetAction} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, SheetScroll} from '../../design/sheetParts';
import {font, line, SHEET, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {
  digestSourceLine,
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
//
// ## 공용 시트로 (#4458)
//
// 그릇은 `PageSheet`(내용 맞춤 단), 머리는 오른쪽 원형 X 의 `SheetHeader`다. 옛 글자 「닫기」 단추는 없다 —
// 이름은 그대로 `RECEIPT_CLOSE_A11Y`(「기억 목록 닫기」). 요약은 묶음 카드의 줄이고, 줄 사이는 카드의 구분선이다.
// 근거 알약은 다른 화면(그 메시지)으로 가는 누름이라 시트가 **먼저 내려간 뒤** 부른 쪽의 일이 불린다.
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
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={title}
      scrimLabel={RECEIPT_CLOSE_A11Y}
      scrimTestID={`${testID}-backdrop`}
      testID={testID}>
      <SheetHeader
        title={title}
        closeLabel={RECEIPT_CLOSE_A11Y}
        closeTestID={`${testID}-close`}
      />
      <DigestBody
        summary={summary}
        digests={digests}
        withheld={withheld}
        listShorter={listShorter}
        onOpenEvidence={onOpenEvidence}
        testID={testID}
      />
    </PageSheet>
  );
}

function DigestBody({
  summary,
  digests,
  withheld,
  listShorter,
  onOpenEvidence,
  testID,
}: {
  summary?: string;
  digests: readonly MemoryDigest[];
  withheld: number | null;
  listShorter: boolean;
  onOpenEvidence?: (link: MemoryEvidenceLink) => void;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const afterClose = usePageSheetAction();
  // 근거 → 그 메시지: 시트를 먼저 내리고 부른 쪽의 일을 한 번 부른다(부른 쪽이 곧바로 걷어도 스냅으로 사라지지 않는다).
  const openEvidence = onOpenEvidence
    ? (link: MemoryEvidenceLink) => afterClose(() => onOpenEvidence(link))
    : undefined;
  return (
    <SheetScroll testID={`${testID}-scroll`}>
      {summary ? <Sentence style={styles.summary}>{summary}</Sentence> : null}
      {digests.length > 0 ? (
        <GroupCard>
          {digests.map((digest, index) => (
            <View
              key={digest.id}
              style={styles.item}
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
                onOpen={openEvidence}
                testID={`${testID}-evidence-${index + 1}`}
              />
            </View>
          ))}
        </GroupCard>
      ) : null}
      {listShorter ? (
        <Sentence style={styles.note} testID={`${testID}-only-readable`}>
          {RECEIPT_ONLY_READABLE}
        </Sentence>
      ) : null}
      {withheld !== null ? (
        <GroupCard>
          <View style={styles.withheld} testID={`${testID}-withheld`}>
            <Text style={styles.withheldTitle}>{withheldLine(withheld)}</Text>
            <Sentence style={styles.note}>{WITHHELD_EXPLAIN}</Sentence>
          </View>
        </GroupCard>
      ) : null}
    </SheetScroll>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 제목 아래 한 줄 — 카드 위의 회색 작은 글씨(섹션 라벨과 같은 줄 높이).
    summary: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    // 카드 안의 한 요약. 구분선은 카드가 그린다(옛 `itemSeparated` 테두리 없음).
    item: {
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    itemLine: {fontSize: font.label, lineHeight: line.label, color: color.text},
    itemMeta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    note: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    withheld: {
      gap: space.xs,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    withheldTitle: {fontSize: font.label, color: color.text, fontWeight: '600'},
  });
