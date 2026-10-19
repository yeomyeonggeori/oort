// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  GITHUB_DOWNTIME_SENTENCE,
  GITHUB_RECEIVE_FAILED_SENTENCE,
  type GithubAppStatus,
} from "@momo/core/features/github/model";
import { click, flush, mount, type as typeInto, unmount, waitUntil } from "../memory/memoryTestKit";
import { GithubPane } from "./GithubPane";
import { GH_PUBLIC_CH, GH_WS, overview, q } from "./githubTestKit";

const api = vi.hoisted(() => ({
  fetchGithubOverview: vi.fn(),
  fetchGithubAppStatus: vi.fn(),
  listUnlinkedInstallations: vi.fn(),
  startGithubManifest: vi.fn(),
  startGithubLink: vi.fn(),
  linkInstallationToWorkspace: vi.fn(),
  pasteGithubApp: vi.fn(),
  unsubscribeGithub: vi.fn(),
}));
vi.mock("@momo/core/features/github/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/features/github/api")>();
  return { ...actual, ...api };
});
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({
      groups: {
        channels: [{ id: "00000000-0000-7000-8000-000000000201", workspaceId: "w", kind: "public", name: "마케팅", muted: false }],
        dms: [],
      },
    }),
  };
});
const desktop = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, isDesktop: () => desktop.on, openExternalUrl: vi.fn() };
});

