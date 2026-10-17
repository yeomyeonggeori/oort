import { useEffect, useState } from "react";
import { PRESENCE_WRITE_FAILED } from "@momo/core/features/presence/model";
import type { RosterMember } from "@momo/core/lib/api";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import { PauseUntilDialog } from "@/features/settings/PauseUntilDialog";
import { useSelfPresenceWrite } from "./useSelfPresenceWrite";

// =============================================================================
// 방해 금지의 기한 다이얼로그 (ADR-0204 D2, #2899). 프로필 메뉴의 「방해 금지」 항목이
// 연다. 방해 금지는 기한을 고르고 나서야 켜지고, 쓰기는 `PUT /presence`
// `{status: "dnd", dndUntilMs}` **하나**다. 서버가 같은 트랜잭션에서 알림 일시 중지를
// 묶어 켜므로(ADR-0124 증보 2) 알림 규칙을 따로 쓰지 않는다 — 쓰면 묶음이 끊긴다.
// 대신 `useSelfPresenceWrite` 가 쓰기가 끝나면 규칙 질의를 다시 읽게 한다.
// =============================================================================

export function PresenceDndDialog({
  workspaceId,
  selfMemberId,
  selfMember,
  open,
  onOpenChange,
  opener,
  nowMs,
}: {
  workspaceId: string;
  selfMemberId: string;
  selfMember: RosterMember | null | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: DialogFocusTarget | null;
  /** 시험이 시계를 고정한다. */
  nowMs?: number;
}) {
  const write = useSelfPresenceWrite(workspaceId, selfMemberId);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    // 닫히면 지난 실패 문장도 접는다. 다시 열었을 때 옛 오류가 먼저 보이지 않게.
    if (!open) setFailure(null);
  }, [open]);

  const running = selfMember?.presenceStatus === "dnd";

  return (
    <PauseUntilDialog
      kind="dnd"
      open={open}
      onOpenChange={onOpenChange}
      opener={opener}
      running={running}
      currentUntilMs={running ? selfMember?.dndUntilMs : undefined}
      pending={write.isPending}
      failure={failure}
      nowMs={nowMs}
      onConfirm={(untilMs) => {
        setFailure(null);
        write.mutate(
          { status: "dnd", dndUntilMs: untilMs },
          {
            onSuccess: () => onOpenChange(false),
            onError: () => setFailure(PRESENCE_WRITE_FAILED),
          }
        );
      }}
    />
  );
}
