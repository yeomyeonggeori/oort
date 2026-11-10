// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkHost, type WorkSession } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5595 (ADR-0188 D3): 웹·데스크탑 세션 상세의 멈추기가 kill 라우트로 간다. 폰과 같은 길·같은 문장이다.
// `PATCH ended`(원장 종료)는 맥에 닿지 않으니 내 맥 세션에서는 쓰지 않고, kill 라우트가 규칙상 받지 않는 세션
// (공용 호스트·맥에서 직접 연 창)에만 남는다. 화면은 진짜 `WorkSessionDetail`이고, 서버 호출 두 개만 대역이다.
// =============================================================================

const api = vi.hoisted(() => ({
  kill: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    killWorkSession: (...args: unknown[]) => api.kill(...args),
    endWorkSession: (...args: unknown[]) => api.end(...args),
  };
});
vi.mock("./useWorkSessions", () => ({
  useSessionEvents: () => ({
    events: [],
    truncated: false,
    isPending: false,
    error: null,
    data: { events: [], truncated: false },
    refetch: vi.fn(),
  }),
  useSessionVerification: () => null,
}));
vi.mock("./signedWork", () => ({
  useHumanControlSigning: () => ({ signatureRequired: false, signed: false, recheck: () => undefined }),
  useResumeWorkSession: () => async () => {
    throw new Error("unused");
  },
}));
vi.mock("@/features/workstreams/useWorkstreams", () => ({ useSessionWorkstream: () => ({ data: undefined }) }));
vi.mock("./DisplayObserver", () => ({ DisplayObserver: () => null }));
vi.mock("./DisplayController", () => ({ ControlInvite: () => null, DisplayController: () => null }));
vi.mock("./ObserverTerminal", () => ({ ObserverTerminal: () => null, TerminalShortNotice: () => null }));
vi.mock("./TakeoverBlock", () => ({ TakeoverBlock: () => null }));

import { WorkSessionDetail } from "./WorkSessionDetail";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const TEAMMATE = "00000000-0000-7000-8000-000000000102";
const MAC = "00000000-0000-7000-8000-000000000302";
const SHARED_HOST = "00000000-0000-7000-8000-000000000303";
const SID = "00000000-0000-7000-8000-0000000000a1";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: SID,
    workspaceId: WS,
    channelId: "00000000-0000-7000-8000-000000000201",
    memberId: ME,
    hostId: MAC,
    rootMessageId: "00000000-0000-7000-8000-0000000000b1",
    tool: "claude",
    label: "UI 검수",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: false,
    remoteDisplayAvailable: false,
    startedAtMs: 1_800_000_000_000,
    origin: "host",
    ...overrides,
  };
}

function workHost(overrides: Partial<WorkHost> = {}): WorkHost {
  return {
    id: MAC,
    workspaceId: WS,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "내 맥북",
    capabilities: {},
    createdAtMs: 1_700_000_000_000,
    online: true,
    ...overrides,
  };
}

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  api.kill.mockReset();
  api.end.mockReset();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function render(current: WorkSession, hosts: WorkHost[] | undefined): void {
  const value = { workspaceId: WS, connStatus: "connected", session: { member: { id: ME } } } as unknown as SessionContextValue;
  act(() => {
    root?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(SessionProvider, {
          value,
          children: createElement(LocaleProvider, {
            locale: ko,
            children: createElement(WorkSessionDetail, {
              session: current,
              hosts,
              directory: makeDirectory([]),
              channelName: "릴리스",
              liveEvents: [],
              controlFrames: [],
              live: true,
              nowMs: 1_800_000_060_000,
              wide: false,
              onWideChange: () => undefined,
              onBack: () => undefined,
              openingThread: false,
              onOpenThread: () => undefined,
              onResumed: () => undefined,
            }),
          }),
        })
      )
    );
  });
}

function mount(current: WorkSession, hosts: WorkHost[] | undefined = [workHost()]): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  render(current, hosts);
  return host;
}

