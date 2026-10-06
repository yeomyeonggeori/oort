import React, {createContext, useContext, useEffect, useRef} from 'react';
import {
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {GlassSurface, useGlassMaterial} from '../design/glass';
import {haptics} from '../lib/haptics';
import {useReduceMotionRef} from '../lib/useReduceMotion';
import {SHELL_ICONS, SHELL_ICON_SIZE, type ShellIconName} from '../design/icons';
import {BAR_CONTROL_MAX_SCALE} from '../design/atoms';
import {usePalette, useStyles} from '../design/theme';
import {ds2Type, TOUCH_TARGET, type Palette} from '../design/tokens';
import {tabLabel, visibleTabs, type Tab} from '../nav/state';

// =============================================================================
// 폰 셸의 크롬 — 바닥, 가운데 알약 탭바, 작은 + 단추, 스크롤 페이드
// (ADR-0189 D1, 시안 A `#a-home`; 크기·배치는 DS2-2b #2750 에서 Buzz 로 줄였다).
//
// ## 사양 표 (393pt 기준, Buzz 캡처 IMG_4161 1206px = 393pt → 3.07px/pt 로 환산)
//
//   | 항목            | Buzz 실측          | 이전 oort(DS2-2)       | 이 파일                    |
//   |-----------------|--------------------|------------------------|----------------------------|
//   | 탭바 배치       | 가운데             | 왼쪽 16                | **화면 정중앙**(#3580)     |
//   | 탭바 크기       | ≈211×53            | 252×64                 | 212×54                     |
//   | 탭(선택 채움)   | ≈67×46             | 78×52                  | 66×46 · 반경 23            |
//   | 탭바 여백       | ≈3.5               | 6 · 틈 2               | 4 · 틈 2                   |
//   | 새로 만들기     | 별도 FAB 없음      | 오른쪽 64 원 FAB       | 54 원 +, 화면 오른쪽 20 에 앵커(#3580) |
//   | + 누르면        | 작은 어두운 팝오버 | 전면 시트              | 작은 팝오버(`PlusMenu`)    |
//   | 하단 크롬 폭    | 211(+는 우측 24)   | 16+252…64+16 = 전폭    | 알약 212 가운데 · +는 우측 20 |
//   | 바닥에서        | ≈34                | 30                     | 30(시안 A 값 유지)         |
//
// 재질·색은 시안 A 그대로다(owner 결정: 레퍼런스는 크기·배치만 Buzz):
//
//   .a-tab  glass + blur(22) · 1px glassLine · sh2 (z 20 은 옮기지 않는다 — bar 주석)
//   .a-tab button   ink2 / on: ink 8% 채움 + ink
//   .a-tab .dot     17×17 · 10.5/800 · 가로 4 · 2px surface 고리
//                   (자리는 탭이 줄어든 비율로 옮긴다: top 8 · right 16)
//
// ## 배지 문법 (#3342, 사이드바·알림 시안 §1.2 · 7)
//
//   인박스  잉크 알약 + 수 = 「나에게 필요한 일」(결정할 수 있는 승인 + 안 읽은 멘션).
//           수는 `useNeedsMe` 한 곳에서 오고(core `needsMe`), 이 파일은 받아서 그릴 뿐이다.
//   홈      호박 점(수 없음) = 안 읽은 글이 어딘가에 있다. 수를 안 그리는 이유는 홈이
//           말하는 것이 「읽을 것이 있다」 하나라서다 — 「해야 할 일」은 인박스의 말이다.
//
// 앱 아이콘 배지는 이 둘이 아니라 서버가 푸시에 싣는 안 읽음 합이다(`push/appBadge.ts`).
//   .a-fab  primary / onPrimary · sh2 — 지름만 64 → 54(탭바 높이와 같다)
//   .a-fade left 0 · right 0 · bottom 0 · height 150 ·
//           linear-gradient(180deg, transparent, bgBot 62%)
//
// ## 가운데·오른쪽 (#3580)
//
// 이전 판은 알약과 + 를 **한 묶음으로** 가운데에 놓아 알약이 화면 중심에서 31pt 왼쪽에
// 있었다(성재 2026-10-07: 「버즈는 가운데 컨트롤 박스가 가운데에 있고, 우측에 + 버튼」).
// Buzz 는 알약을 `bottomNavigationBar` 가운데에 두고 + 는 알약에 묶지 않은 채 화면 오른쪽
// 가장자리(`rightInset`)에 앵커한다 — 같은 구조다: 알약은 화면 폭의 정중앙, + 는
// `right: plusInset`(20). 좁은 창에서는 알약이 줄어 둘 사이 틈(`plusGap` 이상)을 지킨다.
//
// ## 탭 전환 (#3580)
//
// 선택 채움은 탭마다 칠하던 배경이 아니라 알약 안을 미끄러지는 **캡슐 하나**다
// (`translateX` 스프링 — 임계감쇠, 오버슈트 없음, 도중 재지정은 현재 값에서 재출발).
// 목적은 「선택이 어디로 옮겨갔는가」의 상태 표시이고, 콘텐츠 쪽 페이드는 `AppShell` 의
// `TabPane` 이 진다. 동작 줄이기가 켜져 있으면 캡슐이 즉시 자리를 옮긴다.
//
// 탭바는 아이콘만 든다. 시안이 그렇고, 이름은 VoiceOver 라벨이 진다(탭마다
// `tabLabel`). 아이콘이 글자를 대신하므로 Dynamic Type 으로 커질 글자가 탭바에
// 없다.
//
// + 는 탭바 **밖**의 형제다. `tablist` 안에 넣으면 VoiceOver 가 「탭, 4개 중 4번째」로
// 읽어 행위를 자리로 오해하게 한다. 두 배치 안(알약 안 네 번째 칸 / 알약 옆 작은
// 원)을 캡처로 비교했고 옆 원을 골랐다 — PR #2750 본문 「배치 비교」.
// =============================================================================

/** 사양 수치. 캡처와 시험이 같은 이름을 읽는다. */
export const SHELL = {
  bottom: 30,
  barHeight: 54,
  /** 안쪽 여백. 세로는 테두리 1 을 포함한다: 1 + 3 + 46 + 3 + 1 = 54. */
  barPadding: 4,
  barGap: 2,
  tabWidth: 66,
  tabHeight: 46,
  /** + 원의 지름 — 탭바 높이와 같다. 두 도형의 윗선·아랫선이 한 줄에 선다. */
  plus: 54,
  /** 알약 오른쪽 가장자리와 + 사이의 **최소** 틈. 넓은 창에서는 더 벌어진다. */
  plusGap: 8,
  /**
   * + 의 오른쪽 가장자리가 창 오른쪽에서 떨어진 거리(Buzz `rightInset` 24 와 같은 구조).
   * + 메뉴의 좌우 여백(`PLUS_MENU.inset` 20)과 같아서 메뉴 오른쪽 변이 + 의 오른쪽 변과
   * 한 줄에 선다.
   */
  plusInset: 20,
  fadeHeight: 150,
  dot: 17,
  /** 홈의 안 읽음 점 — 수를 못 그리는 자리라 알약보다 작다. 고리는 같은 2. */
  unreadDot: 10,
  /** 시안 `.a-scroll{padding-bottom:140px}` — 목록 끝이 탭바 밑에 숨지 않게. */
  clearance: 140,
} as const;

/** 테두리 두 줄 + 가로 여백 둘 + 틈 둘 — 탭 폭 밖에서 탭바가 먹는 폭. */
const BAR_CHROME = 2 + SHELL.barPadding * 2 + SHELL.barGap * 2;

/** 선택 캡슐의 스프링 — 감쇠비 1(임계감쇠): damping = 2·√(stiffness·mass) = 2·√380 ≈ 39. */
export const CAPSULE_SPRING = {stiffness: 380, damping: 39, mass: 1} as const;

/** 탭 폭에서 탭바의 폭. */
export function barWidthFor(tabWidth: number): number {
  return tabWidth * 3 + BAR_CHROME;
}

/**
 * 창 폭에서 탭 하나의 폭.
 *
 * 알약은 창 가운데에 있으므로 + 가 오른쪽 한 곳에만 서도 **왼쪽도 같은 만큼** 비워야
 * 대칭이다: 알약의 한쪽 반폭이 `w/2 − (plusInset + plus + plusGap)` 이하여야 한다.
 * 사양 값(66)은 376pt 부터 그대로 들어간다(20+54+8 = 82 → 반폭 ≥ 106). iOS 16.4 를
 * 지원하는 가장 좁은 폰은 375(SE·미니)라 거기서는 65 로 1pt 줄고, 그보다 좁은 창은
 * 폰에 없지만(320 은 식의 하한 확인용) 틈 8 을 지키며 44 아래로는 가지 않는다.
 */
export function tabWidthFor(windowWidth: number): number {
  const half = windowWidth / 2 - (SHELL.plusInset + SHELL.plus + SHELL.plusGap);
  const room = half * 2 - BAR_CHROME;
  return Math.max(TOUCH_TARGET, Math.min(SHELL.tabWidth, Math.floor(room / 3)));
}

/**
 * 하단 크롬의 가로 기하 — 렌더 트리와 시험이 같은 식을 읽는다.
 * 좌표는 창 왼쪽 가장자리에서 잰다.
 */
export function shellGeometry(windowWidth: number): {
  tabWidth: number;
  barWidth: number;
  barLeft: number;
  barRight: number;
  plusLeft: number;
  plusRight: number;
  /** 알약 오른쪽 가장자리와 + 왼쪽 가장자리의 틈. */
  gap: number;
} {
  const tabWidth = tabWidthFor(windowWidth);
  const barWidth = barWidthFor(tabWidth);
  const barLeft = (windowWidth - barWidth) / 2;
  const barRight = barLeft + barWidth;
  const plusRight = windowWidth - SHELL.plusInset;
  const plusLeft = plusRight - SHELL.plus;
  return {tabWidth, barWidth, barLeft, barRight, plusLeft, plusRight, gap: plusLeft - barRight};
}

// ---- 탭 화면의 아래 여백 ------------------------------------------------------

const TabBarClearance = createContext(0);

/** 탭 화면의 목록이 끝에 더할 여백. 셸 밖(층·하네스)에서는 0이다. */
export function useTabBarClearance(): number {
  return useContext(TabBarClearance);
}

export function TabBarClearanceProvider({
  children,
}: {
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <TabBarClearance.Provider value={SHELL.clearance}>{children}</TabBarClearance.Provider>
  );
}

// ---- 바닥 --------------------------------------------------------------------

/** 셸 뒤의 그라데이션 바닥. 탭 화면은 투명해서 이것이 보인다. */
export function Canvas({children}: {children: React.ReactNode}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.canvas} testID="shell-canvas">
      {children}
    </View>
  );
}

