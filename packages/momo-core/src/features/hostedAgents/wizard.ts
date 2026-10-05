import { attachParticle } from "../../lib/koreanParticle";
import {
  isHostedTerminal,
  type HostedAgentConnection,
} from "./model";

// =============================================================================
// "Bring your hosted agent" 마법사의 단계 기계 (ADR-0162 D6, goal HAP-UX1 / #1360).
//
// 서버 상태 하나에서 화면 하나를 도출한다. 마법사가 자기 진행도를 따로 세지 않는
// 이유는 이 흐름의 절반이 **다른 프로세스가 일으키는 사건**이기 때문이다:
// 감지는 provider 의 에이전트가 다이얼인해야 일어나고, 활성은 그 에이전트가 새
// 자격증명으로 증명해야 일어난다. 로컬 카운터를 두면 새로고침·재접속·다른 탭이
// 각자 다른 진행도를 들고 같은 커넥션을 설명하게 된다.
//
// ## 지역 상태는 정확히 하나다 — "지금 비밀값이 화면에 떠 있는가"
//
// 그것은 서버가 알 수 없는 사실이고(서버는 값을 발급했는지만 안다), 그 값이
// 떠 있는 동안은 화면을 바꾸면 안 되는 유일한 구간이라 단계 함수의 인자로 받는다.
//
// ## `detected` 는 화면 둘이다
//
// 승인(`confirm`)은 자격증명을 발급할 뿐 상태를 바꾸지 않는다. 그래서
// `detected` 는 `activeCredentialId` 의 유무로 두 화면을 가른다: 승인 전(4단계)과
// 증명 대기(5단계). 상태 이름만 보고 화면을 고르면 승인 직후 화면이 4단계로
// 되돌아가고, 사람은 방금 한 승인을 한 번 더 하려 든다.
//
// ## 만료는 단계가 아니라 **가로막힘**이다
//
// `expired` 는 자기 번호를 갖지 않는다. 그것이 가로막는 단계(2번, 연결 값 발급)의
// 번호를 그대로 쓰고, 화면은 "여기서 막혔고 이렇게 푼다"를 말한다. 새 번호를
// 주면 진행 표시가 뒤로 가는 것처럼 보이는데 실제로는 같은 자리에 서 있는 것이다.
// =============================================================================

export type HostedWizardStep =
  | "identity"
  | "pairing"
  | "detecting"
  | "approval"
  | "activation"
  | "expired"
  /** cleanup_pending·disconnected. 이 마법사의 것이 아니다 (UX2 / #1362). */
  | "closed";

export interface HostedWizardStepSpec {
  id: HostedWizardStep;
  /** 진행 표시의 번호. 1부터 5까지이고 `expired` 는 2번을 함께 쓴다. */
  number: number;
  title: string;
  /** 이 단계에서 사람이 하는 일 한 문장. 제목 아래에 상시 노출된다. */
  purpose: string;
}

/** 진행 표시에 서는 다섯 단계. 순서가 곧 번호다. */
export const HOSTED_WIZARD_STEPS: readonly HostedWizardStepSpec[] = [
  {
    id: "identity",
    number: 1,
    title: "전용 에이전트 이름 정하기",
    purpose:
      "이 연결만 쓰는 에이전트 멤버를 새로 만들어요. 기존 에이전트에 덧붙이지 않아요.",
  },
  {
    id: "pairing",
    number: 2,
    title: "연결 값 발급",
    // 일반 프리셋 문면. Grok 은 presets.ts `GROK_PAIRING_PURPOSE` 가 같은 자리를 덮는다.
    purpose:
      "연결 값은 지금 한 번만 보여요. AI 회사 설정에 붙여 넣고 이 화면에서 저장을 마치세요.",
  },
  {
    id: "detecting",
    number: 3,
    title: "다이얼인 기다리기",
    purpose:
      "이 에이전트가 연결 값으로 접속하면 감지돼요. 감지만으로는 아무 권한도 열리지 않아요.",
  },
  {
    id: "approval",
    number: 4,
    title: "사람이 채널과 권한 확인",
    purpose:
      "이 에이전트가 닿을 채널과 권한을 직접 골라요. 고르지 않은 채널은 열리지 않아요.",
  },
  {
    id: "activation",
    number: 5,
    title: "자격증명 교체와 활성 확인",
    purpose:
      "승인하면 새 자격증명이 한 번만 보여요. AI 회사 설정의 연결 값을 그 값으로 바꿔야 활성이 돼요.",
  },
];

