import React, {createContext, useContext} from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';

import {GlassSurface} from '../design/glass';
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
//   | 탭바 배치       | 가운데             | 왼쪽 16                | 가운데(묶음 전체가)        |
//   | 탭바 크기       | ≈211×53            | 252×64                 | 212×54                     |
//   | 탭(선택 채움)   | ≈67×46             | 78×52                  | 66×46 · 반경 23            |
//   | 탭바 여백       | ≈3.5               | 6 · 틈 2               | 4 · 틈 2                   |
//   | 새로 만들기     | 별도 FAB 없음      | 오른쪽 64 원 FAB       | 알약 옆 54 원 +(틈 8)      |
//   | + 누르면        | 작은 어두운 팝오버 | 전면 시트              | 작은 팝오버(`PlusMenu`)    |
//   | 하단 크롬 폭    | 211                | 16+252…64+16 = 전폭    | 212 + 8 + 54 = 274         |
//   | 바닥에서        | ≈34                | 30                     | 30(시안 A 값 유지)         |
//
// 재질·색은 시안 A 그대로다(owner 결정: 레퍼런스는 크기·배치만 Buzz):
//
//   .a-tab  glass + blur(22) · 1px glassLine · sh2 (z 20 은 옮기지 않는다 — bar 주석)
//   .a-tab button   ink2 / on: ink 8% 채움 + ink
//   .a-tab .dot     17×17 · accent / onAccent · 10.5/800 · 가로 4 · 2px surface 고리
//                   (자리는 탭이 줄어든 비율로 옮긴다: top 8 · right 16)
//   .a-fab  primary / onPrimary · sh2 — 지름만 64 → 54(탭바 높이와 같다)
//   .a-fade left 0 · right 0 · bottom 0 · height 150 ·
//           linear-gradient(180deg, transparent, bgBot 62%)
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
  /** 탭바와 + 사이. */
  plusGap: 8,
  /** 좁은 창에서 크롬이 창 가장자리에 남길 최소 여백. */
  minInset: 16,
  fadeHeight: 150,
  dot: 17,
  /** 시안 `.a-scroll{padding-bottom:140px}` — 목록 끝이 탭바 밑에 숨지 않게. */
  clearance: 140,
} as const;

/** 테두리 두 줄 + 가로 여백 둘 + 틈 둘 — 탭 폭 밖에서 탭바가 먹는 폭. */
const BAR_CHROME = 2 + SHELL.barPadding * 2 + SHELL.barGap * 2;

/** 탭 폭에서 탭바의 폭. */
export function barWidthFor(tabWidth: number): number {
  return tabWidth * 3 + BAR_CHROME;
}

/**
 * 창 폭에서 탭 하나의 폭.
 *
 * 사양 값(66)은 306pt 창까지 그대로 들어간다: 16 + 212 + 8 + 54 + 16 = 306. 그보다
 * 좁은 창은 폰에 없지만(최소 320), 식은 줄여서 가장자리 여백 16 을 지키고 44 아래로는
 * 가지 않는다.
 */
export function tabWidthFor(windowWidth: number): number {
  const room =
    windowWidth - SHELL.minInset * 2 - SHELL.plus - SHELL.plusGap - BAR_CHROME;
  return Math.max(TOUCH_TARGET, Math.min(SHELL.tabWidth, Math.floor(room / 3)));
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
 * 하단 크롬 — 가운데 정렬된 알약 탭바와 + 단추 한 묶음.
 *
 * 가운데 정렬은 창 폭 전체를 차지하는 절대 띠로 하고, 띠 자신은 누름을 받지 않는다
 * (`box-none`). 띠가 누름을 먹으면 탭바 양옆 빈 자리에서 목록의 마지막 줄이 눌리지
 * 않는다.
 */
export function ShellBottomBar({
  current,
  inboxCount,
  onSelect,
  onPlus,
  plusOpen = false,
  covered = false,
}: {
  current: Tab;
  /** 인박스 점의 수. 0이면 점이 없다. */
  inboxCount: number;
  onSelect: (tab: Tab) => void;
  onPlus: () => void;
  /** + 메뉴가 열려 있는가(보조기술의 「펼쳐짐」). */
  plusOpen?: boolean;
  /** 층이 셸을 덮고 있는가(`coveredProps`). */
  covered?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const tabWidth = tabWidthFor(useWindowDimensions().width);
  return (
    <View pointerEvents="box-none" style={styles.band} testID="shell-bottom">
      <GlassSurface
        radius={SHELL.barHeight / 2}
        style={styles.bar}
        testID="shell-tabbar">
        <View style={styles.barRow}>
          <View accessibilityRole="tablist" style={styles.tabs} {...coveredProps(covered)}>
            {visibleTabs().map(tab => (
              <TabButton
                key={tab}
                tab={tab}
                width={tabWidth}
                selected={tab === current}
                badge={tab === 'inbox' ? inboxCount : 0}
                onPress={() => onSelect(tab)}
              />
            ))}
          </View>
        </View>
      </GlassSurface>
      <PlusButton onPress={onPlus} open={plusOpen} covered={covered} />
    </View>
  );
}

function TabButton({
  tab,
  width,
  selected,
  badge,
  onPress,
}: {
  tab: Tab;
  width: number;
  selected: boolean;
  badge: number;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const icon = TAB_ICON[tab];
  return (
    <Pressable
      accessibilityRole="tab"
      accessibilityState={{selected}}
      accessibilityLabel={
        badge > 0 ? `${tabLabel(tab)}, 멘션 ${badge}개` : tabLabel(tab)
      }
      onPress={onPress}
      style={({pressed}) => [
        styles.tab,
        {width},
        selected && styles.tabOn,
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
      accessibilityHint="새 DM, 새 채널, 에이전트 부르기 메뉴를 엽니다."
      accessibilityState={{expanded: open}}
      onPress={onPress}
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
      flexDirection: 'row',
      justifyContent: 'center',
      alignItems: 'center',
      gap: SHELL.plusGap,
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
    tab: {
      width: SHELL.tabWidth,
      height: SHELL.tabHeight,
      borderRadius: SHELL.tabHeight / 2,
      alignItems: 'center',
      justifyContent: 'center',
    },
    // `color-mix(in srgb, var(--ink) 8%, transparent)` — 잉크 8%(0x14).
    tabOn: {backgroundColor: `${color.text}14`},
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
      backgroundColor: color.accent,
      boxShadow: `0 0 0 2px ${color.surface}`,
    },
    dotLabel: {
      fontSize: ds2Type.badge,
      fontWeight: '800',
      color: color.onAccent,
    },
    plus: {
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
