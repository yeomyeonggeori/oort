import {
  ATTACH_COPY,
  attachmentMetaLine,
  isImageMime,
  showsInlinePreview,
  splitFileName,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import React, { useCallback, useState } from 'react';
import {
  Image,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import {
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import { useStyles } from '../../design/theme';
import { useSession } from '../../session/useSession';
import { downloadAttachmentFile, useAttachmentPreview } from './content';

// =============================================================================
// 타임라인의 첨부 — 웹 컴포넌트를 공유하지 않고 폰 문법으로 번역한다 (#1681).
//
// 모양은 두 가지뿐이다. 8MB 이하의 안전한 래스터 이미지는 16:9 고정 프레임,
// SVG·큰 이미지·나머지 파일은 카드다. 모든 모양은 같은 이름/메타/다운로드 상태를
// 가지며, 탭하면 앱 캐시로 스트리밍한 파일을 iOS 공유시트에 넘긴다.
// =============================================================================

const PREVIEW_ASPECT_RATIO = 16 / 9;

export interface AttachmentGesture {
  onLongPress: () => void;
  delayLongPress: number;
  consumeTap: () => boolean;
}

type DownloadState =
  | { status: 'idle' }
  | { status: 'downloading'; progress: number | null }
  | { status: 'failed' };

function FileName({ name }: { name: string }): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const parts = splitFileName(name);
  return (
    <View style={styles.fileNameRow}>
      <Text style={styles.fileNameHead} numberOfLines={1}>
        {parts.head}
      </Text>
      {parts.tail ? (
        <Text style={styles.fileNameTail}>{parts.tail}</Text>
      ) : null}
    </View>
  );
}

function Preview({
  workspaceId,
  channelId,
  attachment,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment,
    true,
  );

  return (
    <View
      style={styles.previewFrame}
      testID="attachment-preview"
      accessibilityLabel={
        preview.status === 'loading'
          ? ATTACH_COPY.previewLoading
          : preview.status === 'failed'
          ? ATTACH_COPY.previewFailed
          : attachment.name
      }
      accessibilityValue={{ text: preview.status }}
    >
      {preview.status === 'ready' ? (
        <Image
          source={{ uri: preview.uri }}
          resizeMode="contain"
          style={styles.previewImage}
          testID="attachment-preview-image"
        />
      ) : (
        <Text
          style={styles.previewState}
          testID={`attachment-preview-${preview.status}`}
        >
          {preview.status === 'loading'
            ? ATTACH_COPY.previewLoading
            : ATTACH_COPY.previewFailed}
        </Text>
      )}
    </View>
  );
}

function DownloadStatus({
  state,
}: {
  state: DownloadState;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  if (state.status === 'downloading') {
    const percent =
      state.progress === null ? null : Math.round(state.progress * 100);
    return (
      <Text style={styles.downloadBusy} testID="attachment-downloading">
        {percent === null
          ? ATTACH_COPY.downloading
          : `${ATTACH_COPY.downloading} ${percent}%`}
      </Text>
    );
  }
  if (state.status === 'failed') {
    return (
      <Text style={styles.downloadFailed} testID="attachment-download-failed">
        {`${ATTACH_COPY.downloadFailed} · ${ATTACH_COPY.retry}`}
      </Text>
    );
  }
  return (
    <Text style={styles.downloadIdle} testID="attachment-download-idle">
      {ATTACH_COPY.download}
    </Text>
  );
}

function AttachmentItem({
  workspaceId,
  channelId,
  attachment,
  gesture,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  gesture?: AttachmentGesture;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const inline = showsInlinePreview(attachment);
  const [download, setDownload] = useState<DownloadState>({ status: 'idle' });

  const onPress = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation();
      if (gesture?.consumeTap()) return;
      if (download.status === 'downloading') return;
      setDownload({ status: 'downloading', progress: null });
      void downloadAttachmentFile(
        workspaceId,
        channelId,
        attachment,
        progress => setDownload({ status: 'downloading', progress }),
      )
        .then(file =>
          Share.share({
            title: attachment.name,
            url: file.uri,
          }),
        )
        .then(() => setDownload({ status: 'idle' }))
        .catch(() => setDownload({ status: 'failed' }));
    },
    [attachment, channelId, download.status, gesture, workspaceId],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${attachment.name}, ${attachmentMetaLine(
        attachment,
      )}, ${
        download.status === 'failed'
          ? `${ATTACH_COPY.downloadFailed}, ${ATTACH_COPY.retry}`
          : download.status === 'downloading'
          ? ATTACH_COPY.downloading
          : `${ATTACH_COPY.download}, 공유하기`
      }`}
      accessibilityState={{ busy: download.status === 'downloading' }}
      delayLongPress={gesture?.delayLongPress}
      onLongPress={gesture?.onLongPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.item,
        !inline && styles.fileCard,
        pressed && styles.pressed,
      ]}
      testID="attachment-item"
    >
      {inline ? (
        <Preview
          workspaceId={workspaceId}
          channelId={channelId}
          attachment={attachment}
        />
      ) : (
        <View style={styles.fileIcon} testID="attachment-card-icon">
          <Text style={styles.fileIconText}>
            {isImageMime(attachment.mime) ? '▧' : '▤'}
          </Text>
        </View>
      )}
      <View style={styles.metaRow}>
        <View style={styles.metaText}>
          <FileName name={attachment.name} />
          <Text style={styles.fileMeta} testID="attachment-meta">
            {attachmentMetaLine(attachment)}
          </Text>
          <DownloadStatus state={download} />
        </View>
        <View style={styles.downloadMark}>
          <Text style={styles.downloadMarkText}>
            {download.status === 'downloading'
              ? '…'
              : download.status === 'failed'
              ? '↻'
              : '↓'}
          </Text>
        </View>
      </View>
    </Pressable>
  );
}

/** 한 메시지의 첨부 전부. 빈 배열이면 어떤 자리도 만들지 않는다. */
export function AttachmentList({
  channelId,
  attachments,
  muted,
  gesture,
}: {
  channelId: string;
  attachments: MessageAttachment[];
  muted?: boolean;
  gesture?: AttachmentGesture;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const { workspaceId } = useSession();
  if (attachments.length === 0) return null;
  return (
    <View style={[styles.list, muted && styles.muted]} testID="attachment-list">
      {attachments.map(attachment => (
        <AttachmentItem
          key={attachment.id}
          workspaceId={workspaceId}
          channelId={channelId}
          attachment={attachment}
          gesture={gesture}
        />
      ))}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    list: { paddingTop: space.xs, gap: space.sm },
    muted: { opacity: 0.7 },
    item: {
      width: '100%',
      minHeight: TOUCH_TARGET,
      borderRadius: radius.md,
    },
    fileCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      padding: space.sm,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    pressed: { backgroundColor: color.surfacePressed },
    previewFrame: {
      width: '100%',
      aspectRatio: PREVIEW_ASPECT_RATIO,
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    previewImage: { width: '100%', height: '100%' },
    previewState: {
      paddingHorizontal: space.md,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      textAlign: 'center',
    },
    fileIcon: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
      backgroundColor: color.surfacePressed,
    },
    fileIconText: { fontSize: font.title, color: color.textMuted },
    metaRow: {
      flex: 1,
      minWidth: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingTop: space.xs,
    },
    metaText: { flex: 1, minWidth: 0 },
    fileNameRow: { flexDirection: 'row', minWidth: 0 },
    fileNameHead: {
      flexShrink: 1,
      minWidth: 0,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    fileNameTail: {
      flexShrink: 0,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    fileMeta: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    downloadIdle: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.accentText,
    },
    downloadBusy: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    downloadFailed: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.danger,
    },
    downloadMark: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    downloadMarkText: { fontSize: font.title, color: color.textMuted },
  });
