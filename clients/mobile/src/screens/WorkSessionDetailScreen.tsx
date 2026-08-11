import {uuidEq} from '@momo/core/lib/api';
import {
  emptyStepsDetail,
  eventsForSession,
  foldSessionEvents,
  ROW_STATE_LABEL,
  workHostTrust,
  workSessionContinuityStatus,
  type WorkEventRow,
  type WorkPlanItem,
} from '@momo/core/features/work/workSessionModel';
import React, {useCallback, useEffect, useMemo, useRef} from 'react';
import {
  AccessibilityInfo,
  findNodeHandle,
  InteractionManager,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {
  ErrorState,
  FailureBanner,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  SectionLabel,
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
  explicitTimeLabel,
  workSessionPresentation,
} from '../features/work/model';
import {useWorkSessionEvents} from '../features/work/queries';
import {
  WorkLocationBadge,
  WorkStatusBadge,
} from '../features/work/WorkSessionParts';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {queryFailureDetail} from './SidebarScreen';

export default function WorkSessionDetailScreen({
  active,
  sessionId,
  onBack,
  onOpenConversation,
}: {
  /** True only while this pushed surface is the top accessibility layer. */
  active: boolean;
  sessionId: string;
  onBack: () => void;
  onOpenConversation: (channelId: string, title: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const {workspaceId, member} = useSession();
  const online = useOnline();
  const sessionsQuery = useWorkSessions(workspaceId, true);
  const hostsQuery = useWorkHosts(workspaceId, true);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const session =
    sessionsQuery.data?.find(candidate => uuidEq(candidate.id, sessionId)) ?? null;
  const eventsQuery = useWorkSessionEvents(workspaceId, session);

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups],
  );
  const presentation = useMemo(
    () =>
      session === null
        ? null
        : workSessionPresentation(
            session,
            hostsQuery.data,
            channels,
            directoryQuery.directory,
            member.id,
          ),
    [session, hostsQuery.data, channels, directoryQuery.directory, member.id],
  );
  const sessionEvents = useMemo(
    () =>
      session === null
        ? []
        : eventsForSession(eventsQuery.data?.events ?? [], session.id),
    [eventsQuery.data, session],
  );
  const folded = useMemo(
    () =>
      session === null
        ? null
        : foldSessionEvents(
            sessionEvents,
            session,
            eventsQuery.data?.truncated ?? false,
          ),
    [session, sessionEvents, eventsQuery.data?.truncated],
  );

  const refetchSessions = sessionsQuery.refetch;
  const refetchHosts = hostsQuery.refetch;
  const refetchChannels = channelsQuery.refetch;
  const refetchDirectory = directoryQuery.refetch;
  const refetchEvents = eventsQuery.refetch;
  const refreshControl = useRefreshControl(
    useCallback(
      () =>
        Promise.all([
          refetchSessions(),
          refetchHosts(),
          refetchChannels(),
          refetchDirectory(),
          refetchEvents(),
        ]),
      [
        refetchSessions,
        refetchHosts,
        refetchChannels,
        refetchDirectory,
        refetchEvents,
      ],
    ),
    'work-detail-refresh',
  );

  // A pushed native-style surface must take VoiceOver away from the row hidden
  // underneath it. The full title is also repeated here without truncation.
  const focusRef = useRef<React.ElementRef<typeof View>>(null);
  const focusSessionId = session?.id ?? null;
  useEffect(() => {
    if (!active || focusSessionId === null) return;
    const task = InteractionManager.runAfterInteractions(() => {
      const node = findNodeHandle(focusRef.current);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    });
    return () => task.cancel();
  }, [active, focusSessionId]);

  const noSessionData = sessionsQuery.data === undefined;
  const coldDependencyPending =
    online &&
    session !== null &&
    ((hostsQuery.data === undefined && hostsQuery.isPending) ||
      (channelsQuery.data === undefined && channelsQuery.isPending) ||
      (directoryQuery.data === undefined && directoryQuery.isPending));

  if ((!online && noSessionData) || (sessionsQuery.isError && noSessionData)) {
    return (
      <View style={styles.modalRoot}>
        <Screen>
          <ScreenHeader
            title="작업 상세"
            onBack={onBack}
            backLabel="작업 목록으로"
            titleTestID="work-detail-title"
          />
          <ErrorState
            headline={
              !online
                ? '오프라인이라 작업 상세를 불러올 수 없습니다.'
                : '작업 상세를 불러오지 못했습니다.'
            }
            detail={
              !online
                ? '네트워크에 연결한 뒤 다시 시도하세요.'
                : queryFailureDetail(sessionsQuery.error) ??
                  '잠시 뒤에 다시 시도하세요.'
            }
            onRetry={() => void sessionsQuery.refetch()}
            testID="work-detail-error"
          />
        </Screen>
      </View>
    );
  }

  if ((sessionsQuery.isPending && noSessionData) || coldDependencyPending) {
    return (
      <View style={styles.modalRoot}>
        <Screen>
          <ScreenHeader
            title="작업 상세"
            onBack={onBack}
            backLabel="작업 목록으로"
            titleTestID="work-detail-title"
          />
          <LoadingState
            label="작업 상세를 불러오는 중입니다."
            testID="work-detail-loading"
          />
        </Screen>
      </View>
    );
  }

  if (session === null || presentation === null || folded === null) {
    return (
      <View style={styles.modalRoot}>
        <Screen>
          <ScreenHeader
            title="작업 상세"
            onBack={onBack}
            backLabel="작업 목록으로"
            titleTestID="work-detail-title"
          />
          <ErrorState
            headline="이 작업을 찾을 수 없습니다."
            detail="목록으로 돌아가 최신 작업을 다시 확인하세요."
            onRetry={() => void sessionsQuery.refetch()}
            testID="work-detail-missing"
          />
        </Screen>
      </View>
    );
  }

  const status = workSessionContinuityStatus(session, hostsQuery.data);
  const trust = workHostTrust(session, hostsQuery.data);
  const hasCachedEvents = eventsQuery.data !== undefined;

  return (
    <View style={styles.modalRoot}>
      <Screen>
        <ScreenHeader
          title={presentation.label}
          subtitle={status.label}
          onBack={onBack}
          backLabel="작업 목록으로"
          titleTestID="work-detail-title"
        />
        <ScrollView
          contentContainerStyle={[
            styles.scrollBody,
            {paddingBottom: Math.max(insets.bottom, space.lg)},
          ]}
          refreshControl={refreshControl}
          testID="work-detail-scroll">
          <View
            ref={focusRef}
            accessible
            accessibilityRole="header"
            accessibilityLabel={`${presentation.label} 작업 상세`}
            style={styles.detailHeading}
            testID="work-detail-focus">
            <Text style={styles.detailTitle}>{presentation.label}</Text>
            <View style={styles.badgeLine}>
              <WorkStatusBadge status={status} testID="work-detail-status" />
              <WorkLocationBadge
                location={presentation.location}
                testID="work-detail-location"
              />
            </View>
          </View>

          {!online ? (
            <NoticeBlock
              headline="오프라인입니다."
              detail="마지막으로 불러온 상세와 진행 내역을 유지합니다."
              testID="work-detail-offline-cached"
            />
          ) : sessionsQuery.isError ? (
            <View style={styles.bannerWrap}>
              <FailureBanner
                message="최신 작업 상태를 불러오지 못했습니다. 마지막으로 불러온 상태를 유지합니다."
                onRetry={() => void sessionsQuery.refetch()}
                testID="work-detail-session-stale"
              />
            </View>
          ) : null}

          <View style={styles.originWrap}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${presentation.channelName} 발원 대화로 이동`}
              onPress={() =>
                onOpenConversation(session.channelId, presentation.channelName)
              }
              style={({pressed}) => [
                styles.originButton,
                pressed && styles.pressed,
              ]}
              testID="work-detail-origin">
              <Text style={styles.originLabel}>발원 대화로 이동</Text>
              <Text accessibilityElementsHidden style={styles.originArrow}>
                ›
              </Text>
            </Pressable>
          </View>

          <SectionLabel label="작업 정보" />
          <View style={styles.metaBlock} testID="work-detail-meta">
            <MetaRow label="실행 위치" value={presentation.location.label} />
            <MetaRow
              label="호스트"
              value={`${presentation.hostName} · ${presentation.hostState}`}
            />
            <MetaRow label="대화" value={presentation.channelName} />
            <MetaRow label="담당자" value={presentation.ownerName} />
            <MetaRow label="도구" value={presentation.tool} />
            <MetaRow label="시작" value={explicitTimeLabel(session.startedAtMs)} numeric />
            <MetaRow
              label="종료"
              value={
                session.endedAtMs === undefined
                  ? '종료 시각 없음'
                  : explicitTimeLabel(session.endedAtMs)
              }
              numeric={session.endedAtMs !== undefined}
            />
          </View>

          <NoticeBlock
            headline="읽기 전용으로 확인할 수 있습니다."
            detail="이 화면은 작업 상태와 진행 요약만 보여 줍니다. 터미널 화면이나 입력 내용, 실행 경로와 환경 정보는 표시하거나 기기에 저장하지 않습니다."
            testID="work-detail-readonly"
          />

          {trust !== 'local' ? (
            <NoticeBlock
              headline="진행 내역 중계를 확인하지 못했습니다."
              detail={
                trust === 'remote'
                  ? `원격 호스트에서 ${
                      session.status === 'running'
                        ? '실행 중인'
                        : session.status === 'idle'
                          ? '대기 중인'
                          : '실행된'
                    } 세션입니다. 진행 내역 중계는 아직 검증되지 않았으므로, 아래 단계 목록에는 세션 원장에 남은 것만 나옵니다.`
                  : '이 세션의 호스트를 확인하지 못했습니다. 아래 진행 내역이 모두 도착했는지 보장할 수 없습니다.'
              }
              testID="work-detail-host-unverified"
            />
          ) : null}

          {folded.plan.length > 0 ? (
            <PlanBlock plan={folded.plan} />
          ) : null}

          <SectionLabel label="진행 내역" />
          {eventsQuery.data?.truncated ? (
            <NoticeBlock
              headline="진행 내역이 길어 최대 1,000개 이벤트만 표시합니다."
              detail="이후 단계는 이 화면에 표시되지 않을 수 있습니다."
              testID="work-detail-truncated"
            />
          ) : null}
          {!online && hasCachedEvents ? null : eventsQuery.isError && hasCachedEvents ? (
            <View style={styles.bannerWrap}>
              <FailureBanner
                message="최신 진행 내역을 불러오지 못했습니다. 마지막으로 불러온 내역을 유지합니다."
                onRetry={() => void eventsQuery.refetch()}
                testID="work-detail-events-stale"
              />
            </View>
          ) : eventsQuery.isFetching && hasCachedEvents ? (
            <NoticeBlock
              headline="진행 내역을 새로 확인하는 중입니다."
              detail="불러온 내역은 그대로 유지합니다."
              testID="work-detail-events-refetching"
            />
          ) : null}

          {!online && !hasCachedEvents ? (
            <ErrorState
              headline="오프라인이라 진행 내역을 불러올 수 없습니다."
              detail="작업 정보는 유지됩니다. 온라인이 되면 당겨서 새로고침하세요."
              testID="work-detail-events-offline"
            />
          ) : eventsQuery.isPending && !hasCachedEvents ? (
            <LoadingState
              label="진행 내역을 불러오는 중입니다."
              testID="work-detail-events-loading"
            />
          ) : eventsQuery.isError && !hasCachedEvents ? (
            <ErrorState
              headline="진행 내역을 불러오지 못했습니다."
              detail={
                queryFailureDetail(eventsQuery.error) ??
                '작업 정보는 유지됩니다. 다시 시도하세요.'
              }
              onRetry={() => void eventsQuery.refetch()}
              testID="work-detail-events-error"
            />
          ) : folded.rows.length === 0 ? (
            trust === 'local' ? (
              <View style={styles.emptySteps} testID="work-detail-events-empty">
                <Text style={styles.emptyHeadline}>아직 진행 내역이 없습니다.</Text>
                <Text style={styles.emptyDetail}>
                  {emptyStepsDetail(session, hostsQuery.data)}
                </Text>
              </View>
            ) : null
          ) : (
            <View style={styles.eventList} testID="work-detail-event-list">
              {folded.rows.map(row => (
                <EventRow key={row.id} row={row} />
              ))}
            </View>
          )}
        </ScrollView>
      </Screen>
    </View>
  );
}

function MetaRow({
  label,
  value,
  numeric = false,
}: {
  label: string;
  value: string;
  numeric?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.metaRow}>
      <Text style={styles.metaLabel}>{label}</Text>
      <Text style={[styles.metaValue, numeric && styles.numeric]}>{value}</Text>
    </View>
  );
}

function PlanBlock({plan}: {plan: readonly WorkPlanItem[]}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.planBlock} testID="work-detail-plan">
      <SectionLabel label="계획" />
      {plan.map((item, index) => {
        const label =
          item.status === 'completed'
            ? '완료'
            : item.status === 'in_progress'
              ? '진행 중'
              : '대기';
        return (
          <View
            key={`${index}-${item.content}`}
            style={styles.planRow}
            testID="work-detail-plan-row">
            <Text style={styles.planState}>{label}</Text>
            <Text style={styles.planContent}>{item.content}</Text>
          </View>
        );
      })}
    </View>
  );
}

function EventRow({row}: {row: WorkEventRow}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessible
      accessibilityLabel={[
        explicitTimeLabel(row.atMs),
        row.headline,
        row.detail && row.detail !== row.headline ? row.detail : null,
        ROW_STATE_LABEL[row.state],
      ]
        .filter(Boolean)
        .join(', ')}
      style={styles.eventRow}
      testID="work-detail-event-row">
      <Text style={[styles.eventTime, styles.numeric]}>
        {explicitTimeLabel(row.atMs)}
      </Text>
      <View style={styles.eventBody}>
        <Text style={styles.eventHeadline}>{row.headline}</Text>
        {row.detail && row.detail !== row.headline ? (
          <Text style={styles.eventDetail}>{row.detail}</Text>
        ) : null}
      </View>
      {row.kind === 'message' || row.kind === 'note' ? null : (
        <Text style={styles.eventState}>{ROW_STATE_LABEL[row.state]}</Text>
      )}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    modalRoot: {flex: 1, backgroundColor: color.bg},
    scrollBody: {paddingBottom: space.lg},
    detailHeading: {
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.lg,
      gap: space.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    detailTitle: {
      fontSize: font.heading,
      lineHeight: line.body,
      color: color.text,
      fontWeight: '600',
    },
    badgeLine: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
    bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.sm},
    originWrap: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.md},
    originButton: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      paddingHorizontal: space.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
    },
    originLabel: {
      flex: 1,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.accentText,
      fontWeight: '600',
    },
    originArrow: {
      fontSize: font.heading,
      lineHeight: line.body,
      color: color.accentText,
    },
    pressed: {backgroundColor: color.surfacePressed},
    metaBlock: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    metaRow: {gap: space.xs},
    metaLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textFaint,
      fontWeight: '600',
    },
    metaValue: {fontSize: font.label, lineHeight: line.label, color: color.text},
    numeric: {fontVariant: ['tabular-nums']},
    planBlock: {paddingBottom: space.sm},
    planRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.xs,
    },
    planState: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '600',
    },
    planContent: {
      flex: 1,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
    emptySteps: {paddingHorizontal: SAFE_GUTTER, paddingVertical: space.lg, gap: space.sm},
    emptyHeadline: {fontSize: font.body, lineHeight: line.body, color: color.text, fontWeight: '600'},
    emptyDetail: {fontSize: font.label, lineHeight: line.label, color: color.textMuted},
    eventList: {
      marginHorizontal: SAFE_GUTTER,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: color.border,
      overflow: 'hidden',
    },
    eventRow: {
      minHeight: TOUCH_TARGET,
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      gap: space.xs,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
      backgroundColor: color.surface,
    },
    eventTime: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    eventBody: {gap: space.xs},
    eventHeadline: {fontSize: font.label, lineHeight: line.label, color: color.text},
    eventDetail: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    eventState: {
      alignSelf: 'flex-start',
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '600',
    },
  });
