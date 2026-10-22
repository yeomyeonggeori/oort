// @vitest-environment jsdom

import { createElement, Fragment } from "react";
import { useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  GITHUB_PANE_PATH,
  GITHUB_PLUGIN_ID,
  type GithubAppStatus,
} from "@momo/core/features/github/model";
import { click, flush, mount, unmount, waitUntil } from "../memory/memoryTestKit";
import { GithubFacesBlock } from "./GithubFaces";
import { q } from "./githubTestKit";

// 「앱」 GitHub 카드에서 앱을 만드는 구역으로 바로 들어간다(#4220). 운영자이고 앱이 아직 없을 때만
// 한 줄이 더 서고, 그 밖의 사람들의 카드는 이전과 바이트까지 같다.

const api = vi.hoisted(() => ({ fetchGithubAppStatus: vi.fn() }));
vi.mock("@momo/core/features/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/github/api")>();
  return { ...actual, ...api };
});
vi.mock("@momo/core/features/capabilities/serverSurfaces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/capabilities/serverSurfaces")>();
  return {
    ...actual,
    isSurfaceProvided: (id: Parameters<typeof actual.isSurfaceProvided>[0]) =>
      id === "githubNotifications" ? true : actual.isSurfaceProvided(id),
  };
});

const UNREGISTERED: GithubAppStatus = {
  masterKeyConfigured: true,
  publicAddressConfigured: true,
  configured: false,
  app: null,
  permissions: [{ name: "metadata", access: "read" }],
  events: ["pull_request"],
};
const REGISTERED: GithubAppStatus = {
  ...UNREGISTERED,
  configured: true,
  app: {
    appId: 7,
    slug: "oort-yeomyeonggeori",
    clientId: "Iv1.abc",
    ownerLogin: "yeomyeonggeori",
    ownerType: "Organization",
    source: "manifest",
    createdAtMs: 1_800_000_000_000,
    rotationWindowOpen: false,
    installUrl: "https://github.com/apps/oort-yeomyeonggeori/installations/new",
  },
};

function Probe() {
  return createElement("output", { "data-testid": "path" }, useLocation().pathname);
}

async function renderCard(): Promise<HTMLElement> {
  const { host } = mount(createElement(Fragment, null, createElement(GithubFacesBlock, { pluginId: GITHUB_PLUGIN_ID }), createElement(Probe)));
  await flush();
  return host;
}

beforeEach(() => {
  api.fetchGithubAppStatus.mockReset();
});
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

describe("「앱」 GitHub 카드: 운영자 진입", () => {
  it("운영자이고 앱이 아직 없으면 「GitHub 앱 만들기」가 서고, 누르면 GitHub 구역으로 간다", async () => {
    api.fetchGithubAppStatus.mockResolvedValue(UNREGISTERED);
    await renderCard();
    await waitUntil(() => q("github-faces-operator") !== null, "운영자 진입");
    expect(q("github-faces-operator")?.textContent).toContain("이 서버에는 아직 GitHub 앱이 없어요.");
    const create = q("github-faces-create") as HTMLAnchorElement;
    expect(create.textContent).toBe("GitHub 앱 만들기");
    expect(q("path")?.textContent).toBe("/");
    click(create);
    expect(q("path")?.textContent).toBe(GITHUB_PANE_PATH);
  });

  it("알림 얼굴의 「GitHub 알림 열기」 길은 그대로 있다", async () => {
    api.fetchGithubAppStatus.mockResolvedValue(UNREGISTERED);
    await renderCard();
    await waitUntil(() => q("github-faces-operator") !== null, "운영자 진입");
    expect(q("github-faces-open")?.textContent).toBe("GitHub 알림 열기");
  });

  it("앱이 이미 있으면 한 줄이 서지 않는다", async () => {
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    await renderCard();
    await flush();
    expect(api.fetchGithubAppStatus).toHaveBeenCalledTimes(1);
    expect(q("github-faces-operator")).toBeNull();
    expect(q("github-faces-open")).not.toBeNull();
  });

  it.each([
    ["운영자가 아니다(403)", new ApiError(403, "forbidden")],
    ["이 서버에 표면이 없다(404)", new ApiError(404, "not found")],
    ["마스터키가 없다(503)", new ApiError(503, "unavailable")],
    ["읽기가 실패했다(500)", new ApiError(500, "boom")],
  ])("%s: 카드가 읽기 전과 바이트까지 같다", async (_name, error) => {
    // 읽기가 끝나지 않은 카드(= 이 기능이 생기기 전과 같은 모양)를 기준선으로 잡는다.
    api.fetchGithubAppStatus.mockReturnValue(new Promise(() => undefined));
    const pending = (await renderCard()).innerHTML;
    unmount();
    document.body.innerHTML = "";

    api.fetchGithubAppStatus.mockRejectedValue(error);
    const host = await renderCard();
    await flush();
    expect(api.fetchGithubAppStatus).toHaveBeenCalled();
    // 이 단정이 「운영자가 아닌 사람에게도 한 줄을 그리면 빨개지는」 사보타주 대상이다.
    expect(q("github-faces-operator")).toBeNull();
    expect(host.innerHTML).toBe(pending);
  });
});
