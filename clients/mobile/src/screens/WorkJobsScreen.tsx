import {haptics} from '../lib/haptics';
import type {SharedWorkSession} from '@momo/core/lib/api';
import {uuidEq} from '@momo/core/lib/api';
import {
  channelLabel,
  isRunItem,
} from '@momo/core/features/workbench/teamBoard';
import {
  WORK_JOBS_COPY,
  inProgressCount,
  inProgressLabel,
  itemsForFilter,
  reportedSummary,
  requesterToAgent,
  workJobRow,
  workJobSections,
  type WorkFilter,
  type WorkJobRow,
} from '@momo/core/features/workbench/workJobs';
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
import {PULL_FILL, usePullRefresh} from '../design/refresh';
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
import {ReportedTag} from '../features/work/jobs/WorkJobParts';
import {useWorkFilter, useWorkJobsList} from '../features/work/jobs/useWorkJobs';
import {TeamBoardDetailSheet} from '../features/work/teamBoard/TeamBoardDetailSheet';
import {StateChip} from '../features/work/teamBoard/TeamBoardParts';
import {
  useBoardForegroundRefresh,
  useTeamBoardItem,
  useTeamBoardRail,
} from '../features/work/teamBoard/useTeamBoard';
import {useSession} from '../session/useSession';
import {queryFailureDetail} from './SidebarScreen';

// =============================================================================
// 폰 「작업」 — 결과 중심 한 열 (ADR-0202 D1·D2·D6, U1 #3842, 웹 `WorkJobsRoute`의 짝).
//
// 줄 하나 = 맡긴 일 하나. 줄이 말하는 것은 결과다: 누가 어느 에이전트에게 맡겼나, 상태, 결과
// (PR·에이전트 보고), 걸린 시간, 채널. 진행(단계)은 줄을 열면 읽기 전용 시트에서만 본다.
// 「내 것 / 팀 전체」는 서버에 묻는 보기다(`who`). 기본은 「내 것」이고 기기에 기억한다.
// 이 화면에는 승인 단추가 없다: 승인 대기 줄은 카드가 있는 채널로 간다(D5).
// =============================================================================

const MINUTE_MS = 60_000;
const FOCUS_RETURN_MS = 60;

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

