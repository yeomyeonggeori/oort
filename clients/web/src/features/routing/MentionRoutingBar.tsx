import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { useSession } from "@/app/session";
import { useAgentProfile, useOpenAgentProfile } from "./useAgentProfile";
import { useCalledAgentsRouting } from "./useMentionRouting";
import { RoutingFields } from "./RoutingFields";
import { ExecutionTierField } from "./ExecutionTierField";
import { useExecutionTierAxis } from "./useExecutionTier";
import {
  SEND_UNSUPPORTED_REASON,
  UNSUPPORTED_REASON,
  useAllowedAgentModels,
  useRoutingCapability,
  useSendRoutingCapability,
} from "./capability";
import type { MentionRoutingTarget } from "@momo/core/features/routing/mentionTargets";
import {
  INHERIT_DRAFT,
  appliedModelLabel,
  clearedEffortNotice,
  effectiveModel,
  effortLabel,
  ignoredModelNotice,
  inheritedEffortLabel,
  inheritedModelLabel,
  isOverride,
  knownAgentModels,
  modelOptions,
  resolveInheritance,
  sharedClearedEffortNotice,
  sharedEfforts,
  sharedModelOptions,
  type CalledAgentRouting,
  type RoutingDraft,
} from "@momo/core/features/routing/routingModel";

