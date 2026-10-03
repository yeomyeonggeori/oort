// =============================================================================
// 로그인 뒤 「에이전트로 만들기」 한 단계 (#3389 AIH-5, ADR-0190 D3-h, ADR-0193
// D15-D16).
//
// 이 모듈은 화면 없이 순서만 맡는다: 확인(사람이 누른다) → 서버 등록 → (Claude)
// 앱이 공식 CLI에 연결 → 끝. 규율:
//
// - **확인 전에는 아무것도 부르지 않는다.** 서버도 셸도 `submit()`이 불리기 전에는
//   호출되지 않는다(시험이 잠근다). 컨트롤러를 만들거나 `setHandle`을 불러도 마찬가지다.
// - **연결 값은 이 클로저에만 있다.** 상태에는 사람이 직접 해야 하는 단계(수동)의
//   화면용 계획만 나가고, 그것도 `dispose()`에서 비운다. 로그·콘솔·저장소에 쓰지
//   않는다. 오류 객체도 기록하지 않는다(값이 들어 있을 수 있다).
// - 셸이 CLI 연결을 못 하면(어떤 이유든) 값을 다른 길로 실어 보내지 않고 수동
//   단계로 넘긴다. 수동 명령은 사람이 붙여 넣는 것이지 앱의 실행이 아니다
//   (ADR-0190 D3-h 「실패하면 닫힌 채로」).
// =============================================================================

import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import {
  parseRegisteredSubscriptionAgent,
  type RegisteredSubscriptionAgent,
} from "@momo/core/features/hostedAgents/model";
import {
  subscriptionConnectPlan,
  type SubscriptionConnectPlan,
} from "@momo/core/features/onboarding/aiConnect";
import {
  FAILED_REASON_DEFAULT,
  HANDLE_TAKEN_PROBLEM,
  NAME_INVALID_PROBLEM,
  agentHandleProblem,
  classifyRegisterFailure,
  registerRequestBody,
  type ManualWhy,
  type RegisterStep,
} from "@momo/core/features/onboarding/subscriptionRegister";
import type {
  AgentPortConnectOutcome,
  AgentPortDevice,
} from "@/lib/tauri";

export interface RegisterDeps {
  /** `POST …/subscription-agents/register`. 연결 값이 든 응답을 그대로 돌려준다. */
  register: (body: ReturnType<typeof registerRequestBody>) => Promise<unknown>;
  device: () => Promise<AgentPortDevice | null>;
  connect: (request: {
    harness: "claude";
    endpoint: string;
    agentId: string;
    credential: string;
  }) => Promise<AgentPortConnectOutcome>;
  /** Agent Port 주소. 만들 수 없으면 null. */
  endpoint: () => string | null;
}

export interface RegisterState {
  step: RegisterStep;
  /** 이름 칸의 글자. */
  handle: string;
  /** 수동 단계의 화면용 계획. 그 밖의 단계에서는 null. */
  plan: SubscriptionConnectPlan | null;
  /** 서버가 정한 에이전트(등록 뒤). */
  agent: { id: string; handle: string; displayName: string } | null;
  /** 서버 오류의 분류가 `failed`일 때 한 줄 까닭(영어 서버 문장이 아니다). */
  reason: string | null;
}

function manualWhyFor(outcome: Extract<AgentPortConnectOutcome, { outcome: "manual" }>): ManualWhy {
  switch (outcome.reason) {
    case "cli_missing":
      return "cli-missing";
    case "unsupported_platform":
    case "unsupported_harness":
    case "endpoint_not_allowed":
    case "helper_path_not_allowed":
      return "unsupported";
    default:
      return "cli-failed";
  }
}

