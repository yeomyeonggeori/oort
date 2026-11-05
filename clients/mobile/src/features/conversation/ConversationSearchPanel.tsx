import {
  clampQueryForCopy,
  leadsWithEllipsis,
  normalizeQuery,
  snippetSegments,
  trailsWithEllipsis,
} from '@momo/core/features/search/searchModel';
import {calendarDaysBetween} from '@momo/core/features/timeline/divider';
import {
  memberNameParts,
  missingMemberLabel,
  type Directory,
} from '@momo/core/features/workspace/directory';
import type {MessageSearchHit} from '@momo/core/lib/api';
import {uuidEq} from '@momo/core/lib/api';
import React, {useCallback} from 'react';
import {FlatList, Image, Pressable, StyleSheet, Text, View} from 'react-native';
import {EmptyState, ErrorState, LoadingState, Sentence} from '../../design/atoms';
import {CONV_ICONS, CONV_ICON_SIZE, SHEET_ICONS, SHEET_ICON_SIZE} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, line, SAFE_GUTTER, slopTo, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {useLocaleService} from '../../i18n/useLocaleService';
import {useKeyboardHeight} from '../../lib/useKeyboardHeight';
import {Avatar} from './Avatar';
import {CONV} from './convDesign';
import type {ConversationSearch} from './useConversationSearch';

// =============================================================================
// 대화 안 검색이 검색 줄 **아래**를 덮는 면 (#5364, 시안 A2·A3).
//
// 두 얼굴이다. 상태는 코어가 판정한 `search.phase` 하나만 보고 그린다(`SearchScreen` 과 같은 규율 — 「로딩이면서 오류」 같은 조합을 화면에서
// 조립하지 않는다):
//
//   입력 전(`idle`)  뒤의 대화를 **어둡게 눌러 둔 채** 최근 검색 카드가 선다(A2). 어둠 아무 데나 누르면 검색이 닫힌다.
//   그 밖            불투명한 면이 대화를 덮고 한 상태가 선다: 두 글자 미만 안내 · 찾는 중 · 오류(+다시 시도) · 결과 없음 · 결과 목록(A3).
//
// 결과 줄은 보낸 사람·시각·**찾은 글자 강조**(서버가 준 `matchOffset`)이고 최근 순이다. 누르면 `search.choose` — 이동은 대화 화면의 점프 문이 한다.
//
// 결과 머리의 오른쪽 「모든 대화에서 ›」(시안 A3, #5384)는 같은 말로 홈 검색 탭을 여는 문이다(`onSearchAll` — 셸이 탭을 옮기고 말을 넘긴다). 이 대화 안에서
// 못 찾았거나 더 넓게 보고 싶을 때 말을 다시 치지 않게 한다.
//
// ## 키보드는 안쪽 면이 비운다, 바탕은 비우지 않는다
//
// 바탕(불투명·어둠)은 화면 바닥까지 간다 — 키보드가 올라오는 동안 바탕이 먼저 줄면 그 틈으로 뒤의 대화가 번쩍인다. 키보드 높이만큼 비우는 것은
// 안쪽 면의 아래 여백이다(`useKeyboardHeight`, 숫자만). 결과 목록은 그 안에서 스크롤한다.
// =============================================================================

/** 「지우기」 글자 한 줄을 엄지 44 로 만드는 여유 — 도출한다(감사 M-14). */
const CLEAR_SLOP = slopTo(line.label);

/** 가로로 서고 세로 가운데에 맞추는 줄 — 이 파일의 줄 스타일이 한 벌을 나눠 쓴다(직접 문구 장부가 낱말 리터럴을 세므로 한 곳에만 적는다). */
const ROW = {flexDirection: 'row', alignItems: 'center'} as const;

