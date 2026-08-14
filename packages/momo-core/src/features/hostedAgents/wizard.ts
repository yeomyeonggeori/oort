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
      "이 연결만 쓰는 에이전트 멤버를 새로 만듭니다. 기존 에이전트에 덧붙이지 않습니다.",
  },
  {
    id: "pairing",
    number: 2,
    title: "연결 값 발급",
    purpose:
      "연결 값은 지금 한 번만 보입니다. provider 설정에 붙여 넣고 이 화면에서 저장을 마치세요.",
  },
  {
    id: "detecting",
    number: 3,
    title: "다이얼인 기다리기",
    purpose:
      "이 에이전트가 연결 값으로 접속하면 감지됩니다. 감지만으로는 아무 권한도 열리지 않습니다.",
  },
  {
    id: "approval",
    number: 4,
    title: "사람이 채널과 권한 확인",
    purpose:
      "이 에이전트가 닿을 채널과 권한을 직접 고릅니다. 고르지 않은 채널은 열리지 않습니다.",
  },
  {
    id: "activation",
    number: 5,
    title: "자격증명 교체와 활성 확인",
    purpose:
      "승인하면 새 자격증명이 한 번만 보입니다. provider 설정의 연결 값을 그 값으로 바꿔야 활성이 됩니다.",
  },
];

export function hostedStepSpec(step: HostedWizardStep): HostedWizardStepSpec {
  if (step === "expired") return HOSTED_WIZARD_STEPS[1] as HostedWizardStepSpec;
  const found = HOSTED_WIZARD_STEPS.find((item) => item.id === step);
  // `closed` 는 진행 표시를 갖지 않는다. 그래도 번호를 물으면 마지막을 답한다:
  // 해제는 마법사가 끝난 뒤에 일어나는 일이다.
  return (found ?? HOSTED_WIZARD_STEPS[HOSTED_WIZARD_STEPS.length - 1]) as HostedWizardStepSpec;
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
    return { allowed: false, blockedCopy: "아직 연결을 만들지 않았습니다." };
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
          "이미 활성인 연결입니다. 값을 다시 발급하려면 먼저 이 연결을 해제해야 합니다.",
      };
    case "cleanup_pending":
    case "disconnected":
      return {
        allowed: false,
        blockedCopy: "해제된 연결입니다. 다시 쓰려면 새 연결을 만드세요.",
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
    return { allowed: false, blockedCopy: "아직 연결을 만들지 않았습니다." };
  }
  if (connection.status === "pairing_pending") {
    return {
      allowed: false,
      blockedCopy:
        "아직 이 에이전트가 다이얼인하지 않았습니다. 감지된 뒤에 승인할 수 있습니다.",
    };
  }
  if (connection.status === "expired") {
    return {
      allowed: false,
      blockedCopy: "연결 값이 만료됐습니다. 새 값을 발급한 뒤 다시 승인하세요.",
    };
  }
  if (connection.status !== "detected") {
    return {
      allowed: false,
      blockedCopy: "이 연결은 지금 승인할 수 있는 상태가 아닙니다.",
    };
  }
  if (connection.activeCredentialId !== undefined) {
    return {
      allowed: false,
      blockedCopy:
        "이미 승인해 자격증명을 발급했습니다. 승인을 바꾸려면 연결 값을 다시 발급해 처음부터 진행하세요.",
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
        "자격증명 증명이 아직 성공하지 않았습니다. 활성이 된 뒤에 테스트 멘션을 보낼 수 있습니다.",
    };
  }
  if (connection.approvedChannelIds.length === 0) {
    return {
      allowed: false,
      blockedCopy:
        "승인한 채널이 없습니다. 이 에이전트가 닿을 채널이 없으므로 멘션할 자리도 없습니다.",
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
      return "2단계. 연결 값이 발급됐습니다. 화면에서 복사해 provider 설정에 넣으세요.";
    case "detecting":
      return "3단계. 이 에이전트의 다이얼인을 기다리는 중입니다.";
    case "approval":
      return "4단계. 다이얼인을 감지했습니다. 닿을 채널과 권한을 확인하세요.";
    case "activation":
      return awaitingProof(connection)
        ? "5단계. 새 자격증명을 발급했습니다. provider 설정의 값을 바꾸면 증명이 진행됩니다."
        : "5단계. 연결이 활성입니다. 승인한 채널에서 이 에이전트를 부를 수 있습니다.";
    case "expired":
      return "연결 값이 만료됐습니다. 새 값을 발급해야 이어서 진행할 수 있습니다.";
    case "closed":
      return "이 연결은 해제 절차에 들어갔습니다. 이 화면에서는 더 진행하지 않습니다.";
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
  return `${channelLabel}에서 ${called} 부르면 이 에이전트가 같은 자리에 답합니다. 답은 다른 팀메이트의 메시지와 같은 경로로 옵니다.`;
}

/** 마법사 전체가 무엇을 하는 물건인지. 진입점과 머리글이 같은 말을 쓴다. */
export const HOSTED_WIZARD_TITLE = "호스티드 에이전트 연결";

export const HOSTED_WIZARD_LEAD =
  "이미 다른 곳에서 돌리고 있는 에이전트를 이 워크스페이스의 팀메이트로 들입니다. oort가 그 에이전트를 부르는 것이 아니라, 그 에이전트가 oort로 접속합니다.";

/** 해제 흐름이 이 화면의 것이 아니라는 사실. 감추지 않고 적는다. */
export const HOSTED_CLOSED_NOTICE =
  "이 연결은 해제 절차에 들어갔습니다. 남은 정리는 연결 관리 화면에서 이어서 합니다.";
