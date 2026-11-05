import React, {useCallback, useEffect, useRef} from 'react';
import {
  AccessibilityInfo,
  Image,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
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
  type UploadReasonFor,
} from '@momo/core/features/attachments/model';
import {uploadReasonKey} from '@momo/core/features/connection/uploadFailure';

import {draftPickedUri} from './draftStore';
import {
  ATTACHMENT_CHIP_THUMB,
  ATTACHMENT_TRAY_MAX_HEIGHT,
  font,
  line,
  radius,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {CONV} from '../conversation/convDesign';

/**
 * 입력창 첨부 미리보기 (#5325). **알약 안**, 글 줄 위에 선다 — 사진은 작은 썸네일 한 줄(많으면 가로로 민다), 파일·실패는 같은 줄의 칩이다.
 * 옛 판은 알약 **밖**(입력창 위 도크 줄, 아래 머리카락 선)이라 owner 가 「입력창을 눌러도 입력창 안에는 없다」고 보았다.
 * `inset` 은 알약 안쪽 좌우 여백 — 글 칸의 글자 왼쪽에 맞춘다(Composer 가 `INPUT_TEXT_LEFT` 를 건넨다). 모르면 도크 가장자리(8).
 */
export function AttachmentTray({
  drafts,
  pickerIssue,
  onRemove,
  onRetry,
  onClear,
  inset = CONV.composerDockInset,
}: {
  drafts: AttachmentDraft[];
  pickerIssue: UploadIssue | null;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onClear: () => void;
  inset?: number;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const blocked = sendBlockCopy(drafts);
  const blockReason = sendBlockReason(drafts);
  // 파일·실패 칩은 가로 줄 안에서도 **줄 폭 하나**를 쓴다(이름·상태 문장이 좁은 칸에서 네 줄로 접히지 않게). 줄 폭 = 창 − 알약의 바깥 여백(도크 가장자리) − 안쪽 좌우 `inset`. 다음 칩은 오른쪽에서 비쳐 민다.
  const {width: windowWidth} = useWindowDimensions();
  const fileWidth = Math.max(
    PILL_THUMB,
    windowWidth - 2 * CONV.composerDockInset - 2 * inset,
  );

  // 보조기술이 듣는 줄 (design-review High-2). `accessibilityLiveRegion`은
  // Android 전용이라 이 앱의 1차 플랫폼(iOS)에서는 어떤 전이도 낭독되지
  // 않았다. 코어 `draftAnnouncement`가 정확히 이 용도로 **바뀐 것만** 문장으로
  // 만들고(웹 트레이가 같은 함수를 소비한다), 폰의 전달 관례는 형제들처럼
  // `announceForAccessibility`다 — 소리로만 전달된다, RN에는 웹의 `focus()`가
  // 없다(ApprovalDecision.tsx와 같은 이유).
  const reasonFor = useUploadReasonFor();
  const announcedDrafts = useRef<AttachmentDraft[]>([]);
  useEffect(() => {
    const sentence = draftAnnouncement(announcedDrafts.current, drafts, reasonFor);
    announcedDrafts.current = drafts;
    if (sentence !== null) AccessibilityInfo.announceForAccessibility(sentence);
  }, [drafts, reasonFor]);

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
    <View
      style={[styles.root, {paddingHorizontal: inset}]}
      testID="attachment-tray">
      {drafts.length > 0 ? (
        <>
          {/* 머리글은 없다 (#3820): 입력창 안의 칩은 목록 이름 없이도 첨부로 읽힌다.
              「모두 지우기」는 칩이 많을 때만 선다. */}
          {drafts.length >= CLEAR_ALL_MIN_DRAFTS ? (
            <View style={styles.heading}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={ATTACH_COPY.clearAll}
                hitSlop={slopTo(line.meta)}
                onPress={onClear}
                style={({pressed}) => [styles.clear, pressed && styles.pressed]}
                testID="attachment-clear"
              >
                <Text style={styles.clearLabel}>{ATTACH_COPY.clearAll}</Text>
              </Pressable>
            </View>
          ) : null}
          {/* 가로 한 줄. 자판이 올라온 채로도 ✕ 가 첫 탭에 눌려야 하므로 `always` 다 — 기본(`never`)이면 자판이 올라온 때의 첫 탭은 자판만 내리고 자식에게 안 온다. */}
          <ScrollView
            horizontal
            style={styles.listViewport}
            showsHorizontalScrollIndicator={false}
            keyboardShouldPersistTaps="always"
            contentContainerStyle={styles.list}
            testID="attachment-tray-list"
          >
            {drafts.map(draft => (
              <DraftRow
                key={draft.localId}
                draft={draft}
                fileWidth={fileWidth}
                onRemove={onRemove}
                onRetry={onRetry}
              />
            ))}
          </ScrollView>
          {/* 보낼 수 없는 까닭이 있을 때만 선다(알약 안이라 빈 줄을 늘 잡아 두면 글 줄 위가 휑하다). */}
          {blocked !== null ? (
            <Text
              style={[
                styles.blocked,
                blockReason === 'failed' && styles.blockedFailed,
              ]}
              testID="attachment-blocked"
            >
              {blocked}
            </Text>
          ) : null}
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
  fileWidth,
  onRemove,
  onRetry,
}: {
  draft: AttachmentDraft;
  fileWidth: number;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const reasonFor = useUploadReasonFor();
  const status = draftStatusLine(draft, reasonFor);
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
      // 썸네일 위 ✕ 는 작은 원(`REMOVE_FACE`)이고 눌리는 면은 hitSlop 이 44 로 채운다(#5325). 파일 칩의 ✕ 는 44 면 그대로다.
      hitSlop={thumbUri !== undefined ? slopTo(REMOVE_FACE) : undefined}
      onPress={() => onRemove(draft.localId)}
      style={({pressed}) => [
        thumbUri !== undefined ? styles.removeOnThumb : styles.remove,
        pressed && styles.pressed,
      ]}
      testID="attachment-draft-remove"
    >
      <Text
        style={thumbUri !== undefined ? styles.removeGlyphOnThumb : styles.removeLabel}
      >
        ×
      </Text>
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
      style={[
        styles.fileChip,
        {width: fileWidth},
        draft.status === 'failed' && styles.fileChipFailed,
      ]}
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

/**
 * 실패한 칩의 이유를 **원인의 분류 문장**으로 갈아 끼운다(#5222): 오프라인·서버에 닿지 못함이면 사전의 그 문장을, 아니면 `undefined`(칩의 기존
 * 문장). 상태 코드는 문장에 없다. 눈에 보이는 줄과 낭독이 같은 길을 쓴다(웹 트레이의 `useUploadReasonFor` 와 같다).
 */
function useUploadReasonFor(): UploadReasonFor {
  const formatMessage = useFormatMessage();
  return useCallback(
    (draft: AttachmentDraft) => {
      const key = uploadReasonKey(draft.failureCause);
      return key === null ? undefined : formatMessage(key);
    },
    [formatMessage],
  );
}

/**
 * 알약 안 썸네일 한 변 — 도크 줄 시절의 칩(`ATTACHMENT_CHIP_THUMB` 64, 웹과 짝인 값이라 건드리지 않는다)보다 한 칸(`space.sm`) 작다. 입력창 위 **한 줄**이라 글 줄을 밀어내지 않는 크기다.
 */
const PILL_THUMB = ATTACHMENT_CHIP_THUMB - space.sm;
/** 썸네일 모서리 ✕ 의 보이는 지름(옛 28). 누르는 면은 `slopTo` 가 44 로 채운다. */
const REMOVE_FACE = space.lg + space.xs;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 알약 안: 도크 줄의 아래 머리카락 선·좌우 8 은 없다(좌우는 `inset` 이 정한다). 위는 알약 윗면과 썸네일 사이 숨, 아래는 바로 글 줄(입력창 자기 여백이 숨을 준다).
    root: {
      paddingTop: space.md,
      paddingBottom: space.xs,
      gap: space.xs,
    },
    heading: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: space.sm,
    },
    title: {
      fontSize: font.meta,
      lineHeight: line.meta,
      fontWeight: '700',
      color: color.textMuted,
    },
    clear: {
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    clearLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      textDecorationLine: 'underline',
    },
    list: {flexDirection: 'row', alignItems: 'flex-start', gap: space.sm},
    listViewport: {maxHeight: ATTACHMENT_TRAY_MAX_HEIGHT, flexGrow: 0},
    thumbChip: {
      width: PILL_THUMB,
      height: PILL_THUMB,
      overflow: 'hidden',
      borderRadius: radius.md,
      backgroundColor: color.surface,
    },
    thumbImage: {width: '100%', height: '100%'},
    thumbBusy: {opacity: 0.7},
    fileChip: {
      minHeight: PILL_THUMB,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      overflow: 'hidden',
      // 알약 안의 둥근 칩이라 글이 테두리에 붙지 않게 위아래 숨을 둔다(옛 도크 줄에서는 이름 줄이 윗선에 닿아 있었다).
      paddingVertical: space.xs,
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
    // 썸네일 모서리의 ×: 작은 원(`REMOVE_FACE`) + hitSlop 으로 44pt 를 채운다(#5325, 옛 28pt 면은 owner 가 「너무 크다」). 터치에는 호버가 없어 늘 보인다.
    removeOnThumb: {
      position: 'absolute',
      top: space.xs,
      right: space.xs,
      width: REMOVE_FACE,
      height: REMOVE_FACE,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
      backgroundColor: color.bg,
    },
    // 작은 원 안의 글자: 원 지름에 맞춘 줄 상자 — 원 한가운데에 앉는다.
    removeGlyphOnThumb: {
      fontSize: font.label,
      lineHeight: REMOVE_FACE,
      textAlign: 'center',
      color: color.text,
    },
    blocked: {
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