export function ConversationSearchPanel({
  search,
  directory,
  selfMemberId,
  isDm,
  topInset,
  nowMs,
  onSearchAll,
}: {
  search: ConversationSearch;
  directory: Directory;
  selfMemberId: string;
  isDm: boolean;
  /** 머리가 덮은 높이 — 면은 그 아래에서 시작한다. */
  topInset: number;
  nowMs: number;
  /** 「모든 대화에서 ›」 — 같은 말(다듬은 것)로 홈 검색 탭을 연다. 없으면(셸 밖 호출자) 문이 서지 않는다. */
  onSearchAll?: (query: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  const keyboardHeight = useKeyboardHeight();
  const idle = search.phase === 'idle';

  const renderItem = useCallback(
    ({item, index}: {item: MessageSearchHit; index: number}) => (
      <ResultRow
        hit={item}
        query={search.settledQuery}
        directory={directory}
        selfMemberId={selfMemberId}
        nowMs={nowMs}
        onPress={() => search.choose(index)}
      />
    ),
    [search, directory, selfMemberId, nowMs],
  );

  let body: React.ReactNode;
  switch (search.phase) {
    case 'idle':
      body = (
        <View style={styles.recentCard} testID="conversation-search-recent">
          {search.recent.length === 0 ? (
            <Sentence style={styles.hint} testID="conversation-search-idle-hint">
              {formatMessage('mobile.convSearch.idleHint')}
            </Sentence>
          ) : (
            <>
              <View style={styles.recentHead}>
                <Text style={styles.recentTitle} accessibilityRole="header">
                  {formatMessage('mobile.convSearch.recentTitle')}
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={formatMessage('mobile.convSearch.recentClearLabel')}
                  onPress={search.clearRecent}
                  hitSlop={CLEAR_SLOP}
                  testID="conversation-search-recent-clear">
                  <Text style={styles.recentClear}>{formatMessage('mobile.convSearch.recentClear')}</Text>
                </Pressable>
              </View>
              {search.recent.map((term, index) => (
                <Pressable
                  key={term}
                  accessibilityRole="button"
                  accessibilityLabel={formatMessage('mobile.convSearch.recentRow', {query: term})}
                  onPress={() => search.pickRecent(term)}
                  style={({pressed}) => [
                    styles.recentRow,
                    index > 0 && styles.recentRowRule,
                    pressed && styles.pressed,
                  ]}
                  testID="conversation-search-recent-row">
                  <Image
                    accessibilityElementsHidden
                    source={CONV_ICONS.recent}
                    style={[styles.recentGlyph, {tintColor: palette.textMuted}]}
                  />
                  <Text style={styles.recentTerm} numberOfLines={1}>
                    {term}
                  </Text>
                  <Image
                    accessibilityElementsHidden
                    source={SHEET_ICONS.chevron}
                    style={[styles.chevron, {tintColor: palette.textFaint}]}
                  />
                </Pressable>
              ))}
            </>
          )}
        </View>
      );
      break;
    case 'tooShort':
      body = (
        <EmptyState headline={formatMessage('mobile.convSearch.tooShort')} testID="conversation-search-too-short" />
      );
      break;
    case 'searching':
      body = <LoadingState label={formatMessage('mobile.convSearch.searching')} testID="conversation-search-loading" />;
      break;
    case 'error':
      body = (
        <ErrorState
          headline={formatMessage('mobile.convSearch.errorHeadline')}
          detail={formatMessage('mobile.convSearch.errorDetail')}
          onRetry={search.retry}
          testID="conversation-search-error"
        />
      );
      break;
    case 'empty':
      body = (
        <EmptyState
          headline={formatMessage('mobile.convSearch.emptyHeadline', {query: clampQueryForCopy(search.settledQuery)})}
          detail={formatMessage('mobile.convSearch.emptyDetail')}
          testID="conversation-search-empty"
        />
      );
      break;
    case 'results':
      body = (
        <FlatList
          data={search.hits}
          renderItem={renderItem}
          keyExtractor={hit => hit.messageId}
          testID="conversation-search-results"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={styles.listBody}
          ListHeaderComponent={
            <View style={styles.listHeadRow}>
              <Text style={styles.listHead} accessibilityRole="header" testID="conversation-search-results-head">
                {formatMessage(isDm ? 'mobile.convSearch.resultsDm' : 'mobile.convSearch.resultsChannel')}
              </Text>
              {onSearchAll ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={formatMessage('mobile.convSearch.searchAllLabel', {
                    query: clampQueryForCopy(normalizeQuery(search.query)),
                  })}
                  hitSlop={CLEAR_SLOP}
                  onPress={() => onSearchAll(normalizeQuery(search.query))}
                  style={({pressed}) => [styles.searchAll, pressed && styles.searchAllPressed]}
                  testID="conversation-search-all">
                  <Text style={styles.searchAllLabel}>{formatMessage('mobile.convSearch.searchAll')}</Text>
                  <Image
                    accessibilityElementsHidden
                    source={SHEET_ICONS.chevron}
                    style={[styles.searchAllGlyph, {tintColor: palette.accentText}]}
                  />
                </Pressable>
              ) : null}
            </View>
          }
          ListFooterComponent={
            search.hasMore ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={formatMessage('mobile.convSearch.more')}
                accessibilityState={{busy: search.loadingMore}}
                disabled={search.loadingMore}
                onPress={search.loadMore}
                style={({pressed}) => [styles.more, pressed && styles.pressed]}
                testID="conversation-search-more">
                <Text style={styles.moreLabel}>
                  {formatMessage(search.loadingMore ? 'mobile.convSearch.moreLoading' : 'mobile.convSearch.more')}
                </Text>
              </Pressable>
            ) : null
          }
        />
      );
      break;
  }

  return (
    <View
      style={[styles.ground, idle ? styles.groundDim : styles.groundSolid]}
      testID="conversation-search-panel">
      {idle ? (
        // 어둠을 누르면 검색이 닫힌다 — 카드 밖은 「여기서 그만」이다. 카드의 줄은 자기 손을 먼저 받는다. 누르는 면은 **머리 밑에서** 시작한다: 머리 줄의 빈 틈
        // (원과 입력칸 사이·안전 영역)을 잘못 눌러 검색이 닫히지 않게 한다.
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={formatMessage('mobile.convSearch.close')}
          onPress={search.close}
          style={[styles.scrim, {top: topInset}]}
          testID="conversation-search-scrim"
        />
      ) : null}
      <View
        pointerEvents="box-none"
        style={[styles.inner, {paddingTop: topInset, paddingBottom: keyboardHeight}]}>
        {body}
      </View>
    </View>
  );
}

