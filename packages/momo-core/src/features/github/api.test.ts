import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import { WireShapeError } from "../../lib/wire";
import { installCoreHost, resetCoreHost } from "../../runtime/host";
import {
  fetchGithubAppStatus,
  fetchGithubOverview,
  linkInstallationToWorkspace,
  startGithubLink,
  startGithubManifest,
  subscribeGithub,
  unsubscribeGithub,
} from "./api";

function installHost() {
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => "access-token",
      getRefreshToken: () => null,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: () => {},
      markAuthExpired: () => {},
      clearSession: () => {},
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

function respond(body: unknown, status = 200): Response {
  if (status === 204) return new Response(null, { status: 204 });
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function stubFetch(...responses: Response[]) {
  const mock = vi.fn();
  for (const response of responses) mock.mockResolvedValueOnce(response);
  vi.stubGlobal("fetch", mock);
  installHost();
  return mock;
}

function lastCall(mock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, RequestInit];
  return { url, init, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} };
}

const SUBSCRIPTION = {
  id: "s1",
  channelId: "c1",
  installationId: 5,
  repository: "acme/web",
  repoId: 1,
  features: ["pulls"],
  active: true,
  privateConfirmed: false,
};

describe("GitHub 알림 REST", () => {
  it("구독 요청은 확인하지 않았으면 confirmPrivate 를 보내지 않는다", async () => {
    const mock = stubFetch(respond(SUBSCRIPTION));
    await subscribeGithub("ws-1", {
      channelId: "c1",
      installationId: 5,
      repository: "acme/web",
      features: ["pulls", "issues"],
    });
    const call = lastCall(mock);
    expect(call.url).toBe("https://oort.test/v1/workspaces/ws-1/github/subscriptions");
    expect(call.init.method).toBe("POST");
    expect("confirmPrivate" in call.body).toBe(false);
    expect(call.body.features).toEqual(["pulls", "issues"]);
  });

  it("confirmPrivate: true 일 때만 true 로 보낸다 (false 도 보내지 않는다)", async () => {
    const mock = stubFetch(respond(SUBSCRIPTION), respond(SUBSCRIPTION));
    await subscribeGithub("ws-1", { channelId: "c1", installationId: 5, repository: "acme/web", features: [], confirmPrivate: false });
    expect("confirmPrivate" in lastCall(mock).body).toBe(false);
    await subscribeGithub("ws-1", { channelId: "c1", installationId: 5, repository: "acme/web", features: [], confirmPrivate: true });
    expect(lastCall(mock).body.confirmPrivate).toBe(true);
  });

  it("409 는 서버의 코드를 ApiError 에 실어 던진다", async () => {
    stubFetch(
      respond({ error: { code: "private_repository_requires_confirmation", message: "wording" } }, 409)
    );
    const failure = await subscribeGithub("ws-1", {
      channelId: "c1",
      installationId: 5,
      repository: "acme/web",
      features: [],
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(409);
    expect((failure as ApiError).code).toBe("private_repository_requires_confirmation");
  });

  it("개요는 channelId 를 쿼리로 거르고 작업 공간 id 를 인코딩한다", async () => {
    const mock = stubFetch(respond({ appRegistered: true, installations: [], subscriptions: [] }));
    const overview = await fetchGithubOverview("ws/1", "c 1");
    expect(overview.appRegistered).toBe(true);
    expect(lastCall(mock).url).toBe("https://oort.test/v1/workspaces/ws%2F1/github?channelId=c%201");
  });

  it("앱 상태 응답이 모양을 어기면 WireShapeError", async () => {
    stubFetch(respond({ nope: true }));
    await expect(fetchGithubAppStatus()).rejects.toBeInstanceOf(WireShapeError);
  });

  it("매니페스트 시작은 소유자 선택을 그대로 보낸다", async () => {
    const mock = stubFetch(
      respond({
        registrationUrl: "https://github.com/organizations/acme/settings/apps/new?state=s",
        manifest: { name: "oort" },
        expiresInSeconds: 3600,
      })
    );
    const started = await startGithubManifest({ ownerType: "organization", organization: "acme" });
    expect(lastCall(mock).body).toEqual({ ownerType: "organization", organization: "acme" });
    expect(started.registrationUrl.startsWith("https://github.com/")).toBe(true);
  });

  it("연결 시작은 빈 본문 POST 이고 github.com 설치 주소를 돌려준다", async () => {
    const mock = stubFetch(respond({ installUrl: "https://github.com/apps/oort/installations/new?state=t", expiresInSeconds: 600 }));
    const link = await startGithubLink("ws-1");
    expect(lastCall(mock).url).toBe("https://oort.test/v1/workspaces/ws-1/github/link");
    expect(link.installUrl).toContain("state=t");
  });

  it("운영자 연결과 구독 해제는 본문 없는 성공을 받는다", async () => {
    const mock = stubFetch(respond(null, 204), respond(null, 204));
    await linkInstallationToWorkspace(42, "ws-1");
    expect(lastCall(mock).url).toBe("https://oort.test/v1/integrations/github/installations/42/link");
    expect(lastCall(mock).body).toEqual({ workspaceId: "ws-1" });
    await unsubscribeGithub("ws-1", "s 1");
    expect(lastCall(mock).url).toBe("https://oort.test/v1/workspaces/ws-1/github/subscriptions/s%201");
    expect(lastCall(mock).init.method).toBe("DELETE");
  });
});
