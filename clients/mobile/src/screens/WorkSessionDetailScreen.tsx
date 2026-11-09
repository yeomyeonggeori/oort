import {uuidEq} from '@momo/core/lib/api';
import {
  emptyStepsDetail,
  eventsForSession,
  foldSessionEvents,
  mergeEvents,
  ROW_STATE_LABEL,
  workHostTrust,
  workSessionContinuityStatus,
  withOpenRequest,
  type WorkEventRow,
  type WorkPlanItem,
} from '@momo/core/features/work/workSessionModel';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  Animated,
  Easing,
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
  OutlineButton,
  Screen,
  ScreenHeader,
  SectionLabel,
} from '../design/atoms';
import {PULL_FILL, usePullRefresh} from '../design/refresh';
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
import {canStopSession} from '@momo/core/features/work/stopWork';
import {pendingPermission} from '@momo/core/features/workbench/agentPane';
import {useFormatMessage} from '../i18n/useFormatMessage';
import {useWorkSessionEvents} from '../features/work/queries';
import {
  StopWorkControl,
  type StopWorkInitial,
} from '../features/work/StopWorkControl';
import {useWorkSessionLive} from '../features/work/useWorkSessionLive';
import {
  computeStreamTiming,
  recordWorkStreamTiming,
} from '../features/work/workStreamTiming';
import {
  SIGNING_REQUIRED_QUERY_KEY,
  SignedWorkControls,
  useSigningFlag,
  useSigningRequired,
} from '../features/work/SignedWorkControls';
import {
  WorkLocationBadge,
  WorkStatusBadge,
} from '../features/work/WorkSessionParts';
import {
  ModeSwitch,
  signingReason,
  WorkConversation,
  type ConversationMode,
} from '../features/work/WorkConversation';
import {useQueryClient} from '@tanstack/react-query';
import {useReduceMotion} from '../lib/useReduceMotion';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {queryFailureDetail} from './SidebarScreen';

/** 처음 보기이자, 권한 요청 알림이 착지할 때 돌아오는 보기(#5593): 승인 카드는 상세 보기 맨 위에 선다. */
const DEFAULT_MODE: ConversationMode = 'detail';

