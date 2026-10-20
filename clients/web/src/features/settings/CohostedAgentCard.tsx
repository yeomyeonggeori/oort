import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ChevronRight, Loader2 } from "lucide-react";
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
import { openDirectMessage, type Channel } from "@momo/core/lib/api";
import { openDmErrorMessage, upsertChannel } from "@momo/core/features/directory/model";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { useSession } from "@/app/session";
import { InlineBanner } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import { openExternalUrl } from "@/lib/tauri";
import { rosterQueryKey } from "@/features/workspace/useWorkspace";
import { AiLineRow, AiSection, AiSectionHead } from "./aiAccountsParts";
import { ModelLoginPanel } from "./ModelLoginPanel";
import { cohostedPromptKey, markCohostedPromptShown, wasCohostedPromptShown } from "./cohostedPrompt";

// Reading this as: AI hub (top of every pane) card (instance operator only) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

/** 배포 체크리스트(D6). 앱 안에 문서가 없어 저장소 문서로 간다(WelcomeStep 의 셀프호스트 링크와 같은 방식). */
const COHOSTED_CHECKLIST_URL =
  "https://github.com/yeomyeonggeori/oort/blob/main/docs/SELF_HOST_AGENT.ko.md";

const HEADING_ID = "ai-cohosted-title";

/** 연결 알림이 머무는 시간. */
const CONNECTED_NOTICE_MS = 6000;

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

  // 연결에 성공한 순간 한 번 뜨는 알림. 토스트 더미가 아니라 카드 안 제자리 한 줄이고, 잠시 뒤 스스로 걷힌다.
  const [noticeOn, setNoticeOn] = useState(false);
  useEffect(() => {
    if (!noticeOn) return;
    const timer = window.setTimeout(() => setNoticeOn(false), CONNECTED_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [noticeOn]);

  // 운영자와 Hermes의 DM(#4141). 연결 멤버는 만들어졌는데 DM 채널이 없으면 사이드바에 안 보인다. POST /dms는
  // 멱등이라(`useOpenDm`과 같은 계약) 연결 직후엔 만들어 두고(이동 없이), 「대화 열기」는 같은 호출로 그 채널로 간다.
  const navigate = useNavigate();
  const [dmError, setDmError] = useState<string | null>(null);
  const openAgentDm = useCallback(
    async (agentId: string, andGo: boolean) => {
      setDmError(null);
      try {
        const opened = await openDirectMessage(workspaceId, agentId);
        client.setQueryData<Channel[]>(["channels", workspaceId], (current) =>
          current ? upsertChannel(current, opened.channel) : [opened.channel]
        );
        void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
        if (andGo) navigate(`/c/${opened.channel.id}`);
      } catch (failure) {
        setDmError(openDmErrorMessage(failure, "Hermes"));
      }
    },
    [workspaceId, client, navigate]
  );

  const connect = useMutation({
    mutationFn: () => connectCohosted(workspaceId),
    onSuccess: (result) => {
      // 카드 단추와 처음 한 번 창이 같은 mutation이라 알림도 DM도 한 곳에서 켠다(#4141).
      setNoticeOn(true);
      void openAgentDm(result.agentId, false);
      void client.invalidateQueries({ queryKey: ["cohosted-agent", workspaceId] });
      void client.invalidateQueries({ queryKey: rosterQueryKey(workspaceId) });
    },
  });

  // 처음 한 번만 묻는 창(#4113). 서버가 켜진 위험 도구를 알렸으면(dangerous_listed) 창으로 한 번에 연결시키지 않고,
  // 경고가 단추 옆에 있는 카드에서 고르게 한다. 운영자에게(카드가 이미 운영자만 그린다) 찾았고 연결할 수 있고 아직 연결 전일 때만,
  // 이 운영자·서버·Hermes 주소로 처음일 때만 뜬다. 뜨는 순간 기억해서, 나중에·닫기·새로고침 모두 다시 묻지 않는다.
  const { session } = useSession();
  const promptKey = cohostedPromptKey({ memberId: session.member.id, workspaceId, endpointLabel: status.endpointLabel });
  const promptable = !offline && connected === null && probe.data?.state === "ok" && probe.data.connectable && probe.data.toolsets !== "dangerous_listed";
  const [promptOpen, setPromptOpen] = useState(false);
  useEffect(() => {
    if (!promptable || wasCohostedPromptShown(promptKey)) return;
    markCohostedPromptShown(promptKey);
    setPromptOpen(true);
  }, [promptable, promptKey]);

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
      {noticeOn && connected !== null && (
        <div
          role="status"
          className="mb-2 flex items-center gap-2 rounded-md bg-ok-soft px-3 py-2 text-body font-semibold text-ok"
          data-testid="ai-cohosted-connected-notice"
        >
          <Check aria-hidden="true" className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{COPY.connectedNotice}</span>
          {connect.data && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="tap-target"
              onClick={() => void openAgentDm(connect.data.agentId, true)}
              data-testid="ai-cohosted-notice-open-dm"
            >
              {COPY.openDm}
            </Button>
          )}
        </div>
      )}
      {connected !== null ? (
        <>
        <div ref={doneRef} tabIndex={-1} className="focus-visible:focus-ring" data-testid="ai-cohosted-connected">
          <AiLineRow
            last
            action={
              <span className="flex items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  className="tap-target"
                  onClick={() => void openAgentDm(connected, true)}
                  data-testid="ai-cohosted-open-dm"
                >
                  {COPY.openDm}
                </Button>
                <Link
                  to={`/agents?agent=${encodeURIComponent(connected)}`}
                  className="press rounded-sm text-body text-ink underline underline-offset-4 focus-visible:focus-ring"
                  data-testid="ai-cohosted-open-agent"
                >
                  {COPY.openAgent}
                </Link>
              </span>
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
      {dmError !== null && <InlineBanner message={dmError} testId="ai-cohosted-dm-error" />}
      {connect.isError && (
        <InlineBanner message={connectErrorMessage(connect.error)} testId="ai-cohosted-connect-error" />
      )}
      <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
        {promptOpen && (
          <DialogContent className="gap-3 p-4" data-testid="ai-cohosted-prompt">
            <DialogTitle className="text-title font-bold break-keep">{COPY.promptTitle}</DialogTitle>
            <DialogDescription className="break-keep text-body text-ink-muted">
              {COPY.foundDetail} {COPY.promptLaterNote}
            </DialogDescription>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                className="tap-target"
                onClick={() => setPromptOpen(false)}
                data-testid="ai-cohosted-prompt-later"
              >
                {COPY.promptLater}
              </Button>
              <Button
                type="button"
                className="tap-target"
                onClick={() => {
                  setPromptOpen(false);
                  connect.mutate();
                }}
                data-testid="ai-cohosted-prompt-connect"
              >
                {COPY.promptConnect}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
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
      <details className="group text-meta text-ink-muted" data-testid="ai-cohosted-more">
        <summary className="-mx-1 flex w-full cursor-pointer list-none items-center gap-1 rounded-sm px-1 py-1 text-meta text-ink-muted hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform group-open:rotate-90" />
          {COPY.moreSummary}
        </summary>
        <div className="mt-1 flex flex-col gap-1">
          <span>{COPY.foundMore}</span>
          {probe.toolsets === "none_listed" && <span>{COPY.toolsetsNone}</span>}
          <span data-testid="ai-cohosted-attest-note">{COPY.attestNote}</span>
          <span>{COPY.volumeNote}</span>
        </div>
      </details>
    </AiLineRow>
  );
}
