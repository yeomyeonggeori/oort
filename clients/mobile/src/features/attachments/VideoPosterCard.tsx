import {
  attachmentDisplayName,
  attachmentMediaOf,
  formatVideoDuration,
  videoCardSize,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import React from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  type GestureResponderEvent,
} from 'react-native';
import { VIDEO_ICON_SIZE, VIDEO_ICONS } from '../../design/icons';
import { useStyles } from '../../design/theme';
import { font, line, radius, type Palette } from '../../design/tokens';
import { useFormatMessage } from '../../i18n/useFormatMessage';
import type { AttachmentGesture } from './AttachmentList';
import { useAttachmentPoster } from './videoContent';
import { LAYOUT, VIDEO_CARD } from './videoDesign';
import { VIEWER_GLASS_TONE, VIEWER_STAGE } from './viewerDesign';

// =============================================================================
// 대화 속 영상 카드 — 포스터가 있는 쪽 (#5208, 카카오톡 영상 말풍선을 본으로).
//
// 사진처럼 **테두리 없는 그림**이고, 한가운데 어두운 원 안의 ▶ 와 오른쪽 아래 길이 알약이 영상임을 말한다. 카드의 크기는
// 보내는 기기가 잰 치수(`media.width·height`)에서 나온다(`videoCardSize` — 비율을 9:16~16:9 로 가둔다). 그래서 **포스터가 도착하기 전에도
// 카드는 제 크기로 서 있다** — 받는 동안 16:9 자리에 섰다가 자라는 이음매가 없다.
//
// 포스터를 못 받아도(404·연결 오류) 카드는 같은 크기의 중립 면에 ▶ 와 길이를 그대로 그린다: 영상은 여전히 눌러 볼 수 있다.
// 포스터가 **없는** 영상(보낸 기기가 프레임을 못 만들었다)과 길이도 모르는 영상은 이 카드가 아니라 파일 카드의 모양을 쓴다
// (`AttachmentList.tsx` 의 `FileCard` — 영상기 아이콘, 문서 아이콘이 아니다).
//
// 카드 전체가 누르는 자리다 — 재생 표지는 따로 눌리지 않는다. 누르면 사진과 같은 전체 화면 보기에서 바로 재생된다.
// =============================================================================

export function VideoPosterCard({
  workspaceId,
  channelId,
  attachment,
  gesture,
  onOpen,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  gesture?: AttachmentGesture;
  onOpen: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const media = attachmentMediaOf(attachment);
  const posterUri = useAttachmentPoster(workspaceId, channelId, attachment, true);
  const size = videoCardSize(media, VIDEO_CARD.max);
  const duration = media === null ? null : formatVideoDuration(media.durationMs);
  const name = attachmentDisplayName(attachment);

  const onPress = (event?: GestureResponderEvent) => {
    event?.stopPropagation();
    if (gesture?.consumeTap()) return;
    onOpen();
  };

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        duration === null
          ? formatMessage('attachments.video.cardLabelNoDuration', { name })
          : formatMessage('attachments.video.cardLabel', { name, duration })
      }
      {...gesture?.pressTiming}
      onLongPress={gesture?.onLongPress}
      onPress={onPress}
      style={({ pressed }) => [styles.item, pressed && styles.pressed]}
      testID="attachment-video-item"
    >
      <View style={[styles.frame, size]} testID="attachment-video-frame">
        {posterUri !== null ? (
          <Image
            source={{ uri: posterUri }}
            resizeMode="cover"
            style={styles.poster}
            testID="attachment-video-poster"
          />
        ) : null}
        <View pointerEvents="none" style={styles.badge} testID="attachment-video-badge">
          <Image source={VIDEO_ICONS.playMark} style={styles.badgeGlyph} />
        </View>
        {duration === null ? null : (
          <View pointerEvents="none" style={styles.chip}>
            <Text style={styles.chipText} testID="attachment-video-duration">
              {duration}
            </Text>
          </View>
        )}
      </View>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    item: { borderRadius: radius.md },
    pressed: { opacity: 0.86 },
    // 테두리 없음: 그림이 곧 내용이다(사진 타일과 같다). 중립 면은 포스터가 서기 전의 자리를 지킨다.
    frame: {
      ...LAYOUT.centered,
      ...LAYOUT.clipped,
      borderRadius: radius.md,
      backgroundColor: color.surfaceMuted,
    },
    poster: LAYOUT.fill,
    badge: {
      width: VIDEO_CARD.badge,
      height: VIDEO_CARD.badge,
      ...LAYOUT.centered,
      borderRadius: radius.pill,
      backgroundColor: VIEWER_GLASS_TONE.fallback,
    },
    badgeGlyph: {
      width: VIDEO_ICON_SIZE.playMark,
      height: VIDEO_ICON_SIZE.playMark,
      tintColor: VIEWER_STAGE.ink,
    },
    chip: {
      ...LAYOUT.floating,
      right: VIDEO_CARD.chipInset,
      bottom: VIDEO_CARD.chipInset,
      paddingHorizontal: VIDEO_CARD.chipPadX,
      paddingVertical: VIDEO_CARD.chipPadY,
      borderRadius: radius.pill,
      backgroundColor: VIEWER_GLASS_TONE.fallback,
    },
    chipText: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: VIEWER_STAGE.ink,
      fontVariant: ['tabular-nums'],
    },
  });
