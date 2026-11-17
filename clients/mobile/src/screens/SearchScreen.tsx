import {isSearchable} from '@momo/core/features/search/searchModel';
import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import {
  channelLabel,
  dmPeer,
  memberNameParts,
  missingMemberLabel,
  type Directory,
} from '@momo/core/features/workspace/directory';
import {openDirectMessage, uuidEq, type MessageSearchHit} from '@momo/core/lib/api';
import {useMutation} from '@tanstack/react-query';
import React, {useCallback, useMemo, useRef, useState} from 'react';
import {FlatList, Keyboard, Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  ErrorState,
  FailureBanner,
  Screen,
  Sentence,
} from '../design/atoms';
import {SHELL_ICONS} from '../design/icons';
import {CloseCircle} from '../design/SheetChrome';
import {InputPill} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {useFormatMessage} from '../i18n/useFormatMessage';
import {useLocaleService} from '../i18n/useLocaleService';
import {compareChannelNames} from '@momo/core/features/channels/nameCollation';
import {ConversationPickerSheet, type PickerItem} from '../features/search/ConversationPickerSheet';
import {
  matchChannels,
  matchPeople,
  PREVIEW_COUNT,
  previewOf,
  type ChannelMatch,
  type PersonMatch,
  type SearchKind,
} from '../features/search/localSearch';
import {recentScopeOf} from '../features/search/recentScope';
import {
  forgetSearches,
  recentsScope,
  rememberSearch,
  useSearchRecents,
} from '../features/search/searchRecents';
import {
  ChannelRow,
  GroupHeader,
  KindChips,
  PersonRow,
  RecentConversations,
  RecentSearches,
  ResultRow,
  ScopeChips,
  SkeletonRows,
  type RecentSearchRow,
  type RecentTile,
} from '../features/search/SearchRows';
import {useMessageSearch, type MessageSearch} from '../features/search/useMessageSearch';
import {useChannels, useDirectory, useRememberOpenedDm} from '../features/workspace/queries';
import {useTabBarClearance} from '../shell/ShellChrome';
import {useSession} from '../session/useSession';
import {openDmFailureCopy} from './SidebarScreen';

