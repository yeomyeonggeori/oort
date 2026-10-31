import React, {useState} from 'react';
import {
  Image,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  galleryTiles,
  schemeForThemePick,
  pickNotice,
} from '@momo/core/design/themeGallery';
import {
  modesOf,
  themeMoveForScheme,
  moveNotice,
  type ThemeRef,
} from '@momo/core/design/themeResolve';
import type {Mode} from '@momo/core/design/themes';
import {Screen, Sentence} from './atoms';
import {resolveThemeTokens} from './themeCatalog';
import {SHEET_ICONS, SHEET_ICON_SIZE} from './icons';
import {themeChoiceLabel, useStyles, useTheme, type ThemeChoice} from './theme';
import {
  ds2Radius,
  font,
  line,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from './tokens';

/** 타일은 앱 팔레트를 만들지 않고 core 토큰만 읽어요. 짝은 두 반쪽, 단독은 한 면이에요. */
export function ThemePreview({
  theme,
  large = false,
}: {
  theme: ThemeRef;
  large?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.preview, large && styles.previewLarge]}
      testID={`appearance-swatch-${theme}`}
    >
      {modesOf(theme).map(mode => {
        const t = resolveThemeTokens(theme, mode);
        const [top, mid, bottom] = t.canvas;
        return (
          <View
            key={mode}
            testID={`appearance-swatch-${theme}-${mode}`}
            style={[
              styles.half,
              {
                backgroundColor: mid,
                experimental_backgroundImage: `linear-gradient(180deg, ${top} 0%, ${mid} 50%, ${bottom} 100%)`,
              },
            ]}
          >
            <View
              style={[styles.surface, {backgroundColor: t.color.surface}]}
            />
            <View style={[styles.dot, {backgroundColor: t.color.signal}]} />
          </View>
        );
      })}
    </View>
  );
}

const FILTERS: readonly ThemeChoice[] = ['system', 'light', 'dark'];
const modeLabel = (modes: readonly Mode[]) =>
  modes.length === 2
    ? '라이트·다크 짝'
    : modes[0] === 'light'
    ? '라이트'
    : '다크';

