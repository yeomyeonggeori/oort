// ADR-0113 증보 3 (#4313)의 와이어 읽기·쓰기: 표시 필드(F1), 요청 필드 `apps`와 서버 소유 키
// `props.requestedApps`(F5), 내 앱 실행 장소 투영(F8). 서버 쪽 규칙은 Rust 시험
// (`plugin_manifest.rs`, `requested_apps.rs`, `app_runtimes.rs`)이 못으로 박고, 여기는 **같은 규칙을 코어
// 파서가 같은 자리에서 읽는지**를 박는다. 서버가 실제로 답한 바이트를 읽는 시험은 웹의 `pluginApi.test.ts`다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost, type SessionPort } from "../runtime/host";
import {
  appRuntimesFromWire,
  listAppRuntimes,
  pluginCatalogFromWire,
  pluginDetailFromWire,
  requestedAppsFromWire,
  requestedAppsOfMessage,
  sendMessage,
} from "./api";
import { WireShapeError } from "./wire";

function installHost(): void {
  const session: SessionPort = {
    getAccessToken: () => "access-token",
    getRefreshToken: () => null,
    getPersistedSession: () => null,
    applyLogin: () => {},
    applyRotation: () => {},
    markAuthExpired: () => {},
    clearSession: () => {},
  };
  installCoreHost({
    apiBase: () => "https://oort.test",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetCoreHost();
});

const WS = "00000000-0000-7000-8000-000000000001";
const GMAIL = "com.momo.plugins.gmail";
const GITHUB = "com.momo.plugins.github";

// ---- F1: 표시 필드 ----------------------------------------------------------------------------

/** 서버 목록 한 줄의 최소 모양(+ 선택 필드는 각 시험이 더한다). */
function catalogItem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pluginId: GMAIL,
    name: "Gmail",
    version: "1.0.0",
    description: "d",
    official: true,
    recommended: false,
    egressDomains: ["gmailmcp.googleapis.com"],
    recommendedFor: ["communication"],
    installed: false,
    enabled: false,
    ...extra,
  };
}

function catalog(extra: Record<string, unknown> = {}) {
  return pluginCatalogFromWire({
    plugins: [catalogItem(extra)],
    toolPolicy: { plugins: [] },
  }).plugins[0];
}

