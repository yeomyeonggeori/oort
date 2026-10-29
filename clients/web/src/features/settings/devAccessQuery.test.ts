import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { resetSettingsQueries } from "@/app/retryScope";
import {
  createDevCredentialFn,
  DEV_CREDENTIAL_MUTATION_KEY,
  DEV_CREDENTIAL_MUTATION_SCOPE,
  devAccessPolicyQueryKey,
  devCredentialsQuery,
  devCredentialsQueryKey,
  devCredentialsQueryPrefix,
  purgeDevCredentials,
} from "./devAccessQuery";

// 설정 › 명령줄·AI 도구의 읽기 키와, 한 번만 보이는 비밀의 캐시 수명 (#4663).
// 진짜 QueryClient·MutationCache를 세워 캐시의 **모양**을 잰다. 힙에서의 도달 가능성은 여기서 잴 수
// 없다(웹훅 화면의 같은 한계: `webhookCredentialScope.test.ts`).

const WS = "00000000-0000-7000-8000-000000000001";
const SECRET = "momo_dev_v1.EXAMPLEnotARealSecret0123456789abcdefg";

/** 관찰자 없이 한 번 실행된 뮤테이션. 화면이 떠난 뒤의 캐시와 같은 상태다. */
async function settled(client: QueryClient, options: Record<string, unknown> = {}) {
  const mutation = client.getMutationCache().build(client, {
    mutationFn: async () => ({ token: SECRET }),
    ...options,
  });
  await mutation.execute(undefined);
  return mutation;
}

function bodies(client: QueryClient): string {
  return JSON.stringify(
    client
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.data)
  );
}

describe("읽기 키", () => {
  it("모든 키가 설정 접두를 달아 설정의 되돌리기가 덮는다", async () => {
    const client = new QueryClient();
    client.setQueryData(devAccessPolicyQueryKey(WS), { policy: "admins" });
    client.setQueryData(devCredentialsQueryKey(WS, "mine"), []);
    client.setQueryData(devCredentialsQueryKey(WS, "all"), []);

    resetSettingsQueries(client);

    for (const query of client.getQueryCache().getAll()) {
      expect(query.state.data, JSON.stringify(query.queryKey)).toBeUndefined();
      expect(query.queryKey.slice(0, 2)).toEqual(["settings", "dev-access"]);
    }
  });

  it("목록의 두 보기는 한 접두 아래서 따로 캐시된다", () => {
    const prefix = devCredentialsQueryPrefix(WS);
    expect(devCredentialsQueryKey(WS, "mine").slice(0, prefix.length)).toEqual([...prefix]);
    expect(devCredentialsQueryKey(WS, "all").slice(0, prefix.length)).toEqual([...prefix]);
    expect(devCredentialsQueryKey(WS, "mine")).not.toEqual(devCredentialsQueryKey(WS, "all"));
    // 워크스페이스가 다르면 같은 캐시를 나눠 쓰지 않는다.
    expect(devCredentialsQueryKey("other", "mine")).not.toEqual(devCredentialsQueryKey(WS, "mine"));
  });

  it("보안 표면이라 열 때마다 새로 읽고, 실패를 되풀이해 시도하지 않는다", () => {
    const options = devCredentialsQuery(WS, "mine");
    expect(options.staleTime).toBe(0);
    expect(options.retry).toBe(false);
  });
});

describe("연결 값 뮤테이션의 수명", () => {
  it("규율 없이 실행한 뮤테이션은 화면이 사라진 뒤에도 값을 들고 있다(규율이 필요한 이유)", async () => {
    const client = new QueryClient();
    const leaky = await settled(client);
    expect(bodies(client)).toContain(SECRET);
    expect(leaky.gcTime).not.toBe(0);
  });

  it("규율을 단 뮤테이션은 마지막 관찰자가 떨어지는 즉시 회수 대상이다", async () => {
    const client = new QueryClient();
    const scoped = await settled(client, DEV_CREDENTIAL_MUTATION_SCOPE);
    expect(scoped.gcTime).toBe(0);
    expect(scoped.options.mutationKey).toEqual([...DEV_CREDENTIAL_MUTATION_KEY]);
  });

  it("purge는 이 표면의 값만 지우고 남의 뮤테이션은 건드리지 않는다", async () => {
    const client = new QueryClient();
    await settled(client, DEV_CREDENTIAL_MUTATION_SCOPE);
    await settled(client, { mutationKey: ["settings", "invites"], mutationFn: async () => ({ ok: true }) });
    expect(bodies(client)).toContain(SECRET);

    expect(purgeDevCredentials(client)).toBe(1);

    expect(bodies(client)).not.toContain(SECRET);
    const left = client.getMutationCache().getAll();
    expect(left).toHaveLength(1);
    expect(left[0].options.mutationKey).toEqual(["settings", "invites"]);
  });

  it("지울 것이 없어도 안전하고, 두 번 불러도 같다", async () => {
    const client = new QueryClient();
    expect(purgeDevCredentials(client)).toBe(0);
    await settled(client, DEV_CREDENTIAL_MUTATION_SCOPE);
    expect(purgeDevCredentials(client)).toBe(1);
    expect(purgeDevCredentials(client)).toBe(0);
  });
});

describe("비밀번호 상자", () => {
  it("요청 함수는 상자를 읽는 즉시 비운다", async () => {
    // 서버 쪽(HTTP `fetch`)만 가짜다.
    const seen: string[] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      seen.push(String(init?.body));
      return new Response(
        JSON.stringify({
          id: "019f9b10-0000-7000-8000-0000000000a1",
          kind: "card",
          name: "Claude Code",
          tool: "claude_code",
          scopes: ["dev:identity"],
          createdAtMs: 1,
          expiresAtMs: 2,
          token: SECRET,
        }),
        { status: 201, headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    try {
      const box = { value: "초록-고래-테스트용-비밀번호" };
      const pending = createDevCredentialFn(WS)({
        input: { name: "Claude Code", tool: "claude_code", preset: "read" },
        password: box,
      });
      // 요청이 끝나기 전에 이미 상자는 비어 있다.
      expect(box.value).toBe("");
      await pending;
      expect(seen).toHaveLength(1);
      expect(JSON.parse(seen[0]).currentPassword).toBe("초록-고래-테스트용-비밀번호");
    } finally {
      globalThis.fetch = real;
    }
  });
});
