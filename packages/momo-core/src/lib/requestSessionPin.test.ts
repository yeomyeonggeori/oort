import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NetworkError } from "./http";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  authedResponse,
  fetchAttachmentContent,
  fetchMemberAvatar,
  fetchUnfurlImage,
  login,
  logout,
  type LoginResponse,
} from "./api";
import { postBundleInOrder, type BundlePoster } from "../features/expressions/sendBundle";
import type { PendingMessage } from "../features/timeline/model";

// #5816 — 요청은 그것을 시작한 세션(그 사람 · 그 서버 · 그 로그인)의 자격으로만 다시 시도하고, 그 세션이 끝났으면 다시 보내지
// 않고 실패로 끝낸다.

const WS = "00000000-0000-0000-0000-000000000001";
const dohyeon = { id: "00000000-0000-0000-0000-0000000000d1", workspaceId: WS, handle: "dohyeon", displayName: "김도현", kind: "human" } as const;
const seoyeon = { id: "00000000-0000-0000-0000-0000000000e1", workspaceId: WS, handle: "seoyeon", displayName: "이서연", kind: "human" } as const;
const SERVER = "http://oort.test";

interface Sent {
  path: string;
  method: string;
  authorization: string | null;
  body: string;
}
type Reply = { status: number; body: unknown };

function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

function harness() {
  let access: string | null = "at-D0";
  let refresh: string | null = "rt-D0";
  let member: unknown = dohyeon;
  let expired = 0;
  let server = SERVER;
  const port: SessionPort = {
    getAccessToken: () => access,
    getRefreshToken: () => refresh,
    getPersistedSession: () =>
      refresh ? ({ refreshToken: refresh, realtimeWebSocketUrl: "wss://oort.test/ws", member } as never) : null,
    applyLogin: (response) => {
      access = response.accessToken;
      refresh = response.refreshToken;
      member = response.member;
    },
    applyRotation: (a, r) => {
      if (!refresh) return;
      access = a;
      refresh = r;
    },
    markAuthExpired: () => {
      expired += 1;
    },
    clearSession: () => {
      access = null;
      refresh = null;
      member = null;
    },
  };
  installCoreHost({ apiBase: () => server, absoluteApiBase: () => server, buildMode: () => "test", session: port });
  const sent: Sent[] = [];
  const handlers: { path: string; fn: (s: Sent) => Reply | Promise<Reply> }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const one: Sent = {
        path: url.pathname,
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("Authorization"),
        body: init?.body ? String(init.body) : "",
      };
      sent.push(one);
      const at = handlers.findIndex((h) => h.path === one.path);
      const fn = at >= 0 ? handlers.splice(at, 1)[0].fn : () => ({ status: 200, body: { status: "ok" } });
      const reply = await fn(one);
      return new Response(JSON.stringify(reply.body), {
        status: reply.status,
        headers: { "Content-Type": "application/json" },
      });
    })
  );
  return {
    port,
    sent,
    expired: () => expired,
    setServer: (next: string) => {
      server = next;
    },
    stored: () => ({ access, refresh }),
    /** 다른 창이 같은 저장소에 세션을 넣었다(이 창의 코어를 거치지 않음). */
    adoptElsewhere: (a: string, r: string, m: unknown) => {
      access = a;
      refresh = r;
      member = m;
    },
    once: (path: string, fn: (s: Sent) => Reply | Promise<Reply>) => {
      handlers.push({ path, fn });
    },
  };
}

type Harness = ReturnType<typeof harness>;

const sessionOf = (who: typeof dohyeon | typeof seoyeon, n: number): LoginResponse => {
  const tag = who === dohyeon ? "D" : "S";
  return { accessToken: `at-${tag}${n}`, refreshToken: `rt-${tag}${n}`, realtimeWebSocketUrl: "wss://oort.test/ws", member: who };
};

/** 같은 탭에서 로그아웃하고 `who`가 로그인한다(코어의 login). */
async function logoutThenLogin(h: Harness, who: typeof dohyeon | typeof seoyeon) {
  void logout();
  h.once("/v1/auth/login", () => ({ status: 200, body: sessionOf(who, 1) }));
  await login(`${who.handle}@example.test`, "pw");
}

