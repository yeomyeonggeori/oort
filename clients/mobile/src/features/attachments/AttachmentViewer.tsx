import {
  ATTACH_COPY,
  attachmentDisplayName,
  type MessageAttachment,
} from '@momo/core/features/attachments/model';
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  type GestureResponderHandlers,
  Image,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { BAR_CONTROL_MAX_SCALE } from '../../design/atoms';
import { GlassSurface, LiquidGlassAllowed } from '../../design/glass';
import {
  ATTACH_MENU_ICONS,
  CONV_ICON_SIZE,
  CONV_ICONS,
  VIEWER_ICON_SIZE,
  VIEWER_ICONS,
} from '../../design/icons';
import {
  EASE_OUT,
  VIEWER_CHROME_HIDE_MS,
  VIEWER_CHROME_SHOW_MS,
} from '../../design/motion';
import { font, line, radius, space, type Palette } from '../../design/tokens';
import { useStyles } from '../../design/theme';
import { useReduceMotion } from '../../lib/useReduceMotion';
import { useAttachmentPreview } from './content';
import { useShareAttachment } from './useShareAttachment';
import { useViewerDismiss, type ViewerProgressRef } from './useViewerDismiss';
import { backdropStops, chromeStops, scaleStops } from './viewerDismiss';
import {
  VIEWER,
  VIEWER_GLASS_TONE,
  VIEWER_STAGE,
  viewerCaption,
  viewerCaptionLabel,
  viewerStamp,
  viewerScrim,
  viewerStripOffset,
} from './viewerDesign';

