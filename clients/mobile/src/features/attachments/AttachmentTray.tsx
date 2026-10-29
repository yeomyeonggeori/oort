import React, {useEffect, useRef} from 'react';
import {
  AccessibilityInfo,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  ATTACH_COPY,
  attachmentDisplayName,
  CLEAR_ALL_MIN_DRAFTS,
  draftAnnouncement,
  draftStatusLine,
  isImageMime,
  isRetryableIssue,
  sendBlockCopy,
  sendBlockReason,
  showsDraftThumbnail,
  splitFileName,
  uploadIssueCopy,
  uploadIssueNext,
  type AttachmentDraft,
  type UploadIssue,
} from '@momo/core/features/attachments/model';

import {draftPickedUri} from './draftStore';
import {
  ATTACHMENT_CHIP_THUMB,
  ATTACHMENT_TRAY_MAX_HEIGHT,
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {CONV} from '../conversation/convDesign';

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
          {/* 머리글은 없다 (#3820): 입력창 안의 칩은 목록 이름 없이도 첨부로 읽힌다.
              「모두 지우기」는 칩이 많을 때만 선다. */}
          {drafts.length >= CLEAR_ALL_MIN_DRAFTS ? (
            <View style={styles.heading}>
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
          ) : null}
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
          {(pickerIssue === 'permission-denied' ||
            pickerIssue === 'camera-permission-denied') &&
          pickerNext !== null ? (
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

/**
 * 칩 (#3820, Buzz 레퍼런스). 웹 트레이와 같은 규칙이다.
 *   이미지(정상·진행 중)  썸네일만 있는 둥근 정사각형. 이름·상태는 낭독 라벨에만.
 *   그 밖(파일·실패)      아이콘 + 짧은 이름 + 상태 한 줄. 실패면 다시 시도.
 * 진행 막대는 칩 아래 가장자리에 붙고, 자리(progress slot)는 늘 예약돼 있다.
 */
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
  const label = attachmentDisplayName(draft);
  const name = splitFileName(label);
  const retryable =
    draft.status === 'failed' &&
    draft.issue !== undefined &&
    isRetryableIssue(draft.issue);
  const uploading = draft.status === 'uploading';
  const statusText = `${status.text}${
    status.percent === null ? '' : ` ${status.percent}%`
  }`;
  const thumbUri =
    draft.status !== 'failed' && showsDraftThumbnail(draft)
      ? draftPickedUri(draft.localId)
      : undefined;

  const progress = (
    <View style={styles.progressSlot} testID="attachment-draft-progress-slot">
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
  );
  const remove = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label} ${ATTACH_COPY.remove}`}
      hitSlop={space.md}
      onPress={() => onRemove(draft.localId)}
      style={({pressed}) => [
        thumbUri !== undefined ? styles.removeOnThumb : styles.remove,
        pressed && styles.pressed,
      ]}
      testID="attachment-draft-remove"
    >
      <Text style={styles.removeLabel}>×</Text>
    </Pressable>
  );

  if (thumbUri !== undefined) {
    return (
      <View
        accessibilityLabel={`${label}. ${statusText}`}
        style={styles.thumbChip}
        testID="attachment-draft"
      >
        <Image
          source={{uri: thumbUri}}
          resizeMode="cover"
          style={[styles.thumbImage, uploading && styles.thumbBusy]}
          testID="attachment-draft-thumb"
        />
        {progress}
        {remove}
      </View>
    );
  }

  return (
    <View
      accessibilityLabel={`${label}. ${statusText}`}
      style={[styles.fileChip, draft.status === 'failed' && styles.fileChipFailed]}
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
          {statusText}
        </Text>
      </View>
      {retryable ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} ${ATTACH_COPY.retry}`}
          onPress={() => onRetry(draft.localId)}
          style={({pressed}) => [styles.retry, pressed && styles.pressed]}
          testID="attachment-draft-retry"
        >
          <Text style={styles.retryLabel}>{ATTACH_COPY.retry}</Text>
        </Pressable>
      ) : null}
      {remove}
      {progress}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {
      paddingHorizontal: CONV.composerDockInset,
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
    list: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
    listViewport: {maxHeight: ATTACHMENT_TRAY_MAX_HEIGHT},
    thumbChip: {
      width: ATTACHMENT_CHIP_THUMB,
      height: ATTACHMENT_CHIP_THUMB,
      overflow: 'hidden',
      borderRadius: radius.md,
      backgroundColor: color.surface,
    },
    thumbImage: {width: '100%', height: '100%'},
    thumbBusy: {opacity: 0.7},
    fileChip: {
      minHeight: ATTACHMENT_CHIP_THUMB,
      maxWidth: '100%',
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      overflow: 'hidden',
      paddingLeft: space.sm,
      borderRadius: radius.md,
      backgroundColor: color.surface,
    },
    fileChipFailed: {borderWidth: 1, borderColor: color.dangerText},
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
    progressSlot: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: space.xs,
    },
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
    // 썸네일 위의 ×: 28pt 면 + hitSlop 으로 44pt 를 채운다. 터치에는 호버가 없어 늘 보인다.
    removeOnThumb: {
      position: 'absolute',
      top: space.xs,
      right: space.xs,
      width: space.xl + space.xs,
      height: space.xl + space.xs,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      backgroundColor: color.bg,
    },
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
