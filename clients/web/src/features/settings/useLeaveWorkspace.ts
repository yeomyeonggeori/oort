import { useMutation } from "@tanstack/react-query";
import { ApiError, leaveWorkspace } from "@momo/core/lib/api";
import { errorMessage } from "@momo/core/features/settings/model";
import { useSession } from "@/app/session";

// 워크스페이스 나가기의 쓰기 한 벌 (ADR-0161 D4, #5785).
//
// 나가는 자리가 둘이다: 설정 › 프로필 맨 아래 위험 행(`LeaveWorkspaceRow`, 제자리 확인)과 프로필 메뉴의
// 「워크스페이스 나가기」(`LeaveWorkspaceDialog`, 확인 창). 쓰기·성공 뒤 로그아웃·마지막 소유자 409 판정이
// 두 벌이면 한쪽만 고쳐지는 날이 온다. 그래서 두 자리가 이 훅 하나를 쓰고, 그리는 모양만 각자 갖는다.
//
// `leave`는 mutation 그대로다: 부르는 쪽이 `leave.isPending`을 진행 낱말에, `leave.mutate()`를 확정에 쓴다.

export function useLeaveWorkspace(workspaceId: string) {
  const session = useSession();
  const leave = useMutation({
    mutationFn: () => leaveWorkspace(workspaceId),
    onSuccess: () => {
      // 나가면 이 세션은 끝이다: 서버가 이미 토큰을 파기했고, 로컬도 정리한다.
      session.logout();
    },
  });
  // 마지막 소유자는 서버가 409로 거절한다. 그때는 로그아웃하지 않고 그 자리에서 이유를 말한다.
  const lastOwner =
    leave.isError && leave.error instanceof ApiError && leave.error.status === 409;
  const otherError = leave.isError && !lastOwner ? errorMessage(leave.error) : null;
  return { leave, lastOwner, otherError };
}
