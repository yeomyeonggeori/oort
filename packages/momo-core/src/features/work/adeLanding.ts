import type { AdeItem } from "./adeControl";

// =============================================================================
// 작업 카드를 눌렀을 때 가는 곳 (#5193). 관제 서랍의 카드(`clients/web/src/features/ade/AdeDrawer.tsx`의 `openItem`)가
// 쓰는 규칙을 순수 함수로 적은 것이다 — 메뉴 막대 아이콘의 작업 줄이 같은 곳으로 간다.
//
//   턴(`run`)    작업 패널을 연다. 패널은 라우트가 아니라 셸 옆에 한 벌이라 어느 화면에서든 열린다.
//   세션          채널 표면 안의 작업 세션 패널(`?work=`)로 간다. 주소는 이 함수가 짓지 않는다: 웹의 `workSessionPath`가
//                 짓는다(주소를 두 곳에서 지으면 한 곳만 낡는다 — 서랍 주석의 B1).
//
// 갈 곳이 없는 카드(턴인데 run id나 에이전트가 없고 세션도 아니다)는 `null`이다. 눌러도 아무 데도 가지 않는 길을
// 만들지 않는다.
// =============================================================================

/** 작업 패널을 여는 데 필요한 것. `origin`은 서랍의 카드와 같은 「ade」다(닫을 때 캐럿을 돌려줄 자리를 가른다). */
export interface AdePanelTarget {
  runId: string;
  memberId: string;
  channelId: string;
  origin: "ade";
  startedAtMs?: number;
}

/** 가는 곳 하나: 작업 패널(`panel`) 아니면 작업 세션(`session`). 둘 중 하나만 채워진다. */
export type AdeLanding =
  | { panel: AdePanelTarget; session?: undefined }
  | { panel?: undefined; session: { channelId: string; sessionId: string } };

export function adeItemLanding(item: AdeItem): AdeLanding | null {
  if (item.kind === "run" && item.runId && item.memberId) {
    return {
      panel: {
        runId: item.runId,
        memberId: item.memberId,
        channelId: item.channelId,
        origin: "ade",
        ...(item.startedAtMs !== undefined ? { startedAtMs: item.startedAtMs } : {}),
      },
    };
  }
  if (item.sessionId) {
    return { session: { channelId: item.channelId, sessionId: item.sessionId } };
  }
  return null;
}
