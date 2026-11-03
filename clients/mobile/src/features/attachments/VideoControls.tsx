import { formatVideoDuration } from '@momo/core/features/attachments/model';
import type { VideoPlayer } from 'expo-video';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Image,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
  type LayoutChangeEvent,
} from 'react-native';
import { BAR_CONTROL_MAX_SCALE } from '../../design/atoms';
import { VIDEO_ICON_SIZE, VIDEO_ICONS } from '../../design/icons';
import { useStyles } from '../../design/theme';
import { font, line, radius, type Palette } from '../../design/tokens';
import { useFormatMessage } from '../../i18n/useFormatMessage';
import { GlassButton } from './GlassButton';
import type { VideoController } from './useVideoPlayback';
import { ADJUST_ACTIONS, LAYOUT, VIDEO_PLAYER } from './videoDesign';
import { listenToPlayer } from './videoPlayerEvents';
import { VIEWER_STAGE, VIEWER_TEXT_SHADOW } from './viewerDesign';

// =============================================================================
// 전체 화면 영상의 아래 조작 줄 (#5208): [재생·멈춤]  0:12  ━━●━━━  0:42  [소리].
//
// 뷰어의 아래 조작 덩어리 안에 서므로 조작이 숨고 나타날 때·쓸어 닫을 때 사진 조작과 같이 움직인다. 슬라이더 부품을 새로 들이지
// 않는다(새 의존 없음): 진행 막대는 `View` 한 장의 응답자(`onResponder*`)다.
//
// 이 줄은 플레이어를 **읽기만** 한다(위치·길이·재생·소리는 플레이어의 사건에서 온다). 쓰는 것은 전부 `controller` 를 거친다 — 재생 의도(자동
// 복구가 되돌릴 값)는 훅 한 곳이 쥔다. 그래서 이 줄이 다시 그려져도 뷰어 전체가 다시 그려지지 않는다(뷰어는 `player`·`controller` 두 참조만 안다).
// =============================================================================

interface Snapshot {
  position: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  ended: boolean;
}

function read(player: VideoPlayer): Snapshot {
  return {
    position: player.currentTime,
    duration: player.duration,
    playing: player.playing,
    muted: player.muted,
    ended: false,
  };
}

/** 플레이어의 위치·길이·재생·소리를 구독한다. 구독은 이 줄이 서 있는 동안만이다. */
function usePlayerSnapshot(
  player: VideoPlayer,
): [Snapshot, React.Dispatch<React.SetStateAction<Snapshot>>] {
  const [snapshot, setSnapshot] = useState<Snapshot>(() => read(player));
  useEffect(
    () =>
      listenToPlayer(player, {
        timeUpdate: ({ currentTime }) =>
          setSnapshot(current => ({ ...current, position: currentTime, duration: player.duration })),
        playingChange: ({ isPlaying }) =>
          setSnapshot(current => ({ ...current, playing: isPlaying, ended: isPlaying ? false : current.ended })),
        mutedChange: ({ muted }) => setSnapshot(current => ({ ...current, muted })),
        sourceLoad: ({ duration }) => setSnapshot(current => ({ ...current, duration })),
        playToEnd: () => setSnapshot(current => ({ ...current, playing: false, ended: true })),
      }),
    [player],
  );
  return [snapshot, setSnapshot];
}

const clamp01 = (value: number): number => (Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0);

const clockOf = (seconds: number): string =>
  formatVideoDuration((Number.isFinite(seconds) ? seconds : 0) * 1000);

