import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import type { LocalWorkHostStatus } from "@momo/core/features/settings/thisMacHost";
import type { GitReadResult } from "@momo/core/features/workbench/gitRead";
import type { PtyExit } from "@/lib/tauri";
import { createLocalSessions, type MirrorFactory, type MirrorTerminal, type PtyPort } from "../localSessions";
import { createPaneShare, hostReadiness, type PaneShareDeps } from "./paneShare";
import { lastChannelFor, rememberChannelFor, type RepoChannelStorage } from "./repoChannelStore";

// #2867 「채널에 공유」 — 진짜 세션 관리자(가짜 PTY·가짜 미러) 위에서 컨트롤러를 잰다.
// 되돌리면 실패해야 하는 것: 기본 꺼짐, 집 채널 기본값=저장소별 마지막 채널, 끄기는 서버를 부른다,
// 켜지지 않은 칸은 수집기가 보내지 못한다.

const WS = "00000000-0000-7000-8000-000000000001";
const HOST = "00000000-0000-7000-8000-0000000000aa";
const CH_A = "00000000-0000-7000-8000-000000000201";
const CH_B = "00000000-0000-7000-8000-000000000202";
const SESSION = "00000000-0000-7000-8000-0000000000b1";

class FakeMirror implements MirrorTerminal {
  cols = 80;
  rows = 24;
  private title: ((t: string) => void) | null = null;
  setTitle(t: string) {
    this.title?.(t);
  }
  write(_d: string | Uint8Array, cb?: () => void) {
    if (cb) queueMicrotask(cb);
  }
  resize() {}
  dispose() {}
  onTitleChange(listener: (t: string) => void) {
    this.title = listener;
    return { dispose: () => (this.title = null) };
  }
}

function memoryStorage(): RepoChannelStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

const REGISTERED: LocalWorkHostStatus = {
  sidecar: true,
  registered: { hostId: HOST, workspaceId: WS, ownerMemberId: "m", serverUrl: "https://team.example" },
  running: true,
  heartbeat: { lastOkAtMs: 1, failing: false },
  adapters: [],
  workFolder: "/x",
  displayNameSuggestion: "Mac",
};

function rig(over: Partial<PaneShareDeps> & { repo?: string | null; host?: LocalWorkHostStatus | null } = {}) {
  let output: (b: ArrayBuffer) => void = () => undefined;
  let exit: (e: PtyExit) => void = () => undefined;
  let nextPty = 1;
  const mirrors: FakeMirror[] = [];
  const pty: PtyPort = {
    spawn: vi.fn(async (_r, o, e) => {
      output = o;
      exit = e;
      return nextPty++;
    }),
    write: vi.fn(async () => undefined),
    resize: vi.fn(async () => undefined),
    kill: vi.fn(async () => undefined),
    ack: vi.fn(async () => undefined),
  };
  const factory: MirrorFactory = {
    create: () => {
      const mirror = new FakeMirror();
      mirrors.push(mirror);
      return { mirror, serialize: () => "" };
    },
  };
  let t = 5_000_000;
  const sessions = createLocalSessions({ pty, loadMirror: async () => factory, storage: () => null, now: () => t });
  const storage = memoryStorage();
  const repo = over.repo === undefined ? "oort" : over.repo;
  const ok = (value: unknown): GitReadResult => ({ outcome: "ok", value: value as never });
  const sent: { sessionId: string; body: Record<string, unknown> }[] = [];
  const created: unknown[] = [];
  const ended: string[] = [];
  const deps: PaneShareDeps = {
    workspaceId: WS,
    sessions,
    readGit: async (command) => {
      if (command === "g1") return repo ? ok({ kind: "repo", name: repo }) : { outcome: "unknown" };
      if (command === "g2") return ok({ kind: "branch", name: "feat/x" });
      return { outcome: "unknown" };
    },
    hostStatus: async () => (over.host === undefined ? REGISTERED : over.host),
    serverOrigin: () => "https://team.example",
    createSession: vi.fn(async (input) => {
      created.push(input);
      return { id: SESSION, channelId: input.channelId };
    }),
    endSession: vi.fn(async (id) => void ended.push(id)),
    sendShare: vi.fn(async (sessionId, body) => void sent.push({ sessionId, body })),
    storage,
    now: () => t,
    setInterval: () => () => undefined,
    ...over,
  };
  delete (deps as { repo?: unknown }).repo;
  delete (deps as { host?: unknown }).host;
  const share = createPaneShare(deps);
  return {
    share,
    sessions,
    deps,
    storage,
    sent,
    created,
    ended,
    mirrors,
    advance: (ms: number) => {
      t += ms;
      vi.advanceTimersByTime(ms);
    },
    emit: (text: string) => output(new TextEncoder().encode(text).buffer as ArrayBuffer),
    exit: (e: PtyExit) => exit(e),
  };
}

