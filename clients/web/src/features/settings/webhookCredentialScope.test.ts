import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import {
  CREDENTIAL_MUTATION_SCOPE,
  purgeWebhookCredentials,
  webhookListQuery,
  webhookListQueryKey,
  WEBHOOK_CREDENTIAL_MUTATION_KEY,
} from "./webhookCredentialScope";

// 이 스위트가 재는 것 — 그리고 재지 못하는 것.
//
// 진짜 QueryClient/MutationCache 를 세워 캐시의 **모양**을 잰다: 무엇이 남고,
// 무엇이 지워지고, 이 표면의 mutation 이 정말 한 키를 공유하는가. 아래 첫
// 테스트는 규율 없이 실행한 mutation 이 원문을 들고 있는 것을 재현하므로
// 비어 있지 않다 — `purgeWebhookCredentials` 의 삭제 루프를 지우거나
// `CREDENTIAL_MUTATION_SCOPE` 를 빼면 빨강이 된다.
//
// **재지 못하는 것: 힙에서의 도달 가능성.** 도는 곳이 DOM 없는 node 라 렌더
// 스코프라는 것 자체가 없고, 그래서 #1205 1차 수리는 이 자리에서 초록인 채로
// 힙에서 빨강이었다(리뷰 R2: 목록 쿼리의 인라인 `queryFn` 이 렌더 스코프를
// 캡처해 원문이 5분을 더 살았다). 그 층은 게이트가 잰다:
//
//   npm run build && npm run gate:webhook
//
// 여기 남는 것은 그 게이트가 없는 데스크에서도 도는 값싼 자물쇠다: 아래
// 「렌더 스코프가 캐시에 실리지 않는다」는 힙이 아니라 **파일의 모양**을 재고,
// 그 이상을 주장하지 않는다.

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

  it("이 표면의 mutation 셋이 같은 키를 공유해 한 번에 지워진다", async () => {
    const client = new QueryClient();
    // 발급·회전·폐기. 셋째가 여기 있는 이유는 그것이 비밀값을 실어 나르기
    // 때문이 아니라, 그 콜백이 비밀값이 사는 렌더 스코프를 붙잡기 때문이다.
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    await settled(client, CREDENTIAL_MUTATION_SCOPE);
    expect(cachedBodies(client)).toContain(SECRET);

    expect(purgeWebhookCredentials(client)).toBe(3);
    expect(cachedBodies(client)).not.toContain(SECRET);
    expect(CREDENTIAL_MUTATION_SCOPE.mutationKey).toBe(
      WEBHOOK_CREDENTIAL_MUTATION_KEY
    );
  });
});

describe("렌더 스코프가 세션 수명 캐시에 실리지 않는다 (모양만 — 힙은 게이트)", () => {
  const section = readFileSync(
    new URL("./WebhookSection.tsx", import.meta.url),
    "utf8"
  );

  it("표면은 쿼리 함수를 짓지 않는다", () => {
    // R2 가 힙에서 찾은 리테이너가 정확히 이것이었다: 컴포넌트 안에서 만든
    // `queryFn:` 이 렌더 스코프를 캡처하고, 그 쿼리가 관찰자 0 이후에도 자기
    // gcTime(300000ms) 동안 그 스코프를 붙잡는다. 옵션은 모듈 스코프에서 온다.
    expect(section).not.toMatch(/queryFn\s*:/);
    expect(section).toContain("webhookListQuery(workspaceId)");
  });

  it("목록 키는 한 곳에서만 지어진다", () => {
    // 읽는 쪽과 무효화하는 쪽이 각자 배열을 적으면, 한쪽만 바뀐 날 무효화가
    // 조용히 아무것도 맞히지 못한다. 키도 팩토리에서 온다.
    expect(section).not.toContain('["settings", "webhooks"');
    expect(webhookListQuery("ws-1").queryKey).toEqual(
      webhookListQueryKey("ws-1")
    );
  });

  it("모듈 스코프 쿼리 함수는 workspaceId 말고 아무것도 보지 않는다", () => {
    // 같은 인자로 두 번 부르면 서로 다른 클로저가 나오고(캐시된 싱글턴이 아니다),
    // 각자 붙잡는 것은 자기 호출의 인자뿐이다. 키가 인자를 그대로 담는 것으로
    // 그 인자가 무엇인지도 함께 잰다.
    const a = webhookListQuery("ws-a");
    const b = webhookListQuery("ws-b");
    expect(a.queryFn).not.toBe(b.queryFn);
    expect(a.queryKey).toEqual(["settings", "webhooks", "ws-a"]);
    expect(b.queryKey).toEqual(["settings", "webhooks", "ws-b"]);
    expect(a.retry).toBe(false);
  });
});
