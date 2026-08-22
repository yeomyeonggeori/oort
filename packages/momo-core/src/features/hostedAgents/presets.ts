import {
  boundedLabel,
  HOSTED_AGENT_PORT_AUDIENCE,
  HOSTED_AUTH_MODE,
} from "./model";

// =============================================================================
// provider preset 과 설정 안내 (ADR-0162 D8, goal HAP-UX1 / #1360).
//
// preset 은 **검증된 setup recipe 이지 코어 프로토콜이 아니다.** 그래서 이 파일이
// 하는 일은 두 가지뿐이다: 붙일 주소와 값을 정확히 말하는 것, 그리고 아직 실측되지
// 않은 것을 실측된 것처럼 말하지 않는 것.
//
// ## 왜 Grok 줄에 "확인되지 않음"이 붙어 있나
//
// #1344 는 공식 Grok Bot 앱으로 private plugin 등록과 manual routine 실행까지
// 실제로 했다. 그런데 loader 의 요청은 아직 없던 route 에서 404 로 끝났고, 그
// 404 는 **auth challenge 보다 먼저** 일어났다. 즉 Grok 이 bearer 헤더를 어떻게
// 보내는지, `oauth` 와 `static_bearer` 중 무엇을 고르는지는 한 번도 관측되지
// 않았다. ADR-0162 D8 이 그래서 "폐곡선 전에는 즉시·seamless·최소 응답 시간 같은
// 표현을 쓰지 않는다"고 못 박았고, 이 파일의 `verified: false` 한 줄이 그 문장을
// 코드로 옮긴 것이다. 실계정 E2E 가 닫히면 그 줄만 뒤집는다.
//
// ## OAuth 는 고를 수 있는 자리에 서지 않는다
//
// MCP OAuth authorization server 는 이제 있다(HAP-E7 / #1368, flag-gated). 하지만
// 이 마법사에서 OAuth 연결을 **직접 시작하는 길은 아직 없다**: create API 는
// `authMode:oauth` 를 거절한다(E7 deviation 3). OAuth 방식은 provider 의 인가
// 화면에서 사람이 승인해 연결되고(HAP-UX4 / #1369 의 consent 화면), 그 요청을 받는
// `pairing_pending` OAuth 연결은 다른 경로로 만들어진다. 그러니 여기서 고르게 두면
// 그 선택은 create 에서 반드시 실패하고, 실패한 뒤 static bearer 로 조용히 내려가는
// 경로는 ADR 이 명시적으로 금지한 downgrade 다. 그렇다고 목록에서 지우면 "왜
// OAuth 를 못 고르지"라는 질문에 화면이 답하지 못한다. 그래서 **비활성 + 사유**로
// 세운다. 이 레포가 호스트 목록에서 이미 정한 규율과 같다
// (features/timeline/spawnHostChoice.ts 규율 1). create 가 oauth 를 받기 시작하면
// 이 줄의 `disabled` 만 뒤집는다.
// =============================================================================

export type HostedPresetId = "generic" | "grok";

export interface HostedPreset {
  id: HostedPresetId;
  label: string;
  /** 이 preset 이 무엇인지 한 문장. 상시 노출된다. */
  detail: string;
  /**
   * 이 preset 의 setup 이 실제 provider 에서 폐곡선으로 확인됐는가.
   *
   * 거짓이면 화면이 그 사실을 말한다. 값을 감추는 것이 아니라, 성공을 미리
   * 선언하지 않는 것이다.
   */
  verified: boolean;
  /** 아직 확인되지 않은 것. `verified` 가 참이면 없다. */
  unverifiedNote?: string;
  /** provider 설정 화면에서 밟는 순서. 각 줄이 한 동작이다. */
  steps: readonly string[];
  /** 이 setup 이 남기는 것 중 나중에 따로 지워야 하는 것. */
  leavesBehind?: string;
}

