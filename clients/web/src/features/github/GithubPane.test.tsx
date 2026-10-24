// @vitest-environment jsdom

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import {
  GITHUB_DOWNTIME_SENTENCE,
  GITHUB_IDENTITY_CHECK_SENTENCE,
  GITHUB_ORG_EXAMPLE,
  GITHUB_RECEIVE_FAILED_SENTENCE,
  type GithubAppStatus,
} from "@momo/core/features/github/model";
import { act } from "react";
import { click, flush, mount, type as typeInto, unmount, waitUntil } from "../memory/memoryTestKit";
import { GithubPane } from "./GithubPane";
import { GH_PUBLIC_CH, GH_WS, overview, q } from "./githubTestKit";
import { GITHUB_APP_CALLBACK_PATH, GITHUB_HANDOFF_PATH, readGithubHandoff } from "./handoff";

const api = vi.hoisted(() => ({
  fetchGithubOverview: vi.fn(),
  fetchGithubAppStatus: vi.fn(),
  listUnlinkedInstallations: vi.fn(),
  startGithubManifest: vi.fn(),
  startGithubLink: vi.fn(),
  linkInstallationToWorkspace: vi.fn(),
  pasteGithubApp: vi.fn(),
  unsubscribeGithub: vi.fn(),
  subscribeGithub: vi.fn(),
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
const desktop = vi.hoisted(() => ({ on: false, open: vi.fn() }));
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return { ...actual, isDesktop: () => desktop.on, openExternalUrl: (url: string) => desktop.open(url) };
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
  desktop.open.mockReset();
  desktop.open.mockResolvedValue(true);
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
    expect(document.body.textContent).toContain("조직 이름을 적어 주세요.");
  });

  it("조직 이름 칸의 예시 글자는 값이 아니라 「예: …」이고, 오류는 예시를 되풀이하지 않는다 (#4333)", async () => {
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    const input = q<HTMLInputElement>("github-org-input") as HTMLInputElement;
    // 값은 비어 있고, 예시는 「예: 」로 시작해 입력값처럼 보이지 않는다.
    expect(input.value).toBe("");
    expect(input.placeholder).toBe(`예: ${GITHUB_ORG_EXAMPLE}`);
    click(q("github-register-start"));
    await flush();
    const empty = q("github-app-register")?.textContent ?? "";
    expect(empty).not.toContain("yeomyeonggeori");
    expect(empty).not.toContain("영문, 숫자, 하이픈으로 적어 주세요. 예:");
    // 주소를 통째로 붙여 넣으면 무엇이 틀렸는지 말하고 요청은 나가지 않는다.
    typeInto(input, "github.com/dalmuri");
    click(q("github-register-start"));
    await flush();
    expect(api.startGithubManifest).toHaveBeenCalledTimes(0);
    expect(document.body.textContent).toContain("「.」은 쓸 수 없어요");
    expect(document.body.textContent).not.toContain("조직 이름을 적어 주세요.");
    // 고치면 오류가 사라지고 시작 요청이 나간다.
    api.startGithubManifest.mockResolvedValue({
      registrationUrl: "https://github.com/organizations/dalmuri/settings/apps/new?state=s2",
      manifest: { name: "oort-team" },
      expiresInSeconds: 3600,
    });
    typeInto(input, "dalmuri");
    expect(document.body.textContent).not.toContain("쓸 수 없어요");
    click(q("github-register-start"));
    await waitUntil(() => api.startGithubManifest.mock.calls.length === 1, "시작 요청");
    expect(api.startGithubManifest).toHaveBeenCalledWith({ ownerType: "organization", organization: "dalmuri" });
  });

  it("권한 문장은 코드 읽기를 받는 까닭을 말하고, 본인 확인 예고가 만들기 앞에 선다 (#4333)", async () => {
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    const text = q("github-app-register")?.textContent ?? "";
    expect(text).toContain("push·release 알림을 받으려는 것이고");
    expect(text).not.toContain("코드는 읽지 않아요");
    expect(q("github-identity-notice")?.textContent).toBe(GITHUB_IDENTITY_CHECK_SENTENCE);
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
    expect(form?.textContent).toContain(GITHUB_IDENTITY_CHECK_SENTENCE);
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
    expect(q("github-app-registered")?.textContent).toContain("등록됨");
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
            needsReconfirm: false,
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

  it("다시 확인 필요 구독은 허브에서도 확인한 뒤에만 confirmPrivate 로 다시 구독한다", async () => {
    const stale = {
      id: "s1",
      channelId: GH_PUBLIC_CH,
      installationId: 4001,
      repository: "yeomyeonggeori/oort",
      repoId: 11,
      features: ["pulls", "releases"],
      active: true,
      privateConfirmed: false,
      needsReconfirm: true,
    };
    api.fetchGithubOverview.mockResolvedValue(overview({ subscriptions: [stale] }));
    api.subscribeGithub.mockResolvedValue({ ...stale, needsReconfirm: false });
    await render();
    await waitUntil(() => q("github-subscription-reconfirm") !== null, "다시 확인 버튼");
    expect(q("github-subscription-row")?.textContent).toContain("다시 확인 필요");
    click(q("github-subscription-reconfirm"));
    expect(api.subscribeGithub).toHaveBeenCalledTimes(0);
    expect(q("github-subscription-row")?.textContent).toContain("마케팅 채널이 공개 채널이 됐어요");
    click(q("github-subscription-reconfirm-confirm"));
    await flush();
    expect(api.subscribeGithub).toHaveBeenCalledWith(GH_WS, {
      channelId: GH_PUBLIC_CH,
      installationId: 4001,
      repository: "yeomyeonggeori/oort",
      features: ["pulls", "releases"],
      confirmPrivate: true,
    });
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

// ---- 데스크탑 셸 (#4220) -------------------------------------------------------------------------
// 셸에는 GitHub 로 POST 하는 폼을 열 길이 없다. 「GitHub 앱 만들기」 한 번이 기본 브라우저 열기이고,
// 브라우저에서 돌아오면 창 포커스가 상태를 다시 읽는다.

const PUBLIC_ORIGIN = "https://oort.yeomyeonggeori.test";
const HANDOFF_STATE = `00000000-0000-7000-8000-000000000001.${"7e1b".repeat(16)}`;

function manifestStart(origin = PUBLIC_ORIGIN, expiresInSeconds = 3600) {
  return {
    registrationUrl: `https://github.com/organizations/acme/settings/apps/new?state=${HANDOFF_STATE}`,
    manifest: {
      name: "oort-oort-yeomyeonggeori-test",
      url: origin,
      hook_attributes: { url: `${origin}/v1/integrations/github/webhook`, active: true },
      redirect_url: `${origin}${GITHUB_APP_CALLBACK_PATH}`,
      setup_url: `${origin}/v1/integrations/github/setup`,
      public: false,
      default_permissions: { metadata: "read", issues: "read", pull_requests: "read", checks: "read", contents: "read" },
    },
    expiresInSeconds,
  };
}

async function startOnDesktop(start = manifestStart()) {
  desktop.on = true;
  api.startGithubManifest.mockResolvedValue(start);
  await render();
  await waitUntil(() => q("github-app-register") !== null, "등록 폼");
  typeInto(q<HTMLInputElement>("github-org-input"), "acme");
  click(q("github-register-start"));
  await waitUntil(() => q("github-manifest-browser") !== null || q("github-manifest-browser-unavailable") !== null, "브라우저 카드");
}

function focusReturns(): void {
  act(() => {
    window.dispatchEvent(new Event("focus"));
  });
}

describe("운영자 구역: 데스크탑 셸은 기본 브라우저로 GitHub 앱을 만든다", () => {
  it("「GitHub 앱 만들기」 한 번이 곧 브라우저 열기이고 막다른 문장이 없다", async () => {
    await startOnDesktop();
    expect(api.startGithubManifest).toHaveBeenCalledWith({ ownerType: "organization", organization: "acme" });
    expect(desktop.open).toHaveBeenCalledTimes(1);
    const url = String(desktop.open.mock.calls[0][0]);
    // 이 단정들이 「데스크탑 분기가 다시 막다른 문장을 그리면 빨개지는」 사보타주 대상이다.
    expect(q("github-manifest-desktop")).toBeNull();
    expect(q("github-manifest-handoff")).toBeNull();
    expect(document.body.textContent).not.toContain("열 수 없어요");
    expect(document.body.textContent).not.toContain("웹 브라우저로 이 서버에 들어와");
    expect(q("github-manifest-browser")?.textContent).toContain("기본 브라우저에서 GitHub를 열었어요.");
    expect(q("github-manifest-browser")?.textContent).toContain("60분 안에 마쳐야 해요");
    expect(q("github-manifest-browser")?.textContent).toContain(GITHUB_IDENTITY_CHECK_SENTENCE);
    expect(url.startsWith(`${PUBLIC_ORIGIN}${GITHUB_HANDOFF_PATH}#`)).toBe(true);
  });

  it("열리는 주소는 서버의 공개 오리진이고 state 는 쿼리가 아니라 조각에만 있다", async () => {
    await startOnDesktop();
    const url = String(desktop.open.mock.calls[0][0]);
    const parsed = new URL(url);
    // 이 단정들이 「핸드오프가 state 를 쿼리스트링으로 흘리면 빨개지는」 사보타주 대상이다.
    expect(parsed.search).toBe("");
    expect(url.split("#")[0]).not.toContain(HANDOFF_STATE);
    expect(url).not.toContain("state=");
    // 받는 쪽이 이 주소로 같은 등록 주소와 매니페스트를 읽는다.
    const read = readGithubHandoff(parsed.hash, PUBLIC_ORIGIN);
    expect(read.ok && read.handoff.registrationUrl).toBe(manifestStart().registrationUrl);
    expect(read.ok && JSON.parse(read.handoff.manifestJson)).toEqual(manifestStart().manifest);
    // 카드와 화면 글자에는 state 가 없다.
    expect(document.body.textContent).not.toContain(HANDOFF_STATE);
  });

  it("열기 전후에 콘솔·저장소·쿠키에 state 를 쓰지 않는다", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      vi.spyOn(console, name).mockImplementation(() => undefined)
    );
    try {
      await startOnDesktop();
      const hash = new URL(String(desktop.open.mock.calls[0][0])).hash.slice(1);
      const written = JSON.stringify({
        logs: spies.flatMap((spy) => spy.mock.calls),
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookie: document.cookie,
      });
      // 이 단정이 「주소를 로그로 찍으면 빨개지는」 사보타주 대상이다.
      expect(written).not.toContain(HANDOFF_STATE);
      expect(written).not.toContain(hash);
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("알림 영역은 글줄만 감싼다: 단추는 영역 밖이라 결과가 바뀌어도 단추 글자가 다시 읽히지 않는다", async () => {
    await startOnDesktop();
    const card = q("github-manifest-browser") as HTMLElement;
    const live = card.querySelector('[role="status"]') as HTMLElement;
    // 이 단정이 「단추를 알림 영역 안에 두면 빨개지는」 사보타주 대상이다(design-review L6).
    expect(live).not.toBeNull();
    expect(card.getAttribute("role")).toBeNull();
    expect(live.contains(q("github-manifest-browser-open"))).toBe(false);
    expect(live.textContent).toContain("기본 브라우저에서 GitHub를 열었어요.");
  });

  it("「」 단추 이름과 조사는 한 덩어리라 좁은 폭에서 조사가 줄머리에 서지 않는다", async () => {
    await startOnDesktop();
    // 이 단정이 「묶음을 풀면 빨개지는」 사보타주 대상이다(design-review M2).
    const nowrap = [...(q("github-manifest-browser") as HTMLElement).querySelectorAll("span.whitespace-nowrap")].map((el) => el.textContent);
    expect(nowrap).toContain("「Create GitHub App」을");
    expect(nowrap).toContain("마쳐야 해요.");
  });

  it("단추 이름은 두 상태에서 같다(막힌 화면의 안내가 그 이름으로 가리킨다)", async () => {
    desktop.open.mockResolvedValueOnce(false);
    await startOnDesktop();
    await waitUntil(() => q("github-manifest-browser")?.getAttribute("data-outcome") === "failed", "열기 실패");
    expect(q("github-manifest-browser-open")?.textContent).toBe("브라우저에서 다시 열기");
    click(q("github-manifest-browser-open"));
    await waitUntil(() => q("github-manifest-browser")?.getAttribute("data-outcome") === "opened", "다시 열림");
    expect(q("github-manifest-browser-open")?.textContent).toBe("브라우저에서 다시 열기");
  });

  it("브라우저를 열지 못하면 그렇게 말하고 같은 주소로 다시 열 수 있다", async () => {
    desktop.open.mockResolvedValueOnce(false);
    await startOnDesktop();
    await waitUntil(() => q("github-manifest-browser")?.getAttribute("data-outcome") === "failed", "열기 실패");
    expect(q("github-manifest-browser")?.textContent).toContain("기본 브라우저를 열지 못했어요.");
    // 일시적인 실패만 가정하지 않는다(design-review Nitpick).
    expect(q("github-manifest-browser")?.textContent).not.toContain("잠시 뒤");
    expect(api.startGithubManifest).toHaveBeenCalledTimes(1);
    const firstUrl = String(desktop.open.mock.calls[0][0]);
    click(q("github-manifest-browser-open"));
    await waitUntil(() => q("github-manifest-browser")?.getAttribute("data-outcome") === "opened", "다시 열림");
    expect(desktop.open).toHaveBeenCalledTimes(2);
    // 새 state 를 만들지 않고 들고 있던 주소를 그대로 다시 연다.
    expect(String(desktop.open.mock.calls[1][0])).toBe(firstUrl);
    expect(api.startGithubManifest).toHaveBeenCalledTimes(1);
  });

  it("「GitHub 앱 만들기」를 다시 누르면 새 등록 상태로 다시 연다", async () => {
    await startOnDesktop();
    api.startGithubManifest.mockResolvedValue({
      ...manifestStart(),
      registrationUrl: `https://github.com/organizations/acme/settings/apps/new?state=${"00000000-0000-7000-8000-000000000001"}.${"9a2c".repeat(16)}`,
    });
    click(q("github-register-start"));
    await waitUntil(() => desktop.open.mock.calls.length === 2, "두 번째 열기");
    expect(String(desktop.open.mock.calls[1][0])).not.toBe(String(desktop.open.mock.calls[0][0]));
  });

  it("공개 주소가 너무 길어 opener 한도를 넘으면 열지 않고 직접 말한다", async () => {
    // 이 시험의 매니페스트는 짧아서(설명·이벤트 목록이 없다) 한도에 닿으려면 주소가 훨씬 길어야 한다. 실제
    // 매니페스트로 잰 경계는 handoff.test.ts 가 맡는다.
    await startOnDesktop(manifestStart(`https://${"deep-team-name.".repeat(24)}example.com`));
    expect(desktop.open).toHaveBeenCalledTimes(0);
    expect(q("github-manifest-browser-unavailable")?.textContent).toContain("공개 주소가 너무 길어서");
    expect(q("github-manifest-browser")).toBeNull();
  });

  it("서버가 보낸 콜백이 https 가 아니면 열지 않는다", async () => {
    await startOnDesktop(manifestStart("http://oort.yeomyeonggeori.test"));
    expect(desktop.open).toHaveBeenCalledTimes(0);
    expect(q("github-manifest-browser-unavailable")).not.toBeNull();
  });

  it("창 포커스가 돌아오면 상태를 다시 읽어 「등록됨」으로 바뀐다", async () => {
    await startOnDesktop();
    const reads = api.fetchGithubAppStatus.mock.calls.length;
    const overviewReads = api.fetchGithubOverview.mock.calls.length;
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    focusReturns();
    // 이 단정이 「포커스 복귀 리스너를 지우면 빨개지는」 사보타주 대상이다.
    await waitUntil(() => q("github-app-registered") !== null, "등록됨");
    expect(api.fetchGithubAppStatus.mock.calls.length).toBeGreaterThan(reads);
    expect(api.fetchGithubOverview.mock.calls.length).toBeGreaterThan(overviewReads);
    expect(q("github-app-register")).toBeNull();
    expect(q("github-manifest-browser")).toBeNull();
    expect(q("github-app-registered")?.textContent).toContain("oort-yeomyeonggeori");
    expect(q("github-app-registered")?.textContent).toContain("등록됨");
  });

  it("보임으로 돌아온 신호도 같은 손잡이이고, 연달아 와도 한 번만 읽는다", async () => {
    await startOnDesktop();
    const reads = api.fetchGithubAppStatus.mock.calls.length;
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    act(() => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await waitUntil(() => q("github-app-registered") !== null, "등록됨");
    expect(api.fetchGithubAppStatus.mock.calls.length).toBe(reads + 1);
  });

  it("브라우저를 열지 않은 동안에는 포커스가 와도 다시 읽지 않는다", async () => {
    desktop.on = true;
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    const reads = api.fetchGithubAppStatus.mock.calls.length;
    focusReturns();
    await flush();
    expect(api.fetchGithubAppStatus.mock.calls.length).toBe(reads);
  });

  it("웹 브라우저 탭은 그대로다: 폼 POST, 열기 호출 없음, 포커스에 다시 읽지 않는다", async () => {
    api.startGithubManifest.mockResolvedValue(manifestStart());
    await render();
    await waitUntil(() => q("github-app-register") !== null, "등록 폼");
    typeInto(q<HTMLInputElement>("github-org-input"), "acme");
    click(q("github-register-start"));
    await waitUntil(() => q("github-manifest-handoff") !== null, "넘김 폼");
    const reads = api.fetchGithubAppStatus.mock.calls.length;
    api.fetchGithubAppStatus.mockResolvedValue(REGISTERED);
    focusReturns();
    await flush();
    expect(desktop.open).toHaveBeenCalledTimes(0);
    expect(q("github-manifest-browser")).toBeNull();
    expect(api.fetchGithubAppStatus.mock.calls.length).toBe(reads);
    expect(q("github-app-registered")).toBeNull();
    expect(q("github-manifest-handoff")?.getAttribute("target")).toBe("_blank");
  });
});

describe("워크스페이스 구역: 데스크탑의 설치는 기본 브라우저에서 한다", () => {
  async function openInstallLink() {
    api.fetchGithubOverview.mockResolvedValue(overview({ installations: [] }));
    api.startGithubLink.mockResolvedValue({
      installUrl: "https://github.com/apps/oort/installations/new?state=tok",
      expiresInSeconds: 600,
    });
    await render();
    await waitUntil(() => q("github-link-start") !== null, "연결 버튼");
    click(q("github-link-start"));
    await waitUntil(() => q("github-link-open") !== null, "설치 링크");
  }

  it("설치 링크는 기본 브라우저로 넘기고 창의 기본 이동은 막는다", async () => {
    desktop.on = true;
    await openInstallLink();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      q("github-link-open")?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(desktop.open).toHaveBeenCalledTimes(1);
    expect(desktop.open).toHaveBeenCalledWith("https://github.com/apps/oort/installations/new?state=tok");
  });

  it("데스크탑의 설치 안내는 앱으로 돌아오라고 말하고, 웹의 안내는 그대로다", async () => {
    desktop.on = true;
    await openInstallLink();
    // 이 단정들이 「데스크탑에서도 이 화면으로 돌아온다고 거짓말하면 빨개지는」 사보타주 대상이다(design-review M1).
    const text = q("github-link-ready-text")?.textContent ?? "";
    expect(text).toContain("이 앱으로 돌아와 주세요");
    expect(text).toContain("돌아오면 이 화면이 알아서 바뀌어요");
    expect(text).toContain("10분 안에 마쳐야 해요");
    expect(text).not.toContain("이 화면으로 돌아와요");
    unmount();
    desktop.on = false;
    await openInstallLink();
    const web = q("github-link-ready-text")?.textContent ?? "";
    expect(web).toBe("GitHub에서 설치를 마쳐 주세요. 10분 안에 마치면 이 화면으로 돌아와요.");
  });

  it("웹에서는 평범한 앵커라 열기 호출이 없다", async () => {
    await openInstallLink();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    act(() => {
      q("github-link-open")?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(desktop.open).toHaveBeenCalledTimes(0);
  });

  it("설치 링크를 열어 둔 채 창이 돌아오면 연결된 계정을 다시 읽는다", async () => {
    desktop.on = true;
    await openInstallLink();
    const reads = api.fetchGithubOverview.mock.calls.length;
    api.fetchGithubOverview.mockResolvedValue(overview());
    focusReturns();
    await waitUntil(() => q("github-installations") !== null, "연결된 계정");
    expect(api.fetchGithubOverview.mock.calls.length).toBeGreaterThan(reads);
  });

  it("웹에서는 창 포커스가 개요를 다시 읽지 않는다", async () => {
    await openInstallLink();
    const reads = api.fetchGithubOverview.mock.calls.length;
    focusReturns();
    await flush();
    expect(api.fetchGithubOverview.mock.calls.length).toBe(reads);
  });
});
