import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import {
  COHOSTED_COPY as COPY,
  connectCohosted,
  connectErrorMessage,
  fetchCohostedStatus,
  probeCohosted,
  probeLine,
  type CohostedProbe,
  type CohostedStatus,
} from "@momo/core/features/settings/cohostedAgent";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openExternalUrl } from "@/lib/tauri";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";
import { AiLineRow, AiSection, AiSectionHead } from "./aiAccountsParts";
import { ModelLoginPanel } from "./ModelLoginPanel";

// Reading this as: settings › AI 연결 card (instance operator only) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

/** 배포 체크리스트(D6). 앱 안에 문서가 없어 저장소 문서로 간다(WelcomeStep 의 셀프호스트 링크와 같은 방식). */
const COHOSTED_CHECKLIST_URL =
  "https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST_AGENT.ko.md";

const HEADING_ID = "ai-cohosted-title";

/**
 * 「같은 서버의 Hermes」 (#3883 서버 / ADR-0203 D3·Q2). 인스턴스 운영자에게만, 서버가 선언을 알 때만 보인다.
 *
 * 보임의 판정은 서버 답이다(`fetchCohostedStatus`): 운영자가 아니면(403) 이 서버에 길이 없으면(404) 선언이 없으면
 * 이 카드는 아무것도 그리지 않는다. 읽는 동안에도 그리지 않는다(대부분의 보는 사람은 운영자가 아니다).
 *
 * 세 단계다. 잠금 선언 전에는 체크리스트 링크뿐이다: 「연결할 수 있다」는 암시를 하지 않는다. 선언 뒤에야 서버에
 * 한 번 찾아 보고(고정 요청 둘, 주의 신호로 하나 더), 닿으면 「같은 서버의 Hermes를 찾았어요, 연결할까요?」와 한 번
 * 클릭이다. 연결되면 한 줄로 바뀐다. 도구 잠금은 운영자 본인의 선언이고 oort가 확인한 값이 아니라는 문장이 늘 붙는다.
 */
export function CohostedAgentCard({ offline, workspaceId }: { offline: boolean; workspaceId: string }) {
  const status = useQuery({
    queryKey: ["cohosted-agent", workspaceId],
    queryFn: () => fetchCohostedStatus(workspaceId),
    retry: false,
  });
  if (status.isPending) return null;
  if (status.isError || status.data?.kind === "unknown") {
    return (
      <AiSection labelledBy={HEADING_ID} testId="ai-cohosted">
        <AiSectionHead id={HEADING_ID} title={COPY.title} scope="이 서버" locked />
        <InlineBanner
          message="같은 서버의 Hermes 상태를 불러오지 못했어요."
          actionLabel="다시 시도"
          onAction={() => void status.refetch()}
          testId="ai-cohosted-error"
        />
      </AiSection>
    );
  }
  if (status.data?.kind !== "ready") return null;
  return <CardBody status={status.data.status} offline={offline} workspaceId={workspaceId} />;
}

function openChecklist(event: React.MouseEvent<HTMLAnchorElement>) {
  // Tauri 창에서 target=_blank 는 아무것도 열지 않는다(lib/tauri.ts).
  if (!IS_TAURI) return;
  event.preventDefault();
  void openExternalUrl(COHOSTED_CHECKLIST_URL);
}

function ChecklistLink() {
  return (
    <a
      href={COHOSTED_CHECKLIST_URL}
      target="_blank"
      rel="noreferrer"
      className="press rounded-sm text-ink underline underline-offset-4 focus-visible:focus-ring"
      onClick={openChecklist}
      data-testid="ai-cohosted-checklist"
    >
      {COPY.checklistLink}
    </a>
  );
}

