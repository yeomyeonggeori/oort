// =============================================================================
// AI 연결 재진입 (#2870, RCA 1-b·1-c).
//
// 온보딩의 AI 연결 화면(FirstAgentStage)은 first-run 표지가 있을 때만 섰다.
// 표지가 done·skipped 이거나 연결이 하나라도 있으면(자동 통과) 다시 설 길이
// 없었다. 그래서 「나중에 AI에서 이어갈 수 있습니다」가 가리키는 곳에
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

/** API 키 줄이 넘기는 곳(AI). */
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

// ---- 히스토리 (#2938 ③) --------------------------------------------------------
//
// 닫기는 처음에 출발지 해시를 **새 항목으로 쌓았다**. 그러면 스택이
// [앱, 설정, ai-connect, 설정]이 되고, 설정의 「앱으로 돌아가기」(한 칸 뒤로)가
// 바로 아래의 ai-connect로 간다. 거기서 다시 닫으면 설정이 또 쌓여 끝나지 않았다.
//
// 이제 여는 쪽이 재진입 항목에 「어디 위에 쌓였는가」를 적어 둔다. 닫을 때 가려는
// 곳이 그 자리면 한 칸 **뒤로** 간다(쌓인 항목이 사라진다). 그 표지가 없으면
// (주소로 바로 열림·새로 고침) 또는 다른 곳으로 가면 재진입 항목을 **바꿔 끼운다**.
// 어느 쪽이든 스택에 ai-connect가 남지 않는다.

const REENTRY_ORIGIN_STATE = "oortAiConnectOrigin";

function hashPath(hash: string): string {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const queryAt = raw.indexOf("?");
  return (queryAt === -1 ? raw : raw.slice(0, queryAt)).replace(/\/+$/, "") || "/";
}

function historyState(): Record<string, unknown> {
  const state: unknown = window.history.state;
  return state !== null && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

/** 재진입 화면을 연다. 해시 대입이라 App의 hashchange가 받는다. */
export function openAiConnectReentry(from: AiConnectReentryFrom): void {
  const back = aiConnectReturnHash(from);
  // 출발지가 곧 돌아올 자리면 그 항목을 돌아올 주소로 먼저 고쳐 둔다. 설정은
  // 고른 절을 주소에 싣지 않으므로(#/settings), 뒤로 돌아오면 첫 절이 선다.
  // 라우터의 상태(idx·key)는 그대로 둔다.
  if (hashPath(window.location.hash) === hashPath(back) && window.location.hash !== back) {
    window.history.replaceState(window.history.state, "", back);
  }
  const origin = window.location.hash;
  window.location.hash = aiConnectReentryHash(from);
  window.history.replaceState({ ...historyState(), [REENTRY_ORIGIN_STATE]: origin }, "");
}

/**
 * 재진입을 닫고 `hash`로 간다. 쌓인 자리로 돌아가면 뒤로, 아니면 바꿔 끼운다.
 * 어느 쪽이든 히스토리에 재진입 항목이 남지 않는다.
 */
export function leaveAiConnectReentry(hash: string): void {
  const { [REENTRY_ORIGIN_STATE]: origin, ...rest } = historyState();
  if (typeof origin === "string" && origin === hash) {
    window.history.back();
    return;
  }
  window.location.replace(hash);
  // 바꿔 끼운 항목은 라우터 상태를 잃는다. 재진입 항목의 것을 물려준다: 앱이
  // 재진입 주소로 시작했다면 설정이 「첫 항목(idx 0)」을 알아 앱 밖으로 나가지 않는다.
  window.history.replaceState(Object.keys(rest).length > 0 ? rest : null, "");
}
