import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSurfaceProvided } from "@momo/core/features/capabilities/serverSurfaces";

// =============================================================================
// #3860 (ADR-0113 증보 P-U1) — 「앱 보기」와 「앱 설치」의 표가 참말을 하는지 **기계로** 확인한다.
//
// 같은 자물쇠가 `features/agents/agentRunHistoryRoutes.test.ts`에 있다(그쪽 머리말이 왜 코어가
// 아니라 웹 스위트에 있는지 설명한다: 코어는 `node:fs`를 못 쓴다). 이 파일은 둘을 잰다.
//
//   앱 보기(`plugins`)   읽기 둘이 GET으로만 서 있다 ⇔ 표가 provided.
//   앱 설치(`pluginInstall`)  쓰기 넷이 **아직 서 있지 않다**. 서 있으면 이 파일이 빨개진다.
//
// 두 번째가 일부러 빨개지게 만든 자리다. 「앱 설치」는 표가 아니라 **서버가 보여 준 사실**로
// 켜진다(GET을 보내 405면 서 있다, `pluginInstallVerdict`). 그 405는 쓰기 경로가 POST·DELETE로만
// 등록돼 있다는 전제 위에 서 있고, 그 전제는 이 파일이 쓰기 경로를 처음 보는 날에야 처음
// 재볼 수 있다. 그날 이 파일이 아래 메시지를 들고 빨개지고, 고치는 사람은 ①프로브를 살아 있는
// 서버에 대고 재고 ②`pluginInstall.measured`를 고치고 ③이 단정을 「서 있어야 한다」로 뒤집는다.
// 그 순서를 건너뛰고 지나가는 길이 없다: 초록이 되는 방법이 그 셋뿐이다.
//
// red proof:
//   · `lib.rs`에서 읽기 라우트 하나를 지우면 이 파일이 그 경로 이름을 부르며 빨개진다.
//   · 쓰기 라우트(예: `…/plugins/{plugin}/install`)를 얹으면 「앱 설치」 단정이 빨개진다.
//   · `provided`만 되돌려도 「앱 보기」 단정이 빨개진다.
//   · 코어가 설치 경로를 바꾸고 프로브를 두면 「프로브가 재는 경로」 단정이 빨개진다.
//
// 재지 못하는 것: **배포된 서버**가 그 경로를 답하는가. 이 파일이 읽는 것은 이 레포의 라우터이지
// 상대편 인스턴스가 아니다. 그 층은 런타임이 맡는다(읽기는 `serverSaysAbsent` 폴딩, 쓰기는
// 프로브). 분담은 `serverSurfaces.ts` 상단이 설명한다.
// =============================================================================

const ROUTER_SOURCE = new URL(
  "../../../../../server-rust/bins/momo-server/src/lib.rs",
  import.meta.url
);

const CORE_API_SOURCE = new URL(
  "../../../../../packages/momo-core/src/lib/api.ts",
  import.meta.url
);

/** `{ws}` 든 `{plugin}` 이든 자리 하나로 접는다. 서버는 이름을, 클라는 값을 채운다. */
function shape(path: string): string {
  return path.replace(/\{[^}]*\}/g, "{}");
}

/**
 * `.route("…", get(…).post(…))` 등록을 (경로 모양 → 메서드 집합)으로 읽는다.
 *
 * 괄호를 세어 핸들러 식의 끝을 찾는다. 정규식 한 방으로 자르면 핸들러 안의 `)` 에서 잘려
 * `.get(` 을 못 보고, 못 본 것을 「없다」로 보고한다. 이 파일이 하면 안 되는 종류의 오답이다.
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
        [...body.matchAll(/\b(get|post|put|patch|delete)\s*\(/g)].map((match) => match[1])
      );
      const existing = routes.get(key);
      if (existing) methods.forEach((method) => existing.add(method));
      else routes.set(key, methods);
    }
    cursor = source.indexOf(marker, index);
  }
  return routes;
}

const READS = [
  { path: "/v1/workspaces/{}/plugins", note: "카탈로그와 호출한 사람의 실효 정책" },
  { path: "/v1/workspaces/{}/plugins/{}", note: "매니페스트 상세" },
] as const;

/** 쓰기 넷(ADR-0113 증보 P3). 클라는 이 여섯 동사·경로를 이미 부른다(`installPlugin` 외). */
const WRITES = [
  { path: "/v1/workspaces/{}/plugins/{}/install", verbs: ["post", "delete"] },
  { path: "/v1/workspaces/{}/plugins/{}/grants", verbs: ["post"] },
  { path: "/v1/workspaces/{}/plugins/{}/grants/{}", verbs: ["delete"] },
] as const;

