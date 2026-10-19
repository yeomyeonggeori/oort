// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GITHUB_PANE_PATH } from "@momo/core/features/github/model";
import { click, flush } from "../memory/memoryTestKit";
import { GithubPane } from "./GithubPane";
import { GithubReturnLanding } from "./GithubReturnLanding";
import { GH_WS, overview, q } from "./githubTestKit";

const api = vi.hoisted(() => ({
  fetchGithubOverview: vi.fn(),
  fetchGithubAppStatus: vi.fn(),
  listUnlinkedInstallations: vi.fn(),
}));
vi.mock("@momo/core/features/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/github/api")>();
  return { ...actual, ...api };
});
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return { ...actual, useChannels: () => ({ groups: { channels: [], dms: [] } }) };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  api.fetchGithubOverview.mockResolvedValue(overview());
  api.fetchGithubAppStatus.mockRejectedValue(Object.assign(new Error("x"), { status: 403 }));
  api.listUnlinkedInstallations.mockResolvedValue([]);
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  window.history.replaceState(null, "", "/");
});

async function mountAtSearch(search: string) {
  window.history.replaceState(null, "", `/${search}`);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: ["/"] },
          createElement(GithubReturnLanding),
          createElement(
            Routes,
            null,
            createElement(Route, { path: "/", element: createElement("div", { "data-testid": "home" }) }),
            createElement(Route, {
              path: GITHUB_PANE_PATH,
              element: createElement(GithubPane, { workspaceId: GH_WS, memberId: "m1", offline: false }),
            })
          )
        )
      )
    )
  );
  await flush();
  await flush();
}

describe("GitHub 에서 돌아오는 문", () => {
  it("설치가 끝난 단어는 GitHub 알림 화면으로 가서 문장이 되고, 주소에서는 지워진다", async () => {
    await mountAtSearch("?githubInstall=linked&keep=1");
    expect(q("github-pane")).not.toBeNull();
    const banner = q("github-return");
    expect(banner?.textContent).toContain("GitHub 계정이 이 워크스페이스에 연결됐어요");
    expect(banner?.getAttribute("role")).toBe("status");
    // 새로고침이 같은 말을 되풀이하지 않게 단어만 지우고 나머지는 남긴다.
    expect(window.location.search).toBe("?keep=1");
  });

  it("state_missing 은 운영자가 붙이는 길을 말한다", async () => {
    await mountAtSearch("?githubInstall=state_missing");
    expect(q("github-return")?.textContent).toContain("연결 안 된 설치");
  });

  it("막힌 단어는 alert 이고 닫으면 사라진다", async () => {
    await mountAtSearch("?githubInstall=state_invalid");
    expect(q("github-return")?.getAttribute("role")).toBe("alert");
    expect(q("github-return")?.textContent).toContain("다시 눌러 주세요");
    click(q("github-return-dismiss"));
    expect(q("github-return")).toBeNull();
  });

  it("linked_elsewhere 는 막힌 단어로 돌아와 다른 워크스페이스에 연결됐다고 말한다", async () => {
    await mountAtSearch("?githubInstall=linked_elsewhere");
    const banner = q("github-return");
    expect(banner?.getAttribute("data-return-word")).toBe("linked_elsewhere");
    expect(banner?.getAttribute("role")).toBe("alert");
    expect(banner?.textContent).toContain("이미 다른 워크스페이스에 연결돼 있어요");
    expect(banner?.textContent).toContain("한 계정은 한 워크스페이스에만");
    expect(window.location.search).toBe("");
  });

  it("앱 등록의 단어도 같은 문으로 들어온다", async () => {
    await mountAtSearch("?githubApp=convert_code_rejected");
    expect(q("github-return")?.textContent).toContain("등록 코드를 받아 주지 않았어요");
  });

  it("모르는 단어와 단어 없는 주소는 아무 데도 보내지 않는다", async () => {
    await mountAtSearch("?githubInstall=<script>");
    expect(q("home")).not.toBeNull();
    expect(q("github-return")).toBeNull();
    expect(window.location.search).toBe("?githubInstall=%3Cscript%3E");
  });

  it("단어가 없는 주소는 그냥 첫 화면이다", async () => {
    await mountAtSearch("");
    expect(q("home")).not.toBeNull();
  });
});
