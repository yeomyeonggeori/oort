import {
  recentExpressions,
  frequentExpressions,
} from '@momo/core/features/expressions/usage';
import type {Expression} from '@momo/core/features/expressions/types';
import type {Channel} from '@momo/core/lib/api';
import {searchExpressions} from '@momo/core/features/expressions/search';
import {
  buildExpressionMessage,
  expressionAltText,
} from '@momo/core/features/expressions/message';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {usePageSheetScrollProps} from '../../design/PageSheet';
import {useStyles} from '../../design/theme';
import {
  font,
  line,
  space,
  SAFE_GUTTER,
  TOUCH_TARGET,
  ds2Radius,
  type Palette,
} from '../../design/tokens';
import {useKeyboardHeight} from '../../lib/useKeyboardHeight';
import {ExpressionAddMenu, useCanAddExpression} from './ExpressionAddMenu';
import {ExpressionImage} from './ExpressionImage';
import {ExpressionImportForm} from './ExpressionImportForm';
import {ExpressionMakeForm} from './ExpressionMakeForm';
import {useExpressions} from './ExpressionProvider';

type Filter = 'emoji' | 'sticker' | 'gif' | 'recent' | 'frequent';
const FILTERS = [
  {id: 'emoji', label: '이모지'},
  {id: 'sticker', label: '스티커'},
  {id: 'gif', label: '우리 팀 GIF'},
  {id: 'recent', label: '최근'},
  {id: 'frequent', label: '자주'},
] as const;

/** 「＋」가 여는 안쪽 장 둘. 목록이 아닌 동안은 고르개의 본문이 그 장으로 바뀐다(`ExpressionChapter` 머리말). */
type Chapter = 'list' | 'import' | 'make';

