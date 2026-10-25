import {
  channelActionClusterTitle,
  channelActionMenuLabel,
  type ChannelActionItem,
  type ChannelActionKey,
} from '@momo/core/features/channels/actionModel';
import {
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  channelLeaveConfirmBody,
} from '@momo/core/features/channels/model';
import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {font, line, radius, SHEET, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import type {ChannelRowTarget} from './channelRowActions';

// =============================================================================
// 행을 길게 누르면 열리는 시트 (#4229, Buzz식). 그릇·머리·행은 #4318 의 공용 부품이다.
//
// 항목은 이 파일이 정하지 않는다: 부르는 쪽이 코어 표(`channelRowActionItems`)의 답을 그대로 넘기고,
// 여기는 **그리기만** 한다 — 차례도, 「복사」 제목도, 묶음이 갈리는 자리도 코어가 준
// `cluster`/`separatorBefore` 를 따른다. 그래서 웹 행 메뉴와 같은 문장이 같은 차례로 읽힌다.
// 묶음 하나가 카드 하나이고, 제목이 있는 묶음은 카드 위에 섹션 라벨이 선다.
//
// ## 닫는 길
//
// 머리의 **원형 X**(옛 「닫기」 줄을 이어받아 `channel-sheet-close`), 스크림, 끌어내리기. 내용은 화면의
// 85% 안에서 스크롤하고 X 는 스크롤 밖이라 큰 글씨에서도 닿는다(메시지 시트 M-7 과 같은 이유).
//
// ## 나가기는 이 시트 안에서 확인한다
//
// 되돌릴 길이 없는 일(다시 들어오려면 관리자가 추가해야 한다)이라 한 단계를 더 둔다 — 메시지 시트의
// 지우기 확인과 같은 모양이다. 실패는 확인 단계 **안에서** 말한다(시트를 닫지 않는다).
// =============================================================================

interface Group {
  key: string;
  title: string | undefined;
  items: ChannelActionItem[];
}

/** 코어가 준 차례를 카드 묶음으로 자른다 — 제목이 바뀌거나 `separatorBefore` 면 새 카드다. */
function groupItems(items: ChannelActionItem[]): Group[] {
  const groups: Group[] = [];
  items.forEach((item, index) => {
    const startsCluster = index === 0 || items[index - 1].cluster !== item.cluster;
    if (startsCluster || item.separatorBefore) {
      groups.push({
        key: item.key,
        title: startsCluster ? channelActionClusterTitle(item.cluster) : undefined,
        items: [item],
      });
    } else {
      groups[groups.length - 1].items.push(item);
    }
  });
  return groups;
}

export function ChannelActionSheet({
  target,
  items,
  confirmingLeave,
  isPending,
  error,
  leave,
  onRun,
  onConfirmLeave,
  onCancelLeave,
  onClose,
}: {
  target: ChannelRowTarget;
  items: ChannelActionItem[];
  confirmingLeave: boolean;
  isPending: (key: ChannelActionKey) => boolean;
  error: string | null;
  leave: {pending: boolean; error: string | null};
  onRun: (key: ChannelActionKey) => void;
  onConfirmLeave: () => void;
  onCancelLeave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const isDm = target.channel.kind === 'dm';

  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={channelActionMenuLabel(target.title, target.channel)}
      scrimLabel="대화 액션 닫기"
      scrimTestID="channel-sheet-backdrop"
      testID="channel-action-sheet">
      <SheetHeader
        title={isDm ? target.title : `# ${target.title}`}
        titleTestID="channel-sheet-title"
        closeLabel="대화 액션 닫기"
        closeTestID="channel-sheet-close"
      />
      <SheetScroll testID="channel-sheet-scroll">
        {confirmingLeave ? (
          <>
            <GroupCard testID="channel-leave-confirm">
              <View style={styles.confirm}>
                <Text style={styles.confirmHeadline}>{CHANNEL_LEAVE_CONFIRM_TITLE}</Text>
                <Text style={styles.confirmDetail}>{channelLeaveConfirmBody(target.title)}</Text>
                {leave.error !== null ? (
                  <Text
                    accessibilityRole="alert"
                    style={styles.error}
                    testID="channel-leave-error">
                    {leave.error}
                  </Text>
                ) : null}
              </View>
            </GroupCard>
            <View style={styles.confirmRow}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="취소"
                onPress={onCancelLeave}
                style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
                testID="channel-leave-cancel">
                <Text style={styles.secondaryLabel}>취소</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={CHANNEL_LEAVE_LABEL}
                accessibilityState={{busy: leave.pending}}
                onPress={onConfirmLeave}
                style={({pressed}) => [styles.destructive, pressed && styles.pressed]}
                testID="channel-leave-confirm-button">
                <Text style={styles.destructiveLabel}>
                  {leave.pending ? '나가는 중…' : CHANNEL_LEAVE_LABEL}
                </Text>
              </Pressable>
            </View>
          </>
        ) : (
          <>
            {error !== null ? (
              <Text accessibilityRole="alert" style={styles.error} testID="channel-sheet-error">
                {error}
              </Text>
            ) : null}
            {groupItems(items).map(group => (
              <GroupCard key={group.key} label={group.title}>
                {group.items.map(item => {
                  const busy = isPending(item.key);
                  return (
                    <ListRow
                      key={item.key}
                      title={busy && item.busyLabel ? item.busyLabel : item.label}
                      tone={item.tone === 'danger' ? 'danger' : 'default'}
                      busy={busy}
                      onPress={() => onRun(item.key)}
                      testID={`channel-sheet-${item.testKey}`}
                    />
                  );
                })}
              </GroupCard>
            ))}
          </>
        )}
      </SheetScroll>
    </PageSheet>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    error: {fontSize: font.label, color: color.danger, lineHeight: line.label},
    confirm: {
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    confirmHeadline: {fontSize: font.body, color: color.text, fontWeight: '700'},
    confirmDetail: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    confirmRow: {flexDirection: 'row', gap: space.sm},
    secondary: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
    },
    secondaryLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
    destructive: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.dangerBorder,
      backgroundColor: color.dangerSurface,
    },
    destructiveLabel: {fontSize: font.label, color: color.danger, fontWeight: '700'},
    pressed: {opacity: 0.6},
  });
