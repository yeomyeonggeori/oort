import { useMemo, type ReactNode } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { Button } from "@/design/ui/button";
import { Skeleton } from "@/features/common/States";
import { useSession } from "@/app/session";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { useSurfaceProvided } from "@/features/capabilities/useSurfaceProvided";
import {
  fetchSessionEvents,
  sessionThreadKey,
  useWorkHosts,
  useWorkSessionRail,
  useWorkSessions,
} from "@/features/work/useWorkSessions";
import { eventsForSession, workHostName } from "@momo/core/features/work/workSessionModel";
import {
  agentPaneModel,
  openableAgentSessions,
  type AgentPaneBindings,
  type AgentPaneModel,
} from "@momo/core/features/workbench/agentPane";
import type { SessionStatus } from "@momo/core/features/workbench/sessionList";
import { ApiError, decideWorkPermission, type WorkSession } from "@momo/core/lib/api";
import { fetchHumanControlSignatureRequired } from "@momo/core/features/auth/deviceKeys";
import {
  HUMAN_SIGNATURE_REFUSAL,
  instructFrom,
  type InstructFrom,
} from "@momo/core/features/auth/humanSignature";
import { isDesktop } from "@/lib/tauri";
import { AgentProgressView, type AgentPaneActions } from "./AgentProgressView";
import { agentPaneStore, useAgentPaneBindings, type AgentPaneStore } from "./agentPanes";

// =============================================================================
// 격자가 A 칸을 그리는 데 필요한 것(#2779). 도크(LocalTerminalDock)는 이 모양만 알고
// 서버를 모른다. 제품은 `useAgentPaneSource`가, 디자인 하네스는 흉내 원천이 채운다.
// =============================================================================

export interface AgentPaneSummary {
  title: string;
  harness: string;
  status: SessionStatus;
  /** 「나를 기다림」일 때 칸 바닥 띠 한 줄. */
  waitingLine: string | null;
}

export interface AgentSessionOption {
  id: string;
  label: string;
  harness: string;
  hostName: string | null;
  status: SessionStatus;
}

export interface AgentPaneSource {
  store: AgentPaneStore;
  bindings: AgentPaneBindings;
  /** 「새 세션」 메뉴의 에이전트 세션들. 이 서버에 작업 표면이 없으면 빈 목록. */
  candidates: readonly AgentSessionOption[];
  summary(sessionId: string): AgentPaneSummary | null;
  render(sessionId: string, paneId: string): ReactNode;
}

/** 에이전트 레인 표지(칸 머리·목록). 색이 아니라 글과 아이콘으로 말한다. */
export const AGENT_LANE_LABEL = "에이전트 · oort에 기록";
export const LOCAL_LANE_LABEL = "로컬";

export function AgentLaneIcon({ className }: { className?: string }) {
  return <Bot aria-hidden className={className} />;
}

/** 모델 하나로 칸 머리 요약을 만든다(제품·하네스 공용). */
export function summaryOf(model: AgentPaneModel): AgentPaneSummary {
  const pending = model.permission;
  return {
    title: model.goal,
    harness: model.harness,
    // 관전자에게 권한 요청은 「나를 기다림」이 아니고 도는 것도 아니다: 빈 원(대기).
    status: pending && !model.viewerIsOwner ? "idle" : model.status,
    waitingLine:
      model.status === "waiting" && pending
        ? pending.tool?.headline ?? "권한 확인을 기다려요"
        : null,
  };
}

/**
 * 권한 결정은 #3000 라우트로 간다(ADR-0188 §8.6). 지시(답장)는 R2의 기기 키 서명
 * 전까지 길이 없다. 카드는 서버의 `approval.decided`가 실시간으로 오면 닫힌다.
 * 실시간을 놓쳤을 때를 위해 결정이 닿으면 스레드를 한 번 다시 읽는다.
 */
export function agentRoutes(
  workspaceId: string,
  afterDecide: () => void = () => {},
  onSignatureRequired: () => void = () => {}
): AgentPaneActions {
  return {
    decide: async ({ sessionId, requestEventId, optionId, kind }) => {
      try {
        await decideWorkPermission(workspaceId, sessionId, { requestEventId, optionId, kind });
        afterDecide();
      } catch (err) {
        // 서버가 서명을 요구한다고 답했다: 플래그를 다시 읽어 칸을 안내로 바꾼다(D-4).
        if (err instanceof ApiError && err.code === HUMAN_SIGNATURE_REFUSAL.required) onSignatureRequired();
        // 서버가 결론을 낸 거절(409·403·404)도 스레드를 다시 읽는다: 다른 기기의 결정이나
        // host 철회가 남긴 `approval.decided`가 칸 머리의 「나를 기다림」을 거둔다.
        if (err instanceof ApiError && err.status >= 400 && err.status < 500) afterDecide();
        throw err;
      }
    },
    reply: null,
  };
}

function PaneMissing({ onClear, loading }: { onClear: () => void; loading: boolean }) {
  if (loading) return <Skeleton ready={false} rows={4} className="p-4" />;
  return (
    <div className="flex flex-col items-start gap-2 p-4" data-testid="agent-pane-missing">
      <p className="text-body text-ink">이 칸의 에이전트 세션을 찾지 못했어요. 끝난 지 오래되었거나 볼 권한이 없어요.</p>
      <Button type="button" size="sm" variant="secondary" onClick={onClear}>
        칸 비우기
      </Button>
    </div>
  );
}

function PaneError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2 p-4" data-testid="agent-pane-error">
      <p className="text-body text-ink">진행을 읽지 못했어요. 연결을 확인한 뒤 다시 읽으세요.</p>
      <Button type="button" size="sm" variant="secondary" onClick={onRetry}>
        다시 읽기
      </Button>
    </div>
  );
}

