import type {SharedWorkSession} from '@momo/core/lib/api';
import {uuidEq} from '@momo/core/lib/api';
import {relativeLabel} from '@momo/core/features/inbox/model';
import {
  TEAM_BOARD_COPY,
  boardSections,
  boardSummary,
  channelLabel,
  ownedBy,
  sessionTitle,
  whereLabel,
  type BoardSection,
} from '@momo/core/features/workbench/teamBoard';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  Pressable,
  SectionList,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  EmptyState,
  ErrorState,
  FailureBanner,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  SectionLabel,
  TapRow,
} from '../design/atoms';
import {useRefreshControl} from '../design/refresh';
import {useStyles} from '../design/theme';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {useOnline} from '../features/inbox/useOnline';
import {TeamBoardDetailSheet} from '../features/work/teamBoard/TeamBoardDetailSheet';
import {
  DiffNumbers,
  LaneLabel,
  StateChip,
} from '../features/work/teamBoard/TeamBoardParts';
import {
  useTeamBoardItem,
  useTeamBoardList,
  useTeamBoardRail,
} from '../features/work/teamBoard/useTeamBoard';
import {useSession} from '../session/useSession';
import {queryFailureDetail} from './SidebarScreen';

// =============================================================================
// 「작업」 — 팀 보드의 한 열 판 (#2864, 제안서 T12·시안 ⑦ 왼쪽, 웹 `TeamBoardRoute`의 짝).
//
// 보이는 것은 **서버가 보는 사람의 채널 멤버십으로 걸러 준 공유 세션**뿐이다. 이 화면은 그
// 위에 다시 거르지 않고, 작업 원장(`/work-sessions`)을 읽지도 않는다. 「내 것」은 보는
// 사람이 고른 보기(주인이 나인 줄)이지 가시성 거르기가 아니다. 한 열에 상태 순서로 선다:
// 응답 필요 → 실행 중 → 검토 대기, 그 뒤 대기, 맨 끝에 오늘 끝난 것. 줄을 누르면 읽기
// 전용 시트가 열린다(터미널·입력·멈춤 없음).
// =============================================================================

export type BoardFilter = 'all' | 'mine';

const MINUTE_MS = 60_000;
const FOCUS_RETURN_MS = 60;

