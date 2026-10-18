// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { serverSurface } from "@momo/core/features/capabilities/serverSurfaces";
import { ApiError, type MembershipRole } from "@momo/core/lib/api";
import { NO_INSTALLER_SENTENCE } from "./model";
// 서버가 실제로 준 바이트다(server-rust 시험이 못박는다, #3859). 지어낸 응답이 아니다.
import catalogWire from "../../../../../server/Fixtures/plugin-wire/catalog.json";
import githubDetailWire from "../../../../../server/Fixtures/plugin-wire/detail-github.json";
// 나머지 세 앱의 상세는 서버가 시드하는 매니페스트를 같은 모양으로 감싼 것이다.
import driveManifest from "../../../../../server/Fixtures/plugin-manifests/drive.json";
import linearManifest from "../../../../../server/Fixtures/plugin-manifests/linear.json";
import notionManifest from "../../../../../server/Fixtures/plugin-manifests/notion.json";

// =============================================================================
// 「앱」 화면 읽기 전용 (#3860, ADR-0113 증보 P-U1).
//
// 한 화면이 세 서버 앞에서 서는 모습을 같은 픽스처로 잰다.
//   - 설치·권한 경로가 없는 서버(오늘의 Rust 서버): 읽기만, 안내 한 줄.
//   - 그 경로가 서 있는 서버: 같은 정보 위에 버튼이 돌아온다.
//   - 앱 목록 경로조차 없는 서버: 구획이 접힌다.
// 쓰기 흐름 자체(동의 다이얼로그, 뮤테이션)는 `gate:shell`이 재고, 여기서는 그 문이 열리고 닫히는 것만 본다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const GITHUB = "com.momo.plugins.github";
const LINEAR = "com.momo.plugins.linear";
const NOTION = "com.momo.plugins.notion";
const DRIVE = "com.momo.plugins.drive";

const h = vi.hoisted(() => ({
  catalog: null as unknown,
  details: new Map<string, unknown>(),
  probe: vi.fn(),
  listError: null as unknown,
  role: "owner" as string,
  /** 나 말고 디렉터리에 있는 사람들(관리자 안내 시험이 쓴다). */
  others: [] as Array<Record<string, unknown>>,
  grant: vi.fn(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    // 화면이 부르는 읽기는 **진짜 와이어 파서**를 통과한다(픽스처는 서버의 응답 그대로).
    listPlugins: async () => {
      if (h.listError) throw h.listError;
      return actual.pluginCatalogFromWire(h.catalog);
    },
    getPlugin: async (_workspace: string, pluginId: string) => {
      const wire = h.details.get(pluginId);
      if (!wire) throw new actual.ApiError(404, "plugin not found");
      return actual.pluginDetailFromWire(wire);
    },
    probePluginWriteRoutes: (...args: unknown[]) => h.probe(...args),
    // 쓰기는 호출 횟수와 인자를 센다: 「동의 없이 grant POST 0」은 이 mock의 호출 수로 잰다.
    grantPluginScope: (...args: unknown[]) => h.grant(...args),
  };
});

vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: WS, session: { member: { id: ME } } }),
}));

vi.mock("@/features/workspace/useWorkspace", () => ({
  useDirectory: () => ({
    isPending: false,
    isError: false,
    refetch: () => undefined,
    directory: {
      members: [
        { id: ME, kind: "human", status: "active", role: h.role, displayName: "곽성재", handle: "seongjae" },
        ...h.others,
      ],
    },
  }),
  memberFor: (
    directory: { members: Array<{ id: string; role: MembershipRole }> },
    id: string
  ) => directory.members.find((member) => member.id === id),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

function detailWire(manifest: { plugin: { id: string } }) {
  const item = (catalogWire.plugins as Array<Record<string, unknown>>).find(
    (plugin) => plugin.pluginId === manifest.plugin.id
  );
  const rest: Record<string, unknown> = { ...item };
  delete rest.recommended;
  return { plugin: { ...rest, manifest } };
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  h.catalog = catalogWire;
  h.details = new Map<string, unknown>([
    [GITHUB, githubDetailWire],
    [DRIVE, detailWire(driveManifest)],
    [LINEAR, detailWire(linearManifest)],
    [NOTION, detailWire(notionManifest)],
  ]);
  h.listError = null;
  h.role = "owner";
  h.others = [];
  h.grant.mockReset();
  h.probe.mockReset();
  // 기본은 오늘의 서버: 설치·권한 경로가 라우터에 없다.
  h.probe.mockResolvedValue([404, 404]);
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * 조건이 설 때까지 act를 짧게 반복한다. act 안에서 기다리면 React가 그 scope를 나가기 전까지
 * 렌더를 밀어 두므로, DOM을 읽는 조건이 영영 서지 않는다.
 */
async function until(check: () => unknown, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw new Error(`until 시간 초과: ${String(check)}`);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });
  }
}

async function mount(): Promise<HTMLElement> {
  const { PluginSection } = await import("./PluginSection");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(PluginSection, { offline: false })
      )
    );
  });
  return host;
}