// =============================================================================
// 컴포저 1회 오버라이드 (ADR-0134 D1·D3 / MOMO-626).
//
// @멘션이 확정되면 컴포저 위에 한 줄이 생긴다. 그 줄의 기본값은 오버라이드가
// 아니라 **상속**이고, 상속된 실제 값이 함께 적힌다: "모델 상속 (프로필:
// hermes-fast) · 강도 상속 (프로필: 낮음)". buzz가 증명한 문법이고(레퍼런스
// 서베이 §2), 무엇을 바꾸지 않았을 때 무슨 일이 일어나는지 먼저 보여 준다.
//
// 오버라이드가 걸리면 줄이 accent-soft로 바뀌고 "1회" 표시가 붙는다. Cursor가
// Auto 라벨을 백그라운드에서 덮어써 명시적 선택과 표시가 어긋난 사례(서베이 §2)의
// 반대편에 서기 위한 것이다. 전송하면 사라진다: "1회"라고 적어 놓고 다음
// 메시지까지 남아 있으면 그 말이 거짓이 된다(Composer가 보낸 뒤 reset을 호출한다).
//
// -----------------------------------------------------------------------------
// 왜 컨트롤이 프로브 뒤에 있는가 (R1 B1)
//
// `routing` 블록은 `POST .../messages`의 본문 키다(ADR-0134 D1 멘션 tier =
// MOMO-625가 `SendMessageRequest.allowedKeys`에 더한 단 하나의 키). 문제는 그
// 키를 **모르는 세대의 서버가 400을 주지 않는다**는 데 있다. 머지 전
// `SendMessageRequest`는 합성 Decodable이라 모르는 키를 그냥 버리고 200을 준다
// (main DTOs.swift:106, momowebqa 왕복 실측). 그러면 "이번 한 번만"이라는 칩과
// 요약 줄이 그대로 거짓말이 된다: 사람은 hermes-fast를 골랐는데 에이전트는
// 상속 모델로 답하고, 아무도 그 사실을 말해 주지 않는다.
//
// effort-table 200은 그 답이 되지 못한다. 그것은 MOMO-621이고, 전송 표면
// `routing`은 MOMO-625다. 실제로 621만 올라간 서버가 존재한다(track/engine 현재
// 형상). 그래서 이 줄은 [이번만 바꾸기]를 누르는 순간 전송 표면에 **직접** 물어본
// 뒤에야 상자를 연다(capability.ts `probeSendRouting`, 확정될 때까지). 확정되기
// 전까지는 상자가 잠긴 채 "확인 중"이라고 적혀 있고, 아니라고 들으면 잠긴 채로
// 이유가 남는다. 그 상태에서도 상속 줄은 계속 참이다: 서버는 프로필 값을 그대로
// 쓰므로, 이 줄이 말하는 내용은 오히려 그때 더 정확하다.
//
// **확인하지 못한 것은 아니라고 들은 것과 다르게 다룬다**(R2 H1). 500이나 네트워크
// 블립으로 프로브가 확정에 실패하면 그 결과는 이 서버에 대한 사실이 아니므로
// 기억하지 않는다: 줄에 [다시 확인]이 서고, 접었다 다시 펼치기만 해도 물음이 새로
// 날아간다. 회복 경로가 새로고침뿐인 화면은 "확인될 때까지 쓸 수 없습니다"라고
// 적어 놓고 그 확인을 일으킬 방법을 주지 않는 화면이다.
//
// -----------------------------------------------------------------------------
// 여럿을 부른 글 (#1113)
//
// 한 발화가 부른 에이전트 수만큼 run이 생기고(`agent_mentions.rs`의 per-agent
// 루프), 각자에게 걸려 있는 모델·강도는 서로 다르다. 앞 판의 이 줄은 그 사실을
// 한 문장으로 접어 두고("각 에이전트의 프로필 값이 그대로 적용됩니다") **그 값이
// 무엇인지는 끝내 말하지 않았다.** 부른 사람 수만큼 상속 체인을 풀면 되는 일이고,
// 그것이 여기서 늘어난 절반이다: 펼치면 부른 각자에게 이번 메시지가 무엇으로
// 도착할지가 한 줄씩 적힌다.
//
// 나머지 절반은 오버라이드다. 전송 표면이 받는 `routing`은 **메시지 한 건당
// 블록 하나**이고(openapi `RunRoutingInput`은 `additionalProperties: false`),
// 서버는 그 하나를 루프 안에서 각 에이전트에게 다시 푼다. 그러므로 이 줄이
// 여럿에게 걸 수 있는 값은 "각자 다른 값"이 아니라 **모두에게 같은 값**이고, 고를
// 수 있는 값은 부른 모두가 받아 주는 것들의 교집합이다(`sharedModelOptions` /
// `sharedEfforts`). 한 명에게만 유효한 값을 실으면 서버는 그 한 명에서 400을
// 답하고, 그 400은 전송 트랜잭션 전체를 되돌린다 — 두 명을 부른 메시지가 통째로
// 안 나간다. 화면은 그 조합을 애초에 상자에 올리지 않는다.
//
// -----------------------------------------------------------------------------
// 세 번째 축: 실행 위치 (CRUN-1 / #1382)
//
// Cursor의 「Run on」을 같은 문법으로 번역한 것이다. 저쪽 칩은 고른 값만 보여 주고
// 아무것도 고르지 않은 상태에서는 무슨 일이 일어나는지 말하지 않는데, 이 줄은 위에
// 적힌 그대로 **상속을 먼저** 보여 준다. 그래서 축이 하나 늘어난 자리도 같다:
// 접힌 줄의 요약에 실행 위치가 모델·강도 옆에 붙고, 고르는 상자는 [이번만 바꾸기]
// 패널 안에 선다.
//
// **다만 이 축은 지금 보낼 수 없다.** `routing` 블록의 허용 키는 두 세대 모두
// model·effort 둘뿐이고(`ROUTING_KEYS`, openapi `RunRoutingInput`은
// `additionalProperties: false`), `SendMessageRequest`에도 호스트를 받는 키가 없다.
// 모르는 키를 조용히 버리는 모델·강도의 사정과도 다르다: 여기서 `routing.tier`를
// 지어내 실으면 서버는 400으로 **전송 전체를 되돌린다.** 그래서 축은 끝까지 그리되
// 값을 싣지 않고, 왜 못 싣는지를 상자 아래 한 문장으로 말한다
// (`features/routing/tierAxis.ts`).
// =============================================================================

/** 이 줄이 접혀 있을 때의 고정 높이. 멘션이 붙었다 떨어질 때 컴포저가 튀지 않는다. */
export const MENTION_ROUTING_ROW_CLASS = "h-8 border-t border-line";

/** 'many' 문구에 이름을 그대로 적는 최대 인원. 나머지는 수로 접는다. */
const NAMED_LIMIT = 2;

/**
 * 오버라이드 표시. 줄 자체가 이미 accent-soft이므로 칩까지 accent-soft로 두면
 * 배경 위의 배경이 되어 아무것도 표시하지 않는다. 채운 accent + on-accent 쌍은
 * 버튼이 쓰는 측정된 조합이다(tokens.contrast.test.ts).
 */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-sm bg-accent px-1 text-timestamp font-medium text-on-accent">
      {children}
    </span>
  );
}

