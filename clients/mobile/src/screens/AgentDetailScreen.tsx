import {
  openDirectMessage,
  uuidEq,
  type WorkSession,
} from '@momo/core/lib/api';
import {
  allowedModelsSummary,
  noSessionsDetail,
  pauseActionLabel,
  pauseEffectNotice,
  pauseFailureCopy,
  pauseReceipt,
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
import {sortSessions, workSessionStatus} from '@momo/core/features/work/workSessionModel';
import {attachParticle} from '@momo/core/lib/koreanParticle';
import {channelLabel} from '@momo/core/features/workspace/directory';
import {useMutation} from '@tanstack/react-query';
import React, {useMemo, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Text, View} from 'react-native';
import {
  EmptyState,
  ErrorState,
  FailureBanner,
  LoadingState,
  NoticeBlock,
  Screen,
  ScreenHeader,
  SectionLabel,
} from '../design/atoms';
import {
  color,
  font,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
} from '../design/tokens';
import {
  useAgentProfile,
  useAllowedAgentModels,
  usePauseAgent,
  useWorkHosts,
  useWorkSessions,
} from '../features/agents/queries';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {openDmFailureCopy} from './SidebarScreen';
import type {OpenAgent} from '../nav/state';

// =============================================================================
// 한 에이전트 — 재우기·깨우기, 그리고 지금 무슨 일을 하는가.
//
// ## 재우기가 이 배치의 심장이고, 문구는 서버를 읽고 썼다
//
// The sentence under the switch is not a paraphrase of the button. It is the
// measured behaviour of `PUT …/agents/{agent}/pause` on `server-rust`, and it
// lives in `@momo/core/features/agents/agentOps` beside the line numbers that
// prove it. The short version: pause writes ONE column, and only the three
// paths that CREATE a run consult it. A job the gateway has already claimed
// runs to completion.
//
// That sentence used to end "…그대로 끝까지 갑니다", and it was true twice over:
// pause did not reach a running job, AND nothing else could. goal SRV-C2 landed
// `POST …/agent-runs/{run}/cancel`, so only the second half is still true. The
// notice now says what pause does not do and where the person can actually stop
// the run — repackaging pause as a cancel would be the same lie facing the other
// way. 중단 자체는 이 화면이 아니라 **대화**에 있다: 취소되는 것은 실행(run)이고,
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

export default function AgentDetailScreen({
  agent,
  onBack,
  onOpenConversation,
}: {
  agent: OpenAgent;
  onBack: () => void;
  onOpenConversation: (channelId: string, title: string) => void;
}): React.JSX.Element {
  const {workspaceId, member} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const profileQuery = useAgentProfile(workspaceId, agent.memberId);
  const allowedModelsQuery = useAllowedAgentModels(workspaceId, agent.memberId);
  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);
  const pause = usePauseAgent(workspaceId, agent.memberId);

  const [receipt, setReceipt] = useState<string | null>(null);

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

  const openDm = useMutation({
    mutationFn: () => openDirectMessage(workspaceId, agent.memberId),
    onSuccess: opened => {
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
        backLabel="에이전트 목록으로"
        titleTestID="agent-detail-title"
      />

      <ScrollView
        contentContainerStyle={styles.body}
        keyboardShouldPersistTaps="handled"
        testID="agent-detail-scroll">
        {/* ---- 재우기 / 깨우기 ------------------------------------------ */}
        <SectionLabel label="상태" />
        {read.kind === 'pending' ? (
          <LoadingState label="상태를 확인하는 중입니다." testID="agent-state-loading" />
        ) : read.kind === 'forbidden' ? (
          // 권한은 장애가 아니다. 다시 시도 버튼도, 붉은 색도 없다.
          <NoticeBlock
            headline="이 에이전트의 상태는 볼 수 없습니다."
            detail="재우고 깨우는 것은 워크스페이스 관리자나 이 에이전트를 맡은 사람만 할 수 있습니다."
            testID="agent-state-forbidden"
          />
        ) : read.kind === 'failed' ? (
          <ErrorState
            headline="상태를 확인하지 못했습니다."
            detail="지금 자고 있는지 깨어 있는지 알 수 없습니다."
            onRetry={() => {
              void profileQuery.refetch();
            }}
            testID="agent-state-error"
          />
        ) : (
          <PauseControl
            paused={profile?.paused === true}
            busy={pause.isPending}
            onToggle={next => {
              setReceipt(null);
              pause.mutate(next, {
                onSuccess: saved => {
                  setReceipt(pauseReceipt(agent.displayName, saved.paused));
                },
              });
            }}
          />
        )}

        {pause.isError ? (
          <View style={styles.bannerWrap}>
            <FailureBanner
              // `pause.variables` is the state that was being moved TO, so the
              // sentence names the act that failed and not its opposite.
              message={pauseFailureCopy(pause.variables === true, pause.error)}
              // 「다시 시도」가 실제로 다시 시도한다. 이전 판은 `reset()`이라
              // 배너만 사라지고 아무 일도 일어나지 않았다 — 라벨이 하지 않는
              // 일을 약속하고 있었다 (R1 High-3). 재우기는 재시도가 말이 되는
              // 자리다: 실패 원인이 네트워크면 다음 번에 성공하고, 권한이면
              // 같은 문장이 다시 뜬다(그건 정직한 답이다).
              onRetry={
                pause.variables === undefined
                  ? undefined
                  : () => pause.mutate(pause.variables as boolean)
              }
              testID="agent-pause-error"
            />
          </View>
        ) : null}

        {receipt !== null && !pause.isError ? (
          <View style={styles.bannerWrap}>
            <Text style={styles.receipt} testID="agent-pause-receipt">
              {receipt}
            </Text>
          </View>
        ) : null}

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

        <Pressable
          accessibilityRole="button"
          // 「과/와」를 손으로 적으면 "Hermes과의 대화"가 된다. 조사는 항상
          // 유틸이 고른다 (R1 Medium-2 — 이 배치에서 코어에 쌍을 추가했다).
          accessibilityLabel={`${attachParticle(agent.displayName, 'with')}의 대화 열기`}
          onPress={() => openDm.mutate()}
          disabled={openDm.isPending}
          style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
          testID="agent-open-dm">
          <Text style={styles.secondaryLabel}>
            {openDm.isPending ? '대화 여는 중…' : '대화 열기'}
          </Text>
        </Pressable>
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
        <SectionLabel label="있는 채널" />
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
            <Text style={styles.channelList}>
              {placement.present.map(channel => `#${channel.name}`).join('  ')}
            </Text>
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
            detail={noSessionsDetail(runHistoryProvided)}
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
 * The switch, and the sentence that keeps it honest.
 *
 * The sentence is ABOVE the button and always visible, not behind a confirm
 * step. What it describes is reversible in one tap, so a modal would be
 * ceremony; what it must not do is let someone press 재우기 believing the
 * running job dies.
 */
function PauseControl({
  paused,
  busy,
  onToggle,
}: {
  paused: boolean;
  busy: boolean;
  onToggle: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <View style={styles.card}>
      <Text style={styles.stateHeadline} testID="agent-state">
        {paused ? '자고 있습니다' : '깨어 있습니다'}
      </Text>
      <Text style={styles.meta} testID="agent-pause-effect">
        {pauseEffectNotice(paused)}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{busy, disabled: busy}}
        accessibilityLabel={
          paused ? '이 에이전트를 깨우기' : '이 에이전트를 재우기'
        }
        disabled={busy}
        onPress={() => onToggle(!paused)}
        style={({pressed}) => [
          styles.toggle,
          paused && styles.toggleWake,
          pressed && !busy && styles.pressed,
        ]}
        testID="agent-pause-toggle">
        <Text style={[styles.toggleLabel, paused && styles.toggleWakeLabel]}>
          {pauseActionLabel(paused, busy)}
        </Text>
      </Pressable>
    </View>
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
 */
function SessionRow({
  session,
  hosts,
}: {
  session: WorkSession;
  hosts: Parameters<typeof sessionSurvival>[1];
}): React.JSX.Element {
  const status = workSessionStatus(session);
  const survival = sessionSurvival(session, hosts);
  return (
    <View
      style={styles.sessionRow}
      // `accessible` is what MAKES this an element VoiceOver reads: a View with
      // a label but without it is not an accessibility element on iOS, so the
      // assembled sentence below was never spoken (R1 Medium-3).
      accessible
      accessibilityLabel={`${session.label}, ${status.label}, ${survival.tier.label}. ${survival.sentence}`}
      testID={`agent-session-${session.id}`}>
      <View style={styles.sessionHead}>
        <Text style={styles.sessionLabel} numberOfLines={1} ellipsizeMode="tail">
          {session.label}
        </Text>
        <Text
          style={[
            styles.sessionStatus,
            status.key === 'running' && styles.sessionStatusRunning,
          ]}>
          {status.label}
        </Text>
      </View>
      <Text style={styles.meta}>{`${session.tool} · ${survival.tier.label}`}</Text>
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
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <Text style={styles.fieldValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: {paddingBottom: space.xl},
  bannerWrap: {paddingHorizontal: SAFE_GUTTER, paddingBottom: space.sm},
  card: {
    marginHorizontal: SAFE_GUTTER,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    backgroundColor: color.surface,
    gap: space.sm,
  },
  stateHeadline: {fontSize: font.body, color: color.text, fontWeight: '600'},
  meta: {fontSize: font.meta, color: color.textMuted, lineHeight: 18},
  receipt: {fontSize: font.meta, color: color.ok, lineHeight: 18},
  toggle: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    alignItems: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
    alignSelf: 'flex-start',
    paddingHorizontal: space.lg,
  },
  toggleWake: {backgroundColor: color.accent, borderColor: color.accent},
  toggleLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
  toggleWakeLabel: {color: '#ffffff'},
  field: {gap: 2},
  fieldLabel: {fontSize: font.meta, color: color.textFaint},
  fieldValue: {fontSize: font.label, color: color.text, lineHeight: 19},
  channelList: {fontSize: font.label, color: color.text, lineHeight: 20},
  secondary: {
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    marginHorizontal: SAFE_GUTTER,
    marginTop: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: color.border,
    alignSelf: 'flex-start',
  },
  secondaryLabel: {fontSize: font.label, color: color.accentText, fontWeight: '600'},
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
  sessionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  sessionLabel: {fontSize: font.label, color: color.text, fontWeight: '600', flex: 1},
  sessionStatus: {fontSize: font.meta, color: color.textMuted},
  sessionStatusRunning: {color: color.ok, fontWeight: '600'},
  survivalWarn: {color: color.warn},
  footnote: {
    marginHorizontal: SAFE_GUTTER,
    marginTop: space.sm,
    fontSize: font.meta,
    color: color.textFaint,
  },
  pressed: {backgroundColor: color.surfacePressed},
});
