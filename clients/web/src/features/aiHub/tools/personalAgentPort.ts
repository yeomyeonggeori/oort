import { settingsRequest } from "@momo/core/features/settings/api";
import {
  type PersonalAgentSummary,
  type PersonalHarnessWire,
} from "@momo/core/features/ai/harnessCard";
import { ApiError } from "@momo/core/lib/api";

// =============================================================================
// 개인 에이전트 어댑터 (ADR-0198 증보 1 D7, 서버 계약 P2 #3591).
//
// 서버 라우트 `POST/GET /v1/workspaces/{ws}/personal-agents`, `POST …/{agent}/disable`은
// track/engine 쪽에 있다(이 트랙이 승격으로 받기 전에는 서버에 없다). 그래서 화면은 이
// 포트 하나만 부르고, 서버에 라우트가 없으면(404/405) `unavailable`로 차분히 말한다.
// 응답 모양은 openapi `PersonalAgentSummary`다. engine 승격 후에는 코드를 바꾸지 않고
// 이 어댑터가 그대로 이어진다.
// =============================================================================

export type PersonalAgentListResult =
  | { state: "ok"; agents: PersonalAgentSummary[] }
  | { state: "unavailable" }
  | { state: "error" };

export class PersonalAgentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null
  ) {
    super(code ?? `HTTP ${status}`);
    this.name = "PersonalAgentError";
  }
}

export interface PersonalAgentPort {
  list(): Promise<PersonalAgentListResult>;
  /** 켜기. 같은 별칭으로 다시 부르면 꺼 둔 같은 멤버가 돌아온다. */
  enable(harness: PersonalHarnessWire, alias: string): Promise<PersonalAgentSummary>;
  disable(agentId: string): Promise<PersonalAgentSummary>;
}

function asError(error: unknown): PersonalAgentError {
  if (error instanceof ApiError) return new PersonalAgentError(error.status, error.code ?? null);
  return new PersonalAgentError(0, null);
}

export function createPersonalAgentPort(workspaceId: string): PersonalAgentPort {
  const base = `/v1/workspaces/${encodeURIComponent(workspaceId)}/personal-agents`;
  return {
    async list() {
      try {
        const res = await settingsRequest<{ agents?: PersonalAgentSummary[] }>(base);
        return { state: "ok", agents: Array.isArray(res.agents) ? res.agents : [] };
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
          return { state: "unavailable" };
        }
        return { state: "error" };
      }
    },
    async enable(harness, alias) {
      try {
        const res = await settingsRequest<{ agent: PersonalAgentSummary }>(base, {
          method: "POST",
          body: JSON.stringify({ harness, alias }),
        });
        return res.agent;
      } catch (error) {
        throw asError(error);
      }
    },
    async disable(agentId) {
      try {
        const res = await settingsRequest<{ agent: PersonalAgentSummary }>(
          `${base}/${encodeURIComponent(agentId)}/disable`,
          { method: "POST", body: "{}" }
        );
        return res.agent;
      } catch (error) {
        throw asError(error);
      }
    },
  };
}
