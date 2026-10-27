// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { StopRunControl, STOP_ARM_NAME } from "./StopRunControl";

// =============================================================================
// 작업 패널의 「중단」 (#3852). 지키는 것:
//   1. 끝나지 않은 run에만, 연결이 살아 있을 때만 버튼이 선다.
//   2. 첫 클릭은 아무것도 보내지 않는다(묻는다).
//   3. 보내는 길은 `POST …/agent-runs/{run}/cancel` 하나다 — 세션 kill이 아니다.
//      그래서 `cancelAgentRun`을 mock하지 않고 fetch까지 내려가 URL을 잰다.
//   4. 권한 없음·이미 끝남·없음은 해요체 문장이고 상태 코드가 보이지 않는다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const RUN = "0199aa11-2222-7000-8000-0000000000c1";

let root: Root | null = null;
let host: HTMLElement | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function answer(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mount(props: { open?: boolean; live?: boolean } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = { workspaceId: WS } as unknown as SessionContextValue;
  const draw = (next: { open?: boolean; live?: boolean }) =>
    act(() => {
      root?.render(
        createElement(
          QueryClientProvider,
          { client },
          createElement(
            SessionProvider,
            { value: session },
            createElement(StopRunControl, {
              runId: RUN,
              agentName: "김인턴",
              open: next.open ?? true,
              live: next.live ?? true,
            })
          )
        )
      );
    });
  draw(props);
  return draw;
}

const q = (id: string) =>
  host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

async function click(id: string) {
  await act(async () => {
    q(id)?.click();
  });
}

const settle = async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
};