// =============================================================================
// 검색 탭 (#5365). 사람·채널·메시지를 한 입력칸에서 찾는다.
//
// ## 무엇이 어디서 오는가
//
//   채널·사람   폰이 이미 받아 둔 목록(`useChannels`·`useDirectory`)에서 글자마다 바로 거른다. 규칙은 순수 모듈 `localSearch`.
//   메시지      서버(`useMessageSearch`, 250ms 뒤). 규칙·판정은 코어 `searchModel` 이다.
//   최근        이 기기에만 남긴다(`searchRecents`). 서버는 모른다. 최근 검색은 대화 안 검색과 **한 목록**이고, 한 대화 안에서 찾은 줄은 범위 칩과 함께 서며 누르면 그 범위로 다시 찾는다(#5384).
//
// 화면은 **상태를 조립하지 않는다.** 메시지 쪽 상태는 코어 `searchPhase` 가 돌려준 값 하나만 보고 그린다: 조건문을 화면에서
// 모으면 「로딩이면서 오류」 같은 조합이 생기고 그중 몇은 화면에서만 재현된다. 오류를 로딩보다 먼저 보지 않는 순서도 그 판정에
// 들어 있다.
//
// ## 입력값은 동기다
//
// `search.query` 는 키 입력마다 그 자리에서 바뀌어 그대로 `value` 로 돌아온다(`useMessageSearch` 머리말). 한글 조합이 이 값이
// 한 틱 늦어지는 순간 끊긴다. 채널·사람 걸러내기도 같은 값을 **동기로** 읽는다 — 네트워크도 디바운스도 없다.
//
// ## X 는 두 가지다 (owner 11-05)
//
// 입력이 있으면 입력을 지우고, 비어 있으면 홈 탭으로 돌아간다. 검색은 탭이라(ADR-0189 D1) 돌아갈 곳이 홈이고 탭바는 그대로 있다.
//
// ## 결과를 누르면
//
// 메시지는 그 대화의 그 메시지로(채널 id·메시지 id·seq 를 함께 넘긴다 — 아직 안 불러온 글이면 대화가 그렇다고 말한다, B12 R2
// High-3), 채널은 그 채널로, 사람은 그 사람과의 DM 으로 간다(없으면 서버가 만든다). 누른 순간 지금 친 말을 최근 검색에 남긴다.
//
// 결과(사람·채널·메시지·최근 연 대화)를 누르면 **자판을 먼저 내린 뒤** 간다(#5418, 검증 6a). 검색은 탭이라 대화 층이 이 화면 위에 얹힐 뿐 이 화면은 사라지지
// 않는다: 입력칸이 포커스를 쥔 채 가면 자판이 대화 위에 그대로 남아 입력창과 그 위 도크(「찾는 중」·「더 위쪽에 있습니다」)를 덮는다. 열리는 쪽이 아니라 자판을
// 쥔 이 화면이 내린다. 사람은 DM 이 열리는 것을 기다리므로 누른 순간에 한 번, 도착해 이동하는 순간에 한 번 더 내린다(그 사이 입력칸을 다시 눌렀을 수 있다).
//
// ## 이 화면의 이름 (이슈 #1146 N4)
//
// 입력칸의 이름을 손으로 적지 않고 코어의 표면 판정표에서 든다. 이 화면은 사람이 **도착하는 곳**이고, 문을 여는 쪽(사이드바
// 헤더 액션·웹 사이드바 줄·⌘K 항목)과 같은 한 줄에서 이름이 나와야 낡을 때 한쪽만 남지 않는다.
//
// ## 목록은 정방향이다 — 뒤집지 않는다
//
// 검색 결과도 이 규칙에서 예외가 아니다. `__tests__/projectShape.test.ts` 가 `src/` 전체에서 그 단어를 막는데, 그 검사는
// 주석을 걷어내지 않는 **날것의 문자열 검색**이다. 그래서 이 레포는 주석에서도 그 단어를 쓰지 않는다.
// =============================================================================

/** 이 목적지의 이름. 문을 여는 컨트롤들이 읽는 그 한 줄 (이슈 #1146 N4). */
const SEARCH_SURFACE_NAME = serverSurface('messageSearch').label;