const WRITE_VERBS = ["post", "put", "patch", "delete"] as const;

describe("앱 — 표와 라우터가 같은 말을 하는가", () => {
  const routes = registeredRoutes(readFileSync(ROUTER_SOURCE, "utf8"));

  it("파서가 라우터를 실제로 읽는다", () => {
    // 파서가 조용히 0개를 읽고 아래 단정들이 전부 통과해 버리는 사고를 막는다.
    expect(routes.size).toBeGreaterThan(40);
    expect(routes.get("/v1/auth/login")).toContain("post");
  });

  describe("앱 보기(plugins)", () => {
    it.each(READS)("GET $path ($note) 가 등록돼 있다", ({ path }) => {
      expect(
        [...(routes.get(path) ?? [])],
        `${path} 를 GET 으로 등록한 .route() 가 server-rust/bins/momo-server/src/lib.rs 에 없다`
      ).toContain("get");
    });

    it.each(READS)("$path 는 읽기만 한다: 쓰기 동사가 없다", ({ path }) => {
      const verbs = [...(routes.get(path) ?? [])];
      for (const verb of WRITE_VERBS) {
        expect(verbs, `${path} 에 ${verb} 가 얹혔다. 쓰기는 「앱 설치」 판정(프로브)이 다룬다`).not.toContain(verb);
      }
    });

    it("표의 provided 는 읽기 둘이 다 서 있을 때만 참이다", () => {
      const allMounted = READS.every(({ path }) => routes.get(path)?.has("get"));
      expect(isSurfaceProvided("plugins")).toBe(allMounted);
    });
  });

  describe("앱 설치(pluginInstall)", () => {
    it("정적 표는 거짓이다: 이 줄은 표가 아니라 서버가 보여 준 사실로 켜진다", () => {
      expect(isSurfaceProvided("pluginInstall")).toBe(false);
    });

    it("쓰기 넷은 아직 라우터에 없다 (서 있다면 아래 메시지를 따른다)", () => {
      const mounted = WRITES.filter(({ path }) => routes.has(path));
      expect(
        mounted.map(({ path }) => path),
        [
          "엔진이 설치·권한 쓰기 경로를 올렸다. 이 단정을 지우고 지나가지 말고 순서대로 한다:",
          "  1) 살아 있는 서버 한 대에 GET …/plugins/{id}/install 과 …/grants 를 보내 둘 다 405인지 잰다",
          "     (serverSurfaces.ts `pluginInstallVerdict` 아래 「엔진 랜딩 시 재확인」 ①②③).",
          "     핸들러가 불리기 전이라 감사 행·설치 행이 생기지 않아야 한다.",
          "  2) 라우터에서 이 경로들에 GET 이 얹히지 않았는지 본다. GET 이 있으면 405가 오지 않아 프로브가 영영 닫힌다.",
          "  3) serverSurfaces.ts `pluginInstall.measured` 를 그날의 실측으로 고친다.",
          "  4) 이 단정을 「넷이 모두 WRITES 의 동사로만 서 있다」로 뒤집는다.",
        ].join("\n")
      ).toEqual([]);
    });

    it("프로브가 재는 경로가 코어가 실제로 부르는 쓰기 경로다", () => {
      // 프로브가 버튼이 부르는 경로와 다른 곳을 재면, 초록인 채로 버튼은 404를 받는다.
      const api = readFileSync(CORE_API_SOURCE, "utf8");
      for (const fragment of [
        "/plugins/${encodeURIComponent(pluginId)}/install`",
        "/plugins/${encodeURIComponent(pluginId)}/grants`",
        "/plugins/${encodeURIComponent(pluginId)}/grants/${encodeURIComponent(scope)}`",
      ]) {
        expect(api, `코어의 쓰기 호출 경로가 바뀌었다: ${fragment}`).toContain(fragment);
      }
      // 프로브 함수가 재는 말단이 위 두 경로의 말단(설치, 권한)과 같다.
      expect(api).toMatch(/\["install", "grants"\]\.map/);
    });
  });
});
