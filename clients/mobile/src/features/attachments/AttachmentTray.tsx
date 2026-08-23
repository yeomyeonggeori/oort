import React, {useEffect, useRef} from 'react';
import {
  AccessibilityInfo,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  ATTACH_COPY,
  draftAnnouncement,
  draftStatusLine,
  isImageMime,
  isRetryableIssue,
  sendBlockCopy,
  sendBlockReason,
  splitFileName,
  uploadIssueCopy,
  uploadIssueNext,
  type AttachmentDraft,
  type UploadIssue,
} from '@momo/core/features/attachments/model';

import {
  ATTACHMENT_TRAY_MAX_HEIGHT,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';

export function AttachmentTray({
  drafts,
  pickerIssue,
  onRemove,
  onRetry,
  onClear,
}: {
  drafts: AttachmentDraft[];
  pickerIssue: UploadIssue | null;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onClear: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const blocked = sendBlockCopy(drafts);
  const blockReason = sendBlockReason(drafts);

  // 보조기술이 듣는 줄 (design-review High-2). `accessibilityLiveRegion`은
  // Android 전용이라 이 앱의 1차 플랫폼(iOS)에서는 어떤 전이도 낭독되지
  // 않았다. 코어 `draftAnnouncement`가 정확히 이 용도로 **바뀐 것만** 문장으로
  // 만들고(웹 트레이가 같은 함수를 소비한다), 폰의 전달 관례는 형제들처럼
  // `announceForAccessibility`다 — 소리로만 전달된다, RN에는 웹의 `focus()`가
  // 없다(ApprovalDecision.tsx와 같은 이유).
  const announcedDrafts = useRef<AttachmentDraft[]>([]);
  useEffect(() => {
    const sentence = draftAnnouncement(announcedDrafts.current, drafts);
    announcedDrafts.current = drafts;
    if (sentence !== null) AccessibilityInfo.announceForAccessibility(sentence);
  }, [drafts]);

  // picker 사유(선택 취소·권한 거부)는 draft가 되기 전의 실패라 위 문장에
  // 실리지 않는다 — 같은 채널로 따로 말한다. 사유가 걷히는 전이는 침묵한다.
  const announcedPickerIssue = useRef<UploadIssue | null>(null);
  useEffect(() => {
    if (pickerIssue === announcedPickerIssue.current) return;
    announcedPickerIssue.current = pickerIssue;
    if (pickerIssue === null) return;
    const next = uploadIssueNext(pickerIssue);
    AccessibilityInfo.announceForAccessibility(
      next === null
        ? uploadIssueCopy(pickerIssue)
        : `${uploadIssueCopy(pickerIssue)}. ${next}`,
    );
  }, [pickerIssue]);

  if (drafts.length === 0 && pickerIssue === null) return null;

  const pickerReason =
    pickerIssue === null ? null : uploadIssueCopy(pickerIssue);
  const pickerNext = pickerIssue === null ? null : uploadIssueNext(pickerIssue);

  return (
    <View style={styles.root} testID="attachment-tray">
      {drafts.length > 0 ? (
        <>
          <View style={styles.heading}>
            <Text
              style={styles.title}
            >{`${ATTACH_COPY.tray} ${drafts.length}`}</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={ATTACH_COPY.clearAll}
              onPress={onClear}
              style={({pressed}) => [styles.clear, pressed && styles.pressed]}
              testID="attachment-clear"
            >
              <Text style={styles.clearLabel}>{ATTACH_COPY.clearAll}</Text>
            </Pressable>
          </View>
          <ScrollView
            style={styles.listViewport}
            showsVerticalScrollIndicator
            contentContainerStyle={styles.list}
            testID="attachment-tray-list"
          >
            {drafts.map(draft => (
              <DraftRow
                key={draft.localId}
                draft={draft}
                onRemove={onRemove}
                onRetry={onRetry}
              />
            ))}
          </ScrollView>
          <Text
            style={[
              styles.blocked,
              blockReason === 'failed' && styles.blockedFailed,
            ]}
            testID="attachment-blocked"
          >
            {blocked ?? ' '}
          </Text>
        </>
      ) : null}
      {pickerReason !== null ? (
        <View
          style={styles.pickerNotice}
          testID={`attachment-picker-issue-${pickerIssue}`}
        >
          <Text
            style={[
              styles.pickerReason,
              pickerIssue !== 'selection-cancelled' && styles.pickerWarning,
            ]}
          >
            {pickerReason}
          </Text>
          {pickerIssue === 'permission-denied' && pickerNext !== null ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pickerNext}
              onPress={() => void Linking.openSettings()}
              style={({pressed}) => [
                styles.settings,
                pressed && styles.pressed,
              ]}
              testID="attachment-open-settings"
            >
              <Text style={styles.settingsLabel}>{pickerNext}</Text>
            </Pressable>
          ) : pickerNext !== null ? (
            <Text style={styles.pickerNext}>{pickerNext}</Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function DraftRow({
  draft,
  onRemove,
  onRetry,
}: {
  draft: AttachmentDraft;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const status = draftStatusLine(draft);
  const name = splitFileName(draft.name);
  const retryable =
    draft.status === 'failed' &&
    draft.issue !== undefined &&
    isRetryableIssue(draft.issue);
  const uploading = draft.status === 'uploading';
  return (
    <View
      accessibilityLabel={`${draft.name}. ${status.text}${
        status.percent === null ? '' : ` ${status.percent}%`
      }`}
      style={styles.draft}
      testID="attachment-draft"
    >
      <View style={styles.icon}>
        <Text style={styles.iconText}>
          {isImageMime(draft.mime) ? '▧' : '▤'}
        </Text>
      </View>
      <View style={styles.draftText}>
        <View style={styles.nameRow}>
          <Text style={styles.nameHead} numberOfLines={1}>
            {name.head}
          </Text>
          {name.tail ? <Text style={styles.nameTail}>{name.tail}</Text> : null}
        </View>
        <Text
          style={[styles.status, status.danger && styles.statusDanger]}
          testID="attachment-draft-status"
        >
          {`${status.text}${
            status.percent === null ? '' : ` ${status.percent}%`
          }`}
        </Text>
        {/* 웹 쌍둥이와 같은 자리 예약. 상태가 바뀌어도 이 4pt가 나타났다 사라지며
            행 높이를 흔들지 않는다. 실제 트랙은 uploading에서만 보인다. */}
        <View
          style={styles.progressSlot}
          testID="attachment-draft-progress-slot"
        >
          {uploading ? (
            <View
              accessibilityRole="progressbar"
              accessibilityValue={
                status.percent === null
                  ? {text: ATTACH_COPY.uploading}
                  : {min: 0, max: 100, now: status.percent}
              }
              style={styles.progressTrack}
              testID="attachment-draft-progress"
            >
              {status.percent === null ? (
                // 가운데 조각은 왼쪽에서 잰 비율이 아니다. 첫 native 측정 전의
                // 값 없음(indeterminate)을 빈 트랙이나 0%로 오독하지 않게 한다.
                <View
                  style={styles.progressIndeterminate}
                  testID="attachment-draft-progress-indeterminate"
                />
              ) : (
                <View
                  style={[styles.progressFill, {width: `${status.percent}%`}]}
                  testID="attachment-draft-progress-fill"
                />
              )}
            </View>
          ) : null}
        </View>
      </View>
      {retryable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${draft.name} ${ATTACH_COPY.retry}`}
          onPress={() => onRetry(draft.localId)}
          style={({pressed}) => [styles.retry, pressed && styles.pressed]}
          testID="attachment-draft-retry"
        >
          <Text style={styles.retryLabel}>{ATTACH_COPY.retry}</Text>
        </Pressable>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${draft.name} ${ATTACH_COPY.remove}`}
        onPress={() => onRemove(draft.localId)}
        style={({pressed}) => [styles.remove, pressed && styles.pressed]}
        testID="attachment-draft-remove"
      >
        <Text style={styles.removeLabel}>×</Text>
      </Pressable>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
      gap: space.xs,
    },
    heading: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: space.sm,
    },
    title: {
      fontSize: font.meta,
      lineHeight: line.meta,
      fontWeight: '700',
      color: color.textMuted,
    },
    clear: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    clearLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      textDecorationLine: 'underline',
    },
    list: {gap: space.xs},
    listViewport: {maxHeight: ATTACHMENT_TRAY_MAX_HEIGHT},
    draft: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingVertical: space.xs,
    },
    icon: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      backgroundColor: color.surface,
    },
    iconText: {fontSize: font.title, color: color.textMuted},
    draftText: {flex: 1, minWidth: 0, gap: space.xs},
    nameRow: {flexDirection: 'row', minWidth: 0},
    nameHead: {
      flexShrink: 1,
      minWidth: 0,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    nameTail: {
      flexShrink: 0,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    status: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    statusDanger: {color: color.dangerText},
    progressSlot: {height: space.xs},
    progressTrack: {
      height: '100%',
      width: '100%',
      overflow: 'hidden',
      borderRadius: radius.pill,
      backgroundColor: color.border,
    },
    progressIndeterminate: {
      width: '36%',
      height: '100%',
      alignSelf: 'center',
      borderRadius: radius.pill,
      backgroundColor: color.accent,
    },
    progressFill: {
      height: '100%',
      borderRadius: radius.pill,
      backgroundColor: color.accent,
    },
    retry: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: color.border,
    },
    retryLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
    },
    remove: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    removeLabel: {fontSize: font.title, color: color.textMuted},
    blocked: {
      minHeight: line.meta,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    blockedFailed: {color: color.warn},
    pickerNotice: {gap: space.xs},
    pickerReason: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    pickerWarning: {color: color.warn},
    pickerNext: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    settings: {
      minHeight: TOUCH_TARGET,
      alignSelf: 'flex-start',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    settingsLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.accentText,
      textDecorationLine: 'underline',
    },
    pressed: {backgroundColor: color.surfacePressed},
  });