export default function SearchScreen({
  initialQuery = '',
  onOpenResult,
  onClose,
}: {
  /** What was already typed into the sidebar's filter. See `useMessageSearch`. */
  initialQuery?: string;
  onOpenResult: (
    channelId: string,
    title: string,
    anchor?: {messageId: string; seq: number},
  ) => void;
  /** 입력이 비어 있을 때 X 가 부른다 — 셸이 홈 탭으로 돌려보낸다. 탭 밖에서는 없다. */
  onClose?: () => void;
}): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const formatMessage = useFormatMessage();
  const displayLocale = useLocaleService().context.messageLocale;
  const byChannelName = useMemo(() => compareChannelNames(displayLocale), [displayLocale]);
  const [kind, setKind] = useState<SearchKind>('all');
  const [scopeId, setScopeId] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 범위는 「메시지」 칩에서만 있다. 칩을 옮겨도 고른 대화는 남아 「메시지」로 돌아오면 그대로다.
  const search = useMessageSearch(workspaceId, initialQuery, {
    channelId: kind === 'messages' && scopeId !== null ? scopeId : undefined,
    enabled: kind === 'all' || kind === 'messages',
  });
  // 셸 안의 탭이면 바닥 위에 투명하게 서고, 목록 끝을 탭바만큼 비운다(ADR-0189 D1).
  const clearance = useTabBarClearance();
  const channelsQuery = useChannels(workspaceId);
  const {groups} = channelsQuery;
  const directoryQuery = useDirectory(workspaceId);
  const {directory} = directoryQuery;
  const scopeKey = recentsScope(workspaceId, member.id);
  const recents = useSearchRecents(scopeKey);
  const rememberOpenedDm = useRememberOpenedDm(workspaceId);

  const titleFor = useCallback(
    (channelId: string) => {
      const channel = [...groups.channels, ...groups.dms].find(candidate =>
        uuidEq(candidate.id, channelId),
      );
      return channel
        ? channelLabel(channel, directory, member.id)
        : formatMessage('search.row.fallbackTitle');
    },
    [groups, directory, member.id, formatMessage],
  );

  const trimmed = search.query.trim();
  const channelMatches = useMemo(
    () => (trimmed === '' ? [] : matchChannels(groups.channels, trimmed, displayLocale)),
    [groups.channels, trimmed, displayLocale],
  );
  const peopleMatches = useMemo(
    () => (trimmed === '' ? [] : matchPeople(directory.members, member.id, trimmed)),
    [directory.members, member.id, trimmed],
  );

  const recentTiles = useMemo<RecentTile[]>(() => {
    const known = [...groups.channels, ...groups.dms];
    const tiles: RecentTile[] = [];
    for (const id of recents.conversations) {
      const channel = known.find(candidate => uuidEq(candidate.id, id));
      if (channel === undefined) continue;
      tiles.push({
        channelId: channel.id,
        title: channelLabel(channel, directory, member.id),
        kind: channel.kind === 'dm' ? 'dm' : channel.kind === 'private' ? 'private' : 'channel',
        peerId: dmPeer(channel, directory, member.id)?.id ?? null,
      });
    }
    return tiles;
  }, [recents.conversations, groups, directory, member.id]);

  const pickerItems = useMemo<PickerItem[]>(() => {
    const channels: PickerItem[] = groups.channels
      .map(channel => ({
        id: channel.id,
        title: channel.name ?? formatMessage('search.row.fallbackTitle'),
        subtitle: formatMessage(
          channel.kind === 'private' ? 'search.picker.channelPrivate' : 'search.picker.channelPublic',
        ),
        kind: channel.kind === 'private' ? ('private' as const) : ('channel' as const),
        peerId: null,
      }))
      .sort((a, b) => byChannelName(a.title, b.title));
    const dms: PickerItem[] = groups.dms
      .map(dm => {
        const peer = dmPeer(dm, directory, member.id);
        return {
          id: dm.id,
          title: channelLabel(dm, directory, member.id),
          subtitle: formatMessage(peer?.kind === 'agent' ? 'search.picker.agent' : 'search.picker.dm'),
          kind: 'dm' as const,
          peerId: peer?.id ?? null,
        };
      })
      .sort((a, b) => a.title.localeCompare(b.title, 'ko'));
    return [...channels, ...dms];
  }, [groups, directory, member.id, formatMessage, byChannelName]);

  const scope = useMemo(() => {
    if (scopeId === null) return null;
    const item = pickerItems.find(candidate => uuidEq(candidate.id, scopeId));
    return {
      id: scopeId,
      title: item?.title ?? titleFor(scopeId),
      isPrivate: item === undefined || item.kind === 'dm' ? null : item.kind === 'private',
    };
  }, [scopeId, pickerItems, titleFor]);

  // 지금 효과가 있는 범위: 「메시지」 칩에서 고른 대화 하나(칩을 옮기면 고른 대화는 남아도 「전체」 검색에는 걸리지 않는다).
  const activeScopeId = kind === 'messages' && scopeId !== null ? scopeId : undefined;
  // 지금 친 말을 최근 검색에 남긴다. 서버가 받아 줄 수 있는 말(두 글자 이상)만 남고, 한 대화 안에서 찾은 말이면 그 범위와 함께 남는다.
  const remember = useCallback(() => {
    if (isSearchable(search.query)) rememberSearch(scopeKey, search.query, activeScopeId);
  }, [search.query, scopeKey, activeScopeId]);

  // 최근 검색 줄: 저장된 범위(대화 id)를 내가 든 목록에서 풀어 범위 칩의 이름을 만든다. 못 풀면(나간 대화) 범위 없는 말로 선다.
  const fallbackScopeTitle = formatMessage('search.row.fallbackTitle');
  const recentSearchRows = useMemo<RecentSearchRow[]>(
    () =>
      recents.searches.map(line => {
        const scoped =
          line.channelId === undefined
            ? null
            : recentScopeOf(groups, directory, member.id, line.channelId, fallbackScopeTitle);
        return {
          query: line.query,
          channelId: line.channelId ?? null,
          scope: scoped === null ? null : {title: scoped.title, isPrivate: scoped.isPrivate},
        };
      }),
    [recents.searches, groups, directory, member.id, fallbackScopeTitle],
  );

  // 사람을 눌러 DM 이 열리는 동안 다른 곳을 눌렀다면, 늦게 도착한 DM 이 그 길을 가로채지 않는다(`NewMessageSheet` 가 시트가 걷혔는지 묻는 것과 같은 이유).
  // 다른 결과로 간 횟수를 세어 두고, DM 을 시작할 때의 값과 달라졌으면 도착해도 열지 않는다(채널 캐시에는 넣는다).
  const navigations = useRef(0);
  const dmStartedAt = useRef(0);

  // 결과로 가는 모든 길의 마지막 한 걸음: 자판을 내린 뒤 연다(#5418). 인자 수는 그대로 넘긴다 - 메시지만 앵커를 가진다.
  const openResult = useCallback(
    (channelId: string, title: string, anchor?: {messageId: string; seq: number}) => {
      Keyboard.dismiss();
      if (anchor === undefined) onOpenResult(channelId, title);
      else onOpenResult(channelId, title, anchor);
    },
    [onOpenResult],
  );

  const openChannel = useCallback(
    (channelId: string, title: string) => {
      remember();
      navigations.current += 1;
      openResult(channelId, title);
    },
    [remember, openResult],
  );

  const openMessage = useCallback(
    (hit: MessageSearchHit) => {
      remember();
      navigations.current += 1;
      openResult(hit.channelId, titleFor(hit.channelId), {
        messageId: hit.messageId,
        seq: hit.seq,
      });
    },
    [remember, openResult, titleFor],
  );

  // 사람 → DM. 「새 DM」 시트와 같은 길이다: 서버가 그 둘의 DM 을 열어 주고(없으면 만든다 — 닫아 둔 DM 도 이 길로 다시 선다) 채널 캐시에
  // 먼저 넣어 첫 그림부터 DM 으로 선다.
  const openDm = useMutation({
    mutationFn: (memberId: string) => openDirectMessage(workspaceId, memberId),
    onSuccess: opened => {
      rememberOpenedDm(opened.channel);
      if (dmStartedAt.current !== navigations.current) return;
      openResult(opened.channel.id, channelLabel(opened.channel, directory, member.id));
    },
  });

  const onExit = useCallback(() => {
    if (search.query !== '') {
      search.setQuery('');
      return;
    }
    // 돌아가면 처음 열 때의 모양으로 — 칩과 범위도 비운다.
    setKind('all');
    setScopeId(null);
    onClose?.();
  }, [search, onClose]);

  const messageRow = useCallback(
    (hit: MessageSearchHit) => (
      <ResultRow
        key={hit.messageId}
        hit={hit}
        query={search.settledQuery}
        channelTitle={titleFor(hit.channelId)}
        authorName={memberNameParts(directory, hit.authorMemberId, missingMemberLabel(directory)).name}
        onPress={() => openMessage(hit)}
      />
    ),
    [search.settledQuery, titleFor, directory, openMessage],
  );

  return (
    <Screen onCanvas={clearance > 0}>
      <SearchView
        search={search}
        directory={directory}
        kind={kind}
        onKind={setKind}
        onExit={onExit}
        onSubmit={remember}
        inputLabel={SEARCH_SURFACE_NAME}
        scope={scope}
        onPickScope={() => setPickerOpen(true)}
        onClearScope={() => setScopeId(null)}
        channels={channelMatches}
        people={peopleMatches}
        localPending={channelsQuery.isPending || directoryQuery.isPending}
        recentTiles={recentTiles}
        recentSearches={recentSearchRows}
        onOpenRecent={tile => {
          navigations.current += 1;
          openResult(tile.channelId, tile.title);
        }}
        onPickRecentSearch={row => {
          // 이미 다 친 말이라 디바운스를 기다리지 않는다. 범위가 있는 줄은 「메시지」 칩 + 그 대화로 다시 찾는다(범위 칩이 말하던 그대로).
          search.setQueryNow(row.query);
          const scoped = row.scope !== null && row.channelId !== null ? row.channelId : null;
          if (scoped !== null) {
            setKind('messages');
            setScopeId(scoped);
          }
          rememberSearch(scopeKey, row.query, scoped ?? undefined);
        }}
        onClearRecentSearches={() => forgetSearches(scopeKey)}
        onOpenChannel={match => openChannel(match.channel.id, match.name)}
        onOpenPerson={match => {
          // DM 이 열리길 기다리는 동안에도 자판은 이미 내려가 있다(도착했을 때 `openResult` 가 한 번 더 내린다).
          Keyboard.dismiss();
          // 열리는 중에 다른 사람을 또 누르면 DM 이 둘 열린다 — 한 번에 하나다.
          if (openDm.isPending) return;
          remember();
          dmStartedAt.current = navigations.current;
          openDm.mutate(match.member.id);
        }}
        renderMessage={messageRow}
        dmFailure={
          openDm.isError
            ? {
                message: openDmFailureCopy(openDm.error),
                retry:
                  openDm.variables === undefined
                    ? undefined
                    : () => openDm.mutate(openDm.variables as string),
              }
            : null
        }
        clearance={clearance}
      />
      {pickerOpen ? (
        <ConversationPickerSheet
          items={pickerItems}
          directory={directory}
          selectedId={scopeId}
          onPick={next => setScopeId(next)}
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
    </Screen>
  );
}

export interface SearchViewProps {
  search: MessageSearch;
  directory: Directory;
  kind: SearchKind;
  onKind: (next: SearchKind) => void;
  onExit: () => void;
  onSubmit: () => void;
  inputLabel: string;
  scope: {id: string; title: string; isPrivate: boolean | null} | null;
  onPickScope: () => void;
  onClearScope: () => void;
  channels: readonly ChannelMatch[];
  people: readonly PersonMatch[];
  /** 채널·사람 목록을 아직 못 받았다. 받기 전에 「없다」고 말하지 않는다. */
  localPending: boolean;
  recentTiles: readonly RecentTile[];
  recentSearches: readonly RecentSearchRow[];
  onOpenRecent: (tile: RecentTile) => void;
  onPickRecentSearch: (row: RecentSearchRow) => void;
  onClearRecentSearches: () => void;
  onOpenChannel: (match: ChannelMatch) => void;
  onOpenPerson: (match: PersonMatch) => void;
  renderMessage: (hit: MessageSearchHit) => React.JSX.Element;
  dmFailure: {message: string; retry?: () => void} | null;
  /** 목록 끝에 더할 여백(탭바 높이). 셸 밖에서는 0. */
  clearance: number;
}

/**
 * 머리(X·입력칸)부터 아래 전부. 화면이 서버 없이는 못 보이는 상태(빈 결과·오류·최근 목록이 찬 첫 화면)를 `measure/surfaces.tsx` 가
 * 이 컴포넌트 그대로 찍을 수 있도록, 데이터는 모두 props 로 받는다 — 옛 `SearchBody` 가 하던 일이다.
 */
export function SearchView(view: SearchViewProps): React.JSX.Element {
  const {search, kind, onKind, inputLabel} = view;
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const trimmed = search.query.trim();
  const placeholder = formatMessage('search.input.placeholder');
  const kindLabels = {
    all: formatMessage('search.kind.all'),
    messages: formatMessage('search.kind.messages'),
    channels: formatMessage('search.kind.channels'),
    people: formatMessage('search.kind.people'),
  } satisfies Record<SearchKind, string>;

  return (
    <>
      <View style={styles.topRow}>
        <CloseCircle
          label={formatMessage(trimmed === '' && search.query === '' ? 'search.input.exitLabel' : 'search.input.clearLabel')}
          onPress={view.onExit}
          testID="search-exit"
        />
        <View style={styles.pillSlot}>
          <InputPill
            icon={SHELL_ICONS.search}
            // 동기. `useMessageSearch` 의 헤더 참조 — 늦는 것은 요청뿐이다.
            value={search.query}
            onChangeText={search.setQuery}
            placeholder={placeholder}
            // 이 밭의 이름도 이 표면의 이름이다 — 한 낱말을 두 군데 적으면 한쪽만 낡는다 (이슈 #1146 N4).
            accessibilityLabel={inputLabel}
            accessibilityHint={placeholder}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            returnKeyType="search"
            onSubmitEditing={view.onSubmit}
            testID="search-input"
          />
        </View>
      </View>
      <KindChips
        kind={kind}
        onKind={onKind}
        labels={kindLabels}
        groupLabel={formatMessage('search.kind.groupLabel')}
      />
      {kind === 'messages' ? (
        <ScopeChips
          scope={view.scope}
          groupLabel={formatMessage('search.scope.groupLabel')}
          allLabel={formatMessage('search.scope.all')}
          pickLabel={formatMessage('search.scope.pick')}
          pickAccessibilityLabel={formatMessage('search.scope.pickLabel')}
          chosenAccessibilityLabel={formatMessage('search.scope.chosenLabel', {
            name: view.scope?.title ?? '',
          })}
          onClear={view.onClearScope}
          onPick={view.onPickScope}
        />
      ) : null}
      <View style={styles.body}>
        {view.dmFailure ? (
          <View style={styles.failure}>
            <FailureBanner
              message={view.dmFailure.message}
              retryLabel={formatMessage('search.state.retry')}
              onRetry={view.dmFailure.retry}
              testID="search-dm-error"
            />
          </View>
        ) : null}
        {trimmed === '' ? <HomeBody {...view} /> : <ResultsBody {...view} />}
      </View>
    </>
  );
}

/** 입력 전: 최근 연 대화와 최근 검색. 둘 다 없으면 한 줄 안내. */
function HomeBody(view: SearchViewProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const hasTiles = view.recentTiles.length > 0;
  const hasSearches = view.recentSearches.length > 0;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{paddingBottom: view.clearance}}
      testID="search-home">
      {hasTiles ? (
        <RecentConversations
          title={formatMessage('search.recent.conversations')}
          tiles={view.recentTiles}
          directory={view.directory}
          openLabel={name => formatMessage('search.recent.openLabel', {name})}
          onOpen={view.onOpenRecent}
        />
      ) : null}
      {hasSearches ? (
        <RecentSearches
          title={formatMessage('search.recent.searches')}
          clearLabel={formatMessage('search.recent.clearAll')}
          clearAccessibilityLabel={formatMessage('search.recent.clearAllLabel')}
          items={view.recentSearches}
          rowLabel={row =>
            row.scope === null
              ? formatMessage('search.recent.searchLabel', {query: row.query})
              : formatMessage('search.recent.searchInLabel', {query: row.query, where: row.scope.title})
          }
          onPick={view.onPickRecentSearch}
          onClear={view.onClearRecentSearches}
        />
      ) : null}
      {!hasTiles && !hasSearches ? (
        <Sentence style={styles.hint} testID="search-idle">
          {formatMessage('search.recent.empty')}
        </Sentence>
      ) : null}
    </ScrollView>
  );
}

