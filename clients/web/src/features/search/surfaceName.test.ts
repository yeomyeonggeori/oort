import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { serverSurface } from "@momo/core/features/capabilities/serverSurfaces";

// =============================================================================
// 한 목적지, 한 이름 — 웹 쪽 가드 (이슈 #1170 M1, #1146 N4 후속).
//
// ## 왜 여기에 또 있나
//
// 이 단정은 이미 한 벌 있었다. `scripts/capture-honesty.mjs` 가 브라우저를 띄워
// 사이드바 줄의 글자와 라우트 제목의 글자를 **런타임에** 비교한다. 그것이 더 강한
// 증명인 것은 맞다 — 실제로 화면에 무엇이 그려졌는지를 보니까.
//
// 문제는 그 증명이 **수동**이라는 것이다(`npm run capture:honesty`). 폰 쪽 같은
// 가드는 jest 스위트에 있어서 `verify_merge_tree.sh` 가 매번 돌리는데, 웹은 다음에
// 누군가 캡처를 손으로 돌릴 때까지 아무것도 붉지 않는다. 즉 두 클라가 같은 결함에
// 대해 **다른 속도로** 반응한다: 폰은 커밋 시점, 웹은 「누가 생각났을 때」.
// 리뷰(#1169 M1)가 가리킨 것은 가드의 부재가 아니라 이 비대칭이다.
//
// ## 그래서 이 파일은 캡처를 흉내 내지 않는다
//
// 이 층에는 DOM 이 없다(웹 vitest 환경은 node 다 — jsdom 도 testing-library 도
// 이 클라의 devDependency 에 없고, 이 한 단정을 위해 들이는 것은 비싼 거래다).
// 대신 폰이 이미 내린 판단과 **같은 씨앗**을 심는다: 이름이 갈라지는 경로는 하나
// 뿐이고, 그것은 누군가 낱말을 손으로 다시 적는 것이다. 세 표면이 전부 코어의 한
// 줄에서 이름을 받아 오면 셋은 **구조적으로** 같은 글자다 — 런타임 비교가 확인해
// 주는 그 결론이 여기서는 배선으로 성립한다.
//
// 캡처는 그대로 남는다. 이 파일이 닫는 것은 「캡처와 캡처 사이」다.
// =============================================================================

const SURFACE_ID = "messageSearch";
const NAME = serverSurface(SURFACE_ID).label;

/**
 * 이 목적지의 이름을 사람에게 내놓는 두 자리. 사이드바 줄은 #3334에서 없어졌다(⌘K가 메시지
 * 본문까지 덮는다, 성재 2026-10-02): 사이드바는 더 이상 이 이름을 내놓는 자리가 아니다
 * (아래 「사이드바에는 메시지 검색 줄이 없다」).
 */
const SURFACES = {
  route: "./SearchRoute.tsx",
  palette: "../../app/QuickSwitcher.tsx",
} as const;

/** 목록 열의 목적지 줄을 그리는 소스들. 어느 하나라도 이 줄을 다시 세우면 아래 시험이 붉다. */
const SIDEBAR_SOURCES = [
  "../sidebar/Sidebar.tsx",
  "../sidebar/SidebarDestinations.tsx",
  "../sidebar/WorkspaceRail.tsx",
] as const;

