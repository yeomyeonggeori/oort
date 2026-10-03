import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import type { RegisterState } from "./registerController";

// design 캡처가 세우는 「로그인 뒤 에이전트로 만들기」 단계(#3389). 컨트롤러도 서버도
// 셸도 없이 단계 하나를 그대로 그린다. 제품 빌드에서는 어디서도 읽히지 않는다
// (`AiConnectCard`의 `?aiCard=register-…`는 design 모드에서만 켜진다).

export const REGISTER_POSES = [
  "register-confirm",
  "register-confirm-problem",
  "register-registering-server",
  "register-registering-cli",
  "register-done",
  "register-existing",
  "register-paused",
  "register-disabled",
  "register-forbidden",
  "register-codex",
  "register-cli-failed",
  "register-failed",
] as const;
export type RegisterPose = (typeof REGISTER_POSES)[number];

const base: RegisterState = {
  step: { step: "confirm" },
  handle: "seongjae-claude",
  plan: null,
  agent: null,
  reason: null,
};

const ENDPOINT = "https://oort-team.example.test/v1/mcp/agent-port";
// 캡처용 가짜 값. 실제 값이 아니다.
const FAKE = "capture-only-not-a-value-0000";

export function registerPoseFixture(pose: RegisterPose): {
  harness: LocalHarnessId;
  state: RegisterState;
} {
  switch (pose) {
    case "register-confirm-problem":
      return {
        harness: "claude",
        state: {
          ...base,
          handle: "haneul-claude",
          step: { step: "confirm", problem: "이미 쓰는 이름이에요. 다른 이름을 적어 주세요." },
        },
      };
    case "register-registering-server":
      return { harness: "claude", state: { ...base, step: { step: "registering", stage: "server" } } };
    case "register-registering-cli":
      return { harness: "claude", state: { ...base, step: { step: "registering", stage: "cli" } } };
    case "register-done":
      return {
        harness: "claude",
        state: { ...base, step: { step: "done", handle: "seongjae-claude", displayName: "곽성재-claude" } },
      };
    case "register-existing":
      return { harness: "claude", state: { ...base, step: { step: "existing", handle: "seongjae-claude" } } };
    case "register-paused":
      return { harness: "claude", state: { ...base, step: { step: "calm", refusal: "paused" } } };
    case "register-disabled":
      return { harness: "claude", state: { ...base, step: { step: "calm", refusal: "disabled" } } };
    case "register-forbidden":
      return { harness: "claude", state: { ...base, step: { step: "calm", refusal: "forbidden" } } };
    case "register-codex":
      return {
        harness: "codex",
        state: {
          ...base,
          handle: "seongjae-codex",
          step: { step: "manual", handle: "seongjae-codex", why: "codex" },
          plan: { kind: "fields", endpoint: ENDPOINT, credential: FAKE },
        },
      };
    case "register-cli-failed":
      return {
        harness: "claude",
        state: {
          ...base,
          step: { step: "manual", handle: "seongjae-claude", why: "cli-failed" },
          plan: {
            kind: "command",
            command: `claude mcp add --scope user --transport http oort ${ENDPOINT} --header "Authorization: Bearer ${FAKE}"`,
          },
        },
      };
    case "register-failed":
      return {
        harness: "claude",
        state: { ...base, step: { step: "failed" }, reason: "서버에 닿지 못했어요" },
      };
    default:
      return { harness: "claude", state: base };
  }
}

export function isRegisterPose(value: string | null): value is RegisterPose {
  return value !== null && (REGISTER_POSES as readonly string[]).includes(value);
}
