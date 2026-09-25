import React, {createContext, useContext} from 'react';
import {Image, Pressable, StyleSheet, Text, View} from 'react-native';

import {GlassSurface} from '../design/glass';
import {SHELL_ICONS, SHELL_ICON_SIZE, type ShellIconName} from '../design/icons';
import {BAR_CONTROL_MAX_SCALE} from '../design/atoms';
import {usePalette, useStyles} from '../design/theme';
import {ds2Type, type Palette} from '../design/tokens';
import {tabLabel, visibleTabs, type Tab} from '../nav/state';

// =============================================================================
// 폰 셸의 크롬 — 바닥, 떠 있는 알약 탭바, 잉크 FAB, 스크롤 페이드
// (ADR-0189 D1, 시안 A `#a-home`, DS2-2 #2714).
//
// 값은 시안 CSS 그대로다. 옮긴 곳을 줄마다 적어 두어, 시안과 대조할 때 이 파일이
// 원문 역할을 하게 한다:
//
//   .a-bg   linear-gradient(180deg, bgTop 0%, bgMid 46%, bgBot 100%)
//   .a-tab  left 16 · bottom 30 · height 64 · radius 32 · padding 6 · gap 2 ·
//           glass + blur(22) · 1px glassLine · sh2 · z 20
//   .a-tab button   78×52 · radius 26 · ink2 / on: ink 8% 채움 + ink
//   .a-tab .dot     top 10 · right 22 · 17×17 · radius 9 · accent / onAccent ·
//                   10.5/800 · 가로 4 · 2px surface 고리
//   .a-fab  right 16 · bottom 30 · 64 원 · primary / onPrimary · sh2 · z 20
//   .a-fade left 0 · right 0 · bottom 0 · height 150 ·
//           linear-gradient(180deg, transparent, bgBot 62%)
//
// 탭바는 아이콘만 든다. 시안이 그렇고, 이름은 VoiceOver 라벨이 진다(탭마다
// `tabLabel`). 아이콘이 글자를 대신하므로 Dynamic Type 으로 커질 글자가 탭바에
// 없다 — 옛 탭바가 큰 글자에서 세로로 자라던 규칙은 이 탭바에 물려받을 대상이 없다.
// =============================================================================

/** 시안 수치. 캡처와 시험이 같은 이름을 읽는다. */
export const SHELL = {
  inset: 16,
  bottom: 30,
  barHeight: 64,
  barPadding: 6,
  barGap: 2,
  tabWidth: 78,
  tabHeight: 52,
  fab: 64,
  fadeHeight: 150,
  dot: 17,
  /** 시안 `.a-scroll{padding-bottom:140px}` — 목록 끝이 탭바 밑에 숨지 않게. */
  clearance: 140,
} as const;

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

export function FloatingTabBar({
  current,
  inboxCount,
  onSelect,
}: {
  current: Tab;
  /** 인박스 점의 수. 0이면 점이 없다. */
  inboxCount: number;
  onSelect: (tab: Tab) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <GlassSurface
      radius={SHELL.barHeight / 2}
      style={styles.bar}
      testID="shell-tabbar">
      <View accessibilityRole="tablist" style={styles.barRow}>
        {visibleTabs().map(tab => {
          const selected = tab === current;
          const badge = tab === 'inbox' ? inboxCount : 0;
          const icon = TAB_ICON[tab];
          return (
            <Pressable
              key={tab}
              accessibilityRole="tab"
              accessibilityState={{selected}}
              accessibilityLabel={
                badge > 0 ? `${tabLabel(tab)}, 멘션 ${badge}개` : tabLabel(tab)
              }
              onPress={() => onSelect(tab)}
              style={({pressed}) => [
                styles.tab,
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
        })}
      </View>
    </GlassSurface>
  );
}

// ---- 잉크 FAB ----------------------------------------------------------------

export function InkFab({onPress}: {onPress: () => void}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="새 메시지"
      accessibilityHint="받는 사람을 고르거나 에이전트를 부릅니다."
      onPress={onPress}
      style={({pressed}) => [styles.fab, pressed && styles.fabPressed]}
      testID="shell-fab">
      <Image
        source={SHELL_ICONS.plus}
        style={{
          width: SHELL_ICON_SIZE.plus,
          height: SHELL_ICON_SIZE.plus,
          tintColor: palette.onPrimary,
        }}
        testID="shell-fab-icon"
      />
    </Pressable>
  );
}

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
    bar: {
      position: 'absolute',
      left: SHELL.inset,
      bottom: SHELL.bottom,
      height: SHELL.barHeight,
      borderRadius: SHELL.barHeight / 2,
      borderWidth: 1,
      borderColor: color.glassLine,
      boxShadow: color.elevationFloat,
      zIndex: 20,
    },
    // 시안은 `box-sizing: border-box`라 1px 테두리가 높이 64 안에 든다. 세로 여백
    // 6에서 그 1을 빼야 안쪽이 52가 되어 탭 52가 넘치지 않는다. 가로는 폭이 내용에서
    // 나오므로(auto) 6 그대로다: 78×3 + 2×2 + 6×2 + 테두리 2 = 252.
    barRow: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: SHELL.barGap,
      paddingVertical: SHELL.barPadding - 1,
      paddingHorizontal: SHELL.barPadding,
    },
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
      top: 10,
      right: 22,
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
    fab: {
      position: 'absolute',
      right: SHELL.inset,
      bottom: SHELL.bottom,
      width: SHELL.fab,
      height: SHELL.fab,
      borderRadius: SHELL.fab / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.primary,
      boxShadow: color.elevationFloat,
      zIndex: 20,
    },
    fabPressed: {backgroundColor: color.text, opacity: 0.85},
  });
