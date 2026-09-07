import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { HostedAgentWizard } from "@/features/hostedAgents/HostedAgentWizard";
import { HostedConnectionSection } from "@/features/hostedAgents/HostedConnectionSection";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { doorbellProjection } from "@momo/core/features/hostedAgents/doorbell";
import {
  hostedFailureMessage,
  hostedStatusDetail,
  hostedStatusLabel,
  hostedStatusTone,
  isHostedOperatorDenied,
  type HostedAgentConnection,
  type HostedChipTone,
} from "@momo/core/features/hostedAgents/model";
import {
  HOSTED_CREATED_LABEL,
  HOSTED_UPDATED_LABEL,
  hostedConnectionTimes,
  hostedListRow,
} from "@momo/core/features/hostedAgents/status";
import { regenerateGate } from "@momo/core/features/hostedAgents/wizard";
import { uuidEq } from "@momo/core/lib/api";
import {
  OperatorNotice,
  SectionShell,
  StatusChip,
  type ChipTone,
} from "./SettingsFields";
import { formatMoment } from "./oauthGrant";

// =============================================================================
// 설정 › 연결 › 에이전트 자격 (#2204).
//
// 목록은 이 화면의 것이고, 발급·재발급·해제·도어벨은 이미 있는 표면을 연다.
// 위저드·1회용 카드·해제 장부를 여기 복제하지 않는다. 1회용 연결 값은 목록에
// 없고, 위저드 안의 OneTimeSecretCard 에만 선다.
// =============================================================================

function chipTone(tone: HostedChipTone): ChipTone {
  return tone === "neutral" ? "muted" : tone;
}

function doorbellLabel(connection: HostedAgentConnection): string {
  return doorbellProjection(connection) ? "있음" : "없음";
}

