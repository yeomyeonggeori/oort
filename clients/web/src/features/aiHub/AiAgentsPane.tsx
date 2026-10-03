import { useEffect, useLayoutEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { cn } from "@/design/lib/cn";
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
const TD = "px-0 py-1 align-top text-body text-ink group-data-wide:px-3 group-data-wide:py-3";

/** 좁은 폭에서 표가 카드로 접힐 때만 보이는 칸 이름. 넓은 폭에서는 표 머리가 말한다. */
function CellLabel({ children }: { children: string }) {
  return (
    <span aria-hidden="true" data-cell-label className="block text-timestamp text-ink-muted group-data-wide:hidden">
      {children}
    </span>
  );
}

function StatusCell({ status }: { status: AgentStatusView | null }) {
  if (!status) return <span className="text-meta text-ink-muted">{COPY.statusUnknown}</span>;
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <AiPill tone={status.tone}>{status.label}</AiPill>
      {status.detail && <span className="max-w-pane-md break-keep text-meta text-ink-muted">{status.detail}</span>}
    </div>
  );
}

function CallableCell({ row }: { row: AgentTableRow }) {
  const { callable, lockedForViewer } = row.labels;
  if (callable === null) return <span className="text-meta text-ink-muted">{COPY.unknownBrain}</span>;
  return (
    <AiPill tone={lockedForViewer ? "warn" : "mute"}>
      {lockedForViewer && <Lock aria-hidden="true" className="size-3 shrink-0" />}
      {callable}
      {lockedForViewer && <span className="sr-only"> · {COPY.locked}</span>}
    </AiPill>
  );
}

function AgentRow({ row, highlighted }: { row: AgentTableRow; highlighted: boolean }) {
  const { labels } = row;
  return (
    <tr
      role="row"
      className={cn("grid grid-cols-2 gap-x-4 border-b border-line py-3 group-data-wide:table-row group-data-wide:py-0", highlighted && "bg-accent-soft")}
      data-testid={`ai-agent-row-${row.handle}`}
      data-just-created={highlighted || undefined}
      data-locked={labels.lockedForViewer || undefined}
    >
      <th scope="row" role="rowheader" className={`${TD} col-span-2 pb-2 text-left font-normal group-data-wide:col-auto group-data-wide:whitespace-nowrap`}>
        <div className="flex min-w-0 items-center gap-3">
          <AiLogo mark={row.mark} />
          <div className="flex min-w-0 flex-col">
            <Link
              to={`/agents?agent=${encodeURIComponent(row.id)}`}
              data-agent-link={row.id}
              data-testid={`ai-agent-link-${row.handle}`}
              className="break-keep text-body font-semibold text-ink underline-offset-4 press hover:underline focus-visible:focus-ring group-data-wide:whitespace-nowrap"
            >
              {row.name}
            </Link>
            <span className="text-meta text-ink-muted [overflow-wrap:anywhere]">@{row.handle}</span>
          </div>
        </div>
      </th>
      <td role="cell" className={`${TD} group-data-wide:whitespace-nowrap`} data-testid={`ai-agent-brain-${row.handle}`}>
        <CellLabel>{COPY.columns.brain}</CellLabel>
        {labels.brain ?? <span className="text-meta text-ink-muted">{COPY.unknownBrain}</span>}
      </td>
      <td role="cell" className={TD} data-testid={`ai-agent-callable-${row.handle}`}>
        <CellLabel>{COPY.columns.callable}</CellLabel>
        <CallableCell row={row} />
      </td>
      <td role="cell" className={`${TD} group-data-wide:whitespace-nowrap`} data-testid={`ai-agent-cost-${row.handle}`}>
        <CellLabel>{COPY.columns.cost}</CellLabel>
        {labels.cost ?? <span className="text-meta text-ink-muted">{COPY.unknownBrain}</span>}
      </td>
      <td role="cell" className={`${TD} col-span-2 group-data-wide:col-auto group-data-wide:w-full`} data-testid={`ai-agent-status-${row.handle}`}>
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
/** 이 폭(px) 이상일 때 표로, 아니면 카드로 접는다. 앞 네 열(한 줄)이 약 560px, 상태 열이 최소 약 400px 필요하다. */
const TABLE_MIN_WIDTH = 960;

/**
 * 창이 아니라 표 영역의 실제 폭으로 접는다(사이드바가 열려 있으면 같은 창 폭도 영역 폭이 다르다).
 * `overflowing` 은 표 모양인데도 넘칠 때만 true: 그때만 스크롤 영역이 키보드 정차점이다.
 */
function usePaneLayout() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState({ wide: false, overflowing: false });
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const wide = el.clientWidth >= TABLE_MIN_WIDTH;
      const overflowing = el.scrollWidth > el.clientWidth + 1;
      setState((prev) => (prev.wide === wide && prev.overflowing === overflowing ? prev : { wide, overflowing }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [el]);
  return { setEl, ...state };
}

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
  const layout = usePaneLayout();
  // 방금 만든 에이전트 줄: 명부가 새로 오면 그 줄의 이름으로 포커스를 옮기고 잠깐 칠한다.
  const [createdId, setCreatedId] = useState<string | null>(null);

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

  const createdRowReady = createdId !== null && rows.some((r) => r.id.toLowerCase() === createdId);
  useEffect(() => {
    if (!createdRowReady) return;
    // 만들기 창이 닫히며 여는 단추로 포커스를 돌려주고 난 뒤에 옮긴다.
    const focus = window.setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-agent-link="${createdId}"]`)?.focus();
    }, 400);
    const clear = window.setTimeout(() => setCreatedId(null), 3000);
    return () => {
      window.clearTimeout(focus);
      window.clearTimeout(clear);
    };
  }, [createdRowReady, createdId]);

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
              <Button type="button" size="sm" className="tap-target" onClick={(event) => openChooser(event.currentTarget)} disabled={offline}>
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
          ref={layout.setEl}
          className="group min-w-0 overflow-x-auto focus-visible:focus-ring"
          data-wide={layout.wide || undefined}
          role="region"
          aria-label={COPY.tableLabel}
          // 가로로 미는 영역은 키보드로 닿아야 한다. 밀 것이 없으면 정차점도 아니다.
          tabIndex={layout.overflowing ? 0 : undefined}
          data-overflowing={layout.overflowing || undefined}
        >
          <table role="table" className="block w-full border-collapse group-data-wide:table" data-testid="ai-agents-table">
            <caption className="sr-only">{COPY.tableLabel}</caption>
            <thead role="rowgroup" className="sr-only group-data-wide:not-sr-only group-data-wide:table-header-group">
              <tr role="row" className="border-b border-line">
                <th scope="col" role="columnheader" className={TH}>{COPY.columns.agent}</th>
                <th scope="col" role="columnheader" className={TH}>{COPY.columns.brain}</th>
                <th scope="col" role="columnheader" className={TH}>{COPY.columns.callable}</th>
                <th scope="col" role="columnheader" className={TH}>{COPY.columns.cost}</th>
                <th scope="col" role="columnheader" className={TH}>{COPY.columns.status}</th>
              </tr>
            </thead>
            <tbody role="rowgroup" className="block group-data-wide:table-row-group">
              {rows.map((row) => (
                <AgentRow key={row.id} row={row} highlighted={createdId !== null && row.id.toLowerCase() === createdId} />
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

      <CreateAgentFlow open={choosing} onOpenChange={setChoosing} mayCreate={mayCreate}
        opener={opener}
        onCreated={(created) => setCreatedId(created.id.toLowerCase())}
      />
    </div>
  );
}
