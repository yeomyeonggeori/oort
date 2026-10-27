import { useId } from "react";
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
  wakeLimitedText,
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
  const noteId = useId();

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
  const limited =
    ring.error instanceof DoorbellRingLimitedError ? ring.error : undefined;
  const failed = ring.isError && limited === undefined ? wakeFailureText(ring.error) : undefined;
  // 낭독되는 안내(라이브 영역)는 **상태가 바뀔 때 한 번**이다: 접수됐다 / 한도에 닿았다 /
  // 깨우지 못했다. 1초마다 바뀌는 쿨다운 숫자는 이 영역에 넣지 않는다 — 스크린리더가
  // 60번 연달아 읽게 된다(design-review U3 H-1). 이 영역은 눈에는 보이지 않고(sr-only),
  // 눈이 읽는 것은 버튼 옆 한 줄이다.
  const announce = limited
    ? wakeLimitedText(limited.retryAfterSeconds)
    : (failed ?? (ring.isSuccess ? WAKE_REQUESTED_SENTENCE : ""));
  // 눈이 읽는 한 줄: 왜 지금 못 누르는가(쿨다운)나 왜 못 깨웠는가. 버튼 옆에 한 줄로
  // 서서 문구가 나타나도 머리의 높이가 변하지 않는다(design-review U3 M-4).
  // 앞머리(「깨웠어요」「시간당 깨우기 한도에 닿았어요」)는 **쿨다운이 진행 중일 때만** 말한다:
  // 쿨다운이 끝난 뒤에도 남아 있으면 이미 지난 일이 현재형 안내처럼 읽힌다(design-review U3
  // 재검수 M-1).
  const lead =
    cooldownText === undefined
      ? undefined
      : limited
        ? wakeLimitedText(limited.retryAfterSeconds).replace(/\.$/, "")
        : ring.isSuccess
          ? "깨웠어요"
          : undefined;
  const note =
    failed ?? ([lead, cooldownText].filter(Boolean).join(" · ") || undefined);

  return (
    <div
      className={className ?? "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"}
      data-testid="wake-agent"
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        // 폰 폭(<600)에서 44: 대화의 예외 줄(#4619)에서는 자기 줄을 갖는 1급 컨트롤이다. 데스크탑 폭에서는 아무 일도 없다.
        className="tap-target"
        disabled={ring.isPending || cooldownText !== undefined}
        onClick={() => ring.mutate()}
        data-testid="wake-agent-button"
        aria-describedby={note !== undefined ? noteId : undefined}
      >
        {WAKE_LABEL}
      </Button>
      {note !== undefined && (
        <span
          id={noteId}
          className="min-w-0 break-keep text-timestamp text-ink-muted"
          data-testid="wake-agent-cooldown"
        >
          {note}
        </span>
      )}
      <p className="sr-only" role="status" aria-live="polite" data-testid="wake-agent-status">
        {announce}
      </p>
    </div>
  );
}
