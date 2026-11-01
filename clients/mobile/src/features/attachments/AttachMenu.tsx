import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import {
  AccessibilityInfo,
  Animated,
  findNodeHandle,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {ATTACH_COPY} from '@momo/core/features/attachments/model';
import {GLASS_FALLBACK_OPACITY} from '@momo/core/design/themes';

import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {
  blurSupported,
  GLASS_BLUR_INTENSITY,
  glassMaterial,
  useReduceTransparency,
} from '../../design/glass';
import {
  ATTACH_MENU_ICONS,
  MENU_ICON_SIZE,
  type AttachMenuIconName,
} from '../../design/icons';
import {
  EASE_OUT,
  MENU_CLOSE_REST,
  MENU_CLOSE_SPRING,
  MENU_CLOSE_WATCHDOG_MS,
  MENU_FADE_MS,
  MENU_OPEN_SPRING,
} from '../../design/motion';
import {usePalette, useStyles, useTheme} from '../../design/theme';
import {font, line, space, type Palette} from '../../design/tokens';
import {useDismissOnEntry} from '../../lib/useDismissOnEntry';
import {useReduceMotionRef} from '../../lib/useReduceMotion';
import {PhotoGridCard} from './PhotoGridCard';
import {PhotoMorphFrame} from './PhotoMorphFrame';
import {PHOTO_CARD, photoCardSize} from './photoCardDesign';
import type {PhotoLibraryPorts} from './photoLibrary';
import {cardIsLive, menuIsInteractive, MORPH_START, morphReduce} from './photoMorph';
import type {PickedAttachmentFile} from './picker';

// =============================================================================
// 첨부 메뉴 — + 원에서 펼쳐지는 둥근 카드 (#4180). 바닥 시트(`AttachmentPickerSheet`)를 대체한다.
//
// 성재 원문(2026-10-21): 「뭔가 펼쳐지는 애니메이션이나 확장되는 애니메이션, 커스텀 UI 같은
// 디테일 부분을 버즈 레퍼런스를 확인해서」. 기준은 성재가 고른 Buzz 캡처(`IMG_4320`, 1206×2622 =
// 402pt@3x)이고 재해석하지 않는다. 아래 사양 표는 그 캡처에서 **픽셀로 잰** 값이다.
//
// ## 사양 표 (Buzz 실측 → 이 파일)
//
//   | 항목          | Buzz 실측                            | 이 파일                                   |
//   |---------------|--------------------------------------|-------------------------------------------|
//   | 카드 폭       | x 10→226pt = 216                     | 216                                       |
//   | 행 간격       | 60                                   | 행 높이 60                                |
//   | 카드 안 여백  | 위·아래 12 (5행 = 5×60 + 24 = 324)   | 12(`space.md`), 3행 = 3×60 + 24 = 204     |
//   | 모서리        | 연속 곡선, 반경 34(아래 「모서리」)    | `ATTACH_MENU.radius` 34 + `continuous`    |
//   | 위치          | 카드 왼쪽 10 · 아래 = + 원 중심 + 11 | 같은 두 수를 + 원에서 잰다(`attachMenuFrame`) |
//   | 아이콘        | 글리프 ≈ 15pt, 선 1.7pt              | 22pt 래스터(선 1.65pt), `MENU_ICON_SIZE`  |
//   | 글자          | 캡 높이 14.6pt → ≈ 20.7pt, 보통 굵기  | `font.title` 22 · 400                     |
//   | 글자 위치     | 아이콘 왼쪽 ≈ 39, 글자 왼쪽 ≈ 73     | 카드 12 + 행 16 = 28, 아이콘 22, 사이 16  |
//   | 재질          | 어두운 반투명(뒤 말풍선이 흐리게 비침)| 잉크(`primary`) 86% + 흐림, 아래 「재질」   |
//
// ## 모서리 — 이슈의 「~27pt」가 아니라 연속 곡선 34
//
// 이슈는 Buzz 모서리를 「~27pt」로 적었다. 캡처의 아래 왼쪽 모서리 프로필(아래 끝에서 dy 만큼 위 행의 가장
// 왼쪽 카드 픽셀이 카드 왼쪽에서 떨어진 거리)을 iOS 연속 곡선(`borderCurve: 'continuous'`) 반경 26·27·30·32·
// 34·36 의 시뮬레이터 프로필과 최소제곱으로 맞추면 **34 가 가장 가깝다**(dy 8~100 의 제곱오차 8, 26 은 1390,
// 30 은 346, 32 는 67). 연속 곡선은 모서리 점 가까이에서는 원호와 거의 같고 **꼬리(dy ≥ 48px)에서 갈리므로**
// 눈대중 27 로는 그 꼬리가 맞지 않았다. 디자인 시스템 사다리(`ds2Radius`)에 34 가 없어 **이름을 지어** 이 파일에 둔다(README §6 1·2단계:
// 이름과 근거). 카드 안 행의 반경은 동심이다 — 카드 반경 − 안 여백 = 22.
//
// 항목은 Buzz 의 다섯(카메라·사진·동영상·음성 메모·파일) 중 **셋**이다 — 동영상·음성 메모는 지원하지
// 않아 넣지 않는다(이슈 Goal). 그래서 높이는 5행이 아니라 3행이다.
//
// ## 재질
//
// Buzz 의 카드는 라이트에서도 어둡다. 이 앱에는 이미 같은 결정이 있다 — `PlusMenu`(DS2-2b)가 시안 A
// `.a-fab` 의 잉크 반전(`primary`/`onPrimary`)으로 「라이트에서는 어두운 카드, 다크에서는 밝은 카드」를
// 골랐다. 같은 문법을 따르므로 새 색 토큰이 없다(`docs/design-system/README.md` §6 을 밟지 않는다).
// `PlusMenu` 와 다른 한 가지가 Buzz 의 **반투명**이다: 잉크 86% 를 흐림(`expo-blur`) 위에 얹어 뒤의
// 말풍선이 흐리게 비친다. `GlassSurface` 와 같은 세 갈래다 — 투명도 줄이기가 켜져 있으면 불투명 잉크,
// 흐림 모듈이 없으면 94%(`GLASS_FALLBACK_OPACITY`와 같은 값), 그 밖에는 흐림 + 86%. 흐림의 틴트는 앱
// 스킴을 따른다(`GlassSurface` 와 같다).
//
// 86% 는 Buzz 에서 잰 값이다: 흰 바닥 위 카드가 (54,54,55)이고 잉크가 (28,26,23)이면
// α = (255 − 54) / (255 − 28) ≈ 0.885, 가장 어두운 자리가 (47,48,48)이라 상한은 ≈ 0.92 — 가운데로 0.86~0.9.
// 글자(`onPrimary`)는 그 위에서 라이트 ≈ 10.8:1 · 다크 ≈ 11.6:1(둘 다 AA 를 크게 넘는다).
//
// ## 기점과 움직임
//
// 카드는 + 원에서 **자라나** 펼쳐지고, 닫힐 때 역방향으로 + 원에 접혀 들어간다. 시작 자세는 「카드의
// 한가운데가 + 원의 한가운데에 있고, 크기는 + 원만 한 것」이고 끝 자세는 제자리다. 그 사이는 하나의
// 진행값(0→1)이 크기·이동·불투명도를 선형으로 잇는다(`attachMenuFrame` 의 `start*`). 스프링 값과 그 근거는
// `design/motion.ts` 의 「첨부 메뉴」 절이다. 움직이는 속성은 `transform`·`opacity` 뿐이라 네이티브
// 구동(`useNativeDriver`)이고, `transformOrigin` 은 쓰지 않는다 — 시작·끝 자세를 직접 적는 쪽이
// 네이티브 애니메이션과 스타일 원점의 상호작용을 믿지 않아도 된다.
//
// 불투명도는 두 단이다: 카드(재질)가 진행 0~0.35 에 먼저 서고, 행이 0.12~0.6 에 뒤따른다. 글자 없는
// 밝은 네모가 또렷이 서 있는 시간을 줄이는 순서다(Buzz 의 중간 프레임 `IMG_4321` 도 작아진 카드 안에
// 글자가 남아 있다). 「동작 줄이기」면 크기·이동 없이 카드째로 페이드만 한다(`MENU_FADE_MS`).
//
// ## 연타 방어
//
// 카드의 마지막 행(「파일」)이 + 원 위쪽 반을 덮는다(Buzz 배치). + 를 두 번 누르는 손의 두 번째 탭이 그
// 행에 떨어지면 메뉴를 본 적도 없는 사람이 파일 앱을 연다. 그래서 열린 뒤 200ms(`touchGuardMs`) 동안은 행의
// 누름을 무시한다. 닫는 길(바깥 탭 등)은 막지 않는다.
//
// ## 닫힘과 순서 계약
//
// 바깥 탭·+ 재탭·VoiceOver 탈출(두 손가락 Z)·Modal 의 `onRequestClose` 가 닫는다. Buzz 배치에서는 카드가
// + 원을 덮는다(카드 아래 끝이 + 원 중심 아래 11pt): + 원의 위쪽 16pt 는 마지막 행(「파일」) 아래 빈 자리,
// 가운데 12pt 는 카드의 아래 안 여백, 아래 6pt 만 카드 밖이다. 그대로 두면 + 를 다시 누를 때 가운데는
// 무반응이고 위쪽은 파일 앱이 열린다 — 그래서 + 원 자리에 **보이지 않는 닫기 표면**(`attach-menu-anchor-close`)을
// 카드 위에 얹는다. 가져가는 것은 행의 빈 모서리(34×34 표면과 「파일」 행의 겹침 28×16pt, 아이콘·글자와는 세로·
// 가로로 떨어져 있다)뿐이다. `anchorFromLeft` 는 지금 컴포저(+ 원 중심 x 33)에서는 클램프(`edge`)가 이겨 안 쓰이고,
// + 원이 Buzz 자리(중심 67.5)에 서는 날(#4179) 10 을 낸다.
//
// 시스템 picker·카메라는 이 Modal 이 **완전히 사라진 뒤**에 제시한다 — iOS 가 내려가는 VC 위의 제시를
// 거절하고, 그 거절이 「업로드 실패」 오탐으로 접힌다(design-review High-1). `onDismissed` 가 그 신호이고
// 옛 시트와 같은 계약이다: 접힘이 끝나 Modal 을 내리면 iOS 가 `onDismiss` 를 부른다.
// =============================================================================

/** 사양 수치. 시험이 같은 이름을 읽는다. */
export const ATTACH_MENU = {
  /** 카드 폭 — Buzz x 10→226pt. */
  width: 216,
  /** 카드 모서리 반경(연속 곡선) — 위 「모서리」. 코너 프로필 최소제곱으로 맞춘 Buzz 값. */
  radius: 34,
  /** 행 높이 — Buzz 행 간격 60. 고정이라 카드 높이를 글자 크기와 무관하게 산수로 안다. */
  rowHeight: 60,
  /** 화면 가장자리에서 카드까지 — Buzz 왼쪽 10. */
  edge: 10,
  /**
   * 카드 왼쪽 끝에서 + 원 중심까지. Buzz: + 원 중심 67.5(알약 왼쪽 41 + 안 여백 9 + 반지름 17.5) −
   * 카드 왼쪽 10 = 57.5. 값이 같은 두 번째 해석 「카드 왼쪽 = 화면 가장자리 10」은 `edge` 가 클램프로 진다.
   */
  anchorFromLeft: 57.5,
  /** + 원 중심에서 카드 아래 끝까지 — Buzz: 카드 아래 830 − 원 중심 819 = 11. 카드가 + 원을 덮는다. */
  belowCenter: 11,
  /** 아이콘과 글자 사이. */
  iconGap: 16,
  /** 재질의 잉크 불투명도 — 위 「재질」. */
  materialAlpha: 0.86,
  /**
   * 진행값에서 카드(재질)가 다 서는 지점. 임계감쇠 스프링은 앞이 빨라(50ms 에 0.26, 100ms 에 0.58)
   * 0.3 으로 두면 글자 없는 밝은 네모가 35ms 동안 또렷이 섰다(첫 캡처 `t=50ms`) — 0.35 로 늦춰
   * 카드가 크기와 함께 차오르고, 행은 그 안에서 일찍(0.12) 따라 선다.
   */
  cardFadeEnd: 0.35,
  /** 진행값에서 행이 서기 시작하고 다 서는 지점. */
  rowsFadeStart: 0.12,
  rowsFadeEnd: 0.6,
  /** 열린 뒤 VoiceOver 초점을 첫 행으로 옮기기까지 — 네이티브 뷰가 서는 한 틱. */
  focusDelayMs: 60,
  /** + 원 측정을 기다리는 상한. 기기에서는 한 프레임 안에 오므로 시험·측정 실패의 안전망이다. */
  anchorWaitMs: 120,
  /**
   * 열린 뒤 행의 누름을 무시하는 시간(열기 시작부터). 카드가 + 원 **위에** 서므로(마지막 행이 + 원 위쪽
   * 반을 덮는다) + 를 두 번 누르는 손은 두 번째 탭을 「파일」 행에 놓는다. 사람이 메뉴를 보기도 전의
   * 누름은 선택이 아니다 — 열림 스프링이 98% 에 닿는 ≈ 300ms 안에서 앞 200ms. 바깥 탭(닫기)은 막지 않는다.
   */
  touchGuardMs: 200,
} as const;

/** 항목 수. 높이 산수가 읽는다. */
const ROW_COUNT = 3;

/** 눌림 채움(`PlusMenu` 의 눌림과 같은 16%, 0x29). */
const PRESSED_ALPHA_HEX = '29';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AttachMenuFrame {
  /** 카드의 최종 자리(창 좌표). */
  left: number;
  top: number;
  width: number;
  height: number;
  /** 진행 0 에서의 자세 — 이 크기·이동에서 출발해 (1, 0, 0)으로 간다. */
  startScale: number;
  startX: number;
  startY: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * 측정 실패 때의 + 원. 컴포저의 기본 배치(알약 바깥 12 + 안 여백 4 = 왼쪽 16, 원 34, 도크 바닥에서 위로
 * 한 줄) — 틀려도 카드가 화면 안 왼쪽 아래에서 열린다는 것만 지킨다.
 */
export function fallbackAnchor(
  win: {width: number; height: number},
  insets: {bottom: number},
): Rect {
  return {x: 16, y: win.height - insets.bottom - 64, width: 34, height: 34};
}

/**
 * + 원(`anchor`, 창 좌표)에서 카드의 최종 자리와 출발 자세를 낸다. 순수 함수라 시험이 숫자로 읽는다.
 *
 * 카드는 + 원 중심 위에 아래 끝이 서고(`belowCenter`), 왼쪽 끝은 + 원 중심에서 `anchorFromLeft` 만큼
 * 왼쪽이되 화면 가장자리(`edge`)와 오른쪽 가장자리 사이로 클램프된다. 위로는 안전 영역 아래까지만
 * 자란다 — 그보다 높아야 하면 카드가 아래로 내려와 + 원을 더 덮는다(좁은 창의 안전망).
 */
export function attachMenuFrame(
  anchor: Rect,
  win: {width: number; height: number},
  insets: {top: number; left: number; right: number},
): AttachMenuFrame {
  const width = ATTACH_MENU.width;
  const height = ROW_COUNT * ATTACH_MENU.rowHeight + 2 * space.md;
  const ax = anchor.x + anchor.width / 2;
  const ay = anchor.y + anchor.height / 2;
  const left = clamp(
    ax - ATTACH_MENU.anchorFromLeft,
    insets.left + ATTACH_MENU.edge,
    win.width - insets.right - ATTACH_MENU.edge - width,
  );
  const bottom = ay + ATTACH_MENU.belowCenter;
  const top = Math.max(bottom - height, insets.top + ATTACH_MENU.edge);
  return {
    left,
    top,
    width,
    height,
    startScale: anchor.width / width,
    startX: ax - (left + width / 2),
    startY: ay - (top + height / 2),
  };
}

/** `measureInWindow` 를 약속으로. 잴 수 없으면(참조 없음·크기 0) `null`. */
function measureAnchor(
  ref: React.RefObject<View | null>,
  done: (rect: Rect | null) => void,
): void {
  const node = ref.current;
  if (node === null || typeof node.measureInWindow !== 'function') {
    done(null);
    return;
  }
  node.measureInWindow((x, y, width, height) => {
    const ok =
      [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0;
    done(ok ? {x, y, width, height} : null);
  });
}

/** `#rrggbb` 에 불투명도(0~1)를 `#rrggbbaa` 로 단다. 팔레트 색은 언제나 6자리다. */
function withAlpha(hex: string, alpha: number): string {
  return `${hex}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`;
}

/**
 * 「사진」 행이 메뉴를 **사진 카드로 변신**시키는 데 필요한 것 (#4181). 없으면 옛 길(`onPickPhoto` →
 * 시스템 picker)이 그대로다.
 */
export interface AttachMenuPhotos {
  /** 사진 보관함 포트. 카드가 열려 있을 때만 불린다. */
  ports: PhotoLibraryPorts;
  /** 더 붙일 수 있는 수(`photoRoom(트레이 개수)`). */
  room: number;
  /** 고른 사진을 파일로 바꿨다 — 한 번의 호출로 넘긴다. */
  onAttach: (files: PickedAttachmentFile[]) => void;
}

export function AttachMenu({
  visible,
  anchorRef,
  onClose,
  onPickCamera,
  onPickPhoto,
  onPickFile,
  onDismissed,
  photos,
}: {
  /** 있으면 「사진」 행이 메뉴를 사진 카드로 바꾼다(#4181). */
  photos?: AttachMenuPhotos;
  visible: boolean;
  /** + 원. 열 때 한 번 재고, 닫히면 VoiceOver 초점이 돌아간다. */
  anchorRef: React.RefObject<View | null>;
  onClose: () => void;
  onPickCamera: () => void;
  onPickPhoto: () => void;
  onPickFile: () => void;
  /** Modal 이 실제로 사라진 뒤(iOS `onDismiss`). picker·카메라 제시는 이 뒤여야 한다. */
  onDismissed?: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const win = useWindowDimensions();
  const reduceMotion = useReduceMotionRef();
  // 알림이 새 입구로 들어오면 접는다(#4667). 이 컴포넌트는 닫혀 있어도 마운트돼 있으므로 열려 있을 때만 닫아 달라고 한다.
  useDismissOnEntry(() => {
    if (visible) onClose();
  });

  const progress = useRef(new Animated.Value(0)).current;
  const [mounted, setMounted] = useState(false);
  const mountedRef = useRef(false);
  /** 잰 + 원. `null` 은 아직 못 쟀거나 잴 수 없다. */
  const [anchor, setAnchor] = useState<Rect | null>(null);
  /** 움직임을 시작해도 되는가 — + 원을 쟀거나(또는 못 재서 포기했거나). */
  const [ready, setReady] = useState(false);
  /** 이번 열림의 움직임. 열 때 `useReduceMotionRef` 에서 한 번 읽고 닫을 때까지 그대로 쓴다. */
  const motionRef = useRef<'spring' | 'fade'>('spring');
  const animationRef = useRef<Animated.CompositeAnimation | null>(null);
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 항목을 골라 닫혔는가 — 그러면 초점은 곧 뜰 picker 몫이라 + 원으로 돌려보내지 않는다. */
  const pickedRef = useRef(false);
  /** 이 시각 전의 행 누름은 무시한다(`touchGuardMs`). */
  const acceptTouchAfterRef = useRef(0);
  const firstRowRef = useRef<View | null>(null);
  // 메뉴 → 사진 카드 변신(#4181). 목표와 도착 여부 두 값이 전부다(`photoMorph.ts`).
  const [morph, dispatchMorph] = useReducer(morphReduce, MORPH_START);
  const hostOpacity = useRef(new Animated.Value(1)).current;
  // 카드가 서는 첫 `touchGuardMs` 동안은 카드 안의 누름을 삼킨다(「사진」 행을 두 번 누르는 손).
  const [cardGuard, setCardGuard] = useState(false);
  const cardGuardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
    if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
    if (cardGuardTimer.current !== null) clearTimeout(cardGuardTimer.current);
    watchdogRef.current = null;
    focusTimerRef.current = null;
    cardGuardTimer.current = null;
  }, []);

  // 열기: + 원을 재고 Modal 을 세운다. Modal 은 바로 서고(보이지 않는 채로) 움직임은 측정이 끝난 뒤에
  // 시작한다 — 측정이 카드 자리를 바꾸는 순간을 사람이 보지 않게 한다.
  useEffect(() => {
    if (!visible) return undefined;
    let alive = true;
    // 접히는 도중에 다시 열렸다면 그 접힘의 상한 타이머가 열린 Modal 을 내리지 않게 한다.
    if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
    watchdogRef.current = null;
    pickedRef.current = false;
    acceptTouchAfterRef.current = Date.now() + ATTACH_MENU.touchGuardMs;
    motionRef.current = reduceMotion.current ? 'fade' : 'spring';
    mountedRef.current = true;
    setMounted(true);
    setReady(false);
    const finish = (rect: Rect | null) => {
      if (!alive) return;
      alive = false;
      setAnchor(rect);
      setReady(true);
    };
    const wait = setTimeout(() => finish(null), ATTACH_MENU.anchorWaitMs);
    measureAnchor(anchorRef, rect => {
      clearTimeout(wait);
      finish(rect);
    });
    return () => {
      alive = false;
      clearTimeout(wait);
    };
  }, [visible, anchorRef, reduceMotion]);

  // 움직임 시작: Modal 이 서 있고 자리가 정해졌을 때.
  useEffect(() => {
    if (!mounted || !ready || !visible) return undefined;
    animationRef.current?.stop();
    progress.setValue(0);
    const animation =
      motionRef.current === 'fade'
        ? Animated.timing(progress, {
            toValue: 1,
            duration: MENU_FADE_MS,
            easing: EASE_OUT,
            useNativeDriver: true,
          })
        : Animated.spring(progress, {
            toValue: 1,
            ...MENU_OPEN_SPRING,
            overshootClamping: true,
            useNativeDriver: true,
          });
    animationRef.current = animation;
    animation.start();
    // VoiceOver 초점은 첫 항목으로. Modal 이 자동으로 첫 요소를 읽기도 하지만 명시한다.
    focusTimerRef.current = setTimeout(() => {
      focusTimerRef.current = null;
      const handle = findNodeHandle(firstRowRef.current);
      if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }, ATTACH_MENU.focusDelayMs);
    return () => {
      if (focusTimerRef.current !== null) clearTimeout(focusTimerRef.current);
      focusTimerRef.current = null;
    };
  }, [mounted, ready, visible, progress]);

  // 닫기: 열려 있던 Modal 만 접는다. 끝나면(또는 상한이 지나면) Modal 을 내린다.
  useEffect(() => {
    if (visible || !mountedRef.current) return undefined;
    animationRef.current?.stop();
    const hide = () => {
      if (watchdogRef.current !== null) clearTimeout(watchdogRef.current);
      watchdogRef.current = null;
      mountedRef.current = false;
      setMounted(false);
    };
    const animation =
      motionRef.current === 'fade'
        ? Animated.timing(progress, {
            toValue: 0,
            duration: MENU_FADE_MS,
            easing: EASE_OUT,
            useNativeDriver: true,
          })
        : Animated.spring(progress, {
            toValue: 0,
            ...MENU_CLOSE_SPRING,
            ...MENU_CLOSE_REST,
            overshootClamping: true,
            useNativeDriver: true,
          });
    animationRef.current = animation;
    watchdogRef.current = setTimeout(hide, MENU_CLOSE_WATCHDOG_MS);
    animation.start(({finished}) => {
      if (finished) hide();
    });
    return undefined;
  }, [visible, progress]);

  useEffect(
    () => () => {
      animationRef.current?.stop();
      clearTimers();
    },
    [clearTimers],
  );

  const handleDismissed = useCallback(() => {
    // 골라서 닫혔으면 곧 시스템 picker 가 초점을 가져간다. 그 밖(바깥 탭·탈출·뒤로)이면 + 원으로.
    if (!pickedRef.current) {
      const handle = findNodeHandle(anchorRef.current);
      if (handle !== null) AccessibilityInfo.setAccessibilityFocus(handle);
    }
    onDismissed?.();
  }, [anchorRef, onDismissed]);

  const choose = useCallback(
    (run: () => void) => () => {
      if (Date.now() < acceptTouchAfterRef.current) return;
      pickedRef.current = true;
      run();
    },
    [],
  );

  const frame = useMemo(
    () =>
      attachMenuFrame(anchor ?? fallbackAnchor(win, insets), win, insets),
    [anchor, win, insets],
  );

  // ---- 사진 카드(#4181) ------------------------------------------------------
  // 「사진」 행: 카드가 있으면 메뉴를 닫지 않고 **변신**한다. 연타 방어는 다른 행과 같다.
  const openPhotos = useCallback(() => {
    if (Date.now() < acceptTouchAfterRef.current) return;
    setCardGuard(true);
    if (cardGuardTimer.current !== null) clearTimeout(cardGuardTimer.current);
    cardGuardTimer.current = setTimeout(() => {
      cardGuardTimer.current = null;
      setCardGuard(false);
    }, ATTACH_MENU.touchGuardMs);
    dispatchMorph({type: 'open'});
  }, []);
  // 메뉴가 통째로 내려가면 다음에 열 때 메뉴에서 시작한다.
  useEffect(() => {
    if (!mounted) dispatchMorph({type: 'reset'});
  }, [mounted]);
  // 카드가 선 채로 메뉴가 닫히면(바깥 탭·탈출) + 원으로 접히는 건 옛 카드의 일이라 카드는 서서히 걷힌다.
  useEffect(() => {
    if (photos === undefined) return undefined;
    if (visible) {
      hostOpacity.setValue(1);
      return undefined;
    }
    const fadeOut = Animated.timing(hostOpacity, {
      toValue: 0,
      duration: MENU_FADE_MS,
      easing: EASE_OUT,
      useNativeDriver: true,
    });
    fadeOut.start();
    return () => fadeOut.stop();
  }, [photos, visible, hostOpacity]);
  const morphing = photos !== undefined && (morph.target === 'card' || !morph.settled);
  // 카드 크기: 화면 비율대로이되 안전 영역 위로는 올라가지 않는다. 바닥·왼쪽은 메뉴와 같은 자리다.
  const menuBottom = frame.top + frame.height;
  const cardBox = useMemo(() => {
    const size = photoCardSize(win);
    return {
      width: Math.min(size.width, win.width - insets.right - PHOTO_CARD.inset - frame.left),
      height: Math.min(size.height, menuBottom - insets.top - ATTACH_MENU.edge),
    };
  }, [win, insets, frame.left, menuBottom]);

  const fade = motionRef.current === 'fade';
  // 보간 노드는 렌더마다 새로 만들면 네이티브 구동이 매번 다시 붙는다 — 자리·방식이 바뀔 때만 만든다.
  const motion = useMemo(
    () => ({
      cardOpacity: fade
        ? progress
        : progress.interpolate({
            inputRange: [0, ATTACH_MENU.cardFadeEnd],
            outputRange: [0, 1],
            extrapolate: 'clamp',
          }),
      rowsOpacity: fade
        ? 1
        : progress.interpolate({
            inputRange: [ATTACH_MENU.rowsFadeStart, ATTACH_MENU.rowsFadeEnd],
            outputRange: [0, 1],
            extrapolate: 'clamp',
          }),
      transform: fade
        ? []
        : [
            {
              translateX: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [frame.startX, 0],
              }),
            },
            {
              translateY: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [frame.startY, 0],
              }),
            },
            {
              scale: progress.interpolate({
                inputRange: [0, 1],
                outputRange: [frame.startScale, 1],
              }),
            },
          ],
    }),
    [fade, frame, progress],
  );

  return (
    <Modal
      visible={mounted}
      transparent
      animationType="none"
      onRequestClose={onClose}
      onDismiss={handleDismissed}
      testID="attach-menu-modal">
      <View
        accessibilityViewIsModal
        onAccessibilityEscape={onClose}
        style={StyleSheet.absoluteFill}
        testID="attach-menu-layer">
        <Pressable
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
          testID="attach-menu-backdrop"
        />
        <Animated.View
          accessibilityLabel={ATTACH_COPY.attach}
          accessibilityRole="menu"
          style={[
            styles.card,
            morphing && styles.cardHidden,
            {
              left: frame.left,
              top: frame.top,
              height: frame.height,
              opacity: motion.cardOpacity,
              transform: motion.transform,
            },
          ]}
          testID="attach-menu">
          {menuClip(styles, {
            rowsOpacity: motion.rowsOpacity,
            firstRowRef,
            photoHint:
              photos === undefined
                ? '사진 보관함에서 한 장을 골라요'
                : '최근 사진을 펼쳐서 골라요',
            onCamera: choose(onPickCamera),
            onPhoto: photos === undefined ? choose(onPickPhoto) : openPhotos,
            onFile: choose(onPickFile),
          })}
        </Animated.View>
        {anchor === null || morphing ? null : (
          // + 원 자리의 닫기 표면(위 「닫힘」). 카드로 변신하는 동안에는 세우지 않는다 — 그 자리에 카드의 뒤로 원이 있다(#4181). 글자도 그림도 없다 — + 는 카드 밑에 있고, 사람이 누르는 것은
          // 그 기억이다. 보조기술에서는 숨는다(VoiceOver 는 탈출 제스처가 닫는다). 열린 직후에도 닫는 길은 막지 않는다.
          <Pressable
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            onPress={onClose}
            style={{
              position: 'absolute',
              left: anchor.x,
              top: anchor.y,
              width: anchor.width,
              height: anchor.height,
              borderRadius: anchor.height / 2,
            }}
            testID="attach-menu-anchor-close"
          />
        )}
        {photos === undefined ? null : (
          // 변신 틀은 메뉴가 열릴 때 **미리 서 있다**(투명, 눌리지도 낭독되지도 않는다). 「사진」을 누르는 순간에
          // 새로 마운트하면 틀 안 메뉴 사본의 아이콘 `Image` 가 한두 프레임 비어 있다가 나타났다(영상 프레임에서
          // 확인) — 미리 마운트해 두면 아이콘이 이미 그려진 사본이 그대로 켜진다. 사진 권한 API 는 카드가
          // `active` 가 되기 전에는 한 번도 불리지 않는다(`cardIsLive`).
          <Animated.View
            accessibilityElementsHidden={!morphing}
            importantForAccessibility={morphing ? 'auto' : 'no-hide-descendants'}
            pointerEvents={morphing ? 'box-none' : 'none'}
            style={[
              styles.morphHost,
              {
                left: frame.left,
                top: menuBottom - cardBox.height,
                width: cardBox.width,
                height: cardBox.height,
                opacity: hostOpacity,
              },
              morphing ? null : styles.morphStandby,
            ]}
            testID="attach-photo-host">
            <PhotoMorphFrame
              target={morph.target}
              menuSize={{width: frame.width, height: frame.height}}
              menuRadius={ATTACH_MENU.radius}
              cardSize={cardBox}
              cardRadius={PHOTO_CARD.radius}
              frameStyle={styles.morphShadow}
              bodyColor={palette.surface}
              cardGuarded={cardGuard}
              onSettled={target => dispatchMorph({type: 'settled', target})}
              menu={
                <View
                  pointerEvents={menuIsInteractive(morph) ? 'auto' : 'none'}
                  style={styles.morphMenu}>
                  {menuClip(styles, {
                    rowsOpacity: 1,
                    photoHint: '최근 사진을 펼쳐서 골라요',
                    onCamera: choose(onPickCamera),
                    onPhoto: openPhotos,
                    onFile: choose(onPickFile),
                  })}
                </View>
              }
              card={
                <PhotoGridCard
                  ports={photos.ports}
                  active={cardIsLive(morph)}
                  size={cardBox}
                  room={photos.room}
                  onBack={() => dispatchMorph({type: 'back'})}
                  onAttach={photos.onAttach}
                  onDone={onClose}
                  onOpenSystemPicker={choose(onPickPhoto)}
                />
              }
            />
          </Animated.View>
        )}
      </View>
    </Modal>
  );
}

