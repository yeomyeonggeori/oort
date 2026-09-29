import { useSession } from "@/app/session";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { SectionShell, SettingsToggleRow, Subsection } from "@/features/settings/SettingsFields";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import {
  MEMORY_PAUSE_DETAIL_OFF,
  MEMORY_PAUSE_DETAIL_ON,
  MEMORY_PAUSE_LABEL,
  MEMORY_PAUSE_WORKSPACE_OFF,
  MEMORY_SETTINGS_LOAD_ERROR,
  TEAM_MEMORY_NOTICE,
  WORKSPACE_SWITCH_ADMIN_ONLY_REASON,
  canChangeWorkspaceMemory,
  memoryWriteErrorMessage,
} from "@momo/core/features/memory/presentation";
import {
  serverSaysAbsent,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import {
  useMemorySettings,
  useMyMemoryMutation,
  useWorkspaceMemoryMutation,
} from "./useMemory";

// =============================================================================
// 설정 › 기억 (ADR-0196 D9, #3165).
//
// Two blocks with different audiences. 「내 기억」 is every member's own pause.
// 「워크스페이스」 is the admin switch and pause; a member who is not an admin
// sees the rows disabled WITH the reason, not a hidden block, so the section
// still tells them the team setting exists and who holds it. The server has the
// last word (a 403 maps to the same reason), so a stale role never lets a write
// through.
// =============================================================================

const ADMIN_REASON_ID = "memory-workspace-admin-reason";

export function MemorySettingsSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const { session } = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const self = memberFor(directoryQuery.directory, session.member.id);
  const canChangeWorkspace = canChangeWorkspaceMemory(self?.role);
  const settings = useMemorySettings(workspaceId);
  const workspaceWrite = useWorkspaceMemoryMutation(workspaceId);
  const myWrite = useMyMemoryMutation(workspaceId);

  const lines = [
    "채널 대화를 요약해 두고, 에이전트가 답할 때 참고하게 해요.",
    "요약에는 원본 메시지 링크가 함께 남아요.",
  ];

  if (settings.isPending) {
    return (
      <SectionShell title="기억" lines={lines}>
        <Skeleton ready={false} rows={4} />
      </SectionShell>
    );
  }
  if (settings.isError || !settings.data) {
    const absent = serverSaysAbsent(settings.error);
    return (
      <SectionShell title="기억" lines={lines}>
        <InlineBanner
          tone={absent ? "neutral" : "error"}
          message={
            absent
              ? `${serverSurface("teamMemory").absentReason} ${serverSurface("teamMemory").fallback}`
              : MEMORY_SETTINGS_LOAD_ERROR
          }
          {...(absent
            ? {}
            : { actionLabel: "다시 시도", onAction: () => void settings.refetch() })}
          testId="memory-settings-load"
        />
      </SectionShell>
    );
  }

  const { workspace, me } = settings.data;
  const busy = workspaceWrite.isPending || myWrite.isPending;
  const offlineReasonId = "memory-offline-reason";
  const writeError = workspaceWrite.isError
    ? memoryWriteErrorMessage(workspaceWrite.error, "workspace")
    : myWrite.isError
      ? memoryWriteErrorMessage(myWrite.error, "me")
      : null;
  const workspaceLocked = !canChangeWorkspace || offline || busy;

  return (
    <SectionShell title="기억" lines={lines}>
      {offline && (
        <p
          id={offlineReasonId}
          className="text-meta text-ink-muted"
          data-testid="memory-offline-reason"
        >
          연결이 끊겨 있어서 지금은 바꿀 수 없어요.
        </p>
      )}
      {writeError !== null && (
        <InlineBanner message={writeError} testId="memory-write-error" />
      )}

      <Subsection title="내 기억">
        <div
          className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
          data-testid="memory-mine"
        >
          <SettingsToggleRow
            testId="memory-me-paused"
            name={MEMORY_PAUSE_LABEL}
            description={me.paused ? MEMORY_PAUSE_DETAIL_ON : MEMORY_PAUSE_DETAIL_OFF}
            checked={me.paused}
            disabled={offline || busy}
            describedBy={offline ? offlineReasonId : undefined}
            onToggle={(next) => {
              workspaceWrite.reset();
              myWrite.mutate(next);
            }}
          />
        </div>
        {!workspace.enabled && (
          <p className="text-meta text-ink-muted" data-testid="memory-mine-workspace-off">
            {MEMORY_PAUSE_WORKSPACE_OFF}
          </p>
        )}
      </Subsection>

      <Subsection title="워크스페이스" lines={[TEAM_MEMORY_NOTICE]}>
        {!canChangeWorkspace && (
          <p
            id={ADMIN_REASON_ID}
            className="text-meta text-ink-muted"
            data-testid="memory-admin-reason"
          >
            {WORKSPACE_SWITCH_ADMIN_ONLY_REASON}
          </p>
        )}
        <div
          className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
          data-testid="memory-workspace"
        >
          <SettingsToggleRow
            testId="memory-workspace-enabled"
            name="팀 기억 켜기"
            description="끄면 새 요약을 만들지 않고, 에이전트도 기억을 참고하지 않아요."
            checked={workspace.enabled}
            disabled={workspaceLocked}
            describedBy={
              !canChangeWorkspace ? ADMIN_REASON_ID : offline ? offlineReasonId : undefined
            }
            onToggle={(next) => {
              myWrite.reset();
              workspaceWrite.mutate({ enabled: next });
            }}
          />
          <SettingsToggleRow
            testId="memory-workspace-paused"
            name="팀 기억 잠시 멈추기"
            description="멈춰 두면 요약 만들기와 참고를 쉬어요. 저장된 요약은 그대로 남아요."
            checked={workspace.paused}
            disabled={workspaceLocked || !workspace.enabled}
            describedBy={
              !canChangeWorkspace ? ADMIN_REASON_ID : offline ? offlineReasonId : undefined
            }
            onToggle={(next) => {
              myWrite.reset();
              workspaceWrite.mutate({ paused: next });
            }}
          />
        </div>
      </Subsection>

      <p className="break-keep text-meta text-ink-muted" data-testid="memory-channel-hint">
        채널마다 제외하거나 멈추려면 채널 헤더의 더보기 메뉴(⋮)에서 기억 설정을 열어요.
      </p>
    </SectionShell>
  );
}