const q = (el: HTMLElement, testId: string) => el.querySelector(`[data-testid="${testId}"]`);
const text = (el: HTMLElement, testId: string) => (q(el, testId)?.textContent ?? "").replace(/\s+/g, " ").trim();
const buttons = (el: HTMLElement) =>
  [...el.querySelectorAll("button")].map((button) => (button.textContent ?? "").trim());

async function openDetail(el: HTMLElement, pluginId: string) {
  await until(() => q(el, "plugin-list"));
  await act(async () => {
    (q(el, `plugin-catalog-${pluginId}`) as HTMLElement).click();
  });
  await until(() => q(el, "plugin-detail"));
  await until(() => (q(el, "plugin-detail")?.getAttribute("aria-label") ?? "").length > 0);
  await flush();
}

/** 설치·권한을 바꾸는 컨트롤이 하나라도 서 있는가. */
function writeControls(el: HTMLElement): string[] {
  const names = buttons(el);
  return names.filter((name) =>
    ["워크스페이스에 설치", "다시 활성화", "설치 해제", "내 사용 허용", "권한 추가", "내 권한 회수"].includes(name)
  );
}

describe("읽기 전용: 설치·권한 경로가 없는 서버 (오늘의 Rust 서버)", () => {
  it("공식 네 앱을 서버가 준 순서로 보여 주고, 영어 매니페스트 문구 대신 한국어 한 줄 소개를 쓴다", async () => {
    const el = await mount();
    await until(() => q(el, "plugin-list"));
    const rows = [...el.querySelectorAll('[data-testid^="plugin-catalog-"]')];
    // 이름은 타일 바로 다음 칸이다.
    const nameOf = (row: Element) =>
      row.querySelector('span[aria-hidden="true"]')?.nextElementSibling?.textContent;
    expect(rows.map(nameOf)).toEqual([
      "Google Drive",
      "GitHub",
      "Linear",
      "Notion",
    ]);
    // 공식 표시는 네 앱 모두에 있고, 타일 글자는 서로 다르다(G가 둘이면 목록에서 구별되지 않는다).
    expect(rows.every((row) => (row.textContent ?? "").includes("공식"))).toBe(true);
    const tiles = rows.map((row) => row.querySelector('span[aria-hidden="true"]')?.textContent);
    expect(tiles).toEqual(["GD", "G", "L", "N"]);
    const list = text(el, "plugin-list");
    expect(list).toContain("공유 드라이브의 파일");
    expect(list).toContain("코드 저장소와 이슈");
    // 서버의 영어 설명 문장이 서지 않는다. 연결 주소(mcp.linear.app)는 데이터라 따로 말한다.
    expect(list).not.toMatch(/Official|integration|read-only|shared drive/i);
  });

  it("목록 줄은 내가 허용한 도구와 설치 상태를 정직하게 말한다", async () => {
    const el = await mount();
    await until(() => q(el, "plugin-list"));
    const row = (id: string) => (q(el, `plugin-catalog-${id}`)?.textContent ?? "").replace(/\s+/g, " ");
    // 서버의 정책 투영(toolPolicy)에 GitHub 도구 둘이 실려 있다.
    expect(row(GITHUB)).toContain("허용한 도구 2개");
    expect(row(GITHUB)).toContain("설치됨 · 내가 허용함");
    expect(row(LINEAR)).toContain("설치했지만 비활성");
    expect(row(NOTION)).toContain("미설치");
    expect(row(NOTION)).toContain("허용한 도구 없음");
    // 한 줄: 내 허용 상태 · 연결하는 곳.
    expect(row(DRIVE)).toContain("허용한 도구 없음 · 연결 www.googleapis.com, oauth2.googleapis.com");
  });

  it("GitHub 상세: 배포자·할 수 있는 일·연결하는 곳·내 권한이 한 화면에 있고 버튼은 없다", async () => {
    const el = await mount();
    await openDetail(el, GITHUB);
    const detail = text(el, "plugin-detail");

    // 설치 상태와 내 권한: 정책이 싣는 것만 말한다.
    expect(text(el, "plugin-status-workspace")).toContain("설치돼 있어요");
    expect(text(el, "plugin-status-mine")).toContain("github 읽기 권한 (허용한 도구 2개)");

    // 할 수 있는 일: 매니페스트의 한국어 설명이 제목이고, 도구 이름은 식별자로 아래에 선다.
    const tools = [...(q(el, "plugin-tools")?.querySelectorAll("li") ?? [])];
    expect(tools).toHaveLength(2);
    expect(tools[0].textContent).toContain("권한을 위임한 사용자가 접근할 수 있는 저장소 목록을 조회합니다.");
    expect(tools[0].textContent).toContain("github.list_repositories");
    expect(text(el, "plugin-tools")).toContain("이 앱의 도구는 2개이고, 모두 읽기 도구예요.");
    // 내가 허용한 도구에만 「내가 허용함」이 붙는다.
    expect((text(el, "plugin-tools").match(/내가 허용함/g) ?? []).length).toBe(2);
    expect(text(el, "plugin-tools")).not.toContain("내게 허용됨");
    // 읽기 도구와 읽기 전용 승인은 위 요약이 이미 말한다: 도구마다 같은 칩 둘을 달지 않는다.
    expect(text(el, "plugin-tools")).not.toMatch(/위험도: 읽기|승인: 읽기 전용/);

    // 연결하는 곳(D5): 주소와, 그 주소로 무엇이 오가는지 쉬운 말로.
    const egress = text(el, "plugin-egress");
    expect(egress).toContain("api.githubcopilot.com");
    expect(egress).toContain("요청이 나가요");
    expect(egress).toContain("도구에 넘긴 검색어 같은 내용");
    // `)` 바로 뒤의 조사는 keep-all에서도 줄바꿈 자리라 900px에서 조사가 줄 머리에 홀로 남았다(M1).
    expect(egress).not.toMatch(/\)[가-힣]/);
    // 로그인 정보를 어디에 둔다는 보증은 하지 않는다(앱마다 다르고 이 화면이 아는 사실이 아니다).
    expect(egress).not.toMatch(/토큰|비밀번호|저장하지 않/);

    // 배포자 정보. 이용약관·개인정보 링크가 없는 오늘 제목이 「약관」을 약속하지 않는다(M6).
    expect(q(el, "plugin-detail")?.textContent).toContain("배포자 정보");
    expect(q(el, "plugin-detail")?.textContent).not.toContain("배포자와 약관");
    expect(detail).toContain("GitHub, oort 레지스트리가 확인했어요");
    expect(detail).toContain("MIT");
    expect(q(el, "plugin-detail")?.querySelector('a[href="https://github.com/github/github-mcp-server"]')).not.toBeNull();

    // 쓰기 컨트롤이 없다.
    expect(writeControls(el)).toEqual([]);
    expect(q(el, "plugin-scope-grant")).toBeNull();
    expect(q(el, "plugin-scope-revoke")).toBeNull();
  });

  it("차분한 안내 한 줄이 버튼 자리에 서고, 문장은 판정표의 것이다. 오류가 아니다", async () => {
    const el = await mount();
    await openDetail(el, NOTION);
    const notice = q(el, "plugin-install-closed");
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toBe(serverSurface("pluginInstall").fallback);
    expect(notice?.textContent).toContain("보기만 할 수 있어요");
    // 아직 만들지 않은 기능은 잘못된 것이 아니다: alert 역할도 오류 배너도 아니다.
    expect(el.querySelector('[role="alert"]')).toBeNull();
    expect(notice?.closest('[role="alert"]')).toBeNull();
    expect(writeControls(el)).toEqual([]);
    // 설치하지 않은 앱의 상태도 그대로 말한다.
    expect(text(el, "plugin-status-workspace")).toContain("설치하지 않았어요");
    expect(text(el, "plugin-status-mine")).toContain("허용한 권한이 없어요");
  });

  it("안내 줄은 이미 설치된 앱 곁에서도 참이다: 곧 열린다고 예측하지 않고 해제·권한 변경도 막혀 있다고 말한다 (H1)", async () => {
    const el = await mount();
    await openDetail(el, GITHUB);
    // 실제 서버 바이트에서 GitHub은 설치되어 켜져 있다: 「설치돼 있어요」 곁에서 「설치는 곧」이면 모순이다.
    expect(text(el, "plugin-status-workspace")).toContain("설치돼 있어요");
    const notice = text(el, "plugin-install-closed");
    expect(notice).toContain("보기만 할 수 있어요");
    expect(notice).toContain("설치와 해제, 권한 변경");
    expect(notice).not.toMatch(/곧|나중|예정/);
    // 같은 줄이 서버를 모를 때(403)도 서고, 그때도 참이다(예측도 단정도 없다).
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    h.probe.mockResolvedValue([405, 403]);
    const unknown = await mount();
    await openDetail(unknown, GITHUB);
    await until(() => q(unknown, "plugin-install-closed"));
    expect(text(unknown, "plugin-install-closed")).toBe(notice);
  });

  it("공식 네 앱은 모두 공식이라 「공식」 칩은 신호색이 아니라 중립 톤이다 (M5)", async () => {
    const el = await mount();
    await openDetail(el, GITHUB);
    const chips = [...el.querySelectorAll("span")].filter((span) => span.textContent === "공식");
    // 목록 네 줄 + 상세 머리 하나.
    expect(chips.length).toBe(5);
    for (const chip of chips) expect(chip.className, chip.className).not.toMatch(/accent|signal/);
  });

  it("도구 칩은 평범하지 않은 것만 단다: 읽기 도구는 칩이 없고 쓰기 도구와 쓰기 승인은 칩이 된다 (M7)", async () => {
    const writeTool = {
      name: "notion.update_page",
      description: "페이지의 내용을 고칩니다.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      risk: "write",
      approvalPolicy: "require_approval",
      schemaDigest: `sha256:${"c".repeat(64)}`,
      scopes: ["notion:write"],
    };
    const manifest = {
      ...notionManifest,
      mcp: { ...notionManifest.mcp, tools: [...notionManifest.mcp.tools, writeTool] },
      momo: {
        ...notionManifest.momo,
        approvalTier: { ...notionManifest.momo.approvalTier, "notion.update_page": "workspace_write" },
      },
    };
    h.details.set(NOTION, detailWire(manifest));
    const el = await mount();
    await openDetail(el, NOTION);
    const rows = [...(q(el, "plugin-tools")?.querySelectorAll("li") ?? [])];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain("notion.search");
    expect(rows[0].textContent).not.toMatch(/위험도|승인/);
    expect(rows[1].textContent).toContain("위험도: 쓰기");
    expect(rows[1].textContent).toContain("승인: 워크스페이스 쓰기");
    expect(text(el, "plugin-tools")).toContain("이 앱의 도구는 2개예요: 읽기 1개, 쓰기 1개.");
  });

  it("설치했지만 꺼진 앱(Linear)은 그렇게 말하고, 라이선스는 읽을 수 있는 이름이다", async () => {
    const el = await mount();
    await openDetail(el, LINEAR);
    expect(text(el, "plugin-status-workspace")).toContain("설치했지만 비활성이에요");
    // 서버는 grant를 설치가 켜져 있을 때만 센다: 빈 정책은 「허용한 적 없다」가 아니라 「지금 적용되는 것이 없다」다.
    expect(text(el, "plugin-status-mine")).toContain("비활성인 동안은 적용되는 권한이 없어요");
    expect(text(el, "plugin-status-mine")).not.toContain("허용한 권한이 없어요");
    expect(text(el, "plugin-detail")).toContain("Linear 호스팅 서비스 약관");
    expect(text(el, "plugin-detail")).not.toContain("LicenseRef-");
  });

  it("Drive는 연결 주소를 둘 다 공개하고 읽기 도구 셋을 말한다", async () => {
    const el = await mount();
    await openDetail(el, DRIVE);
    expect(text(el, "plugin-egress")).toContain("www.googleapis.com");
    expect(text(el, "plugin-egress")).toContain("oauth2.googleapis.com");
    expect(text(el, "plugin-tools")).toContain("이 앱의 도구는 3개이고, 모두 읽기 도구예요.");
  });

  it("공식 네 앱은 한눈에 읽히므로 검색·보기 컨트롤이 서지 않는다", async () => {
    const el = await mount();
    await until(() => q(el, "plugin-list"));
    expect(el.querySelectorAll('[data-testid^="plugin-catalog-"]')).toHaveLength(4);
    expect(el.querySelector("#plugin-search")).toBeNull();
    expect(el.querySelector("#plugin-filter")).toBeNull();
  });

  it("검색이 다 걸러 낸 빈 상태는 「아직」 없이 맞는 앱이 없다고 말하고 필터 지우기가 목록을 되돌린다", async () => {
    const real = (catalogWire.plugins as Array<Record<string, unknown>>);
    const extra = ["alpha", "beta", "gamma"].map((name) => ({
      ...real[0],
      pluginId: `com.example.${name}`,
      name: `예시 ${name}`,
      official: false,
    }));
    h.catalog = { ...catalogWire, plugins: [...real, ...extra] };
    const el = await mount();
    await until(() => q(el, "plugin-list"));
    const search = el.querySelector("#plugin-search") as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "zzzz");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(() => q(el, "plugins-empty"));
    const empty = text(el, "plugins-empty");
    // 서버에 앱이 없는 경우(「…아직 없어요」)와 다르다: 걸러서 빈 것은 시간 문제가 아니다.
    expect(empty).toContain("맞는 앱이 없어요.");
    expect(empty).not.toContain("아직");
    expect(empty).toContain("검색어나 보기를 바꿔 다른 앱을 확인하세요.");
    await act(async () => {
      [...el.querySelectorAll("button")].find((button) => button.textContent === "필터 지우기")?.click();
    });
    await until(() => q(el, "plugin-list"));
    expect(el.querySelectorAll('[data-testid^="plugin-catalog-"]')).toHaveLength(7);
  });

  it("목록이 한눈에 읽히는 길이를 넘으면 컨트롤이 돌아온다", async () => {
    // 길이만 재는 합성 항목이다: 공식 네 앱 뒤에 가짜 셋을 더해 일곱으로 만든다.
    const real = (catalogWire.plugins as Array<Record<string, unknown>>);
    const extra = ["alpha", "beta", "gamma"].map((name) => ({
      ...real[0],
      pluginId: `com.example.${name}`,
      name: `예시 ${name}`,
      official: false,
    }));
    h.catalog = { ...catalogWire, plugins: [...real, ...extra] };
    const el = await mount();
    await until(() => q(el, "plugin-list"));
    expect(el.querySelectorAll('[data-testid^="plugin-catalog-"]')).toHaveLength(7);
    expect(el.querySelector("#plugin-search")).not.toBeNull();
    expect(el.querySelector("#plugin-filter")).not.toBeNull();
  });
});