/** routine 이름은 결정적이다 (ADR-0162 D6). cleanup 도 이 이름을 찾는다. */
export function hostedRoutineLabel(
  workspaceName: string,
  agentLabel: string
): string {
  return `Oort Inbox: ${boundedLabel(workspaceName, 40)} / ${boundedLabel(
    agentLabel,
    40
  )}`;
}

/** routine 이 시킬 일. ADR-0162 D8 의 template 문장 그대로. */
export const HOSTED_ROUTINE_TEMPLATE =
  "oort inbox를 확인하고, 할 일이 있으면 claim한 뒤 결과를 원래 thread에 게시한다.";

export const HOSTED_PRESETS: readonly HostedPreset[] = [
  {
    id: "generic",
    label: "일반 MCP 에이전트",
    detail:
      "원격 MCP 서버를 등록할 수 있는 에이전트라면 무엇이든 이 순서로 붙습니다.",
    verified: true,
    steps: [
      "provider의 MCP 커넥터 설정에서 원격 서버를 하나 추가합니다.",
      "주소 칸에 아래 Agent Port 주소를 그대로 넣습니다.",
      "인증 헤더의 bearer 값에 아래 연결 값을 넣습니다.",
      "저장한 뒤 커넥터를 한 번 실행하면 이 화면이 감지 상태로 넘어갑니다.",
    ],
  },
  {
    id: "grok",
    label: "Grok Bot",
    detail:
      "Grok Bot을 이 방식으로 붙이는 순서입니다. 값은 아래 것을 그대로 씁니다.",
    verified: false,
    unverifiedNote:
      "Grok이 이 인증 헤더를 실제로 보내는지는 아직 확인되지 않았습니다. 감지가 되지 않으면 값이 아니라 이 방식이 원인일 수 있습니다.",
    steps: [
      "Grok의 Create Plugin으로 비공개 플러그인을 만듭니다.",
      "그 플러그인의 mcp.json에 아래 Agent Port 주소를 원격 서버로 적습니다.",
      "인증 헤더의 bearer 값에 아래 연결 값을 넣고 커넥터를 설치합니다.",
      "아래 이름으로 routine을 만들고 아래 문장을 그 routine의 지시로 넣습니다.",
      "routine을 한 번 수동 실행하면 이 화면이 감지 상태로 넘어갑니다.",
    ],
    leavesBehind:
      "이 방식은 로컬에 플러그인 소스를 남깁니다. 나중에 연결을 해제할 때 커넥터 제거와 별개로 그 소스도 지워야 합니다.",
  },
];

export function hostedPreset(id: HostedPresetId): HostedPreset {
  return (
    HOSTED_PRESETS.find((preset) => preset.id === id) ??
    (HOSTED_PRESETS[0] as HostedPreset)
  );
}

// ---- Agent Port 주소 --------------------------------------------------------

/**
 * provider 설정에 붙일 정규 주소.
 *
 * 서버가 문자열로 주지 않는 값이라 클라이언트가 조립한다. 조립인 이상 틀릴 수
 * 있고, 이 값이 틀리면 사람은 자기 비밀값을 남의 호스트에 붙인다. 그래서 웹훅
 * 수신 URL 이 이미 세워 둔 거절 규칙을 그대로 쓴다:
 *
 *   - http/https 가 아니면 거절. 다른 scheme 은 이 주소가 될 수 없다.
 *   - 계정 정보(userinfo)가 붙어 있으면 거절. 그것은 자격증명이지 주소가 아니다.
 *   - 질의·조각이 붙어 있으면 거절. Agent Port 주소에는 둘 다 없다.
 *
 * `null` 이면 화면은 복사 버튼 대신 이유를 그린다. 추측한 주소를 내미는 것보다
 * 낫다.
 */
