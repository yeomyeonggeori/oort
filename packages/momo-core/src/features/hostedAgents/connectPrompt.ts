import { HOSTED_ROUTINE_TEMPLATE } from "./presets";

// =============================================================================
// 「연결 프롬프트 한 덩어리」 (#3773, ADR-0162 D4·D6·D8).
//
// 그록봇에게 말로 전하는 일을 한 번의 복사로 줄인다. 예전에는 주소, routine 이름,
// 연결 값을 따로 복사해 따로 붙였고 routine 지시문은 화면에서 읽어 옮겨야 했다.
//
// ## 이 덩어리가 지키는 경계 (이 파일의 테스트가 고정한다)
//
// - 비밀값은 **커넥터 구획에 정확히 한 번**만 나온다. routine 구획에는 들어가지
//   않는다 (ADR-0162 D4: static bearer 는 URL·질의·routine prompt·일반 평문
//   설정에 넣지 않는다). routine 은 비밀 없이 도는 지시문이어야 한다.
// - 연결 값(pairing)과 active 자격증명은 서로 다른 비밀이다. 두 덩어리는 서로의
//   값을 담지 않고, 교체 덩어리는 이전 값이 더 이상 통하지 않는다고 말한다.
// - 이 문자열은 **화면과 클립보드에서만** 산다. 저장·로그·분석 이벤트로 흘리지
//   않는다 (호출부 규율). 비밀이 들어 있으므로 미리보기에는 마스킹본을 쓴다.
// =============================================================================

/** 비밀 자리를 화면 미리보기에서 대신하는 표지. */
export const CONNECT_PROMPT_SECRET_MASK = "●●●●●●●●";

/** 구획 머리. 테스트와 미리보기가 구획 경계를 같은 문자열로 찾는다. */
export const CONNECT_PROMPT_CONNECTOR_HEAD = "[1] 원격 MCP 커넥터";
export const CONNECT_PROMPT_ROUTINE_HEAD = "[2] routine";

export interface ConnectPromptInput {
  /** Agent Port 주소. */
  endpoint: string;
  /** 첫 연결 값(pairing). 비밀이다. */
  pairingCredential: string;
  /** 결정적 routine 이름 (`hostedRoutineLabel`). cleanup 매니페스트가 이 문자열을 찾는다. */
  routineLabel: string;
}

/**
 * 첫 번째 덩어리: 커넥터와 routine 을 한 번에 만들게 한다.
 *
 * `reveal` 이 거짓이면 비밀 자리를 마스크로 둔 미리보기 문자열이다. 복사에는
 * 항상 `reveal: true` 본을 쓴다.
 */
export function buildConnectPrompt(
  input: ConnectPromptInput,
  options: { reveal: boolean } = { reveal: true }
): string {
  const secret = options.reveal ? input.pairingCredential : CONNECT_PROMPT_SECRET_MASK;
  return [
    "oort 연결을 설정해 줘. 아래 두 가지를 순서대로 하고, 끝나면 각각 됐는지만 알려 줘.",
    "",
    CONNECT_PROMPT_CONNECTOR_HEAD,
    `- 주소: ${input.endpoint}`,
    `- 인증: Authorization 헤더의 Bearer 값에 ${secret}`,
    "- 이 값은 한 번만 쓰는 연결 값이야. 커넥터 설정 밖에는 적지도 되풀이하지도 마.",
    "",
    CONNECT_PROMPT_ROUTINE_HEAD,
    `- 이름: ${input.routineLabel}`,
    `- 지시: ${HOSTED_ROUTINE_TEMPLATE}`,
    "- 만든 뒤 한 번 수동으로 실행해 줘.",
  ].join("\n");
}

export interface SwapPromptInput {
  endpoint: string;
  /** 승인 뒤 한 번만 보이는 active 자격증명. 비밀이다. */
  activeCredential: string;
  routineLabel: string;
}

/**
 * 두 번째 덩어리: 승인 뒤 커넥터의 값을 새 자격증명으로 바꾸게 한다.
 *
 * 정적 bearer 방식에서는 이 교체가 정직한 한 단계로 남는다 (ADR-0162 D4·D6-4).
 * OAuth 방식(#3524)이 열리면 이 덩어리가 사라진다.
 */
export function buildSwapPrompt(
  input: SwapPromptInput,
  options: { reveal: boolean } = { reveal: true }
): string {
  const secret = options.reveal ? input.activeCredential : CONNECT_PROMPT_SECRET_MASK;
  return [
    "oort 커넥터의 인증 값을 바꿔 줘.",
    "",
    CONNECT_PROMPT_CONNECTOR_HEAD,
    `- 주소: ${input.endpoint}`,
    `- 인증: Authorization 헤더의 Bearer 값을 다음으로 교체: ${secret}`,
    "- 처음 준 연결 값은 이미 쓸 수 없어. 커넥터 설정 밖에는 적지도 되풀이하지도 마.",
    "",
    CONNECT_PROMPT_ROUTINE_HEAD,
    `- 이름: ${input.routineLabel}`,
    "- 교체한 뒤 한 번 수동으로 실행해 줘.",
  ].join("\n");
}

/** 구획 하나의 본문. 머리 줄부터 다음 구획 머리 직전까지. 없으면 빈 문자열. */
export function connectPromptSection(prompt: string, head: string): string {
  const start = prompt.indexOf(head);
  if (start < 0) return "";
  const rest = prompt.slice(start + head.length);
  const next = rest.search(/\n\[\d+\] /);
  return next < 0 ? rest : rest.slice(0, next);
}