/**
 * 줄 안의 텍스트 액션.
 *
 * 이 줄은 오버라이드가 걸리면 accent-soft로 칠해지는데, `--line-strong`은 다크에서
 * 그 위에 2.90:1로 놓여 3:1 컨트롤 외곽선 바닥에 못 미친다(tokens.contrast.test.ts가
 * 이제 그 분류를 기계적으로 확인한다). 그래서 이 줄에는 외곽선을 가진 컨트롤을
 * 두지 않는다. 텍스트 액션은 전경색 규칙(4.5:1)만 지키면 되고, 그것은 측정표가
 * 이미 보장한다(R1 M2).
 */
function RowAction({
  children,
  onClick,
  expanded,
  testId,
}: {
  children: React.ReactNode;
  onClick: () => void;
  expanded?: boolean;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-controls={expanded ? "composer-routing-fields" : undefined}
      data-testid={testId}
      className="flex shrink-0 items-center gap-1 rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
    >
      {children}
    </button>
  );
}

/** 접기/펼치기 손잡이. 두 줄이 같은 동사와 같은 아이콘을 쓴다. */
function ToggleAction({
  expanded,
  onToggle,
}: {
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <RowAction expanded={expanded} onClick={onToggle} testId="composer-routing-toggle">
      {expanded ? "접기" : "이번만 바꾸기"}
      {expanded ? (
        <ChevronUp aria-hidden="true" className="size-3" />
      ) : (
        <ChevronDown aria-hidden="true" className="size-3" />
      )}
    </RowAction>
  );
}

export function MentionRoutingBar({
  channelId,
  target,
  draft,
  onDraftChange,
}: {
  channelId: string;
  target: MentionRoutingTarget;
  draft: RoutingDraft;
  onDraftChange: (next: RoutingDraft) => void;
}) {
  // 오버라이드가 걸려 있는데 대상이 사라지면(멘션을 지웠다) 그 값도 갈 곳이
  // 없다. 줄 자체가 사라지므로 초안도 함께 비운다.
  useEffect(() => {
    if (target.kind === "none" && isOverride(draft)) onDraftChange(INHERIT_DRAFT);
  }, [target.kind, draft, onDraftChange]);

  if (target.kind === "none") return null;
  if (target.kind === "many") {
    return (
      <ManyTargetRow
        channelId={channelId}
        target={target}
        draft={draft}
        onDraftChange={onDraftChange}
      />
    );
  }
  return (
    <OneTargetRow
      channelId={channelId}
      agent={target.agent}
      draft={draft}
      onDraftChange={onDraftChange}
    />
  );
}