/** 입력 뒤: 칩이 정한 종류만, 「전체」면 채널 → 사람 → 메시지 묶음으로. */
function ResultsBody(view: SearchViewProps): React.JSX.Element {
  switch (view.kind) {
    case 'all':
      return <AllBody {...view} />;
    case 'messages':
      return <MessagesBody {...view} />;
    case 'channels':
      return <ChannelsBody {...view} />;
    case 'people':
      return <PeopleBody {...view} />;
  }
}

function noResultsCopy(
  formatMessage: ReturnType<typeof useFormatMessage>,
  query: string,
  scopeTitle: string | null,
): string {
  return scopeTitle === null
    ? formatMessage('search.state.noResults', {query})
    : formatMessage('search.state.noResultsIn', {query, where: scopeTitle});
}

function AllBody(view: SearchViewProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {search} = view;
  const channels = previewOf(view.channels, PREVIEW_COUNT.channels);
  const people = previewOf(view.people, PREVIEW_COUNT.people);
  const hits = previewOf(search.hits, PREVIEW_COUNT.messages);
  const messagesMore = hits.more || search.hasMore;
  const nothing =
    view.channels.length === 0 && view.people.length === 0 && search.phase === 'empty';
  if (nothing) {
    return (
      <EmptyState
        headline={noResultsCopy(formatMessage, search.settledQuery, null)}
        detail={formatMessage('search.state.scopeNote')}
        testID="search-empty"
      />
    );
  }
  const loadingLocal =
    view.localPending && view.channels.length === 0 && view.people.length === 0;
  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{paddingBottom: view.clearance}}
      testID="search-all">
      {channels.shown.length > 0 ? (
        <View testID="search-group-channels">
          <GroupHeader
            title={formatMessage('search.group.channels')}
            moreLabel={formatMessage('search.group.more')}
            moreAccessibilityLabel={formatMessage('search.group.moreLabel', {
              group: formatMessage('search.group.channels'),
            })}
            onMore={channels.more ? () => view.onKind('channels') : undefined}
            testID="search-head-channels"
          />
          {channels.shown.map(match => (
            <ChannelRow
              key={match.channel.id}
              id={match.channel.id}
              name={match.name}
              isPrivate={match.channel.kind === 'private'}
              ranges={match.ranges}
              onPress={() => view.onOpenChannel(match)}
            />
          ))}
        </View>
      ) : null}
      {people.shown.length > 0 ? (
        <View testID="search-group-people">
          <GroupHeader
            title={formatMessage('search.group.people')}
            moreLabel={formatMessage('search.group.more')}
            moreAccessibilityLabel={formatMessage('search.group.moreLabel', {
              group: formatMessage('search.group.people'),
            })}
            onMore={people.more ? () => view.onKind('people') : undefined}
            testID="search-head-people"
          />
          {people.shown.map(match => (
            <PersonRow
              key={match.member.id}
              member={match.member}
              directory={view.directory}
              nameRanges={match.nameRanges}
              handleRanges={match.handleRanges}
              onPress={() => view.onOpenPerson(match)}
            />
          ))}
        </View>
      ) : null}
      {loadingLocal && search.phase !== 'results' ? (
        <Sentence style={styles.hint} testID="search-local-pending">
          {formatMessage('search.state.pendingChannels')}
        </Sentence>
      ) : null}
      {search.phase !== 'empty' && search.phase !== 'idle' ? (
        <View testID="search-group-messages">
          <GroupHeader
            title={formatMessage('search.group.messages')}
            moreLabel={formatMessage('search.group.more')}
            moreAccessibilityLabel={formatMessage('search.group.moreLabel', {
              group: formatMessage('search.group.messages'),
            })}
            onMore={search.phase === 'results' && messagesMore ? () => view.onKind('messages') : undefined}
            testID="search-head-messages"
          />
          {search.phase === 'tooShort' ? (
            <Sentence style={styles.hint} testID="search-too-short">
              {formatMessage('search.state.shortHintMessages')}
            </Sentence>
          ) : null}
          {search.phase === 'searching' ? (
            <SkeletonRows label={formatMessage('search.state.loading')} />
          ) : null}
          {search.phase === 'error' ? (
            <ErrorState
              headline={formatMessage('search.state.errorHeadline')}
              detail={formatMessage('search.state.errorDetail')}
              onRetry={search.retry}
              testID="search-error"
            />
          ) : null}
          {search.phase === 'results' ? (
            <View testID="search-results">{hits.shown.map(view.renderMessage)}</View>
          ) : null}
        </View>
      ) : null}
    </ScrollView>
  );
}

