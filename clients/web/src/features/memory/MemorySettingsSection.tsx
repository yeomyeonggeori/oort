import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError } from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { useSession } from "@/app/session";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { Switch } from "@/design/ui/switch";
import { SettingsRow } from "@/features/settings/shell/SettingsRow";
import { SettingsSection } from "@/features/settings/shell/SettingsSection";
import { CardBody } from "@/features/settings/workTierPolicy";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import {
  MEMORY_PAUSE_DETAIL_OFF,
  MEMORY_PAUSE_DETAIL_ON,
  MEMORY_PAUSE_LABEL,
  MEMORY_PAUSE_WORKSPACE_OFF,
  MEMORY_NOTICE_ENABLE_BLOCKED,
  MEMORY_NOTICE_ENABLE_CONFIRM,
  MEMORY_NOTICE_ENABLE_LEAD,
  MEMORY_NOTICE_ENABLE_LEAD_UNCONFIGURED,
  MEMORY_NOTICE_TITLE,
  MEMORY_RESET_CANCEL,
  MEMORY_RESET_TITLE,
  MEMORY_SETTINGS_FORBIDDEN,
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
import { MemoryNoticeBody, MemoryNoticeQueryBody } from "./MemoryNoticePanel";
import { MemoryResetPanel } from "./MemoryResetPanel";
import {
  useMemoryNotice,
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

const MEMORY_BROWSER_LEAD =
  "팀이 기억해 두기로 한 것을 보고, 근거를 따라가고, 고치거나 잊을 수 있어요.";

const ADMIN_REASON_ID = "memory-workspace-admin-reason";

const PAGE_LEAD =
  "채널 대화를 요약해 두고, 에이전트가 답할 때 참고하게 해요. 요약에는 원본 메시지 링크가 함께 남아요.";

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
  // Every member reads the notice (guests included); it also backs the confirm step of the switch.
  const notice = useMemoryNotice(workspaceId);
  // D9 ②: turning memory ON asks first, with the notice in front of the admin. Off is one click.
  const [askingEnable, setAskingEnable] = useState(false);
  useEscapeLayer(askingEnable, () => setAskingEnable(false));
  // Focus goes into the question when it opens and back to the switch when it closes.
  const enableConfirmRef = useRef<HTMLButtonElement | null>(null);
  const enableWasAsking = useRef(false);
  useEffect(() => {
    if (askingEnable) {
      enableWasAsking.current = true;
      enableConfirmRef.current?.focus({ preventScroll: true });
    } else if (enableWasAsking.current) {
      enableWasAsking.current = false;
      document
        .querySelector<HTMLElement>('[data-testid="memory-workspace-enabled"]')
        ?.focus({ preventScroll: true });
    }
  }, [askingEnable]);

  if (settings.isPending) {
    return (
      <div className="flex min-w-0 flex-col gap-8" data-testid="memory-page">
        <SettingsSection title="기억" description={PAGE_LEAD}>
          <CardBody>
            <Skeleton ready={false} rows={4} />
          </CardBody>
        </SettingsSection>
      </div>
    );
  }
  if (settings.isError || !settings.data) {
    const absent = serverSaysAbsent(settings.error);
    // 403은 운영자 권한이 아니다: 서버는 이 설정을 「활성 사람 멤버」에게 읽게 하므로(`require_live_human`)
    // 에이전트 계정이거나 멤버가 아니라는 뜻이다. 다시 불러와도 같은 답이라 단추를 두지 않는다.
    const forbidden = settings.error instanceof ApiError && settings.error.status === 403;
    return (
      <div className="flex min-w-0 flex-col gap-8" data-testid="memory-page">
        <SettingsSection title="기억" description={PAGE_LEAD}>
          <CardBody>
            {forbidden ? (
              <p
                className="break-keep text-body text-ink-muted"
                role="status"
                data-testid="memory-settings-forbidden"
              >
                {MEMORY_SETTINGS_FORBIDDEN}
              </p>
            ) : (
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
                separator={false}
                className="px-0"
                testId="memory-settings-load"
              />
            )}
          </CardBody>
        </SettingsSection>
      </div>
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
  // 진행은 잠금이 아니다: 쓰는 동안 스위치를 native disabled로 끄면 초점이 <body>로 떨어진다.
  // 잠그는 사실은 권한과 오프라인이고, 진행 중 두 번째 쓰기는 핸들러가 막는다.
  const workspaceLocked = !canChangeWorkspace || offline;
  const myPauseId = { label: "memory-me-paused-label", desc: "memory-me-paused-desc" };
  const enabledId = { label: "memory-workspace-enabled-label", desc: "memory-workspace-enabled-desc" };
  const pausedId = { label: "memory-workspace-paused-label", desc: "memory-workspace-paused-desc" };
  const reasonFor = (descId: string) =>
    [descId, !canChangeWorkspace ? ADMIN_REASON_ID : offline ? offlineReasonId : null]
      .filter(Boolean)
      .join(" ");

  return (
    <div className="flex min-w-0 flex-col gap-8" data-testid="memory-page">
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 있어서 지금은 바꿀 수 없어요."
          messageId={offlineReasonId}
          testId="memory-offline-reason"
        />
      )}
      {writeError !== null && (
        <InlineBanner message={writeError} testId="memory-write-error" />
      )}

      <SettingsSection title="기억 살펴보기">
        <SettingsRow label="팀 기억 열기" description={MEMORY_BROWSER_LEAD}>
          <Link
            to="/memory"
            className="tap-target inline-flex h-control-sm items-center rounded-md bg-surface-muted px-3 text-meta text-ink press hover:bg-surface-hover focus-visible:focus-ring"
            data-testid="memory-open-browser"
          >
            기억 열기
          </Link>
        </SettingsRow>
      </SettingsSection>

      <SettingsSection
        title="내 기억"
        description="나에게만 걸리는 설정이에요. 멤버라면 누구나 바꿀 수 있어요."
        testId="memory-mine"
      >
        <SettingsRow
          label={MEMORY_PAUSE_LABEL}
          description={me.paused ? MEMORY_PAUSE_DETAIL_ON : MEMORY_PAUSE_DETAIL_OFF}
          labelId={myPauseId.label}
          descriptionId={myPauseId.desc}
          keep
        >
          <Switch
            testId="memory-me-paused"
            checked={me.paused}
            disabled={offline}
            labelledBy={myPauseId.label}
            describedBy={offline ? `${myPauseId.desc} ${offlineReasonId}` : myPauseId.desc}
            onCheckedChange={(next) => {
              if (busy) return;
              workspaceWrite.reset();
              myWrite.mutate(next);
            }}
          />
        </SettingsRow>
        {!workspace.enabled && (
          <CardBody>
            <p className="break-keep text-meta text-ink-muted" data-testid="memory-mine-workspace-off">
              {MEMORY_PAUSE_WORKSPACE_OFF}
            </p>
          </CardBody>
        )}
      </SettingsSection>

      <SettingsSection
        title="워크스페이스 기억"
        description={TEAM_MEMORY_NOTICE}
        testId="memory-workspace"
      >
        {!canChangeWorkspace && (
          <CardBody>
            <p
              id={ADMIN_REASON_ID}
              className="break-keep text-meta text-ink-muted"
              data-testid="memory-admin-reason"
            >
              {WORKSPACE_SWITCH_ADMIN_ONLY_REASON}
            </p>
          </CardBody>
        )}
        <SettingsRow
          label="팀 기억 켜기"
          description="끄면 새 요약을 만들지 않고, 에이전트도 기억을 참고하지 않아요."
          labelId={enabledId.label}
          descriptionId={enabledId.desc}
          keep
        >
          <Switch
            testId="memory-workspace-enabled"
            checked={workspace.enabled}
            disabled={workspaceLocked}
            labelledBy={enabledId.label}
            describedBy={reasonFor(enabledId.desc)}
            onCheckedChange={(next) => {
              if (busy) return;
              myWrite.reset();
              if (next) {
                workspaceWrite.reset();
                setAskingEnable(true);
                return;
              }
              setAskingEnable(false);
              workspaceWrite.mutate({ enabled: false });
            }}
          />
        </SettingsRow>
        <SettingsRow
          label="팀 기억 잠시 멈추기"
          description="멈춰 두면 요약 만들기와 참고를 쉬어요. 저장된 요약은 그대로 남아요."
          labelId={pausedId.label}
          descriptionId={pausedId.desc}
          keep
        >
          <Switch
            testId="memory-workspace-paused"
            checked={workspace.paused}
            disabled={workspaceLocked || !workspace.enabled}
            labelledBy={pausedId.label}
            describedBy={reasonFor(pausedId.desc)}
            onCheckedChange={(next) => {
              if (busy) return;
              myWrite.reset();
              workspaceWrite.mutate({ paused: next });
            }}
          />
        </SettingsRow>
        {askingEnable && !workspace.enabled && (
          <div
            role="group"
            aria-label="팀 기억 켜기 확인"
            className="flex min-w-0 flex-col gap-3 p-4"
            data-testid="memory-enable-ask"
          >
            <p className="break-keep text-body font-semibold text-ink">
              {notice.data && !notice.data.summary.configured
                ? MEMORY_NOTICE_ENABLE_LEAD_UNCONFIGURED
                : MEMORY_NOTICE_ENABLE_LEAD}
            </p>
            {notice.data ? (
              <MemoryNoticeBody notice={notice.data} />
            ) : (
              <MemoryNoticeQueryBody query={notice} />
            )}
            {!notice.data && !notice.isPending && (
              <p className="break-keep text-meta text-ink-muted" data-testid="memory-enable-blocked">
                {MEMORY_NOTICE_ENABLE_BLOCKED}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button
                ref={enableConfirmRef}
                type="button"
                size="sm"
                aria-disabled={!notice.data || workspaceLocked || busy || undefined}
                className={!notice.data || workspaceLocked || busy ? "opacity-50" : undefined}
                onClick={() => {
                  if (!notice.data || workspaceLocked || busy) return;
                  setAskingEnable(false);
                  workspaceWrite.mutate({ enabled: true });
                }}
                data-testid="memory-enable-confirm"
              >
                {MEMORY_NOTICE_ENABLE_CONFIRM}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAskingEnable(false)}
                data-testid="memory-enable-cancel"
              >
                {MEMORY_RESET_CANCEL}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      {!(askingEnable && !workspace.enabled) && (
        <SettingsSection title={MEMORY_NOTICE_TITLE} testId="memory-notice">
          <CardBody>
            <MemoryNoticeQueryBody query={notice} />
          </CardBody>
        </SettingsSection>
      )}

      <SettingsSection title={MEMORY_RESET_TITLE} testId="memory-reset-card">
        <CardBody>
          <MemoryResetPanel
            workspaceId={workspaceId}
            canReset={canChangeWorkspace}
            offline={offline}
            epoch={workspace.resetEpoch}
          />
        </CardBody>
      </SettingsSection>

      <SettingsSection title="채널마다">
        <SettingsRow
          label="채널에서 제외하거나 멈추기"
          description="채널 헤더의 더보기 메뉴(⋮)에서 기억 설정을 열어요."
          testId="memory-channel-hint"
        />
      </SettingsSection>
    </div>
  );
}
