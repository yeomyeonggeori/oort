import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { attachParticle } from "@momo/core/lib/koreanParticle";
import { cn } from "@/design/lib/cn";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { useSession } from "@/app/session";
import { useAgentProfile, useOpenAgentProfile } from "./useAgentProfile";
import { RoutingFields } from "./RoutingFields";
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
      className="flex shrink-0 items-center gap-1 rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {children}
    </button>
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
  const [expanded, setExpanded] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const { workspaceId } = useSession();
  const directory = useDirectory(workspaceId).directory;
  const capability = useRoutingCapability();
  const sendTier = useSendRoutingCapability(channelId);
  const openProfile = useOpenAgentProfile();
  const agent: RosterMember | null = target.kind === "one" ? target.agent : null;
  const profileHandle = useAgentProfile(agent?.id ?? null);
  const allowedModels = useAllowedAgentModels(agent?.id ?? null);

  // 프로필을 못 읽었으면 상속값을 **주장하지 않는다**(R1 H2). 404는 실패가 아니라
  // "프로필이 없다"는 사실이고, 그때 상속의 상대는 에이전트 자신의 모델이다.
  const profileFailed = agent !== null && Boolean(profileHandle.error);
  const table = capability.table;
  const inheritance = useMemo(() => {
    if (!agent || profileHandle.isPending || profileFailed) return null;
    return resolveInheritance(
      table, agent.agentModel ?? "", profileHandle.profile, allowedModels
    );
  }, [table, agent, profileHandle.isPending, profileHandle.profile, profileFailed, allowedModels]);

  // 오버라이드가 걸려 있는데 대상이 사라지면(멘션을 지웠다) 그 값도 갈 곳이
  // 없다. 줄 자체가 사라지므로 초안도 함께 비운다.
  useEffect(() => {
    if (target.kind === "none" && isOverride(draft)) onDraftChange(INHERIT_DRAFT);
  }, [target.kind, draft, onDraftChange]);

  if (target.kind === "none") return null;

  if (target.kind === "many") {
    const named = target.agents.slice(0, NAMED_LIMIT).map((a) => `@${a.handle}`);
    const rest = target.agents.length - named.length;
    // 조사는 목록이 무엇으로 끝나는지에 달려 있다(R2 M4). 두 명이면 문장은 라틴
    // 핸들로 끝나 "를"이고, 셋 이상이면 "명"으로 끝나 "을"이다. 하드코딩한 "을"은
    // 앞의 경우에 어긋나고, 같은 파일이 쓰는 clearedEffortNotice는 이미 이 규칙을
    // 계산해서 쓴다.
    const called = rest > 0 ? `${named.join(", ")} 외 ${rest}명` : named.join(", ");
    return (
      <p
        className="border-t border-line px-4 py-1 text-meta text-ink-muted"
        data-testid="composer-routing-many"
      >
        {attachParticle(called, "object")} 불렀습니다. 요청이 각각 만들어져서
        이번 한 번만 바꾸기는 붙일 수 없고, 각 에이전트의 프로필 값이 그대로
        적용됩니다.
      </p>
    );
  }

  const override = isOverride(draft);
  const effortReady = capability.support === "ready" && table !== null;

  // 잠긴 이유는 확정된 사실부터 순서대로 고른다. 확인 중은 결론이 아니므로
  // 마지막이고, 결론이 난 사유가 있으면 그것을 먼저 말한다.
  const agentName = agent?.displayName ?? "이 에이전트";
  const inheritSuffix = `지금 보내면 ${agentName}의 프로필 값이 그대로 적용됩니다.`;
  const reason: string | null = profileFailed
    ? "이 에이전트의 프로필을 불러오지 못해 무엇이 적용될지 확인하지 못했습니다."
    : capability.support === "absent"
      ? `${capability.reason ?? UNSUPPORTED_REASON} ${inheritSuffix}`
      : capability.support === "unknown"
        ? `${capability.reason ?? ""} 확인될 때까지 이번 한 번만 바꾸기는 쓸 수 없습니다.`.trim()
        : sendTier.support === "absent"
          ? `${sendTier.reason ?? SEND_UNSUPPORTED_REASON} ${inheritSuffix}`
          : sendTier.support === "unknown"
            ? `${sendTier.reason ?? ""} 확인될 때까지 이번 한 번만 바꾸기는 쓸 수 없습니다.`.trim()
            : capability.support === "checking" ||
                sendTier.support === "checking" ||
                sendTier.support === "idle"
              ? "이 서버가 메시지 한 건 오버라이드를 받는지 확인하는 중입니다."
              : profileHandle.isPending
                ? "이 에이전트에 지금 무엇이 걸려 있는지 확인하는 중입니다."
                : null;

  // 이미 답이 있는 사유만 접힌 상태에서 보여 준다. 아직 물어보지도 않은 것을 두고
  // "확인 중"이라고 적어 두면 아무도 누르지 않은 줄이 계속 바쁜 척을 한다.
  const standingReason =
    profileFailed ||
    capability.support === "absent" ||
    capability.support === "unknown" ||
    sendTier.support === "absent" ||
    sendTier.support === "unknown"
      ? reason
      : null;

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

  const inheritedModel = agent?.agentModel ?? "";
  const summary = profileFailed
    ? "상속값을 확인하지 못했습니다"
    : inheritance
      ? `모델 ${draft.model ?? inheritedModelLabel(inheritance)} · 강도 ${
          draft.effort ? effortLabel(draft.effort) : inheritedEffortLabel(inheritance)
        }`
      : "상속값을 불러오는 중";

  return (
    <div
      className={cn("border-t border-line", override && "bg-accent-soft")}
      data-testid="composer-routing"
      data-override={override ? "" : undefined}
    >
      <div className="flex h-8 items-center gap-2 px-4 text-meta">
        <span className="shrink-0 text-agent">@{agent?.handle}</span>
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
        <RowAction
          expanded={expanded}
          onClick={() => {
            const next = !expanded;
            setExpanded(next);
            // 펼치는 순간에만 전송 표면에 물어본다. 오버라이드를 한 번도 쓰지
            // 않는 세션은 이 요청을 한 건도 만들지 않고, 확정된 뒤의 펼침은
            // `prove`가 스스로 물러선다(capability.ts `beginSendProbe`).
            if (next && effortReady) sendTier.prove();
          }}
          testId="composer-routing-toggle"
        >
          {expanded ? "접기" : "이번만 바꾸기"}
          {expanded ? (
            <ChevronUp aria-hidden="true" className="size-3" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-3" />
          )}
        </RowAction>
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
          {agent && (
            <RowAction
              onClick={() => openProfile(agent.id)}
              testId="composer-routing-open-profile"
            >
              {agent.displayName}의 기본값 편집
            </RowAction>
          )}
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