export function hostedStepSpec(step: HostedWizardStep): HostedWizardStepSpec {
  if (step === "expired") return HOSTED_WIZARD_STEPS[1] as HostedWizardStepSpec;
  const found = HOSTED_WIZARD_STEPS.find((item) => item.id === step);
  // `closed` 는 진행 표시를 갖지 않는다. 그래도 번호를 물으면 마지막을 답한다:
  // 해제는 마법사가 끝난 뒤에 일어나는 일이다.
  return (found ?? HOSTED_WIZARD_STEPS[HOSTED_WIZARD_STEPS.length - 1]) as HostedWizardStepSpec;
}

/** 5단계가 이미 끝난 자리의 같은 한 문장. 교체는 과거형이고, 남은 것은 확인이다. */
export const HOSTED_ACTIVATION_DONE_PURPOSE =
  "자격증명 교체가 끝났고 첫 증명도 성공했어요. 승인한 채널에서 한 번 불러 확인하세요.";

/**
 * 제목 아래에 서는 한 문장. 5단계에서만 서버 상태를 함께 본다.
 *
 * `HOSTED_WIZARD_STEPS` 의 문장은 **아직 하지 않은 일**을 말한다. 5단계는 이
 * 마법사에서 유일하게 자기 자리에 머문 채 끝나는 단계라(`activation` 은 증명
 * 대기와 활성 둘 다이다), 그 문장이 활성 화면에도 그대로 서면 이미 끝난 교체를
 * 앞으로 할 일처럼 지시한다. 사람은 방금 바꾼 provider 설정을 한 번 더 바꾸러
 * 간다.
 *
 * 나머지 단계에는 이 갈림이 없다: 각자 다음 단계가 열리면 화면을 떠난다.
 */
export function hostedStepPurpose(
  step: HostedWizardStep,
  connection: HostedAgentConnection | null
): string {
  if (step === "activation" && connection?.status === "active") {
    return HOSTED_ACTIVATION_DONE_PURPOSE;
  }
  return hostedStepSpec(step).purpose;
}

/**
 * 지금 서 있는 단계.
 *
 * @param connection 서버가 아는 커넥션. 아직 만들지 않았으면 `null`.
 * @param pairingRevealed 연결 값이 지금 화면에 떠 있는가. 서버가 알 수 없는
 *   유일한 사실이고, 그것이 켜져 있는 동안 2단계를 떠나지 않는다.
 */
export function hostedWizardStep(
  connection: HostedAgentConnection | null,
  pairingRevealed: boolean
): HostedWizardStep {
  if (connection === null) return "identity";
  if (isHostedTerminal(connection.status)) return "closed";
  switch (connection.status) {
    case "pairing_pending":
      return pairingRevealed ? "pairing" : "detecting";
    case "detected":
      // 승인은 상태를 바꾸지 않는다(머리말). 자격증명 id 가 그 경계다.
      return connection.activeCredentialId === undefined ? "approval" : "activation";
    case "active":
      return "activation";
    case "expired":
      return "expired";
    default:
      return "closed";
  }
}

/** 5단계 안에서 증명이 아직 안 왔는가. 활성 문장과 테스트 멘션이 이걸로 갈린다. */
export function awaitingProof(connection: HostedAgentConnection | null): boolean {
  return (
    connection !== null &&
    connection.status === "detected" &&
    connection.activeCredentialId !== undefined
  );
}

