// =============================================================================
// 온보딩 2.0 공통 틀의 모델 (ADR-0193 D10·D11, #2807 OB2-1).
//
// 두 클라이언트(웹·데스크탑, 폰)가 같은 표를 읽는다.
//   - 코메토 표정 id 여섯 개와 상태 → 표정 표 (D11 「상태와 표정은 1:1」)
//   - 말풍선 문장 검사: 표정만 있고 문장이 빈 사용을 거부한다
//     (D11 「표정만으로 상태를 전하지 않고 문장이 함께 간다」)
//   - 진행 점 흐름 모델 (D10): 로그인 전·claim 뒤·AI 연결을 한 줄로 잇는다.
//     첫 화면(D0)과 첫 대화(D5)에서는 점이 없다.
//
// 표정 그림(에셋 경로)은 플랫폼 몫이라 여기 없다. 각 클라이언트의 매핑 한 곳이
// 이 id를 그림으로 바꾼다(#2806 OB2-0 전에는 여섯 id 모두 K6 플랫 배지).
//
// ADR-0185 §5-2의 `OWNER_ONBOARDING_STAGES`(2칸)와 그 카운터는 이 모델과 따로
// 산다. 바뀌는 것은 보이는 점뿐이다(ADR-0185 증보 §5-2 해석).
// =============================================================================

/** 코메토 표정 id. #2806 규격 시트(`docs/brand/kometto/expressions.md`)와 같은 이름이다. */
export const KOMETTO_EXPRESSIONS = [
  "idle",
  "thinking",
  "happy",
  "flustered",
  "working",
  "sleepy",
] as const;

export type KomettoExpression = (typeof KOMETTO_EXPRESSIONS)[number];

/** 표정의 한국어 이름(규격 시트·갤러리 표기). 화면 문장이 아니다. */
export const KOMETTO_EXPRESSION_NAMES: Readonly<Record<KomettoExpression, string>> = {
  idle: "대기",
  thinking: "생각",
  happy: "기쁨",
  flustered: "당황",
  working: "작업 중",
  sleepy: "졸림",
};

/** 온보딩 화면이 놓일 수 있는 상태. 화면은 상태를 고르고, 표정은 표가 고른다. */
export const GUIDE_STATES = [
  "awaiting",
  "checking",
  "success",
  "trouble",
  "preparing",
  "skipped",
] as const;

export type GuideState = (typeof GUIDE_STATES)[number];

export type GuideStateRow = {
  readonly state: GuideState;
  readonly expression: KomettoExpression;
  /** ADR-0193 D11 표의 뜻. 사람이 읽는 설명이고 화면 문장이 아니다. */
  readonly meaning: string;
};

/** ADR-0193 D11 상태 → 표정 표. 순서가 표다. 한 상태에 한 표정, 한 표정에 한 상태. */
export const GUIDE_STATE_TABLE: readonly GuideStateRow[] = [
  { state: "awaiting", expression: "idle", meaning: "질문을 기다림" },
  { state: "checking", expression: "thinking", meaning: "감지·확인·연결 중" },
  { state: "success", expression: "happy", meaning: "완료·감지 성공" },
  { state: "trouble", expression: "flustered", meaning: "오류·오프라인" },
  { state: "preparing", expression: "working", meaning: "에이전트 준비 중" },
  { state: "skipped", expression: "sleepy", meaning: "건너뛰고 나중에 할 때" },
];

export function expressionForState(state: GuideState): KomettoExpression {
  const row = GUIDE_STATE_TABLE.find((r) => r.state === state);
  if (!row) throw new Error(`unknown onboarding guide state: ${String(state)}`);
  return row.expression;
}

export function isKomettoExpression(value: unknown): value is KomettoExpression {
  return (
    typeof value === "string" &&
    (KOMETTO_EXPRESSIONS as readonly string[]).includes(value)
  );
}

/**
 * 말풍선 문장을 검사해 돌려준다. 빈 문장(공백뿐 포함)은 던진다.
 *
 * 표정만으로 상태를 전하는 화면은 스크린리더에게 아무것도 말하지 않는다
 * (코메토 그림은 장식 `alt=""`다). 그래서 이것은 문구 규칙이 아니라 계약이다:
 * 문장 없이 코메토를 그리는 호출은 렌더에서 실패한다.
 */
export function assertGuideLine(line: string): string {
  if (typeof line !== "string" || line.trim() === "") {
    throw new Error(
      "KomettoGuide needs a line: an expression alone does not tell the state (ADR-0193 D11)"
    );
  }
  return line.trim();
}

// ---- 진행 점 (ADR-0193 D10) -------------------------------------------------

/** 온보딩 2.0 화면 id (ADR-0193 흐름 표의 D0~D5). */
export type OnboardingScreen =
  | "welcome" // D0
  | "sign-in" // D1
  | "join" // D1′
  | "claim" // D1″
  | "workspace-profile" // D2
  | "invite" // D3
  | "ai-connect" // D4
  | "first-conversation"; // D5

export type OnboardingRoute = "login" | "invite" | "claim";

/**
 * 경로별 점 줄. 로그인 전·claim 뒤·AI 연결이 한 줄을 공유한다.
 * 로그인 경로의 AI 연결은 선택이라(흐름 표: 로그인은 D1 뒤 곧장 앱) 1~2점이다.
 */
export function onboardingDotScreens(
  route: OnboardingRoute,
  options: { aiConnect?: boolean } = {}
): readonly OnboardingScreen[] {
  switch (route) {
    case "login":
      return options.aiConnect ? ["sign-in", "ai-connect"] : ["sign-in"];
    case "invite":
      return ["join", "ai-connect"];
    case "claim":
      return ["claim", "workspace-profile", "invite", "ai-connect"];
  }
}

export type OnboardingDotState = "done" | "current" | "todo";

export type OnboardingDots = {
  readonly total: number;
  /** 1부터 센다. */
  readonly current: number;
  readonly dots: readonly OnboardingDotState[];
  /** 스크린리더용 숨김 문장(「4단계 중 2단계」). */
  readonly label: string;
};

export function onboardingDotsLabel(total: number, current: number): string {
  return `${total}단계 중 ${current}단계`;
}

/**
 * 이 경로의 이 화면에 그릴 점. 경로의 점 줄에 없는 화면이면 null이다.
 * 첫 화면(D0)과 첫 대화(D5)는 어느 경로의 점 줄에도 없어서 늘 null이다.
 */
export function onboardingDots(
  route: OnboardingRoute,
  screen: OnboardingScreen,
  options: { aiConnect?: boolean } = {}
): OnboardingDots | null {
  const screens = onboardingDotScreens(route, options);
  const index = screens.indexOf(screen);
  if (index < 0) return null;
  const total = screens.length;
  const current = index + 1;
  return {
    total,
    current,
    dots: screens.map((_, i) =>
      i < index ? "done" : i === index ? "current" : "todo"
    ),
    label: onboardingDotsLabel(total, current),
  };
}