/** 이서연(다음 사람)의 값이 실린 요청. */
const sentAsSeoyeon = (h: Harness) =>
  h.sent.filter((s) => /-S\d/.test(s.authorization ?? "") || /-S\d/.test(s.body)).map((s) => `${s.method} ${s.path}`);

const MESSAGE_PATH = `/v1/workspaces/${WS}/channels/c1/messages`;
const MESSAGE_BODY = JSON.stringify({ clientMsgId: "m-1", body: "도현이 보내는 글" });

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  resetCoreHost();
  vi.unstubAllGlobals();
});

describe("401을 받은 요청은 그것을 보낸 세션으로만 다시 보낸다", () => {
  /** 앞 사람의 글 보내기를 붙잡아 두고, `between`을 한 뒤 401을 돌려준다. */
  async function sendWhile(h: Harness, between: () => Promise<void>) {
    const answered = gate();
    h.once(MESSAGE_PATH, async () => {
      await answered.opened;
      return { status: 401, body: { error: { message: "token has been revoked" } } };
    });
    const sending = authedResponse(MESSAGE_PATH, { method: "POST", body: MESSAGE_BODY }).then(
      (res) => `status ${res.status}`,
      (error: unknown) => (error instanceof NetworkError ? "failed" : `other: ${String(error)}`)
    );
    await vi.waitFor(() => expect(h.sent.some((s) => s.path === MESSAGE_PATH)).toBe(true));
    await between();
    answered.open();
    return sending;
  }

  it("다른 사람의 세션이 저장돼 있으면 그 자격으로 갱신하지도 다시 보내지도 않는다", async () => {
    const h = harness();
    const result = await sendWhile(h, () => logoutThenLogin(h, seoyeon));
    expect(result).toBe("failed");
    expect(sentAsSeoyeon(h)).toEqual([]);
    expect(h.sent.filter((s) => s.path === MESSAGE_PATH)).toHaveLength(1);
    expect(h.expired()).toBe(0); // 다음 사람의 세션을 끝났다고 하지 않는다
    expect(h.stored()).toEqual({ access: "at-S1", refresh: "rt-S1" });
  });

  it("같은 사람의 새 로그인이어도 다시 보내지 않는다", async () => {
    const h = harness();
    const result = await sendWhile(h, () => logoutThenLogin(h, dohyeon));
    expect(result).toBe("failed");
    expect(h.sent.filter((s) => s.path === MESSAGE_PATH)).toHaveLength(1);
    expect(h.sent.filter((s) => s.path === "/v1/auth/refresh")).toEqual([]);
  });

  it("새 로그인이 덮어썼어도 다시 보내지 않는다", async () => {
    const h = harness();
    const result = await sendWhile(h, async () => {
      h.once("/v1/auth/login", () => ({ status: 200, body: sessionOf(dohyeon, 1) }));
      await login("dohyeon@example.test", "pw");
    });
    expect(result).toBe("failed");
    expect(h.sent.filter((s) => s.path === MESSAGE_PATH)).toHaveLength(1);
    expect(h.sent.filter((s) => s.path === "/v1/auth/refresh")).toEqual([]);
  });

  it("끝난 세션의 요청은 다른 창이 넣은 세션으로 다시 보내지 않는다", async () => {
    const h = harness();
    const result = await sendWhile(h, async () => {
      void logout();
      h.adoptElsewhere("at-D9", "rt-D9", dohyeon);
    });
    expect(result).toBe("failed");
    expect(h.sent.filter((s) => s.path === MESSAGE_PATH)).toHaveLength(1);
    expect(h.sent.some((s) => /-D9/.test(s.authorization ?? "") || /-D9/.test(s.body))).toBe(false);
  });

  it("갱신이 다른 사람의 짝을 받아 왔으면 다시 보내지 않는다", async () => {
    const h = harness();
    h.port.exclusiveRotation = async <T>(work: () => Promise<T>): Promise<T> => {
      h.adoptElsewhere("at-S5", "rt-S5", seoyeon);
      return work();
    };
    h.once("/v1/auth/refresh", () => ({ status: 200, body: { accessToken: "at-S6", refreshToken: "rt-S6" } }));
    const result = await sendWhile(h, async () => {});
    expect(result).toBe("failed");
    expect(h.sent.filter((s) => s.path === MESSAGE_PATH)).toHaveLength(1);
    expect(h.expired()).toBe(0);
  });

  it("다른 서버를 가리키게 됐으면 갱신하지도 다시 보내지도 않는다", async () => {
    const h = harness();
    const result = await sendWhile(h, async () => {
      h.setServer("http://next.test");
    });
    expect(result).toBe("failed");
    expect(h.sent.map((s) => s.path)).toEqual([MESSAGE_PATH]);
  });

  it("세션이 그대로면 예전처럼 갱신하고 같은 본문으로 한 번 다시 보낸다", async () => {
    const h = harness();
    h.once("/v1/auth/refresh", () => ({ status: 200, body: { accessToken: "at-D2", refreshToken: "rt-D2" } }));
    const result = await sendWhile(h, async () => {});
    expect(result).toBe("status 200");
    const posts = h.sent.filter((s) => s.path === MESSAGE_PATH);
    expect(posts.map((s) => s.authorization)).toEqual(["Bearer at-D0", "Bearer at-D2"]);
    expect(posts[1].body).toBe(MESSAGE_BODY);
  });
});