/**
 * 지금 이 연결이 **남의 프로세스가 일으킬 사건**을 기다리는가.
 *
 * 되묻기(폴링)의 유일한 근거다. 이 흐름에서 그런 자리는 정확히 둘이고, 머리말이
 * 세는 그 둘과 같다:
 *
 *   1. `pairing_pending` — 상대 에이전트의 **다이얼인**을 기다린다
 *   2. `detected` + 자격증명 발급됨 — 그 에이전트의 **증명**을 기다린다
 *
 * 나머지는 기다릴 상대가 없다. 승인 화면(`detected` 이고 자격증명 전)에서 다음
 * 수를 두는 것은 화면 앞의 사람이고, `active` 는 도착한 상태이며, `expired` 와
 * 해제 계열은 사람이 손을 대야 움직인다. 이 함수가 따로 있는 이유가 그것이다:
 * "연결을 하나 골랐는가"로 되물으면 활성 연결을 열어 둔 탭이 아무도 기다리지
 * 않는 사건을 위해 5초마다 서버를 두드린다.
 */
export function hostedAwaitsRemoteEvent(
  connection: HostedAgentConnection | null
): boolean {
  if (connection === null) return false;
  if (connection.status === "pairing_pending") return true;
  return awaitingProof(connection);
}

// ---- 게이트 -----------------------------------------------------------------

export interface HostedGate {
  allowed: boolean;
  /** 막힌 이유 한 문장. 허용되면 없다. 화면은 이 문장을 **감추지 않는다**. */
  blockedCopy?: string;
}

/**
 * 지금 연결 값을 다시 발급할 수 있는가.
 *
 * 서버 `regenerate_pairing_in_tx` 가 받는 상태 셋을 그대로 비춘다. 활성 연결의
 * 재발급은 409 이고, 그 거절을 화면이 미리 말하지 않으면 사람은 살아 있는 연결을
 * 끊으려 시도한 뒤에야 이유를 듣는다.
 */
export function regenerateGate(connection: HostedAgentConnection | null): HostedGate {
  if (connection === null) {
    return { allowed: false, blockedCopy: "아직 연결을 만들지 않았어요." };
  }
  switch (connection.status) {
    case "pairing_pending":
    case "detected":
    case "expired":
      return { allowed: true };
    case "active":
      return {
        allowed: false,
        blockedCopy:
          "이미 활성인 연결이에요. 값을 다시 발급하려면 먼저 이 연결을 해제해야 해요.",
      };
    case "cleanup_pending":
    case "disconnected":
      return {
        allowed: false,
        blockedCopy: "해제된 연결이에요. 다시 쓰려면 새 연결을 만드세요.",
      };
  }
}

/**
 * 지금 승인을 저장할 수 있는가.
 *
 * 상태 조건만 본다. 고른 채널·권한이 유효한지는 `approval.ts` 의 몫이고, 두
 * 판정을 한 함수에 섞으면 "왜 저장 버튼이 죽어 있나"의 답이 두 곳으로 갈린다.
 */
export function confirmStateGate(connection: HostedAgentConnection | null): HostedGate {
  if (connection === null) {
    return { allowed: false, blockedCopy: "아직 연결을 만들지 않았어요." };
  }
  if (connection.status === "pairing_pending") {
    return {
      allowed: false,
      blockedCopy:
        "아직 이 에이전트가 다이얼인하지 않았어요. 감지된 뒤에 승인할 수 있어요.",
    };
  }
  if (connection.status === "expired") {
    return {
      allowed: false,
      blockedCopy: "연결 값이 만료됐어요. 새 값을 발급한 뒤 다시 승인하세요.",
    };
  }
  if (connection.status !== "detected") {
    return {
      allowed: false,
      blockedCopy: "이 연결은 지금 승인할 수 있는 상태가 아니에요.",
    };
  }
  if (connection.activeCredentialId !== undefined) {
    return {
      allowed: false,
      blockedCopy:
        "이미 승인해 자격증명을 발급했어요. 승인을 바꾸려면 연결 값을 다시 발급해 처음부터 진행하세요.",
    };
  }
  return { allowed: true };
}