/**
 * 메뉴 카드의 안쪽 — 재질과 세 행. 진짜 카드와 변신 틀의 메뉴 층이 같은 것을 그린다.
 *
 * 컴포넌트가 아니라 **그리는 함수**다: 진짜 카드의 첫 자식이 지금도 `clip` 뷰 자신이어야 한다
 * (옛 시험이 그 구조를 읽는다). 스타일은 호출한 곳의 것을 받는다(훅을 두 번째 자리에서 부르지 않는다).
 */
function menuClip(
  styles: ReturnType<typeof buildStyles>,
  {
    rowsOpacity,
    firstRowRef,
    photoHint,
    onCamera,
    onPhoto,
    onFile,
  }: {
    rowsOpacity: Animated.AnimatedInterpolation<number> | number;
    firstRowRef?: React.RefObject<View | null>;
    photoHint: string;
    onCamera: () => void;
    onPhoto: () => void;
    onFile: () => void;
  },
): React.JSX.Element {
  return (
    <View style={styles.clip}>
      <MenuMaterial />
      <Animated.View style={[styles.rows, {opacity: rowsOpacity}]}>
        <MenuRow
          icon="camera"
          label="카메라"
          hint="사진을 찍어 바로 첨부해요"
          onPress={onCamera}
          rowRef={firstRowRef}
          testID="attachment-pick-camera"
        />
        <MenuRow
          icon="photo"
          label="사진"
          hint={photoHint}
          onPress={onPhoto}
          testID="attachment-pick-photo"
        />
        <MenuRow
          icon="file"
          label="파일"
          hint="파일 앱에서 한 개를 골라요"
          onPress={onFile}
          testID="attachment-pick-file"
        />
      </Animated.View>
    </View>
  );
}