export const SIGNING_REQUIRED_KEY = (workspaceId: string) =>
  ["device-keys", workspaceId, "signing-context", "human-control-required"] as const;

/**
 * 이 화면에서 허락·지시를 보내는가(ADR-0146 개정 D-4 · D-11, #3029). 데스크탑 셸은
 * 묻지 않는다(서명 명령이 있다, 카드 배선은 E8 #3028). 일반 브라우저는 서버가
 * `humanControlSignatureRequired: true`라고 말할 때만 안내로 바꾼다. 읽는 중·모름
 * (E3 이전 서버 404, `MOMO_INSTANCE_ID` 없음 503, 네트워크)은 지금 동작 그대로다.
 */
export function useInstructFrom(workspaceId: string, enabled: boolean): {
  from: InstructFrom;
  recheck: () => void;
} {
  const desktopShell = isDesktop();
  const client = useQueryClient();
  const key = SIGNING_REQUIRED_KEY(workspaceId);
  const query = useQuery({
    queryKey: key,
    queryFn: () => fetchHumanControlSignatureRequired(workspaceId),
    enabled: enabled && !desktopShell,
    staleTime: 5 * 60_000,
  });
  return {
    from: instructFrom({ desktopShell, signatureRequired: query.data ?? null }),
    recheck: () => void client.invalidateQueries({ queryKey: key }),
  };
}

/**
 * 제품 원천. 칸에 묶인 세션의 스레드만 읽는다(묶이지 않은 세션은 목록 한 줄뿐).
 * 실시간은 작업 콘솔과 같은 레일을 쓴다.
 */
export function useAgentPaneSource(): AgentPaneSource {
  const { workspaceId, session: auth, connStatus } = useSession();
  const store = agentPaneStore();
  const bindings = useAgentPaneBindings(store);
  const workOn = useSurfaceProvided("work");
  const sessionsQuery = useWorkSessions(workspaceId, undefined, workOn);
  const hostsQuery = useWorkHosts(workspaceId, undefined, workOn);
  const all = useMemo(() => sessionsQuery.data ?? [], [sessionsQuery.data]);
  const hosts = hostsQuery.data;
  const viewer = auth.member.id;
  const { directory } = useDirectory(workspaceId);
  const instruct = useInstructFrom(workspaceId, workOn);

  const boundIds = useMemo(() => [...new Set(Object.values(bindings))], [bindings]);
  const bound = useMemo(
    () => all.filter((s) => boundIds.some((id) => id.toLowerCase() === s.id.toLowerCase())),
    [all, boundIds]
  );
  const rail = useWorkSessionRail(workspaceId, bound, null);
  const threads = useQueries({
    queries: bound.map((s) => ({
      queryKey: sessionThreadKey(workspaceId, s.channelId, s.rootMessageId),
      queryFn: () => fetchSessionEvents(workspaceId, s.channelId, s.rootMessageId),
    })),
  });

  const models = useMemo(() => {
    const out = new Map<
      string,
      { model: AgentPaneModel | null; ownerId: string; loading: boolean; error: boolean; refetch: () => void }
    >();
    bound.forEach((s: WorkSession, i) => {
      const q = threads[i];
      const page = q?.data;
      const live = eventsForSession(rail.liveEvents, s.id);
      const durable = page?.events ?? [];
      const model =
        page || live.length > 0
          ? agentPaneModel({
              session: s,
              events: [...durable, ...live.filter((e) => !durable.some((d) => d.eventId.toLowerCase() === e.eventId.toLowerCase()))],
              truncated: page?.truncated ?? false,
              skipped: page?.skipped ?? 0,
              viewerMemberId: viewer,
              hostName: workHostName(s, hosts),
            })
          : null;
      out.set(s.id.toLowerCase(), {
        model,
        ownerId: s.memberId,
        loading: q?.isPending ?? true,
        error: q?.isError ?? false,
        refetch: () => void q?.refetch(),
      });
    });
    return out;
  }, [bound, threads, rail.liveEvents, viewer, hosts]);

  const candidates = useMemo(
    () =>
      openableAgentSessions(all, viewer).map((s) => ({
        id: s.id,
        label: s.label,
        harness: s.tool,
        hostName: workHostName(s, hosts),
        status: (s.status === "running" ? "running" : s.status === "idle" ? "review" : "stopped") as SessionStatus,
      })),
    [all, viewer, hosts]
  );

  return {
    store,
    bindings,
    candidates,
    summary(sessionId) {
      const entry = models.get(sessionId.toLowerCase());
      return entry?.model ? summaryOf(entry.model) : null;
    },
    render(sessionId, paneId) {
      const entry = models.get(sessionId.toLowerCase());
      if (!entry) {
        return <PaneMissing loading={sessionsQuery.isPending} onClear={() => store.unbind(paneId)} />;
      }
      if (entry.error && !entry.model) return <PaneError onRetry={entry.refetch} />;
      if (!entry.model) return <Skeleton ready={false} rows={4} className="p-4" />;
      return (
        <>
          {connStatus === "disconnected" ? (
            <p className="shrink-0 border-b border-line px-4 py-1 text-meta text-ink-muted" data-testid="agent-pane-offline">
              연결이 끊겨 새 진행을 받지 못하고 있어요. 받은 데까지 보여요.
            </p>
          ) : null}
          <AgentProgressView
            model={entry.model}
            // 세션 소유자의 이름(보는 사람이 아니다). 모르면 「소유자」로 말한다.
            ownerName={entry.ownerId ? memberFor(directory, entry.ownerId)?.displayName ?? null : null}
            actions={agentRoutes(workspaceId, entry.refetch, instruct.recheck)}
            offline={connStatus === "disconnected"}
            instructFrom={instruct.from}
          />
        </>
      );
    },
  };
}
