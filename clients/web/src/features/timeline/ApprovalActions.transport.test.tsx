// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installCoreHost, resetCoreHost } from "@momo/core/runtime/host";

// 승인 결정의 401 갱신 (#3926).
//
// `decideApproval`은 코어 함수이고 웹의 두 카드(타임라인·인박스)가 이 컨트롤로 부른다.
// 코어 전송이 `authedResponse`로 바뀌었으니, 웹 사용처가 **실제 코어 전송**으로 같은
// 일을 하는지 한 번은 컴포넌트에서 본다. 코어 함수는 목으로 바꾸지 않는다 — 바꾸면 이
// 시험이 코어가 아니라 목을 재게 된다.
//   1. 접근 토큰이 죽어 있어도 한 번 누르면 결정된다(401 → 갱신 → 같은 요청).
//   2. 갱신이 안 되면 사고로 그려진다: 빨간 alert 한 줄, 결정은 나가지 않았다.
//   3. 이미 결정된 것(409)은 갱신 없이 예전처럼 상태 전이로 읽힌다.

vi.mock("@/app/session", () => ({
  useSession: () => ({ workspaceId: "019f9b10-0000-7000-8000-000000000001" }),
}));

const { ApprovalActions } = await import("./ApprovalActions");

const WS = "019f9b10-0000-7000-8000-000000000001";
const APPROVAL = "019f9b10-0000-7000-8000-0000000000a1";
const DECISION_PATH = `/v1/workspaces/${WS}/approvals/${APPROVAL}/decision`;
const REFRESH_PATH = "/v1/auth/refresh";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface Sent {
  path: string;
  bearer: string | null;
  body: Record<string, unknown> | null;
}

function answer(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UNAUTHORIZED = () => answer(401, { error: { message: "unauthorized" } });
const ROTATED = () => answer(200, { accessToken: "access-new", refreshToken: "refresh-2" });
const RECEIPT = () =>
  answer(200, { approval_id: APPROVAL, status: "approved", decided_by: "m1", decided_at_ms: 1 });

/** 상태를 가진 호스트 세션과 fetch. 모자란 응답은 던지되, 던지기 전에 기록한다. */
function stage(answers: Array<Response | Error>) {
  const session = { access: "access-old", refresh: "refresh-1", expired: 0 };
  installCoreHost({
    apiBase: () => "",
    absoluteApiBase: () => "https://oort.test",
    buildMode: () => "test",
    session: {
      getAccessToken: () => session.access,
      getRefreshToken: () => session.refresh,
      getPersistedSession: () => null,
      applyLogin: () => {},
      applyRotation: (access, refresh) => {
        session.access = access;
        session.refresh = refresh;
      },
      markAuthExpired: () => {
        session.expired += 1;
      },
      clearSession: () => {},
    },
  });
  const sent: Sent[] = [];
  const queue = [...answers];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      sent.push({
        path: String(url),
        bearer: new Headers(init?.headers).get("Authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const next = queue.shift();
      if (next === undefined) throw new Error(`unexpected request ${String(url)}`);
      if (next instanceof Error) throw next;
      return next;
    })
  );
  return { sent, session };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  resetCoreHost();
});

async function pressApprove(onSettled: ReturnType<typeof vi.fn>) {
  act(() => {
    root.render(<ApprovalActions approvalId={APPROVAL} onSettled={onSettled} />);
  });
  const button = host.querySelector<HTMLButtonElement>('[data-testid="approval-approve"]');
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
  });
  // 결정은 비동기 왕복이다. 응답이 컴포넌트까지 오도록 타이머 한 바퀴를 몇 번 돈다.
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("승인 컨트롤은 죽은 접근 토큰으로도 한 번 누르면 결정된다 (#3926)", () => {
  it("401이면 한 번 갱신하고 같은 멱등 키로 다시 보내 결정을 알린다", async () => {
    const { sent } = stage([UNAUTHORIZED(), ROTATED(), RECEIPT()]);
    const onSettled = vi.fn();

    await pressApprove(onSettled);

    expect(sent.map((request) => request.path)).toEqual([
      DECISION_PATH,
      REFRESH_PATH,
      DECISION_PATH,
    ]);
    expect(sent[0]?.bearer).toBe("Bearer access-old");
    expect(sent[2]?.bearer).toBe("Bearer access-new");
    expect(sent[0]?.body?.client_decision_id).toEqual(expect.any(String));
    expect(sent[2]?.body).toEqual(sent[0]?.body);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ kind: "committed", status: "approved" });
    expect(host.querySelector('[data-testid="approval-error"]')).toBeNull();
  });

  it("갱신이 거절되면 결정을 알리지 않고 빨간 한 줄로 로그인 만료를 말한다", async () => {
    const { sent, session } = stage([UNAUTHORIZED(), UNAUTHORIZED()]);
    const onSettled = vi.fn();

    await pressApprove(onSettled);

    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH, REFRESH_PATH]);
    expect(onSettled).not.toHaveBeenCalled();
    const error = host.querySelector('[data-testid="approval-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toMatch(/로그인이 만료/);
    // 서버가 갱신을 거절했다: 세션이 끝났다는 선언이 나간다(닿지 못한 갈래와 갈리는 지점).
    expect(session.expired).toBeGreaterThan(0);
    // 다시 누를 자리는 남아 있다: 보내는 중에 갇히지 않는다.
    const button = host.querySelector('[data-testid="approval-approve"]');
    expect(button?.getAttribute("data-busy")).toBeNull();
  });

  // #3993. 잠금 화면에서 돌아와 누른 순간 무선이 아직 깨는 중이면 갱신이 서버에 닿지 못한다.
  // 그것은 세션이 끝났다는 뜻이 아니다: 사용자는 로그아웃 화면이 아니라 「연결을 확인하고 다시
  // 눌러 주세요」 한 줄을 보고, 같은 자리에서 다시 누를 수 있어야 한다.
  it("갱신에 닿지 못하면 로그인 만료가 아니라 연결 문구 한 줄이고, 세션은 그대로다", async () => {
    const { sent, session } = stage([UNAUTHORIZED(), new TypeError("network down")]);
    const onSettled = vi.fn();

    await pressApprove(onSettled);

    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH, REFRESH_PATH]);
    expect(onSettled).not.toHaveBeenCalled();
    const error = host.querySelector('[data-testid="approval-error"]');
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toMatch(/서버에 닿지 못했어요/);
    expect(error?.textContent).not.toMatch(/로그인이 만료/);
    expect(session.expired).toBe(0);
    // 다시 누를 자리는 남아 있다: 보내는 중에 갇히지 않는다.
    const button = host.querySelector('[data-testid="approval-approve"]');
    expect(button?.getAttribute("data-busy")).toBeNull();
  });

  it("이미 결정된 것(409)은 갱신하지 않고 결정된 것으로 알린다", async () => {
    const { sent } = stage([answer(409, { approval_id: APPROVAL, status: "rejected" })]);
    const onSettled = vi.fn();

    await pressApprove(onSettled);

    expect(sent.map((request) => request.path)).toEqual([DECISION_PATH]);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled.mock.calls[0]?.[0]).toMatchObject({ kind: "superseded", status: "rejected" });
  });
});
