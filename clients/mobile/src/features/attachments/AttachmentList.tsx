import {
  ATTACH_COPY,
  attachmentDisplayName,
  attachmentMetaLine,
  imageGridColumns,
  isImageMime,
  showsInlinePreview,
  splitFileName,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import React, { useCallback, useState } from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type GestureResponderEvent,
} from 'react-native';
import {
  ATTACHMENT_INLINE_IMAGE,
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import { usePalette, useStyles } from '../../design/theme';
import { CONV_ICONS, CONV_ICON_SIZE } from '../../design/icons';
import { CONV } from '../conversation/convDesign';
import { useSession } from '../../session/useSession';
import { downloadAttachmentFile, useAttachmentPreview } from './content';

// =============================================================================
// 타임라인의 첨부 — 웹 컴포넌트를 공유하지 않고 폰 문법으로 번역한다 (#1681 · #3820).
//
// 모양은 두 가지다.
//   · 8MB 이하의 안전한 래스터 이미지: **테두리 없는 인라인 그림**. 한 장은 폭 280 ·
//     높이 320 안에서 비율을 지키고, 여러 장은 정사각 격자(2~4장 2열, 5장부터 3열).
//     파일명·타입·크기 줄이 없다. 탭하면 전체 화면 보기(좌우로 넘기고, 공유한다).
//   · SVG·큰 이미지·나머지 파일(PDF 포함): 컴팩트 카드. 탭하면 앱 캐시로 스트리밍한
//     파일을 iOS 공유시트에 넘긴다(공유시트가 미리보기와 저장을 함께 준다).
//
// 이름은 `attachmentDisplayName` 만 거친다: 무작위 토큰 같은 이름은 「이미지」
// 「PDF 문서」 「파일」로 갈음한다. 웹의 같은 이슈(#3820)와 같은 규칙이다.
//
// 앞 판의 16:9 고정 프레임은 **받는 동안의 자리**로만 남는다(도착하면 그림의 비율).
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

/** 안에 들어가는 그림 크기: 상한 안에서 비율을 지킨다. */
function fitInside(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function ImageTile({
  workspaceId,
  channelId,
  attachment,
  layout,
  gesture,
  onOpen,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  layout: 'single' | 'grid-2' | 'grid-3';
  gesture?: AttachmentGesture;
  onOpen: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const label = attachmentDisplayName(attachment);
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment,
    true,
  );
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);
  const uri = preview.status === 'ready' ? preview.uri : null;
  React.useEffect(() => {
    if (uri === null || layout !== 'single') return;
    Image.getSize(
      uri,
      (width, height) => setNatural({ width, height }),
      () => setNatural(null),
    );
  }, [uri, layout]);

  const tile =
    layout === 'grid-3'
      ? ATTACHMENT_INLINE_IMAGE.tileSmall
      : ATTACHMENT_INLINE_IMAGE.tile;
  const frameStyle =
    layout !== 'single'
      ? { width: tile, height: tile }
      : natural !== null
      ? fitInside(
          natural.width,
          natural.height,
          ATTACHMENT_INLINE_IMAGE.maxWidth,
          ATTACHMENT_INLINE_IMAGE.maxHeight,
        )
      : { width: ATTACHMENT_INLINE_IMAGE.maxWidth, aspectRatio: PREVIEW_ASPECT_RATIO };

  const onPress = (event?: GestureResponderEvent) => {
    event?.stopPropagation();
    if (gesture?.consumeTap()) return;
    onOpen();
  };

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`${label}, 크게 보기`}
      delayLongPress={gesture?.delayLongPress}
      onLongPress={gesture?.onLongPress}
      onPress={onPress}
      style={({ pressed }) => [styles.imageItem, pressed && styles.pressed]}
      testID="attachment-item"
    >
      <View
        style={[styles.previewFrame, frameStyle]}
        testID="attachment-preview"
        accessibilityLabel={
          preview.status === 'loading'
            ? ATTACH_COPY.previewLoading
            : preview.status === 'failed'
            ? ATTACH_COPY.previewFailed
            : label
        }
        accessibilityValue={{ text: preview.status }}
      >
        {preview.status === 'ready' ? (
          <Image
            source={{ uri: preview.uri }}
            resizeMode={layout === 'single' ? 'contain' : 'cover'}
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
    </Pressable>
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

/** 내려받아 iOS 공유시트에 넘긴다. 카드 탭과 전체 화면 보기의 「공유」가 같은 길이다. */
function useShareAttachment(
  workspaceId: string,
  channelId: string,
  attachment: MessageAttachment,
): [DownloadState, () => void] {
  const [download, setDownload] = useState<DownloadState>({ status: 'idle' });
  const start = useCallback(() => {
    if (download.status === 'downloading') return;
    setDownload({ status: 'downloading', progress: null });
    void downloadAttachmentFile(workspaceId, channelId, attachment, progress =>
      setDownload({ status: 'downloading', progress }),
    )
      .then(file =>
        Share.share({
          title: attachmentDisplayName(attachment),
          url: file.uri,
        }),
      )
      .then(() => setDownload({ status: 'idle' }))
      .catch(() => setDownload({ status: 'failed' }));
  }, [attachment, channelId, download.status, workspaceId]);
  return [download, start];
}

function FileCard({
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
  const palette = usePalette();
  const label = attachmentDisplayName(attachment);
  const [download, share] = useShareAttachment(
    workspaceId,
    channelId,
    attachment,
  );

  const onPress = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation();
      if (gesture?.consumeTap()) return;
      share();
    },
    [gesture, share],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${attachmentMetaLine(attachment)}, ${
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
        styles.fileCard,
        pressed && styles.pressed,
      ]}
      testID="attachment-item"
    >
      <View style={styles.fileIcon} testID="attachment-card-icon">
        {isImageMime(attachment.mime) ? (
          <Text style={styles.fileIconText}>▧</Text>
        ) : (
          <Image
            source={CONV_ICONS.file}
            style={[styles.fileGlyph, { tintColor: palette.textMuted }]}
          />
        )}
      </View>
      <View style={styles.metaRow}>
        <View style={styles.metaText}>
          <FileName name={label} />
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

/** 전체 화면 보기의 한 쪽. 쪽마다 자기 미리보기를 받는다. */
function ViewerPage({
  workspaceId,
  channelId,
  attachment,
  width,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  width: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment,
    true,
  );
  return (
    <View style={[styles.viewerPage, { width }]}>
      {preview.status === 'ready' ? (
        <Image
          source={{ uri: preview.uri }}
          resizeMode="contain"
          style={styles.viewerImage}
          accessibilityLabel={attachmentDisplayName(attachment)}
          testID="attachment-viewer-image"
        />
      ) : (
        <Text style={styles.viewerState}>
          {preview.status === 'loading'
            ? ATTACH_COPY.previewLoading
            : ATTACH_COPY.previewFailed}
        </Text>
      )}
    </View>
  );
}

function AttachmentViewer({
  workspaceId,
  channelId,
  images,
  startIndex,
  onClose,
}: {
  workspaceId: string;
  channelId: string;
  images: MessageAttachment[];
  startIndex: number;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const { width } = useWindowDimensions();
  const [index, setIndex] = useState(startIndex);
  const current = images[index] ?? images[0];
  const [download, share] = useShareAttachment(
    workspaceId,
    channelId,
    current as MessageAttachment,
  );
  return (
    <Modal
      visible
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.viewer} testID="attachment-viewer">
        <View style={styles.viewerBar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="닫기"
            onPress={onClose}
            style={({ pressed }) => [styles.viewerButton, pressed && styles.pressed]}
            testID="attachment-viewer-close"
          >
            <Text style={styles.viewerButtonLabel}>닫기</Text>
          </Pressable>
          {images.length > 1 ? (
            <Text style={styles.viewerPosition} testID="attachment-viewer-position">
              {`${index + 1} / ${images.length}`}
            </Text>
          ) : (
            <View />
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${ATTACH_COPY.download}, 공유하기`}
            onPress={share}
            style={({ pressed }) => [styles.viewerButton, pressed && styles.pressed]}
            testID="attachment-viewer-share"
          >
            <Text style={styles.viewerButtonLabel}>
              {download.status === 'downloading'
                ? ATTACH_COPY.downloading
                : download.status === 'failed'
                ? ATTACH_COPY.retry
                : '공유'}
            </Text>
          </Pressable>
        </View>
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: startIndex * width, y: 0 }}
          onMomentumScrollEnd={event =>
            setIndex(Math.round(event.nativeEvent.contentOffset.x / width))
          }
        >
          {images.map(image => (
            <ViewerPage
              key={image.id}
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={image}
              width={width}
            />
          ))}
        </ScrollView>
      </View>
    </Modal>
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
  const [viewing, setViewing] = useState<number | null>(null);
  if (attachments.length === 0) return null;
  const images = attachments.filter(showsInlinePreview);
  const files = attachments.filter(
    attachment => !showsInlinePreview(attachment),
  );
  const columns = imageGridColumns(images.length);
  const layout =
    columns === 1 ? 'single' : columns === 2 ? 'grid-2' : 'grid-3';
  return (
    <View style={[styles.list, muted && styles.muted]} testID="attachment-list">
      {images.length > 0 ? (
        <View style={styles.imageGroup} testID="attachment-image-group">
          {images.map((attachment, position) => (
            <ImageTile
              key={attachment.id}
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={attachment}
              layout={layout}
              gesture={gesture}
              onOpen={() => setViewing(position)}
            />
          ))}
        </View>
      ) : null}
      {files.map(attachment => (
        <FileCard
          key={attachment.id}
          workspaceId={workspaceId}
          channelId={channelId}
          attachment={attachment}
          gesture={gesture}
        />
      ))}
      {viewing !== null ? (
        <AttachmentViewer
          workspaceId={workspaceId}
          channelId={channelId}
          images={images}
          startIndex={viewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
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
    /**
     * 파일 카드 — 시안 A `.a-file{display:flex;gap:11px;background:var(--surface);
     * border-radius:16px;padding:10px 12px;box-shadow:var(--sh1);border:1px solid
     * var(--line);max-width:250px}` (DS2-4 #2716).
     */
    fileCard: {
      maxWidth: CONV.fileMaxWidth,
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.fileGap,
      paddingVertical: CONV.filePadY,
      paddingHorizontal: CONV.filePadX,
      borderRadius: CONV.fileRadius,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
    },
    pressed: { backgroundColor: color.surfacePressed },
    imageGroup: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
    imageItem: { borderRadius: radius.md },
    // 테두리 없음: 그림이 곧 내용이다(Buzz). 받는 동안만 중립 면이 자리를 지킨다.
    previewFrame: {
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: radius.md,
      backgroundColor: color.surface,
    },
    viewer: { flex: 1, backgroundColor: color.bg },
    viewerBar: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: space.md,
    },
    viewerButton: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
    },
    viewerButtonLabel: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    viewerPosition: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    viewerImage: { width: '100%', height: '100%' },
    viewerState: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    previewImage: { width: '100%', height: '100%' },
    previewState: {
      paddingHorizontal: space.md,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      textAlign: 'center',
    },
    /** 시안 `.a-file .tile{width:38px;height:38px;border-radius:11px;background:var(--surface2)}`. */
    fileIcon: {
      width: CONV.fileTile,
      height: CONV.fileTile,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: CONV.fileTileRadius,
      backgroundColor: color.surfaceMuted,
    },
    fileGlyph: { width: CONV_ICON_SIZE.file, height: CONV_ICON_SIZE.file },
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
    // 카드 전체가 누르는 자리라 이 표지는 따로 눌리지 않는다 — 44 상자가 아니라
    // 글리프 폭이면 된다(시안 250 폭 안에서 이름에 자리를 준다).
    downloadMark: {
      width: space.xl,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    downloadMarkText: { fontSize: font.title, color: color.textMuted },
  });