export function agentPortEndpoint(baseUrl: string): string | null {
  const trimmed = baseUrl.trim();
  if (trimmed === "") return null;
  let base: URL;
  let resolved: URL;
  try {
    base = new URL(trimmed);
    resolved = new URL(HOSTED_AGENT_PORT_AUDIENCE, base);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") return null;
  if (resolved.origin !== base.origin) return null;
  if (resolved.username !== "" || resolved.password !== "") return null;
  if (resolved.search !== "" || resolved.hash !== "") return null;
  return resolved.toString();
}

export const UNRESOLVABLE_ENDPOINT_NOTICE =
  "이 기기가 이야기하는 서버 주소를 읽지 못해 Agent Port 주소를 만들 수 없습니다. 설정에서 서버 주소를 확인한 뒤 다시 여세요.";

// ---- 인증 방식 --------------------------------------------------------------

export interface HostedAuthModeChoice {
  id: string;
  label: string;
  /** 이 방식이 무엇인지, 또는 왜 지금 고를 수 없는지. 상시 노출된다. */
  detail: string;
  disabled: boolean;
}

/**
 * 인증 방식 둘. 고를 수 있는 것은 지금 하나뿐이고, 나머지는 사유와 함께 선다.
 *
 * 두 번째 줄의 문장은 날짜를 약속하지 않는다. 우리가 모르는 것을 적으면 그 줄이
 * 다음 달에 거짓말이 된다.
 */
export const HOSTED_AUTH_MODE_CHOICES: readonly HostedAuthModeChoice[] = [
  {
    id: HOSTED_AUTH_MODE,
    label: "고정 bearer",
    detail:
      "provider 설정에 값을 직접 붙입니다. 승인 뒤에는 그 값을 새 자격증명으로 한 번 더 바꿔야 합니다.",
    disabled: false,
  },
  {
    id: "oauth",
    label: "OAuth",
    detail:
      "OAuth 방식은 provider의 인가 화면에서 승인해 연결합니다. 이 마법사에서 직접 시작하는 길은 아직 열려 있지 않아 여기서는 고를 수 없습니다.",
    disabled: true,
  },
];

// ---- 일회 노출 문구 ---------------------------------------------------------

export const PAIRING_REVEAL_HEADLINE = "지금 연결 값을 provider 설정에 붙이세요.";

export const PAIRING_REVEAL_WARNING =
  "이 값은 지금 한 번만 보입니다. 서버는 원문을 보관하지 않고, 이 화면을 벗어나면 다시 볼 수 없습니다. 잃어버리면 값을 다시 발급하세요.";

/** 이 값이 무엇이 아닌지. 두 비밀을 섞는 것이 이 흐름의 가장 비싼 오해다. */
export const PAIRING_REVEAL_SCOPE_NOTE =
  "이 값은 접속을 한 번 확인하는 용도입니다. 감지되는 순간 소비되고, 대화나 작업 권한으로 승격되지 않습니다.";

/**
 * Grok Bot 전용. 그록봇 앱을 프로그램으로 제어하지 않는다(패킷 §0-2).
 * 사람이 값을 말해 주고, 그록봇이 자기 VM에 붙인다.
 */
export const PAIRING_NATURAL_LANGUAGE_HANDOFF =
  "이 값을 그록봇에게 자연어로 전달하세요. 그록봇이 직접 붙여 넣습니다.";

export const ACTIVE_REVEAL_HEADLINE = "지금 provider 설정의 값을 이 자격증명으로 바꾸세요.";

export const ACTIVE_REVEAL_WARNING =
  "이 자격증명도 지금 한 번만 보입니다. 앞서 붙인 연결 값은 이미 소비돼 더 이상 통하지 않습니다.";

export const ACTIVE_REVEAL_PROOF_NOTE =
  "provider가 이 값으로 첫 요청에 성공해야 연결이 활성이 됩니다. 그 전까지 이 에이전트는 어떤 대화도 읽지 못합니다.";

/** 값을 저장했다고 사람이 말하는 자리. 웹훅 카드와 같은 낱말을 쓴다. */
export const REVEAL_DONE_LABEL = "저장했습니다";
