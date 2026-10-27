import {
  DM_CLOSED_LIST_EMPTY,
  DM_CLOSED_LIST_HINT,
  DM_CLOSED_LIST_LABEL,
  dmClosedReasonLabel,
  dmReopenLabelFor,
} from '@momo/core/features/sidebar/dmVisibility';
import React from 'react';
import {StyleSheet, View} from 'react-native';
import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {font, line, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import type {DmClosedEntry} from './dmVerdicts';

// =============================================================================
// 「⋯ › 닫은 대화」 시트 (ADR-0177 증보 D11, #4367). 웹 `DmClosedMenu` 의 폰판이다: 내가 **닫은** 대화와 상대가 **나간** 대화를
// 「다시 열기」·「열기」와 함께 보여 주고, 지금 목록에 보이는 대화는 넣지 않는다. 낱말은 전부 코어(`dmVisibility.ts`)의 것이다.
//
// 목록이 열린 채 비면(다른 기기에서 다시 열었다·새 메시지로 돌아왔다) 제목과 힌트만 남지 않게 빈 상태를 말한다.
//
// ## 공용 시트로 (#4458)
//
// 그릇은 `PageSheet`(내용 맞춤 단), 머리는 오른쪽 원형 X 의 `SheetHeader` 다 — 옛 맨 아래 「닫기」 줄(`SheetRow`)과 줄마다 선
// 외곽선 「다시 열기」 단추는 없다. 대화 하나는 묶음 카드의 **행 하나**이고 행 전체가 그 동사(「다시 열기」·「열기」)다.
// 동사는 오른쪽 값 자리에 서고 보조기술 이름은 그대로 「<이름>, <동사>」다. 진행 중인 줄은 눌리지 않는다.
// =============================================================================

export interface DmClosedSheetItem {
  entry: DmClosedEntry;
  /** 행이 그리는 이름(`channelLabelParts`). */
  name: string;
}

export function DmClosedSheet({
  items,
  pendingId,
  error,
  onReopen,
  onClose,
}: {
  items: readonly DmClosedSheetItem[];
  pendingId: string | null;
  error: string | null;
  onReopen: (entry: DmClosedEntry) => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={DM_CLOSED_LIST_LABEL}
      scrimLabel="닫은 대화 닫기"
      scrimTestID="dm-closed-backdrop"
      testID="dm-closed-sheet">
      <SheetHeader
        title={DM_CLOSED_LIST_LABEL}
        closeLabel="닫은 대화 닫기"
        closeTestID="dm-closed-close"
      />
      <SheetScroll testID="dm-closed-scroll">
        <Sentence style={styles.hint} testID="dm-closed-hint">
          {DM_CLOSED_LIST_HINT}
        </Sentence>
        {error !== null ? (
          <Sentence accessibilityRole="alert" style={styles.error} testID="dm-closed-error">
            {error}
          </Sentence>
        ) : null}
        {items.length === 0 ? (
          <Sentence style={styles.empty} testID="dm-closed-empty">
            {DM_CLOSED_LIST_EMPTY}
          </Sentence>
        ) : (
          <GroupCard>
            {items.map(({entry, name}) => {
              const id = entry.channel.id;
              const busy = pendingId === id;
              const action = dmReopenLabelFor(entry.reason);
              return (
                <View key={id} testID={`dm-closed-item-${id}`}>
                  <ListRow
                    title={name}
                    detail={dmClosedReasonLabel(entry.reason)}
                    value={action}
                    accessibilityLabel={`${name}, ${action}`}
                    busy={busy}
                    disabled={busy}
                    onPress={() => onReopen(entry)}
                    testID={`dm-closed-reopen-${id}`}
                  />
                </View>
              );
            })}
          </GroupCard>
        )}
      </SheetScroll>
    </PageSheet>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // AA: `textFaint` 는 본문 대비 4.5 를 못 지난다 — 힌트는 뜻을 나르는 글자다.
    hint: {
      paddingHorizontal: space.xs,
      fontSize: font.meta,
      color: color.textMuted,
      lineHeight: line.label,
    },
    error: {fontSize: font.label, color: color.danger, lineHeight: line.label},
    empty: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
  });