// =============================================================================
// 사진 전체 화면 보기 (#1681 · #3820 → #4293 → #4297).
//
// ## 이 판의 모양 (#4297 — 카카오톡 아이폰 사진 미리보기를 본으로)
//
// **검정 무대** 위에 사진이 화면 가득 서고 막대는 없다. 조작은 사진 위에 **떠 있는 반투명 유리**다(`viewerDesign.ts` 머리말에
// 그림과 값이 있다). 무대는 라이트 테마에서도 검정이다 — 사진은 어두운 방에서 가장 잘 보인다.
//
//   위     왼쪽 둥근 유리 ‹ 뒤로, 그 옆에 보낸 사람 이름·날짜·시각(눌리지 않는다 — 갈 곳이 없다)
//   아래   (두 장 이상) 썸네일 줄 — 누르면 그 장으로 — 과 「N장 중 n번」, 맨 아래 왼쪽 [저장] · 오른쪽 [공유]
//   탭     사진을 한 번 누르면 위·아래 조작이 같이 사라지고 다시 나타난다(불투명도만, 모션 사다리).
//
// 이 전체 화면은 앱의 「페이지」다 — 대화 위에 한 겹 쌓이고 한 겹만 벗기며 돌아가므로 나가는 문이 X 가 아니라 **‹ 뒤로(왼쪽)** 다
// (`docs/design-system/phone-sheets.md` §3 「페이지 머리의 나가는 문은 둘 중 하나다」).
//
// [저장]과 [공유]는 **같은 일을 한다**: 내려받아 iOS 공유 시트를 연다(`useShareAttachment`). 사진 보관함에 직접 쓰는 길은
// `projectShape.test.ts` 가 막고 Info.plist 가 「저장하지 않아요」라고 선언한다 — 그것을 바꾸는 것은 이 일의 결정이 아니다.
// 시트의 「이미지 저장」이 저장이다. [저장]의 보조기술 힌트가 그 사실을 말한다.
//
// ## 조작은 리퀴드 글래스를 쓰지 않는다 — 블러 + 어두운 틴트다
//
// 이 앱의 유리는 iOS 26 에서 `GlassView`(리퀴드)가 맨 위 갈래지만, **조상에 불투명도 애니메이션이 걸린 유리는 리퀴드가 될 수
// 없다**(`design/glass.tsx` 머리말 — UIKit 이 알파가 낮은 동안 효과를 건너뛰고, 한 번 페이드된 곳이 세션 내내 평평해졌다,
// design-review #3580 High). 조작 덩어리는 두 가지로 불투명도가 움직인다: 사진을 눌러 숨길 때, 그리고 쓸어 닫는 동안
// (`chromeStops`, #4293). 그래서 `LiquidGlassAllowed` 를 끄고 블러 갈래(`expo-blur`)에 어두운 틴트(`VIEWER_GLASS_TONE`)를
// 얹는다. 앱 셸도 같은 이유로 자기 자식에게 이미 끈다 — 이 Modal 은 React 로는 그 자손이다.
//
// ## 안전 영역 (#4293 — 베타 테스터가 뷰어에 갇혔다)
//
// 앞 판은 Modal 안의 첫 줄에 단추 띠를 놓았다. Modal 은 화면 **전체**를 덮으므로 그 줄은 상태 막대·다이내믹 아일랜드 밑에
// 깔렸고, 닫기·공유는 눌리지 않았다. 지금도 같은 규칙이다: 위쪽 조작은 `insets.top` 아래에서 시작하고 가로 여백은 `insets.left·
// right` 보다 좁아지지 않으며, 아래쪽 조작은 `insets.bottom` 위에서 끝난다. 인셋은 Modal **안의** `SafeAreaProvider` 에서 읽는다
// — Modal 은 앱 루트와 다른 네이티브 계층이다(`PageSheet` 와 같다). 사진 자체는 **화면 가득**이다(조작이 그 위에 뜬다).
//
// 아래로 쓸어 닫기도 그대로다(`viewerDismiss.ts` 의 규칙, `useViewerDismiss.ts` 의 배선): 단추가 어떤 이유로든 가려져도 사진을
// 쓸어 내리면 닫힌다. 끄는 동안 배경이 옅어져 뒤의 대화가 비치므로 Modal 이 `transparent` 이고 배경은 이 파일이 그린다.
//
// ## 응답을 쥐는 자리 — 쪽이다 (design-review r2 B-1)
//
// 사진 위에 닿은 손가락은 뿌리가 아니라 **쪽**(`ViewerPage` 의 View)이 쥔다. 뿌리는 가로 ScrollView 의 조상이고, iOS 의
// ScrollView 는 조상이 JS 응답자이면 스크롤을 시작하지 못한다 — 둘째 판은 이것 때문에 옆으로 넘기기가 죽었다(jest 에는 네이티브
// 스크롤뷰가 없어 초록이었다). 뿌리는 사진 밖에 닿은 손가락만 쥔다. 자세한 까닭은 `useViewerDismiss.ts` 머리말이다.
//
// **조작이 사진 위에 뜨면서 이 위험이 되살아났다.** 조작 덩어리의 빈 곳(단추 옆·썸네일 줄 둘레)에 닿은 손가락이 위로 번져
// 뿌리에 닿으면 뿌리가 JS 응답자가 되어 그 아래 쪽의 옆으로 넘기기가 죽는다. 그래서 조작 덩어리는 **`pointerEvents="box-none"`**
// (보일 때) 이라 빈 곳을 통과시키고, 글자(이름·캡션·안내)는 `none` 이라 닿지 않으며, 숨었을 때는 덩어리가 통째로 `none` 이다
// (보이지 않는 44pt 단추가 눌리지 않게). 이 구조를 지키는 것은 `attachmentViewer.test.tsx` 의 「조작 덩어리는 빈 곳을 통과시킨다」와
// 「사진 위에 닿은 손가락을 쥐는 뷰는 가로 스크롤뷰의 조상이 아니다」, 그리고 Maestro 105 의 「3장 중 3번」 단정이다.
//
// ## 조작을 숨길 때 보조기술
//
// 숨은 조작은 보이지 않을 뿐 아니라 **읽히지도 않는다**(`accessibilityElementsHidden`) — 보이지 않는 단추에 초점이 가면 사람은
// 무엇이 있는지 모른다. 반대로 VoiceOver 가 켜져 있으면 **숨기지 않는다**(탭이 아무것도 하지 않는다): 숨은 조작을 다시 불러올
// 길이 화면의 빈 곳을 누르는 것뿐이라, 화면을 보지 않는 사람에게는 닫는 길(뒤로)을 잃는 일이다.
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