describe("바이트를 받는 요청도 그것을 보낸 세션으로만 다시 받는다", () => {
  it.each([
    ["링크 미리보기 그림", `/v1/workspaces/${WS}/unfurls/u1/image`, () => fetchUnfurlImage(`/v1/workspaces/${WS}/unfurls/u1/image`)],
    ["첨부", `/v1/workspaces/${WS}/channels/c1/attachments/a1/content`, () => fetchAttachmentContent(WS, "c1", "a1")],
    [
      "멤버 사진",
      `/v1/workspaces/${WS}/members/${dohyeon.id}/avatar/content`,
      () => fetchMemberAvatar(`/v1/workspaces/${WS}/members/${dohyeon.id}/avatar/content`),
    ],
  ])("%s", async (_name, path, fetchIt) => {
    const h = harness();
    const answered = gate();
    h.once(path, async () => {
      await answered.opened;
      return { status: 401, body: {} };
    });
    const result = fetchIt().then(
      () => "fetched",
      (error: unknown) => (error instanceof NetworkError ? "failed" : "other")
    );
    await vi.waitFor(() => expect(h.sent.some((s) => s.path === path)).toBe(true));
    await logoutThenLogin(h, seoyeon);
    answered.open();
    expect(await result).toBe("failed");
    expect(sentAsSeoyeon(h)).toEqual([]);
    expect(h.sent.filter((s) => s.path === path)).toHaveLength(1);
    expect(h.expired()).toBe(0);
  });
});

describe("묶음의 뒤 행은 묶음을 시작한 세션으로만 나간다", () => {
  const head: PendingMessage = { clientMsgId: "m-head", body: ":wave:", createdAtMs: 0, state: "sending" } as unknown as PendingMessage;
  const tail: PendingMessage = { clientMsgId: "m-tail", body: "도현의 글", createdAtMs: 0, state: "sending", after: "m-head" } as unknown as PendingMessage;

  it("묶음을 시작한 세션이 끝났으면 뒤 행을 보내지 않는다", async () => {
    const h = harness();
    let list: PendingMessage[] = [head, tail];
    const headAnswered = gate();
    const posted: string[] = [];
    const poster: BundlePoster = {
      list: () => list,
      post: async (row) => {
        posted.push(row.clientMsgId);
        if (row.clientMsgId === "m-head") await headAnswered.opened;
        list = list.filter((entry) => entry.clientMsgId !== row.clientMsgId);
        return true;
      },
      held: () => {},
    };
    const sending = postBundleInOrder(head, poster);
    await vi.waitFor(() => expect(posted).toEqual(["m-head"]));
    await logoutThenLogin(h, seoyeon);
    headAnswered.open();
    await sending;
    expect(posted).toEqual(["m-head"]);
  });

  it("세션이 그대로면 뒤 행이 이어서 나간다", async () => {
    harness();
    let list: PendingMessage[] = [head, tail];
    const posted: string[] = [];
    const poster: BundlePoster = {
      list: () => list,
      post: async (row) => {
        posted.push(row.clientMsgId);
        list = list.filter((entry) => entry.clientMsgId !== row.clientMsgId);
        return true;
      },
      held: () => {},
    };
    await expect(postBundleInOrder(head, poster)).resolves.toBe(true);
    expect(posted).toEqual(["m-head", "m-tail"]);
  });
});