const STATUS_BASE: GithubAppStatus = {
  masterKeyConfigured: true,
  publicAddressConfigured: true,
  configured: false,
  app: null,
  permissions: [
    { name: "metadata", access: "read" },
    { name: "issues", access: "read" },
    { name: "pull_requests", access: "read" },
    { name: "checks", access: "read" },
    { name: "contents", access: "read" },
  ],
  events: ["pull_request"],
};
const REGISTERED: GithubAppStatus = {
  ...STATUS_BASE,
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

beforeEach(() => {
  desktop.on = false;
  for (const fn of Object.values(api)) fn.mockReset();
  api.fetchGithubOverview.mockResolvedValue(overview());
  api.fetchGithubAppStatus.mockResolvedValue(STATUS_BASE);
  api.listUnlinkedInstallations.mockResolvedValue([]);
  api.unsubscribeGithub.mockResolvedValue(undefined);
});
afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

async function render(state?: unknown) {
  mount(createElement(GithubPane, { workspaceId: GH_WS, memberId: "m1", offline: false }), {
    role: "owner",
    ...(state === undefined ? {} : { route: "/" }),
  });
  await flush();
}

describe("운영자 구역", () => {
  it("앱이 없으면 만들기 폼이 서고, 조직은 이름을 검사한다", async () => {
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    // 조직 이름이 비면 요청이 나가지 않는다.
    click(q("github-register-start"));
    await flush();
    expect(api.startGithubManifest).toHaveBeenCalledTimes(0);
    expect(document.body.textContent).toContain("조직 이름은 영문, 숫자, 하이픈");
  });

  it("조직 이름을 적으면 소유자 선택을 그대로 서버에 보내고 GitHub 로 가는 폼을 세운다", async () => {
    api.startGithubManifest.mockResolvedValue({
      registrationUrl: "https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=s1",
      manifest: { name: "oort-yeomyeonggeori", default_permissions: { contents: "read" } },
      expiresInSeconds: 3600,
    });
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    typeInto(q<HTMLInputElement>("github-org-input"), "yeomyeonggeori");
    click(q("github-register-start"));
    await waitUntil(() => q("github-manifest-handoff") !== null, "넘김 폼");
    expect(api.startGithubManifest).toHaveBeenCalledWith({ ownerType: "organization", organization: "yeomyeonggeori" });
    const form = q<HTMLFormElement>("github-manifest-handoff");
    expect(form?.getAttribute("action")).toBe(
      "https://github.com/organizations/yeomyeonggeori/settings/apps/new?state=s1"
    );
    expect(form?.getAttribute("method")).toBe("post");
    const hidden = form?.querySelector<HTMLInputElement>('input[name="manifest"]');
    expect(JSON.parse(hidden?.value ?? "{}")).toMatchObject({ name: "oort-yeomyeonggeori" });
    expect(form?.textContent).toContain("60분 안에");
  });

  it("공개 주소가 없으면 「GitHub 수신 실패」 줄이 서고 만들기는 요청을 보내지 않는다", async () => {
    api.fetchGithubAppStatus.mockResolvedValue({ ...STATUS_BASE, publicAddressConfigured: false });
    await render();
    await waitUntil(() => q("github-receive-failed") !== null, "수신 실패 줄");
    const line = q("github-receive-failed")?.textContent ?? "";
    expect(line).toContain("GitHub 수신 실패");
    expect(line).toContain(GITHUB_RECEIVE_FAILED_SENTENCE);
    expect(line).toContain(GITHUB_DOWNTIME_SENTENCE);
    typeInto(q<HTMLInputElement>("github-org-input"), "yeomyeonggeori");
    click(q("github-register-start"));
    await flush();
    expect(api.startGithubManifest).toHaveBeenCalledTimes(0);
  });

  it("등록된 앱인데 공개 주소가 없어도 같은 줄이 서고, 있으면 받을 수 있다고 말한다", async () => {
    api.fetchGithubAppStatus.mockResolvedValue({ ...REGISTERED, publicAddressConfigured: false });
    await render();
    await waitUntil(() => q("github-app-registered") !== null, "등록된 앱");
    expect(q("github-receive-failed")).not.toBeNull();
    expect(q("github-receive-ok")).toBeNull();
    unmount();
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    await render();
    await waitUntil(() => q("github-receive-ok") !== null, "받을 수 있음");
    expect(q("github-receive-failed")).toBeNull();
    // 다운 중 이벤트가 사라진다는 사실을 숨기지 않는다.
    expect(q("github-receive-ok")?.textContent).toContain("사라지고");
    expect(q("github-app-registered")?.textContent).toContain("코드(contents)");
    expect(q("github-app-registered")?.textContent).toContain("쓰기 권한은 없어요");
  });

  it("데스크탑 셸에서는 POST 폼을 열 수 없다고 정직하게 말한다", async () => {
    desktop.on = true;
    api.startGithubManifest.mockResolvedValue({
      registrationUrl: "https://github.com/settings/apps/new?state=s",
      manifest: { name: "x" },
      expiresInSeconds: 3600,
    });
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    typeInto(q<HTMLInputElement>("github-org-input"), "acme");
    click(q("github-register-start"));
    await waitUntil(() => q("github-manifest-desktop") !== null, "데스크탑 안내");
    expect(q("github-manifest-handoff")).toBeNull();
  });

  it("운영자가 아니면(403) 이 구역은 비어 있고 워크스페이스 구역만 선다", async () => {
    api.fetchGithubAppStatus.mockRejectedValue(new ApiError(403, "forbidden"));
    await render();
    await waitUntil(() => q("github-workspace") !== null && q("github-installations") !== null, "워크스페이스 구역");
    expect(q("github-operator")).toBeNull();
    expect(q("github-app-register")).toBeNull();
  });

  it("연결 안 된 설치를 이 워크스페이스에 붙인다(두 단계)", async () => {
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    api.listUnlinkedInstallations.mockResolvedValue([
      {
        installationId: 9001,
        accountLogin: "dawn-labs",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
        repositoryCount: 3,
      },
    ]);
    api.linkInstallationToWorkspace.mockResolvedValue(undefined);
    await render();
    await waitUntil(() => q("github-unlinked-row") !== null, "연결 안 된 설치");
    expect(q("github-unlinked-row")?.textContent).toContain("저장소 3개");
    click(q("github-unlinked-attach"));
    expect(api.linkInstallationToWorkspace).toHaveBeenCalledTimes(0);
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent === "붙이기");
    click(confirm ?? null);
    await flush();
    expect(api.linkInstallationToWorkspace).toHaveBeenCalledWith(9001, GH_WS);
  });

  it("다른 워크스페이스에 이미 붙은 설치는 코드로 알아본 문장으로 말한다", async () => {
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    api.listUnlinkedInstallations.mockResolvedValue([
      { installationId: 9001, accountLogin: "dawn-labs", accountType: "User", repositorySelection: "all", suspended: false, repositoryCount: 0 },
    ]);
    api.linkInstallationToWorkspace.mockRejectedValue(new ApiError(409, "wording", "github_installation_linked_elsewhere"));
    await render();
    await waitUntil(() => q("github-unlinked-row") !== null, "행");
    click(q("github-unlinked-attach"));
    click([...document.querySelectorAll("button")].find((button) => button.textContent === "붙이기") ?? null);
    await waitUntil(() => q("github-unlinked-attach-error") !== null, "오류");
    expect(q("github-unlinked-attach-error")?.textContent).toContain("이미 다른 워크스페이스에 연결돼 있어요");
  });
});

