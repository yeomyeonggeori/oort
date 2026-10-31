import {AgentUsageStatus} from '../features/agents/AgentUsage';
import {
  openDirectMessage,
  uuidEq,
  type WorkSession,
} from '@momo/core/lib/api';
import {
  allowedModelsSummary,
  noSessionsDetail,
  sessionsForAgent,
  sessionSurvival,
  TERMINAL_ON_DESKTOP,
  type AgentProfileRead,
} from '@momo/core/features/agents/agentOps';
import {
  effectiveEffortLabel,
  effectiveModelLabel,
} from '@momo/core/features/agents/hubModel';
import {channelPlacement} from '@momo/core/features/agents/channelPlacement';
import {isSurfaceProvided} from '@momo/core/features/capabilities/serverSurfaces';
import {
  sortSessions,
  workSessionContinuityStatus,
} from '@momo/core/features/work/workSessionModel';
import {workExecutionLocation} from '@momo/core/features/work/workLocation';
import {attachParticle, attachRecipient} from '@momo/core/lib/koreanParticle';
import {channelLabel} from '@momo/core/features/workspace/directory';
import {useMutation} from '@tanstack/react-query';
import React, {useMemo} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  ErrorState,
  FailureBanner,
  LoadingState,
  OutlineButton,
  PrimaryButton,
  Screen,
  ScreenHeader,
  SectionLabel,
} from '../design/atoms';
import {font, radius, SAFE_GUTTER, space, type Palette} from '../design/tokens';
import {useStyles} from '../design/theme';
import {AgentLivenessLabel} from '../features/agents/AgentLivenessLabel';
import {ChannelTags} from '../features/agents/channelTags';
import {Avatar} from '../features/conversation/Avatar';
import {
  useAgentProfile,
  useAllowedAgentModels,
  useWorkHosts,
  useWorkSessions,
} from '../features/agents/queries';
import {WorkStatusBadge} from '../features/work/WorkSessionParts';
import {
  useChannels,
  useDirectory,
  useRememberOpenedDm,
} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {openDmFailureCopy} from './SidebarScreen';
import type {OpenAgent} from '../nav/state';

// =============================================================================
// 한 에이전트 — 누구인지, 어느 채널에 있는지, 지금 무슨 일을 하는가.
//
// ## 재우기·깨우기는 폰에 없다 (성재 2026-10-16)
//
// 에이전트는 사람처럼 쉬어야 하는 존재가 아니라서 폰에서 재울 이유가 없다는 결정이다.
// 서버의 `PUT …/agents/{agent}/pause` 와 데스크톱·웹의 스위치는 그대로다 — 이 화면만
// 그 문을 두지 않는다. 재워진 에이전트는 목록 줄에서 흐려지고 「일시정지」로 읽힌다
// (`AgentsScreen`). 중단은 이 화면이 아니라 **대화**에 있다: 취소되는 것은 실행(run)이고,
// 이 화면이 나열하는 것은 작업 세션이며, 서버는 그 둘이 함께 끝나지 **않는다**고
// 응답으로 명시한다(`workSessionsTerminated: false`).
//
// ## 호스트 등급 (ADR-0137 D5)
//
// D5 makes the tier mandatory on a session row because one app holds two kinds
// of host and the person's question is "지금 이거 꺼도 되나". The session row
// does not carry it: `WorkSessionDto` has `hostId` and nothing else about the
// machine, so the tier is a join against `GET …/work-hosts`. When that list is
// missing the row says 호스트 확인 안 됨 and refuses to answer the question,
// which is the only honest branch — guessing "계속 됩니다" is how someone shuts
// a laptop on a running job.
//
// ## 터미널은 여기서 열지 않는다
//
// D5 demoted the raw PTY on the phone: reading 80 columns on a 390pt screen is
// the problem, not the transport. There is no attach button here.
// =============================================================================

/** 상세 머리의 얼굴. 기본 아바타(32)보다 한 단 크게 — 이 화면의 주인공이다. */
const AGENT_HEADER_FACE = 40;

