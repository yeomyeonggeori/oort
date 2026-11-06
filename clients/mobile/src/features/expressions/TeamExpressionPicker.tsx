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
import {Sentence} from '../../design/atoms';
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
import {ExpressionMakeEntry} from './ExpressionMakeEntry';
import {useExpressions} from './ExpressionProvider';
import type {PhoneExpressionStore} from './store';
import {
  browseExpressions,
  expressionActionOf,
  type ExpressionView,
} from './expressionViews';
import {
  useExpressionMessages,
  type PlainMessageKey,
} from './useExpressionMessages';

// 반응 고르개의 「우리 팀」 칸이 쓰는 옛 모양의 거르기 줄. 「이모티콘」 하나로 모았다(owner 11-05 #5330): 앞 판의 「이모지」·「스티커」는
// 둘 다 거르지 않는 칸(전체)이었으므로 하나로 합쳤고, 「우리 팀 GIF」는 「GIF」다.
type Filter = 'emoji' | 'gif' | 'recent' | 'frequent';
const FILTERS = [
  {id: 'emoji', label: '이모티콘'},
  {id: 'gif', label: 'GIF'},
  {id: 'recent', label: '최근'},
  {id: 'frequent', label: '자주'},
] as const;

/** 「＋」가 여는 안쪽 장 둘. 목록이 아닌 동안은 고르개의 본문이 그 장으로 바뀐다(`ExpressionChapter` 머리말). */
type Chapter = 'list' | 'import' | 'make';

/** 표현 시트의 큰 칸(이모티콘·GIF 탭, #4942): 정지 그림 64 + 칸 여백. 열 수는 글자 배수만큼 줄어든다. */
const TILE_CELL = 72;
/** 탭마다의 빈 보관함 안내 — 어디서 채우는지까지 한 줄로 말한다. */
const EMPTY_COPY: Readonly<Record<ExpressionView, PlainMessageKey>> = {
  emoticon: 'expressions.sheet.emptyEmoticon',
  gif: 'expressions.sheet.emptyGif',
};

/**
 * 고른 등록이 지금도 활성인지 다시 읽어 확인한다 - 고르는 사이 다른 곳에서 신고·삭제될 수 있다. 활성이면 그 등록, 아니면 null이다.
 * 이모지 탭의 팀 이모지 한 줄(`TeamEmojiRow`)도 같은 길로 고른다.
 */
export async function resolveActiveExpression(
  store: PhoneExpressionStore,
  item: Expression,
): Promise<Expression | null> {
  await store.refresh();
  const now = store.snapshot();
  if (now.state !== 'ready') return null;
  return (
    now.items.find(
      entry =>
        entry.id === item.id &&
        entry.name === item.name &&
        entry.status === 'active',
    ) ?? null
  );
}

