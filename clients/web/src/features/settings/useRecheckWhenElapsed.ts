import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pauseUntilElapsed } from "@momo/core/features/presence/pauseUntil";
import { notificationRulesQueryKey } from "./notificationRulesKey";

// =============================================================================
// 알고 있는 기한이 지나면 서버에 다시 묻는다 (ADR-0204 D2·D3, #2899 design-review H3).
//
// 방해 금지와 알림 일시 중지의 만료는 서버가 판정한다. 서버는 만료 시각에 이벤트를 보내지 않고
// (`RosterMember.dndUntilMs`), 질의 클라이언트는 30초 동안 신선하다고 믿으며 포커스 재조회도 꺼져 있다
// (`app/queryClient.ts`). 그래서 아무것도 하지 않으면 기한이 지난 뒤에도 자기 화면(아바타의 방해 금지
// 점, 프로필 메뉴의 「오후 10:30까지」, 설정의 스위치)이 낡은 값을 말한다 — 실측: 시계를 기한 뒤로 옮기자
// 아바타는 `dnd`, 메뉴는 `aria-checked="true"` + 지난 시각을 「…까지」로 말했다.
//
// 이 훅은 **화면을 스스로 풀지 않는다.** 기한이 지난 것을 알면 규칙과 명부를 다시 읽을 뿐이고, 줄이
// 사라지는 것은 서버의 새 답이 도착했을 때다. 서버가 아직 켜져 있다고 답하면(두 시계의 차이) 화면은
// 그대로이고 분 틱마다 다시 묻는다.
//
// 기한이 오는 순간에 한 번 깨어(분 틱을 기다리지 않는다), 그 뒤로는 분 틱에 맡긴다. 기한이 없으면
// 타이머를 하나도 들지 않는다.
// =============================================================================

const MINUTE_MS = 60_000;
/** `setTimeout` 은 이 값을 넘는 지연을 즉시 실행으로 읽는다(32비트). 더 먼 기한은 분 틱이 맡는다. */
const MAX_TIMER_MS = 2_147_483_647;
/** 타이머가 기한보다 조금 일찍 깨어도 「지났다」가 참이 되도록 두는 여유. */
const SLACK_MS = 500;

export function useRecheckWhenElapsed(
  workspaceId: string,
  untilMs: number | undefined
): void {
  const client = useQueryClient();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (untilMs === undefined) return;
    const wait = untilMs - Date.now();
    if (wait <= 0 || wait > MAX_TIMER_MS) return;
    const id = window.setTimeout(() => setNow(Date.now()), wait + SLACK_MS);
    return () => window.clearTimeout(id);
  }, [untilMs]);

  useEffect(() => {
    if (untilMs === undefined) return;
    const id = window.setInterval(() => setNow(Date.now()), MINUTE_MS);
    return () => window.clearInterval(id);
  }, [untilMs]);

  const elapsed = pauseUntilElapsed(untilMs, now);
  useEffect(() => {
    if (!elapsed) return;
    void client.invalidateQueries({ queryKey: notificationRulesQueryKey(workspaceId) });
    void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
  }, [client, elapsed, now, workspaceId]);
}