function OneTargetRow({
  channelId,
  agent,
  draft,
  onDraftChange,
}: {
  channelId: string;
  agent: RosterMember;
  draft: RoutingDraft;
  onDraftChange: (next: RoutingDraft) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const { workspaceId } = useSession();
  const directory = useDirectory(workspaceId).directory;
  const capability = useRoutingCapability();
  const sendTier = useSendRoutingCapability(channelId);
  const openProfile = useOpenAgentProfile();
  const profileHandle = useAgentProfile(agent.id);
  const allowedModels = useAllowedAgentModels(agent.id);
  const tier = useExecutionTierAxis();

  // 프로필을 못 읽었으면 상속값을 **주장하지 않는다**(R1 H2). 404는 실패가 아니라
  // "프로필이 없다"는 사실이고, 그때 상속의 상대는 에이전트 자신의 모델이다.
  const profileFailed = Boolean(profileHandle.error);
  const table = capability.table;
  const inheritance = useMemo(() => {
    if (profileHandle.isPending || profileFailed) return null;
    return resolveInheritance(
      table, agent.agentModel ?? "", profileHandle.profile, allowedModels
    );
  }, [table, agent, profileHandle.isPending, profileHandle.profile, profileFailed, allowedModels]);

  const override = isOverride(draft);
  const effortReady = capability.support === "ready" && table !== null;

  // 잠긴 이유는 확정된 사실부터 순서대로 고른다. 확인 중은 결론이 아니므로
  // 마지막이고, 결론이 난 사유가 있으면 그것을 먼저 말한다.
  const agentName = agent.displayName;
  const inheritSuffix = `지금 보내면 ${agentName}의 프로필 값이 그대로 적용됩니다.`;
  const reason: string | null = profileFailed
    ? "이 에이전트의 프로필을 불러오지 못해 무엇이 적용될지 확인하지 못했습니다."
    : serverReason(capability, sendTier, inheritSuffix) ??
      (profileHandle.isPending
        ? "이 에이전트에 지금 무엇이 걸려 있는지 확인하는 중입니다."
        : null);

  // 이미 답이 있는 사유만 접힌 상태에서 보여 준다. 아직 물어보지도 않은 것을 두고
  // "확인 중"이라고 적어 두면 아무도 누르지 않은 줄이 계속 바쁜 척을 한다.
  const standingReason = profileFailed || settledServerVerdict(capability, sendTier) ? reason : null;

  // 확인하지 못해서 잠긴 줄에는 확인을 일으킬 손잡이가 있어야 한다(R2 H1).
  // "확인될 때까지 쓸 수 없습니다"라고 적어 놓고 그 확인이 새로고침뿐이면, 그
  // 문장은 다음 행동을 말한 것이 아니다(SKILL §5·§6). 프로필 다이얼로그가 effort
  // 축에 [추론 강도 지원 다시 확인]을 둔 것과 같은 자리다.
  const unsettled =
    capability.support === "unknown" || sendTier.support === "unknown";
  const recheckUnsettled = () => {
    if (capability.support === "unknown") capability.recheck();
    if (sendTier.support === "unknown") sendTier.prove();
  };

  const ready =
    effortReady && sendTier.support === "ready" && !profileFailed && inheritance !== null;

  const inheritedModel = agent.agentModel ?? "";
  const summary = profileFailed
    ? "상속값을 확인하지 못했습니다"
    : inheritance
      ? `모델 ${draft.model ?? inheritedModelLabel(inheritance)} · 강도 ${
          draft.effort ? effortLabel(draft.effort) : inheritedEffortLabel(inheritance)
        } · ${tier.summary}`
      : "상속값을 불러오는 중";

  return (
    <div
      className={cn("border-t border-line", override && "bg-accent-soft")}
      data-testid="composer-routing"
      data-override={override ? "" : undefined}
    >
      <div className="flex h-8 items-center gap-2 px-4 text-meta">
        <span className="shrink-0 text-agent">@{agent.handle}</span>
        {override ? (
          <Chip>이번 한 번만</Chip>
        ) : (
          <span className="shrink-0 text-ink-muted">이번 메시지</span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-ink-muted"
          data-testid="composer-routing-summary"
        >
          {summary}
        </span>
        {profileFailed && (
          <RowAction onClick={profileHandle.refetch} testId="composer-routing-retry">
            다시 시도
          </RowAction>
        )}
        {!profileFailed && unsettled && (
          <RowAction onClick={recheckUnsettled} testId="composer-routing-recheck">
            다시 확인
          </RowAction>
        )}
        {override && (
          <RowAction
            onClick={() => {
              onDraftChange(INHERIT_DRAFT);
              setCleared(null);
            }}
            testId="composer-routing-reset"
          >
            상속으로 되돌리기
          </RowAction>
        )}
        <ToggleAction
          expanded={expanded}
          onToggle={() => {
            const next = !expanded;
            setExpanded(next);
            // 펼치는 순간에만 전송 표면에 물어본다. 오버라이드를 한 번도 쓰지
            // 않는 세션은 이 요청을 한 건도 만들지 않고, 확정된 뒤의 펼침은
            // `prove`가 스스로 물러선다(capability.ts `beginSendProbe`).
            if (next && effortReady) sendTier.prove();
          }}
        />
      </div>

      {expanded && (
        <div
          id="composer-routing-fields"
          className="flex flex-col gap-2 border-t border-line bg-surface px-4 pb-2 pt-2"
        >
          <RoutingFields
            idPrefix="composer-routing"
            table={table}
            models={modelOptions(
              table,
              inheritance?.model.value ?? inheritedModel,
              knownAgentModels(directory.members),
              allowedModels
            )}
            allowedModelsReceived={allowedModels !== null}
            inheritedModel={inheritance?.model.value ?? inheritedModel}
            modelInheritLabel={
              inheritance ? inheritedModelLabel(inheritance) : "상속"
            }
            effortInheritLabel={
              inheritance ? inheritedEffortLabel(inheritance) : "상속"
            }
            layout="row"
            draft={draft}
            onChange={(next, clearedEffort) => {
              onDraftChange(next);
              setCleared(
                clearedEffort === null
                  ? null
                  : clearedEffortNotice(
                      effectiveModel(next, inheritance?.model.value ?? inheritedModel),
                      clearedEffort
                    )
              );
            }}
            modelDisabled={!ready}
            modelDisabledReason={reason}
            effortDisabled={!ready}
            effortDisabledReason={reason}
            clearedNotice={cleared}
            ignoredNotice={
              inheritance?.ignoredModelPref
                ? ignoredModelNotice(
                    inheritance.ignoredModelPref, inheritance.model.value
                  )
                : null
            }
          />
          <ExecutionTierField idPrefix="composer-routing" axis={tier} />
          <RowAction
            onClick={() => openProfile(agent.id)}
            testId="composer-routing-open-profile"
          >
            {agent.displayName}의 기본값 편집
          </RowAction>
        </div>
      )}

      {/* 접혀 있어도 서버가 못 하는 일이라면 그 사실은 보여야 한다. 펼쳐야만
          보이는 고지는 고지가 아니다. */}
      {!expanded && standingReason && (
        <p
          className="px-4 pb-1 text-meta text-ink-muted"
          data-testid="composer-routing-notice"
        >
          {standingReason}
        </p>
      )}
    </div>
  );
}

/**
 * 여럿을 부른 글의 줄 (#1113).
 *
 * 접혀 있을 때는 한 명일 때와 같은 문법이고(누구를 불렀는가 · 이번 메시지에
 * 무엇이 적용되는가), 펼치면 두 가지가 나온다: 부른 각자에게 이번 메시지가
 * 무엇으로 도착하는지, 그리고 모두에게 같이 걸 값 한 벌.
 */
function ManyTargetRow({
  channelId,
  target,
  draft,
  onDraftChange,
}: {
  channelId: string;
  target: Extract<MentionRoutingTarget, { kind: "many" }>;
  draft: RoutingDraft;
  onDraftChange: (next: RoutingDraft) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const { workspaceId } = useSession();
  const directory = useDirectory(workspaceId).directory;
  const capability = useRoutingCapability();
  const sendTier = useSendRoutingCapability(channelId);
  const table = capability.table;
  const called = useCalledAgentsRouting(target, table);
  const tier = useExecutionTierAxis();

  const override = isOverride(draft);
  const effortReady = capability.support === "ready" && table !== null;
  const count = target.agents.length;

  const named = target.agents.slice(0, NAMED_LIMIT).map((agent) => `@${agent.handle}`);
  const rest = count - named.length;
  // 조사는 목록이 무엇으로 끝나는지에 달려 있다(R2 M4). 두 명이면 문장은 라틴
  // 핸들로 끝나 "를"이고, 셋 이상이면 "명"으로 끝나 "을"이다.
  const calledLabel = rest > 0 ? `${named.join(", ")} 외 ${rest}명` : named.join(", ");

  const { models, allowedReceived } = sharedModelOptions(
    called.agents,
    table,
    knownAgentModels(directory.members)
  );
  const effortsFor = (modelOverride: string | null) =>
    sharedEfforts(table, called.agents, modelOverride);

  const unreadable = called.unreadable;
  const unreadableReason =
    unreadable.length > 0
      ? `${unreadable.join(", ")}의 프로필을 불러오지 못해 무엇이 적용될지 확인하지 못했습니다.`
      : null;
  const inheritSuffix = `지금 보내면 부른 ${count}명의 프로필 값이 각자 그대로 적용됩니다.`;
  const reason: string | null =
    unreadableReason ??
    serverReason(capability, sendTier, inheritSuffix) ??
    (called.isPending ? "부른 에이전트들에 지금 무엇이 걸려 있는지 확인하는 중입니다." : null);

  const standingReason =
    unreadableReason !== null || settledServerVerdict(capability, sendTier) ? reason : null;

  const unsettled = capability.support === "unknown" || sendTier.support === "unknown";
  const recheckUnsettled = () => {
    if (capability.support === "unknown") capability.recheck();
    if (sendTier.support === "unknown") sendTier.prove();
  };

  const ready =
    effortReady &&
    sendTier.support === "ready" &&
    unreadable.length === 0 &&
    !called.isPending;

  // 두 축은 따로 잠긴다. 공통 모델이 하나도 없는 워크스페이스에서도 강도는
  // 걸 수 있고, 그 반대도 있다.
  const noSharedModel = ready && models.length === 0;
  const noSharedEffort = ready && effortsFor(draft.model).length === 0;
  const modelReason = noSharedModel
    ? `부른 ${count}명이 함께 쓸 수 있는 모델이 없습니다. 모델은 각자 프로필 값이 그대로 적용됩니다.`
    : reason;
  const effortReason = noSharedEffort
    ? `부른 ${count}명이 함께 쓸 수 있는 추론 강도가 없습니다. 강도는 각자 프로필 값이 그대로 적용됩니다.`
    : reason;

  const summary = override
    ? `모델 ${draft.model ?? "각자 프로필 값"} · 강도 ${
        draft.effort ? effortLabel(draft.effort) : "각자 프로필 값"
      } · ${tier.summary}`
    : unreadable.length > 0
      ? "적용될 값을 확인하지 못했습니다"
      : called.isPending
        ? "적용될 값을 불러오는 중"
        : `모델·강도 각자 프로필 값 · ${tier.summary}`;

  return (
    <div
      className={cn("border-t border-line", override && "bg-accent-soft")}
      data-testid="composer-routing"
      data-override={override ? "" : undefined}
      data-called={count}
    >
      <div className="flex h-8 items-center gap-2 px-4 text-meta">
        {/* 핸들 두 개가 붙은 라벨은 한 명일 때보다 길다. 폭을 묶어 두지 않으면
            긴 핸들 두 개가 요약 줄을 밀어내고, 그다음에는 행 자체를 민다. */}
        <span className="max-w-pane-sm shrink-0 truncate text-agent">{calledLabel}</span>
        {override ? (
          <Chip>이번 한 번만</Chip>
        ) : (
          <span className="shrink-0 text-ink-muted">이번 메시지</span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-ink-muted"
          data-testid="composer-routing-summary"
        >
          {summary}
        </span>
        {unreadable.length > 0 && (
          <RowAction onClick={called.refetch} testId="composer-routing-retry">
            다시 시도
          </RowAction>
        )}
        {unreadable.length === 0 && unsettled && (
          <RowAction onClick={recheckUnsettled} testId="composer-routing-recheck">
            다시 확인
          </RowAction>
        )}
        {override && (
          <RowAction
            onClick={() => {
              onDraftChange(INHERIT_DRAFT);
              setCleared(null);
            }}
            testId="composer-routing-reset"
          >
            상속으로 되돌리기
          </RowAction>
        )}
        <ToggleAction
          expanded={expanded}
          onToggle={() => {
            const next = !expanded;
            setExpanded(next);
            if (next && effortReady) sendTier.prove();
          }}
        />
      </div>

      {expanded && (
        <div
          id="composer-routing-fields"
          className="flex flex-col gap-2 border-t border-line bg-surface px-4 pb-2 pt-2"
        >
          <p className="text-meta text-ink-muted">
            고른 값은 부른 {count}명 모두에게 같이 적용됩니다. 메시지 한 건에는
            모델과 추론 강도를 하나씩만 실을 수 있고, 여기 올라오는 값은 부른
            모두가 받아 주는 것들입니다.
          </p>
          <RoutingFields
            idPrefix="composer-routing"
            table={table}
            models={models}
            allowedModelsReceived={allowedReceived}
            inheritedModel=""
            modelInheritLabel="상속 (각자 프로필 값)"
            effortInheritLabel="상속 (각자 프로필 값)"
            effortsFor={effortsFor}
            layout="row"
            draft={draft}
            onChange={(next, clearedEffort) => {
              onDraftChange(next);
              setCleared(
                clearedEffort === null
                  ? null
                  : next.model === null
                    ? sharedClearedEffortNotice(clearedEffort)
                    : clearedEffortNotice(next.model, clearedEffort)
              );
            }}
            modelDisabled={!ready || noSharedModel}
            modelDisabledReason={modelReason}
            effortDisabled={!ready || noSharedEffort}
            effortDisabledReason={effortReason}
            clearedNotice={cleared}
          />
          {/* 실행 위치는 부른 수와 무관하다: 워크스페이스 정책 한 벌이 모두에게
              같이 걸리고, 지금은 메시지 한 건으로 그것을 바꿀 전선도 없다. 그래서
              한 명일 때와 **같은 상자 하나**가 선다. */}
          <ExecutionTierField idPrefix="composer-routing" axis={tier} />
          <CalledAgentList agents={called.agents} draft={draft} pending={called.isPending} />
        </div>
      )}

      {!expanded && standingReason && (
        <p
          className="px-4 pb-1 text-meta text-ink-muted"
          data-testid="composer-routing-notice"
        >
          {standingReason}
        </p>
      )}
    </div>
  );
}

/**
 * 부른 각자에게 이번 메시지가 무엇으로 도착하는가.
 *
 * 오버라이드가 걸려 있으면 그 값이 이미 반영된 줄이다: 사람이 상자에서 고른 값과
 * 이 목록이 다른 말을 하면, 둘 중 하나는 반드시 거짓이 된다.
 */
function CalledAgentList({
  agents,
  draft,
  pending,
}: {
  agents: readonly CalledAgentRouting[];
  draft: RoutingDraft;
  pending: boolean;
}) {
  return (
    <dl className="flex flex-col gap-1" data-testid="composer-routing-called">
      {agents.map((agent) => (
        <div key={agent.id} className="flex items-baseline gap-2 text-meta">
          <dt className="max-w-pane-sm shrink-0 truncate text-agent">@{agent.handle}</dt>
          <dd className="min-w-0 flex-1 truncate text-ink-muted">
            {appliedLine(agent, draft, pending)}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function appliedLine(
  agent: CalledAgentRouting,
  draft: RoutingDraft,
  pending: boolean
): string {
  if (agent.inheritance === null) {
    return pending ? "불러오는 중" : "무엇이 적용될지 확인하지 못했습니다";
  }
  const model = appliedModelLabel(draft.model ?? agent.inheritance.model.value);
  const effort = draft.effort ?? agent.inheritance.effort.value;
  return `모델 ${model} · 강도 ${effort === null ? "지정 없음" : effortLabel(effort)}`;
}

// ---- 두 줄이 함께 쓰는 서버 판정 ---------------------------------------------

type Capability = { support: string; reason: string | null };

/**
 * 서버가 이 오버라이드를 받는가에 대한, 사람에게 할 말. 없으면 `null`이고 그때
 * 잠금 사유는 호출자가 자기 사정(프로필 읽기 등)으로 정한다.
 *
 * 순서가 곧 정직함이다: 확정된 사유가 먼저고, "확인 중"은 결론이 아니므로 맨
 * 뒤다. 두 줄이 같은 순서를 쓰지 않으면 한 화면이 서버에 대해 두 가지를 말한다.
 */
function serverReason(
  capability: Capability,
  sendTier: Capability,
  inheritSuffix: string
): string | null {
  if (capability.support === "absent") {
    return `${capability.reason ?? UNSUPPORTED_REASON} ${inheritSuffix}`;
  }
  if (capability.support === "unknown") {
    return `${capability.reason ?? ""} 확인될 때까지 이번 한 번만 바꾸기는 쓸 수 없습니다.`.trim();
  }
  if (sendTier.support === "absent") {
    return `${sendTier.reason ?? SEND_UNSUPPORTED_REASON} ${inheritSuffix}`;
  }
  if (sendTier.support === "unknown") {
    return `${sendTier.reason ?? ""} 확인될 때까지 이번 한 번만 바꾸기는 쓸 수 없습니다.`.trim();
  }
  if (
    capability.support === "checking" ||
    sendTier.support === "checking" ||
    sendTier.support === "idle"
  ) {
    return "이 서버가 메시지 한 건 오버라이드를 받는지 확인하는 중입니다.";
  }
  return null;
}

/** 서버에 대해 **결론이 난** 사유가 있는가. 접힌 줄은 그것만 보여 준다. */
function settledServerVerdict(capability: Capability, sendTier: Capability): boolean {
  return (
    capability.support === "absent" ||
    capability.support === "unknown" ||
    sendTier.support === "absent" ||
    sendTier.support === "unknown"
  );
}
