import {
  attachmentDisplayName,
  attachmentMediaOf,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import { VideoView, type VideoPlayer } from 'expo-video';
import React, { useEffect } from 'react';
import {
  ActivityIndicator,
  type GestureResponderHandlers,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { GlassSurface, LiquidGlassAllowed } from '../../design/glass';
import { VIDEO_ICON_SIZE, VIDEO_ICONS } from '../../design/icons';
import { useStyles } from '../../design/theme';
import { font, line, radius, space, TOUCH_TARGET, type Palette } from '../../design/tokens';
import { useFormatMessage } from '../../i18n/useFormatMessage';
import { useVideoPlayback, type VideoController } from './useVideoPlayback';
import { PLAYBACK, useAttachmentPoster } from './videoContent';
import { LAYOUT, VIDEO_PLAYER } from './videoDesign';
import { VIEWER_GLASS_TONE, VIEWER_STAGE } from './viewerDesign';

// =============================================================================
// 전체 화면 보기의 영상 쪽 (#5208) — 사진 쪽(`ViewerPage`)의 영상 갈래.
//
// 사진 뷰어와 **같은 무대**에 선다: 쪽의 뿌리 `View`(`attachment-viewer-page`)가 쪽 응답자를 쥐고, 그래서 한 번 누르면 조작이 숨고
// 나타나며 아래로 쓸면 닫힌다(`AttachmentViewer.tsx` 머리말 「응답을 쥐는 자리」). 영상 화면(`VideoView`)은 `pointerEvents="none"` 으로
// 감싼다 — 네이티브 영상 뷰가 닿음을 삼키지 않게 한다. 확대는 없다(영상은 확대 스크롤뷰에 들어가지 않는다).
//
// ## 플레이어는 활성인 쪽 하나뿐이다
// pager 가 영상을 여러 장 들고 있어도 AVPlayer 는 지금 보는 쪽에만 있다(`active`). 다른 쪽은 포스터만 그린다. 쪽에서 쪽으로 넘기면
// 앞 쪽의 플레이어가 풀려 재생이 멈추고, 새 쪽이 서면 새 플레이어가 열린다. 아래 조작 줄(`VideoControls`)은 뷰어 프레임의 아래 덩어리에
// 서므로, 활성 쪽이 자기 플레이어와 조작 손잡이를 프레임에 알린다(`onActiveVideo`).
//
// 자동 재생은 **카드를 눌러 연 그 영상**만이다(`autoPlay`). 옆으로 넘겨 닿은 영상은 멈춰 서서 사람이 누르기를 기다린다 —
// 사진을 넘기다 소리가 터지지 않는다.
// =============================================================================

/** 활성 영상 쪽이 프레임에 내미는 것. 프레임의 아래 조작 줄이 읽는다. */
export interface ActiveVideoHandle {
  /** 이 손잡이를 낸 쪽의 첨부 id — 프레임은 지금 쪽의 손잡이일 때만 조작 줄을 세운다(쪽이 바뀌는 한 번의 그림에서 옛 플레이어를 읽지 않게). */
  attachmentId: string;
  player: VideoPlayer;
  controller: VideoController;
  /** 보낸 기기가 잰 길이(초) — 플레이어가 길이를 알려 주기 전의 막대 눈금. */
  durationHintSeconds: number;
}

function PosterLayer({
  uri,
  testID,
}: {
  uri: string | null;
  testID: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (uri === null) return null;
  return (
    <View pointerEvents="none" style={styles.fill}>
      <Image
        source={{ uri }}
        resizeMode="contain"
        style={styles.fill}
        testID={testID}
      />
    </View>
  );
}

function ActiveVideo({
  workspaceId,
  channelId,
  attachment,
  autoPlay,
  posterUri,
  onActiveVideo,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  autoPlay: boolean;
  posterUri: string | null;
  onActiveVideo: (handle: ActiveVideoHandle | null) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const media = attachmentMediaOf(attachment);
  const durationHintSeconds = media === null ? 0 : media.durationMs / 1000;
  const playback = useVideoPlayback({
    workspaceId,
    channelId,
    attachment,
    autoPlay,
    durationHintSeconds,
  });
  const { player, controller, phase, playing, firstFrame, markFirstFrame } = playback;

  useEffect(() => {
    onActiveVideo({ attachmentId: attachment.id, player, controller, durationHintSeconds });
    return () => onActiveVideo(null);
  }, [attachment.id, player, controller, durationHintSeconds, onActiveVideo]);

  const loading = phase === PLAYBACK.OPENING || (phase === PLAYBACK.READY && playing && !firstFrame);
  const failed = phase === PLAYBACK.FAILED;
  const gone = phase === PLAYBACK.GONE;

  return (
    <>
      {firstFrame ? null : <PosterLayer uri={posterUri} testID="attachment-viewer-video-poster" />}
      <View pointerEvents="none" style={styles.fill}>
        <VideoView
          player={player}
          nativeControls={false}
          contentFit="contain"
          allowsPictureInPicture={false}
          // 멈춘 장면에 iOS 가 「텍스트 가져오기」 단추를 얹지 않게 한다 — 영상 위의 정체 모를 시스템 단추이고 조작은 우리 것 하나뿐이다.
          allowsVideoFrameAnalysis={false}
          onFirstFrameRender={markFirstFrame}
          style={styles.fill}
          testID="attachment-viewer-video"
        />
      </View>
      {loading ? (
        <View pointerEvents="none" style={styles.center}>
          <ActivityIndicator
            color={VIEWER_STAGE.ink}
            accessibilityLabel={formatMessage('attachments.video.loading')}
            testID="attachment-viewer-video-loading"
          />
        </View>
      ) : null}
      {failed || gone ? (
        <View pointerEvents="box-none" style={styles.center}>
          <Text
            style={styles.status}
            accessibilityRole="alert"
            testID="attachment-viewer-video-status"
          >
            {formatMessage(gone ? 'attachments.video.gone' : 'attachments.video.failed')}
          </Text>
          {failed ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={formatMessage('attachments.video.retry')}
              onPress={controller.retry}
              style={({ pressed }) => [styles.retry, pressed && styles.retryPressed]}
              testID="attachment-viewer-video-retry"
            >
              <Text style={styles.retryText}>{formatMessage('attachments.video.retry')}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {phase === PLAYBACK.READY && !playing ? (
        <View pointerEvents="box-none" style={styles.center}>
          <LiquidGlassAllowed.Provider value={false}>
            <GlassSurface
              radius={VIDEO_PLAYER.center / 2}
              tone={VIEWER_GLASS_TONE}
              style={styles.centerGlass}
              testID="attachment-viewer-video-play-glass"
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={formatMessage('attachments.video.play')}
                onPress={controller.togglePlay}
                style={({ pressed }) => [styles.centerHit, pressed && styles.centerPressed]}
                testID="attachment-viewer-video-play"
              >
                <Image source={VIDEO_ICONS.playMark} style={styles.centerGlyph} />
              </Pressable>
            </GlassSurface>
          </LiquidGlassAllowed.Provider>
        </View>
      ) : null}
    </>
  );
}

/** 전체 화면 보기의 영상 한 쪽. 활성이면 플레이어가 서고, 아니면 포스터(없으면 재생 표지)만 그린다. */
export function VideoViewerPage({
  workspaceId,
  channelId,
  attachment,
  width,
  height,
  responder,
  blankResponder,
  active,
  autoPlay,
  onActiveVideo,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  width: number;
  height: number;
  /** 쪽 위에 닿은 손가락을 쥐는 핸들러 — 사진 쪽과 같다. */
  responder: GestureResponderHandlers;
  /** 쪽 둘레 빈 곳에 닿은 손가락을 쥐는 핸들러 — 사진 쪽과 같다. */
  blankResponder: GestureResponderHandlers;
  active: boolean;
  autoPlay: boolean;
  onActiveVideo: (handle: ActiveVideoHandle | null) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const posterUri = useAttachmentPoster(workspaceId, channelId, attachment, true);

  return (
    <View style={{ width, height }} {...blankResponder}>
      <View
        style={[styles.page, { width, height }]}
        // 레이아웃 속성만 있는 View 는 평탄화되어 네이티브 뷰가 사라질 수 있다 — 그러면 닿는 대상이 못 된다.
        collapsable={false}
        accessible={!active}
        accessibilityLabel={attachmentDisplayName(attachment)}
        testID="attachment-viewer-page"
        {...responder}
      >
        {active ? (
          <ActiveVideo
            workspaceId={workspaceId}
            channelId={channelId}
            attachment={attachment}
            autoPlay={autoPlay}
            posterUri={posterUri}
            onActiveVideo={onActiveVideo}
          />
        ) : (
          <>
            <PosterLayer uri={posterUri} testID="attachment-viewer-video-poster" />
            {posterUri !== null ? null : (
              <View pointerEvents="none">
                <Image source={VIDEO_ICONS.playMark} style={styles.idleGlyph} />
              </View>
            )}
          </>
        )}
      </View>
    </View>
  );
}

const buildStyles = (_color: Palette) =>
  StyleSheet.create({
    page: LAYOUT.centered,
    fill: LAYOUT.fill,
    center: {
      ...LAYOUT.fill,
      ...LAYOUT.centered,
      gap: space.md,
    },
    status: {
      paddingHorizontal: space.xl,
      fontSize: font.label,
      lineHeight: line.label,
      color: VIEWER_STAGE.ink,
      ...LAYOUT.textMiddle,
    },
    retry: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.lg,
      ...LAYOUT.centered,
      borderRadius: radius.pill,
      backgroundColor: VIEWER_GLASS_TONE.fallback,
    },
    retryPressed: { backgroundColor: VIEWER_STAGE.pressedFill },
    retryText: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: VIEWER_STAGE.ink,
    },
    centerGlass: { width: VIDEO_PLAYER.center, height: VIDEO_PLAYER.center },
    centerHit: {
      width: VIDEO_PLAYER.center,
      height: VIDEO_PLAYER.center,
      ...LAYOUT.centered,
      borderRadius: radius.pill,
    },
    centerPressed: { backgroundColor: VIEWER_STAGE.pressedFill },
    centerGlyph: {
      width: VIDEO_ICON_SIZE.playMark,
      height: VIDEO_ICON_SIZE.playMark,
      tintColor: VIEWER_STAGE.ink,
    },
    idleGlyph: {
      width: VIDEO_ICON_SIZE.playMark,
      height: VIDEO_ICON_SIZE.playMark,
      tintColor: VIEWER_STAGE.inkMuted,
    },
  });
