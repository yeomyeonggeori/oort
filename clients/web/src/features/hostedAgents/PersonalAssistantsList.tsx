import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { AI_EXTERNAL_BASE_PATH } from "@momo/core/features/ai/aiHubModel";
import {
  hostedFailureMessage,
  isHostedOperatorDenied,
  type HostedChipTone,
} from "@momo/core/features/hostedAgents/model";
import {
  PERSONAL_ASSISTANTS_COPY as COPY,
  personalAssistantRows,
  type PersonalAssistantBadge,
  type PersonalAssistantRow,
} from "@momo/core/features/hostedAgents/personalAssistants";
import { AI_EXTERNAL_COPY } from "@momo/core/features/ai/aiHubModel";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { canCreateAgentNow } from "@/features/agentHub/createModel";
import { AgentLivenessLabel } from "@/features/agents/AgentLivenessLabel";
import { useAgentLiveness } from "@/features/agents/useAgentLiveness";
import { CHIP_CLASS } from "@/features/common/chip";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { hostedListQuery } from "./hostedCredentialScope";
import type { HostedWizardLaunch } from "./hostedWizardLaunch";
import { HostedAgentWizard } from "./HostedAgentWizard";

// Reading this as: settings (AI 허브 외부 연결) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

// =============================================================================
// 「개인 비서」 목록 (#3773). Aside 의 Settings › Channels › Personal Assistants
// 문법: 한 줄 = 이니셜 마크 · 이름 · 상태 배지 · **주 행동 하나**.
//
// 행의 내용은 core 의 `personalAssistantRows` 가 정한다. 이 컴포넌트는 그것을
// 그리고, 행동이 눌리면 위저드를 그 시작 값으로 연다. 위저드 단계 기계는 바꾸지
// 않는다: 그록봇 행의 「연결」은 이름·핸들을 채우고 첫 발급을 대신 밟는
// `autoAdvance: "create"` 시작 값이다.
//
// 네 상태: 로딩(높이를 지키는 막대) · 오류(인라인 배너 + 다시 시도) ·
// 오프라인(행은 그대로, 행동만 잠금) · 권한 없음(소유자·관리자만 행동).
// =============================================================================

const TONE_CLASS: Record<HostedChipTone | "signal", string> = {
  ok: "bg-ok-soft text-ok",
  warn: "bg-warn-soft text-warn",
  danger: "bg-warn-soft text-warn",
  neutral: "bg-muted-soft text-ink-muted",
  signal: "bg-muted-soft text-ink",
};

function ConnectedFallback({ badge }: { badge: PersonalAssistantBadge }) {
  return (
    <span className={cn(CHIP_CLASS, TONE_CLASS[badge.tone])} data-testid="assistant-badge-text">
      {badge.text}
    </span>
  );
}

/**
 * 활성 행의 배지. 서버가 생존 라벨을 줄 수 있으면 그 라벨(ADR-0200), 모르면 「연결됨」.
 * 라벨은 「연결됨」과 다른 사실이다: 토큰이 한 번 증명됐다는 것과 지금 응답한다는 것.
 */
function LivenessBadge({
  agentMemberId,
  badge,
}: {
  agentMemberId: string;
  badge: PersonalAssistantBadge;
}) {
  const { liveness } = useAgentLiveness(agentMemberId);
  if (liveness === null || liveness === undefined) return <ConnectedFallback badge={badge} />;
  return <AgentLivenessLabel agentId={agentMemberId} />;
}

function Badge({ badge }: { badge: PersonalAssistantBadge }) {
  if (badge.text === "" && badge.kind === "none") return null;
  if (badge.kind === "liveness") {
    return <LivenessBadge agentMemberId={badge.agentMemberId} badge={badge} />;
  }
  return <ConnectedFallback badge={badge} />;
}

function Row({
  row,
  locked,
  lockedReason,
  mayAct,
  onAct,
}: {
  row: PersonalAssistantRow;
  locked: boolean;
  lockedReason: string | null;
  mayAct: boolean;
  onAct: (row: PersonalAssistantRow, opener: HTMLButtonElement) => void;
}) {
  const { entry, action } = row;
  const soon = entry.state === "soon";
  const titleId = `assistant-title-${entry.id}`;
  const noteId = `assistant-note-${entry.id}`;
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-3 first:border-t"
      data-testid="assistant-row"
      data-assistant-id={entry.id}
      data-state={entry.state}
    >
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-muted text-body font-semibold",
          soon ? "text-ink-muted" : "text-ink"
        )}
        data-testid="assistant-mark"
      >
        {entry.mark}
      </span>
      <div className="flex min-w-0 flex-1 basis-pane-sm flex-col">
        <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <span id={titleId} className="break-keep text-body font-semibold text-ink">
            {entry.name}
          </span>
          {entry.provider && (
            <span className="text-meta text-ink-muted" data-testid="assistant-provider">
              {entry.provider}
            </span>
          )}
        </span>
        <span id={noteId} className="break-keep text-meta text-ink-muted">
          {entry.note}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <Badge badge={row.badge} />
        {action && mayAct && (
          <Button
            type="button"
            variant={action.kind === "connect" ? "default" : "secondary"}
            size="sm"
            className={cn("tap-target", locked && "opacity-50")}
            aria-disabled={locked || undefined}
            aria-labelledby={`assistant-action-${entry.id} ${titleId}`}
            id={`assistant-action-${entry.id}`}
            aria-describedby={locked && lockedReason ? "assistant-locked-reason" : noteId}
            onClick={(event) => {
              if (locked) return;
              onAct(row, event.currentTarget);
            }}
            data-testid="assistant-action"
            data-action-kind={action.kind}
          >
            {action.label}
          </Button>
        )}
      </div>
    </li>
  );
}