/** 목록이 탭바 밑으로 녹아드는 페이드. 누름을 가로채지 않는다. */
export function ScrollFade(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return <View pointerEvents="none" style={styles.fade} testID="shell-fade" />;
}

// ---- 떠 있는 알약 탭바 --------------------------------------------------------

const TAB_ICON: Readonly<Record<Tab, ShellIconName>> = {
  home: 'home',
  inbox: 'inbox',
  search: 'search',
};

/**
 * 층이 셸을 덮은 동안 크롬을 보조기술에서 숨긴다. 층은 크롬 **위**에 그려지므로
 * 손가락은 크롬에 닿지 않는데, VoiceOver 는 트리를 훑어 가려진 탭바·FAB 을 읽고
 * 누를 수 있다 — 대화 층은 늘 모달이 아니다(`AppShell` 의 `accessibilityViewIsModal`).
 */
function coveredProps(covered: boolean) {
  return covered
    ? ({
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants',
      } as const)
    : {};
}

/**
 * 하단 크롬 — 화면 정중앙의 알약 탭바와, 오른쪽 가장자리에 앵커한 + 단추.
 *
 * 가운데 정렬은 창 폭 전체를 차지하는 절대 띠로 하고, 띠 자신은 누름을 받지 않는다
 * (`box-none`). 띠가 누름을 먹으면 탭바 양옆 빈 자리에서 목록의 마지막 줄이 눌리지
 * 않는다. + 는 흐름 밖(`position: absolute`)이라 알약의 가운데에 영향을 주지 않는다.
 */
