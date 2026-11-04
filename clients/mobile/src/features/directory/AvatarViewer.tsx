import React, { useMemo } from 'react';
import {
  Animated,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
} from 'react-native';
import {
  SafeAreaProvider,
  useSafeAreaInsets,
} from 'react-native-safe-area-context';
import { SHEET_ICON_SIZE, SHEET_ICONS } from '../../design/icons';
import { useStyles } from '../../design/theme';
import { radius, space, TOUCH_TARGET, type Palette } from '../../design/tokens';
import { useDismissOnEntry } from '../../lib/useDismissOnEntry';
import { useReduceMotion } from '../../lib/useReduceMotion';
import { useViewerDismiss } from '../attachments/useViewerDismiss';
import {
  backdropStops,
  chromeStops,
  scaleStops,
} from '../attachments/viewerDismiss';

// =============================================================================
// 프로필 사진 크게 보기 (#4319, owner 10-24 「프로필 이미지 누르면 미리보기로 크게 보이는 기능」).
//
// `AttachmentViewer`(#4293) 의 **형제**다. 그 뷰어는 메시지 첨부(`MessageAttachment`)에 묶여 있다 — 미리보기를 서버에서 받아 오고
// 저장·공유 단추와 「N장 중 n번」 위치가 있다. 프로필 사진은 이미 손에 든 주소(`file://`·`data:`) 한 장이라 그것들이 필요 없다. 그래서
// **같은 규칙**(`viewerDismiss.ts`)과 **같은 배선**(`useViewerDismiss.ts`)으로 쓰되 첨부 쪽을 한 줄도 건드리지 않는다(Maestro 105 가
// `attachment-viewer-*` 를 짚는다 — 이 파일의 testID 는 `avatar-viewer-*` 다).
//
// **얼굴은 지금 갈렸다(#4297).** 첨부 뷰어는 검정 무대 위에 사진이 화면 가득, 조작이 떠 있는 둥근 유리(‹ 뒤로 · 보낸 사람 · 저장·공유)로
// 옮겼다. 이 파일은 옛 얼굴(테마 바탕 · X 단추)이 그대로다 — 어느 쪽으로 맞출지는 후속 결정이다(PR 「후속」).
//
// 쓰는 곳: 프로필 시트의 큰 얼굴(사진이 있을 때만 눌린다), 정보 페이지의 큰 얼굴. 사진이 없는(이니셜) 얼굴은 이 뷰어를 열지 않는다 —
// 호출하는 쪽이 `useAvatarSource` 의 답이 `null` 이 아닐 때만 부른다.
//
// ## 이 파일이 `AttachmentViewer` 와 다른 것
//
//   · 가로 `ScrollView` 가 없다(한 장). 그래서 가로 스크롤을 잠글 일도, 둘째 손가락이 스크롤을 빼앗을 일도 없다. 응답을 쥐는 자리의
//     모양(뿌리는 이동 should-set 둘을 뺀 부분 집합, 쪽은 전부)은 **그대로 둔다** — 같은 훅이 두 갈래를 전제로 짜여 있고, 그 이음매를
//     여기서 다르게 쓰면 훅을 읽는 사람이 둘을 따로 외워야 한다(`useViewerDismiss.ts` 머리말 ②③).
//   · 공유·위치 글자가 없다. 닫기 단추 하나뿐이다 — 이름은 「○○ 프로필 사진 닫기」(어느 사진을 닫는지 말한다).
//
// ## 닫는 길 — 단추·쓸어 내리기·escape 셋이 같은 `onClose` 다
//
// 호출한 쪽이 뷰어를 걷는다(`onClose`). 놓은 뒤의 사라짐은 Modal 의 시스템 페이드가 한다 — 끌던 자리에서 그대로 옅어진다.
// =============================================================================

/** 닿는 모든 시작에 「내가 쥔다」고 답한다 — 아래 방패 View 의 한 줄이다(`AttachmentViewer` 의 같은 이름). */
const CLAIM_EVERY_START = () => true;
const SHIELD = { flex: 1 } as const;

export interface AvatarViewerProps {
  /** 사진 주소 — `file://`(받아 둔 업로드 사진)·`data:image/`·서버의 절대 주소. `useAvatarSource` 가 돌려준 것이다. */
  uri: string;
  /** 사진의 이름 — 「이도현 프로필 사진」. 보조기술이 사진을 읽는 이름이고 닫기 단추의 이름 앞에 붙는다. */
  label: string;
  onClose: () => void;
}