describe("열림: 설치·권한 경로가 서 있는 서버 (405, 405)", () => {
  beforeEach(() => h.probe.mockResolvedValue([405, 405]));

  it("같은 정보 위에 관리 버튼이 돌아오고 안내 줄은 빠진다", async () => {
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => writeControls(el).length > 0);
    expect(writeControls(el)).toEqual(["워크스페이스에 설치"]);
    expect(q(el, "plugin-install-closed")).toBeNull();
    // 정보 블록은 닫힘과 같은 말을 한다: 버튼이 문장을 바꾸지 않는다.
    expect(text(el, "plugin-status-workspace")).toContain("설치하지 않았어요");
    expect(text(el, "plugin-egress")).toContain("mcp.notion.com");
  });

  it("설치된 앱(GitHub)은 회수·해제 줄을 얻고, 내 권한 문장은 그대로다", async () => {
    const el = await mount();
    await openDetail(el, GITHUB);
    await until(() => writeControls(el).length > 0);
    expect(writeControls(el).sort()).toEqual(["내 권한 회수", "설치 해제"].sort());
    expect(text(el, "plugin-status-mine")).toContain("github 읽기 권한 (허용한 도구 2개)");
  });

  it("관리자가 아닌 멤버는 설치 대신 누구에게 부탁할지 안내를 받는다", async () => {
    h.role = "member";
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => (q(el, "plugin-detail")?.textContent ?? "").includes(NO_INSTALLER_SENTENCE));
    expect(writeControls(el)).toEqual([]);
    // 부탁할 사람이 목록에 없으면(이 시험의 디렉터리에는 나뿐이다) 활성 관리자가 없는 상태다.
    expect(text(el, "plugin-detail")).toContain(NO_INSTALLER_SENTENCE);
  });
});