export default function WorkJobsScreen({
  active,
  onOpenConversation,
  onOpenAgentSession,
  onBack,
  initialFilter,
}: {
  /** False while this visited layer is hidden; disables its reads, signals and clock. */
  active: boolean;
  onOpenConversation: (channelId: string, title: string) => void;
  /** 내가 시킨 에이전트 세션의 기존 화면(허락 서명 컨트롤이 있는 곳)으로 이동한다. */
  onOpenAgentSession?: (sessionId: string) => void;
  onBack?: () => void;
  /** 캡처 하네스가 고르는 처음 필터. 앱은 기기 기억 → 「내 것」을 쓴다. */
  initialFilter?: WorkFilter;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {workspaceId, member} = useSession();
  const online = useOnline();
  const nowMs = useActiveMinuteNow(active);
  const [filter, setFilter] = useWorkFilter(initialFilter);
  const [openId, setOpenId] = useState<string | null>(null);
  const [goneNotice, setGoneNotice] = useState(false);
  const lastOpenedRef = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, React.ElementRef<typeof Pressable>>());

  const list = useWorkJobsList(workspaceId, filter, active);
  useTeamBoardRail(workspaceId, list.items, active);
  useBoardForegroundRefresh(workspaceId, active);

  const rows = useMemo<WorkJobRow[]>(
    () =>
      itemsForFilter(list.items, filter, member.id, list.mode).map(item =>
        workJobRow(item, nowMs),
      ),
    [list.items, list.mode, filter, member.id, nowMs],
  );
  const sections = useMemo(() => workJobSections(rows), [rows]);
  const running = inProgressCount(rows);

  const fromList =
    openId === null
      ? null
      : (list.items.find(item => uuidEq(item.sessionId, openId)) ?? null);
  const single = useTeamBoardItem(
    workspaceId,
    openId,
    fromList === null || !isRunItem(fromList),
  );
  const openItem: SharedWorkSession | null = single.data ?? fromList;
  const sheetGone = openId !== null && single.gone && fromList === null;

  useEffect(() => {
    if (!sheetGone) return;
    setGoneNotice(true);
    setOpenId(null);
  }, [sheetGone]);
  useEffect(() => {
    if (openId !== null) setGoneNotice(false);
  }, [openId]);

  const refetchList = list.refetch;
  // 이 화면에는 이미 지속 실패 배너(`staleFailure`)와 오프라인 고지가 있다: 같은 일을 두 번 말하지 않게, 당김의 실패
  // 안내(`notice`)는 그 둘이 없을 때의 **대체**로만 선다(아래 고지 자리). 필터를 바꾸면(`resetKey`) 다른 목록의 일이다.
  const {refreshControl, scrollProps, notice} = usePullRefresh(
    useCallback(() => refetchList(), [refetchList]),
    'work-jobs-refresh',
    {active, resetKey: filter},
  );

  const hasData = list.data !== undefined;
  const initialOffline = !online && !hasData;
  const initialFailure = list.isError && !hasData;
  const staleFailure = list.isError && hasData;

  const closeSheet = useCallback(() => setOpenId(null), []);
  useEffect(() => {
    if (!active || openId !== null || lastOpenedRef.current === null) return;
    const timer = setTimeout(() => {
      const key = lastOpenedRef.current?.toLowerCase();
      lastOpenedRef.current = null;
      if (key === undefined) return;
      const node = findNodeHandle(rowRefs.current.get(key) ?? null);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    }, FOCUS_RETURN_MS);
    return () => clearTimeout(timer);
  }, [active, openId]);

  return (
    <Screen>
      <ScreenHeader
        title={WORK_JOBS_COPY.title}
        subtitle={hasData ? inProgressLabel(running, list.hasNextPage) : undefined}
        onBack={onBack}
        backLabel="작업 닫기"
        titleTestID="work-title"
      />
      <FilterBar filter={filter} onChange={setFilter} />

      {!online && hasData ? (
        <NoticeBlock
          headline="오프라인이에요."
          detail="마지막으로 본 목록을 보여 드려요. 연결되면 당겨서 새로고침하세요."
          testID="work-jobs-offline-cached"
        />
      ) : staleFailure ? (
        <View style={styles.bannerWrap}>
          <FailureBanner
            message={WORK_JOBS_COPY.staleError}
            onRetry={() => void list.refetch()}
            testID="work-jobs-stale-error"
          />
        </View>
      ) : (
        notice
      )}
      {hasData && list.mode === 'legacy' ? (
        <NoticeBlock headline={WORK_JOBS_COPY.legacyNotice} testID="work-jobs-legacy" />
      ) : null}
      {goneNotice ? (
        <NoticeBlock
          headline="이 작업은 더 이상 보이지 않아요"
          detail="공유가 꺼졌거나 이 채널의 멤버가 아니에요."
          testID="work-jobs-gone"
        />
      ) : null}

      {initialOffline ? (
        <ErrorState
          headline="오프라인이에요."
          detail={WORK_JOBS_COPY.offlineEmpty}
          onRetry={() => void list.refetch()}
          testID="work-jobs-offline-empty"
        />
      ) : list.isPending && !hasData ? (
        <LoadingState label="작업을 불러와요." testID="work-jobs-loading" />
      ) : initialFailure ? (
        <ErrorState
          headline={WORK_JOBS_COPY.errorTitle}
          detail={queryFailureDetail(list.error) ?? WORK_JOBS_COPY.errorBody}
          onRetry={() => void list.refetch()}
          testID="work-jobs-error"
        />
      ) : sections.length === 0 ? (
        <EmptyState
          headline={filter === 'mine' ? WORK_JOBS_COPY.emptyMineTitle : WORK_JOBS_COPY.emptyTeamTitle}
          detail={filter === 'mine' ? WORK_JOBS_COPY.emptyMineBody : WORK_JOBS_COPY.emptyTeamBody}
          refreshControl={refreshControl}
          scrollProps={scrollProps}
          testID="work-jobs-empty"
        />
      ) : (
        <SectionList
          sections={sections.map(section => ({...section, data: section.rows}))}
          keyExtractor={row => row.id.toLowerCase()}
          stickySectionHeadersEnabled={false}
          initialNumToRender={24}
          renderSectionHeader={({section}) => (
            <SectionLabel label={`${section.label} ${section.rows.length}`} />
          )}
          renderItem={({item: row}) => (
            <JobRow
              row={row}
              rowRef={node => {
                const key = row.id.toLowerCase();
                if (node === null) rowRefs.current.delete(key);
                else rowRefs.current.set(key, node);
              }}
              onPress={() => {
                lastOpenedRef.current = row.id;
                setOpenId(row.id);
              }}
            />
          )}
          ListFooterComponent={
            list.hasNextPage ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={WORK_JOBS_COPY.loadMore}
                disabled={list.isFetchingNextPage}
                onPress={() => void list.fetchNextPage()}
                style={({pressed}) => [styles.more, pressed && styles.pressed]}
                testID="work-jobs-more">
                <Text style={styles.moreLabel}>
                  {list.isFetchingNextPage ? WORK_JOBS_COPY.loadingMore : WORK_JOBS_COPY.loadMore}
                </Text>
              </Pressable>
            ) : null
          }
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          {...scrollProps}
          testID="work-jobs-list"
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

function FilterBar({
  filter,
  onChange,
}: {
  filter: WorkFilter;
  onChange: (filter: WorkFilter) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={WORK_JOBS_COPY.filterGroup}
      style={styles.filters}>
      {(
        [
          ['mine', WORK_JOBS_COPY.filterMine],
          ['team', WORK_JOBS_COPY.filterTeam],
        ] as const
      ).map(([value, label]) => {
        const selected = value === filter;
        return (
          <Pressable
            key={value}
            accessibilityRole="tab"
            accessibilityState={{selected}}
            accessibilityLabel={label}
            onPress={() => { if (!selected) haptics.event('filterChanged'); onChange(value); }}
            style={({pressed}) => [
              styles.filter,
              selected && styles.filterSelected,
              pressed && styles.pressed,
            ]}
            testID={`work-jobs-filter-${value}`}>
            <Text style={[styles.filterLabel, selected && styles.filterLabelSelected]}>
              {label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function JobRow({
  row,
  rowRef,
  onPress,
}: {
  row: WorkJobRow;
  rowRef: React.Ref<React.ElementRef<typeof Pressable>>;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const reported = reportedSummary(row.reported);
  const who = requesterToAgent(row);
  const result =
    reported ??
    row.pr?.number ??
    (row.finished ? WORK_JOBS_COPY.noResultReported : WORK_JOBS_COPY.noResultYet);
  const meta = [row.durationText, row.channel].filter(
    (part): part is string => part !== null && part !== '',
  );
  return (
    <TapRow
      rowRef={rowRef}
      onPress={onPress}
      accessibilityLabel={[
        row.title,
        row.statusLabel,
        who,
        reported !== null ? `${WORK_JOBS_COPY.reportedTag}, ${reported}` : result,
        ...meta,
        row.awaitingApproval ? WORK_JOBS_COPY.approvalHint : null,
      ]
        .filter((part): part is string => part !== null && part !== '')
        .join(', ')}
      testID={`work-job-row-${row.id}`}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle} numberOfLines={2}>
          {row.title}
        </Text>
        <Text
          style={[styles.rowWho, row.agentIsMember && styles.rowWhoAgent]}
          numberOfLines={1}
          testID={`work-job-who-${row.id}`}>
          {who}
        </Text>
        {/* 상태 칩 줄은 서버가 본 사실만. 에이전트가 스스로 알린 말은 꼬리표와 한 덩어리로
            아래 줄에 선다(design-review H-1, 웹 결과 칸과 같은 묶음). */}
        <View style={styles.chipLine}>
          <StateChip item={row.item} testID={`work-job-state-${row.id}`} />
        </View>
        <View style={styles.resultLine}>
          {reported !== null ? <ReportedTag testID={`work-job-reported-tag-${row.id}`} /> : null}
          <Text
            style={[styles.rowResult, reported === null && row.pr === null && styles.rowResultMuted]}
            numberOfLines={2}
            testID={`work-job-result-${row.id}`}>
            {result}
          </Text>
        </View>
        {row.awaitingApproval ? (
          <Text style={styles.rowApproval} testID={`work-job-approval-${row.id}`}>
            {WORK_JOBS_COPY.approvalHint}
          </Text>
        ) : null}
        <Text style={styles.rowMeta} numberOfLines={1}>
          {meta.join(' · ')}
        </Text>
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
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    filterSelected: {borderColor: color.accent, backgroundColor: color.accentSurface},
    filterLabel: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    filterLabelSelected: {color: color.accentText, fontWeight: '700'},
    listContent: {paddingBottom: space.lg, ...PULL_FILL},
    bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
    rowBody: {flex: 1, gap: space.xs, paddingVertical: space.xs},
    rowTitle: {fontSize: font.body, lineHeight: line.body, color: color.text, fontWeight: '600'},
    rowWho: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    rowWhoAgent: {color: color.agent},
    chipLine: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
    resultLine: {flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space.sm},
    rowResult: {flexShrink: 1, fontSize: font.label, lineHeight: line.label, color: color.text},
    rowResultMuted: {color: color.textMuted},
    rowApproval: {fontSize: font.meta, lineHeight: line.meta, color: color.text, fontWeight: '600'},
    rowMeta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
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
