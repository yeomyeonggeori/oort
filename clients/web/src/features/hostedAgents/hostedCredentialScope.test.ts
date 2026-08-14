import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  hostedConnectionQuery,
  hostedConnectionQueryKey,
  hostedListQuery,
  hostedListQueryKey,
  purgeHostedCredentials,
  HOSTED_CREDENTIAL_MUTATION_KEY,
  HOSTED_CREDENTIAL_MUTATION_SCOPE,
  HOSTED_POLL_MS,
} from "./hostedCredentialScope";

// =============================================================================
// #1360 HAP-UX1 — 일회성 비밀값 둘의 수명.
//
// 이 스위트가 볼 수 있는 것과 없는 것은 웹훅 쪽과 같다: 도는 곳은 DOM 없는 node
// 이고 재는 것은 캐시의 **모양**(무엇이 지워지는가, 무엇이 남는가, 키가 하나인가)
// 이다. 힙에서의 도달 가능성은 여기서 잴 수 없고, 그것을 재는 게이트는
// gate-webhook-credential.mjs 하나뿐이다(이 표면에는 아직 없다 — STATUS 에 남긴다).
//
// RED PROOF 셋:
//
//   ① 규율 없는 mutation 은 화면이 사라진 뒤에도 원문을 들고 있다(비공허성 대조).
//   ② 규율을 단 셋은 한 키를 공유해 한 번에 지워지고, 남의 표면은 건드리지 않는다.
//   ③ 마법사는 쿼리 함수를 짓지 않는다. 그 클로저가 렌더 스코프(= 비밀값이 사는
//      곳)를 캡처하고 세션 수명 캐시에 얹히는 것이 웹훅 R2 가 힙에서 찾아낸 경로다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CONNECTION = "00000000-0000-7000-8000-0000000000c1";
const PAIRING_SECRET = "momo_pair_v1.9f2c4a71b0e84d6fa3c1d5e7b28f0a46";
const ACTIVE_SECRET = "momo_agent_v1.5b1d0c7e2a934f18ac6d8e0b4f37c921";

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

async function runMutation(
  queryClient: QueryClient,
  options: Record<string, unknown>,
  value: string
) {
  const mutation = queryClient.getMutationCache().build(queryClient, {
    ...options,
    mutationFn: async () => ({ credential: value }),
  });
  await mutation.execute(undefined);
  return mutation;
}

describe("RED PROOF ① 비공허성 대조", () => {
  it("규율 없이 실행하면 화면이 사라진 뒤에도 캐시가 원문을 들고 있다", async () => {
    const queryClient = client();
    await runMutation(queryClient, {}, PAIRING_SECRET);
    const held = JSON.stringify(
      queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data)
    );
    expect(held).toContain(PAIRING_SECRET);
  });
});

describe("RED PROOF ② 두 비밀값이 한 키 아래 함께 산다", () => {
  it("규율을 단 mutation 은 언마운트 즉시 회수 대상이 된다", () => {
    expect(HOSTED_CREDENTIAL_MUTATION_SCOPE.gcTime).toBe(0);
    expect(HOSTED_CREDENTIAL_MUTATION_SCOPE.mutationKey).toBe(
      HOSTED_CREDENTIAL_MUTATION_KEY
    );
  });

  it("발급·재발급·승인 셋이 같은 키를 공유해 한 번에 지워진다", async () => {
    const queryClient = client();
    await runMutation(queryClient, HOSTED_CREDENTIAL_MUTATION_SCOPE, PAIRING_SECRET);
    await runMutation(queryClient, HOSTED_CREDENTIAL_MUTATION_SCOPE, PAIRING_SECRET);
    await runMutation(queryClient, HOSTED_CREDENTIAL_MUTATION_SCOPE, ACTIVE_SECRET);
    expect(purgeHostedCredentials(queryClient)).toBe(3);
    const left = JSON.stringify(
      queryClient.getMutationCache().getAll().map((mutation) => mutation.state.data)
    );
    expect(left).not.toContain(PAIRING_SECRET);
    expect(left).not.toContain(ACTIVE_SECRET);
  });

  it("남의 표면 mutation 은 건드리지 않는다", async () => {
    const queryClient = client();
    await runMutation(queryClient, HOSTED_CREDENTIAL_MUTATION_SCOPE, PAIRING_SECRET);
    await runMutation(queryClient, { mutationKey: ["settings", "webhooks", "credential"] }, "whsec_x");
    expect(purgeHostedCredentials(queryClient)).toBe(1);
    expect(queryClient.getMutationCache().getAll()).toHaveLength(1);
  });

  it("지울 것이 없으면 0이고 두 번 불러도 같다", () => {
    const queryClient = client();
    expect(purgeHostedCredentials(queryClient)).toBe(0);
    expect(purgeHostedCredentials(queryClient)).toBe(0);
  });
});

