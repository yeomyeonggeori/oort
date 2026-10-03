import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { Button } from "@/design/ui/button";
import {
  AI_AGENTS_PANE_COPY as COPY,
  AI_HUB_COPY,
  aiHubSection,
  glossaryEntry,
} from "@momo/core/features/ai/aiHubModel";
import { memberFor } from "@momo/core/features/workspace/directory";
import { useSession } from "@/app/session";
import { canCreateAgentNow } from "@/features/agentHub/createModel";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { AiLogo, AiPill } from "@/features/settings/aiAccountsParts";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { agentTableRows, type AgentStatusView, type AgentTableRow } from "./aiAgentsModel";
import { CreateAgentFlow } from "./CreateAgentFlow";

const TH = "whitespace-nowrap px-3 py-2 text-left text-meta font-normal text-ink-muted";
const TD = "px-3 py-3 align-top text-body text-ink max-md:px-0 max-md:py-1";

/** 좁은 폭에서 표가 카드로 접힐 때만 보이는 칸 이름. 넓은 폭에서는 표 머리가 말한다. */
function CellLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" data-cell-label className="block text-timestamp text-ink-muted md:hidden">
      {children}
    </span>
  );
}

function StatusCell({ status }: { status: AgentStatusView | null }) {
  if (!status) return <span className="text-meta text-ink-muted">{COPY.statusUnknown}</span>;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <AiPill tone={status.tone}>{status.label}</AiPill>
      {status.detail && <span className="break-keep text-meta text-ink-muted">{status.detail}</span>}
    </div>
  );
}

function CallableCell({ row }: { row: AgentTableRow }) {
  const { callable, lockedForViewer } = row.labels;
  if (callable === null) return <span className="text-meta text-ink-muted">{COPY.unknownBrain}</span>;
  return (
    <AiPill tone={row.classification.callableBy === "owner" ? "warn" : "mute"}>
      {lockedForViewer && <Lock aria-hidden="true" className="size-3 shrink-0" />}
      {callable}
      {lockedForViewer && <span className="sr-only"> · {COPY.locked}</span>}
    </AiPill>
  );
}

function AgentRow({ row }: { row: AgentTableRow }) {
  const { labels } = row;
  return (
    <tr
      className="border-b border-line max-md:grid max-md:grid-cols-2 max-md:gap-x-4 max-md:py-3"
      data-testid={`ai-agent-row-${row.handle}`}
      data-locked={labels.lockedForViewer || undefined}
    >
      <th scope="row" className={`${TD} text-left font-normal max-md:col-span-2 max-md:pb-2`}>
        <div className="flex min-w-0 items-center gap-3">
          <AiLogo mark={row.mark} />
          <div className="flex min-w-0 flex-col">
            <span className="break-keep text-body font-semibold text-ink [overflow-wrap:anywhere]">{row.name}</span>
            <span className="text-meta text-ink-muted [overflow-wrap:anywhere]">@{row.handle}</span>
          </div>
        </div>
      </th>
      <td className={`${TD} md:whitespace-nowrap`} data-testid={`ai-agent-brain-${row.handle}`}>
        <CellLabel>{COPY.columns.brain}</CellLabel>
        {labels.brain ?? <span className="text-meta text-ink-muted">{COPY.unknownBrain}</span>}
      </td>
      <td className={TD} data-testid={`ai-agent-callable-${row.handle}`}>
        <CellLabel>{COPY.columns.callable}</CellLabel>
        <CallableCell row={row} />
      </td>
      <td className={`${TD} md:whitespace-nowrap`} data-testid={`ai-agent-cost-${row.handle}`}>
        <CellLabel>{COPY.columns.cost}</CellLabel>
        {labels.cost ?? <span className="text-meta text-ink-muted">{COPY.unknownBrain}</span>}
      </td>
      <td className={`${TD} max-md:col-span-2`} data-testid={`ai-agent-status-${row.handle}`}>
        <CellLabel>{COPY.columns.status}</CellLabel>
        <StatusCell status={row.status} />
      </td>
    </tr>
  );
}

/**
 * 「에이전트」 구획 (AIH-7, #3428). 에이전트마다 쓰는 AI · 부를 수 있는 사람 · 비용 · 상태를 한 표로 본다.
 * 칸의 문장은 전부 core `aiAgentLabels` 가 만든다(서버 값 → 라벨). 만들기는 종류를 고르는 창(`CreateAgentFlow`).
 */
