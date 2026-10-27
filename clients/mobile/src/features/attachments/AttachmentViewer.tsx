import {
  ATTACH_COPY,
  attachmentDisplayName,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  type GestureResponderHandlers,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import {
  font,
  line,
  radius,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import { BAR_CONTROL_MAX_SCALE } from '../../design/atoms';
import { SHEET_ICON_SIZE, SHEET_ICONS } from '../../design/icons';
import { useStyles } from '../../design/theme';
import { useReduceMotion } from '../../lib/useReduceMotion';
import { useAttachmentPreview } from './content';
import { useShareAttachment } from './useShareAttachment';
import { useViewerDismiss, type ViewerProgressRef } from './useViewerDismiss';
import { backdropStops, chromeStops, scaleStops } from './viewerDismiss';

// =============================================================================
// 사진 전체 화면 보기 (#1681 · #3820 → #4293).
//
// `AttachmentList.tsx` 에서 옮겨 왔다. 뷰어가 자기 파일을 갖는 것은 이어지는 개편(#4297:
// hero 전환 · 핀치 확대 · 유리 단추 · 더보기)이 한 파일에서 일하게 하기 위해서다.
//
// ## 이 판이 고친 것 (#4293 — 베타 테스터가 뷰어에 갇혔다)
//
// 앞 판은 Modal 안의 첫 줄에 단추 띠를 놓았다. Modal 은 화면 **전체**를 덮으므로 그 줄은
// 상태 막대·다이내믹 아일랜드 밑에 깔렸고, 닫기·공유는 눌리지 않았다. 사람은 화면 왼쪽
// 가장자리를 몇 번 쓸어서야 빠져나왔다. 고친 것은 둘이다.
//
//   ① **안전 영역.** 단추 띠가 `insets.top` 만큼 내려앉는다. 가로 여백도 `insets.left·
//      right` 보다 좁아지지 않는다(iPad 가로·노치). 인셋은 Modal **안의** `SafeAreaProvider`
//      에서 읽는다 — Modal 은 앱 루트와 다른 네이티브 계층이다(`PageSheet` 와 같다).
//   ② **아래로 쓸어 닫기.** 단추가 어떤 이유로든 가려져도 사진을 쓸어 내리면 닫힌다
//      (`viewerDismiss.ts` 의 규칙, `useViewerDismiss.ts` 의 배선). 끄는 동안 배경이 옅어져
//      뒤의 대화가 비친다 — 그래서 Modal 이 `transparent` 이고, 배경은 이 파일이 그린다.
//
// ## 응답을 쥐는 자리 — 쪽이다 (design-review r2 B-1)
//
// 사진 위에 닿은 손가락은 뿌리가 아니라 **쪽**(`ViewerPage` 의 View)이 쥔다. 뿌리는 가로 ScrollView 의
// 조상이고, iOS 의 ScrollView 는 조상이 JS 응답자이면 스크롤을 시작하지 못한다 — 둘째 판은 이것 때문에
// 옆으로 넘기기가 죽었다(jest 에는 네이티브 스크롤뷰가 없어 초록이었다). 뿌리는 사진 밖(단추 띠의 빈
// 곳·인셋)에 닿은 손가락만 쥔다. 자세한 까닭은 `useViewerDismiss.ts` 머리말이다. 이 구조를 지키는 것은
// `attachmentViewer.test.tsx` 의 「사진 위에 닿은 손가락을 쥐는 뷰는 가로 스크롤뷰의 조상이 아니다」와 Maestro 105 의
// 「3 / 3」 단정이다.
//
// ## 이어받는 쪽에 (#4297)
//
//   · 확대: 확대 중에는 쓸어 닫기가 꺼져야 한다. `dismissEnabled={!zoomed}` 한 줄이다.
//     지금은 확대가 없어서 기본값(참)을 쓴다.
//   · 단추 띠: `viewerBar` 한 곳이다. 유리 단추로 바꿔도 `paddingTop: insets.top` 은 남는다.
//   · 사진 영역: 아래 `pager` 한 곳이다. 위쪽 띠 아래·홈 인디케이터 위가 사진의 자리다.
// =============================================================================

/** 전체 화면 보기의 한 쪽. 쪽마다 자기 미리보기를 받는다. */
function ViewerPage({
  workspaceId,
  channelId,
  attachment,
  width,
  responder,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  width: number;
  /** 사진 위에 닿은 손가락을 쥐는 핸들러 — 쪽은 가로 ScrollView 의 자손이라 스크롤을 막지 않는다. */
  responder: GestureResponderHandlers;
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
      style={[styles.viewerPage, { width }]}
      // 레이아웃 속성만 있는 View 는 평탄화되어 네이티브 뷰가 사라질 수 있다 — 그러면 닿는 대상이 못 된다.
      collapsable={false}
      testID="attachment-viewer-page"
      {...responder}
    >
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

/** 닿는 모든 시작에 「내가 쥔다」고 답한다 — 아래 방패 View 의 한 줄이다. */
const CLAIM_EVERY_START = () => true;
const SHIELD = { flex: 1 } as const;

export interface AttachmentViewerProps {
  workspaceId: string;
  channelId: string;
  images: MessageAttachment[];
  startIndex: number;
  onClose: () => void;
  /**
   * 아래로 쓸어 닫기가 켜져 있는가. 기본은 참이다. 확대된 사진을 끌어 옮기는 손가락이
   * 뷰어를 닫으면 안 되므로, 확대를 들이는 쪽(#4297)이 확대 중에 거짓을 넘긴다.
   */
  dismissEnabled?: boolean;
  /** 시험이 끄는 거리를 읽는 이음매(`EdgeSwipeBack` 의 `progressRef` 와 같다). */
  progressRef?: ViewerProgressRef;
}

export function AttachmentViewer({
  onClose,
  ...frame
}: AttachmentViewerProps): React.JSX.Element {
  // 「동작 줄이기」면 Modal 이 시스템 페이드 없이 바로 서고 바로 내려간다. 첫 답이 오기 전에는
  // 켜지 않은 것으로 본다(`false`): Modal 은 첫 렌더의 값으로 이미 떠 버리므로, 모르는 동안
  // 켜진 것으로 보면 모두의 첫 모습이 바뀐다.
  const reduceMotion = useReduceMotion(false);
  return (
    <Modal
      visible
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      testID="attachment-viewer-modal"
    >
      <SafeAreaProvider>
        <View
          style={SHIELD}
          // 방패: 뷰어 Modal 은 메시지 행의 React 자손이라, 뷰어 안에서 아무도 쥐지 않은 시작은 위로 번져 행의
          // `Pressable` 이 묻는다. 둘째 손가락이 닿을 때(쪽·뿌리는 쥐지 않고 쪽은 양보도 거절한다) 그 묻는 길의 끝에 이
          // View 가 있어서 행까지 가지 못한다 — 행은 `onResponderGrant` 를 받는 순간 길게 누르기 타이머를 시작하기
          // 때문이다(RN 은 양보를 묻기 **전에** 청한 쪽에 Grant 를 알린다). 첫 손가락은 더 깊은 쪽·뿌리가 먼저 쥐므로
          // 여기까지 오지 않는다.
          collapsable={false}
          onStartShouldSetResponder={CLAIM_EVERY_START}
          testID="attachment-viewer-shield"
        >
          <ViewerFrame onClose={onClose} {...frame} />
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function ViewerFrame({
  workspaceId,
  channelId,
  images,
  startIndex,
  onClose,
  dismissEnabled = true,
  progressRef,
}: AttachmentViewerProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(startIndex);
  // 끌기를 쥐는 동안 가로 스크롤을 잠근다(대각선으로 내릴 때 옆 장이 끌려 들어오는 것을 막는다).
  const [dragging, setDragging] = useState(false);
  const scrollRef = useRef<ScrollView>(null);
  const current = images[index] ?? images[0];
  const [download, share] = useShareAttachment(
    workspaceId,
    channelId,
    current as MessageAttachment,
  );
  const { drag, pageHandlers, frameHandlers } = useViewerDismiss({
    enabled: dismissEnabled,
    height,
    onDismiss: onClose,
    progressRef,
    onDraggingChange: setDragging,
  });

  // 끌기가 쥐어지거나 끝나면 현재 쪽의 정확한 자리에 다시 맞춘다. 잠기기 전에 스크롤뷰가 가로로 몇 pt 따라갔다면 그
  // 어긋남이 끌기가 끝난 뒤에도 남는다(`pagingEnabled` 는 스스로 맞추지 않는다). 첫 렌더에서는 이미 맞다.
  const pinned = useRef(false);
  useEffect(() => {
    if (!pinned.current) {
      pinned.current = true;
      return;
    }
    scrollRef.current?.scrollTo({ x: index * width, y: 0, animated: false });
    // `index`·`width` 는 일부러 뺐다: 이 맞춤은 끌기의 시작·끝에만 한다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragging]);

  // 끄는 거리(`drag`) 한 값에서 세 모양이 파생한다. 표는 `viewerDismiss.ts` 에 한 벌이다.
  const backdropOpacity = useMemo(
    () => drag.interpolate({ ...backdropStops(), extrapolate: 'clamp' }),
    [drag],
  );
  const chromeOpacity = useMemo(
    () => drag.interpolate({ ...chromeStops(), extrapolate: 'clamp' }),
    [drag],
  );
  const scale = useMemo(
    () => drag.interpolate({ ...scaleStops(height), extrapolate: 'clamp' }),
    [drag, height],
  );

  return (
    <View
      accessibilityViewIsModal
      // VoiceOver 두 손가락 문지르기(escape)가 닫는다 — 단추를 찾지 못하는 사람의 길이다.
      onAccessibilityEscape={onClose}
      style={styles.viewer}
      testID="attachment-viewer"
      // 사진 밖에 닿은 손가락만 쥔다(부분 집합). 사진 위는 쪽이 쥔다 — 위 「응답을 쥐는 자리」.
      {...frameHandlers}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.backdrop,
          { opacity: backdropOpacity },
        ]}
        testID="attachment-viewer-backdrop"
      />
      <Animated.View
        style={[
          styles.viewerBar,
          {
            // 상태 막대·다이내믹 아일랜드 아래에서 시작한다. 이 한 줄이 이 이슈의 P0 다.
            paddingTop: insets.top,
            paddingLeft: Math.max(space.md, insets.left),
            paddingRight: Math.max(space.md, insets.right),
            opacity: chromeOpacity,
          },
        ]}
        testID="attachment-viewer-bar"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="닫기"
          onPress={onClose}
          style={({ pressed }) => [
            styles.viewerButton,
            pressed && styles.pressed,
          ]}
          testID="attachment-viewer-close"
        >
          {/* 글자 「닫기」가 아니라 시트·페이지와 같은 X 글리프다(#4458). 시트가 아닌 전체 화면 뷰어라 원은 없다. 누르는 면(44)·
              이름·testID·쓸어 닫기 영역은 그대로다 — 단추 상자는 글자가 아니라 `viewerButton` 이 정한다. */}
          <Image source={SHEET_ICONS.close} style={styles.viewerCloseGlyph} />
        </Pressable>
        {images.length > 1 ? (
          <Text
            style={styles.viewerPosition}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            testID="attachment-viewer-position"
          >
            {`${index + 1} / ${images.length}`}
          </Text>
        ) : (
          <View />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${ATTACH_COPY.download}, 공유하기`}
          onPress={share}
          style={({ pressed }) => [
            styles.viewerButton,
            pressed && styles.pressed,
          ]}
          testID="attachment-viewer-share"
        >
          <Text
            style={styles.viewerButtonLabel}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          >
            {download.status === 'downloading'
              ? ATTACH_COPY.downloading
              : download.status === 'failed'
              ? ATTACH_COPY.retry
              : '공유'}
          </Text>
        </Pressable>
      </Animated.View>
      <Animated.View
        style={[
          styles.pager,
          {
            // 홈 인디케이터 위가 사진의 바닥이다.
            paddingBottom: insets.bottom,
            transform: [{ translateY: drag }, { scale }],
          },
        ]}
        testID="attachment-viewer-pager"
      >
        <ScrollView
          ref={scrollRef}
          horizontal
          pagingEnabled
          scrollEnabled={!dragging}
          testID="attachment-viewer-scroll"
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
              responder={pageHandlers}
            />
          ))}
        </ScrollView>
      </Animated.View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    pressed: { backgroundColor: color.surfacePressed },
    // 바탕은 따로 그린다(`backdrop`): 끄는 동안 옅어져야 해서 이 뿌리는 투명이다.
    viewer: { flex: 1 },
    backdrop: { backgroundColor: color.bg },
    viewerBar: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    viewerButton: {
      minWidth: TOUCH_TARGET,
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      alignItems: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.sm,
    },
    viewerButtonLabel: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    viewerCloseGlyph: {
      width: SHEET_ICON_SIZE.close,
      height: SHEET_ICON_SIZE.close,
      tintColor: color.text,
    },
    viewerPosition: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      fontVariant: ['tabular-nums'],
    },
    pager: { flex: 1 },
    viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    viewerImage: { width: '100%', height: '100%' },
    viewerState: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
  });
