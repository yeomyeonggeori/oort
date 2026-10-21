import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchNotificationRules } from "@momo/core/features/settings/notificationRules";
import { notificationRulesQueryKey } from "@/features/settings/notificationRulesKey";
import { useRecheckWhenElapsed } from "@/features/settings/useRecheckWhenElapsed";
import { setServerPause } from "./serverPause";

// =============================================================================
// 서버의 알림 일시 중지를 읽어 OS 배너 길목에 넣는다 (#4197, ADR-0204 D3).
//
// 규칙 질의는 설정 › 알림·사이드바의 「알림 일시 중지 중」 줄·프로필 카드가 읽는 것과 **같은 캐시 한
// 칸**이다(`notificationRulesQueryKey`). 그래서 어느 화면에서 「다시 켜기」를 누르든 방해 금지를 고르든 이
// 훅이 같은 새 값을 본다 — 이 기기에서 바꾼 것을 배너가 한 박자 늦게 아는 일이 없다.
//
// ## 기한은 서버가 말한다
//
// 기한이 지났다고 해서 이 훅이 일시 중지를 스스로 풀지 않는다. 지난 것을 알면 서버에 **다시 묻고**
// (`useRecheckWhenElapsed`, 사이드바 줄·설정과 같은 훅이다), 서버의 새 답이 `dnd:false` 일 때 배너가
// 다시 뜬다. 서버 시계와 이 기기 시계가 어긋나 서버가 아직 켜져 있다고 답하면 그 답이 이긴다(푸시도
// 같은 서버 판정을 따른다). 사이드바 줄이 이 훅과 별개로 같은 일을 하지만, 줄이 서 있지 않을 수 있고
// (사이드바가 접힌 화면·설정 화면) 배너가 뜨는 때는 창이 **뒤에** 있을 때라 창 포커스에 기대는 재조회는
// 닿지 않는다. 그래서 이 훅이 스스로 한다.
//
// ## 다른 기기에서 바꾼 값
//
// 폰에서 건 일시 중지가 이 기기에 닿는 길은 재조회뿐이다: 규칙에는 이벤트가 없고(`useRecheckWhenElapsed`
// 머리말) 질의 클라이언트는 창 포커스 재조회가 꺼져 있다(`app/queryClient.ts`). 창이 뒤에 있는 동안은
// 포커스가 오지 않으므로 분 단위로 다시 읽는다 — 어긋남이 최대 이 간격이다. 읽기는 한 줄짜리 GET 이다.
//
// ## 읽지 못했을 때
//
// 마지막으로 읽은 값을 그대로 둔다(질의 캐시가 실패한 재조회에도 `data` 를 지우지 않는다). 한 번도
// 못 읽었으면 일시 중지가 아니다 — 읽지 못한 규칙으로 배너를 막지 않는다. 실패는 로그를 남긴다:
// 조용히 값이 굳어 있으면 「왜 배너가 안 오지(또는 계속 오지)」를 아무도 설명하지 못한다.
// =============================================================================

/** 창이 뒤에 있는 동안 다른 기기에서 바뀐 규칙을 따라잡는 간격. */
export const SERVER_PAUSE_POLL_MS = 60_000;

/**
 * 배너가 뜰 수 있는 표면(`enabled`)에서 서버의 일시 중지를 읽어 `serverPauseActive()` 에 싣는다.
 * 켜지지 않은 표면(권한 없는 탭)은 읽지도 않는다 — 쓰지 않는 값에 요청을 내지 않는다.
 */
export function useServerPause(workspaceId: string, enabled: boolean): void {
  const rules = useQuery({
    queryKey: notificationRulesQueryKey(workspaceId),
    queryFn: () => fetchNotificationRules(workspaceId),
    enabled,
    retry: false,
    refetchInterval: SERVER_PAUSE_POLL_MS,
    // 배너는 창이 뒤에 있을 때 뜬다. 숨은 창의 간격 재조회를 멈추면 필요한 때만 값이 굳는다.
    refetchIntervalInBackground: true,
  });

  const paused = enabled && (rules.data?.dnd ?? false);

  // 기한이 지나면 서버에 다시 묻는다. 기한 없는 일시 중지는 만료가 없어 타이머를 들지 않는다.
  useRecheckWhenElapsed(workspaceId, paused ? rules.data?.dndUntilMs : undefined);

  useEffect(() => {
    setServerPause(paused);
    // 떠나면(로그아웃·워크스페이스 전환) 이 값을 다음 사람에게 남기지 않는다.
    return () => setServerPause(false);
  }, [paused]);

  useEffect(() => {
    if (rules.error === null) return;
    console.warn(
      "[momo] notification rules unavailable; keeping the last known pause state",
      rules.error
    );
  }, [rules.error, rules.errorUpdatedAt]);
}