export function AiAgentsPane() {
  const { workspaceId, session } = useSession();
  const offline = useOffline();
  const directory = useDirectory(workspaceId);
  const hosted = useQuery(hostedListQuery(workspaceId));
  // 개요의 「에이전트 만들기」가 `?create=1` 로 와서 고르는 창을 바로 연다.
  const [params] = useSearchParams();
  const [choosing, setChoosing] = useState(() => params.get("create") === "1");
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  const openChooser = (button: HTMLElement) => {
    setOpener(button);
    setChoosing(true);
  };
  const entry = glossaryEntry(aiHubSection("agents").glossaryId);

  const mayCreate = canCreateAgentNow(
    !directory.isPending,
    session.member.kind,
    memberFor(directory.directory, session.member.id)?.role
  );
  // 연결 목록은 소유자·관리자만 읽는다. 못 읽어도 서버가 brain 을 직접 준 행은 그대로 읽는다.
  const rows =
    directory.isPending || directory.isError
      ? []
      : agentTableRows(directory.directory.members, hosted.isPending ? null : (hosted.data ?? null), session.member.id);

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="ai-hub-pane-agents">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="text-display font-bold text-ink">{entry.term}</h2>
          <p className="max-w-2xl break-keep text-body text-ink-muted">{AI_HUB_COPY.agentsPageTagline}</p>
        </div>
        {mayCreate && (
          <Button
            type="button"
            size="sm"
            className="tap-target"
            onClick={(event) => openChooser(event.currentTarget)}
            disabled={offline}
            data-testid="ai-agents-create"
          >
            {COPY.create.button}
          </Button>
        )}
      </div>

      {offline && <InlineBanner tone="neutral" message={COPY.offline} testId="ai-agents-offline" />}

      {directory.isPending ? (
        <div role="status" aria-live="polite" data-testid="ai-agents-loading">
          <span className="sr-only">{COPY.loading}</span>
          <Skeleton ready={false} rows={4} className="py-3" />
        </div>
      ) : directory.isError ? (
        <InlineBanner
          message={COPY.error}
          actionLabel={COPY.retry}
          onAction={() => void directory.refetch()}
          testId="ai-agents-error"
        />
      ) : rows.length === 0 ? (
        <EmptyInvite
          headline={COPY.empty}
          detail={mayCreate ? COPY.emptyCanCreate : COPY.emptyCannotCreate}
          actions={
            mayCreate ? (
              <Button size="sm" onClick={(event) => openChooser(event.currentTarget)} disabled={offline}>
                {COPY.create.button}
              </Button>
            ) : undefined
          }
          className="px-0"
          testId="ai-agents-empty"
        />
      ) : (
        // 표가 폭보다 넓으면 이 상자 안에서만 가로로 민다(문서는 넘치지 않는다). 키보드로도 닿는다.
        <div
          className="min-w-0 overflow-x-auto"
          role="region"
          aria-label={COPY.tableLabel}
          // 가로로 미는 영역은 키보드로 닿아야 한다.
          tabIndex={0}
        >
          <table className="block w-full border-collapse md:table" data-testid="ai-agents-table">
            <caption className="sr-only">{COPY.tableLabel}</caption>
            <thead className="max-md:sr-only">
              <tr className="border-b border-line">
                <th scope="col" className={TH}>{COPY.columns.agent}</th>
                <th scope="col" className={TH}>{COPY.columns.brain}</th>
                <th scope="col" className={TH}>{COPY.columns.callable}</th>
                <th scope="col" className={TH}>{COPY.columns.cost}</th>
                <th scope="col" className={TH}>{COPY.columns.status}</th>
              </tr>
            </thead>
            <tbody className="block md:table-row-group">
              {rows.map((row) => (
                <AgentRow key={row.id} row={row} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="break-keep text-meta text-ink-muted">
        {COPY.manageLine}{" "}
        <Link
          to="/agents"
          className="underline underline-offset-4 press focus-visible:focus-ring"
          data-testid="ai-hub-open-agent-list"
        >
          {COPY.manageLink}
        </Link>
      </p>

      <CreateAgentFlow open={choosing} onOpenChange={setChoosing} mayCreate={mayCreate} opener={opener} />
    </div>
  );
}
