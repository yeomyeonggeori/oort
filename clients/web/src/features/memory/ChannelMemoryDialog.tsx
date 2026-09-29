import { useState, type RefObject } from "react";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
  useRestoreFocusOnClose,
} from "@/design/ui/dialog";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { SettingsToggleRow } from "@/features/settings/SettingsFields";
import {
  CHANNEL_SWITCH_ADMIN_ONLY_REASON,
  MEMORY_SETTINGS_LOAD_ERROR,
  memoryWriteErrorMessage,
} from "@momo/core/features/memory/presentation";
import {
  serverSaysAbsent,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import { useChannelMemoryMutation, useMemorySettings } from "./useMemory";

// =============================================================================
// 채널 기억 설정 (ADR-0196 D9 「채널 제외」 · 「일시정지」, #3165). Opened from the
// channel header menu. The server decides who may write (workspace or channel
// admin); this dialog only tells a member up front that the rows are not theirs
// to change, and maps a 403 to the same sentence if the role guess was stale.
// =============================================================================

export function ChannelMemoryDialog({
  workspaceId,
  channelId,
  channelTitle,
  canChange,
  open,
  onOpenChange,
  opener,
}: {
  workspaceId: string;
  channelId: string;
  channelTitle: string;
  /** Workspace owner/admin. A channel-only admin is judged by the server. */
  canChange: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: RefObject<HTMLElement | null>;
}) {
  useRestoreFocusOnClose(open, opener);
  const offline = useOffline();
  const settings = useMemorySettings(workspaceId, open);
  const write = useChannelMemoryMutation(workspaceId, channelId);
  const [lastWriteFailed, setLastWriteFailed] = useState(false);
  // A channel with no explicit row is at its defaults: on, not paused.
  const row = settings.data?.channels.find(
    (candidate) => candidate.channelId.toLowerCase() === channelId.toLowerCase()
  );
  const excluded = row?.excluded ?? false;
  const paused = row?.paused ?? false;
  const locked = !canChange || offline || write.isPending;
  const reasonId = "channel-memory-reason";

  const submit = (input: { excluded?: boolean; paused?: boolean }) => {
    setLastWriteFailed(false);
    write.mutate(input, { onError: () => setLastWriteFailed(true) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        opener={opener.current}
        className="gap-4 p-4"
        data-testid="channel-memory-dialog"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          restoreDialogOpenerFocus(opener.current);
        }}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <DialogTitle>기억 설정</DialogTitle>
          <DialogDescription>
            {channelTitle} 채널의 대화를 요약과 기억에 쓸지 정해요.
          </DialogDescription>
        </div>

        {settings.isPending ? (
          <Skeleton ready={false} rows={3} />
        ) : settings.isError || !settings.data ? (
          <InlineBanner
            tone={serverSaysAbsent(settings.error) ? "neutral" : "error"}
            message={
              serverSaysAbsent(settings.error)
                ? serverSurface("teamMemory").absentReason
                : MEMORY_SETTINGS_LOAD_ERROR
            }
            {...(serverSaysAbsent(settings.error)
              ? {}
              : {
                  actionLabel: "다시 시도",
                  onAction: () => void settings.refetch(),
                })}
            testId="channel-memory-load"
          />
        ) : (
          <div className="flex min-w-0 flex-col gap-3">
            {!canChange && (
              <p
                id={reasonId}
                className="break-keep text-meta text-ink-muted"
                data-testid="channel-memory-reason"
              >
                {CHANNEL_SWITCH_ADMIN_ONLY_REASON}
              </p>
            )}
            {offline && (
              <p className="text-meta text-ink-muted" data-testid="channel-memory-offline">
                연결이 끊겨 있어서 지금은 바꿀 수 없어요.
              </p>
            )}
            {lastWriteFailed && write.isError && (
              <InlineBanner
                message={memoryWriteErrorMessage(write.error, "channel")}
                testId="channel-memory-error"
              />
            )}
            <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
              <SettingsToggleRow
                testId="channel-memory-excluded"
                name="이 채널은 요약에서 빼기"
                description="켜면 이 채널의 대화는 요약하지 않고 기억에도 쓰지 않아요."
                checked={excluded}
                disabled={locked}
                describedBy={!canChange ? reasonId : undefined}
                onToggle={(next) => submit({ excluded: next })}
              />
              <SettingsToggleRow
                testId="channel-memory-paused"
                name="이 채널의 기억 잠시 멈추기"
                description="멈춰 두면 새 요약을 만들지 않아요. 저장된 요약은 그대로 남아요."
                checked={paused}
                disabled={locked || excluded}
                describedBy={!canChange ? reasonId : undefined}
                onToggle={(next) => submit({ paused: next })}
              />
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            data-testid="channel-memory-close"
          >
            닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