const byTestId = (el: ParentNode, id: string) => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** 멈추기 → 확인 → 그 답이 화면에 닿을 때까지. */
async function confirmStop(el: HTMLElement): Promise<void> {
  act(() => byTestId(el, "work-end-session")?.click());
  await act(async () => {
    byTestId(el, "work-end-commit")?.click();
    for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
  });
}

describe("웹·데스크탑 멈추기는 kill 라우트다 (#5595)", () => {
  it("내 맥에서 도는 내 세션: 「멈추기」 → 확인 → killWorkSession(워크스페이스, 세션)을 부르고 PATCH ended는 부르지 않는다", async () => {
    api.kill.mockResolvedValue({ sessionStatus: "running", hostOnline: true, replayed: false });
    const el = mount(session());
    expect(byTestId(el, "work-end-session")?.textContent).toBe("멈추기");
    act(() => byTestId(el, "work-end-session")?.click());
    expect(byTestId(el, "work-end-warning")?.textContent).toBe(
      "이 작업을 멈출까요? 맥에서 돌고 있는 작업을 끝내요. 지금까지의 진행 내역은 남아요."
    );
    await act(async () => {
      byTestId(el, "work-end-commit")?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(api.kill).toHaveBeenCalledTimes(1);
    expect(api.kill).toHaveBeenCalledWith(WS, SID);
    expect(api.end).not.toHaveBeenCalled();
    expect(byTestId(el, "work-stop-requested")?.textContent).toBe(
      "멈추기를 요청했어요. 맥이 멈추면 여기에 바로 보여요."
    );
    // 요청이 닿은 뒤에는 다시 누를 단추가 아니다(서버는 몇 번을 눌러도 한 줄이지만 화면이 그걸 권하지 않는다).
    expect((byTestId(el, "work-end-session") as HTMLButtonElement).disabled).toBe(true);
  });

  it("맥이 꺼져 있으면 「멈췄다」가 아니라 코어 문장 「맥이 켜지면 멈춰요」를 말한다", async () => {
    api.kill.mockResolvedValue({ sessionStatus: "running", hostOnline: false, replayed: false });
    const el = mount(session());
    await confirmStop(el);
    const line = byTestId(el, "work-stop-requested");
    expect(line?.textContent).toBe("맥이 꺼져 있어요. 맥이 켜지면 멈춰요.");
    expect(line?.getAttribute("role")).toBe("status");
    expect(line?.textContent).not.toContain("멈췄어요");
  });

  it("원장이 ended를 말하면 그때 「멈췄어요.」다", async () => {
    api.kill.mockResolvedValue({ sessionStatus: "running", hostOnline: true, replayed: false });
    const el = mount(session());
    await confirmStop(el);
    render(session({ status: "ended", endedAtMs: 1_800_000_070_000 }), [workHost()]);
    expect(byTestId(el, "work-stop-requested")?.textContent).toBe("멈췄어요.");
    // 내가 멈춘 세션에 「이미 멈췄거나 연결이 끊긴 작업」 이유 줄을 덧붙이지 않는다.
    expect(byTestId(el, "work-end-reason")).toBeNull();
  });

  it("거절은 코드별 코어 문장이고, 확인 단추가 남아 다시 누를 수 있다", async () => {
    api.kill.mockRejectedValue(new ApiError(409, "the work session is not running", "work_session_not_running"));
    const el = mount(session());
    await confirmStop(el);
    expect(byTestId(el, "work-end-error")?.textContent).toBe("이미 멈췄거나 연결이 끊긴 작업이에요.");
    expect(byTestId(el, "work-stop-requested")).toBeNull();
    const again = byTestId(el, "work-end-commit") as HTMLButtonElement;
    expect(again.disabled).toBe(false);
    await act(async () => {
      again.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(api.kill).toHaveBeenCalledTimes(2);
  });

  it("호스트 목록을 아직 모르면 kill로 간다(서버가 마지막 판정자다)", async () => {
    api.kill.mockResolvedValue({ sessionStatus: "running", hostOnline: true, replayed: false });
    const el = mount(session(), undefined);
    await confirmStop(el);
    expect(api.kill).toHaveBeenCalledTimes(1);
    expect(api.end).not.toHaveBeenCalled();
  });
});

describe("화면이 내놓는 것 = kill 라우트가 받는 것 (#5595, work_kill.rs)", () => {
  it("남의 세션: 단추는 잠기고 이유는 코어 문장이다. 아무 라우트도 부르지 않는다", () => {
    const el = mount(session({ memberId: TEAMMATE }), [workHost({ ownerMemberId: TEAMMATE })]);
    const button = byTestId(el, "work-end-session") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(byTestId(el, "work-end-reason")?.textContent).toBe(
      "멈추기: 작업을 시작한 사람의 맥에서만 멈출 수 있어요."
    );
    act(() => button.click());
    expect(api.kill).not.toHaveBeenCalled();
    expect(api.end).not.toHaveBeenCalled();
  });

  it("끝났거나 끊긴 내 세션: 잠기고 이유를 말한다", () => {
    for (const status of ["ended", "orphaned"] as const) {
      const el = mount(session({ status }));
      expect((byTestId(el, "work-end-session") as HTMLButtonElement).disabled, status).toBe(true);
      expect(byTestId(el, "work-end-reason")?.textContent, status).toBe(
        "멈추기: 이미 멈췄거나 연결이 끊긴 작업이에요."
      );
      act(() => root?.unmount());
      root = null;
      host?.remove();
    }
  });

  it("공용 호스트(scope=workspace)의 세션은 kill 라우트가 받지 않으니 지금까지의 원장 종료다", async () => {
    api.end.mockResolvedValue(session({ status: "ended" }));
    const el = mount(session({ hostId: SHARED_HOST }), [
      workHost(),
      workHost({ id: SHARED_HOST, scope: "workspace", type: "remote", displayName: "팀 서버" }),
    ]);
    expect(byTestId(el, "work-end-session")?.textContent).toBe("세션 종료");
    await confirmStop(el);
    expect(api.end).toHaveBeenCalledWith(WS, SID);
    expect(api.kill).not.toHaveBeenCalled();
    expect(byTestId(el, "work-end-done")?.textContent).toBe("세션 기록을 닫았어요.");
  });

  it("원장 종료의 확인 문장은 실제로 일어나는 일(기록만 닫힘)을 말한다 — 호스트의 작업이 끝난다고 말하지 않는다 (work_kill.rs 「PATCH ended」, design-review M-3)", () => {
    const el = mount(session({ origin: "local_pty" }));
    act(() => byTestId(el, "work-end-session")?.click());
    const warning = byTestId(el, "work-end-warning")?.textContent ?? "";
    expect(warning).toBe("세션 기록만 닫아요. 호스트에서 돌던 작업은 그대로 남을 수 있어요.");
    expect(warning).not.toMatch(/정리됩니다|끝냅니다/);
  });

  it("맥에서 직접 연 창(local_pty)도 원장 종료다", async () => {
    api.end.mockResolvedValue(session({ status: "ended" }));
    const el = mount(session({ origin: "local_pty" }));
    await confirmStop(el);
    expect(api.end).toHaveBeenCalledTimes(1);
    expect(api.kill).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 캐럿과 낭독 (#5595 design-review H-1, 같은 클라 `StopRunControl` #3854 H-1과 같은 규칙). 누른 단추가 확인 줄로 바뀌면
// 그 단추가 사라진다. 캐럿이 <body>로 떨어지지 않고 안전한 쪽(취소)으로, 접으면 무장 단추로, 답이 서면 방금 선 문장으로
// 간다. jsdom의 `.click()`은 초점을 옮기지 않으므로 키보드처럼 먼저 초점을 놓고 누른다.
// =============================================================================

describe("멈추기의 캐럿과 낭독 (#5595 design-review H-1)", () => {
  function arm(el: HTMLElement): void {
    act(() => byTestId(el, "work-end-session")?.focus());
    expect(document.activeElement).toBe(byTestId(el, "work-end-session"));
    act(() => byTestId(el, "work-end-session")?.click());
  }

  async function commitFromKeyboard(el: HTMLElement): Promise<void> {
    arm(el);
    act(() => byTestId(el, "work-end-commit")?.focus());
    expect(document.activeElement).toBe(byTestId(el, "work-end-commit"));
    await act(async () => {
      byTestId(el, "work-end-commit")?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
  }

  it("무장하면 캐럿은 안전한 쪽(취소)이고, 묻는 문장이 단추보다 먼저 오며 두 단추의 설명이다", () => {
    const el = mount(session());
    arm(el);
    expect(document.activeElement).toBe(byTestId(el, "work-end-cancel"));
    const question = byTestId(el, "work-end-warning")!;
    expect(question.id).not.toBe("");
    expect(byTestId(el, "work-end-commit")?.getAttribute("aria-describedby")).toBe(question.id);
    expect(byTestId(el, "work-end-cancel")?.getAttribute("aria-describedby")).toBe(question.id);
    // 읽는 순서: 질문 → 단추.
    const confirm = byTestId(el, "work-end-confirm")!;
    expect(question.compareDocumentPosition(confirm) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("취소하면 캐럿이 「멈추기」 단추로 돌아온다", () => {
    const el = mount(session());
    arm(el);
    act(() => byTestId(el, "work-end-cancel")?.click());
    expect(byTestId(el, "work-end-confirm")).toBeNull();
    expect(document.activeElement).toBe(byTestId(el, "work-end-session"));
  });

  it("답이 서면 캐럿이 그 문장(상태 영역, 탭 순서 밖)으로 간다 — 맥 꺼짐 문장이 읽힌다", async () => {
    api.kill.mockResolvedValue({ sessionStatus: "running", hostOnline: false, replayed: false });
    const el = mount(session());
    await commitFromKeyboard(el);
    const line = byTestId(el, "work-stop-requested");
    expect(line?.textContent).toBe("맥이 꺼져 있어요. 맥이 켜지면 멈춰요.");
    expect(document.activeElement).toBe(line);
    expect(line?.getAttribute("tabindex")).toBe("-1");
    expect(line?.getAttribute("role")).toBe("status");
  });

  it("실패하면 캐럿은 확정 단추에 남는다(다시 누를 수 있다)", async () => {
    api.kill.mockRejectedValue(new ApiError(500, "boom", "internal"));
    const el = mount(session());
    await commitFromKeyboard(el);
    expect(byTestId(el, "work-end-error")?.getAttribute("role")).toBe("alert");
    expect(document.activeElement).toBe(byTestId(el, "work-end-commit"));
  });

  it("캐럿이 이 줄 밖에 있었으면 옮기지 않는다", async () => {
    api.kill.mockResolvedValue({ sessionStatus: "running", hostOnline: true, replayed: false });
    const elsewhere = document.createElement("button");
    document.body.append(elsewhere);
    const el = mount(session());
    arm(el);
    act(() => elsewhere.focus());
    await act(async () => {
      byTestId(el, "work-end-commit")?.click();
      for (let turn = 0; turn < 6; turn += 1) await Promise.resolve();
    });
    expect(byTestId(el, "work-stop-requested")).not.toBeNull();
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it("원장 종료 갈래도 같다: 답 문장으로 캐럿이 간다", async () => {
    api.end.mockResolvedValue(session({ status: "ended" }));
    const el = mount(session({ origin: "local_pty" }));
    await commitFromKeyboard(el);
    const done = byTestId(el, "work-end-done");
    expect(document.activeElement).toBe(done);
    expect(done?.getAttribute("role")).toBe("status");
  });
});
