import type {Channel} from '@momo/core/lib/api';
import {
  CHANNEL_BROWSE_QUERY_MAX,
  channelBrowseLoadFailure,
  splitBrowseRows,
  type BrowseChannel,
  type ChannelBrowseFailure,
} from '@momo/core/features/channels/browse';
import {looseTailIncludes} from '@momo/core/features/channels/nameSearch';
import {memberFor} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo, useState} from 'react';
import {
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import {
  EmptyState,
  ErrorState,
  LoadingState,
  NoticeBlock,
  OutlineButton,
  Screen,
  Sentence,
  STACK_PILL_SCALE,
} from '../design/atoms';
import {HOME_ICONS, SHELL_ICONS} from '../design/icons';
import {PageHeader} from '../design/SheetChrome';
import {GroupCardItem, GroupLabel, InputPill, RowIcon} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, line, radius, SAFE_GUTTER, SHEET, space, TOUCH_TARGET, type Palette} from '../design/tokens';
import {
  useChannelBrowseList,
  useJoinBrowsedChannel,
  useSettledValue,
} from '../features/channelBrowse/useChannelBrowse';
import {useOnline} from '../features/inbox/useOnline';
import {useDirectory} from '../features/workspace/queries';
import {useFormatMessage} from '../i18n/useFormatMessage';
import type {OpenChannelPreview} from '../nav/state';
import {useSession} from '../session/useSession';

// =============================================================================
// 폰 「채널 둘러보기」 페이지 (ADR-0224 화면 폰 줄 · D3 · D4 · D8, #5846).
//
// 문은 홈 「채널」 섹션 머리의 ⋯ 메뉴(정식 멤버에게만)와 홈 이름 검색의 「참여하지 않은 공개 채널」 묶음이다. 긴 목록 · 거르기 ·
// 더 불러오기라 시트가 아니라 **페이지**다(`docs/design-system/phone-sheets.md` §1 규칙 1). 셸의 층이고 닫히면 언마운트된다 —
// 그래서 열 때마다 다시 읽는다(`useChannelBrowseList` 의 `gcTime: 0`).
//
// 줄 = 서버 목록 그대로(켜진 공개 채널만, 서버가 거른다). 화면은 `splitBrowseRows` 로 「참여하지 않은 채널」을 위에 둘 뿐이다.
// 관리자 묶음과 「둘러보기에 보이기」 스위치는 폰에 없다(ADR-0224 D2 · D12).
//
// ## 줄의 모양 — 글자 칸과 단추가 따로다
//
// `ListRow` 는 줄 전체가 누름 하나라서 쓰지 않았다: 미리 보기(#5847)가 「줄을 누르면 미리 보기, 단추는 참여」를 얹을 자리가
// 막히고, `onPress` 없는 `ListRow` 는 `accessible` 한 덩어리라 안에 둔 단추에 VoiceOver 가 닿지 못한다. 그래서 묶음 카드의 한 줄
// (`GroupCardItem`) 안에 글자 칸(낭독 이름 하나)과 공용 `OutlineButton` 을 나란히 둔다. #5847 은 글자 칸(`rowMain`)을 누르는
// 면으로 바꾸면 된다(`onPreview` 자리).
//
// ## 상태가 바뀌어도 머리 · 거르기 칸 · 줄 자리가 움직이지 않게
//
// 머리와 거르기 칸은 목록 밖에 고정이고, 네 상태(불러오는 중 · 실패 · 비어 있음 · 목록)는 그 아래 한 칸을 갈아 쓴다. 줄의 실패
// 문장은 둘째 줄(멤버 수 · 주제)의 자리를 갈아 끼우고, 404 로 걷힌 줄도 같은 높이를 지킨다(단추가 빠져도 줄의 최소 높이 그대로).
// =============================================================================

