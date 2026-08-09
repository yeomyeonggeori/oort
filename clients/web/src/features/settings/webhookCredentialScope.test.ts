import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  CREDENTIAL_MUTATION_SCOPE,
  purgeWebhookCredentials,
  WEBHOOK_CREDENTIAL_MUTATION_KEY,
} from "./webhookCredentialScope";

// RED PROOF 5 — 일회성 비밀값은 그것을 보여주던 화면보다 오래 살지 않는다.
//
// #1205 리뷰 B1 이 잡은 결함은 코어 모델이 아니라 **컴포넌트 고도**에 있었다.
// 모델 쪽 단정 넷은 목록·실패·URL·행 목록에서 비밀값을 막았지만, 아무도 발급된
// 값의 수명을 재지 않았고 그게 정확히 무너진 자리다: 「저장했습니다」 없이 떠나면
// MutationCache 가 원문을 계속 들고 있었다.
//
// 이 스위트는 진짜 QueryClient/MutationCache 를 세워 그 누수를 **재현하고**,
// 규율을 적용한 쪽에서 사라지는 것까지 잰다. `purgeWebhookCredentials` 의 삭제
// 루프를 지우거나 `CREDENTIAL_MUTATION_SCOPE` 를 빼면 빨강이 된다.

const SECRET = "whsec_9f2c4a71b0e84d6fa3c1d5e7b28f0a46";

/** 서버가 한 번만 주는 그 본문. */
const CREDENTIAL = {
  installation: { id: "019f9b10-0000-7000-8000-0000000009a1", label: "배포 알림" },
  keyId: "019f9b10-0000-7000-8000-0000000009b1",
  secret: SECRET,
  url: "/v1/webhooks/ws/inst",
};

function cachedBodies(client: QueryClient): string {
  return JSON.stringify(
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data)
  );
}

/** 관찰자 없이 한 번 실행된 mutation. 컴포넌트가 떠난 뒤의 캐시와 같은 상태다. */
async function settled(
  client: QueryClient,
  options: Record<string, unknown> = {}
) {
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => CREDENTIAL,
    ...options,
  });
  await mutation.execute(undefined);
  return mutation;
}

describe("일회성 웹훅 비밀값의 수명", () => {
  it("규율 없이 실행하면 화면이 사라진 뒤에도 캐시가 원문을 들고 있다", async () => {
    const client = new QueryClient();
    const leaky = await settled(client);

    // 이것이 B1 이다. 이 mutation 에는 관찰자가 붙은 적조차 없는데(= 패널은 이미
    // 언마운트된 뒤와 같은 상태인데) 값이 그대로 캐시에 있다. 브라우저에서 이
    // mutation 의 gcTime 은 300000ms 이고 node 기본값은 Infinity 라 아예 만료되지
    // 않는다. 어느 쪽이든 그것을 보여주던 화면보다 길다.
    expect(client.getMutationCache().getAll()).toHaveLength(1);
    expect(cachedBodies(client)).toContain(SECRET);
    expect(leaky.gcTime).not.toBe(0);
  });

  it("규율을 단 mutation 은 언마운트 즉시 회수 대상이 된다", async () => {
    const client = new QueryClient();
    const scoped = await settled(client, CREDENTIAL_MUTATION_SCOPE);
    expect(scoped.gcTime).toBe(0);
  });

  it("purge 는 캐시에 남은 원문을 지운다", async () => {
    const client = new QueryClient();
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    expect(cachedBodies(client)).toContain(SECRET);

    expect(purgeWebhookCredentials(client)).toBe(1);

    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(cachedBodies(client)).not.toContain(SECRET);
  });

  it("purge 는 남의 표면을 건드리지 않는다", async () => {
    const client = new QueryClient();
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    const neighbour = client.getMutationCache().build(client, {
      mutationKey: ["settings", "invites"],
      mutationFn: async () => ({ ok: true }),
    });
    await neighbour.execute(undefined);

    expect(purgeWebhookCredentials(client)).toBe(1);

    const left = client.getMutationCache().getAll();
    expect(left).toHaveLength(1);
    expect(left[0].options.mutationKey).toEqual(["settings", "invites"]);
  });

  it("지울 것이 없어도 안전하고, 두 번 불러도 같다", async () => {
    const client = new QueryClient();
    expect(purgeWebhookCredentials(client)).toBe(0);
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    expect(purgeWebhookCredentials(client)).toBe(1);
    expect(purgeWebhookCredentials(client)).toBe(0);
  });

  it("두 mutation(발급·회전)이 같은 키를 공유해 한 번에 지워진다", async () => {
    const client = new QueryClient();
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    expect(cachedBodies(client)).toContain(SECRET);

    expect(purgeWebhookCredentials(client)).toBe(2);
    expect(cachedBodies(client)).not.toContain(SECRET);
    expect(CREDENTIAL_MUTATION_SCOPE.mutationKey).toBe(
      WEBHOOK_CREDENTIAL_MUTATION_KEY
    );
  });
});
