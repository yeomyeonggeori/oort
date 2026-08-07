import type {MessageSearchHit} from '@momo/core/lib/api';
import {
  leadsWithEllipsis,
  noResultsCopy,
  NO_RESULTS_SCOPE_NOTE,
  SHORT_QUERY_HINT,
  snippetSegments,
  trailsWithEllipsis,
} from '@momo/core/features/search/searchModel';
import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import {
  channelLabel,
  memberNameParts,
} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo} from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  EmptyState,
  ErrorState,
  LoadingState,
  Screen,
  ScreenHeader,
} from '../design/atoms';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {usePalette, useStyles} from '../design/theme';
import {
  useMessageSearch,
  type MessageSearch,
} from '../features/search/useMessageSearch';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {useSession} from '../session/useSession';

// =============================================================================
// 메시지 검색.
//
// ## 상태는 코어가 판정한다
//
// 화면은 `searchPhase` 가 돌려준 값 하나만 보고 그린다. 조건문을 화면에서
// 조립하면 「로딩이면서 오류」나 「결과 없음이면서 입력 전」 같은 조합이 생기고,
// 그중 몇은 화면에서만 재현된다. 그 판정에는 이 배치가 반드시 지켜야 하는 순서도
// 들어 있다: **오류를 로딩보다 먼저 보지 않는다** — 재시도가 날아가는 동안 화면은
// 「찾는 중」이어야 한다.
//
// ## 결과 없음은 범위를 함께 말한다
//
// 서버 질의는 워크스페이스 전체를 훑지만 `membership` JOIN 이 결과를 **내가
// 떠나지 않은 채널**로 가둔다. 그 사실을 말하지 않으면 사람은 "그런 말은 오간 적
// 없다"로 읽고 검색을 그만두는데, 실제로는 자기가 속하지 않은 채널에 있을 수
// 있다. 조사(`'배포'가` / `'로그인'이`)는 레포에 이미 있는 규칙이 고른다 —
// 여기서 두 번째 규칙을 세우면 판정이 두 벌로 갈라진다(B12 R2 High-2).
//
// ## 목록은 정방향이다 — 뒤집지 않는다
//
// 검색 결과도 이 규칙에서 예외가 아니다. `__tests__/projectShape.test.ts` 가
// `src/` 전체에서 그 단어를 막는데, 그 검사는 주석을 걷어내지 않는 **날것의 문자열
// 검색**이다. 그래서 이 레포는 주석에서도 그 단어를 쓰지 않는다 — 가드가 무딘
// 것이 아니라, 가드를 무디게 만들 여지를 주지 않는 쪽을 고른 것이다.
//
// ## 결과를 누르면 무슨 일이 일어나는가 — 그리고 일어나지 않으면 그렇게 말한다
//
// 결과 한 건은 채널과 메시지 id 와 seq 를 안다. 채널을 열면서 그 셋을 함께
// 넘긴다. 열린 대화가 그 메시지를 화면에서 찾지 못하면 **그렇다고 말한다**:
// 웹은 이 자리를 조용히 실패하게 두었다가 지적을 받았다(B12 R2 High-3) — 사용자는
// 방금 읽은 문장을 눌러 놓고 표식도 문장도 없이 전혀 다른 메시지가 있는 채널
// 바닥에 도착했다. seq 를 함께 들고 가는 것이 "더 위쪽에 있어 아직 안 불러왔다"를
// 추측이 아니라 사실로 만든다.
//
// ## 이 화면의 이름 (이슈 #1146 N4)
//
// 제목을 손으로 적지 않고 코어의 표면 판정표에서 든다. 이 화면은 사람이 **도착
// 하는 곳**이고, 이 레포의 규칙에서 목적지의 이름은 도착한 표면이 쓰는 말이다 —
// 그래서 여기가 이름의 원본이 될 자격이 있는 유일한 자리인데, 원본이 화면 안에
// 갇혀 있으면 문을 여는 쪽(사이드바 헤더 액션·웹 사이드바 줄·⌘K 항목)은 그것을
// 베껴 적을 수밖에 없고, 실제로 베낀 것들이 갈라져 있었다.
// =============================================================================