describe("쿼리 옵션", () => {
  it("목록과 단건이 서로 다른 키를 쓴다", () => {
    expect(hostedListQueryKey(WS)).not.toEqual(
      hostedConnectionQueryKey(WS, CONNECTION)
    );
    expect(hostedListQuery(WS).retry).toBe(false);
  });

  // 되묻는 **구간**은 호출부가 아니라 쿼리 자신이 정한다: 근거가 방금 받은 서버
  // 상태이기 때문이다. 그래서 `refetchInterval` 은 숫자가 아니라 캐시를 읽는
  // 함수이고, 아래 셋이 그 함수가 무엇을 보는지 잰다 (design-review M4).
  const intervalFor = (status: string, extra: object = {}) => {
    const option = hostedConnectionQuery(WS, CONNECTION, true).refetchInterval;
    if (typeof option !== "function") throw new Error("expected a predicate");
    return option({
      state: {
        data: {
          id: CONNECTION,
          agentMemberId: "00000000-0000-7000-8000-0000000000a1",
          status,
          authMode: "static_bearer",
          audience: "/v1/mcp/agent-port",
          approvedChannelIds: [],
          approvedScopes: [],
          createdAtMs: 0,
          updatedAtMs: 0,
          ...extra,
        },
      },
    } as never);
  };

  it("남의 프로세스를 기다리는 두 구간에서만 되묻는다", () => {
    expect(intervalFor("pairing_pending")).toBe(HOSTED_POLL_MS);
    expect(
      intervalFor("detected", {
        activeCredentialId: "00000000-0000-7000-8000-0000000000e1",
      })
    ).toBe(HOSTED_POLL_MS);
  });

  it("사람이 결정 중이거나 이미 도착한 자리에서는 조용하다", () => {
    // 승인 화면(`detected` 이고 자격증명 전)과 활성. 앞 판은 "연결을 하나
    // 골랐는가"로 물어서 이 둘에서도 5초마다 두드렸다.
    expect(intervalFor("detected")).toBe(false);
    expect(intervalFor("active")).toBe(false);
    expect(intervalFor("expired")).toBe(false);
  });

  it("오프라인이면 구간과 무관하게 되묻지 않는다", () => {
    expect(hostedConnectionQuery(WS, CONNECTION, false).refetchInterval).toBe(false);
  });
});

describe("RED PROOF ③ 마법사는 쿼리 함수를 짓지 않는다", () => {
  const wizard = readFileSync(
    fileURLToPath(new URL("./HostedAgentWizard.tsx", import.meta.url)),
    "utf8"
  );

  it("컴포넌트 안에 인라인 queryFn 이 없다", () => {
    expect(wizard).not.toMatch(/queryFn\s*:/);
    expect(wizard).toContain("hostedListQuery(workspaceId)");
    expect(wizard).toContain("hostedConnectionQuery(");
  });

  it("비밀값을 저장소나 URL 에 넣는 코드가 없다", () => {
    // 이름이 아니라 **호출**을 본다. 이 파일의 머리말은 localStorage 를 낱말로
    // 이야기하고 있고(무엇을 하지 않는지 적는 것이 그 문단의 일이다), 낱말을
    // 세는 단정은 그 문단을 지우게 만든다. 코어 purity 게이트가 AST 로 같은
    // 구분을 하는 이유와 같다.
    expect(wizard).not.toMatch(/localStorage\s*\./);
    expect(wizard).not.toMatch(/sessionStorage\s*\./);
    expect(wizard).not.toMatch(/indexedDB\s*\./);
    expect(wizard).not.toMatch(/history\.(push|replace)State/);
  });

  it("아무것도 로그하지 않는다", () => {
    expect(wizard).not.toMatch(/console\.(log|warn|error|debug)/);
  });

  it("값이 떠 있는 동안 Esc 와 바깥 클릭이 그 값을 버리지 못한다", () => {
    expect(wizard).toContain("onEscapeKeyDown");
    expect(wizard).toContain("onInteractOutside");
    expect(wizard).toContain("holdingSecret");
  });

  it("언마운트에서 캐시에 남은 원문을 비운다", () => {
    expect(wizard).toContain("purgeHostedCredentials(client)");
  });

  it("해제 경로는 이 화면에 없다 (UX2 / #1362 소유)", () => {
    expect(wizard).not.toMatch(/disconnect/i);
  });
});