describe("워크스페이스 구역", () => {
  it("앱이 없는 서버는 운영자가 먼저 만들어야 한다고 말한다", async () => {
    api.fetchGithubOverview.mockResolvedValue(overview({ appRegistered: false, installations: [] }));
    await render();
    await waitUntil(() => q("github-no-app") !== null, "앱 없음");
    expect(q("github-link-start")).toBeNull();
  });

  it("연결 시작은 설치 주소를 받아 GitHub 로 가는 링크를 세운다(자동 이동 없음)", async () => {
    api.fetchGithubOverview.mockResolvedValue(overview({ installations: [] }));
    api.startGithubLink.mockResolvedValue({
      installUrl: "https://github.com/apps/oort/installations/new?state=tok",
      expiresInSeconds: 600,
    });
    await render();
    await waitUntil(() => q("github-link-start") !== null, "연결 버튼");
    click(q("github-link-start"));
    await waitUntil(() => q("github-link-open") !== null, "링크");
    expect(q<HTMLAnchorElement>("github-link-open")?.getAttribute("href")).toBe(
      "https://github.com/apps/oort/installations/new?state=tok"
    );
    expect(q("github-link-ready")?.textContent).toContain("10분 안에");
  });

  it("공개 주소가 없는 서버가 409 코드로 막으면 같은 문장을 말한다", async () => {
    api.fetchGithubOverview.mockResolvedValue(overview({ installations: [] }));
    api.startGithubLink.mockRejectedValue(new ApiError(409, "x", "public_address_required"));
    await render();
    await waitUntil(() => q("github-link-start") !== null, "연결 버튼");
    click(q("github-link-start"));
    await waitUntil(() => q("github-link-error") !== null, "오류");
    expect(q("github-link-error")?.textContent).toContain(GITHUB_RECEIVE_FAILED_SENTENCE);
  });

  it("설치 권고(선택한 저장소만)와 권한 문장이 연결 곁에 선다", async () => {
    await render();
    await waitUntil(() => q("github-installations") !== null, "설치 목록");
    expect(q("github-workspace")?.textContent).toContain("「선택한 저장소만」을 고르길 권해요");
    expect(q("github-workspace")?.textContent).toContain("쓰기 권한은 없어요");
  });

  it("구독 목록은 채널 이름을 달고, 구독이 없으면 채널 메뉴로 가라고 말한다", async () => {
    api.fetchGithubOverview.mockResolvedValue(
      overview({
        subscriptions: [
          {
            id: "s1",
            channelId: GH_PUBLIC_CH,
            installationId: 4001,
            repository: "yeomyeonggeori/oort",
            repoId: 11,
            features: ["pulls"],
            active: true,
            privateConfirmed: false,
          },
        ],
      })
    );
    await render();
    await waitUntil(() => q("github-subscriptions") !== null, "구독 목록");
    expect(q("github-subscription-row")?.textContent).toContain("마케팅");
    unmount();
    api.fetchGithubOverview.mockResolvedValue(overview());
    await render();
    await waitUntil(() => q("github-no-subscription") !== null, "빈 상태");
    expect(q("github-no-subscription")?.textContent).toContain("⋮ 메뉴");
  });

  it("옛 서버(404)와 키 없는 서버(503)는 화면 전체가 한 문장으로 접힌다", async () => {
    api.fetchGithubOverview.mockRejectedValue(new ApiError(404, "x"));
    await render();
    await waitUntil(() => q("github-pane-load-absent") !== null, "접힘");
    expect(q("github-operator")).toBeNull();
    unmount();
    api.fetchGithubOverview.mockRejectedValue(new ApiError(503, "x"));
    await render();
    await waitUntil(() => q("github-pane-unavailable") !== null, "503");
    expect(document.body.textContent).toContain("서버를 관리하는 분께 알려 주세요");
  });

  it("읽기 실패는 다시 시도를 준다", async () => {
    api.fetchGithubOverview.mockRejectedValueOnce(new ApiError(500, "x"));
    api.fetchGithubOverview.mockResolvedValue(overview());
    await render();
    await waitUntil(() => q("github-load-failure") !== null, "오류");
    click([...document.querySelectorAll("button")].find((button) => button.textContent === "다시 시도") ?? null);
    await waitUntil(() => q("github-installations") !== null, "다시 읽음");
  });
});