export default function AgentDetailScreen({
  agent,
  onBack,
  onOpenConversation,
  onDelegateWork,
}: {
  agent: OpenAgent;
  onBack: () => void;
  onOpenConversation: (channelId: string, title: string) => void;
  /** 「작업 맡기기」 시트를 이 에이전트로 정해 연다 (#3588). 없으면 버튼도 없다. */
  onDelegateWork?: (prefill: {agentMemberId: string}) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {workspaceId, member} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const profileQuery = useAgentProfile(workspaceId, agent.memberId);
  const allowedModelsQuery = useAllowedAgentModels(workspaceId, agent.memberId);
  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);

  const rosterAgent = useMemo(
    () =>
      directoryQuery.directory.members.find(candidate =>
        uuidEq(candidate.id, agent.memberId),
      ),
    [directoryQuery.directory, agent.memberId],
  );

  const read: AgentProfileRead = profileQuery.read;
  const profile = read.kind === 'ready' ? read.profile : null;

  const placement = useMemo(
    () =>
      rosterAgent
        ? channelPlacement(
            rosterAgent,
            channelsQuery.groups.channels,
            channelsQuery.groups.dms,
          )
        : null,
    [rosterAgent, channelsQuery.groups],
  );

  const sessions = useMemo<WorkSession[]>(
    () =>
      sessionsQuery.data === undefined
        ? []
        : sortSessions(sessionsForAgent(sessionsQuery.data, agent.memberId)),
    [sessionsQuery.data, agent.memberId],
  );

  const rememberOpenedDm = useRememberOpenedDm(workspaceId);
  const openDm = useMutation({
    mutationFn: () => openDirectMessage(workspaceId, agent.memberId),
    onSuccess: opened => {
      rememberOpenedDm(opened.channel);
      onOpenConversation(
        opened.channel.id,
        channelLabel(opened.channel, directoryQuery.directory, member.id),
      );
    },
  });

  const runHistoryProvided = isSurfaceProvided('agentRunHistory');

  return (
    <Screen>
      <ScreenHeader
        title={agent.displayName}
        subtitle={`@${agent.handle}`}
        onBack={onBack}
        // 에이전트 목록·DM 목록과 같은 아바타(사진, 없으면 이니셜). 제목이 이름을 말하므로
        // 얼굴은 보조기술에서 숨는다(`Avatar` 가 스스로 숨는다).
        leading={
          <View testID="agent-detail-face">
            <Avatar
              directory={directoryQuery.directory}
              memberId={agent.memberId}
              size={AGENT_HEADER_FACE}
            />
          </View>
        }
        backLabel="에이전트 목록으로"
        titleTestID="agent-detail-title"
      />

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        testID="agent-detail-scroll">
        {/* ---- 지금 살아 있는가 (ADR-0200 D4) ------------------------------ */}
        {/* 「활성」·「깨어 있음」 같은 설정 상태와 다른 사실이다: 서버가 수령·읽기·run
            이벤트·ping으로 지금 파생한 것이고, hosted가 아닌 에이전트에는 서지 않는다. */}
        {/* 가터는 끼우는 자리가 준다(#4982): 라벨은 목록 행 안에서도 쓰이고(`AgentsScreen`) 거기서는 행이 이미 여백을 지므로
            부품이 가터를 가지면 행 안에서 이중 인셋이 된다. 상세의 스크롤(`body`)은 아래 여백뿐이라 여기서 준다. 라벨이 없으면
            (서버가 모르는 에이전트) 빈 그릇은 높이가 0 이다. */}
        <View style={styles.liveness}>
          <AgentLivenessLabel
            agentId={agent.memberId}
            testID="agent-detail-liveness"
          />
        </View>
        <AgentUsageStatus agentId={agent.memberId} />
        {/* ---- 프로필 ---------------------------------------------------- */}
        <SectionLabel label="프로필" />
        <View style={styles.card} testID="agent-profile-card">
          <Field
            label="모델"
            value={
              rosterAgent ? effectiveModelLabel(profile, rosterAgent) : '확인할 수 없음'
            }
            testID="agent-model"
          />
          {/* 추론 강도는 서버가 값을 준 경우에만 나온다.
              `effectiveEffortLabel`의 나머지 두 갈래는 각각 "모델 기본값"과
              "이 서버에는 추론 강도 축이 없음"인데, 둘 중 어느 쪽인지는 routing
              capability 판정만 알고 폰은 그 판정을 아직 배선하지 않았다. 모르는
              것을 둘 중 하나로 골라 적는 대신 줄 자체를 내지 않는다. */}
          {profile?.effortPref !== undefined &&
          profile.effortPref.trim() !== '' ? (
            <Field
              label="추론 강도"
              value={effectiveEffortLabel(profile, true)}
              testID="agent-effort"
            />
          ) : null}
          <Field
            label="고를 수 있는 모델"
            value={
              allowedModelsQuery.isPending
                ? '불러오는 중…'
                : allowedModelsQuery.isError
                  ? '고를 수 있는 모델을 불러오지 못했습니다.'
                  : allowedModelsSummary(allowedModelsQuery.data ?? null)
            }
            testID="agent-allowed-models"
          />
          {profile && profile.instructions.trim() !== '' ? (
            <Field
              label="지시문"
              value={profile.instructions.trim()}
              testID="agent-instructions"
            />
          ) : null}
        </View>

        {/* 주 행동 하나, 보조 하나. 한 줄에 나란히 서고, 큰 글씨에서는 줄이 접혀 각각 한 줄을
            전부 쓴다(`flexBasis` + `flexWrap`). 높이는 둘 다 44pt 이상이다. */}
        <View style={styles.actions} testID="agent-actions">
          <View style={styles.action}>
            <PrimaryButton
              label="대화 열기"
              busyLabel="여는 중"
              busy={openDm.isPending}
              // 「과/와」를 손으로 적으면 "Hermes과의 대화"가 된다. 조사는 항상
              // 유틸이 고른다 (R1 Medium-2 — 이 배치에서 코어에 쌍을 추가했다).
              accessibilityLabel={`${attachParticle(agent.displayName, 'with')}의 대화 열기`}
              onPress={() => openDm.mutate()}
              testID="agent-open-dm"
            />
          </View>
          {onDelegateWork ? (
            <View style={styles.action}>
              <OutlineButton
                label="작업 맡기기"
                accessibilityLabel={`${attachRecipient(agent.displayName, 'person')} 작업 맡기기`}
                onPress={() => onDelegateWork({agentMemberId: agent.memberId})}
                testID="agent-delegate-work"
              />
            </View>
          ) : null}
        </View>
        {openDm.isError ? (
          <View style={styles.bannerWrap}>
            <FailureBanner
              message={openDmFailureCopy(openDm.error)}
              onRetry={() => openDm.mutate()}
              testID="agent-open-dm-error"
            />
          </View>
        ) : null}

        {/* ---- 채널 배치 -------------------------------------------------- */}
        <SectionLabel label="에이전트가 포함된 채널" />
        {placement === null ? (
          <EmptyState
            headline="채널을 확인하지 못했습니다."
            testID="agent-channels-unknown"
          />
        ) : placement.present.length === 0 && placement.unresolved === 0 ? (
          <EmptyState
            headline="아직 어느 채널에도 없습니다."
            detail="채널에 넣기 전까지는 멘션해도 닿지 않습니다. 채널 배치는 데스크톱에서 할 수 있습니다."
            testID="agent-channels-empty"
          />
        ) : (
          <View style={styles.card} testID="agent-channels">
            {placement.present.some(channel => channel.name !== undefined) ? (
              <ChannelTags
                names={placement.present
                  .map(channel => channel.name)
                  .filter((name): name is string => name !== undefined)}
                testID="agent-channel-tags"
              />
            ) : null}
            {placement.unresolved > 0 ? (
              <Text style={styles.meta}>
                {`그 밖에 ${placement.unresolved}곳에 더 있습니다. 여기서는 이름을 확인할 수 없는 곳입니다.`}
              </Text>
            ) : null}
          </View>
        )}

        {/* ---- 지금 무슨 일을 하는가 --------------------------------------- */}
        <SectionLabel label="작업" />
        {sessionsQuery.isPending ? (
          <LoadingState label="작업을 불러오는 중입니다." testID="agent-work-loading" />
        ) : sessionsQuery.isError ? (
          <ErrorState
            headline="작업을 불러오지 못했습니다."
            onRetry={() => {
              void sessionsQuery.refetch();
            }}
            testID="agent-work-error"
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            headline="이 에이전트가 연 작업 세션이 없습니다."
            // 문구 정본은 코어 하나다. 화면이 직접 조립하면 같은 문장의
            // 정본이 둘이 되고, 라우트가 이식되는 날 한쪽만 바뀐다 (R1 Low-3).
            //
            // #1223: 그 「라우트가 이식되는 날」이 왔고, 이 자리에서 드러난 것이
            // 하나 있다 — 코어의 provided=true 문장은 위 headline 과 **같은
            // 문장**이라, 그대로 넘기면 한 화면이 같은 말을 두 번 한다. 덧붙일
            // 말이 없을 때는 덧붙이지 않는다. 문구 정본은 여전히 코어다.
            detail={runHistoryProvided ? undefined : noSessionsDetail(false)}
            testID="agent-work-empty"
          />
        ) : (
          <View testID="agent-work-list">
            {sessions.map(session => (
              <SessionRow
                key={session.id}
                session={session}
                hosts={hostsQuery.data}
              />
            ))}
          </View>
        )}
        <Text style={styles.footnote}>{TERMINAL_ON_DESKTOP}</Text>
      </ScrollView>
    </Screen>
  );
}