export function TeamExpressionPicker({
  query,
  onSelect,
  mode = 'reaction',
  view,
  onOpenConversation,
  onChapterChange,
}: {
  query: string;
  /** 고른 등록의 `:이름:` 과 그 등록. 시트(`view`)는 등록이 정하는 일(`expressionActionOf`)로 길을 가른다. */
  onSelect: (token: string, item: Expression) => void;
  /**
   * 옛 모양(`view` 없음, 반응 고르개)의 동작. `reaction`: 고르면 바로 넘긴다. `message`: 큰 그림을 먼저 미리 보고 「보내기」를 한 번 더
   * 눌러야 넘긴다(ADR-0218 D1). `insert`: 고르면 바로 넘긴다 — 호스트가 그 이름을 입력칸에 넣는다(미리보기 없음, #4942).
   * **`view` 가 있으면 이 값을 읽지 않는다**: 등록 하나가 정한다(큰 것은 미리 보고 보낸다 · 작은 것은 입력칸에 넣는다, `expressionActionOf`).
   */
  mode?: 'reaction' | 'message' | 'insert';
  /**
   * 입력창 표현 시트의 탭(#4942): 안쪽 필터 줄 없이 이 보기 하나만 그린다(`expressionViews.ts` 머리말). 이모지 탭은 표준 그림 문자
   * 목록이 본문이라 여기 오지 않는다(팀의 작은 이모지는 `TeamEmojiRow`). 주지 않으면 옛 모양(이모티콘·GIF·최근·자주 필터 줄)이고 반응 고르개가 그렇게 쓴다.
   */
  view?: ExpressionView;
  /** 「AI와 만들기」 요청을 보낸 뒤 그 에이전트 DM 으로 간다. 호스트가 대화로 가는 길을 줄 때만 서고, 시트를 먼저 내린다. */
  onOpenConversation?: (channel: Channel) => void;
  /** 「＋」의 안쪽 장이 열리고 닫힐 때 알린다 — 호스트가 장 동안 검색·탭 줄을 접어 좁은 화면에 자리를 준다. */
  onChapterChange?: (open: boolean) => void;
}) {
  const {items, state, store, usage} = useExpressions();
  const canAdd = useCanAddExpression();
  const formatMessage = useExpressionMessages();
  const [chapter, setChapter] = useState<Chapter>('list');
  const onChapterChangeRef = useRef(onChapterChange);
  onChapterChangeRef.current = onChapterChange;
  useEffect(() => {
    onChapterChangeRef.current?.(chapter !== 'list');
  }, [chapter]);
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
  // 시트의 두 보기(이모티콘·GIF)는 모두 큰 칸(`tile`)이다.
  const tiles = view !== undefined;
  // 이름 줄은 옛 모양에서는 전체(이모티콘) 필터만 빼고, 시트에서는 늘 둔다.
  const captioned = view ? true : filter !== 'emoji';
  /** 한 등록을 고르면 하는 일. 시트(`view`)는 등록이 정하고, 옛 모양은 `mode` 가 정한다. */
  const modeOf = (item: Expression): 'reaction' | 'message' | 'insert' =>
    view ? (expressionActionOf(item) === 'send' ? 'message' : 'insert') : mode;
  const columns = Math.max(
    1,
    Math.floor(
      (width - SAFE_GUTTER * 2) /
        ((tiles ? TILE_CELL : TOUCH_TARGET) * Math.max(1, fontScale)),
    ),
  );
  const results = useMemo(() => {
    if (view) return browseExpressions(items, view, query, usage);
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
  }, [items, query, filter, usage, view]);
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
  }, [query, filter, view]);
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
    const active = await resolveActiveExpression(store, item);
    if (attempt !== selection.current) return;
    setSelecting(false);
    if (!active) {
      locked.current = false;
      setSelectionError(true);
      return;
    }
    Keyboard.dismiss();
    onSelect(buildExpressionMessage(active).body, active);
  };
  const notice =
    state === 'offline'
      ? formatMessage('expressions.sheet.offline')
      : state === 'error'
      ? formatMessage('expressions.sheet.error')
      : state === 'loading'
      ? formatMessage('expressions.sheet.loading')
      : query
      ? formatMessage('expressions.sheet.noMatch')
      : formatMessage(
          view ? EMPTY_COPY[view] : 'expressions.sheet.emptyLegacy',
        );
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
          <ExpressionMakeEntry
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
      {view ? null : (
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
      )}
      {store && !current ? (
        <ExpressionAddMenu
          canAdd={canAdd}
          offline={state === 'offline'}
          onImport={() => setChapter('import')}
          onMake={() => setChapter('make')}
        />
      ) : null}
      {current ? (
        <View style={styles.preview} testID="expression-send-preview">
          {/* 미리보기는 서 있는 동안 늘 보인다 — `visible` 이라 동작 줄이기만 정지 그림(thumb)으로 가르고, 움직이면 4회 뒤 멈춘다. */}
          <ExpressionImage expression={current} size="large" visible />
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
              {selecting
                ? formatMessage('expressions.sheet.sending')
                : formatMessage('expressions.sheet.send')}
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
            <Text style={styles.label}>
              {formatMessage('expressions.sheet.pickAgain')}
            </Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          {...scrollProps}
          key={`${columns}-${view ?? filter}-${query}`}
          data={rows}
          keyExtractor={row => row[0].id}
          initialNumToRender={6}
          maxToRenderPerBatch={6}
          windowSize={5}
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          // 마지막 줄이 시트 바닥·홈 표시 줄에 붙지 않게 한다(기본 탭의 격자와 같은 바닥 여백, #5330).
          contentContainerStyle={{
            paddingBottom: Math.max(insets.bottom, space.lg),
          }}
          ListEmptyComponent={
            <View
              style={styles.notice}
              testID={
                state === 'ready' ? 'emoji-team-empty' : `expression-${state}`
              }
            >
              {/* 빈 보관함·검색 결과 없음 안내는 완성된 문장이다 — 어절 단위로 줄바꿈한다(맨 `Text` 는 「보세 / 요.」로 끊었다, #5065 M1). */}
              <Sentence style={styles.label} accessibilityLiveRegion="polite">
                {notice}
              </Sentence>
              {state === 'error' ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={() => {
                    void store?.refresh(true);
                  }}
                  style={styles.filter}
                >
                  <Text style={styles.label}>
                    {formatMessage('expressions.sheet.retry')}
                  </Text>
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
                  accessibilityHint={formatMessage(
                    modeOf(item) === 'message'
                      ? 'expressions.sheet.hintPreview'
                      : modeOf(item) === 'insert'
                      ? 'expressions.sheet.hintInsert'
                      : 'expressions.sheet.hintReact',
                  )}
                  disabled={selecting}
                  onPress={() => {
                    if (modeOf(item) === 'message') setPreview(item);
                    else void choose(item);
                  }}
                  style={[
                    styles.cell,
                    {width: (width - SAFE_GUTTER * 2) / columns},
                  ]}
                  testID={`expression-pick-${item.name}`}
                >
                  <ExpressionImage
                    expression={item}
                    size={tiles ? 'tile' : 'grid'}
                  />
                  {captioned ? (
                    <Text
                      style={styles.caption}
                      numberOfLines={view ? 2 : undefined}
                    >
                      {item.displayName}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          )}
        />
      )}
      {selectionError ? (
        <Text accessibilityRole="alert" style={styles.label}>
          {formatMessage('expressions.sheet.unavailable')}
        </Text>
      ) : null}
    </View>
  );
}

/** 시트의 칸 모양. 이모지 탭의 한 줄(`TeamEmojiRow`)이 같은 칸·줄·글자 모양을 쓴다. */
export const buildStyles = (color: Palette) =>
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