export default function ChannelBrowseScreen({
  initialQuery = '',
  onClose,
  onOpenChannel,
  onPreview,
}: {
  /** 홈 이름 검색에서 고른 이름 — 거르기 칸에 미리 넣는다. */
  initialQuery?: string;
  onClose: () => void;
  /** 참여한 채널 · 이미 든 채널로 간다. 셸이 이 층을 걷고 그 대화를 연다. */
  onOpenChannel: (channelId: string, title: string) => void;
  /** 참여하지 않은 줄의 글자 칸을 눌렀다 — 셸이 둘러보기 위에 미리 보기를 세운다(#5847). */
  onPreview: (preview: OpenChannelPreview) => void;
}): React.JSX.Element {
  const {member, workspaceId} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const role = memberFor(directoryQuery.directory, member.id)?.role;
  const online = useOnline();

  const [typed, setTyped] = useState(() => initialQuery.slice(0, CHANNEL_BROWSE_QUERY_MAX));
  // 칸 값(`typed`)은 동기 상태 그대로다. 서버로 가는 글자만 250ms 쉬고 간다.
  const serverQuery = useSettledValue(typed.trim());
  const list = useChannelBrowseList(workspaceId, serverQuery);

  const onJoined = useCallback(
    // 제목은 홈 줄 · 새 채널 시트와 같은 맨 이름이다(`#` 은 대화 머리가 붙인다).
    (channel: Channel) => onOpenChannel(channel.id, channel.name ?? ''),
    [onOpenChannel],
  );
  const join = useJoinBrowsedChannel(workspaceId, member.id, onJoined);

  const allRows = useMemo(
    () => (list.data?.pages ?? []).flatMap(page => page.channels),
    [list.data],
  );
  const rows = useMemo(() => allRows.filter(row => rowMatches(row, typed)), [allRows, typed]);

  const state: ChannelBrowseViewState = list.isPending
    ? 'loading'
    : list.isError && allRows.length === 0
      ? 'error'
      : 'ready';

  return (
    <ChannelBrowseView
      state={state}
      rows={rows}
      typed={typed}
      onChangeTyped={setTyped}
      loadFailure={list.isError ? channelBrowseLoadFailure(list.error) : undefined}
      onRetry={() => void list.refetch()}
      isAdmin={role === 'owner' || role === 'admin'}
      offline={!online}
      pending={join.pending}
      failures={join.failures}
      onJoin={channelId => void join.join(channelId)}
      onOpen={row => onOpenChannel(row.id, row.name)}
      onPreview={row =>
        onPreview({channelId: row.id, name: row.name, topic: row.topic, memberCount: row.memberCount})
      }
      hasMore={list.hasNextPage}
      loadingMore={list.isFetchingNextPage}
      moreFailed={list.isFetchNextPageError}
      onLoadMore={() => {
        if (!list.isFetchingNextPage) void list.fetchNextPage();
      }}
      onClose={onClose}
    />
  );
}

/** 화면에서 좁히기: 이름 · 주제에 그대로 들어 있거나, 조합 중인 마지막 글자까지 느슨하게 맞으면 남는다(웹 창과 같은 규칙). */
function rowMatches(row: BrowseChannel, typed: string): boolean {
  const needle = typed.trim().toLowerCase();
  if (needle === '') return true;
  const fields = row.topic === undefined ? [row.name] : [row.name, row.topic];
  return fields.some(
    field => field.toLowerCase().includes(needle) || looseTailIncludes(needle, field),
  );
}

export type ChannelBrowseViewState = 'loading' | 'error' | 'ready';