describe("모를 때는 닫는다", () => {
  it("확인이 끝나기 전에는 버튼도 안내도 그리지 않는다(안내가 먼저 깜빡이지 않는다)", async () => {
    h.probe.mockReturnValue(new Promise(() => {}));
    const el = await mount();
    await openDetail(el, NOTION);
    expect(q(el, "plugin-install-closed")).toBeNull();
    expect(writeControls(el)).toEqual([]);
    // 정보는 확인과 무관하게 이미 서 있다.
    expect(text(el, "plugin-egress")).toContain("mcp.notion.com");
  });

  it("경로에 대한 진술이 아닌 답(403)이나 반쪽만 선 서버는 버튼을 세우지 않는다", async () => {
    for (const answer of [[405, 403], [405, 404], [200, 200]]) {
      h.probe.mockResolvedValue(answer);
      const el = await mount();
      await openDetail(el, NOTION);
      await until(() => q(el, "plugin-install-closed"));
      expect(writeControls(el), JSON.stringify(answer)).toEqual([]);
      act(() => root?.unmount());
      host?.remove();
      root = null;
      host = null;
    }
  });

  it("네트워크가 끊겨 프로브가 던져도 닫힌 채 읽기는 계속된다", async () => {
    h.probe.mockRejectedValue(new Error("unreachable"));
    const el = await mount();
    await openDetail(el, GITHUB);
    await until(() => q(el, "plugin-install-closed"));
    expect(writeControls(el)).toEqual([]);
    expect(text(el, "plugin-tools")).toContain("github.list_repositories");
  });

  it("프로브는 카탈로그가 준 실제 앱 하나를 경로에 싣고 워크스페이스 단위로 한 번만 보낸다", async () => {
    const el = await mount();
    await openDetail(el, GITHUB);
    await openDetail(el, LINEAR);
    await flush();
    expect(h.probe).toHaveBeenCalledTimes(1);
    const [workspace, pluginId] = h.probe.mock.calls[0] as [string, string];
    expect(workspace).toBe(WS);
    expect((catalogWire.plugins as Array<{ pluginId: string }>).map((plugin) => plugin.pluginId)).toContain(pluginId);
  });
});