/** 이 목적지의 이름. 문을 여는 컨트롤들이 읽는 그 한 줄 (이슈 #1146 N4). */
const SEARCH_SURFACE_NAME = serverSurface('messageSearch').label;

export default function SearchScreen({
  initialQuery = '',
  onOpenResult,
  onBack,
}: {
  /** What was already typed into the sidebar's filter. See `useMessageSearch`. */
  initialQuery?: string;
  onOpenResult: (
    channelId: string,
    title: string,
    anchor: {messageId: string; seq: number},
  ) => void;
  onBack: () => void;
}): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const search = useMessageSearch(workspaceId, initialQuery);
  const {directory} = useDirectory(workspaceId);
  const {groups} = useChannels(workspaceId);

  const titleFor = useCallback(
    (channelId: string) => {
      const channel = [...groups.channels, ...groups.dms].find(
        candidate => candidate.id.toLowerCase() === channelId.toLowerCase(),
      );
      return channel ? channelLabel(channel, directory, member.id) : '대화';
    },
    [groups, directory, member.id],
  );

  const renderItem = useCallback(
    ({item}: {item: MessageSearchHit}) => (
      <ResultRow
        hit={item}
        query={search.settledQuery}
        channelTitle={titleFor(item.channelId)}
        authorName={
          memberNameParts(directory, item.authorMemberId, '알 수 없는 멤버').name
        }
        onPress={() =>
          onOpenResult(item.channelId, titleFor(item.channelId), {
            messageId: item.messageId,
            seq: item.seq,
          })
        }
      />
    ),
    [search.settledQuery, titleFor, directory, onOpenResult],
  );

  return (
    <Screen>
      {/* 도착한 화면이 자기 이름을 말한다 — 그리고 그 말은 이 문을 여는
          컨트롤들과 **같은 한 줄**에서 온다 (이슈 #1146 N4). */}
      <ScreenHeader
        title={SEARCH_SURFACE_NAME}
        onBack={onBack}
        backLabel="검색 닫기"
        titleTestID="search-title"
      />
      <SearchBody search={search} renderItem={renderItem} />
    </Screen>
  );
}

/**
 * Everything below the header, given a search.
 *
 * Split out for one reason: the states that matter most here (입력 전·찾는
 * 중·결과 없음·오류) never appear on a live server, so they would go
 * uncaptured — and those are exactly the ones a person meets on a bad day.
 * `measure/surfaces.tsx` hands this component each phase in turn, so what gets
 * photographed is the surface that ships rather than a mockup of it. The same
 * trick `measure/states.tsx` already plays on `Timeline`.
 */
