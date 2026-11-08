import {
  ATTACH_COPY,
  attachmentDisplayName,
  attachmentImageSizeOf,
  attachmentMediaOf,
  attachmentMetaLine,
  formatVideoDuration,
  imageGridColumns,
  isImageMime,
  isInAppPlayableVideo,
  isVideoAttachment,
  showsInlinePreview,
  splitFileName,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import React, { useCallback, useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import {
  ATTACHMENT_INLINE_IMAGE,
  font,
  line,
  radius,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import { usePalette, useStyles } from '../../design/theme';
import {
  CONV_ICONS,
  CONV_ICON_SIZE,
  VIDEO_ICON_SIZE,
  VIDEO_ICONS,
} from '../../design/icons';
import { useFormatMessage } from '../../i18n/useFormatMessage';
import { CONV } from '../conversation/convDesign';
import type { LongPressTiming } from '../conversation/useLongPress';
import { useSession } from '../../session/useSession';
import {
  measuredAttachmentSize,
  rememberAttachmentSize,
  useAttachmentPreview,
  type MeasuredSize,
} from './content';
import { AttachmentViewer } from './AttachmentViewer';
import { VideoPosterCard } from './VideoPosterCard';
import {useHeroSources} from './heroSource';
import type {StageRect} from '@momo/core/lib/stageTransition';
import { saveNoticeKey, useSaveAttachment, type SaveAttachment } from './useSaveAttachment';
import { useShareAttachment, type DownloadState } from './useShareAttachment';

// =============================================================================
// 타임라인의 첨부 — 웹 컴포넌트를 공유하지 않고 폰 문법으로 번역한다 (#1681 · #3820).
//
// 모양은 두 가지다.
//   · 8MB 이하의 안전한 래스터 이미지: **테두리 없는 인라인 그림**. 한 장은 폭 280 ·
//     높이 320 안에서 비율을 지키고, 여러 장은 정사각 격자(2~4장 2열, 5장부터 3열).
//     파일명·타입·크기 줄이 없다. 탭하면 전체 화면 보기(좌우로 넘기고, 공유한다).
//   · SVG·큰 이미지·나머지 파일(PDF 포함): 컴팩트 카드. 탭하면 앱 캐시로 스트리밍한
//     파일을 iOS 공유시트에 넘긴다(「공유」 — 앞 판 그대로). 오른쪽 ↓ 는 **「저장」** 이다(#5209):
//     사진·영상은 사진 보관함에 바로 추가하고, 그 밖의 파일은 파일 앱에서 위치를 골라 거기에 복사한다.
//   · 영상(mp4·mov·m4v, #5208): 앱 안에서 바로 재생한다. 보낸 기기가 포스터를 만들었으면 **포스터 카드**(`VideoPosterCard.tsx` —
//     사진처럼 테두리 없는 그림, 한가운데 재생 표지, 오른쪽 아래 길이), 아니면 파일 카드의 모양에 **영상기 아이콘 · 길이 · ▶**.
//     탭하면 사진과 같은 전체 화면 보기에서 구간 읽기로 재생이 시작된다(사진과 섞인 묶음은 한 줄로 넘긴다). 앱이 못 읽는 영상(WebM)만
//     위 파일 카드로 남는다(아이콘은 영상기다 — 문서 아이콘이 아니다): 탭은 공유시트, ↓ 는 파일 앱(보관함이 WebM 을 못 받는다). 재생되는 영상의
//     「저장」은 전체 화면 보기의 [저장]이 맡는다(#5209) — 그 카드에는 ↓ 가 없고 ▶ 가 선다.
//
// 이름은 `attachmentDisplayName` 만 거친다: 무작위 토큰 같은 이름은 「이미지」
// 「PDF 문서」 「파일」로 갈음한다. 웹의 같은 이슈(#3820)와 같은 규칙이다.
//
// 앞 판의 16:9 고정 프레임은 **받는 동안의 자리**로만 남는다(도착하면 그림의 비율). 한 번 잰 그림은 새 마운트가 첫
// 프레임부터 그 비율로 선다 — 보낸 사진의 메아리가 서버 사본으로 바뀌는 순간 행이 줄었다 자라지 않게(`content.ts` 의
// 「잰 크기」, #4455).
//
// **처음 보는 사진도 첫 프레임부터 제 칸이다**(ADR-0151 증보 9, #5469): 보내는 기기가 가로세로를 선언해 서버가 `media: {kind: "image"}` 로
// 싣는다. 선언은 **그림이 오기 전까지의 칸**일 뿐이다 — 상태에는 **잰 크기**만 두고, 칸은 `잰 크기 ?? 선언` 이다. 그래서 ① 선언은 잰 크기
// 기억(`content.ts`·기기)에 **쓰이지 않고**(틀린 선언이 기억으로 굳지 않는다), ② 그림을 읽으면(`Image.getSize`·`onLoad`) 실제 크기가 이기며
// (선언과 같으면 칸은 움직이지 않는다), ③ 못 재면 선언으로 남는다. 선언이 없으면(옛 메시지·옛 판이 보낸 사진) 위와 같다.
// =============================================================================

const PREVIEW_ASPECT_RATIO = 16 / 9;

export interface AttachmentGesture {
  onLongPress: () => void;
  /** 행과 같은 한 쌍(칠하기 지연 + 길게 누르기) — `Pressable` 에 그대로 펼친다(#4664). */
  pressTiming: LongPressTiming;
  consumeTap: () => boolean;
}

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
  registerSource,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  layout: 'single' | 'grid-2' | 'grid-3';
  gesture?: AttachmentGesture;
  onOpen: () => void;
  registerSource: (id: string, node: View | null) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const label = attachmentDisplayName(attachment);
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment,
    true,
  );
  // 비율은 **첫 프레임부터** 알아야 한다(#4455 design-review r2 H2). 이 그림을 이미 잰 마운트가 있으면(보낸 사진의 메아리가
  // 서버 사본으로 바뀔 때, 화면 밖에서 돌아온 행, 다시 들어온 방) 그 크기로 곧바로 서고, 못 쟀을 때만 16:9 자리표시로 선다.
  // 효과에서 읽으면 한 프레임 늦어서 새 마운트가 16:9 로 한 번 선다 — 그 한 프레임이 곧 행이 53~163pt 줄었다 자라는 이음매다.
  //
  // 처음 보는 그림은 **보낸 기기의 선언**(`attachmentImageSizeOf`: 서버가 범위만 보고 저장한 값을 다시 범위로 막고, 이미지 첨부일 때만)이
  // 첫 프레임의 칸이다(ADR-0151 증보 9). 선언은 상태에 넣지도 잰 크기 기억에 적지도 않는다: 상태(`measured`)는 **잰 값**만 담고 칸은
  // `measured ?? declared` 로 매 렌더 셈한다. 그래서 잰 값(기억·`getSize`·`onLoad`)이 늘 선언을 이기고, 재기가 실패해 `measured` 가 비어도
  // 선언으로 돌아갈 뿐 16:9 로 되튀지 않는다.
  const [measured, setMeasured] = useState<MeasuredSize | null>(() =>
    measuredAttachmentSize(attachment.id),
  );
  const declared = attachmentImageSizeOf(attachment);
  const natural: MeasuredSize | null = measured ?? declared;
  const uri = preview.status === 'ready' ? preview.uri : null;
  React.useEffect(() => {
    if (uri === null) return undefined;
    const known = measuredAttachmentSize(attachment.id);
    if (known !== null) {
      // 잰 값이 있으면 다시 재지 않는다 — 같은 그림의 크기는 바뀌지 않는다. 마운트 뒤에 다른 타일이 먼저 쟀을 수도 있어서
      // 상태는 맞춰 둔다(같은 객체면 갱신이 곧 끝난다).
      setMeasured(known);
      return undefined;
    }
    let live = true;
    Image.getSize(
      uri,
      (width, height) => {
        const size = rememberAttachmentSize(attachment.id, width, height);
        if (live) setMeasured(size);
      },
      () => {
        if (live) setMeasured(null);
      },
    );
    return () => {
      live = false;
    };
  }, [uri, layout, attachment.id]);

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
      {...gesture?.pressTiming}
      onLongPress={gesture?.onLongPress}
      onPress={onPress}
      style={({ pressed }) => [styles.imageItem, pressed && styles.pressed]}
      testID="attachment-item"
    >
      <View
        ref={node => registerSource(attachment.id, node)}
        collapsable={false}
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
            onLoad={event => {
              const {width, height} = event.nativeEvent.source;
              setMeasured(rememberAttachmentSize(attachment.id, width, height));
            }}
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
  saving,
  lastBy,
  onRetrySave,
  gesture,
}: {
  state: DownloadState;
  saving: SaveAttachment;
  /** 마지막으로 누른 것 — 카드(공유)와 ↓(저장)의 상태가 한 줄을 나눠 쓴다. */
  lastBy: 'save' | 'share';
  /** 저장 실패 줄을 누르면 하는 일 — ↓ 와 같은 저장이다(`FileCard` 의 `onSave`). */
  onRetrySave: (event?: GestureResponderEvent) => void;
  gesture?: AttachmentGesture;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const savedLast = lastBy === 'save';
  const key = savedLast ? saveNoticeKey(saving.state) : null;
  if (key !== null) {
    const text = formatMessage(key);
    // 「· 동사」 줄은 누르면 그 일을 한다(#5273): 거부 → 설정 열기, 실패 → 다시 저장. 나머지(하는 중·영수증)는 읽기만 한다.
    // 저장 실패 줄을 눌러도 카드가 쥐고 있던 탭(공유 시트)이 열리지 않는다 — 이 줄이 탭을 쥔다.
    if (saving.state.status === 'denied') {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text}
          hitSlop={{ top: slopTo(line.meta), bottom: slopTo(line.meta) }}
          onPress={saving.openSettings}
          testID="attachment-save-settings"
        >
          <Text style={styles.downloadIdle} testID="attachment-save-status">
            {text}
          </Text>
        </Pressable>
      );
    }
    if (saving.state.status === 'failed') {
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={text}
          hitSlop={{ top: slopTo(line.meta), bottom: slopTo(line.meta) }}
          // ↓ 와 같은 규율: 길게 누르기는 메시지 메뉴의 것이고, 그 뒤에 따라오는 탭은 저장을 시작하지 않는다(`onSave`).
          {...gesture?.pressTiming}
          onLongPress={gesture?.onLongPress}
          onPress={onRetrySave}
          testID="attachment-save-retry"
        >
          <Text style={styles.downloadFailed} testID="attachment-save-status">
            {text}
          </Text>
        </Pressable>
      );
    }
    return (
      <Text style={styles.downloadBusy} testID="attachment-save-status">
        {text}
      </Text>
    );
  }
  // 마지막으로 ↓ 를 눌렀으면 이 줄은 저장의 것이다. 앞서 공유가 남긴 실패(`state`)는 저장의 영수증이 걷힌 뒤에 되살아나지 않는다.
  if (savedLast) {
    return (
      <Text style={styles.downloadIdle} testID="attachment-download-idle">
        {ATTACH_COPY.download}
      </Text>
    );
  }
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