describe("서버가 앱 목록을 싣지 않을 때와 비었을 때", () => {
  it("목록 경로가 없는 서버(404)는 구획이 접히고, 쓰기 프로브는 한 번도 보내지 않는다", async () => {
    const { ApiError } = await import("@momo/core/lib/api");
    h.listError = new ApiError(404, "not found");
    const el = await mount();
    await until(() => q(el, "plugins-unavailable"));
    expect(q(el, "plugin-list")).toBeNull();
    expect(text(el, "plugins-unavailable")).toContain(serverSurface("plugins").absentReason);
    expect(h.probe).not.toHaveBeenCalled();
  });

  it("같은 404가 아니라 5xx이면 접지 않고 오류와 다시 시도를 말한다", async () => {
    const { ApiError } = await import("@momo/core/lib/api");
    h.listError = new ApiError(503, "unavailable");
    const el = await mount();
    await until(() => q(el, "plugins-error"));
    expect(q(el, "plugins-unavailable")).toBeNull();
    expect(text(el, "plugins-error")).toContain("다시 시도");
  });

  it("등록된 앱이 없으면 빈 상태가 사실대로 말하고, 쓰기 프로브도 보내지 않는다", async () => {
    h.catalog = { plugins: [], toolPolicy: { plugins: [] } };
    const el = await mount();
    await until(() => q(el, "plugins-empty"));
    expect(text(el, "plugins-empty")).toContain("보여 줄 앱이 아직 없어요.");
    expect(text(el, "plugins-empty")).toContain("서버에 등록된 공식 앱이 생기면 여기에 나타나요.");
    // 「설치할 수 있는」은 읽기만 되는 서버에서 약속이 된다.
    expect(text(el, "plugins-empty")).not.toContain("설치할 수 있는");
    expect(h.probe).not.toHaveBeenCalled();
  });
});


