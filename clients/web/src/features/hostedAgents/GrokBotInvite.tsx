import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { InlineBanner, Skeleton } from "@/features/common/States";
import type { RosterMember } from "@momo/core/lib/api";
import {
  hostedFailureMessage,
  isHostedOperatorDenied,
} from "@momo/core/features/hostedAgents/model";
import {
  hostedAgentDetected,
  planHostedInvite,
  type HostedInvitePlan,
} from "@momo/core/features/hostedAgents/detect";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { hostedListQuery } from "./hostedCredentialScope";
import type { HostedWizardLaunch } from "./hostedWizardLaunch";
import { useHostedAgentProbe } from "./useHostedAgentProbe";

// =============================================================================
// 데스크탑에서 Grok Bot 이 보이면 한 줄 초대 (T-5 / #1655).
//
// 허브의 「호스티드 에이전트 연결」 버튼은 그대로 둔다. 감지가 실패하거나
// 브라우저 탭이면 이 줄은 마운트되지 않고, 사람은 그 버튼으로 위저드에 들어간다.
// 위저드 단계 구조는 이 줄이 바꾸지 않는다. 넘기는 것은 identity 프리필과
// 첫 발급 한 번뿐이다.
//
// 네 상태:
//   빈      미감지·비데스크탑·권한 없음 → 그리지 않음 (침묵이 빈 상태다)
//   로딩    감지된 뒤 연결 목록을 읽는 동안 한 줄 스켈레톤
//           오프라인이고 목록이 아직 없으면 스켈레톤 대신 침묵
//   오류    목록을 못 읽음 → 인라인 배너 + 다시 시도. 위저드 수동 진입은 남는다
//   오프라인 허브가 이미 배너를 세운다. 목록이 있으면 이 줄은 버튼을 잠근다
// =============================================================================

export function GrokBotInvite({
  mayCreate,
  offline,
  members,
  onLaunch,
}: {
  mayCreate: boolean;
  offline: boolean;
  members: readonly RosterMember[];
  onLaunch: (launch: HostedWizardLaunch, opener: HTMLButtonElement) => void;
}) {
  const { workspaceId } = useSession();
  const { desktop, ready, probes } = useHostedAgentProbe();
  const list = useQuery({
    ...hostedListQuery(workspaceId),
    enabled:
      mayCreate &&
      desktop &&
      ready &&
      probes.some(hostedAgentDetected),
  });

  if (!mayCreate || !desktop || !ready) return null;
  if (!probes.some(hostedAgentDetected)) return null;

  if (list.isPending) {
    if (offline) return null;
    return (
      <div role="status" className="border-b border-line px-4 py-2" data-testid="grokbot-invite-loading">
        <span className="sr-only">그록봇 연결 상태를 확인하는 중입니다.</span>
        <Skeleton ready={false} rows={1} className="p-0" />
      </div>
    );
  }

  if (list.isError) {
    if (isHostedOperatorDenied(list.error) || serverSaysAbsent(list.error)) {
      return null;
    }
    return (
      <InlineBanner
        message={hostedFailureMessage("list", list.error)}
        actionLabel="다시 시도"
        onAction={() => void list.refetch()}
        testId="grokbot-invite-error"
      />
    );
  }

  const plan = planHostedInvite({
    probes,
    members,
    connections: list.data ?? [],
  });
  if (!plan) return null;

  return (
    <InviteRow plan={plan} offline={offline} onLaunch={onLaunch} />
  );
}

function InviteRow({
  plan,
  offline,
  onLaunch,
}: {
  plan: HostedInvitePlan;
  offline: boolean;
  onLaunch: (launch: HostedWizardLaunch, opener: HTMLButtonElement) => void;
}) {
  const launch: HostedWizardLaunch = {
    presetId: "grok",
    displayName: plan.displayName,
    handle: plan.handle,
    ...(plan.connectionId ? { connectionId: plan.connectionId } : {}),
    ...(plan.autoAdvance ? { autoAdvance: plan.autoAdvance } : {}),
  };

  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2"
      data-testid="grokbot-invite"
      data-invite-kind={plan.kind}
    >
      <p className="min-w-0 break-keep text-body text-ink">{plan.prompt}</p>
      <Button
        type="button"
        size="sm"
        aria-disabled={offline || undefined}
        aria-label={
          offline
            ? `${plan.actionLabel}. 연결이 끊겨 지금은 할 수 없습니다`
            : undefined
        }
        className={cn(offline && "opacity-50")}
        onClick={(event) => {
          if (offline) return;
          onLaunch(launch, event.currentTarget);
        }}
        data-testid="grokbot-invite-action"
      >
        {plan.actionLabel}
      </Button>
    </div>
  );
}
