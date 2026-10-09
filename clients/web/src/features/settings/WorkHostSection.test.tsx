// @vitest-environment jsdom

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { WorkHost, WorkTierPolicy } from "@momo/core/features/settings/api";

// =============================================================================
// #3578 S4 설정 > 실행 호스트. 사보타주로 붉어지는 규율:
//   ① 「실행 엔진」 선택이 다시 서면 (화면에도, 호출에도, 캡처 스텁에도)
//   ② 남의 개인 맥이 이름 밖의 것(상태·ID 복사)까지 보이면
//   ③ 워크스페이스 기본 재개 정책 카드가 내 정책 저장을 들고 있으면(범위가 섞이면)
//   ④ 소유자 아닌 사람이 403 대신 저장이 항상 실패하는 폼을 받으면
// =============================================================================

const WS = "0f8fad5b-d9cb-469f-a165-70867728950e";
const ME = "m-me";
const OTHER = "m-other";

const api = vi.hoisted(() => ({
  listWorkHosts: vi.fn(),
  fetchWorkTierPolicy: vi.fn(),
  putWorkTierPolicy: vi.fn(),
}));
vi.mock("@momo/core/features/settings/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/settings/api")>()),
  ...api,
}));
vi.mock("@/lib/tauri", () => ({ isDesktop: () => false }));

import { WorkHostSection } from "./WorkHostSection";

function host(over: Partial<WorkHost> = {}): WorkHost {
  return {
    id: "019a0000-0000-7000-8000-000000aaaaaa",
    workspaceId: WS,
    scope: "workspace",
    ownerMemberId: OTHER,
    type: "workd",
    displayName: "빌드 서버",
    publicKey: "PK",
    capabilities: {},
    createdAtMs: 1,
    online: true,
    lastSeenAtMs: Date.now() - 60_000,
    ...over,
  };
}

function policy(over: Partial<WorkTierPolicy> = {}): WorkTierPolicy {
  return { workspaceId: WS, mode: "ask", inherited: false, ...over };
}

let root: Root;
let container: HTMLDivElement;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listWorkHosts.mockResolvedValue([]);
  api.fetchWorkTierPolicy.mockResolvedValue(policy());
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(offline = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(WorkHostSection, { workspaceId: WS, memberId: ME, offline })
      )
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe("실행 엔진은 이 화면에 없다 (#3578 S4, ADR-0198 D4)", () => {
  it("화면에 엔진 선택도 엔진 문장도 없다", async () => {
    await render();
    expect(container.textContent).not.toContain("실행 엔진");
    expect(container.textContent).not.toContain("opencode");
    expect(container.textContent).not.toContain("codex-local");
    expect(container.querySelector(`input[name="${"work-host-" + "engine"}"]`)).toBeNull();
  });

  it("엔진 API·상수·캡처 스텁이 코드 어디에도 다시 서지 않는다", () => {
    // 이름을 이어 붙여 적는 이유: 이 파일이 스스로를 잡지 않게 한다.
    const needles = [
      "work-host-" + "engine",
      "fetchWorkHost" + "Engine",
      "putWorkHost" + "Engine",
      "WORK_" + "ENGINES",
    ];
    // vitest는 clients/web에서 돈다(DevicesSection.test도 상대 경로로 소스를 읽는다).
    const web = process.cwd();
    const core = join(web, "../../packages/momo-core/src");
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "artifacts" || entry.name === "evidence")
          return [];
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return walk(path);
        return /\.(ts|tsx|mjs|js)$/.test(entry.name) ? [path] : [];
      });
    const files = [
      ...walk(join(web, "src")),
      ...walk(join(web, "scripts")),
      ...walk(join(web, "gates")),
      ...walk(core),
    ];
    // 하나도 안 걸리는 순회는 공허하게 초록이다: 이 파일들이 실제로 읽힌다.
    expect(files.length).toBeGreaterThan(200);
    const hits: string[] = [];
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const needle of needles) if (text.includes(needle)) hits.push(`${path}: ${needle}`);
    }
    expect(hits).toEqual([]);
  });
});