/** 순수 표현부. 훅 없이 props 로만 그린다 — 측정 장면과 시험이 서버 없이 네 상태를 세운다. */
export function ChannelBrowseView({
  state,
  rows,
  typed,
  onChangeTyped,
  loadFailure,
  onRetry,
  isAdmin,
  offline,
  pending,
  failures,
  onJoin,
  onOpen,
  onPreview,
  hasMore,
  loadingMore,
  moreFailed,
  onLoadMore,
  onClose,
}: {
  state: ChannelBrowseViewState;
  rows: BrowseChannel[];
  typed: string;
  onChangeTyped: (next: string) => void;
  loadFailure?: ChannelBrowseFailure;
  onRetry: () => void;
  isAdmin: boolean;
  offline: boolean;
  pending: ReadonlySet<string>;
  failures: ReadonlyMap<string, ChannelBrowseFailure>;
  onJoin: (channelId: string) => void;
  onOpen: (row: BrowseChannel) => void;
  onPreview: (row: BrowseChannel) => void;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onLoadMore: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const say = (failure: ChannelBrowseFailure): string =>
    formatMessage(failure.key, failure.values as never);
  const typedQuery = typed.trim();
  const {notJoined, joined} = splitBrowseRows(rows);

  let body: React.ReactNode;
  if (state === 'loading') {
    body = <LoadingState label={formatMessage('channels.browse.loading')} testID="channel-browse-loading" />;
  } else if (state === 'error') {
    body = (
      <ErrorState
        headline={loadFailure ? say(loadFailure) : formatMessage('channels.browse.loadGeneric')}
        onRetry={onRetry}
        testID="channel-browse-error"
      />
    );
  } else if (rows.length === 0 && typedQuery !== '') {
    body = (
      <View style={styles.stateWrap} testID="channel-browse-no-match">
        <EmptyState headline={formatMessage('channels.browse.noMatch', {query: typedQuery})} />
        <View style={styles.stateAction}>
          <OutlineButton
            label={formatMessage('channels.browse.clearSearch')}
            onPress={() => onChangeTyped('')}
            testID="channel-browse-clear"
          />
        </View>
      </View>
    );
  } else {
    const sections = [
      {key: 'notJoined', title: formatMessage('channels.browse.groupNotJoined'), data: notJoined},
      {key: 'joined', title: formatMessage('channels.browse.groupJoined'), data: joined},
    ].filter(section => section.data.length > 0);
    // 참여하지 않은 공개 채널이 없다는 것이 이 화면의 빈 상태다(출시 직후 흔하다, ADR-0224 D10). 이미 든 채널은 아래에 그대로 남는다.
    // 소유자 · 관리자에게는 이미 있는 채널을 여는 길을 한 줄 더 말한다 — 폰에는 스위치가 없어서 웹 · 데스크탑을 가리킨다.
    const empty =
      notJoined.length === 0 && typedQuery === '' ? (
        <EmptyState
          headline={formatMessage('channels.browse.emptyHeadline')}
          detail={isAdmin ? formatMessage('channels.browse.emptyAdminDetailPhone') : undefined}
          testID="channel-browse-empty"
        />
      ) : null;
    body = (
      <SectionList
        sections={sections}
        keyExtractor={row => row.id}
        ListHeaderComponent={empty}
        renderSectionHeader={({section}) => (
          <View style={styles.groupHead}>
            <GroupLabel testID={`channel-browse-group-${section.key}`}>{section.title}</GroupLabel>
          </View>
        )}
        renderItem={({item, index, section}) => (
          <BrowseRow
            row={item}
            index={index}
            count={section.data.length}
            pending={pending.has(item.id)}
            failure={failures.get(item.id)}
            onJoin={onJoin}
            onOpen={onOpen}
            onPreview={onPreview}
          />
        )}
        ListFooterComponent={
          hasMore ? (
            <View style={styles.more}>
              {moreFailed && loadFailure ? (
                <Sentence style={styles.moreError} accessibilityLiveRegion="polite" testID="channel-browse-more-error">
                  {say(loadFailure)}
                </Sentence>
              ) : null}
              <OutlineButton
                label={formatMessage(moreFailed ? 'channels.browse.retry' : 'channels.browse.loadMore')}
                busy={loadingMore}
                busyLabel={formatMessage('channels.browse.loadMore')}
                onPress={onLoadMore}
                testID="channel-browse-more"
              />
            </View>
          ) : null
        }
        stickySectionHeadersEnabled={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        testID="channel-browse-list"
      />
    );
  }

  return (
    <Screen>
      <PageHeader
        title={formatMessage('channels.browse.title')}
        closeLabel={formatMessage('channels.browse.closeAria')}
        onClose={onClose}
        closeTestID="channel-browse-close"
        titleTestID="channel-browse-title"
      />
      <View style={styles.search}>
        <InputPill
          icon={SHELL_ICONS.search}
          value={typed}
          onChangeText={onChangeTyped}
          maxLength={CHANNEL_BROWSE_QUERY_MAX}
          placeholder={formatMessage('channels.browse.searchPlaceholder')}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel={formatMessage('channels.browse.searchLabel')}
          testID="channel-browse-search"
        />
      </View>
      {offline ? (
        <NoticeBlock headline={formatMessage('channels.browse.offline')} testID="channel-browse-offline" />
      ) : null}
      <View style={styles.body} testID={`channel-browse-body-${state}`}>
        {body}
      </View>
    </Screen>
  );
}

/**
 * 한 줄. 글자 칸(`#이름` · 「기본」 · 둘째 줄)과 오른쪽 단추가 따로 선다(머리 주석). 둘째 줄은 늘 한 자리다: 멤버 수 · 주제, 또는
 * 그 줄의 실패 문장. 404(그 사이 꺼졌거나 보관됨)는 단추 없이 같은 자리에 문장만 남는다(웹과 같다). 큰 글자(`STACK_PILL_SCALE`
 * 부터)에서는 단추가 글자 아래로 내려가고 이름 · 문장은 잘리지 않고 접힌다.
 */
export function BrowseRow({
  row,
  index,
  count,
  pending,
  failure,
  onJoin,
  onOpen,
  onPreview,
}: {
  row: BrowseChannel;
  index: number;
  count: number;
  pending: boolean;
  failure: ChannelBrowseFailure | undefined;
  onJoin: (channelId: string) => void;
  onOpen: (row: BrowseChannel) => void;
  onPreview: (row: BrowseChannel) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {fontScale} = useWindowDimensions();
  const stacked = fontScale >= STACK_PILL_SCALE;
  const gone = failure?.kind === 'notFound';
  const failed = failure !== undefined && !gone;
  const canPreview = !row.isMember && !gone;
  const meta = [formatMessage('channels.browse.memberCount', {count: row.memberCount}), row.topic]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(' · ');
  const second = failure ? formatMessage(failure.key, failure.values as never) : meta;
  const defaultLabel = formatMessage('channels.browse.default');
  const spoken = [row.name, row.isDefault && !gone ? defaultLabel : undefined, second]
    .filter(Boolean)
    .join(', ');

  return (
    <GroupCardItem index={index} count={count} inset="icon" testID={`channel-browse-row-${row.id}`}>
      <View style={[styles.row, stacked && styles.rowStacked]}>
        {/* 참여하지 않은 줄은 이 칸이 누르는 면이다 — 누르면 미리 보기(#5847). 이미 든 줄 · 그 사이 꺼진 줄은 읽히기만 한다. */}
        <RowMain
          style={styles.rowMain}
          label={spoken}
          onPress={canPreview ? () => onPreview(row) : undefined}
          hint={canPreview ? formatMessage('channels.preview.openHint') : undefined}
          testID={`channel-browse-row-text-${row.id}`}>
          <RowIcon source={HOME_ICONS.hash} />
          <View style={styles.rowText}>
            <View style={styles.titleLine}>
              <Text
                style={[styles.name, gone && styles.nameGone]}
                numberOfLines={stacked ? undefined : 1}
                ellipsizeMode="tail">
                {row.name}
              </Text>
              {row.isDefault && !gone ? (
                <View style={styles.chip} testID={`channel-browse-default-${row.id}`}>
                  <Text style={styles.chipText}>{defaultLabel}</Text>
                </View>
              ) : null}
            </View>
            <Sentence
              style={[styles.meta, failed && styles.metaFailed]}
              // 멤버 수 · 주제는 한 줄(말줄임), 실패 문장은 잘리면 이유를 읽을 수 없어 접힌다.
              numberOfLines={failure || stacked ? undefined : 1}
              accessibilityLiveRegion={failure ? 'polite' : undefined}
              testID={failure ? `channel-browse-row-error-${row.id}` : `channel-browse-row-meta-${row.id}`}>
              {second}
            </Sentence>
          </View>
        </RowMain>
        {gone ? null : (
          <View style={[styles.action, stacked && styles.actionStacked]}>
            {row.isMember ? (
              <OutlineButton
                label={formatMessage('channels.browse.joined')}
                accessibilityLabel={formatMessage('channels.browse.openAria', {name: row.name})}
                onPress={() => onOpen(row)}
                testID={`channel-browse-open-${row.id}`}
              />
            ) : (
              <OutlineButton
                label={formatMessage(failed ? 'channels.browse.retry' : 'channels.browse.join')}
                accessibilityLabel={formatMessage('channels.browse.joinAria', {name: row.name})}
                busy={pending}
                busyLabel={formatMessage('channels.browse.joining')}
                // 진행 중에는 단추가 잠기지만, 겹친 누름은 훅(ref)이 한 번 더 버린다.
                onPress={() => onJoin(row.id)}
                testID={`channel-browse-join-${row.id}`}
              />
            )}
          </View>
        )}
      </View>
    </GroupCardItem>
  );
}

/** 줄의 글자 칸. 눌리는 줄(참여하지 않은 채널)만 누름 면이고 낭독은 어느 쪽이든 한 덩어리 이름 하나다. */
function RowMain({
  style,
  label,
  hint,
  onPress,
  testID,
  children,
}: {
  style: StyleProp<ViewStyle>;
  label: string;
  hint?: string;
  onPress?: () => void;
  testID: string;
  children: React.ReactNode;
}): React.JSX.Element {
  if (onPress === undefined) {
    return (
      <View style={style} accessible accessibilityLabel={label} testID={testID}>
        {children}
      </View>
    );
  }
  return (
    <Pressable
      style={style}
      accessible
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      onPress={onPress}
      testID={testID}>
      {children}
    </Pressable>
  );
}

/** 줄의 최소 높이: 단추(44) + 위아래 숨. 404 로 단추가 빠져도 이 높이를 지켜 아래 줄이 올라오지 않는다. */
export const BROWSE_ROW_MIN_HEIGHT = TOUCH_TARGET + space.sm * 2;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    search: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.sm, paddingBottom: space.sm},
    body: {flex: 1},
    list: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.xl * 2},
    groupHead: {paddingTop: space.md, paddingBottom: space.xs},
    stateWrap: {flex: 1},
    stateAction: {paddingHorizontal: SAFE_GUTTER, alignItems: 'flex-start'},
    row: {
      minHeight: BROWSE_ROW_MIN_HEIGHT,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.sm,
    },
    rowStacked: {flexDirection: 'column', alignItems: 'stretch'},
    rowMain: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: space.sm},
    rowText: {flex: 1, gap: space.xs / 2},
    titleLine: {flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.xs},
    name: {flexShrink: 1, fontSize: font.body, lineHeight: line.body, fontWeight: '600', color: color.text},
    nameGone: {color: color.textMuted},
    chip: {
      paddingHorizontal: space.xs,
      borderRadius: radius.sm,
      backgroundColor: color.surfaceMuted,
    },
    chipText: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    meta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    metaFailed: {color: color.danger},
    action: {flexShrink: 0},
    actionStacked: {alignItems: 'flex-start'},
    more: {paddingTop: space.md, gap: space.sm, alignItems: 'flex-start'},
    moreError: {fontSize: font.meta, lineHeight: line.meta, color: color.danger},
  });
