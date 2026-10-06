import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError, leaveWorkspace } from "@momo/core/lib/api";
import { errorMessage } from "@momo/core/features/settings/model";
import { useSession } from "@/app/session";
import { SettingsRow } from "./shell/SettingsRow";
import { ConfirmButton } from "./SettingsFields";

// 워크스페이스 나가기 (ADR-0161 D4). 프로필 페이지 맨 아래 위험 행이다(#3578 S2):
// 「나」에게 걸리는 행동이라 워크스페이스 페이지가 아니라 프로필에 선다. 별도의 「위험
// 구역」 상자는 만들지 않는다 — 라벨만 위험색이고 파괴 동작은 제자리 확인
// (`ConfirmButton`)이 지킨다. 마지막 소유자는 서버가 409로 거절한다.

export function LeaveWorkspaceRow({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const session = useSession();
  // 확인 질문은 한 문장이 길어서 라벨 옆(가로)에 서면 둘 다 접힌다. 묻는 동안만 세로로 선다.
  const [asking, setAsking] = useState(false);

  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => {
      // 나가면 이 세션은 끝이다: 서버가 이미 토큰을 파기했고, 로컬도 정리한다.
      session.logout();
    },
  });

  const lastOwner =
    leave.isError && leave.error instanceof ApiError && leave.error.status === 409;
  const otherError = leave.isError && !lastOwner ? errorMessage(leave.error) : null;

  return (
    <>
      <SettingsRow
        label={<span className="text-danger">워크스페이스 나가기</span>}
        description="이 워크스페이스에서 나가요. 다시 들어오려면 초대가 필요해요."
        stack={asking}
        testId="workspace-leave-row"
      >
        {/* 진행은 잠금이 아니다 (#1403 리뷰 H-1 · #1486 문법). 낱말은 트리거 자신이 진다
            (`busy`): 확정이 질문을 먼저 닫으므로 쓰기가 나가는 순간 초점이 서 있는 자리가
            거기다. 잠그는 사실로 남는 것은 오프라인 하나다. */}
        <ConfirmButton
          label="워크스페이스 나가기"
          question="나가면 멤버십이 끝나고, 확인하면 바로 로그아웃돼요."
          confirmLabel="나가기"
          disabled={offline}
          onAskingChange={setAsking}
          busy={leave.isPending}
          busyLabel="나가는 중"
          onConfirm={() => leave.mutate()}
          triggerClassName="tap-target"
          testId="workspace-leave"
        />
      </SettingsRow>
      {lastOwner && (
        <p
          className="px-4 py-3 text-meta text-danger"
          role="alert"
          data-testid="workspace-leave-last-owner"
        >
          마지막 소유자는 나갈 수 없어요. 먼저 다른 사람에게 소유자를 넘기세요.
        </p>
      )}
      {otherError && (
        <p
          className="px-4 py-3 text-meta text-danger"
          role="alert"
          data-testid="workspace-leave-error"
        >
          {otherError}
        </p>
      )}
    </>
  );
}