// =============================================================================
// #3943 (U-2): 설치가 열린 서버 위의 동의 창·관리자 안내·연결 상태.
// =============================================================================

const NOTION_WRITE_TOOL = {
  name: "notion.update_page",
  description: "페이지의 내용을 고칩니다.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  risk: "write",
  approvalPolicy: "require_approval",
  schemaDigest: `sha256:${"c".repeat(64)}`,
  scopes: ["notion:write"],
};

/** 노션을 설치·활성으로 두고 권한 둘(읽기·쓰기)을 선언하게 한다. 내가 허용한 도구는 `allowed`가 정한다. */
function installNotion(allowed: string[]) {
  const manifest = {
    ...notionManifest,
    mcp: { ...notionManifest.mcp, tools: [...notionManifest.mcp.tools, NOTION_WRITE_TOOL] },
    momo: {
      ...notionManifest.momo,
      approvalTier: { ...notionManifest.momo.approvalTier, "notion.update_page": "workspace_write" },
    },
  };
  const detail = detailWire(manifest) as { plugin: Record<string, unknown> };
  detail.plugin.installed = true;
  detail.plugin.enabled = true;
  h.details.set(NOTION, detail);
  const catalog = JSON.parse(JSON.stringify(catalogWire)) as {
    plugins: Array<Record<string, unknown>>;
    toolPolicy: { plugins: Array<{ pluginId: string; tools: unknown[] }> };
  };
  const item = catalog.plugins.find((plugin) => plugin.pluginId === NOTION);
  if (item) Object.assign(item, { installed: true, enabled: true });
  const tools = [
    { name: "notion.search", risk: "read", approvalTier: "read_only" },
    { name: "notion.update_page", risk: "write", approvalTier: "workspace_write" },
  ].filter((tool) => allowed.includes(tool.name));
  catalog.toolPolicy.plugins = catalog.toolPolicy.plugins.filter((entry) => entry.pluginId !== NOTION);
  if (tools.length > 0) catalog.toolPolicy.plugins.push({ pluginId: NOTION, tools });
  h.catalog = catalog;
}

const click = async (el: HTMLElement, testId: string) =>
  act(async () => {
    (q(el, testId) as HTMLElement).click();
  });