export function createRegisterController(
  harness: LocalHarnessId,
  defaultHandle: string,
  deps: RegisterDeps
) {
  let state: RegisterState = {
    step: { step: "confirm" },
    handle: defaultHandle,
    plan: null,
    agent: null,
    reason: null,
  };
  let disposed = false;
  let running = false;
  const listeners = new Set<() => void>();

  const set = (next: Partial<RegisterState>) => {
    if (disposed) return;
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };

  const toConfirm = (problem: string) =>
    set({ step: { step: "confirm", problem }, plan: null, reason: null });

  async function run(): Promise<void> {
    const problem = agentHandleProblem(state.handle);
    if (problem !== null) {
      toConfirm(problem);
      return;
    }
    set({ step: { step: "registering", stage: "server" }, reason: null });
    const device = await deps.device();
    if (disposed) return;
    if (device === null) {
      set({ step: { step: "failed" }, reason: FAILED_REASON_DEFAULT });
      return;
    }
    let registered: RegisteredSubscriptionAgent;
    try {
      registered = parseRegisteredSubscriptionAgent(
        await deps.register(
          registerRequestBody({
            harness,
            deviceId: device.deviceId,
            deviceLabel: device.deviceLabel,
            typedHandle: state.handle,
            defaultHandle,
          })
        )
      );
    } catch (error) {
      // 오류 객체는 기록하지 않는다. 분류만 쓴다.
      const refusal = classifyRegisterFailure(error);
      if (disposed) return;
      if (refusal === "handle-taken") return toConfirm(HANDLE_TAKEN_PROBLEM);
      if (refusal === "invalid-name") return toConfirm(NAME_INVALID_PROBLEM);
      if (
        refusal === "paused" ||
        refusal === "disabled" ||
        refusal === "forbidden" ||
        refusal === "limit" ||
        refusal === "cleanup"
      ) {
        set({ step: { step: "calm", refusal }, plan: null });
        return;
      }
      set({ step: { step: "failed" }, reason: FAILED_REASON_DEFAULT });
      return;
    }
    if (disposed) return;
    const agent = registered.agent;
    set({ agent });
    const credential = registered.pairingCredential;
    if (credential === undefined) {
      // 이 맥의 에이전트가 이미 연결돼 있다: 새 값이 없으니 할 일도 없다.
      set({ step: { step: "existing", handle: agent.handle }, plan: null });
      return;
    }
    const endpoint = deps.endpoint();
    if (endpoint === null) {
      set({ step: { step: "failed" }, reason: FAILED_REASON_DEFAULT, plan: null });
      return;
    }
    if (harness !== "claude") {
      // Codex: `codex mcp add`는 값을 안전하게 받지 못한다(ADR-0190 D3-h). 같은
      // 창에서 주소·연결 값 두 칸을 보여 준다.
      set({
        step: { step: "manual", handle: agent.handle, why: "codex" },
        plan: subscriptionConnectPlan(harness, endpoint, credential),
      });
      return;
    }
    set({ step: { step: "registering", stage: "cli" } });
    const outcome = await deps.connect({
      harness: "claude",
      endpoint,
      agentId: agent.id.toLowerCase(),
      credential,
    });
    if (disposed) return;
    if (outcome.outcome === "connected") {
      set({
        step: { step: "done", handle: agent.handle, displayName: agent.displayName },
        plan: null,
      });
      return;
    }
    set({
      step: { step: "manual", handle: agent.handle, why: manualWhyFor(outcome) },
      plan: subscriptionConnectPlan(harness, endpoint, credential),
    });
  }

  return {
    getState: () => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setHandle(text: string): void {
      if (state.step.step !== "confirm") return;
      set({ handle: text, step: { step: "confirm" } });
    },
    /** 사람이 [@이름 만들기]를 눌렀다. 이것만이 서버와 셸을 부른다. */
    async submit(): Promise<void> {
      if (running || disposed) return;
      if (state.step.step !== "confirm" && state.step.step !== "failed") return;
      running = true;
      try {
        await run();
      } finally {
        running = false;
      }
    },
    dispose(): void {
      disposed = true;
      state = { ...state, plan: null };
      listeners.clear();
    },
  };
}

export type RegisterController = ReturnType<typeof createRegisterController>;
