import {
  displayGlyph,
  EMOJI_CATEGORIES,
  foldEmoji,
  resolveCatalogEmoji,
  type CatalogEmoji,
} from '@momo/core/features/emoji/catalog';
import {
  filterEmojis,
  isEmojiSearchQuery,
} from '@momo/core/features/emoji/search';
import {mergeEmojiRanking} from '@momo/core/features/emoji/preferences';
import {
  PICKER_EMOJI,
  EMOJI_SKIN_OPTIONS as TONES,
} from '@momo/core/features/emoji/choices';
import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import {REACTION_GLYPH_MAX_SCALE, Sentence} from '../../design/atoms';
import {
  usePageSheetClose,
  usePageSheetScrollProps,
} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {useKeyboardAppearance, useStyles} from '../../design/theme';
import {
  font,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {emojiHaptic} from './haptics';
import {useKeyboardHeight} from '../../lib/useKeyboardHeight';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {loadPhoneEmojiCatalog} from './catalog';
import {emojiFrequency, emojiSkinTone} from './preferences';

/**
 * #4678 extension seam, rendered inside the existing PageSheet, never another Modal.
 * `team` is deliberately empty in #4322. #4678 can supply
 * `{render: ({query, onClose}) => ReactNode}` using the representation model in
 * `@momo/core/features/expressions/`. The renderer owns its typed selection callback
 * (captured by the caller), loading/error/empty states and list virtualization.
 * The standard `onSelect(glyph)` callback remains Unicode-only. No custom IDs or URLs
 * are sent to the Unicode reaction/status API through this seam.
 */
export interface TeamEmojiSlot {
  render: (props: {query: string; onClose: () => void}) => React.ReactNode;
}

export interface EmojiPickerProps {
  onSelect: (glyph: string) => void;
  /** Return to the action/status editor, preserving its draft. */
  onClose: () => void;
  team?: TeamEmojiSlot;
  /**
   * 입력창 표현 시트(#4942)가 머리와 검색을 직접 갖고 이 본문만 쓸 때. 머리·검색 칸·「우리 팀」 탭을 그리지 않고
   * 검색어를 위에서 받는다 — 분류 칩·피부색·격자·빈/오류 문장은 반응·상태 고르개와 같은 코드다.
   *
   * 검색어의 주인이 위(시트)라서 **지우는 손도 위에 있다**(#5065). 빈 결과의 「검색 지우기」가 이 본문 안의 상태만 비우면
   * 화면의 검색어와 결과는 그대로여서 눌러도 아무 일도 없는 죽은 단추가 된다. 그래서 `onClearQuery` 는 필수다 —
   * 끼워 넣는 쪽이 빠뜨리면 타입이 먼저 막는다.
   */
  embedded?: {query: string; onClearQuery: () => void};
}

type Tab = (typeof EMOJI_CATEGORIES)[number]['id'] | 'team';
const TABS = [...EMOJI_CATEGORIES, {id: 'team', label: '우리 팀'}] as const;
const ROW_HEIGHT = TOUCH_TARGET + space.xs;

/** Sheet body shared by reactions and status. The caller owns the one PageSheet. */
export function EmojiPicker({
  onSelect,
  onClose,
  team,
  embedded,
}: EmojiPickerProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {width} = useWindowDimensions();
  const keyboardAppearance = useKeyboardAppearance();
  const keyboardHeight = useKeyboardHeight();
  const insets = useSafeAreaInsets();
  const columns = Math.max(
    1,
    Math.min(8, Math.floor((width - SAFE_GUTTER * 2) / TOUCH_TARGET)),
  );
  const [ownQuery, setQuery] = useState('');
  const query = embedded ? embedded.query : ownQuery;
  // 검색어를 가진 쪽이 지운다: 독립 고르개는 제 상태, 시트에 끼워진 본문은 시트의 검색어(#5065).
  const clearQuery = embedded ? embedded.onClearQuery : () => setQuery('');
  const [tab, setTab] = useState<Tab>('frequent');
  const [catalog, setCatalog] = useState<CatalogEmoji[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const ranking = useSyncExternalStore(
    emojiFrequency.subscribe,
    emojiFrequency.snapshot,
  );
  const tone = useSyncExternalStore(
    emojiSkinTone.subscribe,
    emojiSkinTone.snapshot,
  );
  const list = useRef<FlatList<CatalogEmoji[]>>(null);
  const scrollProps = usePageSheetScrollProps();
  const closePicker = usePageSheetClose() ?? onClose;

  useEffect(() => {
    let alive = true;
    setFailed(false);
    loadPhoneEmojiCatalog()
      .then(entries => {
        if (alive) setCatalog(entries);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const entries = useMemo(() => {
    if (!catalog || tab === 'team') return [];
    if (isEmojiSearchQuery(query)) return filterEmojis(catalog, query);
    if (tab !== 'frequent')
      return catalog.filter(entry => entry.category === tab);
    const seen = new Set<string>();
    return mergeEmojiRanking(ranking, PICKER_EMOJI, 32).flatMap(glyph => {
      const entry = resolveCatalogEmoji(catalog, glyph);
      if (!entry || seen.has(foldEmoji(entry.glyph))) return [];
      seen.add(foldEmoji(entry.glyph));
      return [entry];
    });
  }, [catalog, tab, query, ranking]);
  const rows = useMemo(() => {
    const out: CatalogEmoji[][] = [];
    for (let index = 0; index < entries.length; index += columns)
      out.push(entries.slice(index, index + columns));
    return out;
  }, [entries, columns]);
  useEffect(() => {
    list.current?.scrollToOffset({offset: 0, animated: false});
  }, [tab, query, columns]);

  const select = (entry: CatalogEmoji) => {
    const glyph = displayGlyph(entry, tone);
    emojiFrequency.record(entry.glyph);
    Keyboard.dismiss();
    onSelect(glyph);
  };
  // 같은 시트의 다른 탭(`expressions.sheet.noMatch` 「찾는 표현이 없어요」)과 말씨를 맞춘다: 해요체(#5065, design-review L1).
  // 네 문장이 한 삼항식이라 하나만 바꾸면 같은 탭 안에서 말씨가 다시 갈린다.
  const empty = failed
    ? '이모지 목록을 불러오지 못했어요.'
    : catalog === null
    ? '이모지 목록을 불러오는 중이에요.'
    : catalog.length === 0
    ? '이 기기에서 쓸 수 있는 이모지가 없어요. OS를 업데이트해 주세요.'
    : '찾는 이모지가 없어요. 다른 이름으로 검색해 보세요.';

  return (
    <>
      {embedded ? null : (
        <SheetHeader
          title="이모지 고르기"
          closeLabel="이모지 고르기 닫기"
          onClose={closePicker}
          closeTestID="emoji-picker-close"
        />
      )}
      <View style={styles.controls}>
        {embedded ? null : (
          <TextInput
            accessibilityLabel="이모지 검색"
            placeholder="이름이나 :code:로 검색"
            placeholderTextColor={styles.placeholder.color}
            value={query}
            onChangeText={setQuery}
            keyboardAppearance={keyboardAppearance}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            onSubmitEditing={Keyboard.dismiss}
            style={styles.search}
            testID="emoji-search"
          />
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          testID="emoji-tabs"
        >
          {(embedded ? EMOJI_CATEGORIES : TABS).map(item => (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityLabel={item.label}
              accessibilityState={{selected: tab === item.id}}
              testID={`emoji-tab-${item.id}`}
              onPress={() => {
                if (tab !== item.id) {
                  emojiHaptic('tabChanged');
                  setTab(item.id);
                }
              }}
              style={({pressed}) => [
                styles.tab,
                tab === item.id && styles.selected,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.label}>{item.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
        {tab !== 'team' && keyboardHeight === 0 ? (
          <View style={styles.tones} accessibilityLabel="피부색" testID="emoji-tones">
            {TONES.map(item => (
              <Pressable
                key={item.tone}
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{selected: tone === item.tone}}
                testID={`emoji-tone-${item.tone}`}
                onPress={() => {
                  if (tone !== item.tone) {
                    emojiHaptic('filterChanged');
                    emojiSkinTone.set(item.tone);
                  }
                }}
                style={({pressed}) => [
                  styles.cell,
                  styles.toneChip,
                  tone === item.tone && styles.toneChipSelected,
                  pressed && styles.pressed,
                ]}
              >
                <Text
                  style={styles.glyph}
                  maxFontSizeMultiplier={REACTION_GLYPH_MAX_SCALE}
                >
                  {item.glyph}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}
      </View>
      {tab === 'team' ? (
        team ? (
          team.render({query, onClose})
        ) : (
          <View style={styles.notice} testID="emoji-team-empty">
            <Text style={styles.label}>아직 우리 팀 이모지가 없습니다.</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => setTab('people')}
              style={styles.tab}
            >
              <Text style={styles.label}>기본 이모지 고르기</Text>
            </Pressable>
          </View>
        )
      ) : (
        <FlatList
          ref={list}
          {...scrollProps}
          style={[styles.list, {marginBottom: keyboardHeight}]}
          contentContainerStyle={[
            styles.grid,
            {paddingBottom: Math.max(insets.bottom, space.lg)},
          ]}
          data={rows}
          keyExtractor={row => row[0].glyph}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={5}
          getItemLayout={(_, index) => ({
            length: ROW_HEIGHT,
            offset: ROW_HEIGHT * index,
            index,
          })}
          testID="emoji-grid"
          ListEmptyComponent={
            <View style={styles.notice} testID="emoji-empty">
              {/* 완성된 한국어 문장은 어절 단위로 줄바꿈한다 — 맨 `Text` 는 「검색해 보세 / 요.」로 낱말 가운데서 끊었다(#5065 M1). */}
              <Sentence
                style={styles.label}
                accessibilityRole={failed ? 'alert' : 'text'}
              >
                {empty}
              </Sentence>
              {failed ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => setAttempt(value => value + 1)}
                  style={styles.tab}
                  testID="emoji-retry"
                >
                  <Text style={styles.label}>다시 시도</Text>
                </Pressable>
              ) : catalog !== null && catalog.length > 0 ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={clearQuery}
                  style={styles.tab}
                  testID="emoji-clear-search"
                >
                  <Text style={styles.label}>검색 지우기</Text>
                </Pressable>
              ) : null}
            </View>
          }
          renderItem={({item}) => (
            <View style={styles.row}>
              {item.map(entry => (
                <Pressable
                  key={entry.glyph}
                  accessibilityRole="button"
                  accessibilityLabel={entry.koreanName ?? entry.name}
                  testID={`emoji-pick-${entry.glyph}`}
                  onPress={() => select(entry)}
                  style={({pressed}) => [
                    styles.cell,
                    pressed && styles.selected,
                  ]}
                >
                  <Text
                    style={styles.glyph}
                    maxFontSizeMultiplier={REACTION_GLYPH_MAX_SCALE}
                  >
                    {displayGlyph(entry, tone)}
                  </Text>
                </Pressable>
              ))}
            </View>
          )}
        />
      )}
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    controls: {paddingHorizontal: SAFE_GUTTER, gap: space.xs},
    placeholder: {color: color.textMuted},
    search: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderWidth: 1,
      borderColor: color.textFaint,
      borderRadius: radius.md,
      fontSize: font.body,
      color: color.text,
    },
    tab: {
      minHeight: TOUCH_TARGET,
      justifyContent: 'center',
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: radius.pill,
    },
    label: {fontSize: font.body, color: color.text},
    // 피부색 줄은 이모지 칸과 구분된다(#4982): 같은 44 정사각 칸·같은 고른 면을 쓰면 여섯 손이 격자의 첫 줄처럼 읽혀서 눌러
    // 이모지를 고르는 줄인지 설정 줄인지 알 수 없었다. 그래서 줄이 자기 쟁반(조용한 면 + 가는 테두리 + 알약)에 서고, 칸은 둥근
    // 정사각이 아니라 원이며, 고른 칸은 격자의 옅은 면이 아니라 신호색 고리다. 칸의 상자는 그대로 44(눌림 높이)다.
    tones: {
      flexDirection: 'row',
      alignSelf: 'flex-start',
      padding: space.xs,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    // 격자 칸(`cell`)과 같은 44 상자 위에 도형만 바꾼다: 원 + 고리 자리(고르지 않으면 투명).
    toneChip: {borderRadius: radius.pill, borderWidth: 2, borderColor: 'transparent'},
    toneChipSelected: {borderColor: color.accent},
    selected: {backgroundColor: color.accentSurface},
    pressed: {opacity: 0.6},
    glyph: {fontSize: font.title, color: color.text},
    cell: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
    },
    row: {height: ROW_HEIGHT, flexDirection: 'row'},
    grid: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.lg},
    list: {flex: 1},
    notice: {padding: SAFE_GUTTER, gap: space.sm},
  });
