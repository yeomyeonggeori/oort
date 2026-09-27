import type { LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import type { SubscriptionEntryState } from "@/features/welcome/SubscriptionAgentEntry";

// =============================================================================
// 「내 계정 · 이 맥」 절의 문장과 판정 (#2944 GC-3).
//
// 설정 › AI 연결의 이 절(`AiMyAccountsSection`)과 채팅의 로컬 연결 카드
// (`features/chat/AiConnectCard`)가 **같은 줄**을 그린다. 두 곳이 서로 다른 문장이나
// 다른 「브라우저 탭」 판정을 갖지 않게 여기 한 번만 둔다. 알약 판정은 코어
// `aiLinkPill.ts`(#2941)다.
// =============================================================================

export const MY_ACCOUNTS_EMPTY_LINE = "아직 연결한 구독이 없어요.";
export const MY_ACCOUNTS_EMPTY_DETAIL =
  "Claude나 ChatGPT 구독이 있으면 이 맥의 공식 CLI로 붙일 수 있어요.";
export const MY_ACCOUNTS_BROWSER_LINE =
  "구독 계정은 데스크탑 앱에서만 연결하고 볼 수 있어요. 이 브라우저 탭에는 이 맥의 CLI가 없어요.";
export const MY_ACCOUNTS_DENIED_DETAIL =
  "구독 에이전트는 워크스페이스 owner·admin이 붙일 수 있어요.";
export const MY_ACCOUNTS_ROW_DETAIL = "구독 · 이 맥의 공식 CLI 기본 로그인";

/**
 * 이 화면이 브라우저 탭인가. design 캡처의 `?aiEntry=desktop-only`는 브라우저
 * 탭을 흉내 낸다. 그 밖에는 셸 종류가 답한다. 빌드가 구독 표면을 걷었어도
 * 브라우저 탭 사실은 그대로다.
 */
export function myAccountsBrowserTab(state: SubscriptionEntryState, isTauri: boolean): boolean {
  return state === "desktop-only" || (!isTauri && state !== "rows" && state !== "server-off");
}

/**
 * design 모드 캡처 전용: `?aiProbe=claude-ready` · `?aiProbe=login`. 브라우저에는
 * 이 맥의 CLI가 없어 감지 결과를 셸 없이 세울 수 없다. 제품 빌드에서는 늘 null이다.
 */
export function readProbeFixture(): LocalHarnessProbe[] | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?")) : window.location.search;
  const pose = new URLSearchParams(query).get("aiProbe");
  if (pose === "claude-ready") {
    return [
      { id: "claude", installed: true, auth: "logged_in" },
      { id: "codex", installed: true, auth: "needs_login" },
    ];
  }
  if (pose === "login") {
    return [
      { id: "claude", installed: true, auth: "needs_login" },
      { id: "codex", installed: true, auth: "needs_login" },
    ];
  }
  return null;
}
