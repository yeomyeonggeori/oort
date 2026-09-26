// =============================================================================
// AI 연결 재진입 (#2870, RCA 1-b·1-c).
//
// 온보딩의 AI 연결 화면(FirstAgentStage)은 first-run 표지가 있을 때만 섰다.
// 표지가 done·skipped 이거나 연결이 하나라도 있으면(자동 통과) 다시 설 길이
// 없었다. 그래서 「나중에 설정 › AI 연결에서 이어갈 수 있습니다」가 가리키는 곳에
// 구독 줄이 없었다.
//
// 재진입은 같은 화면을 `#/ai-connect?from=<출발지>`로 다시 세운다. App이 이
// 주소를 보면 first-run과 같은 자리에 `mode="reentry"`로 띄운다. 이 모드는
// 자동 통과를 하지 않고 first-run 표지를 쓰지 않으며, 닫으면 출발지로 돌아간다.
// =============================================================================

export const AI_CONNECT_REENTRY_PATH = "/ai-connect";

/** 재진입 출발지. 닫기·뒤로가 돌아갈 곳이고, 허용 목록 밖은 받지 않는다. */
export type AiConnectReentryFrom = "agents" | "settings";

const RETURN_HASH: Record<AiConnectReentryFrom, string> = {
  agents: "#/agents",
  settings: "#/settings?section=ai",
};

/** API 키 줄이 넘기는 곳(설정 › AI 연결). */
export const AI_CONNECT_SETTINGS_HASH = RETURN_HASH.settings;

export function aiConnectReentryHash(from: AiConnectReentryFrom): string {
  return `#${AI_CONNECT_REENTRY_PATH}?from=${from}`;
}

/**
 * 해시가 재진입 주소면 출발지를, 아니면 null. 모르는 `from`은 에이전트 화면으로
 * 읽는다(열린 리다이렉트가 아니라 해시 안의 두 자리뿐이지만 값은 고정한다).
 */
export function readAiConnectReentry(
  hash: string
): { from: AiConnectReentryFrom } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = raw.indexOf("?");
  const path = queryAt === -1 ? raw : raw.slice(0, queryAt);
  if (path.replace(/\/+$/, "") !== AI_CONNECT_REENTRY_PATH) return null;
  const from = new URLSearchParams(queryAt === -1 ? "" : raw.slice(queryAt)).get("from");
  return { from: from === "settings" ? "settings" : "agents" };
}

export function aiConnectReturnHash(from: AiConnectReentryFrom): string {
  return RETURN_HASH[from];
}

/** 재진입 화면을 연다. 해시 대입이라 App의 hashchange가 받는다. */
export function openAiConnectReentry(from: AiConnectReentryFrom): void {
  window.location.hash = aiConnectReentryHash(from);
}