function MessagesBody(view: SearchViewProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {search} = view;
  switch (search.phase) {
    case 'idle':
      return <HomeBody {...view} />;
    case 'tooShort':
      return <EmptyState headline={formatMessage('search.state.shortHint')} testID="search-too-short" />;
    case 'searching':
      return <SkeletonRows label={formatMessage('search.state.loading')} count={4} />;
    case 'error':
      return (
        <ErrorState
          headline={formatMessage('search.state.errorHeadline')}
          detail={formatMessage('search.state.errorDetail')}
          onRetry={search.retry}
          testID="search-error"
        />
      );
    case 'empty':
      return (
        <EmptyState
          headline={noResultsCopy(formatMessage, search.settledQuery, view.scope?.title ?? null)}
          detail={view.scope === null ? formatMessage('search.state.scopeNote') : undefined}
          testID="search-empty"
        />
      );
    case 'results':
      return (
        <FlatList
          data={search.hits}
          renderItem={({item}) => view.renderMessage(item)}
          keyExtractor={hit => hit.messageId}
          testID="search-results"
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{paddingBottom: view.clearance}}
          ListFooterComponent={
            search.hasMore ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={formatMessage('search.group.more')}
                accessibilityState={{busy: search.loadingMore}}
                disabled={search.loadingMore}
                onPress={search.loadMore}
                style={({pressed}) => [styles.loadMore, pressed && styles.pressed]}
                testID="search-more">
                <Text style={styles.loadMoreLabel}>
                  {search.loadingMore
                    ? formatMessage('search.group.loadingMore')
                    : formatMessage('search.group.more')}
                </Text>
              </Pressable>
            ) : null
          }
        />
      );
  }
}

