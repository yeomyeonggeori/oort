import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { uuidEq, type AgentLivenessState } from "@momo/core/lib/api";
import {
  DoorbellRingLimitedError,
  ringHostedDoorbell,
} from "@momo/core/features/hostedAgents/api";
import {
  canOfferWake,
  WAKE_LABEL,
  WAKE_REQUESTED_SENTENCE,
  wakeCooldownLabel,
  wakeFailureText,
} from "@momo/core/features/agents/liveness";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { agentLivenessQueryKey } from "./useAgentLiveness";
import { setWakeCooldown, useWakeCooldownUntil } from "./wakeCooldownStore";
import { useTickingNow } from "./agentWorkingSignal";

// =============================================================================
// 「다시 깨우기」 (ADR-0200 D4, 서버 S4 #3743). 도어벨 수동 ring **요청**이다: 전달이
// 아니라 접수이고, 에이전트가 정말 일을 가져가는지는 곧이어 라벨이 말한다.
//
// 보이는 사람: 워크스페이스 owner/admin. 서버는 연결을 만든 사람과 에이전트 소유자도
// 허용하지만, 그 사람들은 연결 목록(owner/admin 전용 읽기)에서 연결 id를 얻을 길이
// 없어 이 화면에서는 버튼을 세울 수 없다 — 문이 없는 자리에 누를 수 없는 버튼을
// 세우지 않는다. 눌러도 되는 상태(응답 중이 아님·연결이 켜져 있음)에서만 선다.
//
// 쿨다운(60초·시간당 5회)은 서버가 센다. 서버가 준 다음 가능 시각을 보여 주고,
// 429가 오면 그 `retryAfterSeconds`를 그대로 쓴다. 이 기기의 시계와 서버 시계가
// 다를 수 있어 서버가 준 **간격**(next − requested)만 이 기기의 시계에 얹는다.
// =============================================================================

export function WakeAgentButton({
  agentId,
  state,
  className,
}: {
  agentId: string;
  state: AgentLivenessState;
  className?: string;
}) {
  const { session, workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  const client = useQueryClient();
  const selfRole = memberFor(directory, session.member.id)?.role;
  const mayList = selfRole === "owner" || selfRole === "admin";
  const offer = canOfferWake(state);

  const connections = useQuery({
    ...hostedListQuery(workspaceId),
    enabled: mayList && offer,
    staleTime: 60_000,
  });
  const connection = connections.data?.find(
    (row) => uuidEq(row.agentMemberId, agentId) && row.status === "active"
  );
  const connectionId = connection?.id ?? null;

  const coolUntil = useWakeCooldownUntil(connectionId);
  const cooling = coolUntil !== undefined && coolUntil > Date.now();
  const nowMs = useTickingNow(cooling);

  const ring = useMutation({
    mutationFn: () => ringHostedDoorbell(workspaceId, connectionId as string),
    onSuccess: (result) => {
      if (connectionId === null) return;
      setWakeCooldown(
        connectionId,
        Date.now() + Math.max(0, result.nextAllowedAtMs - result.requestedAtMs)
      );
      void client.invalidateQueries({
        queryKey: agentLivenessQueryKey(workspaceId, agentId),
      });
    },
    onError: (error) => {
      if (connectionId !== null && error instanceof DoorbellRingLimitedError) {
        setWakeCooldown(connectionId, Date.now() + error.retryAfterSeconds * 1000);
      }
    },
  });

  if (!mayList || !offer || connectionId === null) return null;

  const cooldownText =
    coolUntil === undefined ? undefined : wakeCooldownLabel(coolUntil, nowMs);
  const failed =
    ring.isError && !(ring.error instanceof DoorbellRingLimitedError)
      ? wakeFailureText(ring.error)
      : undefined;
  const status =
    failed ??
    cooldownText ??
    (ring.isSuccess ? WAKE_REQUESTED_SENTENCE : undefined);

  return (
    <div
      className={className ?? "flex min-w-0 flex-col items-start gap-1"}
      data-testid="wake-agent"
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={ring.isPending || cooldownText !== undefined}
        onClick={() => ring.mutate()}
        data-testid="wake-agent-button"
      >
        {WAKE_LABEL}
      </Button>
      {/* 접수 결과와 남은 쿨다운. 버튼이 비활성인 이유를 글로 말한다(색만이 아니라). */}
      <p
        className="break-keep text-timestamp text-ink-muted"
        role="status"
        aria-live="polite"
        data-testid="wake-agent-status"
      >
        {status}
      </p>
    </div>
  );
}
