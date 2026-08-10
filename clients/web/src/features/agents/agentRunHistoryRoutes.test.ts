import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";

// =============================================================================
// #1223 — 표가 참말을 하는지 **기계로** 확인한다.
//
// `serverSurfaces.ts` 의 `provided` 는 사람이 손으로 뒤집는 한 줄이다. 그 줄은
// 두 방향으로 거짓말할 수 있고, 이 코드베이스는 둘 다 겪었다:
//
//   * false 인데 서버엔 있다 → 있는 기능을 "준비 중"이라 말한다(#979 승인 3라우트가
//     올라간 뒤 표가 며칠 늦었던 자리).
//   * true 인데 서버엔 없다 → 화면이 진입점을 세우고 사용자는 404/405를 장애로 본다.
//     이게 더 나쁘다. 이 배치가 없애려던 바로 그 화면이다.
//
// core 스위트는 표의 **값**을 못으로 박지만(serverSurfaces.test.ts), 값이 사실과
// 맞는지는 재지 못한다 — 코어는 `node:fs` 를 쓸 수 없다(purity 게이트: 코어는 웹과
// React Native 양쪽에서 컴파일돼야 한다). 그래서 이 자물쇠는 웹 스위트에 있다:
// **라우터 소스를 직접 읽어** 세 경로가 정말 GET 으로 서 있는지 본다.
//
// red proof: `bins/momo-server/src/lib.rs` 에서 세 라우트 중 하나를 지우면 이
// 파일이 그 경로 이름을 부르며 빨강이 된다. `provided` 만 되돌려도 빨강이다.
//
// 재지 못하는 것: **배포된 서버**가 그 경로를 답하는가. 이 파일이 읽는 것은 이
// 레포의 라우터이지 상대편 인스턴스가 아니다. 그 층은 런타임 폴딩
// (`serverSaysAbsent`)이 맡고, 그 분담은 `serverSurfaces.ts` 상단이 설명한다.
// =============================================================================

const ROUTER_SOURCE = new URL(
  "../../../../../server-rust/bins/momo-server/src/lib.rs",
  import.meta.url
);

const CORE_API_SOURCE = new URL(
  "../../../../../packages/momo-core/src/lib/api.ts",
  import.meta.url
);

/**
 * 클라가 실제로 부르는 세 경로. 경로 파라미터는 이름이 아니라 **자리**로 비교한다
 * (서버는 `{ws}`, 클라는 값을 채운다) — `scripts/openapi_server_routes.py` 가 쓰는
 * 규칙 그대로다.
 */
const AGENT_RUN_HISTORY_READS = [
  {
    path: "/v1/workspaces/{}/channels/{}/agent-runs",
    caller: "fetchAgentRuns",
    /** 이 경로는 POST 와 자리를 나눠 쓴다 — GET 이 없으면 404가 아니라 405였다. */
    note: "채널의 작업 실행 목록",
  },
  {
    path: "/v1/workspaces/{}/agents/{}/runs",
    caller: "fetchAgentRunSummaries",
    note: "에이전트 한 명의 워크스페이스 전역 기록",
  },
  {
    path: "/v1/workspaces/{}/agent-runs/{}",
    caller: "fetchAgentRunDetail",
    note: "실행 하나의 전체 투영",
  },
] as const;

/** `{ws}` 든 `{agent}` 든 자리 하나로 접는다. */
function shape(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

/**
 * `.route("…", get(…).post(…))` 등록을 (경로 모양 → 메서드 집합)으로 읽는다.
 *
 * 괄호를 세어 핸들러 식의 끝을 찾는다. 정규식 한 방으로 자르면 핸들러 안의
 * `)` 에서 잘려 `.get(` 을 못 보고, 못 본 것을 "없다"로 보고한다 — 이 파일이
 * 절대 하면 안 되는 종류의 오답이다.
 */
function registeredRoutes(source: string): Map<string, Set<string>> {
  const routes = new Map<string, Set<string>>();
  const marker = ".route(";
  let cursor = source.indexOf(marker);
  while (cursor !== -1) {
    let depth = 1;
    let index = cursor + marker.length;
    while (index < source.length && depth > 0) {
      const char = source[index];
      if (char === "(") depth += 1;
      else if (char === ")") depth -= 1;
      index += 1;
    }
    const body = source.slice(cursor + marker.length, index - 1);
    const literal = /"([^"]+)"/.exec(body);
    if (literal) {
      const key = shape(literal[1]);
      const methods = new Set(
        [...body.matchAll(/\b(get|post|put|patch|delete)\s*\(/g)].map(
          (match) => match[1]
        )
      );
      const existing = routes.get(key);
      if (existing) methods.forEach((method) => existing.add(method));
      else routes.set(key, methods);
    }
    cursor = source.indexOf(marker, index);
  }
  return routes;
}

describe("에이전트 작업 기록 — 표와 라우터가 같은 말을 하는가", () => {
  const source = readFileSync(ROUTER_SOURCE, "utf8");
  const routes = registeredRoutes(source);

  it("파서가 라우터를 실제로 읽는다", () => {
    // 파서가 조용히 0개를 읽고 아래 단정들이 전부 통과해 버리는 사고를 막는다.
    expect(routes.size).toBeGreaterThan(40);
    expect(routes.get("/v1/auth/login")).toContain("post");
  });

  it.each(AGENT_RUN_HISTORY_READS)(
    "GET $path ($note) 가 등록돼 있다",
    ({ path }) => {
      expect(
        [...(routes.get(path) ?? [])],
        `${path} 를 GET 으로 등록한 .route() 가 server-rust/bins/momo-server/src/lib.rs 에 없다`
      ).toContain("get");
    }
  );

  it("표의 provided 는 세 경로가 다 서 있을 때만 참이다", () => {
    const allMounted = AGENT_RUN_HISTORY_READS.every(({ path }) =>
      routes.get(path)?.has("get")
    );
    expect(isSurfaceProvided("agentRunHistory")).toBe(allMounted);
  });

  it("코어가 부르는 곳이 그대로 그 세 경로다", () => {
    // 서버만 보면 반쪽이다: 클라가 부르는 경로를 바꿔 놓고 서버 라우트를 그대로
    // 두면 위 단정들은 전부 초록인 채로 화면은 404를 받는다.
    const api = readFileSync(CORE_API_SOURCE, "utf8");
    for (const { caller } of AGENT_RUN_HISTORY_READS) {
      expect(api).toContain(`export async function ${caller}(`);
    }
    for (const fragment of [
      "/agent-runs?limit=",
      ")}/runs?${query.toString()}`",
      "/agent-runs/${encodeURIComponent(runId.toLowerCase())}`",
    ]) {
      expect(api).toContain(fragment);
    }
  });
});
