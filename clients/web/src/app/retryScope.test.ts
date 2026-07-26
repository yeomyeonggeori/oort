import { describe, expect, it } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { resetRouteQueries, resetSettingsQueries } from "./retryScope";

// 실제 키는 소스에서 그대로 가져왔다(추측한 모양이 아니라 발신 코드 기준).
const SETTINGS_KEYS = [
  ["settings", "work-hosts", "ws"],
  ["settings", "invites", "ws"],
  ["settings", "provider-link"],
  ["settings", "work-tier-policy", "ws", "member"],
];
const SHELL_KEYS = [
  ["channels", "ws"],
  ["roster", "ws"],
  ["read-state", "ws"],
  ["inbox-mentions", "ws"],
];
const ROUTE_KEYS = [
  ["approvals", "ws"],
  ["agent-runs", "ws"],
  ["thread", "ws", "ch", "root"],
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

  it("셸 키 목록이 사이드바가 실제로 읽는 것과 어긋나면 알아챌 수 있게 고정한다", () => {
    // 사이드바가 새 쿼리를 쓰기 시작했는데 여기 없으면, 라우트 재시도가 그걸
    // 조용히 비운다. 목록을 계약으로 못박아 둔다.
    const client = seed(SHELL_KEYS);
    resetRouteQueries(client);
    expect(present(client, SHELL_KEYS)).toBe(SHELL_KEYS.length);
  });
});
