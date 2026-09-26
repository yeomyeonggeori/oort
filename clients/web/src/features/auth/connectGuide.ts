import {
  expressionForState,
  type GuideState,
  type KomettoExpression,
} from "@momo/core/features/onboarding/guide";
import type { OnboardingStep } from "./onboardingFlow";

// =============================================================================
// 로그인 전 세 화면의 코메토 말 (ADR-0193 D11, #2808·#2809·#2810 M5).
//
// 화면은 상태를 고르고, 표정은 core 표(`expressionForState`)가 고르고, 문장은
// 이 표가 고른다. 표정과 문장은 늘 함께 바뀐다(「표정만으로 상태를 전하지 않는다」).
// 코메토의 말은 해요체 한 문장이다. 무엇이 잘못됐고 무엇을 하면 되는지는 문제
// 자리의 합니다체 오류(배너·필드 아래)가 말한다.
// =============================================================================

/** 화면이 지금 놓인 상태. 우선순위: 오프라인 > 오류 > 확인 중 > 대기. */
export type ConnectCondition = {
  offline: boolean;
  failed: boolean;
  busy: boolean;
};

export function connectGuideState(
  step: OnboardingStep,
  condition: ConnectCondition
): GuideState {
  if (condition.offline || condition.failed) return "trouble";
  if (condition.busy) return "checking";
  // D1′은 링크가 이미 팀을 찾아 준 화면이라 기쁨으로 맞는다(#2810 Acceptance).
  if (step === "join") return "success";
  return "awaiting";
}

export type ConnectGuide = {
  state: GuideState;
  expression: KomettoExpression;
  line: string;
  detail?: string;
};

type Copy = { line: string; detail?: string };

const OFFLINE_LINE = "지금은 인터넷에 닿지 않아요.";

/** 세 화면이 실제로 쓰는 상태만 있다. 나머지 상태는 대기 문장으로 떨어진다. */
const LINES: Record<OnboardingStep, Partial<Record<GuideState, Copy>> & { awaiting: Copy }> = {
  welcome: {
    awaiting: { line: "안녕하세요, 저는 코메토예요. 어디로 갈까요?" },
    trouble: { line: "그 주소로는 길을 못 찾았어요." },
  },
  "sign-in": {
    awaiting: { line: "다시 왔군요. 이메일로 들어가요." },
    checking: { line: "들어갈 수 있는지 확인하고 있어요." },
    trouble: { line: "들어가지 못했어요." },
  },
  join: {
    awaiting: { line: "초대를 받았어요.", detail: "세 칸만 채우면 바로 들어가요." },
    success: { line: "초대를 받았어요.", detail: "세 칸만 채우면 바로 들어가요." },
    checking: { line: "팀에 들어가고 있어요." },
    trouble: { line: "초대로 들어가지 못했어요." },
  },
};

/**
 * 이 화면·상태의 코메토 말. `workspaceName`을 알면 D1′은 「{이름}팀이
 * 초대했어요.」다. 초대 링크에 이름이 없어 지금은 늘 모른다(#2810).
 */
export function connectGuide(
  step: OnboardingStep,
  condition: ConnectCondition,
  options: {
    workspaceName?: string;
    pendingInviteCode?: boolean;
    /** 가입은 됐고 표시 이름 저장만 실패했다(fail-forward). */
    nameSaveFailed?: boolean;
  } = {}
): ConnectGuide {
  const state = connectGuideState(step, condition);
  const expression = expressionForState(state);
  if (condition.offline) {
    return { state, expression, line: OFFLINE_LINE };
  }
  if (step === "join" && options.nameSaveFailed && state === "trouble") {
    // 가입 실패로 읽히면 안 된다: 계정은 이미 있다.
    return { state, expression, line: "팀에는 들어왔는데 이름을 저장하지 못했어요." };
  }
  if (step === "welcome" && options.pendingInviteCode && state === "awaiting") {
    return { state, expression, line: "초대 코드를 받았어요. 어느 팀 서버인가요?" };
  }
  const name = options.workspaceName?.trim();
  if (step === "join" && name && state === "success") {
    return {
      state,
      expression,
      line: `${name}팀이 초대했어요.`,
      detail: LINES.join.awaiting.detail,
    };
  }
  const copy = LINES[step][state] ?? LINES[step].awaiting;
  return { state, expression, ...copy };
}
