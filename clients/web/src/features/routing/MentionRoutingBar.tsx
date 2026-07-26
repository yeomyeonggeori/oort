import { useEffect, useMemo, useState } from "react";
import type { RosterMember } from "@/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useAgentProfile, useOpenAgentProfile } from "./useAgentProfile";
import { RoutingFields } from "./RoutingFields";
import { UNSUPPORTED_REASON, useRoutingCapability } from "./capability";
import type { MentionRoutingTarget } from "./mentionTargets";
import {
  INHERIT_DRAFT,
  clearedEffortNotice,
  effectiveModel,
  effortLabel,
  inheritedEffortLabel,
  inheritedModelLabel,
  isOverride,
  resolveInheritance,
  type RoutingDraft,
} from "./routingModel";

// =============================================================================
// 컴포저 1회 오버라이드 (ADR-0134 D1·D3 / MOMO-626).
//
// @멘션이 확정되면 컴포저 위에 한 줄이 생긴다. 그 줄의 기본값은 오버라이드가
// 아니라 **상속**이고, 상속된 실제 값이 함께 적힌다: "모델 상속 (프로필:
// hermes-fast) · 강도 상속 (프로필: 낮음)". buzz가 증명한 문법이고(레퍼런스
// 서베이 §2), 무엇을 바꾸지 않았을 때 무슨 일이 일어나는지 먼저 보여 준다.
//
// 오버라이드가 걸리면 줄 전체가 accent-soft로 바뀌고 "1회" 표시가 붙는다.
// Cursor가 Auto 라벨을 백그라운드에서 덮어써 명시적 선택과 표시가 어긋난
// 사례(서베이 §2)의 반대편에 서기 위한 것이다: 이 값이 이번 한 번만 산다는
// 사실과, 지금 상속이 아니라는 사실이 둘 다 눈에 보여야 한다.
//
// 전송하면 사라진다. "1회"라고 적어 놓고 다음 메시지까지 남아 있으면 그 말이
// 거짓이 된다(Composer가 보낸 뒤 reset을 호출한다).
//
// 서버가 아직 이 기능을 모르면(capability absent) 컨트롤을 숨기지 않고 잠근
// 채 사유를 적는다. 그 상태에서도 상속 줄은 계속 참이다: 서버는 프로필 값을
// 그대로 쓰므로, 이 줄이 말하는 내용은 오히려 그때 더 정확하다.
// =============================================================================

/**
 * 오버라이드 표시. 줄 자체가 이미 accent-soft이므로 칩까지 accent-soft로 두면
 * 배경 위의 배경이 되어 아무것도 표시하지 않는다. 채운 accent + on-accent 쌍은
 * 버튼이 쓰는 측정된 조합이다(tokens.contrast.test.ts).
 */
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm bg-accent px-1 text-timestamp font-medium text-on-accent">
      {children}
    </span>
  );
}

export function MentionRoutingBar({
  target,
  draft,
  onDraftChange,
}: {
  target: MentionRoutingTarget;
  draft: RoutingDraft;
  onDraftChange: (next: RoutingDraft) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cleared, setCleared] = useState<string | null>(null);
  const capability = useRoutingCapability();
  const openProfile = useOpenAgentProfile();
  const agent: RosterMember | null = target.kind === "one" ? target.agent : null;
  const profileHandle = useAgentProfile(agent?.id ?? null);

  // 표가 없어도 모델 층은 계산된다: 표는 강도의 유효값을 재는 자일 뿐이다.
  // 프로필 응답이 아직 없을 때만 상속값이 진짜로 미지수다.
  const table = capability.table;
  const inheritance = useMemo(() => {
    if (!agent || profileHandle.isPending) return null;
    return resolveInheritance(table, agent.agentModel ?? "", profileHandle.profile);
  }, [table, agent, profileHandle.isPending, profileHandle.profile]);

  // 오버라이드가 걸려 있는데 대상이 사라지면(멘션을 지웠다) 그 값도 갈 곳이
  // 없다. 줄 자체가 사라지므로 초안도 함께 비운다.
  useEffect(() => {
    if (target.kind === "none" && isOverride(draft)) onDraftChange(INHERIT_DRAFT);
  }, [target.kind, draft, onDraftChange]);

  if (target.kind === "none") return null;

  if (target.kind === "many") {
    return (
      <p
        className="border-t border-line px-4 py-1 text-meta text-ink-muted"
        data-testid="composer-routing-many"
      >
        에이전트를 여러 명 불렀습니다(
        {target.agents.map((a) => `@${a.handle}`).join(", ")}). 요청이 각각
        만들어져서 이번 한 번만 바꾸기는 붙일 수 없고, 각 에이전트의 프로필 값이
        그대로 적용됩니다.
      </p>
    );
  }

  const override = isOverride(draft);
  const ready = capability.support === "ready" && table !== null;
  const inheritedModel = agent?.agentModel ?? "";

  const reason =
    capability.support === "absent"
      ? `${capability.reason ?? UNSUPPORTED_REASON} 지금 보내면 ${
          agent?.displayName ?? "이 에이전트"
        }의 프로필 값이 그대로 적용됩니다.`
      : capability.support === "unknown"
        ? `${capability.reason ?? ""} 확인될 때까지 이번 한 번만 바꾸기는 쓸 수 없습니다.`
        : null;

  return (
    <div
      className={cn(
        "border-t border-line",
        override && "bg-accent-soft"
      )}
      data-testid="composer-routing"
      data-override={override ? "" : undefined}
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-1 text-meta">
        <span className="text-agent">@{agent?.handle}</span>
        {override ? (
          <Chip>이번 한 번만</Chip>
        ) : (
          <span className="text-ink-muted">이번 메시지</span>
        )}
        <span
          className="min-w-0 flex-1 truncate text-ink-muted"
          data-testid="composer-routing-summary"
        >
          {inheritance
            ? `모델 ${
                draft.model ?? inheritedModelLabel(inheritance)
              } · 강도 ${
                draft.effort
                  ? effortLabel(draft.effort)
                  : inheritedEffortLabel(inheritance)
              }`
            : "상속값을 불러오는 중"}
        </span>
        {override && (
          <button
            type="button"
            onClick={() => {
              onDraftChange(INHERIT_DRAFT);
              setCleared(null);
            }}
            data-testid="composer-routing-reset"
            className="rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            상속으로 되돌리기
          </button>
        )}
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          aria-controls="composer-routing-fields"
          data-testid="composer-routing-toggle"
        >
          {expanded ? "접기" : "이번만 바꾸기"}
        </Button>
      </div>

      {expanded && (
        <div
          id="composer-routing-fields"
          className="flex flex-col gap-3 px-4 pb-2"
        >
          <RoutingFields
            idPrefix="composer-routing"
            table={table}
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
            disabled={!ready}
            disabledReason={reason}
            clearedEffort={cleared}
          />
          {agent && (
            <button
              type="button"
              onClick={() => openProfile(agent.id)}
              data-testid="composer-routing-open-profile"
              className="self-start rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {agent.displayName}의 기본값 편집
            </button>
          )}
        </div>
      )}

      {/* 접혀 있어도 서버가 못 하는 일이라면 그 사실은 보여야 한다. 펼쳐야만
          보이는 고지는 고지가 아니다. */}
      {!expanded && reason && (
        <p
          className="px-4 pb-1 text-meta text-ink-muted"
          data-testid="composer-routing-reason"
        >
          {reason}
        </p>
      )}
    </div>
  );
}