describe("등록된 호스트: 남의 개인 맥은 이름만", () => {
  it("내 호스트와 워크스페이스 공용은 상태·ID·복사를 갖고, 남의 개인 맥은 이름만 갖는다", async () => {
    api.listWorkHosts.mockResolvedValue([
      host({ id: "019a0000-0000-7000-8000-00000000aa01", displayName: "빌드 서버", scope: "workspace" }),
      host({ id: "019a0000-0000-7000-8000-00000000bb02", displayName: "내 맥북", scope: "member", ownerMemberId: ME }),
      host({ id: "019a0000-0000-7000-8000-00000000cc03", displayName: "동료의 맥", scope: "member", ownerMemberId: OTHER }),
    ]);
    await render();
    const rows = all("work-host-row");
    expect(rows).toHaveLength(3);
    const other = rows.find((row) => row.textContent?.includes("동료의 맥"));
    expect(other?.getAttribute("data-host-status")).toBe("other-personal");
    expect(other?.textContent).toContain("다른 멤버의 개인 호스트예요.");
    expect(other?.querySelector('[data-testid="work-host-copy-id"]')).toBeNull();
    expect(other?.textContent).not.toContain("cc03");
    expect(other?.textContent).not.toContain("온라인");
    for (const name of ["빌드 서버", "내 맥북"]) {
      const row = rows.find((r) => r.textContent?.includes(name));
      expect(row?.querySelector('[data-testid="work-host-copy-id"]'), name).not.toBeNull();
      expect(row?.getAttribute("data-host-status")).not.toBe("other-personal");
    }
    // 남의 맥은 「사용 가능」 수에 들지 않는다: 둘(빌드 서버, 내 맥북)만 센다.
    expect(byTestId("work-host-count")?.textContent?.replace(/\s+/g, " ")).toContain("사용 가능 2");
  });

  it("등록이 비면 데스크톱 앱의 「기기」를 가리키고 다시 불러오기 하나를 건넨다", async () => {
    await render();
    expect(byTestId("work-hosts-empty")?.textContent).toContain("설정 「기기」에서 이 맥을 등록하면");
    expect(byTestId("work-hosts-refresh")).not.toBeNull();
  });

  it("목록 403은 재시도 없는 안내, 그 밖의 실패는 재시도 한 번", async () => {
    api.listWorkHosts.mockRejectedValue(new ApiError(403, "forbidden"));
    await render();
    expect(byTestId("operator-notice")?.textContent).toContain("멤버만 볼 수 있어요");
    expect(byTestId("work-hosts-error")).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    api.listWorkHosts.mockRejectedValue(new ApiError(500, "boom"));
    await render();
    expect(byTestId("work-hosts-error")).not.toBeNull();
  });
});

describe("재개 정책: 이 화면은 워크스페이스 기본만 쥔다", () => {
  it("저장 단추는 워크스페이스 하나이고 내 정책 저장은 없다", async () => {
    await render();
    expect(byTestId("work-tier-save-workspace")).not.toBeNull();
    expect(byTestId("work-tier-save-member")).toBeNull();
    expect(api.fetchWorkTierPolicy).toHaveBeenCalledWith(WS, "workspace");
    expect(api.fetchWorkTierPolicy).not.toHaveBeenCalledWith(WS, "member");
  });

  it("소유자·관리자가 아니면 403이고, 저장이 항상 실패하는 폼 대신 한 줄을 본다", async () => {
    api.fetchWorkTierPolicy.mockRejectedValue(new ApiError(403, "forbidden"));
    await render();
    expect(byTestId("work-tier-save-workspace")).toBeNull();
    expect(byTestId("work-tier-workspace-denied")?.textContent).toContain("소유자나 관리자만");
  });

  it("고른 값은 저장 단추를 눌러야 서버로 간다", async () => {
    api.putWorkTierPolicy.mockResolvedValue(policy({ mode: "t1_only" }));
    await render();
    const radio = container.querySelector<HTMLInputElement>('input[name="work-tier-mode-workspace"]:not(:checked)');
    expect(radio).not.toBeNull();
    await act(async () => {
      radio!.click();
    });
    expect(api.putWorkTierPolicy).not.toHaveBeenCalled();
    await act(async () => {
      byTestId("work-tier-save-workspace")!.click();
    });
    expect(api.putWorkTierPolicy).toHaveBeenCalledTimes(1);
    expect(api.putWorkTierPolicy.mock.calls[0]?.[1]).toBe("workspace");
  });
});
