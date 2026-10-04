import type { RefObject } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { PERSONAL_KEYS_COPY as COPY } from "@momo/core/features/ai/personalKeys";

const OFFLINE_ID = "ai-personal-revoke-offline";

/**
 * 개인 키 회수 확인 창. 운영자 구획과 「받은 개인 키」가 같은 창을 쓴다.
 * 회수는 한 방향이다: 되살릴 수 없고, 에이전트는 팀 키로 넘어가지 않고 멈춘다.
 */
export function PersonalKeyRevokeDialog({
  open,
  onOpenChange,
  opener,
  title,
  body,
  busy,
  offline,
  error,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: RefObject<HTMLButtonElement | null> | null;
  title: string;
  body: string;
  busy: boolean;
  offline: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  const locked = busy || offline;
  const copy = COPY.revokeDialog;
  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      {open && (
        <DialogContent
          role="alertdialog"
          opener={opener?.current ?? null}
          className="gap-3 p-4"
          data-testid="ai-personal-revoke-dialog"
        >
          <DialogTitle className="shrink-0 [overflow-wrap:anywhere]">{title}</DialogTitle>
          <DialogDescription className="shrink-0 break-keep" data-testid="ai-personal-revoke-body">
            {body}
          </DialogDescription>
          {error && (
            <p className="break-keep text-meta text-danger" role="alert" data-testid="ai-personal-revoke-error">
              {error}
            </p>
          )}
          {offline && (
            <p id={OFFLINE_ID} className="break-keep text-meta text-ink-muted">
              {copy.offline}
            </p>
          )}
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="tap-target"
              onClick={() => onOpenChange(false)}
              data-testid="ai-personal-revoke-cancel"
            >
              {copy.cancel}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className={cn("tap-target", offline && !busy && "opacity-50 hover:opacity-50")}
              aria-disabled={locked || undefined}
              aria-busy={busy || undefined}
              aria-describedby={offline ? OFFLINE_ID : undefined}
              onClick={() => {
                if (!locked) onConfirm();
              }}
              data-testid="ai-personal-revoke-confirm"
            >
              {busy ? copy.confirming : copy.confirm}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