export function PersonalAssistantsList({ className }: { className?: string }) {
  const { workspaceId, session } = useSession();
  const offline = useOffline();
  const navigate = useNavigate();
  const directory = useDirectory(workspaceId);
  const list = useQuery(hostedListQuery(workspaceId));
  const [launch, setLaunch] = useState<HostedWizardLaunch | null>(null);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const role = memberFor(directory.directory, session.member.id)?.role;
  const rosterSettled = !directory.isPending;
  const mayCreate = canCreateAgentNow(rosterSettled, session.member.kind, role);
  const denied = list.isError && isHostedOperatorDenied(list.error);
  const absent = list.isError && serverSaysAbsent(list.error);
  const failed = list.isError && !denied && !absent;
  const connections = list.isSuccess ? list.data : null;

  // 이 서버에 호스티드 연결 표면이 없으면(구 서버) 연결 가능 행의 행동은 거짓이다.
  const rows = personalAssistantRows({
    members: directory.directory.members,
    connections: absent ? [] : connections,
  }).map((row) =>
    absent && row.action ? { ...row, action: null } : row
  );

  const act = (row: PersonalAssistantRow, trigger: HTMLButtonElement) => {
    const action = row.action;
    if (!action) return;
    if (action.kind === "manage" || !action.launch) {
      navigate(`${AI_EXTERNAL_BASE_PATH}/agents`);
      return;
    }
    setOpener(trigger);
    setLaunch(action.launch);
    setWizardOpen(true);
  };

  const lockedReason = offline ? "연결이 끊겨 지금은 할 수 없어요. 다시 연결되면 눌러 보세요." : null;

  return (
    <section
      className={cn("flex min-w-0 flex-col gap-3", className)}
      aria-labelledby="assistants-heading"
      data-testid="personal-assistants"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 id="assistants-heading" className="text-title font-semibold text-ink">
          {COPY.title}
        </h3>
        <p className="max-w-2xl break-keep text-body text-ink-muted">{COPY.lead}</p>
      </div>
      {offline && (
        <InlineBanner
          tone="neutral"
          message={lockedReason ?? ""}
          messageId="assistant-locked-reason"
          testId="assistants-offline"
          separator={false}
        />
      )}
      {failed && (
        <InlineBanner
          message={hostedFailureMessage("list", list.error)}
          actionLabel="다시 시도"
          onAction={() => void list.refetch()}
          testId="assistants-error"
          separator={false}
        />
      )}
      {list.isPending && !offline ? (
        <div role="status" data-testid="assistants-loading">
          <span className="sr-only">개인 비서 목록을 불러오는 중이에요.</span>
          <Skeleton ready={false} rows={3} className="p-0" />
        </div>
      ) : (
        <ul aria-label={COPY.listLabel} className="flex min-w-0 flex-col">
          {rows.map((row) => (
            <Row
              key={row.entry.id}
              row={row}
              locked={offline}
              lockedReason={lockedReason}
              mayAct={mayCreate && !denied}
              onAct={act}
            />
          ))}
        </ul>
      )}
      {!list.isPending && !mayCreate && rosterSettled && (
        <p className="break-keep text-meta text-ink-muted" data-testid="assistants-permission">
          {AI_EXTERNAL_COPY.permission}
        </p>
      )}
      {denied && (
        <p className="break-keep text-meta text-ink-muted" data-testid="assistants-denied">
          {AI_EXTERNAL_COPY.permission}
        </p>
      )}
      <p className="break-keep text-meta text-ink-muted" data-testid="assistants-boundary">
        {COPY.boundary}
      </p>
      <HostedAgentWizard
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open);
          if (!open) {
            setLaunch(null);
            void list.refetch();
          }
        }}
        opener={opener}
        launch={launch}
        entry="settings"
      />
    </section>
  );
}