describe("catalog display fields (ADR-0113 증보 3 F1)", () => {
  const display = {
    publisherName: "Google",
    logoKey: "gmail",
    category: "communication",
    websiteURL: "https://mail.google.com",
    starterPrompts: [
      { text: "받은편지함에서 이번 주에 온 메일을 찾아서 요약해 줘요.", tool: "gmail.search_threads" },
      { text: "내 Gmail 라벨 목록을 보여 줘요.", tool: "gmail.list_labels" },
    ],
  };

  it("읽는다: 개발자·로고 키·분류·웹사이트·예시 카드", () => {
    const item = catalog(display);
    expect(item).toMatchObject({
      publisherName: "Google",
      logoKey: "gmail",
      category: "communication",
      websiteURL: "https://mail.google.com",
    });
    expect(item.starterPrompts).toEqual(display.starterPrompts);
  });

  it("없으면 키가 없다 - 옛 서버의 응답은 그대로 읽힌다", () => {
    const item = catalog();
    expect(item.publisherName).toBeUndefined();
    expect(item.logoKey).toBeUndefined();
    expect(item.category).toBeUndefined();
    expect(item.starterPrompts).toBeUndefined();
    expect(item.websiteURL).toBeUndefined();
    expect(item.pluginId).toBe(GMAIL);
  });

  it("logoKey는 번들 자산 이름의 모양일 때만 읽는다 - URL·경로·대문자는 읽지 않는다", () => {
    for (const bad of [
      "GitHub",
      "git_hub",
      "github.svg",
      "../github",
      "https://cdn.example.com/github.svg",
      "",
      "a".repeat(33),
      7,
      null,
    ]) {
      expect(catalog({ logoKey: bad }).logoKey, JSON.stringify(bad)).toBeUndefined();
    }
    expect(catalog({ logoKey: "a".repeat(32) }).logoKey).toBe("a".repeat(32));
    expect(catalog({ logoKey: "google-calendar" }).logoKey).toBe("google-calendar");
  });

  it("category는 닫힌 다섯 중 하나일 때만 읽는다 - 모르는 분류는 undefined", () => {
    for (const known of ["communication", "productivity", "developer", "files", "project"]) {
      expect(catalog({ category: known }).category).toBe(known);
    }
    for (const bad of ["Developer", "tools", "", 3, ["developer"]]) {
      expect(catalog({ category: bad }).category, JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("websiteURL은 https만 읽는다", () => {
    expect(catalog({ websiteURL: "http://example.com" }).websiteURL).toBeUndefined();
    expect(catalog({ websiteURL: "javascript:alert(1)" }).websiteURL).toBeUndefined();
    expect(catalog({ websiteURL: "https://example.com/x" }).websiteURL).toBe("https://example.com/x");
  });

  it("예시 카드는 서버와 같은 규칙으로 걸러 읽는다: 3장까지, 어긋난 카드만 건너뛴다", () => {
    const good = { text: "오늘 일정을 알려 줘요.", tool: "google-calendar.list_events" };
    const cards = catalog({
      starterPrompts: [
        good,
        { text: "", tool: "x.y" },
        { text: "가".repeat(141), tool: "x.y" },
        { text: " 앞공백", tool: "x.y" },
        { text: "줄\n바꿈", tool: "x.y" },
        { text: "도구 없음" },
        { tool: "x.y" },
        "문자열",
      ],
    }).starterPrompts;
    expect(cards).toEqual([good]);
    // 140자는 읽는다 - 한글 140자(바이트 420)도 140자다.
    const longest = { text: "가".repeat(140), tool: "x.y" };
    expect(catalog({ starterPrompts: [longest] }).starterPrompts).toEqual([longest]);
    // 네 번째 이후는 읽지 않는다.
    const four = Array.from({ length: 4 }, (_, index) => ({ text: `예시 ${index}`, tool: "x.y" }));
    expect(catalog({ starterPrompts: four }).starterPrompts).toHaveLength(3);
    // 하나도 남지 않으면 빈 배열이 아니라 undefined.
    expect(catalog({ starterPrompts: [{ text: "", tool: "x.y" }] }).starterPrompts).toBeUndefined();
    expect(catalog({ starterPrompts: [] }).starterPrompts).toBeUndefined();
    expect(catalog({ starterPrompts: "x" }).starterPrompts).toBeUndefined();
  });

  it("원격 이미지 키는 읽지 않는다 - 서버가 보내도 객체 어디에도 실리지 않는다", () => {
    const item = catalog({
      iconURL: "https://cdn.example.com/a.png",
      logoURL: "https://cdn.example.com/b.png",
      imageURL: "https://cdn.example.com/c.png",
    });
    for (const key of ["iconURL", "logoURL", "imageURL"]) {
      expect(Object.keys(item)).not.toContain(key);
    }
    expect(JSON.stringify(item)).not.toContain("cdn.example.com");
  });

  it("상세도 같은 표시 필드를 읽고, 개발자는 DTO가 먼저이며 없으면 매니페스트에서 읽는다", () => {
    const manifest = {
      plugin: { publisher: { name: "Manifest Publisher", verified: true } },
      mcp: { tools: [] },
      momo: {},
    };
    const detail = pluginDetailFromWire({
      plugin: { ...catalogItem(display), manifest },
    });
    expect(detail).toMatchObject({
      publisherName: "Google",
      logoKey: "gmail",
      category: "communication",
      websiteURL: "https://mail.google.com",
    });
    expect(detail.starterPrompts).toHaveLength(2);
    // 옛 서버: DTO에 개발자 칸이 없으면 매니페스트의 publisher.name.
    const old = pluginDetailFromWire({ plugin: { ...catalogItem(), manifest } });
    expect(old.publisherName).toBe("Manifest Publisher");
    expect(old.logoKey).toBeUndefined();
  });
});

// ---- F5: 요청 필드 apps와 서버 소유 키 requestedApps ----------------------------------------------

describe("requestedAppsFromWire (ADR-0113 증보 3 F5)", () => {
  it("중복 없는 3개 이하의 플러그인 id 배열만 읽는다", () => {
    expect(requestedAppsFromWire([GMAIL])).toEqual([GMAIL]);
    expect(requestedAppsFromWire([GMAIL, GITHUB, "com.momo.plugins.drive"])).toHaveLength(3);
  });

  it("모르는 모양이면 통째로 무시한다(null) - 일부만 건져 읽지 않는다", () => {
    const bad: unknown[] = [
      undefined,
      null,
      "com.momo.plugins.gmail",
      {},
      [],
      [GMAIL, GITHUB, "com.momo.plugins.drive", "com.momo.plugins.linear"],
      [GMAIL, GMAIL],
      [GMAIL, 3],
      [GMAIL, "Com.Momo.Plugins.Gmail"],
      [GMAIL, "x"],
      [{ pluginId: GMAIL }],
    ];
    for (const value of bad) expect(requestedAppsFromWire(value), JSON.stringify(value)).toBeNull();
  });

  it("메시지의 props.requestedApps를 읽고, 없거나 어긋나면 빈 배열이다", () => {
    expect(requestedAppsOfMessage({ props: { requestedApps: [GMAIL] } })).toEqual([GMAIL]);
    expect(requestedAppsOfMessage({ props: { requestedApps: "forged" } })).toEqual([]);
    expect(requestedAppsOfMessage({ props: {} })).toEqual([]);
    expect(requestedAppsOfMessage({})).toEqual([]);
  });
});

describe("sendMessage apps option (ADR-0113 증보 3 F5)", () => {
  function captureBody(): { body: () => Record<string, unknown> } {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "m1",
            channelId: "c1",
            seq: 1,
            hlcTs: 0,
            hlcCount: 0,
            authorMemberId: "a",
            type: "text",
            createdAtMs: 0,
          }),
          { status: 201, headers: { "content-type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    return {
      body: () => {
        const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
        return JSON.parse(String(init.body)) as Record<string, unknown>;
      },
    };
  }

  it("앱을 고르면 apps가 실린다", async () => {
    installHost();
    const captured = captureBody();
    await sendMessage(WS, "c1", "id-1", "메일 확인해 줘요", { apps: [GMAIL, GITHUB] });
    expect(captured.body().apps).toEqual([GMAIL, GITHUB]);
  });

  it("고르지 않았거나 비었으면 키 자체가 빠진다 - 옛 서버의 closed-world 요청과 바이트가 같다", async () => {
    installHost();
    for (const options of [undefined, {}, { apps: [] }]) {
      vi.unstubAllGlobals();
      const captured = captureBody();
      await sendMessage(WS, "c1", "id-1", "메일 확인해 줘요", options);
      expect(Object.keys(captured.body()).sort()).toEqual(["body", "clientMsgId", "type"]);
    }
  });
});

// ---- F8: 내 앱 실행 장소 ------------------------------------------------------------------------

describe("appRuntimesFromWire (ADR-0113 증보 3 F8)", () => {
  const hosted = {
    agentId: "a1",
    path: "hosted_vendor",
    apps: [GMAIL],
    enforced: false,
    blocked: null,
  };
  const trial = {
    agentId: "a2",
    path: "hermes_trial",
    apps: [GMAIL, GITHUB],
    enforced: true,
    blocked: "members",
  };

  const wire = (...entries: unknown[]) => ({ runtimes: entries });

  it("최상위 객체의 runtimes를 읽는다 - blocked는 null(배달됨) 또는 이유", () => {
    expect(appRuntimesFromWire(wire(hosted, trial))).toEqual([hosted, trial]);
    expect(appRuntimesFromWire(wire())).toEqual([]);
    for (const reason of ["hosted_off", "connection", "attest", "members", "apps", "paused"]) {
      expect(appRuntimesFromWire(wire({ ...hosted, blocked: reason }))[0]?.blocked).toBe(reason);
    }
  });

  it("객체가 아니거나 runtimes가 배열이 아니면 모양 오류다 - 옛 최상위 배열도 거절한다", () => {
    // 서버는 이제 `{ runtimes: [...] }`만 보낸다(planner 결정 1). 최상위 배열을 계속 받아 주면 옛 모양이 조용히 살아남는다.
    for (const bad of [null, {}, [], [hosted, trial], { runtimes: {} }, { runtimes: "x" }, "x", 3]) {
      expect(() => appRuntimesFromWire(bad)).toThrow(WireShapeError);
    }
  });

  it("모르는 이유도 막힘으로 읽는다 - 배달된다고 읽지 않는다", () => {
    expect(appRuntimesFromWire(wire({ ...hosted, blocked: "quota" }))[0]?.blocked).toBe("unknown");
    // 키가 없는 항목은 「배달됨」이 아니라 모르는 모양이라 건너뛴다.
    const withoutBlocked = { agentId: "a1", path: "hosted_vendor", apps: [GMAIL], enforced: false };
    expect(appRuntimesFromWire(wire(withoutBlocked, trial))).toEqual([trial]);
    // blocked가 문자열도 null도 아니면 건너뛴다.
    expect(appRuntimesFromWire(wire({ ...hosted, blocked: 3 }, trial))).toEqual([trial]);
  });

  it("어긋난 항목만 건너뛴다 - 모르는 경로·필수 키 없음·배열이 아닌 apps", () => {
    const bad = [
      { ...hosted, path: "mac" },
      { ...hosted, agentId: undefined },
      { ...hosted, apps: "gmail" },
      { ...hosted, enforced: "no" },
      "x",
      null,
    ];
    expect(appRuntimesFromWire(wire(...bad, trial))).toEqual([trial]);
  });

  it("listAppRuntimes는 /members/me/app-runtimes를 GET으로 부른다", async () => {
    installHost();
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify(wire(hosted)), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(listAppRuntimes(WS)).resolves.toEqual([hosted]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit | undefined];
    expect(url).toBe(`https://oort.test/v1/workspaces/${WS}/members/me/app-runtimes`);
    expect((init?.method ?? "GET").toUpperCase()).toBe("GET");
    expect(init?.body).toBeUndefined();
  });
});
