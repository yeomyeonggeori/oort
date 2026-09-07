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
import { hostedPresetIdForMember } from "@momo/core/features/hostedAgents/detect";
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
  HOSTED_UPDATED_LABEL,
  hostedConnectionTimes,
  hostedListRow,
} from "@momo/core/features/hostedAgents/status";
import { regenerateGate } from "@momo/core/features/hostedAgents/wizard";
import { uuidEq } from "@momo/core/lib/api";
import {
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  StatusChip,
  type ChipTone,
  type KeyValue,
} from "./SettingsFields";
import { formatMoment } from "./oauthGrant";

// =============================================================================
// 설정 › 연결 › 에이전트 자격 (#2204).
//
// 목록은 이 화면의 것이고, 발급·재발급·해제·도어벨은 이미 있는 표면을 연다.
// 위저드·1회용 카드·해제 장부를 여기 복제하지 않는다. 1회용 연결 값은 목록에
// 없고, 위저드 안의 OneTimeSecretCard 에만 선다.
// =============================================================================

const CREDENTIALS_OFFLINE_NOTE_ID = "agent-credentials-offline-note";
const CREDENTIALS_OFFLINE_REASON =
  "연결이 끊겨 지금은 자격을 발급하거나 바꿀 수 없습니다.";

function chipTone(tone: HostedChipTone): ChipTone {
  return tone === "neutral" ? "muted" : tone;
}

function doorbellLabel(connection: HostedAgentConnection): string {
  return doorbellProjection(connection) ? "있음" : "없음";
}

function rowFacts(row: HostedAgentConnection): KeyValue[] {
  const times = hostedConnectionTimes(row).filter(
    (fact) =>
      fact.label !== HOSTED_UPDATED_LABEL || fact.atMs !== row.createdAtMs
  );
  return [
    { key: "상태", value: hostedStatusDetail(row), prose: true },
    ...times.map((fact) => ({
      key: fact.label,
      value: formatMoment(fact.atMs),
    })),
    { key: "도어벨", value: doorbellLabel(row) },
  ];
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
      presetId: hostedPresetIdForMember(member),
      displayName: member?.displayName ?? hostedListRow(row, "에이전트").title,
      handle: member?.handle ?? "",
      connectionId: row.id,
      autoAdvance: "regenerate",
    });
    setWizardOpen(true);
  };

  const writesLocked = offline;

  /**
   * 잠긴 컨트롤이 가리키는 사유 (#1542 규율 · design-review #1557 M · #1559).
   *
   * `aria-disabled` 로 tab order 에 남게 된 뒤로 그 침묵은 더 크게 들린다 —
   * 초점은 닿는데 왜 못 하는지는 컨트롤이 가리키는 문장에 있어야 한다.
   */
  function lockReason(): string | undefined {
    if (offline) return CREDENTIALS_OFFLINE_NOTE_ID;
    return undefined;
  }

  const issueButton = (testId: string) => (
    <Button
      type="button"
      size="sm"
      aria-disabled={writesLocked || undefined}
      aria-describedby={lockReason()}
      className={cn(writesLocked && "opacity-50")}
      onClick={(event) => {
        if (writesLocked) return;
        setWizardOpener(event.currentTarget);
        openIssue();
      }}
      data-testid={testId}
    >
      새 자격 발급
    </Button>
  );

  const offlineReason = writesLocked && list.isSuccess && (
    <p
      id={CREDENTIALS_OFFLINE_NOTE_ID}
      className="break-keep text-meta text-ink-muted"
      data-testid="agent-credentials-offline"
    >
      {CREDENTIALS_OFFLINE_REASON}
    </p>
  );

  return (
    <div data-testid="agent-credentials-section">
      <SectionShell
        title="에이전트 자격"
        lines={[
          "다른 인프라에서 도는 에이전트를 이 워크스페이스에 들이는 연결입니다.",
          "1회용 연결 값은 발급 직후 한 번만 보입니다. 해제는 서버가 끊겼다고 답한 뒤에야 끝납니다.",
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
            className="px-0"
            testId="agent-credentials-error"
          />
        )}

        {list.isSuccess && rows.length === 0 && (
          <div className="flex min-w-0 flex-col gap-2">
            <EmptyInvite
              headline="아직 연결된 에이전트가 없습니다."
              detail="자격을 발급하면 1회용 연결 값이 한 번 열립니다. 그 값으로 에이전트가 합류합니다."
              className="px-0"
              actions={issueButton("agent-credentials-issue")}
              testId="agent-credentials-empty"
            />
            {offlineReason}
          </div>
        )}

        {list.isSuccess && rows.length > 0 && (
          <div className="flex min-w-0 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {issueButton("agent-credentials-issue")}
            </div>
            {offlineReason}

            <ul
              className="flex flex-col overflow-hidden rounded-md border border-line"
              data-testid="agent-credentials-list"
            >
              {rows.map((row) => {
                const member = memberFor(directory, row.agentMemberId);
                const fullName = member?.displayName ?? "에이전트";
                const selectedRow = uuidEq(
                  row.agentMemberId,
                  selectedAgentId ?? ""
                );
                const gate = regenerateGate(row);
                return (
                  <li
                    key={row.id}
                    className={cn(
                      "flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0",
                      selectedRow ? "bg-accent-soft" : "hover:bg-surface-hover"
                    )}
                    data-testid="agent-credentials-row"
                    data-connection-id={row.id}
                    data-selected={selectedRow ? "" : undefined}
                  >
                    <div className="flex min-w-0 items-center gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-body text-ink"
                        title={fullName}
                        aria-label={fullName}
                      >
                        {fullName}
                      </span>
                      <StatusChip
                        tone={chipTone(hostedStatusTone(row.status))}
                      >
                        {hostedStatusLabel(row.status)}
                      </StatusChip>
                    </div>
                    <KeyValueRows rows={rowFacts(row)} />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-describedby={lockReason()}
                        onClick={() => setSelectedAgentId(row.agentMemberId)}
                        data-testid="agent-credentials-disconnect"
                      >
                        해제
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        aria-describedby={lockReason()}
                        onClick={() => setSelectedAgentId(row.agentMemberId)}
                        data-testid="agent-credentials-doorbell"
                      >
                        도어벨
                      </Button>
                      {gate.allowed ? (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          aria-disabled={writesLocked || undefined}
                          aria-describedby={lockReason()}
                          className={cn(writesLocked && "opacity-50")}
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
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {selected !== null && (
          <HostedConnectionSection
            key={selected.agentMemberId}
            agentMemberId={selected.agentMemberId}
            agentLabel={selectedLabel}
            title={selectedLabel}
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