export default function WorkSessionDetailScreen({
  active,
  sessionId,
  onBack,
  onOpenConversation,
  stopInitial,
  initialMode,
  permissionLanding,
}: {
  /** True only while this pushed surface is the top accessibility layer. */
  active: boolean;
  sessionId: string;
  /**
   * 권한 요청 알림으로 열렸을 때만 (#5593, `OpenWorkSession.permission`). 그 요청이 아직 열려 있으면 상세 보기 맨 위의
   * 승인 카드가 착지 자리다(낭독 초점도 카드로). 이미 닫혔으면 그 사실을 한 줄로 말한다 — 카드 없는 화면에 조용히 두지 않는다.
   */
  permissionLanding?: {requestEventId: string; token: number};
  onBack: () => void;
  onOpenConversation: (channelId: string, title: string) => void;
  /** 캡처 하네스 전용 시작 상태. 제품은 넘기지 않는다. */
  stopInitial?: StopWorkInitial;
  /** 캡처 하네스 전용 시작 보기. 제품은 넘기지 않는다(상세로 열린다). */
  initialMode?: ConversationMode;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const formatMessage = useFormatMessage();
  const [mode, setMode] = useState<ConversationMode>(initialMode ?? DEFAULT_MODE);
  // 권한 요청 알림이 새로 착지하면 상세 보기로 돌아온다(#5593): 카드는 상세 보기 맨 위에 선다. 대화 보기에서 다른 일을
  // 보던 중이어도 알림은 새 입구다. 렌더 중에 앞 값과 견준다(효과로 하면 대화 보기가 한 번 그려진 뒤에 바뀐다).
  const landingToken = permissionLanding?.token;
  const [seenLandingToken, setSeenLandingToken] = useState(landingToken);
  if (landingToken !== seenLandingToken) {
    setSeenLandingToken(landingToken);
    if (landingToken !== undefined) setMode(DEFAULT_MODE);
  }
  // 이 착지에서 그 요청이 한 번이라도 열려 있었는가. 열려 있던 요청이 닫힌 것은 사람이 **이 카드에서** 답한 것일 수 있다 —
  // 그 뒤에 「다른 기기에서 답했어요」를 세우면 방금 누른 허락을 남의 일로 말한다. 그래서 「이미 처리됐어요」는 착지한 순간부터
  // 카드가 없을 때만 선다.
  const [landingSeenOpen, setLandingSeenOpen] = useState<number | undefined>(undefined);
  const reduceMotion = useReduceMotion();
  const fade = useRef(new Animated.Value(1)).current;
  const {workspaceId, member} = useSession();
  const online = useOnline();
  const sessionsQuery = useWorkSessions(workspaceId, true);
  const hostsQuery = useWorkHosts(workspaceId, true);
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const session =
    sessionsQuery.data?.find(candidate => uuidEq(candidate.id, sessionId)) ?? null;
  const eventsQuery = useWorkSessionEvents(workspaceId, session);
  const isOwner =
    session !== null && session.memberId.toLowerCase() === member.id.toLowerCase();
  // R2-E8 (#3028): the owner may allow and instruct from here once the server
  // requires device signatures (D-11). Otherwise this stays read-only.
  // 서버의 서명 요구(D-11)를 세 값으로 읽는다(#5593 수리 H1): 요구함일 때만 카드가 서고, 꺼짐·모름·읽는 중이면 카드 자리에 그
  // 이유와 답할 곳이 선다. 같은 질의 키라 카드(`SignedWorkControls`)와 한 번만 묻는다.
  const signing = useSigningRequired(workspaceId, isOwner);
  const signingWhy = signingReason(useSigningFlag(workspaceId, isOwner));
  const queryClient = useQueryClient();
  // 서명 요구 읽기는 5분 동안 캐시된다. 「다시 확인」과 당겨서 새로고침은 그 캐시를 건너 다시 묻는다 — 읽기에 실패해 「모름」에 갇힌
  // 화면이 스스로 풀릴 길이다.
  const recheckSigning = useCallback(
    () =>
      queryClient.refetchQueries({queryKey: SIGNING_REQUIRED_QUERY_KEY(workspaceId)}),
    [queryClient, workspaceId],
  );
  const canStop = session !== null && canStopSession(session, member.id);

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
  // N2 (#3594): 읽은 것(진실) 위에 열려 있는 동안 도착한 꼬리를 얹는다.
  const live = useWorkSessionLive(workspaceId, session, active);
  const sessionEvents = useMemo(
    () =>
      session === null
        ? []
        : eventsForSession(
            mergeEvents(eventsQuery.data?.events ?? [], live.liveEvents),
            session.id,
          ),
    [eventsQuery.data, live.liveEvents, session],
  );
  const timing = useMemo(
    () => (session === null ? null : computeStreamTiming(session, sessionEvents)),
    [session, sessionEvents],
  );
  useEffect(() => {
    if (timing !== null) recordWorkStreamTiming(timing);
  }, [timing]);
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
  // 실패하면 그 한 줄(`notice`)이 두 보기 위에 남는다(#3992). 다른 세션을 비추거나(`resetKey`) 다른 층이 덮으면(`active`) 거둔다.
  const {refreshControl, scrollProps, notice} = usePullRefresh(
    useCallback(
      () =>
        Promise.all([
          refetchSessions(),
          refetchHosts(),
          refetchChannels(),
          refetchDirectory(),
          refetchEvents(),
          recheckSigning(),
        ]),
      [
        refetchSessions,
        refetchHosts,
        refetchChannels,
        refetchDirectory,
        refetchEvents,
        recheckSigning,
      ],
    ),
    'work-detail-refresh',
    {active, resetKey: sessionId},
  );

  // A pushed native-style surface must take VoiceOver away from the row hidden
  // underneath it. The full title is also repeated here without truncation.
  const focusRef = useRef<React.ElementRef<typeof View>>(null);
  const focusSessionId = session?.id ?? null;
  useEffect(() => {
    // 권한 알림으로 왔으면 초점의 주인은 착지 자리다(#5593 수리 M3): 카드의 질문, 아니면 카드를 그릴 수 없는 이유나 이미 닫혔다는
    // 한 줄. 머리가 함께 초점을 청하면, 한 커밋에 둘이 서는 따뜻한 길(캐시가 다 있는 채로 연 화면)에서 부모인 이 효과가 자식의 착지
    // 초점보다 늦게 돌아 머리가 이긴다.
    if (!active || focusSessionId === null || landingToken !== undefined) return;
    const task = InteractionManager.runAfterInteractions(() => {
      const node = findNodeHandle(focusRef.current);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    });
    return () => task.cancel();
  }, [active, focusSessionId, landingToken]);

  // 이미 열려 있던 세션 화면 위로 알림이 와도 착지 자리(맨 위)가 보이게 맨 위로 올린다(#5593 수리 L4).
  const detailScrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    if (landingToken === undefined) return;
    detailScrollRef.current?.scrollTo({y: 0, animated: false});
  }, [landingToken]);

  // 보기 전환: 짧은 페이드 인. 「동작 줄이기」에서는 움직임 없이 바로 바뀐다.
  const changeMode = useCallback(
    (next: ConversationMode) => {
      setMode(next);
      if (reduceMotion) {
        fade.setValue(1);
        return;
      }
      fade.setValue(0);
      Animated.timing(fade, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start();
    },
    [fade, reduceMotion],
  );
  const directory = directoryQuery.directory;
  const nameOf = useCallback(
    (memberId: string) => memberNameParts(directory, memberId, '팀원').name,
    [directory],
  );

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

  // 알림이 가리킨 요청이 지금 열린 그 요청인가(#5593). 열려 있으면 카드가 착지 자리이고, 닫혔으면 한 줄로 말한다 —
  // 「없다」는 진행을 다 읽은 뒤에만 말한다(알림이 진행 읽기를 낡게 했으므로 다시 읽는 동안에는 기다린다).
  const openRequest = pendingPermission(sessionEvents, session);
  // 주인에게 열린 요청이 있으면 머리·배지는 「응답 필요」다(#5593 수리 M2) — 목록 칩과 같은 코어 낱말.
  const status = withOpenRequest(
    workSessionContinuityStatus(session, hostsQuery.data),
    isOwner && openRequest !== null,
  );
  const trust = workHostTrust(session, hostsQuery.data);
  // 열린 요청이 있는데 이 폰이 카드를 그릴 수 없다(#5593 수리 H1): 서버가 서명을 요구하지 않거나(기본값), 그 설정을 읽지 못했거나,
  // 읽는 중이다. 카드 자리에 이유(대화 보기와 같은 문장)와 지금 답할 곳(그 세션의 맥)을 말한다.
  const permissionElsewhere = isOwner && openRequest !== null && !signing && signingWhy !== null;
  const macName = presentation.location.host?.displayName.trim() ?? '';
  const answerWhere =
    macName === ''
      ? formatMessage('mobile.workPermission.elsewhereOnMac')
      : formatMessage('mobile.workPermission.elsewhereOnHost', {host: macName});
  const landingOpen =
    permissionLanding !== undefined &&
    openRequest !== null &&
    uuidEq(openRequest.requestEventId, permissionLanding.requestEventId);
  if (landingOpen && landingSeenOpen !== landingToken) setLandingSeenOpen(landingToken);
  const landingGone =
    permissionLanding !== undefined &&
    !landingOpen &&
    landingSeenOpen !== landingToken &&
    eventsQuery.data !== undefined &&
    !eventsQuery.isFetching;
  const hasCachedEvents = eventsQuery.data !== undefined;
  // 돌고 있는 동안은 재조회 때마다 안내 블록이 나타났다 사라지면 아래 줄이 밀린다.
  const streaming = session.status === 'running';

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
        <ModeSwitch mode={mode} onChange={changeMode} />
        {/* 상세 보기에는 이미 오프라인 고지와 지속 실패 배너가 있다: 같은 일을 두 번 말하지 않는다. */}
        {mode === 'detail' && (!online || sessionsQuery.isError) ? null : notice}
        <Animated.View style={[styles.modeBody, {opacity: fade}]}>
          {/* 두 보기를 함께 마운트해 둔다: 전환해도 쓰던 지시 초안·전송 중 말풍선·스크롤 위치가 남는다. */}
          <View style={mode === 'chat' ? styles.modeBody : styles.modeHidden}>
            <WorkConversation
              workspaceId={workspaceId}
              memberId={member.id}
              session={session}
              events={sessionEvents}
              page={eventsQuery.data}
              online={online}
              agentName={presentation.tool}
              nameOf={nameOf}
              refreshControl={refreshControl}
              scrollProps={scrollProps}
            />
          </View>
          <View style={mode === 'detail' ? styles.modeBody : styles.modeHidden}>
            <ScrollView
              ref={detailScrollRef}
              contentContainerStyle={[
                styles.scrollBody,
                {paddingBottom: Math.max(insets.bottom, space.lg)},
                PULL_FILL,
              ]}
              refreshControl={refreshControl}
              {...scrollProps}
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

              {landingGone ? (
                <LandingFocus token={landingToken}>
                  <NoticeBlock
                    headline={formatMessage('mobile.workPermission.landingGoneTitle')}
                    detail={formatMessage('mobile.workPermission.landingGoneDetail')}
                    testID="work-detail-permission-gone"
                  />
                </LandingFocus>
              ) : null}

              {permissionElsewhere ? (
                <View testID="work-detail-permission-elsewhere">
                  <LandingFocus token={landingOpen ? landingToken : undefined}>
                    <NoticeBlock
                      headline={formatMessage('mobile.workPermission.elsewhereTitle')}
                      detail={
                        signingWhy?.settled === true
                          ? [signingWhy.sentence, answerWhere].join(' ')
                          : signingWhy?.sentence
                      }
                      testID="work-detail-permission-elsewhere-notice"
                    />
                  </LandingFocus>
                  {signingWhy?.retry === true ? (
                    <View style={styles.recheckWrap}>
                      <OutlineButton
                        label={formatMessage('mobile.workPermission.recheck')}
                        onPress={() => void recheckSigning()}
                        testID="work-detail-permission-recheck"
                      />
                    </View>
                  ) : null}
                </View>
              ) : null}

              {isOwner ? (
                <SignedWorkControls
                  workspaceId={workspaceId}
                  memberId={member.id}
                  session={session}
                  events={sessionEvents}
                  online={online}
                  focusToken={landingOpen ? landingToken : undefined}
                />
              ) : null}

              {isOwner ? (
                <StopWorkControl
                  workspaceId={workspaceId}
                  memberId={member.id}
                  session={session}
                  initial={stopInitial}
                />
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
                headline={
                  isOwner && signing
                    ? canStop
                      ? '허락, 지시, 멈추기만 이 화면에서 할 수 있어요.'
                      : '허락과 지시만 이 화면에서 보낼 수 있습니다.'
                    : canStop
                      ? '멈추기만 이 화면에서 할 수 있어요.'
                      : '읽기 전용으로 확인할 수 있습니다.'
                }
                detail={
                  isOwner && signing
                    ? '권한 요청의 미리보기와 보낸 지시는 이 세션 스레드에 남습니다. 터미널 화면, 실행 경로와 환경 정보는 표시하거나 기기에 저장하지 않습니다.'
                    : canStop
                      ? '작업 상태와 진행 요약은 읽기만 해요. 터미널 화면이나 입력 내용, 실행 경로와 환경 정보는 표시하거나 기기에 저장하지 않아요.'
                      : '이 화면은 작업 상태와 진행 요약만 보여 줍니다. 터미널 화면이나 입력 내용, 실행 경로와 환경 정보는 표시하거나 기기에 저장하지 않습니다.'
                }
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
              ) : eventsQuery.isFetching && hasCachedEvents && !streaming ? (
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
                  {folded.rows.map((row, index) => (
                    <EventRow
                      key={row.id}
                      row={row}
                      writing={
                        streaming &&
                        row.kind === 'message' &&
                        index === folded.rows.length - 1
                      }
                    />
                  ))}
                </View>
              )}
            </ScrollView>
          </View>
        </Animated.View>
      </Screen>
    </View>
  );
}

