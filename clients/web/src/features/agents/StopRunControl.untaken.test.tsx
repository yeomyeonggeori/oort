// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { cancelWordingFor, UNTAKEN_WORDING } from "@momo/core/features/agents/runCancel";
import { StopRunControl } from "./StopRunControl";

// =============================================================================
// 작업 패널의 「취소」 (#4285). 아직 아무도 가져가지 않은 요청에는 「중단」이 거짓이라(돌고 있는 것이
// 없다) 같은 컨트롤이 「취소」 한 벌로 말한다. 호출(`POST …/agent-runs/{run}/cancel`)·한 겹의 확인·
// 409와 오류를 읽는 규칙은 「중단」과 같다(`StopRunControl.test.tsx`가 잰다). 여기서 지키는 것은
// 낱말·확인 문장·영수증이 한 벌로 바뀌고, 가져간 뒤의 run은 그대로 「중단」이라는 것이다.
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

function mount(wording?: typeof UNTAKEN_WORDING) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  const session = { workspaceId: WS } as unknown as SessionContextValue;
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
            agentName: "달무리봇",
            open: true,
            live: true,
            ...(wording === undefined ? {} : { wording }),
          })
        )
      )
    );
  });
}

const q = (id: string) => host?.querySelector<HTMLElement>(`[data-testid="${id}"]`) ?? null;

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

const cancelCalls = () => fetchMock.mock.calls.filter((call) => String(call[0]).includes("/cancel"));

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

describe("아직 아무도 가져가지 않은 요청: 「취소」 한 벌", () => {
  it("첫 클릭은 묻기만 한다 — 낱말·이름·확인 문장이 취소이고 요청은 0건", async () => {
    mount(UNTAKEN_WORDING);
    const arm = q("agent-work-panel-stop-arm");
    expect(arm?.textContent).toBe("취소");
    expect(arm?.getAttribute("aria-label")).toBe("요청 취소, 확인 필요");
    await click("agent-work-panel-stop-arm");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q("agent-work-panel-stop-confirm")?.textContent).toContain(
      "취소하면 이 요청은 여기서 끝나요. 같은 일은 다시 시킬 수 있어요."
    );
    expect(q("agent-work-panel-stop-commit")?.textContent).toBe("취소 확정");
    expect(q("agent-work-panel-stop-confirm")?.textContent).not.toContain("중단");
  });

  it("확정은 같은 취소 경로로 POST 한 번이고, 영수증은 요청을 취소했다고 말한다", async () => {
    mount(UNTAKEN_WORDING);
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    await settle();
    expect(cancelCalls()).toHaveLength(1);
    const [url, init] = cancelCalls()[0] as [string, RequestInit];
    expect(String(url)).toMatch(new RegExp(`/v1/workspaces/${WS}/agent-runs/${RUN}/cancel$`));
    expect(init.method).toBe("POST");
    expect(q("agent-work-panel-stop-outcome")?.textContent).toBe("달무리봇의 요청을 취소했어요.");
  });

  it("보내는 동안 확정 버튼은 「취소 중」이라고 말한다", async () => {
    let release: (r: Response) => void = () => {};
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => (release = resolve)));
    mount(UNTAKEN_WORDING);
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    expect(q("agent-work-panel-stop-commit")?.textContent).toContain("취소 중");
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
  });

  it("409(이미 끝났다)를 읽는 규칙은 「중단」과 같다 — 낱말만 다르고 답은 같다", async () => {
    fetchMock.mockImplementation(async () =>
      answer(409, { error: { message: "agent run is already succeeded" } })
    );
    mount(UNTAKEN_WORDING);
    await click("agent-work-panel-stop-arm");
    await click("agent-work-panel-stop-commit");
    await settle();
    const outcome = q("agent-work-panel-stop-outcome");
    expect(outcome?.getAttribute("data-kind")).toBe("alreadyOver");
    expect(outcome?.textContent).toBe("이 실행은 이미 끝났어요. 에이전트가 먼저 마쳤어요.");
  });
});

describe("낱말을 고르는 규칙", () => {
  it("생략하면 기존 「중단」이다 (가져간 뒤의 run·서버가 모르는 run)", () => {
    mount();
    expect(q("agent-work-panel-stop-arm")?.textContent).toBe("중단");
  });

  it("서버가 queued라고 답한 run만 「취소」다", () => {
    expect(cancelWordingFor({ phase: "queued" }).action).toBe("취소");
    for (const phase of ["claimed", "running", "awaiting_approval", "paused"] as const) {
      expect(cancelWordingFor({ phase }).action).toBe("중단");
    }
  });

  it("작업 패널이 서버의 run 사실로 낱말을 고른다 (배선)", () => {
    // 패널 전체를 그리는 하네스는 없다(게이트 `gate:work-panel`이 브라우저로 잰다). 그래서 이 한 줄의
    // 배선을 소스에서 잠근다: 패널이 컨트롤에 `cancelWordingFor(server)`를 넘기지 않으면 홈·활동 줄은
    // 「취소」인데 패널만 「중단」이라고 말하게 된다.
    const panel = readFileSync(
      resolve(__dirname, "AgentWorkPanel.tsx"),
      "utf8"
    );
    expect(panel).toMatch(/<StopRunControl[\s\S]*?wording=\{cancelWordingFor\(server\)\}[\s\S]*?\/>/);
  });
});