function ChannelsBody(view: SearchViewProps): React.JSX.Element {
  const formatMessage = useFormatMessage();
  if (view.channels.length === 0) {
    return view.localPending ? (
      <EmptyState headline={formatMessage('search.state.pendingChannels')} testID="search-local-pending" />
    ) : (
      <EmptyState
        headline={noResultsCopy(formatMessage, view.search.query.trim(), null)}
        testID="search-empty"
      />
    );
  }
  return (
    <FlatList
      data={view.channels}
      keyExtractor={match => match.channel.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{paddingBottom: view.clearance}}
      renderItem={({item}) => (
        <ChannelRow
          id={item.channel.id}
          name={item.name}
          isPrivate={item.channel.kind === 'private'}
          ranges={item.ranges}
          onPress={() => view.onOpenChannel(item)}
        />
      )}
      testID="search-channels"
    />
  );
}

function PeopleBody(view: SearchViewProps): React.JSX.Element {
  const formatMessage = useFormatMessage();
  if (view.people.length === 0) {
    return view.localPending ? (
      <EmptyState headline={formatMessage('search.state.pendingChannels')} testID="search-local-pending" />
    ) : (
      <EmptyState
        headline={noResultsCopy(formatMessage, view.search.query.trim(), null)}
        testID="search-empty"
      />
    );
  }
  return (
    <FlatList
      data={view.people}
      keyExtractor={match => match.member.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="interactive"
      contentContainerStyle={{paddingBottom: view.clearance}}
      renderItem={({item}) => (
        <PersonRow
          member={item.member}
          directory={view.directory}
          nameRanges={item.nameRanges}
          handleRanges={item.handleRanges}
          onPress={() => view.onOpenPerson(item)}
        />
      )}
      testID="search-people"
    />
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    topRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.sm,
      paddingBottom: space.md,
    },
    pillSlot: {flex: 1},
    body: {flex: 1},
    failure: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
    hint: {
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
      fontSize: font.label,
      color: color.textMuted,
    },
    loadMore: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      margin: SAFE_GUTTER,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
    },
    loadMoreLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
    pressed: {backgroundColor: color.surfacePressed},
  });
