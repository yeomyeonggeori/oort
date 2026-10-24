import {
  DM_CLOSED_LIST_EMPTY,
  DM_CLOSED_LIST_HINT,
  DM_CLOSED_LIST_LABEL,
  dmClosedReasonLabel,
  dmReopenLabelFor,
} from '@momo/core/features/sidebar/dmVisibility';
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
import {font, line, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {SheetRow} from '../conversation/MessageActionSheet';
import type {DmClosedEntry} from './dmVerdicts';

// =============================================================================
// 「⋯ › 닫은 대화」 시트 (ADR-0177 증보 D11, #4367). 웹 `DmClosedMenu` 의 폰판이다: 내가 **닫은** 대화와 상대가 **나간** 대화를
// 「다시 열기」·「열기」와 함께 보여 주고, 지금 목록에 보이는 대화는 넣지 않는다. 낱말은 전부 코어(`dmVisibility.ts`)의 것이다.
// 재질은 길게 누르기 시트와 같다(`SheetRow`, 같은 바닥·손잡이·44pt 줄).
//
// 목록이 열린 채 비면(다른 기기에서 다시 열었다·새 메시지로 돌아왔다) 제목과 힌트만 남지 않게 빈 상태를 말한다.
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
  const insets = useSafeAreaInsets();
  const {height: windowHeight} = useWindowDimensions();
  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="dm-closed-sheet">
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel="닫은 대화 닫기"
          onPress={onClose}
          testID="dm-closed-backdrop"
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={DM_CLOSED_LIST_LABEL}
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, space.md),
              maxHeight: windowHeight * 0.85,
            },
          ]}>
          <View style={styles.grabber} />
          <ScrollView bounces={false} showsVerticalScrollIndicator testID="dm-closed-scroll">
            <View style={styles.head}>
              <Text style={styles.headTitle} accessibilityRole="header">
                {DM_CLOSED_LIST_LABEL}
              </Text>
              <Text style={styles.hint} testID="dm-closed-hint">
                {DM_CLOSED_LIST_HINT}
              </Text>
            </View>
            {error !== null ? (
              <Text accessibilityRole="alert" style={styles.error} testID="dm-closed-error">
                {error}
              </Text>
            ) : null}
            {items.length === 0 ? (
              <Text style={styles.empty} testID="dm-closed-empty">
                {DM_CLOSED_LIST_EMPTY}
              </Text>
            ) : null}
            {items.map(({entry, name}) => {
              const id = entry.channel.id;
              const busy = pendingId === id;
              const action = dmReopenLabelFor(entry.reason);
              return (
                <View
                  key={id}
                  style={styles.item}
                  testID={`dm-closed-item-${id}`}>
                  <View style={styles.itemText}>
                    <Text style={styles.name} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={styles.reason} numberOfLines={2}>
                      {dmClosedReasonLabel(entry.reason)}
                    </Text>
                  </View>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${name}, ${action}`}
                    accessibilityState={{busy}}
                    onPress={() => onReopen(entry)}
                    style={({pressed}) => [styles.action, pressed && styles.pressed]}
                    testID={`dm-closed-reopen-${id}`}>
                    <Text style={styles.actionLabel}>{action}</Text>
                  </Pressable>
                </View>
              );
            })}
            <View style={styles.separator} />
            <SheetRow label="닫기" tone="muted" onPress={onClose} testID="dm-closed-close" />
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
    head: {
      paddingBottom: space.md,
      gap: space.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    headTitle: {fontSize: font.label, color: color.text, fontWeight: '700'},
    // AA: `textFaint` 는 본문 대비 4.5 를 못 지난다 — 힌트는 뜻을 나르는 글자다.
    hint: {fontSize: font.meta, color: color.textMuted, lineHeight: line.label},
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: color.border,
      marginVertical: space.xs,
    },
    error: {
      paddingVertical: space.sm,
      fontSize: font.label,
      color: color.danger,
      lineHeight: line.label,
    },
    empty: {
      paddingVertical: space.md,
      fontSize: font.label,
      color: color.textMuted,
      lineHeight: line.label,
    },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      minHeight: TOUCH_TARGET,
      paddingVertical: space.sm,
    },
    itemText: {flex: 1, minWidth: 0},
    name: {fontSize: font.body, color: color.text},
    reason: {fontSize: font.meta, color: color.textMuted, lineHeight: line.label},
    action: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
    },
    actionLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
    pressed: {opacity: 0.6},
  });
