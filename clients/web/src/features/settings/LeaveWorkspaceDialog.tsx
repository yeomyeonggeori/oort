import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { BlockedReason } from "@/features/common/BlockedReason";
import { useOffline } from "@/features/common/useOffline";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useLeaveWorkspace } from "./useLeaveWorkspace";

// =============================================================================
// 프로필 메뉴의 「워크스페이스 나가기」 확인 창 (#5785, QA 14 1단).
//
// 메뉴의 줄은 한 번 누름으로 나가지 않는다(파괴 동작은 확인, design-taste-web §6). 메뉴를 닫고 이 창으로
// 넘긴다 — 같은 메뉴의 「로그아웃」 확인과 같은 자리·같은 모양이다. 쓰기와 409 판정은 설정의 위험 행과
// 한 벌(`useLeaveWorkspace`)이고, 마지막 소유자 거절은 창을 닫지 않고 이 안에서 이유를 말한다: 로그아웃되지
// 않았으니 할 일(소유자 넘기기)을 같은 자리에서 읽어야 한다.
//
// 초점은 열릴 때 첫 단추(「취소」)로 간다. 위험 단추가 아니라서 Enter 두 번이 나가기를 내지 않는다.
// 쓰는 동안에는 Esc·바깥 누름으로 닫히지 않는다(요청이 날아간 뒤 창만 사라지면 결과를 볼 자리가 없다).
// =============================================================================

function LeaveWorkspacePanel({
  workspaceId,
  workspaceName,
  onClose,
  opener,
}: {
  workspaceId: string;
  workspaceName?: string;
  onClose: () => void;
  opener?: DialogFocusTarget | null;
}) {
  const formatMessage = useFormatMessage();
  const offline = useOffline();
  const { leave, lastOwner, otherError } = useLeaveWorkspace(workspaceId);
  const pending = leave.isPending;

  return (
    <DialogContent
      opener={opener}
      className="gap-4 p-4"
      data-testid="workspace-leave-dialog"
      onEscapeKeyDown={(event) => {
        if (pending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (pending) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1">
        <DialogTitle className="break-words">
          {workspaceName
            ? formatMessage("workspace.leave.title", { name: workspaceName })
            : formatMessage("workspace.leave.titleUnnamed")}
        </DialogTitle>
        <DialogDescription className="break-keep">
          {formatMessage("workspace.leave.body")}
        </DialogDescription>
      </div>
      {offline && (
        <p
          className="text-meta text-ink-muted"
          data-testid="workspace-leave-dialog-offline"
        >
          <BlockedReason frame="doThisLater" />
        </p>
      )}
      {lastOwner && (
        <p
          className="break-keep text-meta text-danger"
          role="alert"
          data-testid="workspace-leave-dialog-last-owner"
        >
          {formatMessage("workspace.leave.lastOwner")}
        </p>
      )}
      {otherError && (
        <p
          className="text-meta text-danger"
          role="alert"
          data-testid="workspace-leave-dialog-error"
        >
          {otherError}
        </p>
      )}
      {/* 표준 테두리 버튼, 후행 정렬, 기본(파괴) 액션이 마지막(§8). 진행은 잠금이 아니다: 낱말과
          `aria-busy`가 말하고 두 번째 누름은 아래에서 막는다(#1403 리뷰 H-1). 잠그는 것은 오프라인뿐이다. */}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            if (!pending) onClose();
          }}
          data-testid="workspace-leave-dialog-cancel"
        >
          {formatMessage("workspace.leave.cancel")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          size="sm"
          disabled={offline}
          aria-busy={pending || undefined}
          onClick={() => {
            if (pending) return;
            leave.mutate();
          }}
          data-testid="workspace-leave-dialog-confirm"
        >
          {pending
            ? formatMessage("workspace.leave.busy")
            : formatMessage("workspace.leave.confirm")}
        </Button>
      </div>
    </DialogContent>
  );
}

export function LeaveWorkspaceDialog({
  open,
  onOpenChange,
  workspaceId,
  workspaceName,
  opener,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  workspaceName?: string;
  opener?: DialogFocusTarget | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 열려 있는 동안에만 마운트한다: 앞 시도의 409 문장이 다음 열기까지 따라오지 않는다. */}
      {open && (
        <LeaveWorkspacePanel
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          onClose={() => onOpenChange(false)}
          opener={opener}
        />
      )}
    </Dialog>
  );
}