function read(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

/**
 * 산문을 걷어낸다 — 주석은 이 낱말들을 계속 써야 한다.
 *
 * 산문까지 막는 가드는 가드가 무뎌지는 대신 글이 무뎌진다. 폰의 같은 가드가
 * 같은 이유로 같은 일을 한다.
 */
function stripProse(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * 이 소스가 그 낱말을 **손으로** 갖고 있는가. 어떤 인용부호로 적었는지는 묻지
 * 않는다 — 배선으로 받아 온 이름은 런타임에만 있고 소스에는 없으므로, 소스에서
 * 글자가 보이면 그것이 곧 손으로 적은 것이다.
 */
function handWrites(source: string, name: string): boolean {
  return stripProse(source).includes(name);
}

describe("메시지 검색이라는 목적지는 이름이 하나다 (이슈 #1170 M1)", () => {
  it("두 표면 전부 표면 판정표에서 이름을 받아 온다", () => {
    const missing = Object.entries(SURFACES)
      .filter(([, path]) => !stripProse(read(path)).includes(`serverSurface("${SURFACE_ID}")`))
      .map(([surface]) => surface);
    expect(missing).toEqual([]);
  });

  it("어느 표면도 낱말을 손으로 적지 않는다", () => {
    const offenders = Object.entries(SURFACES)
      .filter(([, path]) => handWrites(read(path), NAME))
      .map(([surface]) => surface);
    expect(offenders).toEqual([]);
  });

  it("사이드바에는 메시지 검색 줄이 없다 (#3334: ⌘K가 대신한다)", () => {
    // 줄이 돌아오는 길은 둘이다: 목적지 줄(`to="/search"`·`nav-search`)을 다시 세우거나, 표면 판정표의
    // 그 이름을 사이드바가 들고 나오는 것. 둘 다 산문을 걷어낸 소스에서 잡는다.
    for (const path of SIDEBAR_SOURCES) {
      const code = stripProse(read(path));
      expect(code, `${path} nav-search`).not.toContain("nav-search");
      expect(code, `${path} /search 줄`).not.toMatch(/to=["{`]*\/search/);
      expect(code, `${path} 판정표 이름`).not.toContain(`serverSurface("${SURFACE_ID}")`);
      expect(code, `${path} isSurfaceProvided`).not.toContain(`isSurfaceProvided("${SURFACE_ID}")`);
    }
  });

  it("라우트 제목이 코어의 그 한 줄이다", () => {
    const route = read(SURFACES.route);
    expect(route).toMatch(
      new RegExp(`const SEARCH_SURFACE_NAME = serverSurface\\("${SURFACE_ID}"\\)\\.label;`)
    );
    expect(route).toMatch(/data-testid="search-title"\s*>\s*\{SEARCH_SURFACE_NAME\}/);
  });

  it("수동 캡처가 붙잡는 로케이터가 그대로 있다", () => {
    // capture-honesty.mjs 는 라우트의 `search-title` innerText 를 팔레트 항목과 비교한다
    // (#3334 이후 사이드바 줄 `nav-search`는 없다). 로케이터가 사라지면 그 하네스는
    // 이름-분열이 아니라 **로케이터 타임아웃**으로 붉어서, 무엇이 깨졌는지 말해 주지
    // 않는다(#1169 리뷰 N4). 그 실패를 여기서 먼저, 이름으로 잡는다.
    expect(read(SURFACES.route)).toContain('data-testid="search-title"');
  });

  it("가드가 보는 문법이 이 파일들이 쓰는 문법이다", () => {
    // 폰의 같은 가드가 인용형 둘만 보다가 백틱과 JSX 맨글자를 놓쳤다(#1170 N1).
    // 웹은 그 구멍을 물려받지 않는다 — 씨앗으로 확인한다.
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ["홑따옴표", `aria-label='${NAME}'`],
      ["쌍따옴표", `aria-label="${NAME}"`],
      ["백틱", "const l = `" + NAME + "`;"],
      ["백틱 + 치환", "const l = `" + NAME + " ${q}`;"],
      ["JSX 맨글자", `<h1>${NAME}</h1>`],
      ["JSX 맨글자, 줄바꿈", `<h1>\n  ${NAME}\n</h1>`],
    ];
    const missed = shapes
      .filter(([, snippet]) => !handWrites(snippet, NAME))
      .map(([shape]) => shape);
    expect(missed).toEqual([]);

    // 그리고 산문은 여전히 통과한다.
    expect(handWrites(`// 이 줄은 ${NAME}으로 간다`, NAME)).toBe(false);
    expect(handWrites(`{/* ${NAME} 라우트 */}`, NAME)).toBe(false);
  });
});
