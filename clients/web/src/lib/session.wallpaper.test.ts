// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// 배경 사진은 세션이 끝나는 모든 길에서 지워지고, 끝나지 않은 길에서는 지워지지 않는다 (AP-4 #4191, ADR-0189 증보 3 D4).
//
// 세션이 끝나는 길은 여럿이지만(로그아웃, 죽은 토큰으로 복원 실패, 다른 탭의 로그아웃, 만료) 모두 `clearSession`을
// 지난다. 이 시험은 **진짜 core 경로**(`logout()`·`restoreSession()`)를 진짜 세션 저장소에 걸어, 그 길들이 배경 삭제
// 호출에 닿는지를 잰다. 삭제 자체(IndexedDB)는 캡처 스크립트의 단정이 진짜 브라우저에서 잰다.
// =============================================================================

const forget = vi.hoisted(() => vi.fn());
vi.mock("../design/wallpaper/signOut", () => ({ forgetWallpaperOnSignOut: forget }));

const WEB_KEY = "momo.web.session.v1";
const member = {
  id: "0199aaaa-0000-7000-8000-000000000001",
  workspaceId: "00000000-0000-7000-8000-000000000001",
  kind: "human" as const,
  displayName: "곽성재",
  handle: "seongjae",
};

function seedSession(): void {
  localStorage.setItem(
    WEB_KEY,
    JSON.stringify({ refreshToken: "refresh-token-1", realtimeWebSocketUrl: "wss://oort.example.com/connection/websocket", member })
  );
}

async function modules() {
  await import("./coreHost");
  const session = await import("./session");
  const api = await import("@momo/core/lib/api");
  return { session, api };
}

beforeEach(() => {
  vi.resetModules();
  forget.mockClear();
  localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("clearSession", () => {
  it("배경 사진 삭제를 한 번 부른다", async () => {
    const { session } = await modules();
    session.clearSession();
    expect(forget).toHaveBeenCalledTimes(1);
  });
});

describe("세션이 끝나는 길", () => {
  it("로그아웃은 로컬 정리의 한 걸음으로 사진을 지운다 (서버에 닿지 못해도)", async () => {
    seedSession();
    const { api } = await modules();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("offline"); }));
    await api.logout();
    expect(forget).toHaveBeenCalledTimes(1);
  });

  it("죽은 토큰으로 복원에 실패하면 지운다 (서버가 이 세션은 끝났다고 답했다)", async () => {
    seedSession();
    const { api, session } = await modules();
    expect(session.getPersistedSession(), "전제: 저장된 세션을 읽었다").not.toBeNull();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { code: "invalid_token", message: "no" } }), { status: 401, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const restored = await api.restoreSession();
    expect(fetchMock, "전제: 회전 요청이 실제로 서버에 갔다").toHaveBeenCalled();
    expect(restored).toBeNull();
    expect(forget).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(WEB_KEY)).toBeNull();
  });

  it("네트워크가 답하지 않으면 지우지 않는다 (오프라인 시작은 세션 경계가 아니다)", async () => {
    seedSession();
    const { api, session } = await modules();
    expect(session.getPersistedSession(), "전제: 저장된 세션을 읽었다").not.toBeNull();
    const fetchMock = vi.fn(async () => { throw new TypeError("offline"); });
    vi.stubGlobal("fetch", fetchMock);
    const restored = await api.restoreSession();
    expect(fetchMock, "전제: 회전 요청이 실제로 나갔다 (그래서 이 시험은 네트워크가 없을 때의 길을 잰다)").toHaveBeenCalled();
    expect(restored).toBeNull();
    expect(forget).not.toHaveBeenCalled();
    // 자격도 그대로다: 다음 시작에 네트워크가 있으면 이어진다.
    expect(localStorage.getItem(WEB_KEY)).not.toBeNull();
  });

  it("새로 로그인한다고 지우지 않는다", async () => {
    const { session } = await modules();
    session.applyLogin({
      accessToken: "access-token-1",
      refreshToken: "refresh-token-2",
      realtimeWebSocketUrl: "wss://oort.example.com/connection/websocket",
      member,
    });
    expect(forget).not.toHaveBeenCalled();
  });
});