const cancelCalls = () =>
  fetchMock.mock.calls.filter((call) => String(call[0]).includes("/cancel"));

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  fetchMock = vi.fn(async () =>
    answer(200, {
      runId: RUN,
      status: "cancelled",
      linkedWorkSessionIds: [],
      workSessionsTerminated: false,
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe("언제 서는가", () => {
  it("열린 run이고 연결이 살아 있으면 「중단」이 서고, 이름은 묻기만 한다는 것을 말한다", () => {
    mount();
    const arm = q("agent-work-panel-stop-arm");
    expect(arm?.textContent).toBe("중단");
    expect(arm?.getAttribute("aria-label")).toBe(STOP_ARM_NAME);
    // label-in-name: 보이는 낱말이 이름 안에 있다.
    expect(STOP_ARM_NAME).toContain("중단");
  });

  it("끝난 run에는 버튼이 없다", () => {
    mount({ open: false });
    expect(q("agent-work-panel-stop")).toBeNull();
    expect(q("agent-work-panel-stop-arm")).toBeNull();
  });

  it("연결이 끊긴 동안에는 버튼이 없다", () => {
    mount({ live: false });
    expect(q("agent-work-panel-stop-arm")).toBeNull();
  });
});

describe("누르는 면 (#4619 design-review r1 M3)", () => {
  it("「중단」과 「그대로 두기」도 폰 폭 44(tap-target)다 — 「취소 확정」만 44면 위험한 쪽이 더 큰 표적이 된다", async () => {
    mount();
    expect(q("agent-work-panel-stop-arm")?.classList.contains("tap-target")).toBe(true);
    await click("agent-work-panel-stop-arm");
    expect(q("agent-work-panel-stop-keep")?.classList.contains("tap-target")).toBe(true);
  });
});

describe("두 번 누른다 — 첫 번째는 아무것도 보내지 않는다", () => {
  it("첫 클릭은 확인 문장과 안전한 쪽 초점, 요청 0건", async () => {
    mount();
    await click("agent-work-panel-stop-arm");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q("agent-work-panel-stop-confirm")?.textContent).toContain(
      "중단하면 이 실행은 여기서 끝나요."
    );
    expect(document.activeElement).toBe(q("agent-work-panel-stop-keep"));
    await click("agent-work-panel-stop-keep");
    expect(q("agent-work-panel-stop-confirm")).toBeNull();
    expect(document.activeElement).toBe(q("agent-work-panel-stop-arm"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("확정은 run 취소 경로로 POST 한 번 — 세션 kill 경로가 아니다", async () => {
    mount();
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    await settle();
    expect(cancelCalls()).toHaveLength(1);
    const [url, init] = cancelCalls()[0] as [string, RequestInit];
    expect(String(url)).toMatch(
      new RegExp(`/v1/workspaces/${WS}/agent-runs/${RUN}/cancel$`)
    );
    expect(init.method).toBe("POST");
    expect(fetchMock.mock.calls.some((call) => /work-sessions|\/kill/.test(String(call[0])))).toBe(
      false
    );
    const outcome = q("agent-work-panel-stop-outcome");
    expect(outcome?.textContent).toBe("김인턴의 실행을 중단했어요.");
    expect(outcome?.getAttribute("role")).toBe("status");
    // 이미 답을 받았으므로 서버 칩이 따라오기 전이라도 다시 권하지 않는다.
    expect(q("agent-work-panel-stop-arm")).toBeNull();
  });

  it("보내는 중 두 번째 클릭은 요청을 하나 더 내지 않는다", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(
      () => new Promise<Response>((resolve) => (release = resolve))
    );
    mount();
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    expect(q("agent-work-panel-stop-commit")?.textContent).toContain("중단 중");
    expect(q("agent-work-panel-stop-commit")?.getAttribute("aria-disabled")).toBe("true");
    await click("agent-work-panel-stop-commit");
    expect(cancelCalls()).toHaveLength(1);
    await act(async () => {
      release(
        answer(200, {
          runId: RUN,
          status: "cancelled",
          linkedWorkSessionIds: [],
          workSessionsTerminated: false,
        })
      );
    });
    await settle();
    expect(cancelCalls()).toHaveLength(1);
  });
});

describe("거절은 문장으로", () => {
  it.each([
    [403, { error: { message: "active human channel member required" } }, "error", "중단하지 못했어요. 이 실행이 있는 채널의 멤버만 중단할 수 있어요."],
    [409, { error: { message: "agent run is already succeeded" } }, "alreadyOver", "이 실행은 이미 끝났어요. 에이전트가 먼저 마쳤어요."],
    [404, { error: { message: "agent run not found" } }, "error", "중단하지 못했어요. 그 실행이 이미 없어졌거나, 이 서버가 실행 중단을 아직 받지 않아요."],
  ])("%i → %s", async (status, body, kind, sentence) => {
    fetchMock.mockImplementation(async () => answer(status as number, body));
    mount();
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    await settle();
    const outcome = q("agent-work-panel-stop-outcome");
    expect(outcome?.getAttribute("data-kind")).toBe(kind);
    expect(outcome?.textContent).toBe(sentence);
    expect(outcome?.textContent).not.toMatch(/\d{3}/);
    if (kind === "alreadyOver") {
      // 이미 끝난 실행에는 더 물을 것이 없다.
      expect(q("agent-work-panel-stop-confirm")).toBeNull();
      expect(q("agent-work-panel-stop-arm")).toBeNull();
    } else {
      // 실패는 다시 누를 수 있다. 확인 줄은 그대로다.
      expect(q("agent-work-panel-stop-commit")).not.toBeNull();
      expect(outcome?.getAttribute("role")).toBe("alert");
    }
  });

  it("끝난 run으로 바뀌어도 방금 낸 문장은 남는다", async () => {
    const draw = mount();
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    await settle();
    draw({ open: false });
    expect(q("agent-work-panel-stop-outcome")?.textContent).toBe("김인턴의 실행을 중단했어요.");
  });
});

describe("답이 선 뒤 캐럿 (#3854 design-review H-1)", () => {
  // 중단됨·이미 끝남이면 확정 버튼이 사라진다. 키보드로 누른 사람의 캐럿이 <body>로
  // 떨어지지 않고 방금 선 문장에 놓여야 한다. jsdom의 `.click()`은 초점을 옮기지
  // 않으므로 키보드처럼 먼저 초점을 놓고 누른다.
  async function commitFromKeyboard() {
    await click("agent-work-panel-stop-arm");
    act(() => q("agent-work-panel-stop-commit")?.focus());
    expect(document.activeElement).toBe(q("agent-work-panel-stop-commit"));
    await click("agent-work-panel-stop-commit");
    await settle();
  }

  it("중단됨: 캐럿이 영수증 문장으로 간다", async () => {
    mount();
    await commitFromKeyboard();
    const outcome = q("agent-work-panel-stop-outcome");
    expect(outcome?.getAttribute("data-kind")).toBe("cancelled");
    expect(document.activeElement).toBe(outcome);
    expect(outcome?.getAttribute("tabindex")).toBe("-1");
  });

  it("이미 끝남(409): 캐럿이 문장으로 가고, 원장을 다시 읽는다", async () => {
    const invalidate = vi.spyOn(QueryClient.prototype, "invalidateQueries");
    fetchMock.mockImplementation(async () =>
      answer(409, { error: { message: "agent run is already succeeded" } })
    );
    mount();
    await commitFromKeyboard();
    const outcome = q("agent-work-panel-stop-outcome");
    expect(outcome?.getAttribute("data-kind")).toBe("alreadyOver");
    expect(document.activeElement).toBe(outcome);
    expect(
      invalidate.mock.calls.some(
        ([filters]) =>
          JSON.stringify((filters as { queryKey?: unknown })?.queryKey) ===
          JSON.stringify(["agent-run-events", WS, RUN.toLowerCase()])
      )
    ).toBe(true);
    invalidate.mockRestore();
  });

  it("실패(403): 캐럿은 확정 버튼에 남는다", async () => {
    fetchMock.mockImplementation(async () =>
      answer(403, { error: { message: "active human channel member required" } })
    );
    mount();
    await commitFromKeyboard();
    expect(document.activeElement).toBe(q("agent-work-panel-stop-commit"));
  });

  it("캐럿이 패널 밖에 있었으면 옮기지 않는다", async () => {
    const elsewhere = document.createElement("button");
    document.body.appendChild(elsewhere);
    mount();
    await click("agent-work-panel-stop-arm");
    act(() => elsewhere.focus());
    await click("agent-work-panel-stop-commit");
    await settle();
    expect(q("agent-work-panel-stop-outcome")?.getAttribute("data-kind")).toBe("cancelled");
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });
});
