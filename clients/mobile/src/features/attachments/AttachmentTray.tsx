import React from 'react';
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  ATTACH_COPY,
  draftStatusLine,
  isImageMime,
  isRetryableIssue,
  sendBlockCopy,
  splitFileName,
  uploadIssueCopy,
  uploadIssueNext,
  type AttachmentDraft,
  type UploadIssue,
} from '@momo/core/features/attachments/model';

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
              drafts.some(draft => draft.status === 'failed') &&
                styles.blockedFailed,
            ]}
            testID="attachment-blocked"
          >
            {blocked ?? ' '}
          </Text>
        </>
      ) : null}
      {pickerReason !== null ? (
        <View
          accessibilityLiveRegion="polite"
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
        {draft.status === 'uploading' ? (
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
            {status.percent === null ? null : (
              <View
                style={[styles.progressFill, {width: `${status.percent}%`}]}
              />
            )}
          </View>
        ) : null}
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
    listViewport: {maxHeight: TOUCH_TARGET * 5},
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
    progressTrack: {
      height: space.xs,
      overflow: 'hidden',
      borderRadius: radius.pill,
      backgroundColor: color.border,
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
