import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";
import { useSession } from "@/app/session";
import { useChannels } from "@/features/workspace/useWorkspace";

// =============================================================================
// 새 승인 카드가 올라오면 「처리할 일」이 **바로** 갱신되게 한다 (#3738).
//
// 실측(2026-10-13): `GET /approvals?status=pending`은 마운트·창 포커스·15초 stale
// 이후에만 다시 읽혔다. 카드가 올라온 순간 사이드바 배지·인박스·탭 제목은 그것을
// 몰랐고, 사람은 다른 일을 하다 1시간 뒤 만료를 만났다.
//
// 승인 카드는 채널의 `approval_request` 메시지다. 채널 구독은 타임라인·알림과
// **공유**(refcount)되므로 여기서 더 구독해도 소켓은 늘지 않는다. 그 메시지가 오면
// (새 카드든, 결정으로 status가 바뀐 편집이든) 대기 목록을 한 번 무효화한다.
// 같은 신호가 몰려도(재접속 재생) 250ms로 합쳐 한 번만 묻는다.
//
// 이 컴포넌트는 아무것도 그리지 않는다. 폴링(`PENDING_APPROVALS_POLL_MS`)이 그물이다:
// 승인자가 카드가 선 채널의 멤버가 아니라면 이 구독은 신호를 받지 못한다.
// =============================================================================

/** 구독할 채널 상한. 알림 레일(`WATCH_CAP`)과 같은 자리다 — 소켓 수는 실비용이다. */
const LIVE_CAP = 60;
const DEBOUNCE_MS = 250;

export function ApprovalsLiveSync() {
  const { workspaceId, realtime } = useSession();
  const { groups } = useChannels(workspaceId);
  const client = useQueryClient();
  const provided = isSurfaceProvided("approvals");

  // 음소거한 채널도 구독한다: 알림은 음소거를 따르지만 결정을 기다리는 일은 아니다.
  const ids = useMemo(
    () =>
      [...groups.channels, ...groups.dms]
        .slice(0, LIVE_CAP)
        .map((channel) => channel.id)
        .join(","),
    [groups]
  );

  useEffect(() => {
    if (!provided || !realtime || ids === "") return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const refresh = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        void client.invalidateQueries({ queryKey: ["approvals", workspaceId] });
      }, DEBOUNCE_MS);
    };
    const stops = ids.split(",").map((channelId) =>
      realtime.subscribeChannel(workspaceId, channelId, {
        // 재접속 때 놓친 프레임이 있을 수 있다: 한 번 다시 읽는다.
        onSubscribed: refresh,
        onMessage: (event) => {
          if (event.payload.type === "approval_request") refresh();
        },
      })
    );
    return () => {
      for (const stop of stops) stop();
      if (timer !== null) clearTimeout(timer);
    };
  }, [provided, realtime, ids, workspaceId, client]);

  return null;
}