/** 카드의 재질 — 위 「재질」. 어느 갈래를 탔는지는 testID 가 말한다. */
function MenuMaterial(): React.JSX.Element {
  const palette = usePalette();
  const {scheme} = useTheme();
  const reduceTransparency = useReduceTransparency();
  const material = glassMaterial(reduceTransparency, blurSupported());
  const fill = StyleSheet.absoluteFill;
  if (material === 'blur') {
    // 모듈이 있을 때만 불러온다(`GlassSurface` 와 같은 이유). 흐림의 틴트는 앱 스킴을 따른다 —
    // 잉크의 반대가 아니다. 라이트에서 어두운 흐림을 깔면 카드가 (38,39,42) 로 Buzz 의
    // (54,54,55) 보다 한 단 더 어두웠다(첫 시뮬레이터 캡처 실측): 밝은 흐림이 뒤 페이지를 밝게
    // 비쳐 주고 그 위에 잉크 86% 가 얹혀야 Buzz 의 「짙지만 투명한」 값에 닿는다.
    const {BlurView} = require('expo-blur') as typeof import('expo-blur');
    return (
      <>
        <BlurView
          intensity={GLASS_BLUR_INTENSITY}
          tint={scheme === 'light' ? 'light' : 'dark'}
          style={fill}
        />
        <View
          pointerEvents="none"
          style={[fill, {backgroundColor: withAlpha(palette.primary, ATTACH_MENU.materialAlpha)}]}
          testID="attach-menu-material-blur"
        />
      </>
    );
  }
  return (
    <View
      pointerEvents="none"
      style={[
        fill,
        {
          backgroundColor:
            material === 'opaque'
              ? palette.primary
              : withAlpha(palette.primary, GLASS_FALLBACK_OPACITY),
        },
      ]}
      testID={`attach-menu-material-${material}`}
    />
  );
}