/** 진입 스냅샷은 이 페이지 수명에 묶여요. 완료·뒤로는 현재 선택을 유지해요. */
export function ThemePickerPage({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {themeId, choice, setChoice, setTheme, restoreTheme} = useTheme();
  const [entry] = useState(() => ({theme: themeId, choice}));
  const [notice, setNotice] = useState<string | null>(null);
  const pickMode = (next: ThemeChoice) => {
    const move = themeMoveForScheme(themeId, next);
    setNotice(move ? moveNotice(move) : null);
    setChoice(next);
  };
  const pickTheme = (ref: ThemeRef) => {
    const picked = schemeForThemePick(choice, ref);
    setNotice(picked.adjusted ? pickNotice(picked.adjusted) : null);
    setTheme(ref);
  };
  const undo = () => {
    restoreTheme(entry.theme, entry.choice);
    setNotice('처음 고른 테마와 화면 모드로 되돌렸어요.');
  };
  const changed = entry.theme !== themeId || entry.choice !== choice;
  return (
    <Screen>
      <View
        style={styles.page}
        accessibilityViewIsModal
        onAccessibilityEscape={onDone}
        testID="theme-picker-page"
      >
        <View style={styles.header}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="테마 선택 되돌리기"
            accessibilityState={{disabled: !changed}}
            disabled={!changed}
            onPress={undo}
            testID="theme-picker-undo"
            style={({pressed}) => [styles.action, pressed && styles.pressed]}
          >
            <Sentence style={[styles.actionText, !changed && styles.muted]}>
              되돌리기
            </Sentence>
          </Pressable>
          <Sentence accessibilityRole="header" style={styles.title}>
            테마 고르기
          </Sentence>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="테마 선택 완료"
            onPress={onDone}
            testID="theme-picker-done"
            style={({pressed}) => [styles.action, pressed && styles.pressed]}
          >
            <Sentence style={styles.actionText}>완료</Sentence>
          </Pressable>
        </View>
        <View
          accessibilityRole="radiogroup"
          accessibilityLabel="테마 화면 모드 필터"
          style={styles.filters}
        >
          {FILTERS.map(filter => (
            <Pressable
              key={filter}
              accessibilityRole="radio"
              accessibilityLabel={`${themeChoiceLabel(filter)} 테마`}
              accessibilityState={{selected: choice === filter}}
              onPress={() => pickMode(filter)}
              testID={`theme-picker-filter-${filter}`}
              style={({pressed}) => [
                styles.filter,
                choice === filter && styles.filterSelected,
                pressed && styles.pressed,
              ]}
            >
              <Sentence
                style={[
                  styles.filterText,
                  choice === filter && styles.filterTextSelected,
                ]}
              >
                {themeChoiceLabel(filter)}
              </Sentence>
            </Pressable>
          ))}
        </View>
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {paddingBottom: insets.bottom + space.xl},
          ]}
          testID="theme-picker-scroll"
        >
          <Sentence
            style={styles.hint}
            accessibilityLiveRegion="polite"
            testID="theme-picker-notice"
          >
            {notice ??
              '고르면 앱 전체에 바로 보여요. 되돌리기로 처음 선택을 복원할 수 있어요.'}
          </Sentence>
          <View
            accessibilityRole="radiogroup"
            accessibilityLabel="테마 스타일"
            style={styles.grid}
            testID="theme-picker-grid"
          >
            {galleryTiles(choice).map(tile => {
              const selected = themeId === tile.ref;
              return (
                <Pressable
                  key={tile.ref}
                  accessibilityRole="radio"
                  accessibilityLabel={`${tile.label}, ${modeLabel(
                    modesOf(tile.ref),
                  )}`}
                  accessibilityState={{selected}}
                  accessibilityHint="앱 전체에 바로 적용해요."
                  onPress={() => pickTheme(tile.ref)}
                  testID={`appearance-theme-${tile.ref}`}
                  style={({pressed}) => [
                    styles.tile,
                    selected && styles.tileSelected,
                    pressed && styles.pressed,
                  ]}
                >
                  <ThemePreview theme={tile.ref} large />
                  <View style={styles.tileFooter}>
                    <Sentence
                      style={[styles.label, selected && styles.labelSelected]}
                    >
                      {tile.label}
                    </Sentence>
                    {selected ? (
                      <Image
                        source={SHEET_ICONS.check}
                        style={styles.check}
                        accessibilityElementsHidden
                        testID={`appearance-theme-${tile.ref}-check`}
                      />
                    ) : null}
                  </View>
                  {tile.ref === 'noeul' ? (
                    <Sentence style={styles.detail}>
                      폰에서는 남색 띠 없이 평평한 바닥으로 보여요.
                    </Sentence>
                  ) : null}
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>
    </Screen>
  );
}

export function ThemePickerModal({
  onDone,
}: {
  onDone: () => void;
}): React.JSX.Element {
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onDone}
    >
      <ThemePickerPage onDone={onDone} />
    </Modal>
  );
}

const buildStyles = (c: Palette) =>
  StyleSheet.create({
    page: {flex: 1, backgroundColor: c.bg},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.sm,
      paddingVertical: space.sm,
    },
    title: {
      flex: 1,
      textAlign: 'center',
      color: c.text,
      fontSize: font.heading,
      lineHeight: line.heading,
      fontWeight: '700',
    },
    action: {
      minHeight: TOUCH_TARGET,
      minWidth: TOUCH_TARGET + space.xl,
      justifyContent: 'center',
      alignItems: 'center',
      borderRadius: ds2Radius.row,
    },
    actionText: {
      color: c.text,
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
    },
    muted: {color: c.textMuted},
    pressed: {opacity: 0.7},
    filters: {
      flexDirection: 'row',
      marginHorizontal: SAFE_GUTTER,
      padding: space.xs,
      gap: space.xs,
      backgroundColor: c.surfaceMuted,
      borderRadius: ds2Radius.row,
    },
    filter: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.xs,
      borderRadius: ds2Radius.row,
    },
    filterSelected: {backgroundColor: c.primary},
    filterText: {
      fontSize: font.label,
      lineHeight: line.label,
      color: c.textMuted,
      fontWeight: '600',
    },
    filterTextSelected: {color: c.onPrimary},
    content: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.lg,
      gap: space.lg,
    },
    hint: {fontSize: font.label, lineHeight: line.label, color: c.textMuted},
    grid: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      rowGap: space.md,
    },
    tile: {
      width: '48%',
      padding: space.sm,
      gap: space.sm,
      borderRadius: ds2Radius.card,
      borderWidth: 2,
      borderColor: c.border,
      backgroundColor: c.surface,
    },
    tileSelected: {borderColor: c.accentText},
    tileFooter: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    label: {
      flex: 1,
      color: c.text,
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '500',
    },
    labelSelected: {fontWeight: '700'},
    check: {
      width: SHEET_ICON_SIZE.check,
      height: SHEET_ICON_SIZE.check,
      tintColor: c.accentText,
    },
    detail: {color: c.textMuted, fontSize: font.meta, lineHeight: line.meta},
    preview: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      flexDirection: 'row',
      overflow: 'hidden',
      borderRadius: ds2Radius.badge,
    },
    previewLarge: {width: '100%', height: TOUCH_TARGET * 2 + space.sm},
    half: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: space.xs,
    },
    surface: {width: '72%', height: '36%', borderRadius: ds2Radius.badge},
    dot: {width: space.sm, height: space.sm, borderRadius: ds2Radius.pill},
  });