/**
 * One work session, with the D5 host tier on it.
 *
 * The tier line is not decoration and is never omitted: an app that holds both a
 * desktop host and an always-on one has to answer "꺼도 되나" per row, and a row
 * with no tier is a row that quietly answers "아마도".
 *
 * But the tier ALONE cannot answer it, which is what R1 High-1 caught: this row
 * used to print the tier's running sentence whatever state the ledger reported,
 * so a session that ended an hour ago warned — in orange — that turning a
 * computer off would stop it. The sentence now comes from `sessionSurvival`,
 * which reads the host AND the session's own state, and `atRisk` (not the tier)
 * decides the colour.
 *
 * ## 수명주기 상태는 이 화면이 색을 고르지 않는다 (#1503)
 *
 * 이 행은 원장 상태를 자기 글자 스타일로 칠했고, 그 표에서 **실행 중이 초록**
 * (`color.ok`)이었다 — 코어 역할표(`SESSION_STATUS_CLASS`)와 폰의 다른 두 표면
 * (`WorkConsoleScreen`·`WorkSessionDetailScreen`)이 쓰는 `WorkStatusBadge` 는 같은
 * 상태를 warn 으로 부른다. 한 원장의 한 상태가 화면에 따라 다른 낱말을 썼다.
 *
 * 어느 쪽이 옳은가는 #1491 이 이미 답했다: **초록은 측정을 보고하는 칩이 진다**
 * (게이트 결과, #1441). 「지금 돌고 있다」는 측정이 아니라 진행이고, 진행에 붙는
 * 색은 warn 이다 — 그리고 그 결정의 정본은 웹/코어 표다(momo-main 위임). 그래서
 * 이 자리가 한 일은 「초록을 warn 으로 고치는 것」이 아니라 **두 번째 표를 지우는
 * 것**이다. 값을 맞추면 다음에 코어가 움직이는 날 다시 갈라지고, 컴포넌트를 지나면
 * 갈라질 표가 없다. 폰의 수명주기 색은 이제 `WorkStatusBadge` 한 곳에서만 나온다.
 *
 * 색과 함께 **상태를 뽑는 함수**도 같은 것으로 맞췄다(design-review High-1). 이 행은
 * `workSessionStatus` 로 원장을 그대로 읽던 유일한 자리였고, 나머지 다섯(폰의
 * `WorkConsoleScreen`·`WorkSessionDetailScreen`, 웹의 `WorkPanel`·`WorkSessionDetail`·
 * `WorkConsoleRoute`)은 전부 `workSessionContinuityStatus` 를 지난다. 그 차이는 색이
 * 아니라 **문장**으로 드러났다: 등록기가 최근 신호를 못 본 호스트의 running 세션을
 * 작업 콘솔은 「호스트 응답 없음」이라 부르는데 이 카드만 「실행 중」이라 부르고,
 * 게다가 그 아래에 「그 컴퓨터를 끄거나 앱을 닫으면 이 작업도 멈춥니다」를 얹었다 —
 * 이미 사라졌을 수도 있는 기계에 대해. 등록기를 못 읽는 경우는 여전히 원장 그대로다
 * (`workHostOnline` 이 그때 `null` 을 답하고 `=== false` 만 상태를 바꾼다): 「못
 * 읽었다」와 「오프라인이다」는 다른 사실이다.
 *
 * 그리고 칩이 **어느 줄에 서는가**도 같은 물음의 일부였다(design-review High-2).
 * 처음 판은 칩을 제목과 한 줄에(`sessionHead`) 뒀는데, 그 줄은 접히지 않고 칩은
 * 줄어들지 않으므로(Yoga 기본 `flexShrink: 0`) 자라는 것은 언제나 칩이고 줄어드는
 * 것은 언제나 `flex: 1` 인 제목이다. 큰 접근성 글자에서 「호스트 연결 끊김」이 세 배로
 * 자라면 제목에 남는 것은 한두 글자다(AX-XXL 캡처에서 제목이 「릴레이 재…」로 줄었다).
 * 두 자매 표면은 이미 답을 갖고 있었다 — 칩은 제목 **아래**의 접히는 줄
 * (`badgeLine`)에 선다. 같은 컴포넌트가 세 표면에서 두 문법으로 서면 그건 공유가
 * 아니라 복제다. 대가는 행 높이이고(칩 줄 하나), 그 대신 제목이 폭을 온전히 갖는다.
 *
 * `export` 는 측정 하네스(`measure/surfaces.tsx`)를 위한 것이다 — 사진이 배송되는
 * 컴포넌트를 찍어야지 하네스가 다시 그린 닮은 것을 찍으면 증거가 아니다. 화면들이
 * `SearchScreen` 의 `ResultRow`·`SearchBody` 에 이미 쓰는 방식 그대로다.
 */