/**
 * 테스트 멘션을 열 수 있는가.
 *
 * ADR-0162 D6 의 마지막 관문이다: 자격증명 증명이 성공한 뒤에만 연다. 승인만으로
 * 여는 화면은 아직 아무 도구도 열리지 않은 에이전트를 부르라고 권하는 것이고,
 * 그 멘션은 답이 오지 않는다(전용 멤버가 아직 pause 상태다).
 */
export function testMentionGate(connection: HostedAgentConnection | null): HostedGate {
  if (connection === null || connection.status !== "active") {
    return {
      allowed: false,
      blockedCopy:
        "자격증명 증명이 아직 성공하지 않았어요. 활성이 된 뒤에 테스트 멘션을 보낼 수 있어요.",
    };
  }
  if (connection.approvedChannelIds.length === 0) {
    return {
      allowed: false,
      blockedCopy:
        "승인한 채널이 없어요. 이 에이전트가 닿을 채널이 없으므로 멘션할 자리도 없어요.",
    };
  }
  return { allowed: true };
}

// ---- 만료 -------------------------------------------------------------------

/** 서버 `HOSTED_PAIRING_TTL_SECONDS`. 화면이 자기 숫자를 지어내지 않는다. */
export const HOSTED_PAIRING_TTL_MS = 15 * 60 * 1000;

export interface PairingExpiry {
  expired: boolean;
  /** 남은 시간 한 마디. 초 단위로 흔들리지 않게 분으로 반올림한다. */
  label: string;
}

/**
 * 연결 값이 언제까지 유효한가.
 *
 * 초를 그리지 않는 이유는 이 값이 사람의 손 속도로 소비되기 때문이다. 매초 바뀌는
 * 숫자는 읽는 사람을 재촉할 뿐이고, 이 표면의 모션 규율(피드백만)과도 어긋난다.
 */
export function pairingExpiry(expiresAtMs: number, nowMs: number): PairingExpiry {
  const remaining = expiresAtMs - nowMs;
  if (remaining <= 0) return { expired: true, label: "만료됨" };
  const minutes = Math.floor(remaining / 60_000);
  if (minutes < 1) return { expired: false, label: "1분 안에 만료" };
  return { expired: false, label: `약 ${minutes}분 뒤 만료` };
}

// ---- 문구 -------------------------------------------------------------------

/**
 * 상태가 바뀔 때 스크린리더가 읽을 한 문장.
 *
 * **비밀값을 절대 담지 않는다.** live region 은 값이 화면에 뜨는 순간 그것을
 * 자동으로 낭독하므로(웹훅 카드 리뷰 M2 가 같은 자리에서 찾아낸 결함), 여기서
 * 말하는 것은 언제나 "무엇이 일어났는가"이지 "그 값이 무엇인가"가 아니다.
 */
export function hostedLiveMessage(
  step: HostedWizardStep,
  connection: HostedAgentConnection | null
): string {
  switch (step) {
    case "identity":
      return "1단계. 전용 에이전트의 이름과 핸들을 정하세요.";
    case "pairing":
      return "2단계. 연결 값이 발급됐어요. 화면에서 복사해 AI 회사 설정에 넣으세요.";
    case "detecting":
      return "3단계. 이 에이전트의 다이얼인을 기다리는 중이에요.";
    case "approval":
      return "4단계. 다이얼인을 감지했어요. 닿을 채널과 권한을 확인하세요.";
    case "activation":
      return awaitingProof(connection)
        ? "5단계. 새 자격증명을 발급했어요. AI 회사 설정의 값을 바꾸면 증명이 진행돼요."
        : "5단계. 연결이 활성이에요. 승인한 채널에서 이 에이전트를 부를 수 있어요.";
    case "expired":
      return "연결 값이 만료됐어요. 새 값을 발급해야 이어서 진행할 수 있어요.";
    case "closed":
      return "이 연결은 해제 절차에 들어갔어요. 이 화면에서는 더 진행하지 않아요.";
  }
}