export function AvatarViewer({
  onClose,
  ...frame
}: AvatarViewerProps): React.JSX.Element {
  // 「동작 줄이기」면 Modal 이 시스템 페이드 없이 바로 서고 바로 내려간다. 첫 답이 오기 전에는 켜지 않은 것으로 본다(`false`):
  // Modal 은 첫 렌더의 값으로 이미 떠 버리므로, 모르는 동안 켜진 것으로 보면 모두의 첫 모습이 바뀐다(`AttachmentViewer` 와 같다).
  const reduceMotion = useReduceMotion(false);
  // 알림이 새 입구로 들어오면 걷는다(#4667). 같은 `onClose` 다 — 단추·쓸어 내리기·escape 와 닫는 길이 같다.
  useDismissOnEntry(onClose);
  return (
    <Modal
      visible
      transparent
      animationType={reduceMotion ? 'none' : 'fade'}
      onRequestClose={onClose}
      testID="avatar-viewer-modal"
    >
      <SafeAreaProvider>
        <View
          style={SHIELD}
          // 방패: 뷰어 Modal 은 부른 화면의 React 자손이라, 뷰어 안에서 아무도 쥐지 않은 시작은 위로 번져 뒤 화면의 눌리는 것(행·
          // 시트)이 묻는다. 둘째 손가락이 닿을 때 그 길의 끝에 이 View 가 있어서 뒤 화면까지 가지 못한다(`AttachmentViewer` 의 같은 방패).
          collapsable={false}
          onStartShouldSetResponder={CLAIM_EVERY_START}
          testID="avatar-viewer-shield"
        >
          <ViewerFrame onClose={onClose} {...frame} />
        </View>
      </SafeAreaProvider>
    </Modal>
  );
}

function ViewerFrame({
  uri,
  label,
  onClose,
}: AvatarViewerProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const { drag, pageHandlers, frameHandlers } = useViewerDismiss({
    enabled: true,
    height,
    onDismiss: onClose,
  });

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
      testID="avatar-viewer"
      // 사진 밖에 닿은 손가락만 쥔다(부분 집합). 사진 위는 쪽이 쥔다 — `useViewerDismiss.ts` 머리말.
      {...frameHandlers}
    >
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          styles.backdrop,
          { opacity: backdropOpacity },
        ]}
        testID="avatar-viewer-backdrop"
      />
      <Animated.View
        style={[
          styles.viewerBar,
          {
            // 상태 막대·다이내믹 아일랜드 아래에서 시작한다(#4293 의 P0 — 단추가 깔려 눌리지 않았다).
            paddingTop: insets.top,
            paddingLeft: Math.max(space.md, insets.left),
            paddingRight: Math.max(space.md, insets.right),
            opacity: chromeOpacity,
          },
        ]}
        testID="avatar-viewer-bar"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${label} 닫기`}
          onPress={onClose}
          style={({ pressed }) => [
            styles.viewerButton,
            pressed && styles.pressed,
          ]}
          testID="avatar-viewer-close"
        >
          {/* 시트·페이지와 같은 X 글리프다. 시트가 아닌 전체 화면 뷰어라 원은 없다(`phone-sheets.md` §5). */}
          <Image source={SHEET_ICONS.close} style={styles.viewerCloseGlyph} />
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
        testID="avatar-viewer-pager"
      >
        <View
          style={styles.viewerPage}
          // 레이아웃 속성만 있는 View 는 평탄화되어 네이티브 뷰가 사라질 수 있다 — 그러면 닿는 대상이 못 된다.
          collapsable={false}
          testID="avatar-viewer-page"
          {...pageHandlers}
        >
          <Image
            source={{ uri }}
            resizeMode="contain"
            style={styles.viewerImage}
            accessibilityLabel={label}
            testID="avatar-viewer-image"
          />
        </View>
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
    viewerCloseGlyph: {
      width: SHEET_ICON_SIZE.close,
      height: SHEET_ICON_SIZE.close,
      tintColor: color.text,
    },
    pager: { flex: 1 },
    viewerPage: { flex: 1, alignItems: 'center', justifyContent: 'center' },
    viewerImage: { width: '100%', height: '100%' },
  });