export function SearchBody({
  search,
  renderItem,
}: {
  search: MessageSearch;
  renderItem: ({item}: {item: MessageSearchHit}) => React.JSX.Element;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const body = useMemo(() => {
    switch (search.phase) {
      case 'idle':
        return (
          <EmptyState
            headline="메시지를 검색합니다."
            detail="내가 속한 채널에 오간 말 중에서 찾습니다. 단어 일부만 입력해도 됩니다."
            testID="search-idle"
          />
        );
      case 'tooShort':
        return <EmptyState headline={SHORT_QUERY_HINT} testID="search-too-short" />;
      case 'searching':
        return <LoadingState label="찾는 중입니다." testID="search-loading" />;
      case 'error':
        return (
          <ErrorState
            headline="검색하지 못했습니다."
            detail="연결을 확인한 뒤 잠시 뒤 다시 시도하세요."
            onRetry={search.retry}
            testID="search-error"
          />
        );
      case 'empty':
        return (
          <EmptyState
            headline={noResultsCopy(search.settledQuery)}
            detail={NO_RESULTS_SCOPE_NOTE}
            testID="search-empty"
          />
        );
      case 'results':
        return (
          <FlatList
            data={search.hits}
            renderItem={renderItem}
            keyExtractor={hit => hit.messageId}
            testID="search-results"
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="interactive"
            showsHorizontalScrollIndicator={false}
            ListFooterComponent={
              search.hasMore ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="더 보기"
                  accessibilityState={{busy: search.loadingMore}}
                  disabled={search.loadingMore}
                  onPress={search.loadMore}
                  style={({pressed}) => [styles.more, pressed && styles.pressed]}
                  testID="search-more">
                  <Text style={styles.moreLabel}>
                    {search.loadingMore ? '불러오는 중' : '더 보기'}
                  </Text>
                </Pressable>
              ) : null
            }
          />
        );
    }
  }, [search, renderItem, styles]);

  return (
    <>
      <View style={styles.field}>
        <TextInput
          style={styles.input}
          // 동기. `useMessageSearch` 의 헤더 참조 — 늦는 것은 요청뿐이다.
          value={search.query}
          onChangeText={search.setQuery}
          placeholder="메시지 내용으로 검색"
          placeholderTextColor={palette.textFaint}
          // 이 밭의 이름도 이 표면의 이름이다 — 한 낱말을 두 군데 적으면 한쪽만
          // 낡는다 (이슈 #1146 N4).
          accessibilityLabel={SEARCH_SURFACE_NAME}
          autoCorrect={false}
          returnKeyType="search"
          testID="search-input"
        />
      </View>
      <View style={styles.body}>{body}</View>
    </>
  );
}

/** Exported so `measure/surfaces.tsx` photographs this row and not a copy. */
export function ResultRow({
  hit,
  query,
  channelTitle,
  authorName,
  onPress,
}: {
  hit: MessageSearchHit;
  query: string;
  channelTitle: string;
  authorName: string;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const segments = snippetSegments(hit.snippet, hit.matchOffset, query);
  // 잘린 쪽에만 말줄임을 붙인다. 잘리지 않은 쪽에 붙이면 없는 말이 있다고 하는
  // 것이고, 그것도 이 표면이 없애려는 거짓말과 같은 종류다.
  const lead = leadsWithEllipsis(hit.matchOffset) ? '…' : '';
  const trail = trailsWithEllipsis(hit.snippet, query) ? '…' : '';
  const when = new Date(hit.createdAtMs);
  const stamp = `${when.getFullYear()}. ${when.getMonth() + 1}. ${when.getDate()}.`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${channelTitle}의 ${authorName} 메시지, ${hit.snippet}`}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID="search-result">
      <View style={styles.rowHead}>
        <Text style={styles.rowChannel} numberOfLines={1}>
          {channelTitle}
        </Text>
        <Text style={styles.rowMeta} numberOfLines={1}>
          {`${authorName} · ${stamp}`}
        </Text>
      </View>
      <Text style={styles.snippet} numberOfLines={3}>
        {lead}
        {segments.before}
        <Text style={styles.match}>{segments.match}</Text>
        {segments.after}
        {trail}
      </Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  field: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
  input: {
    minHeight: TOUCH_TARGET,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    // 16 미만이면 포커스 때 iOS 가 화면을 확대한다.
    fontSize: font.body,
    color: color.text,
  },
  body: {flex: 1},
  row: {
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.md,
    gap: space.xs,
    minHeight: TOUCH_TARGET,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  rowHead: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
  rowChannel: {flexShrink: 1, fontSize: font.label, fontWeight: '700', color: color.text},
  rowMeta: {flex: 1, fontSize: font.meta, color: color.textFaint},
  snippet: {fontSize: font.label, color: color.textMuted, lineHeight: 19},
  match: {color: color.text, fontWeight: '700', backgroundColor: color.accentSurfaceStrong},
  more: {
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    margin: SAFE_GUTTER,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
  },
  moreLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
  pressed: {backgroundColor: color.surfacePressed},
});
