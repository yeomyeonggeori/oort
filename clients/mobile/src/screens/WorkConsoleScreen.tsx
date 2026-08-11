import type {WorkSession} from '@momo/core/lib/api';
import {workSessionContinuityStatus} from '@momo/core/features/work/workSessionModel';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  FlatList,
  InteractionManager,
  Pressable,
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
  TapRow,
} from '../design/atoms';
import {useRefreshControl} from '../design/refresh';
import {
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {useStyles} from '../design/theme';
import {useWorkHosts, useWorkSessions} from '../features/agents/queries';
import {useOnline} from '../features/inbox/useOnline';
import {
  isActiveWorkSession,
  workConsoleSessions,
  workSessionRecentTimeLabel,
  workSessionPresentation,
  type WorkConsoleFilter,
  type WorkSessionPresentation,
} from '../features/work/model';
import {
  WorkLocationBadge,
  WorkStatusBadge,
} from '../features/work/WorkSessionParts';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {queryFailureDetail} from './SidebarScreen';

export default function WorkConsoleScreen({
  active,
  onOpenSession,
}: {
  /** False while this visited tab is hidden; disables its two work-ledger reads. */
  active: boolean;
  onOpenSession: (sessionId: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {workspaceId, member} = useSession();
  const [filter, setFilter] = useState<WorkConsoleFilter>('all');
  const previousActiveRef = useRef(active);
  const lastOpenedSessionIdRef = useRef<string | null>(null);
  const rowRefs = useRef(
    new Map<string, React.ElementRef<typeof Pressable>>(),
  );
  const online = useOnline();
  const sessionsQuery = useWorkSessions(workspaceId, active);
  const hostsQuery = useWorkHosts(workspaceId, active);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);

  const sessions = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const rows = useMemo(
    () => workConsoleSessions(sessions, filter),
    [sessions, filter],
  );
  const activeCount = useMemo(
    () => sessions.filter(isActiveWorkSession).length,
    [sessions],
  );
  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups],
  );

  const refetchSessions = sessionsQuery.refetch;
  const refetchHosts = hostsQuery.refetch;
  const refetchChannels = channelsQuery.refetch;
  const refetchDirectory = directoryQuery.refetch;
  const refreshControl = useRefreshControl(
    useCallback(
      () =>
        Promise.all([
          refetchSessions(),
          refetchHosts(),
          refetchChannels(),
          refetchDirectory(),
        ]),
      [refetchSessions, refetchHosts, refetchChannels, refetchDirectory],
    ),
    'work-refresh',
  );

  const hasCachedSessions = sessionsQuery.data !== undefined;
  const initialOffline = !online && !hasCachedSessions;
  const initialFailure = sessionsQuery.isError && !hasCachedSessions;
  const ancillaryFailed = channelsQuery.isError || directoryQuery.isError;
  const coldDependencyPending =
    online &&
    sessions.length > 0 &&
    ((hostsQuery.data === undefined && hostsQuery.isPending) ||
      (channelsQuery.data === undefined && channelsQuery.isPending) ||
      (directoryQuery.data === undefined && directoryQuery.isPending));

  // The custom reducer keeps the list mounted under detail/conversation. When
  // the detail is popped, return VoiceOver to the row that invoked it rather
  // than leaving focus on a native node that has just disappeared.
  useEffect(() => {
    const returning = active && !previousActiveRef.current;
    previousActiveRef.current = active;
    if (!returning || lastOpenedSessionIdRef.current === null) return;
    const sessionId = lastOpenedSessionIdRef.current.toLowerCase();
    const task = InteractionManager.runAfterInteractions(() => {
      const node = findNodeHandle(rowRefs.current.get(sessionId) ?? null);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    });
    return () => task.cancel();
  }, [active]);

  return (
    <Screen>
      <ScreenHeader
        title="작업 콘솔"
        subtitle="참여 중인 대화 · 최근 작업 최대 200개"
        titleTestID="work-title"
      />
      <WorkFilterBar
        filter={filter}
        total={sessions.length}
        active={activeCount}
        onChange={setFilter}
      />

      {!online && hasCachedSessions ? (
        <NoticeBlock
          headline="오프라인입니다."
          detail="마지막으로 불러온 작업을 유지합니다. 온라인이 되면 당겨서 새로고침하세요."
          testID="work-offline-cached"
        />
      ) : sessionsQuery.isError && hasCachedSessions ? (
        <View style={styles.bannerWrap}>
          <FailureBanner
            message="최신 작업을 불러오지 못했습니다. 마지막으로 불러온 작업을 유지합니다."
            onRetry={() => void sessionsQuery.refetch()}
            testID="work-stale-cached"
          />
        </View>
      ) : sessionsQuery.isFetching && hasCachedSessions ? (
        <NoticeBlock
          headline="작업을 새로 확인하는 중입니다."
          detail="불러온 목록은 그대로 유지합니다."
          testID="work-refetching"
        />
      ) : null}

      {hostsQuery.isError ? (
        <NoticeBlock
          headline="실행 위치 정보를 불러오지 못했습니다."
          detail="확인할 수 없는 작업은 실행 위치를 추측하지 않고 표시합니다."
          testID="work-hosts-error"
        />
      ) : null}
      {ancillaryFailed ? (
        <NoticeBlock
          headline="일부 대화와 담당자 이름을 확인하지 못했습니다."
          detail="확인되지 않은 이름은 식별자 대신 확인 필요로 표시합니다."
          testID="work-names-error"
        />
      ) : null}

      {initialOffline ? (
        <ErrorState
          headline="오프라인이라 작업을 불러올 수 없습니다."
          detail="네트워크에 연결한 뒤 다시 시도하세요."
          onRetry={() => void sessionsQuery.refetch()}
          testID="work-offline-empty"
        />
      ) : (sessionsQuery.isPending && !hasCachedSessions) ||
        coldDependencyPending ? (
        <LoadingState
          label="최근 작업을 불러오는 중입니다."
          testID="work-loading"
        />
      ) : initialFailure ? (
        <ErrorState
          headline="작업을 불러오지 못했습니다."
          detail={
            queryFailureDetail(sessionsQuery.error) ??
            '잠시 뒤에 다시 시도하세요.'
          }
          onRetry={() => void sessionsQuery.refetch()}
          testID="work-error"
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          headline="아직 볼 수 있는 작업이 없습니다."
          detail="참여 중인 대화에서 작업이 시작되면 여기에 표시됩니다."
          refreshControl={refreshControl}
          testID="work-empty"
        />
      ) : rows.length === 0 ? (
        <EmptyState
          headline="진행 중인 작업이 없습니다."
          detail="전체를 선택하면 종료되거나 연결이 끊긴 작업도 볼 수 있습니다."
          refreshControl={refreshControl}
          testID="work-active-empty"
        />
      ) : (
        <FlatList
          data={rows}
          keyExtractor={session => session.id.toLowerCase()}
          renderItem={({item}) => (
            <WorkSessionRow
              session={item}
              presentation={workSessionPresentation(
                item,
                hostsQuery.data,
                channels,
                directoryQuery.directory,
                member.id,
              )}
              hosts={hostsQuery.data}
              rowRef={node => {
                const key = item.id.toLowerCase();
                if (node === null) rowRefs.current.delete(key);
                else rowRefs.current.set(key, node);
              }}
              onPress={() => {
                lastOpenedSessionIdRef.current = item.id;
                onOpenSession(item.id);
              }}
            />
          )}
          contentContainerStyle={styles.listContent}
          refreshControl={refreshControl}
          testID="work-list"
        />
      )}
    </Screen>
  );
}