/** 결과 한 줄 — 얼굴 · 보낸 사람(내 글은 「나」) · 시각 · 찾은 글자를 강조한 조각. 시각은 오늘이면 시각, 어제면 「어제」, 그 밖은 날짜다. */
export function ResultRow({
  hit,
  query,
  directory,
  selfMemberId,
  nowMs,
  onPress,
}: {
  hit: MessageSearchHit;
  query: string;
  directory: Directory;
  selfMemberId: string;
  nowMs: number;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const locale = useLocaleService();
  const segments = snippetSegments(hit.snippet, hit.matchOffset, query);
  // 잘린 쪽에만 말줄임을 붙인다. 잘리지 않은 쪽에 붙이면 없는 말이 있다고 하는 것이다(`SearchScreen` 과 같은 규율).
  const lead = leadsWithEllipsis(hit.matchOffset) ? '…' : '';
  const trail = trailsWithEllipsis(hit.snippet, query) ? '…' : '';
  const author = uuidEq(hit.authorMemberId, selfMemberId)
    ? formatMessage('mobile.convSearch.authorSelf')
    : memberNameParts(directory, hit.authorMemberId, missingMemberLabel(directory)).name;
  const days = calendarDaysBetween(hit.createdAtMs, nowMs);
  const sameYear = new Date(hit.createdAtMs).getFullYear() === new Date(nowMs).getFullYear();
  const when =
    days <= 0
      ? locale.formatTime(hit.createdAtMs)
      : days === 1
        ? formatMessage('mobile.convSearch.dayYesterday')
        : locale.formatDate(
            hit.createdAtMs,
            sameYear ? {month: 'long', day: 'numeric'} : {year: 'numeric', month: 'long', day: 'numeric'},
          );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={formatMessage('mobile.convSearch.resultLabel', {author, when, snippet: hit.snippet})}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID="conversation-search-result">
      <View style={styles.rowFace}>
        <Avatar directory={directory} memberId={hit.authorMemberId} size={CONV.avatar} ground="muted" />
      </View>
      <View style={styles.rowBody}>
        <View style={styles.rowHead}>
          <Text style={styles.rowAuthor} numberOfLines={1}>
            {author}
          </Text>
          <Text style={styles.rowWhen} numberOfLines={1}>
            {when}
          </Text>
        </View>
        <Sentence style={styles.snippet} numberOfLines={3}>
          {lead}
          {segments.before}
          <Text style={styles.match} testID="conversation-search-match">
            {segments.match}
          </Text>
          {segments.after}
          {trail}
        </Sentence>
      </View>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 바탕은 화면 바닥까지 간다(위 머리말). 머리는 이 면 **위**에 서므로(`zIndex`) 면은 머리 밑까지 깔려도 된다.
    ground: {position: 'absolute', top: 0, left: 0, right: 0, bottom: 0},
    scrim: {position: 'absolute', left: 0, right: 0, bottom: 0},
    groundSolid: {backgroundColor: color.bg},
    groundDim: {backgroundColor: color.scrim},
    inner: {flex: 1},
    hint: {
      margin: SAFE_GUTTER,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    // 최근 검색 카드 — 머리 밑에 뜨는 둥근 묶음. 줄은 한 단 위(`surface`)에 서고 선은 카드 둘레와 줄 사이(`border`)다.
    recentCard: {
      marginHorizontal: SAFE_GUTTER,
      marginTop: space.sm,
      borderRadius: ds2Radius.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
      overflow: 'hidden',
    },
    recentHead: {
      ...ROW,
      justifyContent: 'space-between',
      paddingHorizontal: space.lg,
      paddingTop: space.md,
      paddingBottom: space.sm,
    },
    recentTitle: {fontSize: font.label, lineHeight: line.label, color: color.textMuted, fontWeight: '600'},
    recentClear: {fontSize: font.label, lineHeight: line.label, color: color.accentText, fontWeight: '600'},
    recentRow: {
      ...ROW,
      minHeight: TOUCH_TARGET,
      gap: space.md,
      paddingHorizontal: space.lg,
    },
    recentRowRule: {borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border},
    recentGlyph: {width: CONV_ICON_SIZE.recent, height: CONV_ICON_SIZE.recent},
    recentTerm: {flex: 1, fontSize: font.body, color: color.text},
    chevron: {width: SHEET_ICON_SIZE.chevron, height: SHEET_ICON_SIZE.chevron},
    pressed: {backgroundColor: color.surfacePressed},
    listBody: {paddingBottom: space.xl},
    // 결과 머리: 왼쪽 「이 채널의 결과 · 최근 순」, 오른쪽 「모든 대화에서 ›」(시안 A3). 왼쪽이 줄어들 수 있어 오른쪽 문은 늘 한 줄로 선다.
    listHeadRow: {
      ...ROW,
      justifyContent: 'space-between',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
    },
    listHead: {flexShrink: 1, fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    searchAll: {...ROW, flexShrink: 0, gap: space.xs},
    searchAllPressed: {opacity: 0.6},
    searchAllLabel: {fontSize: font.label, lineHeight: line.label, color: color.accentText, fontWeight: '600'},
    searchAllGlyph: {
      width: SHEET_ICON_SIZE.chevron - space.xs,
      height: SHEET_ICON_SIZE.chevron - space.xs,
    },
    // 줄: 왼쪽에 얼굴, 오른쪽 몸통이 구분선을 진다 — 선은 글이 시작하는 자리에서 오른쪽 끝까지다(얼굴 밑으로는 가지 않는다).
    row: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: CONV.avatarGap,
      paddingLeft: SAFE_GUTTER,
    },
    rowFace: {paddingTop: space.md},
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: space.xs,
      paddingTop: space.md,
      paddingBottom: space.md,
      paddingRight: SAFE_GUTTER,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    rowHead: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: space.sm},
    rowAuthor: {flexShrink: 1, fontSize: font.body, lineHeight: line.body, color: color.text, fontWeight: '700'},
    rowWhen: {flexShrink: 0, fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    snippet: {fontSize: font.body, lineHeight: line.body, color: color.textMuted},
    match: {color: color.text, fontWeight: '700', backgroundColor: color.accentSurfaceStrong},
    more: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      margin: SAFE_GUTTER,
      borderRadius: ds2Radius.row,
      backgroundColor: color.surfaceMuted,
    },
    moreLabel: {fontSize: font.label, lineHeight: line.label, color: color.accentText, fontWeight: '600'},
  });