/** 보일 때만 분 단위로 도는 시계. 가려진 층이 몰래 다시 그리지 않는다. */
function useActiveMinuteNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export default function TeamBoardScreen({
  active,
  onOpenConversation,
  onOpenAgentSession,
  onBack,
  initialFilter = 'all',
}: {
  /** False while this visited layer is hidden; disables its reads, signals and clock. */
  active: boolean;
  onOpenConversation: (channelId: string, title: string) => void;
  /** 내가 시킨 에이전트 세션의 기존 화면(허락 서명 컨트롤이 있는 곳)으로 이동한다. */
  onOpenAgentSession?: (sessionId: string) => void;
  /** FAB 시트가 여는 층이 된 뒤의 나가는 길 (ADR-0189 D1). */
  onBack?: () => void;
  /** 처음 고른 보기. 앱은 기본값(전체)만 쓰고, 캡처 하네스가 「내 것」 판을 고른다. */
  initialFilter?: BoardFilter;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {workspaceId, member} = useSession();
  const online = useOnline();
  const nowMs = useActiveMinuteNow(active);
  const [filter, setFilter] = useState<BoardFilter>(initialFilter);
  const [openId, setOpenId] = useState<string | null>(null);
  const [goneNotice, setGoneNotice] = useState(false);
  const lastOpenedRef = useRef<string | null>(null);
  const rowRefs = useRef(
    new Map<string, React.ElementRef<typeof Pressable>>(),
  );

  const list = useTeamBoardList(workspaceId, active);
  useTeamBoardRail(workspaceId, list.items, active);

  // 구간은 한 번만 만든다. 개수는 「전체」와 「내 것」이 같은 구간 규칙 위에서 센다.
  const allSections = useMemo(
    () => boardSections(list.items, nowMs),
    [list.items, nowMs],
  );
  const shownAll = useMemo(
    () => allSections.flatMap(section => section.items),
    [allSections],
  );
  const mineCount = useMemo(
    () => ownedBy(shownAll, member.id).length,
    [shownAll, member.id],
  );
  const sections = useMemo<BoardSection[]>(
    () =>
      filter === 'all'
        ? allSections
        : boardSections(ownedBy(list.items, member.id), nowMs),
    [filter, allSections, list.items, member.id, nowMs],
  );
  const summary = useMemo(() => boardSummary(list.items), [list.items]);

  const single = useTeamBoardItem(workspaceId, openId);
  const fromList =
    openId === null
      ? null
      : (list.items.find(item => uuidEq(item.sessionId, openId)) ?? null);
  // 단건 읽기가 더 최근의 답이다. 없으면 목록의 줄을 쓴다.
  const openItem: SharedWorkSession | null = single.data ?? fromList;
  const sheetGone = openId !== null && single.gone && fromList === null;

  // 열린 줄이 보이지 않게 되면(공유가 꺼짐) 시트를 닫고 안내는 목록 위에 둔다.
  useEffect(() => {
    if (!sheetGone) return;
    setGoneNotice(true);
    setOpenId(null);
  }, [sheetGone]);
  useEffect(() => {
    if (openId !== null) setGoneNotice(false);
  }, [openId]);

  const refetchList = list.refetch;
  const refreshControl = useRefreshControl(
    useCallback(() => refetchList(), [refetchList]),
    'team-board-refresh',
  );

  const hasData = list.data !== undefined;
  const initialOffline = !online && !hasData;
  const initialFailure = list.isError && !hasData;
  const staleFailure = list.isError && hasData;

  // 시트나 그 뒤의 화면에서 돌아오면 VoiceOver 초점을 눌렀던 줄로 돌려 놓는다. 가려진 동안
  // (다른 층이 위에 있는 동안)에는 하지 않고, 되돌아온 순간에 한다.
  const closeSheet = useCallback(() => setOpenId(null), []);
  useEffect(() => {
    if (!active || openId !== null || lastOpenedRef.current === null) return;
    // 시트가 사라지는 프레임과 겹치지 않게 한 박자 뒤에 한다. `InteractionManager` 는
    // RN 0.86 에서 폐기 경고를 내므로 쓰지 않는다.
    const timer = setTimeout(() => {
      const key = lastOpenedRef.current?.toLowerCase();
      lastOpenedRef.current = null;
      if (key === undefined) return;
      const node = findNodeHandle(rowRefs.current.get(key) ?? null);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    }, FOCUS_RETURN_MS);
    return () => clearTimeout(timer);
  }, [active, openId]);

  const subtitle = TEAM_BOARD_COPY.subtitle;

  return (
    <Screen>
      <ScreenHeader
        title="작업"
        subtitle={subtitle}
        onBack={onBack}
        backLabel="작업 닫기"
        titleTestID="work-title"
      />
      {hasData ? (
        <BoardFilterBar
          filter={filter}
          total={shownAll.length}
          mine={mineCount}
          onChange={setFilter}
        />
      ) : null}

      {!online && hasData ? (
        <NoticeBlock
          headline="오프라인이에요."
          detail="마지막으로 본 목록을 보여 드려요. 연결되면 당겨서 새로고침하세요."
          testID="team-board-offline-cached"
        />
      ) : staleFailure ? (
        <View style={styles.bannerWrap}>
          <FailureBanner
            message="팀 작업을 새로 불러오지 못했어요. 마지막 목록을 보여 드려요."
            onRetry={() => void list.refetch()}
            testID="team-board-stale-error"
          />
        </View>
      ) : null}
      {goneNotice ? (
        <NoticeBlock
          headline={TEAM_BOARD_COPY.goneTitle}
          detail={TEAM_BOARD_COPY.goneBody}
          testID="team-board-gone"
        />
      ) : null}

      {initialOffline ? (
        <ErrorState
          headline="오프라인이에요."
          detail={TEAM_BOARD_COPY.offlineEmpty}
          onRetry={() => void list.refetch()}
          testID="team-board-offline-empty"
        />
      ) : list.isPending && !hasData ? (
        <LoadingState label="팀 작업을 불러와요." testID="team-board-loading" />
      ) : initialFailure ? (
        <ErrorState
          headline={TEAM_BOARD_COPY.errorTitle}
          detail={
            queryFailureDetail(list.error) ?? TEAM_BOARD_COPY.errorBody
          }
          onRetry={() => void list.refetch()}
          testID="team-board-error"
        />
      ) : sections.length === 0 ? (
        <EmptyState
          headline={
            filter === 'mine'
              ? TEAM_BOARD_COPY.emptyMineTitle
              : TEAM_BOARD_COPY.emptyTitle
          }
          detail={
            filter === 'mine'
              ? TEAM_BOARD_COPY.emptyMineBody
              : TEAM_BOARD_COPY.emptyBody
          }
          refreshControl={refreshControl}
          testID="team-board-empty"
        />
      ) : (
        <SectionList
          sections={sections.map(section => ({...section, data: section.items}))}
          keyExtractor={item => item.sessionId.toLowerCase()}
          stickySectionHeadersEnabled={false}
          // 보드는 수십 줄이다. 첫 화면을 한 번에 세운다(구간 머리도 칸으로 센다).
          initialNumToRender={24}
          ListHeaderComponent={
            filter === 'all' ? (
              <Text style={styles.summary} testID="team-board-summary">
                {summary.sentence}
              </Text>
            ) : null
          }
          renderSectionHeader={({section}) => (
            <SectionLabel
              label={`${section.label} ${section.items.length}`}
            />
          )}
          renderItem={({item}) => (
            <BoardRow
              item={item}
              nowMs={nowMs}
              rowRef={node => {
                const key = item.sessionId.toLowerCase();
                if (node === null) rowRefs.current.delete(key);
                else rowRefs.current.set(key, node);
              }}
              onPress={() => {
                lastOpenedRef.current = item.sessionId;
                setOpenId(item.sessionId);
              }}
            />
          )}
          ListFooterComponent={
            list.hasNextPage ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={TEAM_BOARD_COPY.loadMore}
                disabled={list.isFetchingNextPage}
                onPress={() => void list.fetchNextPage()}
                style={({pressed}) => [styles.more, pressed && styles.pressed]}
                testID="team-board-more">
                <Text style={styles.moreLabel}>
                  {list.isFetchingNextPage
                    ? TEAM_BOARD_COPY.loadingMore
                    : TEAM_BOARD_COPY.loadMore}
                </Text>
              </Pressable>
            ) : null
          }
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          testID="team-board-list"
        />
      )}

      {openId !== null && openItem !== null ? (
        <TeamBoardDetailSheet
          item={openItem}
          nowMs={nowMs}
          onClose={closeSheet}
          onOpenChannel={channelId => {
            closeSheet();
            onOpenConversation(channelId, channelLabel(openItem));
          }}
          onOpenAgentSession={
            onOpenAgentSession !== undefined && uuidEq(openItem.owner.memberId, member.id)
              ? sessionId => {
                  closeSheet();
                  onOpenAgentSession(sessionId);
                }
              : undefined
          }
        />
      ) : null}
    </Screen>
  );
}

