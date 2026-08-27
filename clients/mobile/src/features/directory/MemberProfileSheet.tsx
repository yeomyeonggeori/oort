import {
  dmAvailability,
  openDmErrorMessage,
  roleLabel,
  statusLabel,
  type RoleLabels,
} from '@momo/core/features/directory/model';
import type { RosterMember } from '@momo/core/lib/api';
import {
  memberFor,
  type Directory,
} from '@momo/core/features/workspace/directory';
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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { FailureBanner, NoticeBlock, PrimaryButton } from '../../design/atoms';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import { useStyles } from '../../design/theme';
import { Avatar } from '../conversation/Avatar';

// 사람/에이전트가 같은 `member`라는 제품 계약을 한 시트에서 그대로 보여 준다.
// 사람은 이 시트가 종착점이고, 에이전트는 기존 AgentDetailScreen으로 더 들어가는
// 문을 얻는다. 설정·관리 액션은 ADR-0137 D5 밖이므로 만들지 않는다.

export function MemberProfileSheet({
  member,
  directory,
  selfMemberId,
  online,
  dmPending,
  dmError,
  onClose,
  onOpenDm,
  onOpenAgent,
  roleLabels,
}: {
  member: RosterMember;
  directory: Directory;
  selfMemberId: string;
  online: boolean;
  dmPending: boolean;
  dmError: unknown | null;
  onClose: () => void;
  onOpenDm: () => void;
  onOpenAgent?: () => void;
  roleLabels?: RoleLabels;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const availability = dmAvailability(member, selfMemberId);
  const membershipStatus = statusLabel(member) ?? '활성';
  const role = roleLabel(member, roleLabels);
  const owner = member.ownerHumanId
    ? memberFor(directory, member.ownerHumanId)
    : null;
  const canOpenDm = availability.kind === 'ready' && online;

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      onRequestClose={onClose}
      testID="member-profile-sheet"
    >
      <View style={styles.root}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="프로필 닫기"
          onPress={onClose}
          style={styles.backdrop}
          testID="member-profile-backdrop"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              maxHeight: windowHeight * 0.85,
              paddingBottom: Math.max(insets.bottom, space.md),
            },
          ]}
        >
          <View style={styles.grabber} />
          <ScrollView bounces={false} showsVerticalScrollIndicator>
            <View style={styles.header}>
              <Avatar directory={directory} memberId={member.id} />
              <View style={styles.identity}>
                <Text
                  style={styles.name}
                  numberOfLines={2}
                  testID="profile-name"
                >
                  {member.displayName}
                </Text>
                <Text style={styles.handle} testID="profile-handle">
                  {`@${member.handle}`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="프로필 닫기"
                onPress={onClose}
                style={({ pressed }) => [
                  styles.close,
                  pressed && styles.pressed,
                ]}
                testID="member-profile-close"
              >
                <Text style={styles.closeLabel}>닫기</Text>
              </Pressable>
            </View>

            <View style={styles.facts}>
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>구분</Text>
                <Text
                  style={[
                    styles.factValue,
                    member.kind === 'agent' && styles.agentValue,
                  ]}
                  testID="profile-kind"
                >
                  {member.kind === 'agent' ? '에이전트' : '사람'}
                </Text>
              </View>
              <View style={styles.factRow}>
                <Text style={styles.factLabel}>상태</Text>
                <Text style={styles.factValue} testID="profile-status">
                  {membershipStatus}
                </Text>
              </View>
              {role ? (
                <View style={styles.factRow}>
                  <Text style={styles.factLabel}>역할</Text>
                  <Text style={styles.factValue}>{role}</Text>
                </View>
              ) : null}
              {member.kind === 'agent' ? (
                <View style={styles.factRow}>
                  <Text style={styles.factLabel}>관리</Text>
                  <Text style={styles.factValue}>
                    {owner
                      ? `${owner.displayName}님이 관리`
                      : '관리자 정보 없음'}
                  </Text>
                </View>
              ) : null}
            </View>

            <View style={styles.actions}>
              {member.kind === 'agent' && onOpenAgent ? (
                <PrimaryButton
                  label="에이전트 상세 보기"
                  onPress={onOpenAgent}
                  testID="profile-open-agent"
                />
              ) : null}

              {canOpenDm ? (
                <PrimaryButton
                  label="다이렉트 메시지 열기"
                  busyLabel="대화 여는 중"
                  busy={dmPending}
                  onPress={onOpenDm}
                  testID="profile-open-dm"
                />
              ) : availability.kind === 'self' ? (
                <NoticeBlock
                  headline="내 프로필입니다."
                  detail="자기 자신과는 다이렉트 메시지를 열 수 없습니다."
                  testID="profile-dm-unavailable"
                />
              ) : availability.kind === 'inactive' ? (
                <NoticeBlock
                  headline={`이 멤버는 ${availability.label} 상태입니다.`}
                  detail="활성 멤버가 되면 다이렉트 메시지를 열 수 있습니다."
                  testID="profile-dm-unavailable"
                />
              ) : (
                <NoticeBlock
                  headline="오프라인에서는 대화를 열 수 없습니다."
                  detail="연결이 돌아오면 다시 시도하세요."
                  testID="profile-dm-unavailable"
                />
              )}

              {dmError !== null ? (
                <FailureBanner
                  message={openDmErrorMessage(dmError, member.displayName)}
                  onRetry={canOpenDm && !dmPending ? onOpenDm : undefined}
                  testID="profile-dm-error"
                />
              ) : null}
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: { flex: 1, justifyContent: 'flex-end' },
    backdrop: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      backgroundColor: color.scrim,
    },
    sheet: {
      paddingHorizontal: SAFE_GUTTER,
      borderTopLeftRadius: radius.md,
      borderTopRightRadius: radius.md,
      backgroundColor: color.bg,
    },
    grabber: {
      alignSelf: 'center',
      width: TOUCH_TARGET,
      height: space.xs,
      marginVertical: space.sm,
      borderRadius: radius.pill,
      backgroundColor: color.border,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingBottom: space.lg,
    },
    identity: { flex: 1, minWidth: 0 },
    name: {
      fontSize: font.title,
      fontWeight: '700',
      color: color.text,
    },
    handle: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    close: {
      minWidth: TOUCH_TARGET,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    closeLabel: {
      fontSize: font.label,
      color: color.accentText,
      fontWeight: '600',
    },
    pressed: { backgroundColor: color.surfacePressed },
    facts: {
      paddingVertical: space.sm,
      borderTopWidth: 1,
      borderBottomWidth: 1,
      borderColor: color.border,
    },
    factRow: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
    },
    factLabel: {
      width: TOUCH_TARGET,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    factValue: {
      flex: 1,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    agentValue: { color: color.agent },
    actions: { gap: space.sm, paddingTop: space.lg },
  });
