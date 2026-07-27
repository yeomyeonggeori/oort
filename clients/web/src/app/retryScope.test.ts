import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { resetRouteQueries, resetSettingsQueries, SHELL_QUERY_KEYS } from "./retryScope";

// 실제 키는 소스에서 그대로 가져왔다(추측한 모양이 아니라 발신 코드 기준).
const SETTINGS_KEYS = [
  ["settings", "work-hosts", "ws"],
  ["settings", "invites", "ws"],
  ["settings", "provider-link"],
  ["settings", "work-tier-policy", "ws", "member"],
];
// useWorkspace.ts의 사이드바 훅 셋에서 그대로 가져온 키.
const SHELL_KEYS = [
  ["channels", "ws"],
  ["roster", "ws"],
  ["read-state", "ws"],
];
const ROUTE_KEYS = [
  ["approvals", "ws"],
  ["agent-runs", "ws"],
  ["thread", "ws", "ch", "root"],
  // 인박스 소유다. 셸로 잘못 분류하면 멘션 때문에 던진 인박스의 재시도가
  // 원인 캐시를 그대로 남긴다.
  ["inbox-mentions", "ws"],
];

function seed(keys: string[][]) {
  const client = new QueryClient();
  for (const key of keys) client.setQueryData(key, { seeded: true });
  return client;
}

function present(client: QueryClient, keys: string[][]) {
  return keys.filter((key) => client.getQueryData(key) !== undefined).length;
}

describe("오류 경계 재시도의 폭발 반경", () => {
  it("설정 재시도는 설정 쿼리만 되돌리고 사이드바를 건드리지 않는다", () => {
    const client = seed([...SETTINGS_KEYS, ...SHELL_KEYS, ...ROUTE_KEYS]);
    resetSettingsQueries(client);

    expect(present(client, SETTINGS_KEYS)).toBe(0);
    // 이게 이 테스트의 존재 이유다: 필터 없는 resetQueries()는 아래 둘도 비웠다.
    expect(present(client, SHELL_KEYS)).toBe(SHELL_KEYS.length);
    expect(present(client, ROUTE_KEYS)).toBe(ROUTE_KEYS.length);
  });

  it("라우트 재시도는 셸이 소유한 쿼리를 남긴다", () => {
    const client = seed([...SETTINGS_KEYS, ...SHELL_KEYS, ...ROUTE_KEYS]);
    resetRouteQueries(client);

    expect(present(client, SHELL_KEYS)).toBe(SHELL_KEYS.length);
    expect(present(client, ROUTE_KEYS)).toBe(0);
    expect(present(client, SETTINGS_KEYS)).toBe(0);
  });

  it("셸 집합은 사이드바가 읽는 세 키뿐이다", () => {
    // 이 단정이 잡는 것은 '집합이 넓어지는 것'이다 — 라우트가 소유한 키가 셸로
    // 들어오면 그 라우트의 재시도가 원인 캐시를 보존한다(4R High). 사이드바가
    // 새 쿼리를 쓰기 시작하는 반대 방향은 여기서 못 잡는다: 그건 useWorkspace의
    // 훅과 이 목록을 함께 읽어야 보인다.
    expect([...SHELL_QUERY_KEYS].sort()).toEqual(["channels", "read-state", "roster"]);
  });
});