function MenuRow({
  icon,
  label,
  hint,
  onPress,
  rowRef,
  testID,
}: {
  icon: AttachMenuIconName;
  label: string;
  hint: string;
  onPress: () => void;
  rowRef?: React.RefObject<View | null>;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <Pressable
      ref={rowRef}
      accessibilityRole="menuitem"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.rowPressed]}
      testID={testID}>
      <Image
        source={ATTACH_MENU_ICONS[icon]}
        style={{
          width: MENU_ICON_SIZE,
          height: MENU_ICON_SIZE,
          tintColor: palette.onPrimary,
        }}
      />
      <Text
        style={styles.label}
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 변신(#4181) 동안은 같은 자리에 변신 틀이 서고 이 카드는 자리만 지킨다(`display: none`).
    cardHidden: {display: 'none'},
    // 변신 틀이 서는 자리: 메뉴와 바닥·왼쪽이 같고 카드 크기다. 틀은 그 안 왼쪽 아래에 닻을 내린다.
    morphHost: {position: 'absolute', justifyContent: 'flex-end', alignItems: 'flex-start'},
    // 변신 전(대기): 그려진 채 보이지 않는다. `display: none` 이 아닌 이유 — 레이아웃에 서 있어야 아이콘
    // 이미지가 미리 불러와진다.
    morphStandby: {opacity: 0},
    morphShadow: {boxShadow: color.elevationFloat},
    morphMenu: {flex: 1},
    // 위치(`left`·`top`·`height`)는 + 원을 잰 값이라 렌더에서 붙는다.
    card: {
      position: 'absolute',
      width: ATTACH_MENU.width,
      borderRadius: ATTACH_MENU.radius,
      borderCurve: 'continuous',
      boxShadow: color.elevationFloat,
    },
    // 흐림과 틴트는 모양 안에서 잘린다. 그림자는 바깥 `card` 가 그린다(`GlassSurface` 와 같은 분업).
    clip: {
      flex: 1,
      borderRadius: ATTACH_MENU.radius,
      borderCurve: 'continuous',
      overflow: 'hidden',
    },
    rows: {
      flex: 1,
      paddingVertical: space.md,
      paddingHorizontal: space.md,
    },
    row: {
      height: ATTACH_MENU.rowHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: ATTACH_MENU.iconGap,
      paddingHorizontal: space.lg,
      // 동심: 카드 반경 − 카드 안 여백(위 「모서리」). 카드와 같은 연속 곡선.
      borderRadius: ATTACH_MENU.radius - space.md,
      borderCurve: 'continuous',
    },
    rowPressed: {backgroundColor: `${color.onPrimary}${PRESSED_ALPHA_HEX}`},
    label: {
      flex: 1,
      fontSize: font.title,
      lineHeight: line.title,
      fontWeight: '400',
      color: color.onPrimary,
    },
  });