/**
 * 권한 알림 착지의 낭독 초점(#5593 수리 M3) — 카드가 없을 때 그 이유 한 줄(카드를 그릴 수 없음 · 이미 닫힘)이 착지 자리다.
 * 토큰이 바뀔 때마다 한 번 초점을 옮긴다. 상자 하나를 한 낭독 원소로 묶는다(제목과 설명을 함께 읽는다). 카드가 서는 착지는 카드가
 * 스스로 초점을 쥔다(`PermissionCard.focusToken`).
 */
function LandingFocus({
  token,
  children,
}: {
  token: number | undefined;
  children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<React.ElementRef<typeof View>>(null);
  useEffect(() => {
    if (token === undefined) return;
    const task = InteractionManager.runAfterInteractions(() => {
      const node = findNodeHandle(ref.current);
      if (node !== null) AccessibilityInfo.setAccessibilityFocus(node);
    });
    return () => task.cancel();
  }, [token]);
  return (
    <View ref={ref} accessible testID="work-detail-landing-focus">
      {children}
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

function EventRow({
  row,
  writing = false,
}: {
  row: WorkEventRow;
  /** 지금 이어 붙고 있는 마지막 답 줄. 정적인 문구라 「동작 줄이기」와 무관하다. */
  writing?: boolean;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessible
      accessibilityLabel={[
        explicitTimeLabel(row.atMs),
        row.headline,
        row.detail && row.detail !== row.headline ? row.detail : null,
        ROW_STATE_LABEL[row.state],
        writing ? '작성 중' : null,
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
      {writing ? (
        <Text style={styles.eventState} testID="work-detail-writing">
          작성 중
        </Text>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    modalRoot: {flex: 1, backgroundColor: color.bg},
    modeBody: {flex: 1},
    modeHidden: {display: 'none'},
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
    recheckWrap: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
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
