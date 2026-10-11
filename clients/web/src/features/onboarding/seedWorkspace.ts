// 서버 사실로 S1을 다시 판정한다 (#3696).
//
// 저장소의 대기 표지는 힌트일 뿐이다(저장소가 지워졌거나 막혔을 수 있다). 소유자가
// S1을 마치기 전에 앱을 끄면 워크스페이스는 시드 이름 「momo Demo Workspace」, 내
// 핸들은 @demo 그대로다. 그 둘이 서버에 그대로 있고 내가 소유자면 S1을 다시 띄운다.
// 이름이나 핸들 하나라도 바뀌었으면(다른 곳에서 이미 정했다) 건드리지 않는다.

import { useEffect, useRef } from "react";
import type { Member } from "@momo/core/lib/api";
import { fetchRoster } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import {
  markOwnerOnboardingStage,
  ownerOnboardingIsPending,
} from "./ownerOnboardingStore";
import { SEED_HANDLE, SEED_WORKSPACE_NAME } from "./s1Copy";

export function isSeedWorkspaceUntouched(input: {
  workspaceName: string | undefined;
  memberHandle: string;
  role: string | undefined;
}): boolean {
  return (
    input.role === "owner" &&
    input.memberHandle.trim().toLowerCase() === SEED_HANDLE &&
    (input.workspaceName ?? "").trim().toLowerCase() === SEED_WORKSPACE_NAME.toLowerCase()
  );
}

/**
 * 로그인 직후 한 번: 시드 이름·핸들 그대로인 소유자의 S1을 다시 세운다. 핸들이
 * @demo가 아닌 사람은 질문 자체를 만들지 않는다(요청 0건). 쿼리 캐시 밖의 일회성
 * 판정이라 QueryClient 없이 서버를 직접 읽는다(실패는 조용히 넘긴다: 힌트일 뿐).
 */
export function useSeedWorkspaceRejudge(member: Member | null): void {
  const judgedRef = useRef<string | null>(null);
  const memberId = member?.id ?? null;
  const workspaceId = member?.workspaceId ?? null;
  const handle = member?.handle ?? "";
  const kind = member?.kind ?? "agent";

  useEffect(() => {
    if (memberId === null || workspaceId === null) return;
    if (kind !== "human" || handle.trim().toLowerCase() !== SEED_HANDLE) return;
    if (judgedRef.current === memberId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [workspace, roster] = await Promise.all([
          fetchWorkspace(workspaceId),
          fetchRoster(workspaceId),
        ]);
        if (cancelled) return;
        judgedRef.current = memberId;
        if (ownerOnboardingIsPending()) return;
        const self = roster.find((row) => row.id.toLowerCase() === memberId.toLowerCase());
        if (
          isSeedWorkspaceUntouched({
            workspaceName: workspace.name,
            memberHandle: handle,
            role: self?.role,
          })
        ) {
          markOwnerOnboardingStage("workspace-profile");
        }
      } catch {
        // 서버에 닿지 않으면 판정하지 않는다. 다음 로그인에서 다시 묻는다.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [memberId, workspaceId, handle, kind]);
}