/** 썸네일 한 장. 같은 사진의 미리보기를 쪽과 나눠 쓴다(캐시·진행 중 요청이 한 벌이라 내려받기가 늘지 않는다). */
function ViewerThumb({
  workspaceId,
  channelId,
  attachment,
  position,
  selected,
  onPress,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  /** 1부터. */
  position: number;
  selected: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment,
    true,
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${position}번째 사진`}
      accessibilityHint="이 사진으로 이동"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[styles.thumb, selected ? styles.thumbSelected : styles.thumbIdle]}
      testID="attachment-viewer-thumb"
    >
      {preview.status === 'ready' ? (
        <Image
          source={{ uri: preview.uri }}
          resizeMode="cover"
          style={styles.thumbImage}
          testID="attachment-viewer-thumb-image"
        />
      ) : null}
    </Pressable>
  );
}

/**
 * 둥근 유리 단추. 누르는 면(`Pressable`)이 지름 44 를 다 채우고, 유리·가는 테두리는 그 뒤·위에 그려진다. 유리의 톤은 테마와
 * 무관하게 어둡다(`VIEWER_GLASS_TONE`) — 밝은 사진 위에서도 흰 글리프가 선다.
 */
function GlassButton({
  label,
  hint,
  onPress,
  disabled,
  testID,
  children,
}: {
  label: string;
  hint?: string;
  onPress: () => void;
  disabled?: boolean;
  testID: string;
  children: React.ReactNode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <GlassSurface
      radius={VIEWER.control / 2}
      tone={VIEWER_GLASS_TONE}
      style={styles.glassCircle}
      testID={`${testID}-glass`}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={disabled ? { disabled: true } : undefined}
        disabled={disabled}
        onPress={onPress}
        style={({ pressed }) => [
          styles.glassHit,
          pressed && styles.glassPressed,
        ]}
        testID={testID}
      >
        {children}
      </Pressable>
      {/* 가는 테두리 — 유리 위·누르는 면 위에 그려 눌림 채움이 테두리를 덮지 않는다. 닿지 않는다. */}
      <View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, styles.glassRing]}
      />
    </GlassSurface>
  );
}

/** VoiceOver·스위치 컨트롤이 켜져 있는가. 켜져 있으면 조작을 숨기지 않는다(파일 머리 「조작을 숨길 때 보조기술」). */
function useScreenReader(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    AccessibilityInfo.isScreenReaderEnabled().then(
      value => {
        if (alive) setOn(value);
      },
      () => {
        /* 모름은 꺼짐으로 남는다 */
      },
    );
    const subscription = AccessibilityInfo.addEventListener(
      'screenReaderChanged',
      value => setOn(value),
    );
    return () => {
      alive = false;
      subscription.remove();
    };
  }, []);
  return on;
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
  /** 보낸 사람 이름. 위쪽 띠의 첫 줄이다. 모르면 줄이 서지 않는다. */
  senderName?: string;
  /** 보낸 시각(ms). 위쪽 띠의 둘째 줄이다. 모르거나 유한하지 않으면 줄이 서지 않는다. */
  sentAtMs?: number;
  /**
   * 아래로 쓸어 닫기가 켜져 있는가. 기본은 참이다. 확대된 사진을 끌어 옮기는 손가락이
   * 뷰어를 닫으면 안 되므로, 확대를 들이는 쪽이 확대 중에 거짓을 넘긴다.
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
  senderName,
  sentAtMs,
  dismissEnabled = true,
  progressRef,
}: AttachmentViewerProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const reduceMotion = useReduceMotion(false);
  const screenReader = useScreenReader();
  const [index, setIndex] = useState(startIndex);
  // 끌기를 쥐는 동안 가로 스크롤을 잠근다(대각선으로 내릴 때 옆 장이 끌려 들어오는 것을 막는다).
  const [dragging, setDragging] = useState(false);
  // 사진을 한 번 눌러 조작을 숨겼는가. 보조기술이 켜져 있으면 숨기지 않는다(`shown`).
  const [hidden, setHidden] = useState(false);
  const [pressedBy, setPressedBy] = useState<'save' | 'share'>('share');
  const scrollRef = useRef<ScrollView>(null);
  const stripRef = useRef<ScrollView>(null);
  const current = images[index] ?? images[0];
  const [download, share] = useShareAttachment(
    workspaceId,
    channelId,
    current as MessageAttachment,
  );
  const toggleChrome = useCallback(() => setHidden(value => !value), []);
  const { drag, pageHandlers, frameHandlers } = useViewerDismiss({
    enabled: dismissEnabled,
    height,
    onDismiss: onClose,
    progressRef,
    onDraggingChange: setDragging,
    onTap: toggleChrome,
  });
  const shown = !hidden || screenReader;

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
  const dragChromeOpacity = useMemo(
    () => drag.interpolate({ ...chromeStops(), extrapolate: 'clamp' }),
    [drag],
  );
  const scale = useMemo(
    () => drag.interpolate({ ...scaleStops(height), extrapolate: 'clamp' }),
    [drag, height],
  );

  // 조작의 보임·숨김: 불투명도 하나(1 ↔ 0). 쓸어 닫는 동안의 옅어짐(`dragChromeOpacity`)과 곱해 한 값으로 쓴다.
  const chromeFade = useRef(new Animated.Value(1)).current;
  const chromeOpacity = useMemo(
    () => Animated.multiply(dragChromeOpacity, chromeFade),
    [dragChromeOpacity, chromeFade],
  );
  const fadeStarted = useRef(false);
  useEffect(() => {
    if (!fadeStarted.current) {
      fadeStarted.current = true; // 첫 렌더는 이미 1(보임)이다 — 움직일 것이 없다.
      return;
    }
    const toValue = shown ? 1 : 0;
    if (reduceMotion) {
      chromeFade.setValue(toValue); // 사다리 D9: 0 으로 만든다, 상태는 착지한다.
      return;
    }
    const animation = Animated.timing(chromeFade, {
      toValue,
      duration: shown ? VIEWER_CHROME_SHOW_MS : VIEWER_CHROME_HIDE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [shown, reduceMotion, chromeFade]);

  // 썸네일 줄: 가로 폭은 창 폭에서 양쪽 여백을 뺀 값이다(측정을 기다리지 않는다).
  const sideLeft = Math.max(VIEWER.edge, insets.left);
  const sideRight = Math.max(VIEWER.edge, insets.right);
  const stripWidth = width - sideLeft - sideRight;
  const stripStarted = useRef(false);
  useEffect(() => {
    if (!stripStarted.current) {
      stripStarted.current = true; // 첫 자리는 `contentOffset` 이 잡는다.
      return;
    }
    stripRef.current?.scrollTo({
      x: viewerStripOffset(index, images.length, stripWidth),
      y: 0,
      animated: !reduceMotion,
    });
    // 줄은 고른 장이 **바뀔 때만** 따라간다(폭이 바뀌는 회전은 줄을 다시 맞추지 않는다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index]);

  const goTo = useCallback(
    (position: number) => {
      setIndex(position);
      scrollRef.current?.scrollTo({
        x: position * width,
        y: 0,
        animated: !reduceMotion,
      });
    },
    [width, reduceMotion],
  );

  // 내려받기 실패를 보조기술에도 알린다(눈에 보이는 안내와 같은 말).
  useEffect(() => {
    if (download.status === 'failed') {
      AccessibilityInfo.announceForAccessibility(
        `${ATTACH_COPY.downloadFailed}. ${ATTACH_COPY.retry}`,
      );
    }
  }, [download.status]);

  const busy = download.status === 'downloading';
  const save = useCallback(() => {
    setPressedBy('save');
    share();
  }, [share]);
  const sendOut = useCallback(() => {
    setPressedBy('share');
    share();
  }, [share]);

  const hasSender = senderName !== undefined && senderName.trim() !== '';
  const hasTime = sentAtMs !== undefined && Number.isFinite(sentAtMs);
  const stamp = hasTime ? viewerStamp(sentAtMs) : null;
  const total = images.length;

  // 조작 덩어리의 공통: 보일 때는 빈 곳을 통과시키고(`box-none`), 숨으면 통째로 닿지도 읽히지도 않는다.
  const chromeProps = {
    pointerEvents: shown ? ('box-none' as const) : ('none' as const),
    accessibilityElementsHidden: !shown,
    importantForAccessibility: shown
      ? ('auto' as const)
      : ('no-hide-descendants' as const),
  };

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
      {/* 상태 막대 글자는 무대에 맞춰 밝다. 앱 바탕이 라이트여도 무대는 검정이라 어두운 글자는 묻힌다. 뷰어가 내려가면
          앱 루트의 값(`App.tsx`)으로 돌아간다(RN 의 StatusBar 는 쌓인 값을 되살린다). */}
      <StatusBar barStyle="light-content" />
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
        style={[styles.pager, { transform: [{ translateY: drag }, { scale }] }]}
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
      {/* 리퀴드 글래스는 조상의 불투명도가 움직이는 곳에서 쓸 수 없다 — 파일 머리 「조작은 리퀴드 글래스를 쓰지 않는다」. */}
      <LiquidGlassAllowed.Provider value={false}>
        <Animated.View
          {...chromeProps}
          style={[
            styles.topChrome,
            {
              // 상태 막대·다이내믹 아일랜드 아래에서 시작한다. 이 한 줄이 #4293 의 P0 다.
              paddingTop: insets.top,
              paddingLeft: sideLeft,
              paddingRight: sideRight,
              opacity: chromeOpacity,
            },
          ]}
          testID="attachment-viewer-bar"
        >
          {/* 글자 뒤의 어두운 스크림 — 밝은 사진 위에서도 이름·시각·상태 막대 글자가 읽힌다. 덩어리 안이라 같이 숨고, 닿지 않는다. */}
          <View
            pointerEvents="none"
            style={styles.scrimTop}
            testID="attachment-viewer-scrim-top"
          />
          <GlassButton
            label="뒤로"
            onPress={onClose}
            testID="attachment-viewer-back"
          >
            <Image source={CONV_ICONS.left} style={styles.backGlyph} />
          </GlassButton>
          {hasSender || stamp !== null ? (
            <View
              // 닿지 않는다: 눌러도 갈 곳이 없고, 닿지 않아야 이 자리에서 시작한 손가락이 아래 사진으로 통과한다.
              pointerEvents="none"
              accessible
              accessibilityLabel={[hasSender ? senderName : null, stamp]
                .filter(Boolean)
                .join(', ')}
              style={styles.stamp}
              testID="attachment-viewer-stamp"
            >
              {hasSender ? (
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                  style={styles.stampName}
                  testID="attachment-viewer-sender"
                >
                  {senderName}
                </Text>
              ) : null}
              {stamp !== null ? (
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                  style={styles.stampTime}
                  testID="attachment-viewer-sent-at"
                >
                  {stamp}
                </Text>
              ) : null}
            </View>
          ) : null}
        </Animated.View>
        <Animated.View
          {...chromeProps}
          style={[
            styles.bottomChrome,
            {
              // 홈 인디케이터 위에서 끝난다.
              paddingBottom: insets.bottom + VIEWER.bottomLift,
              paddingLeft: sideLeft,
              paddingRight: sideRight,
              opacity: chromeOpacity,
            },
          ]}
          testID="attachment-viewer-actions"
        >
          <View
            pointerEvents="none"
            style={styles.scrimBottom}
            testID="attachment-viewer-scrim-bottom"
          />
          {download.status !== 'idle' ? (
            <Text
              pointerEvents="none"
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              style={[
                styles.notice,
                download.status === 'failed' && styles.noticeFailed,
              ]}
              testID="attachment-viewer-status"
            >
              {download.status === 'downloading'
                ? ATTACH_COPY.downloading
                : `${ATTACH_COPY.downloadFailed} · ${ATTACH_COPY.retry}`}
            </Text>
          ) : null}
          {total > 1 ? (
            <>
              <ScrollView
                ref={stripRef}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentOffset={{
                  x: viewerStripOffset(startIndex, total, stripWidth),
                  y: 0,
                }}
                style={styles.strip}
                contentContainerStyle={styles.stripContent}
                testID="attachment-viewer-strip"
              >
                {images.map((image, position) => (
                  <ViewerThumb
                    key={image.id}
                    workspaceId={workspaceId}
                    channelId={channelId}
                    attachment={image}
                    position={position + 1}
                    selected={position === index}
                    onPress={() => goTo(position)}
                  />
                ))}
              </ScrollView>
              <View pointerEvents="none" style={styles.captionRow}>
                <Image
                  source={ATTACH_MENU_ICONS.photo}
                  style={styles.captionGlyph}
                />
                {/* 이름은 글자 자체에 둔다(행을 `accessible` 로 묶으면 안의 testID 가 접근성 트리에서 사라진다 — Maestro 가 이 글자를
                    id 로 짚는다). 보이는 글은 「3장 중 2번」, 읽히는 글은 「3장 중 2번째 사진」이다. */}
                <Text
                  accessibilityLabel={viewerCaptionLabel(index + 1, total)}
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                  style={styles.caption}
                  testID="attachment-viewer-position"
                >
                  {viewerCaption(index + 1, total)}
                </Text>
              </View>
            </>
          ) : null}
          <View pointerEvents="box-none" style={styles.actionRow}>
            <GlassButton
              label="저장"
              // 사진 보관함에 직접 쓰지 않는다 — 공유 시트의 「이미지 저장」이 저장이다(파일 머리).
              hint="공유 시트가 열려요. 「이미지 저장」을 고르세요"
              onPress={save}
              disabled={busy}
              testID="attachment-viewer-save"
            >
              {busy && pressedBy === 'save' ? (
                <ActivityIndicator color={VIEWER_STAGE.ink} />
              ) : (
                <Image
                  source={VIEWER_ICONS.download}
                  style={styles.actionGlyph}
                />
              )}
            </GlassButton>
            <GlassButton
              label="공유"
              onPress={sendOut}
              disabled={busy}
              testID="attachment-viewer-share"
            >
              {busy && pressedBy === 'share' ? (
                <ActivityIndicator color={VIEWER_STAGE.ink} />
              ) : (
                <Image source={VIEWER_ICONS.share} style={styles.actionGlyph} />
              )}
            </GlassButton>
          </View>
        </Animated.View>
      </LiquidGlassAllowed.Provider>
    </View>
  );
}

// 무대는 테마와 무관해서 팔레트를 읽지 않는다(`viewerDesign.ts` 머리말) — 값은 한 벌이다. 그래도 길은 다른 화면과 같다
// (`useStyles(buildStyles)`): 정적 `StyleSheet.create` 상수는 import 시점에 굳는다는 규칙(`themeSwitch.test.tsx`)이 기계라서, 이 화면도
// 그 상수를 만들지 않는다.
const buildStyles = (_color: Palette) =>
  StyleSheet.create({
    // 바탕은 따로 그린다(`backdrop`): 끄는 동안 옅어져야 해서 이 뿌리는 투명이다.
    viewer: { flex: 1 },
    backdrop: { backgroundColor: VIEWER_STAGE.bg },
    // 사진은 화면 가득이다 — 조작이 그 위에 뜬다.
    pager: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 },
    viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    viewerImage: { width: '100%', height: '100%' },
    viewerState: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: VIEWER_STAGE.inkMuted,
    },

    // ---- 위: 뒤로 + 보낸 사람 -----------------------------------------------------
    topChrome: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      flexDirection: 'row',
      alignItems: 'center',
      gap: VIEWER.stampOffset,
    },
    stamp: { flex: 1, minWidth: 0 },
    stampName: {
      fontSize: font.heading,
      lineHeight: line.heading,
      fontWeight: '600',
      color: VIEWER_STAGE.ink,
      textShadowColor: VIEWER_STAGE.inkShadow,
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    stampTime: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: VIEWER_STAGE.inkMuted,
      fontVariant: ['tabular-nums'],
      textShadowColor: VIEWER_STAGE.inkShadow,
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },

    // 조작 덩어리 뒤의 스크림. 덩어리 바깥쪽으로 `scrimReach` 만큼 번져 부드럽게 사라진다.
    scrimTop: {
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: -VIEWER.scrimReach,
      left: 0,
      experimental_backgroundImage: viewerScrim('down'),
    },
    scrimBottom: {
      position: 'absolute',
      top: -VIEWER.scrimReach,
      right: 0,
      bottom: 0,
      left: 0,
      experimental_backgroundImage: viewerScrim('up'),
    },

    // ---- 아래: 안내 · 썸네일 줄 · 캡션 · [저장] [공유] ---------------------------------
    bottomChrome: {
      position: 'absolute',
      bottom: 0,
      left: 0,
      right: 0,
      gap: VIEWER.stackStep,
    },
    strip: { flexGrow: 0, height: VIEWER.thumb },
    // 줄이 화면보다 짧으면 가운데에 선다.
    stripContent: {
      flexGrow: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: VIEWER.thumbStep,
    },
    thumb: {
      width: VIEWER.thumb,
      height: VIEWER.thumb,
      borderRadius: radius.sm,
      borderWidth: VIEWER.thumbRing,
      overflow: 'hidden',
      backgroundColor: VIEWER_STAGE.thumbPlaceholder,
    },
    thumbSelected: { borderColor: VIEWER_STAGE.ring },
    // 같은 두께의 투명 테두리 — 고를 때 사진이 자리를 옮기지 않는다.
    thumbIdle: { borderColor: 'transparent', opacity: VIEWER.thumbDim },
    thumbImage: { width: '100%', height: '100%' },
    captionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.xs,
    },
    captionGlyph: {
      width: VIEWER.captionGlyph,
      height: VIEWER.captionGlyph,
      tintColor: VIEWER_STAGE.inkMuted,
    },
    caption: {
      fontSize: font.label,
      lineHeight: line.label,
      color: VIEWER_STAGE.inkMuted,
      textAlign: 'center',
      fontVariant: ['tabular-nums'],
      textShadowColor: VIEWER_STAGE.inkShadow,
      textShadowOffset: { width: 0, height: 1 },
      textShadowRadius: 3,
    },
    // 상태 안내(내려받는 중·실패)는 어두운 알약 위에 선다 — 어떤 사진 위에서도 읽혀야 하는 피드백이다(스크림이 약한 맨 위 줄이라 따로 면을 깐다).
    notice: {
      alignSelf: 'center',
      overflow: 'hidden',
      paddingHorizontal: VIEWER.noticePadX,
      paddingVertical: VIEWER.noticePadY,
      borderRadius: radius.pill,
      backgroundColor: VIEWER_GLASS_TONE.fallback,
      fontSize: font.label,
      lineHeight: line.label,
      color: VIEWER_STAGE.ink,
      textAlign: 'center',
    },
    noticeFailed: { color: VIEWER_STAGE.danger },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },

    // ---- 둥근 유리 단추 -------------------------------------------------------------
    glassCircle: { width: VIEWER.control, height: VIEWER.control },
    glassHit: {
      width: VIEWER.control,
      height: VIEWER.control,
      minWidth: VIEWER.control,
      minHeight: VIEWER.control,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.pill,
    },
    glassPressed: { backgroundColor: VIEWER_STAGE.pressedFill },
    glassRing: {
      borderRadius: radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: VIEWER_STAGE.glassBorder,
    },
    backGlyph: {
      width: CONV_ICON_SIZE.left,
      height: CONV_ICON_SIZE.left,
      tintColor: VIEWER_STAGE.ink,
    },
    actionGlyph: {
      width: VIEWER_ICON_SIZE,
      height: VIEWER_ICON_SIZE,
      tintColor: VIEWER_STAGE.ink,
    },
  });