export function ShellBottomBar({
  current,
  inboxCount,
  homeUnread = false,
  onSelect,
  onPlus,
  plusOpen = false,
  covered = false,
}: {
  current: Tab;
  /** 인박스 알약의 수 — 「나에게 필요한 일」. 0이면 알약이 없다. */
  inboxCount: number;
  /** 홈 탭의 안 읽음 점. 수가 아니라 있다/없다다. */
  homeUnread?: boolean;
  onSelect: (tab: Tab) => void;
  onPlus: () => void;
  /** + 메뉴가 열려 있는가(보조기술의 「펼쳐짐」). */
  plusOpen?: boolean;
  /** 층이 셸을 덮고 있는가(`coveredProps`). */
  covered?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const tabWidth = tabWidthFor(useWindowDimensions().width);
  const material = useGlassMaterial();
  const tabs = visibleTabs();
  const reduceMotion = useReduceMotionRef();
  // 선택 캡슐의 가로 자리. 첫 그림은 애니메이션 없이 제자리에 선다.
  const step = tabWidth + SHELL.barGap;
  const index = Math.max(0, tabs.indexOf(current));
  const slide = useRef(new Animated.Value(index * step)).current;
  // 폭이 바뀌면(회전·창 크기) 옛 자리에서 미끄러지지 않고 새 자리에 선다 — 움직임은
  // 선택이 바뀔 때만이다.
  const lastStep = useRef(step);
  useEffect(() => {
    const target = index * step;
    if (lastStep.current !== step) {
      lastStep.current = step;
      slide.setValue(target);
      return;
    }
    if (reduceMotion.current) {
      slide.setValue(target);
      return;
    }
    // 임계감쇠(감쇠비 1): damping = 2·√(stiffness·mass). 오버슈트 없이 ~300ms 에 자리 잡고,
    // 연타하면 현재 값에서 다시 출발한다 — 입력을 잠그지 않는다.
    Animated.spring(slide, {
      toValue: target,
      stiffness: CAPSULE_SPRING.stiffness,
      damping: CAPSULE_SPRING.damping,
      mass: CAPSULE_SPRING.mass,
      useNativeDriver: true,
    }).start();
  }, [index, step, slide, reduceMotion]);
  return (
    <View pointerEvents="box-none" style={styles.band} testID="shell-bottom">
      <GlassSurface
        radius={SHELL.barHeight / 2}
        // 리퀴드 글래스는 자기 가장자리 빛을 그린다 — 1px 유리 선을 겹치면 이중선이 된다.
        // 선은 두께를 투명으로 남겨 안쪽 46 의 산수(1+3+46+3+1)를 지킨다.
        style={[styles.bar, material === 'liquid' && styles.barLiquid]}
        testID="shell-tabbar">
        <View style={styles.barRow}>
          <View accessibilityRole="tablist" style={styles.tabs} {...coveredProps(covered)}>
            <Animated.View
              pointerEvents="none"
              importantForAccessibility="no"
              accessibilityElementsHidden
              style={[
                styles.capsule,
                {width: tabWidth, transform: [{translateX: slide}]},
              ]}
              testID="tab-capsule"
            />
            {tabs.map(tab => (
              <TabButton
                key={tab}
                tab={tab}
                width={tabWidth}
                selected={tab === current}
                badge={tab === 'inbox' ? inboxCount : 0}
                unread={tab === 'home' && homeUnread}
                onPress={() => {
                  // 바뀔 때만: 같은 탭을 다시 누르는 것은 값이 넘어가는 것이 아니다.
                  // 시각(탭 전환)과 같은 프레임 — 핸들러 안에서 동기로 부른다.
                  if (tab !== current) haptics.selection();
                  onSelect(tab);
                }}
              />
            ))}
          </View>
        </View>
      </GlassSurface>
      <PlusButton onPress={onPlus} open={plusOpen} covered={covered} />
    </View>
  );
}

/**
 * 탭의 VoiceOver 이름. 배지가 말하는 것을 **그대로** 이름에 싣는다 — 눈에 보이는
 * 수가 「멘션」이 아니라 「나에게 필요한 일」이므로 라벨도 그 낱말이다.
 */
export function tabAccessibilityLabel(
  tab: Tab,
  badge: number,
  unread: boolean,
): string {
  if (badge > 0) return `${tabLabel(tab)}, 나에게 필요한 일 ${badge}개`;
  if (unread) return `${tabLabel(tab)}, 안 읽은 글 있음`;
  return tabLabel(tab);
}

function TabButton({
  tab,
  width,
  selected,
  badge,
  unread,
  onPress,
}: {
  tab: Tab;
  width: number;
  selected: boolean;
  badge: number;
  unread: boolean;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const icon = TAB_ICON[tab];
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{selected}}
      accessibilityLabel={tabAccessibilityLabel(tab, badge, unread)}
      onPress={onPress}
      style={({pressed}) => [
        styles.tab,
        {width},
        pressed && styles.pressed,
      ]}
      testID={`tab-${tab}`}>
      <Image
        source={SHELL_ICONS[icon]}
        style={{
          width: SHELL_ICON_SIZE[icon],
          height: SHELL_ICON_SIZE[icon],
          tintColor: selected ? palette.text : palette.textMuted,
        }}
        testID={`tab-icon-${tab}`}
      />
      {unread ? (
        <View
          style={styles.unreadDot}
          testID={`tab-unread-${tab}`}
          importantForAccessibility="no"
          accessibilityElementsHidden
        />
      ) : null}
      {badge > 0 ? (
        <View style={styles.dot} testID={`tab-dot-${tab}`}>
          <Text
            style={styles.dotLabel}
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            importantForAccessibility="no"
            accessibilityElementsHidden>
            {badge > 99 ? '99+' : String(badge)}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ---- + 단추 ------------------------------------------------------------------

/** + 단추의 VoiceOver 이름. 메뉴의 이름도 같다 — 무엇을 열었는지 한 낱말로 잇는다. */
export const PLUS_LABEL = '새로 만들기';

function PlusButton({
  onPress,
  open,
  covered,
}: {
  onPress: () => void;
  open: boolean;
  covered: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={PLUS_LABEL}
      // 행은 역할·서버 표면에 따라 달라진다(새 채널·작업 콘솔). 힌트가 목록을 읊으면
      // 없는 행을 안내하게 되므로 무엇이 열리는지만 말한다(design-review M2).
      accessibilityHint="만들기 메뉴를 엽니다."
      accessibilityState={{expanded: open}}
      onPress={() => {
        // 메뉴가 **열리는** 누름에만 — 닫는 누름은 열림의 반대라 같은 말이 아니다.
        if (!open) haptics.light();
        onPress();
      }}
      style={({pressed}) => [
        styles.plus,
        pressed && styles.plusPressed,
      ]}
      {...coveredProps(covered)}
      testID="shell-plus">
      <Image
        source={SHELL_ICONS.plus}
        style={{
          width: PLUS_ICON,
          height: PLUS_ICON,
          tintColor: palette.onPrimary,
        }}
        testID="shell-plus-icon"
      />
    </Pressable>
  );
}

/** + 글리프. 26 래스터를 24 로 그린다 — 지름이 64 → 54 로 준 만큼 따라 준다. */
export const PLUS_ICON = 24;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    canvas: {
      flex: 1,
      // 그라데이션을 못 그리는 경로(구 아키텍처·스냅숏)에서는 가운데 정지점 평면이다.
      backgroundColor: color.bg,
      experimental_backgroundImage: `linear-gradient(180deg, ${color.canvasTop} 0%, ${color.bg} 46%, ${color.canvasBottom} 100%)`,
    },
    fade: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: SHELL.fadeHeight,
      // `transparent`는 검정 투명이라 중간에 회색 띠가 선다. 같은 색의 알파 0에서
      // 시작한다 — 시안의 `transparent`가 브라우저에서 그리는 것과 같은 그림이다.
      experimental_backgroundImage: `linear-gradient(180deg, ${color.canvasBottom}00 0%, ${color.canvasBottom} 62%)`,
    },
    band: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: SHELL.bottom,
      // 알약은 흐름의 유일한 자식이라 창 가운데에 선다. + 는 흐름 밖(`plus`).
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
    },
    bar: {
      height: SHELL.barHeight,
      borderRadius: SHELL.barHeight / 2,
      borderWidth: 1,
      borderColor: color.glassLine,
      boxShadow: color.elevationFloat,
      // 시안의 `z-index:20` 은 옮기지 않는다. RN 새 아키텍처에서 zIndex 는 형제의
      // 그리기·누르기 순서를 트리 순서보다 앞세우므로, 여기 20 을 두면 탭바가 뒤에
      // 열리는 층(대화·에이전트 목록)의 **위**에 서서 컴포저를 가린다(design-review
      // B1). 셸은 크롬을 층보다 먼저 그리므로 트리 순서만으로 시안의 겹침이 선다.
    },
    barLiquid: {borderColor: 'transparent'},
    // 시안은 `box-sizing: border-box`라 1px 테두리가 높이 안에 든다. 세로 여백 4 에서
    // 그 1을 빼야 안쪽이 46이 되어 탭 46이 넘치지 않는다: 1 + 3 + 46 + 3 + 1 = 54.
    // 가로는 폭이 내용에서 나오므로(auto) 4 그대로다: 66×3 + 2×2 + 4×2 + 테두리 2 = 212.
    barRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: SHELL.barPadding - 1,
      paddingHorizontal: SHELL.barPadding,
    },
    tabs: {flexDirection: 'row', alignItems: 'center', gap: SHELL.barGap},
    // 선택 채움 — 탭 아래를 미끄러진다. `translateX` 외에는 움직이지 않는다.
    // `color-mix(in srgb, var(--ink) 8%, transparent)` — 잉크 8%(0x14).
    capsule: {
      position: 'absolute',
      left: 0,
      top: 0,
      height: SHELL.tabHeight,
      borderRadius: SHELL.tabHeight / 2,
      backgroundColor: `${color.text}14`,
    },
    tab: {
      width: SHELL.tabWidth,
      height: SHELL.tabHeight,
      borderRadius: SHELL.tabHeight / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pressed: {opacity: 0.6},
    dot: {
      position: 'absolute',
      top: 8,
      right: 16,
      minWidth: SHELL.dot,
      height: SHELL.dot,
      // 시안 9 는 높이 17 의 절반을 넘어 브라우저가 8.5 로 자른다 — 둥근 끝의 산수다.
      borderRadius: SHELL.dot / 2,
      paddingHorizontal: 4,
      alignItems: 'center',
      justifyContent: 'center',
      // 잉크 알약 — 「나에게 필요한 일」은 신호색이 아니라 주 행동과 같은 잉크다.
      backgroundColor: color.primary,
      boxShadow: `0 0 0 2px ${color.surface}`,
    },
    dotLabel: {
      fontSize: ds2Type.badge,
      fontWeight: '800',
      color: color.onPrimary,
    },
    unreadDot: {
      position: 'absolute',
      top: 9,
      right: 20,
      width: SHELL.unreadDot,
      height: SHELL.unreadDot,
      borderRadius: SHELL.unreadDot / 2,
      backgroundColor: color.accent,
      boxShadow: `0 0 0 2px ${color.surface}`,
    },
    plus: {
      position: 'absolute',
      right: SHELL.plusInset,
      top: 0,
      width: SHELL.plus,
      height: SHELL.plus,
      borderRadius: SHELL.plus / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.primary,
      boxShadow: color.elevationFloat,
      // zIndex 없음 — 위 `bar` 주석과 같은 이유.
    },
    plusPressed: {opacity: 0.8},
  });