export function AgentCredentialsSection({ offline }: { offline: boolean }) {
  const { workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  const list = useQuery(hostedListQuery(workspaceId));

  const [wizardOpen, setWizardOpen] = useState(false);
  const [launch, setLaunch] = useState<HostedWizardLaunch | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [wizardOpener, setWizardOpener] = useState<HTMLButtonElement | null>(
    null
  );

  const rows = list.data ?? [];
  const selected =
    rows.find((row) => uuidEq(row.agentMemberId, selectedAgentId ?? "")) ?? null;
  const selectedLabel =
    selected === null
      ? ""
      : (memberFor(directory, selected.agentMemberId)?.displayName ??
        hostedListRow(selected, "에이전트").title);

  const openIssue = () => {
    setLaunch(null);
    setWizardOpen(true);
  };

  const openRegenerate = (row: HostedAgentConnection) => {
    const member = memberFor(directory, row.agentMemberId);
    setSelectedAgentId(row.agentMemberId);
    setLaunch({
      presetId: "generic",
      displayName: member?.displayName ?? hostedListRow(row, "에이전트").title,
      handle: member?.handle ?? "",
      connectionId: row.id,
      autoAdvance: "regenerate",
    });
    setWizardOpen(true);
  };

  const writesLocked = offline;

  return (
    <div data-testid="agent-credentials-section">
      <SectionShell
        title="에이전트 자격"
        lines={[
          "다른 인프라에서 도는 에이전트를 이 워크스페이스에 들이는 연결입니다.",
          "1회용 연결 값은 발급 직후 한 번만 보입니다. 해제는 서버가 끊겼다고 답할 때까지 진행 중입니다.",
        ]}
      >
        {list.isPending && (
          <div role="status" data-testid="agent-credentials-loading">
            <span className="sr-only">연결 목록을 불러오는 중입니다.</span>
            <Skeleton ready={false} rows={3} className="p-0" />
          </div>
        )}

        {list.isError && isHostedOperatorDenied(list.error) && (
          <OperatorNotice
            who="에이전트 자격은 워크스페이스 오너와 관리자만 볼 수 있습니다."
            contact="봐야 한다면 이 워크스페이스의 오너에게 문의하세요."
          />
        )}

        {list.isError && !isHostedOperatorDenied(list.error) && (
          <InlineBanner
            message={hostedFailureMessage("list", list.error)}
            actionLabel="다시 시도"
            onAction={() => void list.refetch()}
            testId="agent-credentials-error"
          />
        )}

        {list.isSuccess && rows.length === 0 && (
          <EmptyInvite
            headline="아직 연결된 에이전트가 없습니다."
            detail="자격을 발급하면 1회용 연결 값이 한 번 열립니다. 그 값으로 에이전트가 합류합니다."
            className="px-0"
            actions={
              <Button
                type="button"
                size="sm"
                aria-disabled={writesLocked || undefined}
                className={cn(writesLocked && "opacity-50")}
                onClick={(event) => {
                  if (writesLocked) return;
                  setWizardOpener(event.currentTarget);
                  openIssue();
                }}
                data-testid="agent-credentials-issue"
              >
                새 자격 발급
              </Button>
            }
            testId="agent-credentials-empty"
          />
        )}

        {list.isSuccess && rows.length > 0 && (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                size="sm"
                aria-disabled={writesLocked || undefined}
                className={cn(writesLocked && "opacity-50")}
                onClick={(event) => {
                  if (writesLocked) return;
                  setWizardOpener(event.currentTarget);
                  openIssue();
                }}
                data-testid="agent-credentials-issue"
              >
                새 자격 발급
              </Button>
            </div>

            <ul
              className="flex flex-col overflow-hidden rounded-md border border-line"
              data-testid="agent-credentials-list"
            >
              {rows.map((row) => {
                const member = memberFor(directory, row.agentMemberId);
                const view = hostedListRow(
                  row,
                  member?.displayName ?? "에이전트"
                );
                const times = hostedConnectionTimes(row);
                const selectedRow = uuidEq(row.agentMemberId, selectedAgentId ?? "");
                const gate = regenerateGate(row);
                return (
                  <li
                    key={row.id}
                    className={cn(
                      "flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0",
                      selectedRow && "bg-surface-hover"
                    )}
                    data-testid="agent-credentials-row"
                    data-connection-id={row.id}
                  >
                    <button
                      type="button"
                      aria-pressed={selectedRow}
                      className="flex w-full min-w-0 flex-col items-start gap-1 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
                      onClick={() => setSelectedAgentId(row.agentMemberId)}
                      data-testid="agent-credentials-row-select"
                    >
                      <span className="flex min-w-0 flex-wrap items-center gap-2">
                        <span className="min-w-0 truncate text-body text-ink">
                          {view.title}
                        </span>
                        <StatusChip tone={chipTone(hostedStatusTone(row.status))}>
                          {hostedStatusLabel(row.status)}
                        </StatusChip>
                      </span>
                      <span className="break-keep text-meta text-ink-muted">
                        {hostedStatusDetail(row)}
                      </span>
                      <span className="break-keep text-meta text-ink-muted">
                        {times
                          .map((fact) =>
                            fact.label === HOSTED_CREATED_LABEL
                              ? `${HOSTED_CREATED_LABEL} ${formatMoment(fact.atMs)}`
                              : `${HOSTED_UPDATED_LABEL} ${formatMoment(fact.atMs)}`
                          )
                          .join(" · ")}
                      </span>
                      <span className="break-keep text-meta text-ink-muted">
                        도어벨 {doorbellLabel(row)}
                      </span>
                    </button>
                    {gate.allowed ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-disabled={writesLocked || undefined}
                        className={cn(
                          "self-start",
                          writesLocked && "opacity-50"
                        )}
                        onClick={(event) => {
                          if (writesLocked) return;
                          setWizardOpener(event.currentTarget);
                          openRegenerate(row);
                        }}
                        data-testid="agent-credentials-regenerate"
                      >
                        재발급
                      </Button>
                    ) : (
                      <p className="break-keep text-meta text-ink-muted">
                        {gate.blockedCopy}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {writesLocked && list.isSuccess && (
          <p
            className="break-keep text-meta text-ink-muted"
            data-testid="agent-credentials-offline"
          >
            연결이 끊겨 지금은 자격을 발급하거나 바꿀 수 없습니다.
          </p>
        )}

        {selected !== null && (
          <HostedConnectionSection
            key={selected.agentMemberId}
            agentMemberId={selected.agentMemberId}
            agentLabel={selectedLabel}
            offline={offline}
          />
        )}
      </SectionShell>

      <HostedAgentWizard
        open={wizardOpen}
        onOpenChange={(open) => {
          setWizardOpen(open);
          if (!open) setLaunch(null);
        }}
        opener={wizardOpener}
        launch={launch}
        entry="settings"
      />
    </div>
  );
}