/**
 * 활성이 된 뒤 무엇을 해 보라고 말하는 문장.
 *
 * 조사를 손으로 적지 않는 이유는 이 문장의 목적어가 **핸들**이기 때문이다.
 * 핸들은 라틴 문자로 끝나는 것이 기본이고("@kim-intern"), 받침이 있는 한글
 * 핸들도 가능하다. 손으로 적은 「을」이 화면에 나갔던 것이 이 함수가 생긴 이유다.
 */
export function testMentionSentence(
  channelLabel: string,
  handle: string
): string {
  const called = attachParticle(`@${handle}`, "object");
  return `${channelLabel}에서 ${called} 부르면 이 에이전트가 같은 자리에 답해요. 답은 다른 팀메이트의 메시지와 같은 경로로 와요.`;
}

/** 마법사 전체가 무엇을 하는 물건인지. 진입점과 머리글이 같은 말을 쓴다. */
export const HOSTED_WIZARD_TITLE = "호스티드 봇 초대";

export const HOSTED_WIZARD_LEAD =
  "이미 다른 곳에서 돌리고 있는 에이전트를 이 워크스페이스의 팀메이트로 들여요. oort가 그 에이전트를 부르는 것이 아니라, 그 에이전트가 oort로 접속해요.";

/**
 * 해제 흐름이 이 화면의 것이 아니라는 사실. 감추지 않고 적는다.
 *
 * UX2(#1362)가 그 화면을 세운 뒤 자리를 이름으로 적는다. 「연결 관리 화면」은
 * 그것이 없던 동안의 자리표시였고, 이름 없는 안내는 사람을 어디로도 보내지
 * 못한다.
 */
export const HOSTED_CLOSED_NOTICE =
  "이 연결은 해제 절차에 들어갔어요. 남은 정리는 에이전트 화면의 연결 탭에서 이어서 해요.";

// ---- 시작 전 미리 안내 · 자격증명 교체 체크리스트 · 멈춤 원인 (#3521) -------------
//
// 이 마법사에서 가장 많이 이탈하는 자리는 5단계의 두 번째 교체다(AT-7 점검 마찰
// 1·2). 값이 둘이라는 사실을 사람은 5단계에 와서야 처음 듣고, 그래서 첫 번째
// 연결 값만 붙인 채 4단계 승인 뒤에 멈춘다. 세 문구 묶음은 모두 그 한 사건을
// 겨냥한다: 미리 말하고(1단계), 하는 중에 보이게 하고(5단계), 놓쳤을 때 이름을
// 붙여 알린다(5단계가 길어질 때).

/** 1단계 머리에 서는 한 줄. 몇 번 붙여 넣는지가 핵심이라 숫자로 말한다. */
export const HOSTED_PREVIEW_HEADLINE = "두 번 붙여 넣어요: 연결 값, 그다음 활성 자격증명";

export interface HostedPreviewStep {
  id: "pairing" | "credential";
  /** 몇 번째 값인가. */
  order: string;
  label: string;
  detail: string;
}

export const HOSTED_PREVIEW_STEPS: readonly HostedPreviewStep[] = [
  {
    id: "pairing",
    order: "첫 번째",
    label: "연결 값",
    detail: "2단계에서 받아 AI 회사 설정에 붙여 넣어요.",
  },
  {
    id: "credential",
    order: "두 번째",
    label: "활성 자격증명",
    detail: "승인한 뒤 5단계에서 받아, 연결 값을 이 값으로 바꿔요.",
  },
];

export const HOSTED_PREVIEW_NOTE =
  "두 번째를 놓치면 승인 뒤에 멈춘 채 활성이 되지 않아요.";

export type HostedSwapItemId = "replace" | "run" | "proof";

export interface HostedSwapItem {
  id: HostedSwapItemId;
  label: string;
  /** 사람이 직접 표시하는 줄인가. `false` 면 서버 상태가 채운다. */
  manual: boolean;
}

