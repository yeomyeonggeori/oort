import { useState, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { HostedAgentWizard } from "@/features/hostedAgents/HostedAgentWizard";
import { TruncatingName } from "@/features/hostedAgents/TruncatingName";
import {
  HostedConnectionSection,
  type HostedLedgerLanding,
} from "@/features/hostedAgents/HostedConnectionSection";
import { hostedListQuery } from "@/features/hostedAgents/hostedCredentialScope";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { hostedPresetIdForMember } from "@momo/core/features/hostedAgents/detect";
import {
  hostedFailureMessage,
  hostedStatusLabel,
  hostedStatusTone,
  isHostedOperatorDenied,
  type HostedAgentConnection,
  type HostedChipTone,
} from "@momo/core/features/hostedAgents/model";
import { hostedListRow } from "@momo/core/features/hostedAgents/status";
import { regenerateGate } from "@momo/core/features/hostedAgents/wizard";
import { relativeLabel } from "@momo/core/features/inbox/model";
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
//
// 목록 키는 연결 `id` 다. 부분 unique index 때문에 한 에이전트 멤버가 만료 행과
// 살아 있는 행을 동시에 가질 수 있고, 멤버 id 로 고르면 장부가 다른 연결을 연다.
// =============================================================================

const CREDENTIALS_OFFLINE_NOTE_ID = "agent-credentials-offline-note";
const CREDENTIALS_OFFLINE_REASON =
  "연결이 끊겨 지금은 자격을 발급하거나 바꿀 수 없습니다.";

export type CredentialsRowAction = "disconnect" | "doorbell" | "record";

/** 행 액션이 장부를 어느 `data-landing` 에 내릴지. 도어벨만 섹션으로 내린다. */
export function ledgerLandingFor(
  action: CredentialsRowAction
): HostedLedgerLanding {
  return action === "doorbell" ? "doorbell" : "heading";
}

/** 목록에서 고른 연결. 멤버 id 가 아니라 연결 id 로만 찾는다. */
export function hostedRowByConnectionId<T extends { id: string }>(
  rows: readonly T[],
  connectionId: string | null
): T | null {
  if (connectionId === null) return null;
  return rows.find((row) => uuidEq(row.id, connectionId)) ?? null;
}

/**
 * 만료·해제된 행에는 「해제」가 서지 않는다 — 그 상태는 칩이 이미 말하고,
 * 시작 게이트도 거절한다. 눌러서 다른 연결의 해제를 무장시키던 자리가 여기다.
 */
export function offersDisconnect(
  status: HostedAgentConnection["status"]
): boolean {
  return status !== "expired" && status !== "disconnected";
}

/**
 * 장부가 도어벨 섹션을 마운트하지 않는 행에는 그 버튼을 두지 않는다.
 * 목적지가 없는 착지는 스크롤·초점을 먹기 전에 빠져나간다.
 */
export function offersDoorbell(
  status: HostedAgentConnection["status"]
): boolean {
  return status !== "cleanup_pending" && status !== "disconnected";
}

/** 해제된 행의 장부(정리 확인·RevokedFacts)로 가는 문. 빈 액션 칸을 두지 않는다. */
export function offersRecord(
  status: HostedAgentConnection["status"]
): boolean {
  return status === "disconnected";
}

/** `lg`(min-width: 1024px) 에서만 3열 `credentials-row-grid`. */
const CREDENTIALS_ROW_WIDE_QUERY = "(min-width: 1024px)";

function subscribeCredentialsRowWide(onStoreChange: () => void): () => void {
  const mq = window.matchMedia(CREDENTIALS_ROW_WIDE_QUERY);
  mq.addEventListener("change", onStoreChange);
  return () => mq.removeEventListener("change", onStoreChange);
}

function credentialsRowWideSnapshot(): boolean {
  return window.matchMedia(CREDENTIALS_ROW_WIDE_QUERY).matches;
}

function credentialsRowWideServerSnapshot(): boolean {
  return false;
}

function useCredentialsRowWide(): boolean {
  return useSyncExternalStore(
    subscribeCredentialsRowWide,
    credentialsRowWideSnapshot,
    credentialsRowWideServerSnapshot
  );
}

function chipTone(tone: HostedChipTone): ChipTone {
  return tone === "neutral" ? "muted" : tone;
}

function ActivityFacts({ updatedAtMs }: { updatedAtMs: number }) {
  const absolute = formatMoment(updatedAtMs);
  return (
    <dl className="min-w-0 shrink-0">
      <dt className="sr-only">마지막 활동</dt>
      <dd className="text-meta text-ink-muted">
        <time
          dateTime={new Date(updatedAtMs).toISOString()}
          title={`마지막 활동 ${absolute}`}
          data-testid="agent-credentials-row-time"
          className="whitespace-nowrap"
        >
          {relativeLabel(updatedAtMs, Date.now())}
        </time>
      </dd>
    </dl>
  );
}

function CredentialsRowName({ name }: { name: string }) {
  return (
    <span
      className="min-w-0 flex-1"
      data-testid="agent-credentials-row-name"
    >
      <TruncatingName
        name={name}
        className="block truncate text-body text-ink"
        visualOnly
      />
      <span className="sr-only">{name}</span>
    </span>
  );
}

export function AgentCredentialsSection({ offline }: { offline: boolean }) {
  const { workspaceId } = useSession();
  const { directory } = useDirectory(workspaceId);
  const list = useQuery(hostedListQuery(workspaceId));

  const [wizardOpen, setWizardOpen] = useState(false);
  const [launch, setLaunch] = useState<HostedWizardLaunch | null>(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState<
    string | null
  >(null);
  const [landOn, setLandOn] = useState<HostedLedgerLanding | undefined>(
    undefined
  );
  const [landNonce, setLandNonce] = useState(0);
  const [wizardOpener, setWizardOpener] = useState<HTMLButtonElement | null>(
    null
  );
  const wide = useCredentialsRowWide();

  const rows = list.data ?? [];
  const selected = hostedRowByConnectionId(rows, selectedConnectionId);
  const selectedLabel =
    selected === null
      ? ""
      : (memberFor(directory, selected.agentMemberId)?.displayName ??
        hostedListRow(selected, "에이전트").title);
  const selectedHeading =
    selected === null
      ? ""
      : `${selectedLabel} · ${hostedStatusLabel(selected.status)}`;

  const openIssue = () => {
    setLaunch(null);
    setWizardOpen(true);
  };

  const openLedger = (
    row: HostedAgentConnection,
    action: CredentialsRowAction
  ) => {
    setSelectedConnectionId(row.id);
    setLandOn(ledgerLandingFor(action));
    setLandNonce((nonce) => nonce + 1);
  };

  const openRegenerate = (row: HostedAgentConnection) => {
    const member = memberFor(directory, row.agentMemberId);
    setSelectedConnectionId(row.id);
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
   * 잠기지 않은 컨트롤에는 id 를 붙이지 않는다.
   */
  function lockReason(
    locked: boolean,
    noteId = CREDENTIALS_OFFLINE_NOTE_ID
  ): string | undefined {
    return writesLocked && locked ? noteId : undefined;
  }

  const issueButton = (testId: string) => (
    <Button
      type="button"
      size="sm"
      aria-disabled={writesLocked || undefined}
      aria-describedby={lockReason(writesLocked)}
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
                  row.id,
                  selectedConnectionId ?? ""
                );
                const gate = regenerateGate(row);
                const rowOfflineId = `agent-credentials-offline-${row.id}`;
                const regenerateLocked = writesLocked && gate.allowed;
                const statusChip = (
                  <StatusChip tone={chipTone(hostedStatusTone(row.status))}>
                    {hostedStatusLabel(row.status)}
                  </StatusChip>
                );
                const facts = (
                  <div
                    className="flex shrink-0 flex-nowrap items-center gap-2"
                    data-credentials-facts=""
                  >
                    {statusChip}
                    <ActivityFacts updatedAtMs={row.updatedAtMs} />
                  </div>
                );
                const regenerateControl = gate.allowed && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-disabled={regenerateLocked || undefined}
                    aria-describedby={lockReason(
                      regenerateLocked,
                      rowOfflineId
                    )}
                    className={cn(regenerateLocked && "opacity-50")}
                    onClick={(event) => {
                      if (regenerateLocked) return;
                      setWizardOpener(event.currentTarget);
                      openRegenerate(row);
                    }}
                    data-testid="agent-credentials-regenerate"
                  >
                    재발급
                  </Button>
                );
                const lockedReason = regenerateLocked && (
                  <p
                    id={rowOfflineId}
                    className={cn(
                      "min-w-0 break-keep text-meta text-ink-muted",
                      wide ? "col-span-full" : "basis-full"
                    )}
                  >
                    {CREDENTIALS_OFFLINE_REASON}
                  </p>
                );
                return (
                  <li
                    key={row.id}
                    aria-current={selectedRow ? "true" : undefined}
                    className={cn(
                      "min-w-0 border-b border-line last:border-b-0 ps-3",
                      selectedRow &&
                        "credentials-row-current bg-accent-soft"
                    )}
                    data-testid="agent-credentials-row"
                    data-connection-id={row.id}
                    data-selected={selectedRow ? "" : undefined}
                    data-layout={wide ? "grid" : "stack"}
                  >
                    <div
                      className={cn(
                        "min-w-0",
                        wide ? "credentials-row-grid" : "flex flex-col"
                      )}
                    >
                      {wide ? (
                        <>
                          <div
                            className="flex min-w-0 items-center overflow-hidden py-1"
                            data-testid="agent-credentials-row-body"
                          >
                            <CredentialsRowName name={fullName} />
                          </div>
                          {facts}
                        </>
                      ) : (
                        <div
                          className="flex min-w-0 flex-nowrap items-center gap-2 overflow-hidden pr-3 py-1"
                          data-testid="agent-credentials-row-body"
                        >
                          <CredentialsRowName name={fullName} />
                          {facts}
                        </div>
                      )}
                      <div
                        className={
                          wide
                            ? "contents"
                            : "mx-3 flex min-w-0 flex-wrap items-center gap-1 border-t border-line/50 bg-surface px-2 py-1"
                        }
                        data-testid={
                          wide
                            ? undefined
                            : "agent-credentials-row-actions"
                        }
                      >
                        <div
                          className={
                            wide
                              ? "flex min-w-0 flex-nowrap items-center gap-1 border-s border-line bg-surface px-2 py-1"
                              : "contents"
                          }
                          data-testid={
                            wide
                              ? "agent-credentials-row-actions"
                              : undefined
                          }
                        >
                          {offersDisconnect(row.status) && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openLedger(row, "disconnect")}
                              data-testid="agent-credentials-disconnect"
                            >
                              해제
                            </Button>
                          )}
                          {offersDoorbell(row.status) && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openLedger(row, "doorbell")}
                              data-testid="agent-credentials-doorbell"
                            >
                              도어벨 설정
                            </Button>
                          )}
                          {offersRecord(row.status) && (
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => openLedger(row, "record")}
                              data-testid="agent-credentials-record"
                            >
                              기록 보기
                            </Button>
                          )}
                          {regenerateControl}
                        </div>
                        {lockedReason}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {selected !== null && (
          <HostedConnectionSection
            key={selected.id}
            agentMemberId={selected.agentMemberId}
            agentLabel={selectedLabel}
            title={selectedHeading}
            connectionId={selected.id}
            landOn={landOn}
            landNonce={landNonce}
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