function FileCard({
  workspaceId,
  channelId,
  attachment,
  gesture,
  onPlay,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  gesture?: AttachmentGesture;
  /** 앱 안에서 재생하는 영상일 때만 온다 — 누르면 공유시트 대신 전체 화면 재생이 열린다(#5208). */
  onPlay?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const label = attachmentDisplayName(attachment);
  const [download, share] = useShareAttachment(
    workspaceId,
    channelId,
    attachment,
  );
  const saving = useSaveAttachment(workspaceId, channelId, attachment);
  const { save: startSave } = saving;
  const [lastBy, setLastBy] = useState<'save' | 'share'>('share');
  const savingNow = saving.state.status === 'working';
  const busy = download.status === 'downloading' || savingNow;
  const saveLabel = formatMessage(
    saving.route === 'photos'
      ? 'mobile.attachmentSave.toPhotos'
      : 'mobile.attachmentSave.toFiles',
  );
  const isVideo = isVideoAttachment(attachment);

  const onPress = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation();
      if (gesture?.consumeTap()) return;
      if (onPlay !== undefined) {
        onPlay();
        return;
      }
      if (savingNow) return;
      setLastBy('share');
      share();
    },
    [gesture, onPlay, savingNow, share],
  );
  // ↓ 는 「저장」이다(#5209). 카드 탭(공유)과 같은 규율: 길게 누르기는 메시지 메뉴의 것이고, 그 뒤에 따라오는 탭은 행동을 시작하지 않는다.
  // 앱 안에서 재생하는 영상 카드에는 ↓ 가 없다(▶ 가 선다) — 그 영상의 저장은 전체 화면 보기의 [저장]이다.
  const onSave = useCallback(
    (event?: GestureResponderEvent) => {
      event?.stopPropagation();
      if (gesture?.consumeTap()) return;
      if (busy) return;
      setLastBy('save');
      startSave();
    },
    [busy, gesture, startSave],
  );
  const duration = attachmentMediaOf(attachment);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        onPlay !== undefined
          ? duration === null
            ? formatMessage('attachments.video.cardLabelNoDuration', { name: label })
            : formatMessage('attachments.video.cardLabel', {
                name: label,
                duration: formatVideoDuration(duration.durationMs),
              })
          : `${label}, ${attachmentMetaLine(attachment)}, ${
              download.status === 'failed'
                ? `${ATTACH_COPY.downloadFailed}, ${ATTACH_COPY.retry}`
                : download.status === 'downloading'
                ? ATTACH_COPY.downloading
                : `${ATTACH_COPY.download}, 공유하기`
            }`
      }
      // 안쪽 ↓ 단추는 VoiceOver 에 따로 서지 않는다(카드가 하나의 요소다) — 저장은 로터의 동작으로 간다. 재생 카드에는 ↓ 가 없어 동작도 없다.
      accessibilityActions={onPlay === undefined ? [{ name: 'save', label: saveLabel }] : undefined}
      onAccessibilityAction={event => {
        if (event.nativeEvent.actionName === 'save') onSave();
      }}
      accessibilityState={{ busy }}
      {...gesture?.pressTiming}
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
        ) : isVideo ? (
          // 영상은 문서 아이콘이 아니다(#5208). 포스터가 없는 영상도 영상기로 읽힌다.
          <Image
            source={VIDEO_ICONS.video}
            style={[styles.videoGlyph, { tintColor: palette.textMuted }]}
            testID="attachment-card-video-icon"
          />
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
          {onPlay === undefined ? (
            <DownloadStatus
              state={download}
              saving={saving}
              lastBy={lastBy}
              onRetrySave={onSave}
              gesture={gesture}
            />
          ) : null}
        </View>
        {onPlay !== undefined ? (
          <View style={styles.downloadMark}>
            <Image
              source={VIDEO_ICONS.play}
              style={[styles.playGlyph, { tintColor: palette.textMuted }]}
              testID="attachment-card-play"
            />
          </View>
        ) : (
          <Pressable
            accessibilityLabel={saveLabel}
            accessibilityRole="button"
            accessibilityState={{ busy: savingNow, disabled: busy }}
            disabled={busy}
            hitSlop={{ left: slopTo(space.xl), right: slopTo(space.xl) }}
            {...gesture?.pressTiming}
            onLongPress={gesture?.onLongPress}
            onPress={onSave}
            style={styles.downloadMark}
            testID="attachment-card-save"
          >
            <Text style={styles.downloadMarkText}>
              {savingNow
                ? '…'
                : saving.state.status === 'saved'
                ? '✓'
                : download.status === 'downloading'
                ? '…'
                : download.status === 'failed'
                ? '↻'
                : '↓'}
            </Text>
          </Pressable>
        )}
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
  senderName,
  sentAtMs,
}: {
  channelId: string;
  attachments: MessageAttachment[];
  muted?: boolean;
  gesture?: AttachmentGesture;
  /** 이 메시지를 보낸 사람 — 사진을 열면 뷰어 위쪽 띠에 선다(#4297). */
  senderName?: string;
  /** 이 메시지를 보낸 시각(ms) — 이름 아래 날짜·시각이 된다. */
  sentAtMs?: number;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const { workspaceId } = useSession();
  const [viewing, setViewing] = useState<{index: number; origin: StageRect | null; pending: boolean} | null>(null);
  const sources = useHeroSources();
  if (attachments.length === 0) return null;
  const images = attachments.filter(showsInlinePreview);
  // 앱 안에서 재생하는 영상(mp4·mov)은 자기 카드를 갖는다. WebM 같은 나머지 영상은 파일 카드와 공유시트로 남는다(#5208).
  const videos = attachments.filter(isInAppPlayableVideo);
  const files = attachments.filter(
    attachment =>
      !showsInlinePreview(attachment) && !isInAppPlayableVideo(attachment),
  );
  // 전체 화면 보기가 넘기는 순서는 화면에 선 순서다: 사진 격자 → 영상 카드. 사진과 영상이 섞인 묶음도 한 줄로 넘긴다.
  const viewables = [...images, ...videos];
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
              registerSource={sources.register}
              onOpen={() => {
                // Present immediately; native measurement prepares only the floating picture.
                const opening = {index: position, origin: null, pending: sources.has(attachment.id)};
                setViewing(opening);
                if (opening.pending) void sources.measure(attachment.id).then(origin => {
                  setViewing(current => current === opening ? {...opening, origin, pending: false} : current);
                });
              }}
            />
          ))}
        </View>
      ) : null}
      {videos.map((attachment, position) => {
        const open = () =>
          setViewing({ index: images.length + position, origin: null, pending: false });
        return attachmentMediaOf(attachment)?.hasPoster === true ? (
          <VideoPosterCard
            key={attachment.id}
            workspaceId={workspaceId}
            channelId={channelId}
            attachment={attachment}
            gesture={gesture}
            onOpen={open}
          />
        ) : (
          <FileCard
            key={attachment.id}
            workspaceId={workspaceId}
            channelId={channelId}
            attachment={attachment}
            gesture={gesture}
            onPlay={open}
          />
        );
      })}
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
          images={viewables}
          startIndex={viewing.index}
          origin={viewing.origin}
          originPending={viewing.pending}
          measureSource={sources.has(viewables[viewing.index]?.id ?? '') ? sources.measure : undefined}
          senderName={senderName}
          sentAtMs={sentAtMs}
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
    // 테두리 없음: 그림이 곧 내용이다(Buzz). 중립 면은 그림이 서기 전의 자리를 지킨다 — 받는 동안, 그리고 **새로 마운트된 이미지 뷰의 첫
    // 프레임**(네이티브 첫 페인트는 한 프레임 늦다, 8~23ms). 보낸 사진이 서버 사본으로 바뀔 때 눈에 보이는 프레임에 이 면이 드러나지 않게
    // 서버 사본을 먼저 마운트해 둔다(`sendArrival.ts` 「사진은 서버 사본을 먼저 마운트해 두고」, #4455).
    previewFrame: {
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
      borderRadius: radius.md,
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
    videoGlyph: { width: VIDEO_ICON_SIZE.video, height: VIDEO_ICON_SIZE.video },
    playGlyph: { width: VIDEO_ICON_SIZE.play, height: VIDEO_ICON_SIZE.play },
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
    // ↓ 는 「저장」 단추다(#5209): 카드 전체(공유)와 따로 눌린다. 높이는 44 이고 폭은 글리프 폭이다 — 가로 44 는 `hitSlop` 이 채운다
    // (시안 250 폭 안에서 이름에 자리를 준다).
    downloadMark: {
      width: space.xl,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    downloadMarkText: { fontSize: font.title, color: color.textMuted },
  });
