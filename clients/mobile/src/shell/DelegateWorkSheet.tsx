import {createAgentWorkRun, uuidEq, type Channel} from '@momo/core/lib/api';
import {
  normalizeWorkRunInput,
  newWorkRunClientId,
  utf8ByteLength,
  WORK_BRIEF_MAX_BYTES,
  WORK_TITLE_MAX_BYTES,
  workRunFailure,
  WorkRunDraftError,
  type WorkRunDraft,
  type WorkRunField,
  type WorkRunFailure,
} from '@momo/core/features/agents/workRunRequest';
import {useMutation, useQueryClient} from '@tanstack/react-query';
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {
  AccessibilityInfo,
  StyleSheet,
  Text,
  type TextInput,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {
  FailureBanner,
  LoadingState,
  PrimaryButton,
  Sentence,
} from '../design/atoms';
import {PageSheet, usePageSheetClose} from '../design/PageSheet';
import {SheetHeader, type SheetConfirm} from '../design/SheetChrome';
import {ChoiceRow, GroupCard, ListRow, SheetScroll} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {
  font,
  line,
  SAFE_GUTTER,
  SHEET,
  space,
  type Palette,
} from '../design/tokens';
import {
  delegateAgentFor,
  delegateAgents,
  destinationLine,
  FAILURE_ACTION_LABEL,
  failureAction,
  HOSTED_UNKNOWN,
  intentKey,
  nearLimit,
  NO_AGENT_SENTENCE,
  NO_APPROVED_CHANNEL_SENTENCE,
  nextRunId,
  REST_SENTENCE,
  type DelegateAgent,
  type HostedRead,
  type RunIdSlot,
} from '../features/work/delegate/model';
import {
  clearDraft,
  readDraft,
  readLastTarget,
  writeDraft,
  writeLastTarget,
  type DelegateDraft,
} from '../features/work/delegate/session';
import {teamBoardKey} from '../features/work/teamBoard/useTeamBoard';
import {useHostedConnections} from '../features/hostedAgents/queries';
import {useChannels, useDirectory} from '../features/workspace/queries';
import {haptics} from '../lib/haptics';
import {useSession} from '../session/useSession';
import {Field, FieldLabel, SheetNotice, TextArea} from './sheetForm';

// =============================================================================
// 작업 맡기기 — 폰에서 에이전트에게 type=work 요청을 만든다 (#3588 N8, ADR-0198 D4 증보 1).
//
// 시트 하나, 단계 둘이다. 새 탭이 아니다(ADR-0189 D1).
//   A. 맡길 곳 고르기 — 누구에게, 어느 채널에서. 진입점이 정해 준 것은 건너뛴다.
//   B. 내용 쓰기     — 제목·설명(필수), 저장소·브랜치(접힌 「더 보기」, 선택).
//
// ## 이 시트는 문장을 새로 쓰지 않는다
//
// 거절은 코어 `workRunFailure`가 사람 말로 바꾼 문장 그대로다. 시트가 정하는 것은
// 그 문장 옆에 **어떤 버튼이 서는가**뿐이다(`failureAction`): 같은 id로 다시 보내기,
// 새로 맡기기, 다른 곳 고르기, 아니면 버튼 없음. 재시도가 안전하지 않은 거절에
// 「다시 시도」를 달면 같은 거절을 한 번 더 받을 뿐이다.
//
// ## 도착지는 입력 전에 이름으로 보인다
//
// 조용한 대신 보냄이 없어야 한다(ADR-0198 D4). B 단계 맨 위에 「그록봇 · #개발
// 채널로 보내요」가 항상 서고, 처음에는 아무것도 미리 고르지 않는다(마지막에 쓴
// 곳은 A에서 미리 찍히되 사람이 「다음」을 눌러야 한다).
//
// ## 입력은 이 앱 실행 안의 메모리에서만 남는다 (owner 결정)
//
// `features/work/delegate/session.ts`. 디스크에는 마지막에 쓴 에이전트·채널 id뿐이다.
//
// ## 공용 시트로 (#4458)
//
// 머리는 `SheetHeader`: **오른쪽 원형 X = 닫기**, 그리고 **B 단계에만 왼쪽 ✓ = 「맡기기」**(보낼 수 없는 동안 회색·눌리지 않음).
// ✓ 는 **마지막 확정에만** 쓴다 — 중간 단계인 A 의 「다음」은 머리가 아니라 **시트 아래의 기본 단추**(`PrimaryButton`)다
// (2026-10-26 planner 결정: 1단계가 ✓ 의 뜻을 「다음」까지 넓혔던 것을 되돌렸다). 옛 오른쪽 글자 단추(「다음」「맡기기」)와 글자
// 「더 보기」·외곽선 「바꾸기」 단추는 없다. 몸은 `SheetScroll` 의 묶음 카드다: 누구에게·어느 채널은 라벨 + 라디오 행
// (`ChoiceRow`), 「보낼 곳」은 카드(「바꾸기」는 그 카드의 **행**), 제목·저장소·브랜치는 입력 알약, 설명은 여러 줄 입력 상자,
// 「저장소·브랜치」는 펼침 행(`expanded` 상태를 보조기술에 말한다)이다. 입력이 넷까지 서고 두 단계라 규칙상 페이지 후보다
// (`phone-sheets.md` §1·§5) — 이 이슈는 시트로 둔 채 머리·부품만 옮겼고 페이지 전환은 별도 이슈(#4611)다.
// =============================================================================

type Step = 'A' | 'B';

export interface DelegatePrefill {
  /** 있으면 에이전트가 정해진 채로 열린다(에이전트 상세·DM 머리). */
  agentMemberId?: string;
  /** 있으면 도착지 채널까지 정해진다(DM 머리). 승인 목록으로 거르지 않는다. */
  channelId?: string;
}

/**
 * 시작 모양. **캡처 하네스 전용**이다(`measure/surfaces.tsx`의 `shell-delegate-*`): 시뮬레이터
 * 에서 손으로 타자를 쳐서 만들 수 없는 판(오류 배너 등)을 한 장에 세운다. 앱은 쓰지 않는다
 * (`Shell`의 `initialNav`와 같은 사정).
 */
export interface DelegatePreview {
  step?: Step;
  pick?: {agentMemberId: string; channelId: string};
  draft?: Partial<DelegateDraft>;
  refusal?: {failure: WorkRunFailure; agentId: string; channelId: string};
}

export function DelegateWorkSheet({
  prefill,
  boardAvailable,
  onClose,
  onSubmitted,
  preview,
}: {
  prefill: DelegatePrefill;
  preview?: DelegatePreview;
  /**
   * 작업 보드(작업 콘솔)가 이 서버·워크스페이스에서 서 있는가. 서 있으면 접수 직후 시트가
   * 내려가며 셸이 보드로 데려간다. 없으면 갈 곳이 없으니 시트 안에 접수 사실을 남긴다.
   */
  boardAvailable: boolean;
  onClose: () => void;
  /** 접수된 직후, 시트가 내려가기 전. 셸이 작업 보드로 데려간다. */
  onSubmitted: () => void;
}): React.JSX.Element {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel="작업 맡기기"
      scrimLabel="작업 맡기기 닫기"
      testID="delegate-sheet"
    >
      <SheetBody
        prefill={prefill}
        preview={preview}
        boardAvailable={boardAvailable}
        onClose={onClose}
        onSubmitted={onSubmitted}
      />
    </PageSheet>
  );
}