function BoardFilterBar({
  filter,
  total,
  mine,
  onChange,
}: {
  filter: BoardFilter;
  total: number;
  mine: number;
  onChange: (filter: BoardFilter) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View accessibilityRole="tablist" style={styles.filters}>
      {(
        [
          ['all', `${TEAM_BOARD_COPY.filterAll} ${total}`],
          ['mine', `${TEAM_BOARD_COPY.filterMine} ${mine}`],
        ] as const
      ).map(([value, label]) => {
        const selected = value === filter;
        return (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{selected}}
            accessibilityLabel={label}
            onPress={() => onChange(value)}
            style={({pressed}) => [
              styles.filter,
              selected && styles.filterSelected,
              pressed && styles.pressed,
            ]}
            testID={`team-board-filter-${value}`}>
            <Text
              style={[
                styles.filterLabel,
                selected && styles.filterLabelSelected,
              ]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function BoardRow({
  item,
  nowMs,
  rowRef,
  onPress,
}: {
  item: SharedWorkSession;
  nowMs: number;
  rowRef: React.Ref<React.ElementRef<typeof Pressable>>;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const where = whereLabel(item);
  const whereText = [where.primary, where.secondary]
    .filter((part): part is string => part !== null)
    .join(' / ');
  const activity = relativeLabel(item.lastActivityAt * 1000, nowMs);
  const channel = channelLabel(item);
  return (
    <TapRow
      rowRef={rowRef}
      onPress={onPress}
      accessibilityLabel={[
        sessionTitle(item),
        item.state === 'waiting' ? '응답 필요' : '',
        `${item.owner.displayName}`,
        whereText,
        channel,
        activity,
      ]
        .filter(part => part !== '')
        .join(', ')}
      testID={`team-board-row-${item.sessionId}`}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {sessionTitle(item)}
        </Text>
        <View style={styles.chipLine}>
          <StateChip item={item} testID={`team-board-state-${item.sessionId}`} />
          <LaneLabel item={item} />
        </View>
        {whereText !== '' ? (
          <Text style={styles.rowMono} numberOfLines={1}>
            {whereText}
          </Text>
        ) : null}
        <View style={styles.metaLine}>
          <Text style={styles.rowMeta} numberOfLines={1}>
            {channel} · {activity}
          </Text>
          <DiffNumbers item={item} />
        </View>
      </View>
      <Text accessibilityElementsHidden style={styles.chevron}>
        ›
      </Text>
    </TapRow>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    filters: {
      flexDirection: 'row',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    filter: {
      minHeight: TOUCH_TARGET,
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      // 선택되지 않은 필터도 컨트롤 경계다(헤어라인이 아니다). textFaint 는 두 스킴에서
      // 3:1 이상인 line-strong 역할이다.
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    filterSelected: {
      borderColor: color.accent,
      backgroundColor: color.accentSurface,
    },
    filterLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    filterLabelSelected: {color: color.accentText, fontWeight: '700'},
    summary: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.md,
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
    },
    listContent: {paddingBottom: space.lg},
    bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
    rowBody: {flex: 1, gap: space.xs, paddingVertical: space.xs},
    rowTitle: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    chipLine: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: space.sm,
    },
    rowMono: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.text,
      fontVariant: ['tabular-nums'],
    },
    metaLine: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
    rowMeta: {
      flexShrink: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },
    chevron: {
      fontSize: font.heading,
      lineHeight: line.body,
      color: color.textFaint,
      alignSelf: 'center',
    },
    more: {
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      marginHorizontal: SAFE_GUTTER,
      marginTop: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    moreLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
    pressed: {backgroundColor: color.surfacePressed},
  });