async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

async function started(h: ReturnType<typeof rig>, pane = "p1") {
  h.sessions.setPendingProgram(pane, { kind: "harness", id: "claude" } as never);
  await h.sessions.ensure(pane, 80, 24);
  await settle();
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("공유 기본값은 끔이다 (ADR-0190 D4)", () => {
  it("칸이 돌고 상태가 바뀌어도 서버를 부르지 않고 아무것도 보내지 않는다", async () => {
    const h = rig();
    await started(h);
    h.emit("hello\r\n");
    h.exit({ id: 1, code: 0, signal: null });
    h.advance(120_000);
    await settle();
    expect(h.share.getState("p1")).toMatchObject({ kind: "off", sessionId: null });
    expect(h.deps.createSession).not.toHaveBeenCalled();
    expect(h.deps.sendShare).not.toHaveBeenCalled();
    expect(h.deps.hostStatus).toBeDefined();
    expect(h.share.linkFor("p1")).toBeNull();
  });

  it("공유 창을 열어(prepare) 확인만 하는 것으로는 켜지지 않는다", async () => {
    const h = rig();
    await started(h);
    await h.share.prepare("p1");
    expect(h.share.getState("p1").kind).toBe("off");
    expect(h.deps.createSession).not.toHaveBeenCalled();
    expect(h.deps.sendShare).not.toHaveBeenCalled();
  });
});

describe("집 채널 기본값 = 이 저장소로 마지막에 공유한 채널 (Q4)", () => {
  it("저장소별로 기억하고, 다른 저장소·워크스페이스에는 새지 않는다", () => {
    const storage = memoryStorage();
    rememberChannelFor(WS, "oort", CH_A, storage);
    rememberChannelFor(WS, "other", CH_B, storage);
    expect(lastChannelFor(WS, "oort", storage)).toBe(CH_A);
    expect(lastChannelFor(WS, "other", storage)).toBe(CH_B);
    expect(lastChannelFor(WS, "never-shared", storage)).toBeNull();
    expect(lastChannelFor("00000000-0000-7000-8000-0000000000ff", "oort", storage)).toBeNull();
    // 저장소를 모르면 기억도 불러오기도 없다: 아무 저장소의 채널을 기본값으로 삼지 않는다.
    rememberChannelFor(WS, null, CH_B, storage);
    expect(lastChannelFor(WS, null, storage)).toBeNull();
    expect(lastChannelFor(WS, "oort", storage)).toBe(CH_A);
  });

  it("prepare가 이 저장소의 마지막 채널을 기본으로 내고, 다른 저장소는 기본이 없다", async () => {
    const h = rig({ repo: "oort" });
    rememberChannelFor(WS, "oort", CH_A, h.storage);
    rememberChannelFor(WS, "momo", CH_B, h.storage);
    await started(h);
    const prep = await h.share.prepare("p1");
    expect(prep).toMatchObject({ host: "ready", repo: "oort", defaultChannelId: CH_A, lockedChannelId: null });
    const fresh = rig({ repo: "brand-new" });
    rememberChannelFor(WS, "oort", CH_A, fresh.storage);
    await started(fresh);
    expect((await fresh.share.prepare("p1")).defaultChannelId).toBeNull();
  });

  it("지금은 고를 수 없는 채널(나간 채널)은 기본으로 내지 않는다", async () => {
    const h = rig({ repo: "oort", channelSelectable: (id) => id === CH_B });
    rememberChannelFor(WS, "oort", CH_A, h.storage);
    await started(h);
    expect((await h.share.prepare("p1")).defaultChannelId).toBeNull();
  });

  it("공유를 켜면 그 채널을 이 저장소의 기본으로 기억한다", async () => {
    const h = rig({ repo: "oort" });
    await started(h);
    expect(await h.share.share("p1", CH_B)).toEqual({ ok: true });
    expect(lastChannelFor(WS, "oort", h.storage)).toBe(CH_B);
  });

  it("공유에 실패하면 기억하지 않는다", async () => {
    const h = rig({
      repo: "oort",
      createSession: vi.fn(async () => {
        throw new ApiError(403, "no", undefined);
      }),
    });
    await started(h);
    const result = await h.share.share("p1", CH_B);
    expect(result).toEqual({ ok: false, reason: "channel_forbidden" });
    expect(lastChannelFor(WS, "oort", h.storage)).toBeNull();
    expect(h.share.getState("p1").kind).toBe("off");
  });
});

describe("채널에 공유 한 번에 (Q5)", () => {
  it("서버에 세션을 만들고(카드는 서버가 올린다) 곧바로 S1 요약을 host 서명 경로로 보낸다", async () => {
    const h = rig({ repo: "oort" });
    await started(h);
    expect(await h.share.share("p1", CH_A)).toEqual({ ok: true });
    await settle();
    expect(h.created).toEqual([
      { channelId: CH_A, hostId: HOST, tool: "claude", label: "claude", folderLabel: "oort" },
    ]);
    expect(h.share.getState("p1")).toMatchObject({ kind: "on", channelId: CH_A, sessionId: SESSION, syncFailed: false });
    // 켜는 순간 한 번 보내고(git 전), 간격 제한(5초) 뒤 git 숫자를 담아 다시 보낸다. 마지막이 최신이다.
    h.advance(6_000);
    await settle();
    expect(h.sent.every((s) => s.sessionId === SESSION)).toBe(true);
    const first = h.sent.at(-1)!;
    expect(first.body).toMatchObject({ shared: true, harness: "claude", state: "running", repo: "oort", branch: "feat/x" });
    // 요약에는 이 S1 필드뿐이다: 경로·커밋 제목·출력이 들어갈 자리가 없다.
    expect(Object.keys(first.body).sort()).toEqual(
      ["branch", "diff", "harness", "lastActivityAt", "prUrl", "repo", "shared", "stages", "state"].sort()
    );
  });

  it("이 맥이 작업 호스트로 등록되지 않았으면 서버를 부르지 않고 등록 길을 가리킨다", async () => {
    const h = rig({ host: { ...REGISTERED, registered: null } });
    await started(h);
    expect(await h.share.share("p1", CH_A)).toEqual({ ok: false, reason: "host_not_registered" });
    expect(h.deps.createSession).not.toHaveBeenCalled();
    expect(h.share.getState("p1").kind).toBe("off");
    expect((await h.share.prepare("p1")).host).toBe("not_registered");
  });

  it("호스트가 꺼져 있거나 다른 워크스페이스에 등록됐거나 브라우저면 서버를 부르지 않는다", async () => {
    const off = rig({ host: { ...REGISTERED, running: false } });
    await started(off);
    expect(await off.share.share("p1", CH_A)).toEqual({ ok: false, reason: "host_not_running" });
    const elsewhere = rig({
      host: { ...REGISTERED, registered: { ...REGISTERED.registered!, workspaceId: "00000000-0000-7000-8000-0000000000ee" } },
    });
    await started(elsewhere);
    expect(await elsewhere.share.share("p1", CH_A)).toEqual({ ok: false, reason: "host_elsewhere" });
    const browser = rig({ host: null });
    await started(browser);
    expect(await browser.share.share("p1", CH_A)).toEqual({ ok: false, reason: "no_shell" });
    for (const r of [off, elsewhere, browser]) expect(r.deps.createSession).not.toHaveBeenCalled();
  });

  it("서버가 등록 안 된 호스트라고 답하면(코드) 같은 안내로 간다", async () => {
    const h = rig({
      createSession: vi.fn(async () => {
        throw new ApiError(403, "x", "local_share_requires_registered_host");
      }),
    });
    await started(h);
    expect(await h.share.share("p1", CH_A)).toEqual({ ok: false, reason: "host_not_registered" });
  });

  it("한도(409 local_share_limit)·연결 실패는 이름 있는 거절이다", async () => {
    const limit = rig({
      createSession: vi.fn(async () => {
        throw new ApiError(409, "x", "local_share_limit");
      }),
    });
    await started(limit);
    expect(await limit.share.share("p1", CH_A)).toEqual({ ok: false, reason: "limit" });
    const down = rig({
      createSession: vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    });
    await started(down);
    expect(await down.share.share("p1", CH_A)).toEqual({ ok: false, reason: "offline" });
  });

  it("집 채널은 바뀌지 않는다: 껐다 켜면 같은 세션·같은 채널이고 세션을 새로 만들지 않는다", async () => {
    const h = rig();
    await started(h);
    await h.share.share("p1", CH_A);
    await settle();
    expect((await h.share.unshare("p1")).ok).toBe(true);
    expect(h.share.getState("p1")).toMatchObject({ kind: "off", channelId: CH_A, sessionId: SESSION });
    expect((await h.share.prepare("p1")).lockedChannelId).toBe(CH_A);
    // 다른 채널을 골라도 집은 그대로다.
    expect(await h.share.share("p1", CH_B)).toEqual({ ok: true });
    expect(h.deps.createSession).toHaveBeenCalledTimes(1);
    expect(h.share.getState("p1")).toMatchObject({ kind: "on", channelId: CH_A, sessionId: SESSION });
  });
});

describe("공유 끄기는 서버를 부른다 (S1 삭제는 서버가 한다)", () => {
  it("{shared:false}를 그 세션으로 보내고, 그 뒤로는 칸이 움직여도 보내지 않는다", async () => {
    const h = rig();
    await started(h);
    await h.share.share("p1", CH_A);
    await settle();
    const before = h.sent.length;
    expect(await h.share.unshare("p1")).toEqual({ ok: true });
    expect(h.sent.at(-1)).toEqual({ sessionId: SESSION, body: { shared: false } });
    expect(h.sent.length).toBe(before + 1);
    expect(h.share.linkFor("p1")).toBeNull();
    // 끈 뒤: 출력·종료·시간이 흘러도 서버로 아무것도 가지 않는다.
    h.emit("still typing\r\n");
    h.exit({ id: 1, code: 0, signal: null });
    h.advance(300_000);
    await settle();
    expect(h.sent.length).toBe(before + 1);
  });

  it("서버가 끄기를 못 받았으면 꺼진 척하지 않는다: 켜진 채로 두고 실패를 말한다", async () => {
    let fail = false;
    const h = rig({
      sendShare: vi.fn(async (sessionId, body) => {
        if (fail) throw "share_unreachable";
        void sessionId;
        void body;
      }),
    });
    await started(h);
    await h.share.share("p1", CH_A);
    await settle();
    fail = true;
    expect(await h.share.unshare("p1")).toEqual({ ok: false, reason: "failed" });
    expect(h.share.getState("p1").kind).toBe("on");
    expect(h.share.getState("p1").syncFailed).toBe(true);
  });

  it("공유 중이 아닌 칸을 끄는 일은 서버를 부르지 않는다", async () => {
    const h = rig();
    await started(h);
    expect(await h.share.unshare("p1")).toEqual({ ok: true });
    expect(h.deps.sendShare).not.toHaveBeenCalled();
  });
});

describe("수집기는 공유가 켜진 칸의 세션으로만 보낸다", () => {
  it("공유를 켠 칸 하나만 보낸다: 다른 칸의 상태 변화는 서버로 가지 않는다", async () => {
    const h = rig();
    await started(h, "p1");
    await started(h, "p2");
    await h.share.share("p1", CH_A);
    await settle();
    const before = h.sent.length;
    h.exit({ id: 2, code: 1, signal: null }); // p2(PTY 2)가 끝났다
    h.advance(60_000);
    await settle();
    expect(h.sent.slice(before).every((s) => s.sessionId === SESSION)).toBe(true);
    expect(h.share.getState("p2").kind).toBe("off");
  });

  it("켜기 요청이 실패한 칸(세션 없음)은 요약을 만들어도 보내지 않는다", async () => {
    const h = rig({
      createSession: vi.fn(async () => {
        throw new ApiError(500, "boom", undefined);
      }),
    });
    await started(h);
    await h.share.share("p1", CH_A);
    h.exit({ id: 1, code: 0, signal: null });
    h.advance(300_000);
    await settle();
    expect(h.deps.sendShare).not.toHaveBeenCalled();
  });

  it("요약을 못 보내면 표지가 말하고(syncFailed), 다음에 보내면 풀린다", async () => {
    let fail = false;
    const h = rig({
      sendShare: vi.fn(async () => {
        if (fail) throw "share_unreachable";
      }),
    });
    await started(h);
    await h.share.share("p1", CH_A);
    await settle();
    fail = true;
    h.exit({ id: 1, code: 0, signal: null });
    h.advance(10_000);
    await settle();
    expect(h.share.getState("p1").syncFailed).toBe(true);
    fail = false;
    h.advance(60_000);
    h.emit("x");
    await settle();
    // 다음 변화가 요약을 다시 보낸다.
    expect(h.share.summaryOf("p1")).not.toBeNull();
  });
});

describe("링크 복사 (Q5)", () => {
  it("링크는 공유된 세션에만 있다: 꺼진 칸은 null, 켜진 칸은 팀 보드 주소", async () => {
    const h = rig();
    await started(h);
    expect(h.share.linkFor("p1")).toBeNull();
    await h.share.share("p1", CH_A);
    expect(h.share.linkFor("p1")).toBe(`https://team.example/work?view=team&card=${SESSION}`);
    await h.share.unshare("p1");
    expect(h.share.linkFor("p1")).toBeNull();
  });
});

describe("칸이 닫히면", () => {
  it("공유했던 세션은 끝낸다(원장에 실행 중이 남지 않는다). 공유한 적 없는 칸은 서버를 부르지 않는다", async () => {
    const h = rig();
    await started(h, "p1");
    await started(h, "p2");
    await h.share.share("p1", CH_A);
    await settle();
    h.sessions.close("p1");
    await settle();
    expect(h.ended).toEqual([SESSION]);
    expect(h.share.getState("p1").kind).toBe("off");
    expect(h.deps.endSession).toHaveBeenCalledTimes(1);
  });
});

describe("hostReadiness", () => {
  it("사이드카 없음·등록 안 됨·다른 서버·꺼짐·정상을 가른다", () => {
    expect(hostReadiness(null, WS, "https://team.example")).toBe("no_shell");
    expect(hostReadiness({ ...REGISTERED, sidecar: false }, WS, "https://team.example")).toBe("not_registered");
    expect(hostReadiness({ ...REGISTERED, registered: null }, WS, "https://team.example")).toBe("not_registered");
    expect(hostReadiness(REGISTERED, WS, "https://other.example")).toBe("elsewhere");
    expect(hostReadiness({ ...REGISTERED, running: false }, WS, "https://team.example")).toBe("not_running");
    expect(hostReadiness(REGISTERED, WS.toUpperCase(), "https://team.example")).toBe("ready");
  });
});

describe("세션 이름은 주인이 정한다 (ADR-0190 D4-b)", () => {
  const SECRET = "/Users/me/secret-repo fix: acme-corp 고객 환불 sk-ant-api03-CANARY";

  it("하네스 제목의 경로·토큰 모양은 기본 이름에서 경로 구분자가 지워지고, 주인이 고친 이름만 서버로 간다", async () => {
    const h = rig();
    await started(h);
    h.mirrors[0]!.setTitle(`◐ ${SECRET}`);
    await settle();
    const prep = await h.share.prepare("p1");
    expect(prep.name).not.toMatch(/[\\/]/);
    expect(prep.name.length).toBeLessThanOrEqual(80);
    await h.share.share("p1", CH_A, "릴리스 노트 초안");
    await settle();
    expect(h.created).toMatchObject([{ label: "릴리스 노트 초안" }]);
    expect(JSON.stringify(h.created)).not.toContain("sk-ant-api03-CANARY");
    expect(JSON.stringify(h.created)).not.toContain("/Users/");
  });

  it("이름을 못 받아도(기본값) 서버로 가는 이름에는 경로 구분자가 없고 80자를 넘지 않는다", async () => {
    const h = rig();
    await started(h);
    h.mirrors[0]!.setTitle(`◐ ${SECRET} ${"가".repeat(200)}`);
    await settle();
    await h.share.share("p1", CH_A);
    const label = (h.created[0] as { label: string }).label;
    expect(label).not.toMatch(/[\\/]/);
    expect(label.length).toBeLessThanOrEqual(80);
    expect(label.length).toBeGreaterThan(0);
  });

  it("빈 이름은 프로그램 이름으로 돌아간다", async () => {
    const h = rig();
    await started(h);
    await h.share.share("p1", CH_A, "   ");
    expect(h.created).toMatchObject([{ label: "claude" }]);
  });
});

describe("경합", () => {
  it("서버가 세션을 만드는 사이 칸이 닫히면 그 세션을 바로 끝내고 켜지 않는다", async () => {
    let release: (v: { id: string; channelId: string }) => void = () => undefined;
    const h = rig({
      createSession: vi.fn(
        () =>
          new Promise<{ id: string; channelId: string }>((resolve) => {
            release = resolve;
          })
      ),
    });
    await started(h);
    const pending = h.share.share("p1", CH_A);
    await settle();
    h.sessions.close("p1");
    release({ id: SESSION, channelId: CH_A });
    expect(await pending).toEqual({ ok: false, reason: "no_pane" });
    await settle();
    expect(h.ended).toEqual([SESSION]);
    expect(h.deps.sendShare).not.toHaveBeenCalled();
    expect(h.share.getState("p1").kind).toBe("off");
  });

  it("같은 칸에 공유가 동시에 두 번 들어와도 세션은 하나만 만든다", async () => {
    const h = rig();
    await started(h);
    await Promise.all([h.share.share("p1", CH_A), h.share.share("p1", CH_A)]);
    await settle();
    expect(h.deps.createSession).toHaveBeenCalledTimes(1);
  });
});