function WorkFilterBar({
  filter,
  total,
  active,
  onChange,
}: {
  filter: WorkConsoleFilter;
  total: number;
  active: number;
  onChange: (filter: WorkConsoleFilter) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View accessibilityRole="tablist" style={styles.filters}>
      {([
        ['all', `전체 ${total}`],
        ['active', `진행 ${active}`],
      ] as const).map(([value, label]) => {
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
            testID={`work-filter-${value}`}>
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

function WorkSessionRow({
  session,
  presentation,
  hosts,
  rowRef,
  onPress,
}: {
  session: WorkSession;
  presentation: WorkSessionPresentation;
  hosts: Parameters<typeof workSessionContinuityStatus>[1];
  rowRef: React.Ref<React.ElementRef<typeof Pressable>>;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const status = workSessionContinuityStatus(session, hosts);
  const recentTime = workSessionRecentTimeLabel(session);
  return (
    <TapRow
      rowRef={rowRef}
      onPress={onPress}
      accessibilityLabel={[
        presentation.label,
        status.label,
        presentation.location.label,
        `${presentation.hostName} ${presentation.hostState}`,
        presentation.channelName,
        `담당 ${presentation.ownerName}`,
        `도구 ${presentation.tool}`,
        recentTime,
      ].join(', ')}
      testID={`work-row-${session.id}`}>
      <View style={styles.rowBody}>
        <Text style={styles.rowTitle}>{presentation.label}</Text>
        <View style={styles.badgeLine}>
          <WorkStatusBadge status={status} testID={`work-status-${session.id}`} />
          <WorkLocationBadge
            location={presentation.location}
            testID={`work-location-${session.id}`}
          />
        </View>
        <Text style={styles.rowMeta} testID={`work-host-${session.id}`}>
          {presentation.hostName} · {presentation.hostState}
        </Text>
        <Text style={styles.rowMeta}>
          {presentation.channelName} · 담당 {presentation.ownerName}
        </Text>
        <Text style={[styles.rowMeta, styles.numeric]}>
          도구 {presentation.tool} · {recentTime}
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
      // An unselected filter is still a control boundary, not a hairline.
      // textFaint is the palette's >=3:1 line-strong role in both schemes.
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    filterSelected: {
      borderColor: color.accent,
      backgroundColor: color.accentSurface,
    },
    filterLabel: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    filterLabelSelected: {color: color.accentText, fontWeight: '700'},
    listContent: {paddingBottom: space.lg},
    bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
    rowBody: {flex: 1, gap: space.xs, paddingVertical: space.xs},
    rowTitle: {
      fontSize: font.body,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    badgeLine: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
    rowMeta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    numeric: {fontVariant: ['tabular-nums']},
    chevron: {
      fontSize: font.heading,
      lineHeight: line.body,
      color: color.textFaint,
      alignSelf: 'center',
    },
    pressed: {backgroundColor: color.surfacePressed},
  });