describe("관리자 안내: 설치는 관리자만 한다 (U-2)", () => {
  beforeEach(() => h.probe.mockResolvedValue([405, 405]));

  it("관리자가 있으면 멤버에게 「○○님(관리자)에게 설치를 요청하세요」를 보이고 설치 버튼은 없다", async () => {
    h.role = "member";
    h.others = [
      { id: "a1", kind: "human", status: "active", role: "admin", displayName: "김관리", handle: "kim" },
    ];
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => (q(el, "plugin-detail")?.textContent ?? "").includes("(관리자)"));
    expect(text(el, "plugin-detail")).toContain("김관리님(관리자)에게 설치를 요청하세요.");
    expect(text(el, "plugin-detail")).not.toContain(NO_INSTALLER_SENTENCE);
    expect(writeControls(el)).toEqual([]);
  });

  it("활성 관리자가 없으면(정지·에이전트뿐) 「설치할 사람이 없어요」를 그대로 보인다", async () => {
    h.role = "member";
    h.others = [
      { id: "a2", kind: "human", status: "suspended", role: "admin", displayName: "정지", handle: "stop" },
      { id: "a3", kind: "agent", status: "active", role: "admin", displayName: "봇", handle: "bot" },
    ];
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => (q(el, "plugin-detail")?.textContent ?? "").includes("설치할 사람이 없어요"));
    expect(text(el, "plugin-detail")).toContain(
      "이 워크스페이스에 앱을 설치할 사람이 없어요. 소유자 계정을 확인해 주세요."
    );
    expect(text(el, "plugin-detail")).not.toContain("(관리자)에게");
    expect(writeControls(el)).toEqual([]);
  });

  it("관리자 본인에게는 안내 대신 설치 버튼이 선다", async () => {
    h.role = "admin";
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => writeControls(el).length > 0);
    expect(writeControls(el)).toEqual(["워크스페이스에 설치"]);
    expect(text(el, "plugin-detail")).not.toContain("설치를 요청하세요");
    expect(text(el, "plugin-detail")).not.toContain(NO_INSTALLER_SENTENCE);
  });
});

// 동의 창은 포털로 문서 맨 아래에 서므로 호스트가 아니라 문서에서 찾는다.
const dq = (testId: string) => document.querySelector(`[data-testid="${testId}"]`);
const dtext = (testId: string) => (dq(testId)?.textContent ?? "").replace(/\s+/g, " ").trim();
const clickDoc = async (testId: string) =>
  act(async () => {
    (dq(testId) as HTMLElement).click();
  });