export function VideoControls({
  player,
  controller,
  durationHintSeconds,
}: {
  player: VideoPlayer;
  controller: VideoController;
  /** 보낸 기기가 잰 길이(초). 플레이어가 길이를 알려 주기 전의 막대 눈금이다. */
  durationHintSeconds: number;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const [snapshot, setSnapshot] = usePlayerSnapshot(player);
  const duration =
    Number.isFinite(snapshot.duration) && snapshot.duration > 0 ? snapshot.duration : durationHintSeconds;

  // 끄는 동안의 위치(0~1). 손가락을 놓을 때 한 번만 옮긴다 — 움직일 때마다 옮기면 플레이어가 매번 새로 읽는다.
  const [scrub, setScrub] = useState<number | null>(null);
  const scrubRef = useRef<number | null>(null);
  const trackWidth = useRef(0);
  const onTrackLayout = useCallback((event: LayoutChangeEvent) => {
    trackWidth.current = event.nativeEvent.layout.width;
  }, []);
  const fractionOf = useCallback((event: GestureResponderEvent): number | null => {
    if (trackWidth.current <= 0) return null;
    return clamp01(event.nativeEvent.locationX / trackWidth.current);
  }, []);
  const onGrant = useCallback(
    (event: GestureResponderEvent) => {
      const next = fractionOf(event);
      scrubRef.current = next;
      setScrub(next);
    },
    [fractionOf],
  );
  const onMove = useCallback(
    (event: GestureResponderEvent) => {
      const next = fractionOf(event);
      if (next === null) return;
      scrubRef.current = next;
      setScrub(next);
    },
    [fractionOf],
  );
  const onRelease = useCallback(() => {
    const at = scrubRef.current;
    scrubRef.current = null;
    setScrub(null);
    if (at === null || duration <= 0) return;
    // 멈춰 있을 때는 옮긴 뒤 위치 사건이 늦게 올 수 있다 — 막대가 옛 자리로 튀지 않게 먼저 그 자리에 둔다.
    setSnapshot(current => ({ ...current, position: at * duration, ended: false }));
    controller.seekTo(at * duration);
  }, [controller, duration, setSnapshot]);

  const shownSeconds = scrub !== null ? scrub * duration : snapshot.position;
  const fraction = duration > 0 ? clamp01(shownSeconds / duration) : 0;
  const total = clockOf(duration);
  const nowLabel = clockOf(shownSeconds);

  return (
    <View style={styles.row} testID="attachment-viewer-video-controls">
      <GlassButton
        label={formatMessage(
          snapshot.ended
            ? 'attachments.video.replay'
            : snapshot.playing
              ? 'attachments.video.pause'
              : 'attachments.video.play',
        )}
        onPress={controller.togglePlay}
        testID="attachment-viewer-video-toggle"
      >
        <Image
          source={snapshot.playing ? VIDEO_ICONS.pause : VIDEO_ICONS.play}
          style={styles.glyph}
        />
      </GlassButton>
      <Text
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        style={[styles.time, styles.timeStart]}
        testID="attachment-viewer-video-time"
      >
        {nowLabel}
      </Text>
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={formatMessage('attachments.video.seekLabel')}
        accessibilityValue={{
          text: formatMessage('attachments.video.seekValue', { position: nowLabel, total }),
        }}
        accessibilityActions={ADJUST_ACTIONS}
        onAccessibilityAction={event => {
          const step = VIDEO_PLAYER.adjustSeconds;
          controller.seekBy(event.nativeEvent.actionName === ADJUST_ACTIONS[0].name ? step : -step);
        }}
        collapsable={false}
        onLayout={onTrackLayout}
        // 막대가 쥔 손가락은 뷰어의 쓸어 닫기·넘기기에게 넘기지 않는다 — 막대를 끄는 동안 뷰어가 닫히면 안 된다.
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={onGrant}
        onResponderMove={onMove}
        onResponderRelease={onRelease}
        onResponderTerminate={onRelease}
        style={styles.trackHit}
        testID="attachment-viewer-video-seek"
      >
        {/* 선과 손잡이는 닿지 않는다 — 닿으면 `locationX` 가 이 자식 기준이 되어 막대 위치가 튄다. */}
        <View pointerEvents="none" style={styles.track}>
          <View style={[styles.fill, { width: `${fraction * 100}%` }]} testID="attachment-viewer-video-fill" />
        </View>
        <View
          pointerEvents="none"
          style={[styles.knob, { left: `${fraction * 100}%` }]}
          testID="attachment-viewer-video-knob"
        />
      </View>
      <Text
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        style={[styles.time, styles.timeEnd]}
        testID="attachment-viewer-video-duration"
      >
        {total}
      </Text>
      <GlassButton
        label={formatMessage(snapshot.muted ? 'attachments.video.unmute' : 'attachments.video.mute')}
        onPress={controller.toggleMuted}
        testID="attachment-viewer-video-mute"
      >
        <Image
          source={snapshot.muted ? VIDEO_ICONS.volumeOff : VIDEO_ICONS.volume}
          style={styles.glyph}
        />
      </GlassButton>
    </View>
  );
}

const buildStyles = (_color: Palette) =>
  StyleSheet.create({
    row: {
      ...LAYOUT.row,
      gap: VIDEO_PLAYER.step,
    },
    glyph: {
      width: VIDEO_ICON_SIZE.play,
      height: VIDEO_ICON_SIZE.play,
      tintColor: VIEWER_STAGE.ink,
    },
    time: {
      minWidth: VIDEO_PLAYER.timeWidth,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: VIEWER_STAGE.ink,
      fontVariant: ['tabular-nums'],
      ...VIEWER_TEXT_SHADOW,
    },
    timeStart: LAYOUT.textEnd,
    timeEnd: { ...LAYOUT.textStart, color: VIEWER_STAGE.inkMuted },
    trackHit: {
      flex: 1,
      height: VIDEO_PLAYER.trackHit,
      ...LAYOUT.centeredY,
    },
    track: {
      height: VIDEO_PLAYER.trackLine,
      borderRadius: radius.pill,
      ...LAYOUT.clipped,
      backgroundColor: VIEWER_STAGE.thumbPlaceholder,
    },
    fill: {
      height: '100%',
      backgroundColor: VIEWER_STAGE.ink,
    },
    // 손잡이의 중심이 채움의 끝에 선다(왼쪽 가장자리에서 지름의 절반을 당긴다).
    knob: {
      ...LAYOUT.floating,
      width: VIDEO_PLAYER.knob,
      height: VIDEO_PLAYER.knob,
      marginLeft: -VIDEO_PLAYER.knob / 2,
      borderRadius: radius.pill,
      backgroundColor: VIEWER_STAGE.ink,
    },
  });