interface Refusal {
  failure: WorkRunFailure;
  agentId: string;
  channelId: string;
}

function pairKey(agent: string, channel: string): string {
  return `${agent.toLowerCase()}|${channel.toLowerCase()}`;
}

/**
 * 서버가 닫은 곳: 이 시트가 열려 있는 동안 다시 권하지 않는다.
 * 채널 미승인은 (에이전트, 채널) 짝만, 그 밖의 이 시트에서 못 고치는 거절과 일시 정지는 에이전트를.
 */
function closedBy(
  failure: WorkRunFailure,
  agentId: string,
  channelId: string,
): {pair?: string; agent?: string} {
  if (failure.reason === 'hosted_channel_not_approved') {
    return {pair: pairKey(agentId, channelId)};
  }
  if (failure.next === 'fix_elsewhere' || failure.reason === 'agent_paused') {
    return {agent: agentId};
  }
  return {};
}

function SheetBody({
  prefill,
  preview,
  boardAvailable,
  onClose,
  onSubmitted,
}: {
  prefill: DelegatePrefill;
  preview?: DelegatePreview;
  boardAvailable: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {member, workspaceId} = useSession();
  const client = useQueryClient();
  const slideClose = usePageSheetClose() ?? onClose;
  const insets = useSafeAreaInsets();

  const directoryQuery = useDirectory(workspaceId);
  const channelsQuery = useChannels(workspaceId);
  const hostedQuery = useHostedConnections(workspaceId);
  const directory = directoryQuery.directory;

  // 호스티드 목록은 소유자·관리자만 읽는다. 못 읽은 것(403·오류)은 「승인 0개」가 아니라
  // 「모른다」다 — 일반 멤버에게 모든 에이전트가 막혔다고 말하지 않는다.
  const hosted = useMemo<HostedRead>(
    () =>
      hostedQuery.data === undefined
        ? HOSTED_UNKNOWN
        : {kind: 'known', connections: hostedQuery.data},
    [hostedQuery.data],
  );

  const lockedAgent = prefill.agentMemberId !== undefined;
  const lockedChannelId = prefill.channelId;

  const allChannels = useMemo<Channel[]>(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups],
  );

  // ---- 사람이 고른 것 -------------------------------------------------------
  const [agentId, setAgentId] = useState<string | null>(
    prefill.agentMemberId ?? preview?.pick?.agentMemberId ?? null,
  );
  const [channelId, setChannelId] = useState<string | null>(
    lockedChannelId ?? preview?.pick?.channelId ?? null,
  );
  const [step, setStep] = useState<Step | null>(preview?.step ?? null);
  const [draft, setDraftState] = useState<DelegateDraft>(() => ({
    ...readDraft(workspaceId),
    ...preview?.draft,
  }));
  const [showMore, setShowMore] = useState(() => {
    const remembered = readDraft(workspaceId);
    return remembered.repo !== '' || remembered.branch !== '';
  });
  const [fieldError, setFieldError] = useState<{
    field: WorkRunField;
    sentence: string;
  } | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(
    preview?.refusal ?? null,
  );
  // 서버가 닫은 곳은 이 시트가 열려 있는 동안 다시 권하지 않는다.
  const [refusedAgents, setRefusedAgents] = useState<readonly string[]>(() => {
    const r = preview?.refusal;
    const closed = r
      ? closedBy(r.failure, r.agentId, r.channelId).agent
      : undefined;
    return closed === undefined ? [] : [closed];
  });
  const [refusedPairs, setRefusedPairs] = useState<readonly string[]>(() => {
    const r = preview?.refusal;
    const closed = r
      ? closedBy(r.failure, r.agentId, r.channelId).pair
      : undefined;
    return closed === undefined ? [] : [closed];
  });
  const [preselected, setPreselected] = useState(preview?.pick !== undefined);
  const [received, setReceived] = useState(false);

  // VoiceOver: iOS 는 `accessibilityLiveRegion` 을 읽지 않는다(Android 전용). 거절 배너와
  // 칸 오류는 포커스 밖에서 생기므로 문장을 직접 알린다(`ApprovalDecision` 과 같은 길).
  const refusalSentence = refusal?.failure.sentence;
  useEffect(() => {
    if (refusalSentence !== undefined) {
      AccessibilityInfo.announceForAccessibility(refusalSentence);
    }
  }, [refusalSentence, refusal]);
  const fieldSentence = fieldError?.sentence;
  useEffect(() => {
    if (fieldSentence !== undefined) {
      AccessibilityInfo.announceForAccessibility(fieldSentence);
    }
  }, [fieldSentence, fieldError]);

  const runId = useRef<RunIdSlot | null>(null);
  const inputs = useRef<Partial<Record<WorkRunField, TextInput | null>>>({});

  const loading =
    directoryQuery.isPending ||
    channelsQuery.isPending ||
    hostedQuery.isPending;

  // ---- 후보 ---------------------------------------------------------------
  const agents = useMemo(
    () =>
      delegateAgents({
        directory,
        channels: channelsQuery.groups.channels,
        selfId: member.id,
        hosted,
      }),
    [directory, channelsQuery.groups.channels, member.id, hosted],
  );

  const lockedChannel = useMemo<Channel | null>(
    () =>
      lockedChannelId === undefined
        ? null
        : allChannels.find(channel => uuidEq(channel.id, lockedChannelId)) ??
          null,
    [allChannels, lockedChannelId],
  );

  const selected = useMemo<DelegateAgent | null>(() => {
    if (agentId === null) return null;
    return (
      agents.find(candidate => uuidEq(candidate.member.id, agentId)) ??
      delegateAgentFor({
        directory,
        channels: channelsQuery.groups.channels,
        agentId,
        hosted,
      })
    );
  }, [agentId, agents, directory, channelsQuery.groups.channels, hosted]);

  const channelOptions = useMemo<Channel[]>(() => {
    if (selected === null) return [];
    if (lockedChannel !== null) return [lockedChannel];
    return selected.channels;
  }, [selected, lockedChannel]);

  // 한 곳뿐이면 사람이 고를 것이 없다 — 이름만 보이고 자동으로 정해진다.
  const resolvedChannel = useMemo<Channel | null>(() => {
    if (channelOptions.length === 0) return null;
    if (channelId !== null) {
      const picked = channelOptions.find(option =>
        uuidEq(option.id, channelId),
      );
      if (picked !== undefined) return picked;
    }
    return channelOptions.length === 1 ? (channelOptions[0] as Channel) : null;
  }, [channelOptions, channelId]);

  const agentRefused =
    selected !== null &&
    refusedAgents.some(id => uuidEq(id, selected.member.id));
  // 서버가 닫은 (에이전트, 채널) 짝: 목록에서 지우지 않고 회색으로 둔다. 지우면 B 단계에서
  // 방금 쓴 도착지가 사라져 화면이 갑자기 A로 떨어진다.
  const pairRefused = (agent: string, channel: string) =>
    refusedPairs.includes(pairKey(agent, channel));
  const canGoToB =
    selected !== null &&
    selected.rest === null &&
    !agentRefused &&
    resolvedChannel !== null &&
    !pairRefused(selected.member.id, resolvedChannel.id);

  // 처음 열릴 때 한 번: 마지막에 쓴 곳을 A에 미리 찍는다(보내지는 않는다).
  if (!loading && !preselected) {
    setPreselected(true);
    if (!lockedAgent) {
      const last = readLastTarget(workspaceId);
      const match =
        last === null
          ? undefined
          : agents.find(
              candidate =>
                uuidEq(candidate.member.id, last.agentMemberId) &&
                candidate.rest === null &&
                candidate.channels.some(channel =>
                  uuidEq(channel.id, last.channelId),
                ),
            );
      if (last !== null && match !== undefined) {
        setAgentId(match.member.id);
        setChannelId(last.channelId);
      }
    }
  }

  // 단계: 에이전트가 정해져 오고 도착지까지 정해지면 B로 바로 간다. 한 번 B에 서면 그대로
  // 있는다 — 거절 뒤에 후보가 바뀌어도 쓰던 화면이 갑자기 A로 떨어지지 않는다.
  if (step === null && lockedAgent && !loading && canGoToB) setStep('B');
  const effectiveStep: Step = step ?? 'A';

  // ---- 입력 --------------------------------------------------------------
  const setField = useCallback(
    (field: keyof DelegateDraft, value: string) => {
      setDraftState(current => {
        const next = {...current, [field]: value};
        writeDraft(workspaceId, next);
        return next;
      });
      setFieldError(current => (current?.field === field ? null : current));
    },
    [workspaceId],
  );

  const pickAgent = (next: DelegateAgent) => {
    if (next.rest !== null) return;
    haptics.selection();
    setAgentId(next.member.id);
    setChannelId(null);
    setRefusal(null);
  };
  const pickChannel = (next: Channel) => {
    haptics.selection();
    setChannelId(next.id);
    setRefusal(null);
  };

  // ---- 보내기 -------------------------------------------------------------
  const mutation = useMutation({
    mutationFn: (variables: {channelId: string; draft: WorkRunDraft}) =>
      createAgentWorkRun(workspaceId, variables.channelId, variables.draft),
    onSuccess: () => {
      haptics.success();
      clearDraft(workspaceId);
      if (selected !== null && resolvedChannel !== null) {
        writeLastTarget(workspaceId, {
          agentMemberId: selected.member.id,
          channelId: resolvedChannel.id,
        });
      }
      void client.invalidateQueries({queryKey: teamBoardKey(workspaceId)});
      if (boardAvailable) {
        onSubmitted();
        slideClose();
      } else {
        setReceived(true);
      }
    },
    onError: (error, variables) => {
      const failure = workRunFailure(error);
      haptics.error();
      setRefusal({
        failure,
        agentId: variables.draft.agentMemberId,
        channelId: variables.channelId,
      });
      const closed = closedBy(
        failure,
        variables.draft.agentMemberId,
        variables.channelId,
      );
      if (closed.pair !== undefined) {
        const pair = closed.pair;
        setRefusedPairs(current => [...current, pair]);
      }
      if (closed.agent !== undefined) {
        const agent = closed.agent;
        setRefusedAgents(current => [...current, agent]);
      }
    },
  });

  const submit = (forceFresh = false) => {
    if (selected === null || resolvedChannel === null || mutation.isPending)
      return;
    const base: WorkRunDraft = {
      agentMemberId: selected.member.id,
      clientRunId: '',
      title: draft.title,
      brief: draft.brief,
      repo: draft.repo,
      branch: draft.branch,
    };
    let key: string;
    try {
      const input = normalizeWorkRunInput(base);
      key = intentKey(selected.member.id, resolvedChannel.id, input);
    } catch (error) {
      if (error instanceof WorkRunDraftError) {
        // 보내기 전에 막은 입력: 서버는 호출되지 않았다. 햅틱 없이 그 칸으로만 간다.
        setFieldError({field: error.field, sentence: error.sentence});
        if (error.field === 'repo' || error.field === 'branch')
          setShowMore(true);
        inputs.current[error.field]?.focus();
        return;
      }
      throw error;
    }
    runId.current = nextRunId(
      runId.current,
      key,
      newWorkRunClientId,
      forceFresh,
    );
    setRefusal(null);
    setFieldError(null);
    haptics.light();
    mutation.mutate({
      channelId: resolvedChannel.id,
      draft: {...base, clientRunId: runId.current.id},
    });
  };

  // ---- 그리기 -------------------------------------------------------------
  const header = (confirm?: SheetConfirm): React.JSX.Element => (
    <SheetHeader
      title="작업 맡기기"
      closeLabel="작업 맡기기 닫기"
      onClose={slideClose}
      closeTestID="delegate-close"
      confirm={confirm}
      testID="delegate-header"
    />
  );

  if (received) {
    return (
      <>
        {header()}
        <SheetScroll>
          <SheetNotice
            headline="작업을 맡겼어요."
            detail="이 서버에는 작업 보드가 없어서 진행은 여기서 볼 수 없어요."
            testID="delegate-received"
          />
        </SheetScroll>
      </>
    );
  }

  if (loading) {
    return (
      <>
        {header()}
        <SheetScroll>
          <GroupCard>
            <LoadingState
              label="맡길 수 있는 곳을 불러오는 중이에요."
              testID="delegate-loading"
            />
          </GroupCard>
        </SheetScroll>
      </>
    );
  }

  if (effectiveStep === 'A') {
    return (
      <>
        {/* 머리에는 확정 ✓ 가 없다 — 「다음」은 중간 단계라 시트 아래의 기본 단추다(아래). */}
        {header()}
        <SheetScroll testID="delegate-step-a">
          <Sentence style={styles.intro}>
            에이전트에게 일을 맡기면 작업 탭에서 진행을 볼 수 있어요.
          </Sentence>

          {!lockedAgent ? (
            agents.length === 0 ? (
              <SheetNotice
                headline={NO_AGENT_SENTENCE}
                testID="delegate-no-agent"
              />
            ) : (
              <GroupCard label="누구에게 맡길까요" testID="delegate-agents">
                {agents.map(candidate => {
                  const refused = refusedAgents.some(id =>
                    uuidEq(id, candidate.member.id),
                  );
                  const rest = candidate.rest;
                  const isSelected =
                    agentId !== null && uuidEq(agentId, candidate.member.id);
                  return (
                    <ChoiceRow
                      key={candidate.member.id}
                      title={candidate.member.displayName}
                      detail={
                        rest !== null
                          ? REST_SENTENCE[rest]
                          : refused
                          ? '방금은 받아 주지 않았어요'
                          : `@${candidate.member.handle}`
                      }
                      disabled={rest !== null || refused}
                      selected={isSelected}
                      onPress={() => pickAgent(candidate)}
                      testID={`delegate-agent-${candidate.member.handle}`}
                    />
                  );
                })}
              </GroupCard>
            )
          ) : selected !== null ? (
            <GroupCard label="맡길 에이전트" testID="delegate-agent-locked">
              <ListRow
                title={selected.member.displayName}
                detail={
                  selected.rest !== null
                    ? REST_SENTENCE[selected.rest]
                    : `@${selected.member.handle}`
                }
                testID="delegate-agent-fixed"
              />
            </GroupCard>
          ) : (
            <SheetNotice
              headline="이 에이전트를 찾지 못했어요. 목록을 새로 불러온 뒤에 다시 열어 주세요."
              testID="delegate-agent-missing"
            />
          )}

          {selected !== null && selected.rest === null ? (
            channelOptions.length === 0 ? (
              <SheetNotice
                headline={
                  selected.filteredByApproval
                    ? NO_APPROVED_CHANNEL_SENTENCE
                    : '이 에이전트가 들어 있는 채널이 없어요. 에이전트를 채널에 넣은 뒤에 맡겨 주세요.'
                }
                testID="delegate-no-channel"
              />
            ) : lockedChannel === null ? (
              <GroupCard label="어느 채널에서 할까요" testID="delegate-channels">
                {channelOptions.map(option => {
                  const isSelected =
                    resolvedChannel !== null &&
                    uuidEq(resolvedChannel.id, option.id);
                  const refused = pairRefused(selected.member.id, option.id);
                  return (
                    <ChoiceRow
                      key={option.id}
                      title={`#${option.name ?? '이름 없는 채널'}`}
                      detail={
                        refused ? '이 채널은 아직 승인되지 않았어요' : undefined
                      }
                      disabled={refused}
                      selected={isSelected}
                      onPress={() => pickChannel(option)}
                      testID={`delegate-channel-${option.name ?? option.id}`}
                    />
                  );
                })}
              </GroupCard>
            ) : null
          ) : null}

          {refusal !== null ? (
            <FailureBanner
              message={refusal.failure.sentence}
              testID="delegate-error"
            />
          ) : null}
        </SheetScroll>
        {/* 스크롤 밖 시트 바닥에 붙는 기본 단추. 고를 수 없는 동안은 회색·눌리지 않는다(`canGoToB`). */}
        <View
          style={[
            styles.footer,
            {paddingBottom: Math.max(insets.bottom, space.lg)},
          ]}
          testID="delegate-footer">
          <PrimaryButton
            label="다음"
            disabled={!canGoToB}
            onPress={() => {
              if (canGoToB) setStep('B');
            }}
            testID="delegate-next"
          />
        </View>
      </>
    );
  }

  // ---- B ------------------------------------------------------------------
  const action = refusal !== null ? failureAction(refusal.failure) : null;
  const blocked =
    refusal !== null &&
    action === 'repick' &&
    selected !== null &&
    resolvedChannel !== null &&
    uuidEq(refusal.agentId, selected.member.id) &&
    uuidEq(refusal.channelId, resolvedChannel.id);
  const sendDisabled =
    mutation.isPending ||
    blocked ||
    selected === null ||
    resolvedChannel === null;
  const fixed = lockedAgent && lockedChannelId !== undefined;
  const titleBytes = utf8ByteLength(draft.title.trim());
  const briefBytes = utf8ByteLength(draft.brief.trim());

  return (
    <>
      {header({
        label: mutation.isPending ? '보내는 중' : '맡기기',
        disabled: sendDisabled,
        busy: mutation.isPending,
        onPress: () => submit(),
        testID: 'delegate-send',
      })}
      <SheetScroll
        keyboardDismissMode="on-drag"
        // 큰 단은 시트가 키보드를 올리지 않는다 — 네이티브 스크롤이 입력 칸을 키보드 위로 올려 준다.
        automaticallyAdjustKeyboardInsets
        testID="delegate-step-b"
      >
        <GroupCard label="보낼 곳" testID="delegate-destination">
          <View style={styles.destination}>
            <Sentence style={styles.destinationValue}>
              {selected !== null && resolvedChannel !== null
                ? destinationLine(
                    selected.member.displayName,
                    resolvedChannel,
                    directory,
                    member.id,
                  )
                : ''}
            </Sentence>
          </View>
          {!fixed ? (
            <ListRow
              title="바꾸기"
              accessory="chevron"
              accessibilityLabel="맡길 곳 바꾸기"
              onPress={() => setStep('A')}
              testID="delegate-change-target"
            />
          ) : null}
        </GroupCard>

        {refusal !== null ? (
          <View style={styles.refusal}>
            <FailureBanner
              message={refusal.failure.sentence}
              onRetry={
                action === 'retry'
                  ? () => submit()
                  : action === 'new'
                  ? () => submit(true)
                  : undefined
              }
              retryLabel={
                action === 'retry' || action === 'new'
                  ? FAILURE_ACTION_LABEL[action]
                  : undefined
              }
              testID="delegate-error"
            />
            {action === 'repick' && !fixed ? (
              <GroupCard>
                <ListRow
                  title={FAILURE_ACTION_LABEL.repick}
                  accessory="chevron"
                  onPress={() => setStep('A')}
                  testID="delegate-error-repick"
                />
              </GroupCard>
            ) : null}
          </View>
        ) : null}

        <View style={styles.field}>
          <FieldLabel
            label="제목"
            note={
              nearLimit(titleBytes, WORK_TITLE_MAX_BYTES) ? '조금 남았어요' : null
            }
          />
          <Field
            ref={node => {
              inputs.current.title = node;
            }}
            value={draft.title}
            onChangeText={value => setField('title', value)}
            placeholder="예: 로그인 버그 고치기"
            invalid={fieldError?.field === 'title'}
            returnKeyType="next"
            editable={!mutation.isPending}
            accessibilityLabel="제목"
            testID="delegate-title"
          />
          <FieldIssue error={fieldError} field="title" />
        </View>

        <View style={styles.field}>
          <FieldLabel
            label="설명"
            note={
              nearLimit(briefBytes, WORK_BRIEF_MAX_BYTES) ? '조금 남았어요' : null
            }
          />
          <TextArea
            ref={node => {
              inputs.current.brief = node;
            }}
            value={draft.brief}
            onChangeText={value => setField('brief', value)}
            placeholder="무엇을, 어떻게 해 주면 좋을지 적어 주세요."
            invalid={fieldError?.field === 'brief'}
            editable={!mutation.isPending}
            accessibilityLabel="설명"
            testID="delegate-brief"
          />
          <FieldIssue error={fieldError} field="brief" />
        </View>

        <GroupCard>
          <ListRow
            title={showMore ? '저장소·브랜치 접기' : '저장소·브랜치 더 보기'}
            accessory="expand"
            expanded={showMore}
            onPress={() => setShowMore(current => !current)}
            testID="delegate-more"
          />
        </GroupCard>
        {showMore ? (
          <>
            <View style={styles.field}>
              <FieldLabel label="저장소" />
              <Field
                ref={node => {
                  inputs.current.repo = node;
                }}
                value={draft.repo}
                onChangeText={value => setField('repo', value)}
                placeholder="예: https://github.com/oort/app"
                invalid={fieldError?.field === 'repo'}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                editable={!mutation.isPending}
                accessibilityLabel="저장소"
                testID="delegate-repo"
              />
              <FieldIssue error={fieldError} field="repo" />
            </View>
            <View style={styles.field}>
              <FieldLabel label="브랜치" />
              <Field
                ref={node => {
                  inputs.current.branch = node;
                }}
                value={draft.branch}
                onChangeText={value => setField('branch', value)}
                placeholder="예: main"
                invalid={fieldError?.field === 'branch'}
                autoCapitalize="none"
                autoCorrect={false}
                editable={!mutation.isPending}
                accessibilityLabel="브랜치"
                testID="delegate-branch"
              />
              <FieldIssue error={fieldError} field="branch" />
              <Text
                style={styles.rule}
                lineBreakStrategyIOS="hangul-word"
                testID="delegate-repo-rule">
                둘 다 비워 두면 서버에 보내지 않아요.
              </Text>
            </View>
          </>
        ) : null}
      </SheetScroll>
    </>
  );
}

function FieldIssue({
  error,
  field,
}: {
  error: {field: WorkRunField; sentence: string} | null;
  field: WorkRunField;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  if (error === null || error.field !== field) return null;
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={styles.issue}
      // 코어가 준 칸 오류 문장은 길어질 수 있다 — 어절 가운데서 갈리지 않게(design-review r2 L2).
      lineBreakStrategyIOS="hangul-word"
      testID={`delegate-issue-${field}`}
    >
      {error.sentence}
    </Text>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    intro: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    // A 단계 바닥의 「다음」 단추 — 스크롤 밖, 몸과 같은 가로 거터.
    footer: {paddingHorizontal: SAFE_GUTTER, paddingTop: space.sm},
    // 입력 한 칸의 묶음: 라벨 · 입력 · 실패.
    field: {gap: space.sm},
    // 「보낼 곳」 카드의 안쪽(행 「바꾸기」가 그 아래 같은 카드에 선다).
    destination: {
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    destinationValue: {
      fontSize: font.body,
      color: color.text,
      fontWeight: '600',
    },
    refusal: {gap: space.sm},
    issue: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.dangerText,
    },
    rule: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.textMuted,
    },
  });