describe("허용 동의: 동의 없이는 grant POST가 나가지 않는다 (U-2 red proof)", () => {
  beforeEach(() => h.probe.mockResolvedValue([405, 405]));

  async function openGrantDialog() {
    installNotion([]);
    h.role = "member"; // 내 사용 허용은 설치와 달리 본인이 직접 누르는 일이다: 관리자가 아니어도 된다.
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => q(el, "plugin-scope-grant"));
    await click(el, "plugin-scope-grant");
    await until(() => dq("plugin-scope-consent"));
    return el;
  }

  it("창을 열기만 하거나 닫아도 POST는 0이고, 아무것도 고르지 않은 채 열린다", async () => {
    await openGrantDialog();
    expect(h.grant).toHaveBeenCalledTimes(0);
    // 권한마다 따로 동의: 모두 미리 골라 두지 않는다.
    expect(dtext("plugin-scope-selection-count")).toBe("2개 중 0개 선택");
    expect((dq("plugin-scope-notion:read") as HTMLInputElement).checked).toBe(false);
    expect((dq("plugin-scope-notion:write") as HTMLInputElement).checked).toBe(false);
    // 고른 것이 없으면 확인 버튼을 눌러도 아무것도 나가지 않는다.
    await clickDoc("plugin-scope-confirm");
    await flush();
    expect(h.grant).toHaveBeenCalledTimes(0);
    await clickDoc("plugin-scope-cancel");
    await flush();
    expect(dq("plugin-scope-consent")).toBeNull();
    expect(h.grant).toHaveBeenCalledTimes(0);
  });

  it("동의 창에 두 줄이 서고, 그 앱의 토큰이 oort에 없다고 말한다", async () => {
    await openGrantDialog();
    const lines = [...(dq("plugin-consent-custody")?.querySelectorAll("li") ?? [])].map((li) => li.textContent);
    expect(lines).toEqual(["토큰은 oort에 없어요", "처음 쓸 때 실행 장소에서 로그인해요"]);
  });

  it("서버가 연결을 들고 있는 앱(hosted, 팀 공유 드라이브)의 동의 창에는 두 줄이 서지 않는다", async () => {
    // 같은 두 줄을 서버가 직접 연결을 들고 있는 앱에 말하면 거짓이다(ADR-0113 D1-A는 사람별 OAuth 앱의 계약이다).
    installNotion([]);
    const drive = detailWire(driveManifest) as { plugin: Record<string, unknown> };
    drive.plugin.installed = true;
    drive.plugin.enabled = true;
    h.details.set(DRIVE, drive);
    const catalog = h.catalog as { plugins: Array<Record<string, unknown>> };
    Object.assign(catalog.plugins.find((plugin) => plugin.pluginId === DRIVE) ?? {}, { installed: true, enabled: true });
    h.role = "member";
    const el = await mount();
    await openDetail(el, DRIVE);
    await until(() => q(el, "plugin-scope-grant"));
    await click(el, "plugin-scope-grant");
    await until(() => dq("plugin-scope-consent"));
    expect(dq("plugin-consent-custody")).toBeNull();
    expect(dtext("plugin-scope-consent")).not.toContain("토큰은 oort에 없어요");
  });

  it("고른 권한만 권한마다 한 번씩 나간다: 고르지 않은 권한은 나가지 않는다", async () => {
    await openGrantDialog();
    h.grant.mockResolvedValue({
      pluginId: NOTION, status: "granted", enabled: true, capabilities: [],
    });
    await clickDoc("plugin-scope-notion:read");
    await clickDoc("plugin-scope-confirm");
    await until(() => h.grant.mock.calls.length > 0);
    await flush();
    expect(h.grant).toHaveBeenCalledTimes(1);
    expect(h.grant.mock.calls[0]).toEqual([WS, NOTION, "notion:read"]);
  });

  it("여러 권한 중 일부가 실패해도 화면은 서버가 지금 말하는 상태와 같다", async () => {
    const el = await openGrantDialog();
    h.grant.mockImplementation(async (_ws: string, _plugin: string, scope: string) => {
      if (scope === "notion:write") throw new ApiError(403, "forbidden");
      // 서버는 읽기 한 권한만 받아들였다: 다음 카탈로그 읽기가 그 사실을 싣는다.
      installNotion(["notion.search"]);
      return { pluginId: NOTION, scope, status: "granted", enabled: true, capabilities: [] };
    });
    await clickDoc("plugin-scope-notion:read");
    await clickDoc("plugin-scope-notion:write");
    await clickDoc("plugin-scope-confirm");
    await until(() => q(el, "plugin-scope-change-result"));
    await until(() => text(el, "plugin-status-mine").includes("notion 읽기 권한"));
    expect(h.grant.mock.calls.map((call) => call[2])).toEqual(["notion:read", "notion:write"]);
    const receipt = text(el, "plugin-scope-change-result");
    expect(receipt).toContain("1개 권한을 허용했어요");
    expect(receipt).toContain("1개는 변경하지 못했어요");
    // 영수증이 아니라 서버 상태가 화면의 사실이다: 쓰기는 허용되지 않았고 읽기만 허용됐다.
    expect(text(el, "plugin-status-mine")).toContain("notion 읽기 권한");
    expect(text(el, "plugin-status-mine")).not.toContain("쓰기 권한");
    expect(text(el, "plugin-detail")).toContain("설치됨 · 내가 허용함");
    // 남은 쓰기 권한은 다시 허용할 수 있다.
    expect(q(el, "plugin-scope-grant")).not.toBeNull();
  });
});

describe("연결 상태 1·2칸이 목록과 상세에서 같다 (U-2)", () => {
  beforeEach(() => h.probe.mockResolvedValue([405, 405]));

  it("미설치(1칸)와 설치됨·내 허용 없음(2칸)", async () => {
    const el = await mount();
    await openDetail(el, NOTION);
    const chipOf = (id: string) => (q(el, `plugin-catalog-${id}`)?.textContent ?? "");
    expect(chipOf(NOTION)).toContain("미설치");
    expect(text(el, "plugin-detail")).toContain("미설치");
    // 설치하고 허용하지 않은 앱: 같은 함수가 목록과 상세에 같은 이름을 준다.
    installNotion([]);
    act(() => root?.unmount());
    host?.remove();
    root = null;
    host = null;
    const second = await mount();
    await openDetail(second, NOTION);
    expect(text(second, `plugin-catalog-${NOTION}`)).toContain("설치됨 · 내 허용 없음");
    expect(text(second, "plugin-detail")).toContain("설치됨 · 내 허용 없음");
  });
});

describe("옛 서버에서는 설치 표면이 없다 (U-2 serverSurfaces 숨김)", () => {
  it("설치·권한 경로가 404인 서버는 관리자에게도 설치·허용 버튼과 동의 창이 없다", async () => {
    installNotion([]);
    h.role = "owner";
    h.probe.mockResolvedValue([404, 404]);
    const el = await mount();
    await openDetail(el, NOTION);
    await until(() => q(el, "plugin-install-closed"));
    expect(writeControls(el)).toEqual([]);
    expect(q(el, "plugin-scope-grant")).toBeNull();
    expect(q(el, "plugin-scope-consent")).toBeNull();
    expect(h.grant).toHaveBeenCalledTimes(0);
  });
});