export function TeamExpressionPicker({
  query,
  onSelect,
  mode = 'reaction',
  onOpenConversation,
}: {
  query: string;
  onSelect: (token: string) => void;
  mode?: 'reaction' | 'message';
  /** 「AI와 만들기」 요청을 보낸 뒤 그 에이전트 DM 으로 간다. 호스트가 대화로 가는 길을 줄 때만 서고, 시트를 먼저 내린다. */
  onOpenConversation?: (channel: Channel) => void;
}) {
  const {items, state, store, usage} = useExpressions();
  const canAdd = useCanAddExpression();
  const [chapter, setChapter] = useState<Chapter>('list');
  const styles = useStyles(buildStyles);
  const {width, fontScale} = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();
  const scrollProps = usePageSheetScrollProps();
  const [filter, setFilter] = useState<Filter>('emoji');
  const [preview, setPreview] = useState<Expression | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState(false);
  const selection = useRef(0);
  const locked = useRef(false);
  const columns = Math.max(
    1,
    Math.floor(
      (width - SAFE_GUTTER * 2) / (TOUCH_TARGET * Math.max(1, fontScale)),
    ),
  );
  const results = useMemo(() => {
    const found = searchExpressions(
      items,
      query.replace(/^:|:$/g, ''),
      usage,
    ).filter(
      item => filter !== 'gif' || item.media?.small.mime === 'image/gif',
    );
    if (!usage || (filter !== 'recent' && filter !== 'frequent')) return found;
    const ranked =
      filter === 'recent'
        ? recentExpressions(usage)
        : frequentExpressions(usage);
    return ranked.flatMap(entry => found.filter(item => item.id === entry.id));
  }, [items, query, filter, usage]);
  const rows = useMemo(() => {
    const next: Expression[][] = [];
    for (let i = 0; i < results.length; i += columns)
      next.push(results.slice(i, i + columns));
    return next;
  }, [results, columns]);
  useEffect(() => {
    setPreview(null);
    setSelectionError(false);
    locked.current = false;
    setSelecting(false);
    return () => {
      selection.current += 1;
    };
  }, [query, filter]);
  const current =
    preview &&
    items.find(
      item =>
        item.id === preview.id &&
        item.name === preview.name &&
        item.status === 'active',
    );
  const choose = async (item: Expression) => {
    if (!store || locked.current) return;
    locked.current = true;
    const attempt = selection.current;
    setSelecting(true);
    setSelectionError(false);
    // Selection can outlive a report/delete elsewhere. Re-resolve before handing off.
    await store.refresh();
    if (attempt !== selection.current) return;
    const active =
      store.snapshot().state === 'ready' &&
      store
        .snapshot()
        .items.find(
          entry =>
            entry.id === item.id &&
            entry.name === item.name &&
            entry.status === 'active',
        );
    setSelecting(false);
    if (!active) {
      locked.current = false;
      setSelectionError(true);
      return;
    }
    Keyboard.dismiss();
    onSelect(buildExpressionMessage(active).body);
  };
  const notice =
    state === 'offline'
      ? '오프라인이에요. 연결되면 팀 보관함을 볼 수 있어요.'
      : state === 'error'
      ? '팀 보관함을 불러오지 못했어요. 다시 시도해 주세요.'
      : state === 'loading'
      ? '팀 보관함을 불러오는 중이에요.'
      : query
      ? '찾는 표현이 없어요. 다른 이름이나 태그로 검색해 보세요.'
      : '아직 우리 팀 이모지가 없습니다.';
  const rootStyle = [
    styles.root,
    {marginBottom: Math.max(0, keyboardHeight - insets.bottom)},
  ];
  // 안쪽 장(가져오기·AI와 만들기)은 같은 시트 안에서 목록을 대신한다. 고르개 본문(`rootStyle`)은 같아서 키보드가 올라와도 장이 그 위에 선다.
  if (chapter !== 'list') {
    return (
      <View style={rootStyle} testID="team-expression-picker">
        {chapter === 'import' ? (
          <ExpressionImportForm
            onBack={() => setChapter('list')}
            onDone={() => setChapter('list')}
          />
        ) : (
          <ExpressionMakeForm
            onBack={() => setChapter('list')}
            onDone={() => setChapter('list')}
            onImport={() => setChapter('import')}
            onOpenConversation={onOpenConversation}
          />
        )}
      </View>
    );
  }
  return (
    <View style={rootStyle} testID="team-expression-picker">
      <View style={styles.filters}>
        {FILTERS.map(item => (
          <Pressable
            key={item.id}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{selected: filter === item.id}}
            onPress={() => setFilter(item.id)}
            style={[styles.filter, filter === item.id && styles.selected]}
          >
            <Text style={styles.label}>{item.label}</Text>
          </Pressable>
        ))}
      </View>
      {store && !(current && mode === 'message') ? (
        <ExpressionAddMenu
          canAdd={canAdd}
          offline={state === 'offline'}
          onImport={() => setChapter('import')}
          onMake={() => setChapter('make')}
        />
      ) : null}
      {current && mode === 'message' ? (
        <View style={styles.preview} testID="expression-send-preview">
          <ExpressionImage expression={current} size="large" />
          <Text style={styles.label}>{expressionAltText(current)}</Text>
          <Pressable
            accessibilityRole="button"
            disabled={selecting}
            onPress={() => {
              void choose(current);
            }}
            style={styles.filter}
            testID="expression-confirm-send"
          >
            <Text style={styles.label}>
              {selecting ? '확인 중…' : '보내기'}
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              selection.current += 1;
              locked.current = false;
              setSelecting(false);
              setPreview(null);
            }}
            style={styles.filter}
          >
            <Text style={styles.label}>다시 고르기</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          {...scrollProps}
          key={`${columns}-${filter}-${query}`}
          data={rows}
          keyExtractor={row => row[0].id}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          ListEmptyComponent={
            <View
              style={styles.notice}
              testID={
                state === 'ready' ? 'emoji-team-empty' : `expression-${state}`
              }
            >
              <Text style={styles.label} accessibilityLiveRegion="polite">
                {notice}
              </Text>
              {state === 'error' ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    void store?.refresh(true);
                  }}
                  style={styles.filter}
                >
                  <Text style={styles.label}>다시 시도</Text>
                </Pressable>
              ) : null}
            </View>
          }
          renderItem={({item: row}) => (
            <View style={styles.row}>
              {row.map(item => (
                <Pressable
                  key={item.id}
                  accessibilityRole="button"
                  accessibilityLabel={expressionAltText(item)}
                  accessibilityHint={
                    mode === 'message' ? '큰 그림으로 미리 보기' : '반응하기'
                  }
                  disabled={selecting}
                  onPress={() => {
                    if (mode === 'message') setPreview(item);
                    else void choose(item);
                  }}
                  style={[
                    styles.cell,
                    {width: (width - SAFE_GUTTER * 2) / columns},
                  ]}
                  testID={`expression-pick-${item.name}`}
                >
                  <ExpressionImage expression={item} size="grid" />
                  {filter !== 'emoji' ? (
                    <Text style={styles.caption}>{item.displayName}</Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          )}
        />
      )}
      {selectionError ? (
        <Text accessibilityRole="alert" style={styles.label}>
          이 표현을 지금 쓸 수 없어요. 다시 골라 주세요.
        </Text>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    root: {flex: 1},
    list: {flex: 1},
    filters: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      paddingHorizontal: SAFE_GUTTER,
      gap: space.xs,
    },
    filter: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      justifyContent: 'center',
      borderRadius: ds2Radius.pill,
    },
    selected: {backgroundColor: color.surfacePressed},
    label: {fontSize: font.body, lineHeight: line.body, color: color.text},
    caption: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      textAlign: 'center',
    },
    row: {flexDirection: 'row', paddingHorizontal: SAFE_GUTTER},
    cell: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: space.sm,
    },
    notice: {padding: space.xl, gap: space.md},
    preview: {padding: space.lg, gap: space.sm, alignItems: 'center'},
  });