function CardBody({
  status,
  offline,
  workspaceId,
}: {
  status: CohostedStatus;
  offline: boolean;
  workspaceId: string;
}) {
  const client = useQueryClient();
  const connected = status.connectedAgentId;
  const searching = status.toolsLockAttested && connected === null;

  // 서버에 한 번 찾아 보는 것은 선언한 운영자가 이 화면을 연 때뿐이다. 창 초점 복귀로 다시 부르지 않는다.
  const probe = useQuery({
    queryKey: ["cohosted-agent-probe", workspaceId],
    queryFn: () => probeCohosted(workspaceId, true),
    enabled: searching && !offline,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  const connect = useMutation({
    mutationFn: () => connectCohosted(workspaceId),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["cohosted-agent", workspaceId] });
      void client.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
    },
  });

  // 연결이 끝나면 초점이 사라진 단추에서 <body> 로 떨어지지 않게 새 줄로 옮긴다.
  const doneRef = useRef<HTMLDivElement>(null);
  const wasConnected = useRef(connected !== null);
  useEffect(() => {
    if (connected !== null && !wasConnected.current) doneRef.current?.focus();
    wasConnected.current = connected !== null;
  }, [connected]);

  return (
    <AiSection labelledBy={HEADING_ID} testId="ai-cohosted">
      <AiSectionHead id={HEADING_ID} title={COPY.title} scope="이 서버" locked />
      {connected !== null ? (
        <>
        <div ref={doneRef} tabIndex={-1} className="focus-visible:focus-ring" data-testid="ai-cohosted-connected">
          <AiLineRow
            last
            action={
              <Link
                to={`/agents?agent=${encodeURIComponent(connected)}`}
                className="press rounded-sm text-body text-ink underline underline-offset-4 focus-visible:focus-ring"
                data-testid="ai-cohosted-open-agent"
              >
                {COPY.openAgent}
              </Link>
            }
          >
            <span className="font-semibold">{COPY.connected}</span>
            <span className="text-meta text-ink-muted">{COPY.volumeNote}</span>
          </AiLineRow>
        </div>
        {/* #4080: 연결된 Hermes의 모델 인증(운영자만, 서버 답이 보임을 정한다). */}
        <ModelLoginPanel workspaceId={workspaceId} agentId={connected} offline={offline} />
        </>
      ) : !status.toolsLockAttested ? (
        <AiLineRow last testId="ai-cohosted-checklist-row">
          <span>{COPY.checklistLead}</span>
          <span className="text-meta text-ink-muted">
            {COPY.checklistAfterHead}
            <code className="rounded-sm bg-muted-soft px-1 font-mono text-ink [overflow-wrap:anywhere]">{COPY.checklistEnv}</code>
            {COPY.checklistAfterTail}
          </span>
          <span>
            <ChecklistLink />
          </span>
        </AiLineRow>
      ) : offline ? (
        <InlineBanner tone="neutral" message={COPY.offline} testId="ai-cohosted-offline" />
      ) : probe.isPending ? (
        <div role="status" aria-live="polite" className="px-2 py-3 text-body text-ink-muted" data-testid="ai-cohosted-finding">
          {COPY.finding}
        </div>
      ) : probe.isError || !probe.data ? (
        <InlineBanner
          message={probeLine("unreachable", status) ?? ""}
          actionLabel={COPY.retry}
          onAction={() => void probe.refetch()}
          testId="ai-cohosted-probe-error"
        />
      ) : (
        <ProbeResult
          probe={probe.data}
          status={status}
          busy={connect.isPending}
          fetching={probe.isFetching}
          onRetry={() => void probe.refetch()}
          onConnect={() => connect.mutate()}
        />
      )}
      {connect.isError && (
        <InlineBanner message={connectErrorMessage(connect.error)} testId="ai-cohosted-connect-error" />
      )}
    </AiSection>
  );
}

function ProbeResult({
  probe,
  status,
  busy,
  fetching,
  onRetry,
  onConnect,
}: {
  probe: CohostedProbe;
  status: CohostedStatus;
  busy: boolean;
  fetching: boolean;
  onRetry: () => void;
  onConnect: () => void;
}) {
  if (probe.state !== "ok") {
    return (
      <AiLineRow
        last
        testId="ai-cohosted-not-found"
        action={
          <Button type="button" size="sm" variant="secondary" className="tap-target" disabled={fetching} onClick={onRetry}>
            {COPY.retry}
          </Button>
        }
      >
        <span role="status">{probeLine(probe.state, status)}</span>
      </AiLineRow>
    );
  }
  return (
    <AiLineRow
      last
      testId="ai-cohosted-found"
      action={
        <Button
          type="button"
          size="sm"
          className="tap-target"
          disabled={busy || !probe.connectable}
          aria-disabled={busy || !probe.connectable}
          onClick={onConnect}
          data-testid="ai-cohosted-connect"
        >
          {busy && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {busy ? COPY.connecting : COPY.connect}
        </Button>
      }
    >
      <span className="font-semibold">{COPY.found}</span>
      <span className="text-meta text-ink-muted">{COPY.foundDetail}</span>
      {probe.toolsets === "dangerous_listed" && (
        <span className="text-meta text-danger" role="status" data-testid="ai-cohosted-toolsets-warn">
          {COPY.toolsetsWarn}
          {probe.toolsetsListed.length > 0 && ` (${probe.toolsetsListed.join(", ")})`}
        </span>
      )}
      {probe.toolsets === "none_listed" && (
        <span className="text-meta text-ink-muted">{COPY.toolsetsNone}</span>
      )}
      <span className="text-meta text-ink-muted" data-testid="ai-cohosted-attest-note">
        {COPY.attestNote}
      </span>
      <span className="text-meta text-ink-muted">{COPY.volumeNote}</span>
    </AiLineRow>
  );
}
