import {buildExpressionSections} from '@momo/core/features/expressions/gridSections';
import {
  FAVORITES_SECTION,
  RECENT_SECTION,
  EXPRESSION_SECTION_NAME_KEY,
} from '@momo/core/features/expressions/gridSections';
import {expressionAltText} from '@momo/core/features/expressions/message';
import type {Expression} from '@momo/core/features/expressions/types';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {HEAD_MAX_SCALE, Sentence} from '../../design/atoms';
import {CONV_ICON_SIZE, CONV_ICONS} from '../../design/icons';
import {useStyles} from '../../design/theme';
import {ds2Radius, font, line, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {haptics} from '../../lib/haptics';
import {WORD} from '../../lib/techWords';
import {useReduceMotion} from '../../lib/useReduceMotion';
import {ExpressionImage} from './ExpressionImage';
import {useExpressions} from './ExpressionProvider';
import {
  layoutPanelSections,
  offsetOfSection,
  PANEL_HEADER_HEIGHT,
  PANEL_ROW_HEIGHT,
  panelColumns,
  sectionAtOffset,
  type PanelOpening,
  type PanelSectionLayout,
} from './panelModel';
import {useExpressionFavorites} from './useExpressionFavorites';
import {useExpressionMessages, type PlainMessageKey} from './useExpressionMessages';

// =============================================================================
// 키보드 자리 창의 이모티콘·GIF 탭 (#5452, owner 2026-11-07) - 그림만 보이는 격자 + 창 아래 세트 띠.
//
// 구역은 최근 → 즐겨찾기 → 세트별 → 기타(코어 `buildExpressionSections`, 웹과 같은 함수). 우리 팀 것과 기본 것을 가르지 않는다. 이모티콘 탭의 맨 위 칸은 정지 그림과 GIF 를 섞은 「자주·최근」이고(#5503),
// 창이 열려 있는 동안 차례가 바뀌지 않게 창이 연 순간 쥔 사용 기록·시각(`opening`)으로만 센다. 칸에는 글이 없고(낭독 이름만) 구역마다 작은 이름줄이 있다.
// 창 아래 띠: 🕘 최근 · ★ 즐겨찾기 · 세트마다 첫 그림 · 기타, 끝의 ＋(가져오기·AI와 만들기). 누르면 그 구역으로 건너뛰고 지금 구역이 표시된다. 비어 있는 최근·즐겨찾기는 띠에 없다.
// 칸을 누르면 미리 보기에 올라가고(고르기만 하고 보내지 않는다), 길게 누르면 즐겨찾기를 켜고 끈다(이 기기 안, 서버 계약 없음).
//
// 네 상태: 불러오는 중 · 오류(다시 시도) · 비어 있음(만드는 길을 말한다) · 있음. ＋ 는 어느 상태에서도 서 있다.
// =============================================================================

export type PanelGridTab = 'emoticon' | 'gif';

/** 칸 하나의 가로(pt)를 정하는 기준: 정지 그림 64 + 칸 여백. 열 수는 글자 배율만큼 줄어든다. */
const TILE_CELL = 72;
const STRIP_BUTTON = 40;
const STRIP_IMAGE = 32;
/** 띠로 건너뛴 직후 스크롤 이벤트가 표시를 되돌리지 않게 잠그는 시간(ms). */
const JUMP_HOLD_MS = 500;

const EMPTY_COPY: Readonly<Record<PanelGridTab, PlainMessageKey>> = {
  emoticon: 'expressions.panel.emptyEmoticon',
  gif: 'expressions.panel.emptyGif',
};
const GLYPH_STAR = '★';
// 시험 열쇠는 컴포넌트 밖에서 만든다: 직접 문구 장부는 JSX 안의 문자열 조각을 문구로 센다. 칸의 열쇠는 보관함 격자·팀 이모지 줄과 같다.
const EMPTY_ID = 'expression-panel-empty';
const stateTestId = (state: string) => `expression-panel-${state}`;
const sectionTestId = (id: string) => `expression-panel-section-${id}`;
const cellTestId = (name: string) => `expression-pick-${name}`;
const setTestId = (id: string) => `expression-panel-set-${id}`;

export function ExpressionPanelGrid({
  tab,
  opening,
  previewId,
  onPick,
  onAdd,
}: {
  tab: PanelGridTab;
  /** 창을 연 순간의 사용 기록과 시각(창이 한 번 쥔다). 맨 위 칸의 차례는 이 둘로만 센다. */
  opening: PanelOpening;
  /** 지금 미리 보기에 올라 있는 등록의 id(칸이 눌린 모양으로 선다). */
  previewId: string | null;
  onPick: (item: Expression) => void;
  onAdd: () => void;
}) {
  const {items, state, store} = useExpressions();
  const {favorites, isFavorite, toggle} = useExpressionFavorites();
  const formatMessage = useExpressionMessages();
  const styles = useStyles(buildStyles);
  const {width, fontScale} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotion();
  const columns = panelColumns(width, SAFE_GUTTER, fontScale, TILE_CELL);
  const sections = useMemo(
    () =>
      buildExpressionSections(items, tab, {
        query: '',
        usage: opening.usage,
        favorites,
        nowMs: opening.nowMs,
      }),
    [items, tab, opening, favorites],
  );
  const {layouts} = useMemo(() => layoutPanelSections(sections, columns), [sections, columns]);
  const list = useRef<FlatList<PanelSectionLayout>>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const viewport = useRef(0);
  const content = useRef(0);
  const holdUntil = useRef(0);
  const current = activeId !== null && layouts.some(layout => layout.section.id === activeId) ? activeId : layouts[0]?.section.id ?? null;

  useEffect(() => {
    // 탭이나 목록이 바뀌면 맨 위로 간다(구역 위치가 다 달라졌다).
    list.current?.scrollToOffset({offset: 0, animated: false});
    setActiveId(null);
  }, [tab]);

  const jump = useCallback(
    (id: string) => {
      const top = offsetOfSection(layouts, id);
      if (top === null) return;
      holdUntil.current = Date.now() + JUMP_HOLD_MS;
      setActiveId(id);
      list.current?.scrollToOffset({offset: top, animated: !reduceMotion});
    },
    [layouts, reduceMotion],
  );
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (Date.now() < holdUntil.current) return;
      const next = sectionAtOffset(layouts, event.nativeEvent.contentOffset.y, viewport.current, content.current);
      setActiveId(previous => (next === null || previous === next ? previous : next));
    },
    [layouts],
  );
  const toggleFavorite = useCallback(
    (item: Expression) => {
      const added = toggle(item.id);
      haptics.light();
      AccessibilityInfo.announceForAccessibility(
        formatMessage(added ? 'expressions.picker.favoriteAdded' : 'expressions.picker.favoriteRemoved', {
          name: expressionAltText(item),
        }),
      );
    },
    [toggle, formatMessage],
  );

  const sectionTitle = (layout: PanelSectionLayout): string => {
    const key = EXPRESSION_SECTION_NAME_KEY[layout.section.kind];
    return key === null ? layout.section.label ?? '' : formatMessage(key);
  };

  const notice =
    state === WORD.offline
      ? formatMessage('expressions.sheet.offline')
      : state === WORD.error
      ? formatMessage('expressions.sheet.error')
      : state === WORD.loading
      ? formatMessage('expressions.sheet.loading')
      : formatMessage(EMPTY_COPY[tab]);
  const noticeId = state === WORD.ready ? EMPTY_ID : stateTestId(state);

  return (
    <View style={styles.root} testID="expression-panel-grid">
      <FlatList
        ref={list}
        data={layouts}
        keyExtractor={layout => layout.section.id}
        style={styles.list}
        contentContainerStyle={styles.listContent}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        initialNumToRender={3}
        windowSize={5}
        scrollEventThrottle={32}
        onScroll={onScroll}
        onLayout={event => {
          viewport.current = event.nativeEvent.layout.height;
        }}
        onContentSizeChange={(_w, h) => {
          content.current = h;
        }}
        getItemLayout={(_data, index) => ({
          length: layouts[index]?.height ?? 0,
          offset: layouts[index]?.top ?? 0,
          index,
        })}
        ListEmptyComponent={
          <View style={styles.notice} testID={noticeId}>
            {/* 완성된 한국어 문장은 어절 단위로 줄바꿈한다 - 맨 `Text` 는 낱말 가운데서 끊는다(#5065 M1). */}
            <Sentence style={styles.noticeText} accessibilityLiveRegion="polite">
              {notice}
            </Sentence>
            {state === WORD.error ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void store?.refresh(true);
                }}
                style={styles.retry}
                testID="expression-panel-retry">
                <Text style={styles.retryLabel}>{formatMessage('expressions.sheet.retry')}</Text>
              </Pressable>
            ) : null}
          </View>
        }
        renderItem={({item: layout}) => (
          <View style={{height: layout.height}} testID={sectionTestId(layout.section.id)}>
            <Text
              style={styles.sectionTitle}
              numberOfLines={1}
              maxFontSizeMultiplier={HEAD_MAX_SCALE}
              accessibilityRole="header">
              {sectionTitle(layout)}
            </Text>
            {layout.rows.map(row => (
              <View key={row[0].id} style={styles.row}>
                {row.map(item => (
                  <Pressable
                    key={item.id}
                    accessibilityRole="button"
                    accessibilityLabel={expressionAltText(item)}
                    accessibilityState={{selected: item.id === previewId}}
                    accessibilityActions={[
                      {
                        name: WORD.favorite,
                        label: formatMessage(isFavorite(item.id) ? 'expressions.picker.favoriteRemove' : 'expressions.picker.favoriteAdd'),
                      },
                    ]}
                    onAccessibilityAction={() => toggleFavorite(item)}
                    onPress={() => onPick(item)}
                    onLongPress={() => toggleFavorite(item)}
                    delayLongPress={450}
                    style={({pressed}) => [
                      styles.cell,
                      {width: (width - SAFE_GUTTER * 2) / columns},
                      (pressed || item.id === previewId) && styles.cellOn,
                    ]}
                    testID={cellTestId(item.name)}>
                    <ExpressionImage expression={item} size="tile" />
                  </Pressable>
                ))}
              </View>
            ))}
          </View>
        )}
      />
      <View style={[styles.strip, {paddingBottom: Math.max(insets.bottom, space.xs)}]} testID="expression-panel-strip">
        <FlatList
          horizontal
          data={layouts}
          keyExtractor={layout => layout.section.id}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          accessibilityLabel={formatMessage('expressions.picker.setStrip')}
          style={styles.stripList}
          contentContainerStyle={styles.stripContent}
          renderItem={({item: layout}) => {
            const kind = layout.section.kind;
            const on = layout.section.id === current;
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sectionTitle(layout)}
                accessibilityState={{selected: on}}
                onPress={() => jump(layout.section.id)}
                style={[styles.stripButton, on && styles.stripButtonOn]}
                testID={setTestId(layout.section.id)}>
                {layout.section.id === RECENT_SECTION ? (
                  <Image source={CONV_ICONS.recent} style={styles.stripGlyph} importantForAccessibility="no" />
                ) : layout.section.id === FAVORITES_SECTION ? (
                  <Text style={styles.stripStar} allowFontScaling={false} importantForAccessibility="no">
                    {GLYPH_STAR}
                  </Text>
                ) : kind === WORD.other ? (
                  <Text style={styles.stripText} numberOfLines={1} maxFontSizeMultiplier={HEAD_MAX_SCALE}>
                    {sectionTitle(layout)}
                  </Text>
                ) : (
                  <View style={styles.stripImage}>
                    <ExpressionImage expression={layout.section.items[0]} size="grid" />
                  </View>
                )}
              </Pressable>
            );
          }}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={formatMessage('expressions.picker.add')}
          onPress={onAdd}
          style={({pressed}) => [styles.stripButton, styles.stripAdd, pressed && styles.cellOn]}
          testID="expression-panel-add">
          <Image source={CONV_ICONS.plus} style={styles.stripGlyph} importantForAccessibility="no" />
        </Pressable>
      </View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    list: {flex: 1},
    listContent: {paddingHorizontal: SAFE_GUTTER, flexGrow: 1},
    sectionTitle: {
      height: PANEL_HEADER_HEIGHT,
      paddingTop: space.sm,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '600',
    },
    row: {flexDirection: WORD.row, height: PANEL_ROW_HEIGHT},
    cell: {
      height: PANEL_ROW_HEIGHT,
      alignItems: WORD.center,
      justifyContent: WORD.center,
      borderRadius: ds2Radius.row,
    },
    cellOn: {backgroundColor: color.accentSurface},
    notice: {paddingVertical: space.xl, gap: space.md, alignItems: 'flex-start'},
    noticeText: {fontSize: font.body, lineHeight: line.body, color: color.textMuted},
    retry: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      justifyContent: WORD.center,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surfaceMuted,
    },
    retryLabel: {fontSize: font.body, lineHeight: line.body, color: color.text},
    // 세트 띠: 창 바닥(홈 표시 줄 위). 위에 가는 선 하나로 격자와 가른다.
    strip: {
      flexDirection: WORD.row,
      alignItems: WORD.center,
      paddingTop: space.xs,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: color.border,
      backgroundColor: color.surface,
    },
    stripList: {flex: 1},
    stripContent: {paddingHorizontal: SAFE_GUTTER - space.xs, gap: space.xs, alignItems: WORD.center},
    stripButton: {
      minWidth: STRIP_BUTTON,
      height: TOUCH_TARGET,
      paddingHorizontal: space.xs,
      alignItems: WORD.center,
      justifyContent: WORD.center,
      borderRadius: ds2Radius.row,
    },
    stripButtonOn: {backgroundColor: color.accentSurface},
    stripAdd: {marginRight: SAFE_GUTTER - space.xs},
    stripGlyph: {
      width: CONV_ICON_SIZE.plus,
      height: CONV_ICON_SIZE.plus,
      tintColor: color.icon,
    },
    stripStar: {fontSize: font.title, color: color.icon},
    stripText: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    stripImage: {width: STRIP_IMAGE, height: STRIP_IMAGE, alignItems: WORD.center, justifyContent: WORD.center},
  });