export function SessionRow({
  session,
  hosts,
}: {
  session: WorkSession;
  hosts: Parameters<typeof sessionSurvival>[1];
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const status = workSessionContinuityStatus(session, hosts);
  const survival = sessionSurvival(session, hosts);
  const location = workExecutionLocation(session, hosts);
  return (
    <View
      style={styles.sessionRow}
      // `accessible` is what MAKES this an element VoiceOver reads: a View with
      // a label but without it is not an accessibility element on iOS, so the
      // assembled sentence below was never spoken (R1 Medium-3).
      accessible
      accessibilityLabel={`${session.label}, ${status.label}, ${location.label}. ${survival.sentence}`}
      testID={`agent-session-${session.id}`}>
      <Text style={styles.sessionLabel} numberOfLines={2} ellipsizeMode="tail">
        {session.label}
      </Text>
      <View style={styles.badgeLine}>
        <WorkStatusBadge
          status={status}
          testID={`agent-session-status-${session.id}`}
        />
      </View>
      <Text style={styles.meta}>{`${session.tool} · ${location.label}`}</Text>
      <Text
        style={[styles.meta, survival.atRisk && styles.survivalWarn]}
        testID={`agent-session-tier-${session.id}`}>
        {survival.sentence}
      </Text>
    </View>
  );
}

function Field({
  label,
  value,
  testID,
}: {
  label: string;
  value: string;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  body: {paddingBottom: space.xl},
  bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
  liveness: {paddingHorizontal: SAFE_GUTTER},
  card: {
    marginHorizontal: SAFE_GUTTER,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.sm,
  },
  meta: {fontSize: font.meta, color: color.textMuted, lineHeight: 18},
  field: {gap: 2},
  fieldLabel: {fontSize: font.meta, color: color.textFaint},
  fieldValue: {fontSize: font.label, color: color.text, lineHeight: 19},
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    marginHorizontal: SAFE_GUTTER,
    marginTop: space.md,
  },
  action: {flexGrow: 1, flexBasis: 140},
  sessionRow: {
    marginHorizontal: SAFE_GUTTER,
    marginBottom: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.xs,
  },
  /**
   * 칩이 서는 줄. `WorkConsoleScreen`·`WorkSessionDetailScreen` 의 같은 이름 같은
   * 값이다 — 한 컴포넌트가 세 표면에서 **한 문법**으로 서야 한다(design-review
   * High-2). 접히는 줄인 것이 요점이다: 큰 접근성 글자에서 「호스트 연결 끊김」은
   * 세 배로 자라는데, 제목과 한 줄에 두면 자라는 쪽이 제목을 먹는다(줄이지 않는
   * 것이 Yoga 의 기본이고, 줄어드는 쪽은 언제나 `flex: 1` 인 제목이다).
   */
  badgeLine: {flexDirection: 'row', flexWrap: 'wrap', gap: space.xs},
  sessionLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
  survivalWarn: {color: color.warn},
  footnote: {
    marginHorizontal: SAFE_GUTTER,
    marginTop: space.sm,
    fontSize: font.meta,
    color: color.textFaint,
  },
});