export const HOSTED_SWAP_TITLE = "교체 체크리스트";

export const HOSTED_SWAP_ITEMS: readonly HostedSwapItem[] = [
  {
    id: "replace",
    label: "AI 회사 설정의 연결 값을 이 자격증명으로 바꿨어요",
    manual: true,
  },
  { id: "run", label: "커넥터나 routine을 한 번 실행했어요", manual: true },
  { id: "proof", label: "첫 요청이 성공해 활성이 됐어요", manual: false },
];

export const HOSTED_SWAP_DONE_NOTE = "교체가 끝났고 첫 요청도 성공했어요.";

export interface HostedSwapTicks {
  replace: boolean;
  run: boolean;
}

export interface HostedSwapRow extends HostedSwapItem {
  done: boolean;
}

/**
 * 체크리스트의 각 줄이 끝났는가.
 *
 * 마지막 줄은 사람이 표시하지 않는다: 활성은 서버만 아는 사실이다. 활성이면 앞의
 * 두 줄도 반드시 일어난 일이므로(증명이 새 자격증명으로 왔다) 표시 여부와 무관하게
 * 끝으로 본다. 화면을 닫았다 다시 열어 표시가 사라져도 활성 연결이 빈 칸으로
 * 보이지 않게 하는 것이 이유다.
 */
export function hostedSwapRows(
  connection: HostedAgentConnection | null,
  ticks: HostedSwapTicks
): HostedSwapRow[] {
  const active = connection?.status === "active";
  return HOSTED_SWAP_ITEMS.map((item) => ({
    ...item,
    done: active ? true : item.id === "proof" ? false : ticks[item.id],
  }));
}

/** 연결이 마지막으로 바뀐 뒤(승인으로 자격증명을 발급한 시각) 이만큼 증명이 없으면 멈춘 것으로 본다. */
export const HOSTED_SWAP_STALL_MS = 3 * 60 * 1000;

export interface HostedSwapStall {
  /** 왜 멈췄을 가능성이 높은가. */
  cause: string;
  /** 지금 무엇을 하면 되는가. */
  action: string;
}

/**
 * 5단계가 길어지는데 증명이 오지 않을 때의 원인과 다음 행동.
 *
 * 서버는 거절 사유를 상태로 내주지 않으므로(AT-7 제안 3은 서버 변경이다) 이 판정은
 * 사람이 남긴 표시와 시간으로만 말한다. 그래서 단정하지 않고 가장 흔한 원인을
 * 앞에 둔다. 교체했다고 표시한 사람과 안 한 사람의 다음 행동이 달라 문장이 둘이다.
 */
export function hostedSwapStall(
  connection: HostedAgentConnection | null,
  nowMs: number,
  replaced: boolean
): HostedSwapStall | null {
  if (!awaitingProof(connection) || connection === null) return null;
  if (nowMs - connection.updatedAtMs < HOSTED_SWAP_STALL_MS) return null;
  if (!replaced) {
    return {
      cause:
        "아직 AI 회사 설정의 값을 바꾸지 않았다면 그 때문일 수 있어요. 처음 붙인 연결 값은 이미 소비돼 활성이 되지 않아요. 위 표시는 창을 닫으면 사라져요.",
      action:
        "AI 회사 설정을 열어 값을 이 연결에서 받은 활성 자격증명으로 바꾸고, 커넥터나 routine을 한 번 실행하세요. 자격증명을 잃어버렸다면 연결 값을 다시 발급해 처음부터 진행하세요.",
    };
  }
  return {
    cause:
      "바꿨다고 표시했는데 첫 요청이 오지 않아요. 붙인 값이 잘렸거나, 커넥터나 routine이 아직 실행되지 않았을 수 있어요.",
    action:
      "붙인 값 앞뒤에 공백이 없는지 보고 커넥터나 routine을 한 번 더 실행한 뒤 지금 확인을 누르세요. 그래도 안 되면 연결 값을 다시 발급하세요.",
  };
}
