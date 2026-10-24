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
import type {ChannelRowTarget} from './channelRowActions';

// =============================================================================
// 행을 길게 누르면 열리는 시트 (#4229, Buzz식).
//
// 항목은 이 파일이 정하지 않는다: 부르는 쪽이 코어 표(`channelRowActionItems`)의 답을
// 그대로 넘기고, 여기는 **그리기만** 한다 — 차례도, 「복사」 제목도, 구분선이 서는 자리도
// 코어가 준 `cluster`/`separatorBefore` 를 따른다. 그래서 웹 행 메뉴와 같은 문장이 같은
// 차례로 읽힌다.
//
// 재질은 메시지 액션 시트와 같다(`SheetRow`, 같은 바닥·손잡이·44pt 줄). 시트 규칙
// 전반(#4318)이 서기 전이라 그 시트의 껍데기를 그대로 따르고, 규칙이 서면 둘이 함께 옮겨 간다.
//
// ## 나가기는 이 시트 안에서 확인한다
//
// 되돌릴 길이 없는 일(다시 들어오려면 관리자가 추가해야 한다)이라 한 단계를 더 둔다 — 메시지
// 시트의 지우기 확인과 같은 모양이다. 실패는 확인 단계 **안에서** 말한다(시트를 닫지 않는다).
// =============================================================================

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
  const insets = useSafeAreaInsets();
  // 시트는 스크롤한다: 접근성 글꼴에서 줄이 자라도 「닫기」까지 닿아야 한다(메시지 시트 M-7 과 같은 이유).
  const {height: windowHeight} = useWindowDimensions();
  const isDm = target.channel.kind === 'dm';

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="channel-action-sheet">
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel="대화 액션 닫기"
          onPress={onClose}
          testID="channel-sheet-backdrop"
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={channelActionMenuLabel(target.title, target.channel)}
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, space.md),
              maxHeight: windowHeight * 0.85,
            },
          ]}>
          <View style={styles.grabber} />
          <ScrollView bounces={false} showsVerticalScrollIndicator testID="channel-sheet-scroll">
            <View style={styles.head}>
              <Text style={styles.headTitle} numberOfLines={1} testID="channel-sheet-title">
                {isDm ? target.title : `# ${target.title}`}
              </Text>
            </View>

            {confirmingLeave ? (
              <View style={styles.confirm} testID="channel-leave-confirm">
                <Text style={styles.confirmHeadline}>{CHANNEL_LEAVE_CONFIRM_TITLE}</Text>
                <Text style={styles.confirmDetail}>
                  {channelLeaveConfirmBody(target.title)}
                </Text>
                {leave.error !== null ? (
                  <Text
                    accessibilityRole="alert"
                    style={styles.error}
                    testID="channel-leave-error">
                    {leave.error}
                  </Text>
                ) : null}
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
              </View>
            ) : (
              <>
                {error !== null ? (
                  <Text accessibilityRole="alert" style={styles.error} testID="channel-sheet-error">
                    {error}
                  </Text>
                ) : null}
                {items.map((item, index) => {
                  const clusterTitle = channelActionClusterTitle(item.cluster);
                  const startsCluster =
                    index === 0 || items[index - 1].cluster !== item.cluster;
                  const busy = isPending(item.key);
                  return (
                    <React.Fragment key={item.key}>
                      {item.separatorBefore ? <View style={styles.separator} /> : null}
                      {clusterTitle !== undefined && startsCluster ? (
                        <Text style={styles.clusterTitle} accessibilityRole="header">
                          {clusterTitle}
                        </Text>
                      ) : null}
                      <SheetRow
                        label={busy && item.busyLabel ? item.busyLabel : item.label}
                        tone={item.tone === 'danger' ? 'danger' : 'default'}
                        busy={busy}
                        onPress={() => onRun(item.key)}
                        testID={`channel-sheet-${item.testKey}`}
                      />
                    </React.Fragment>
                  );
                })}
                <View style={styles.separator} />
                <SheetRow
                  label="닫기"
                  tone="muted"
                  onPress={onClose}
                  testID="channel-sheet-close"
                />
              </>
            )}
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
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    headTitle: {fontSize: font.label, color: color.text, fontWeight: '700'},
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: color.border,
      marginVertical: space.xs,
    },
    // AA: `textFaint` 는 본문 대비 4.5 를 못 지난다 — 제목은 뜻을 나르는 글자다.
    clusterTitle: {
      paddingTop: space.sm,
      fontSize: font.meta,
      color: color.textMuted,
      fontWeight: '600',
    },
    error: {
      paddingVertical: space.sm,
      fontSize: font.label,
      color: color.danger,
      lineHeight: line.label,
    },
    confirm: {paddingTop: space.md, gap: space.sm},
    confirmHeadline: {fontSize: font.body, color: color.text, fontWeight: '700'},
    confirmDetail: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    confirmRow: {flexDirection: 'row', gap: space.sm, paddingTop: space.xs},
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
