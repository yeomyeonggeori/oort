// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { readDraft } from "@/features/chat/draftStore";
import { AgentCard } from "./AgentCard";

// =============================================================================
// #3738 · #3729 — 승인 카드의 기한과 새 행동 카드.
//
// 시계를 고정하고 카드를 경계 양쪽에서 그린다: 9분 59초 전은 경고, 10분 1초 전은
// 조용, 기한 뒤는 만료다. 이 시험은 `expiryPhase`/`useExpiryNow`/ExpiredApprovalFooter
// 를 되돌리면 실패한다 — 각 단정이 렌더 DOM 에서 선다.
// =============================================================================

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-0000000001ff";
const GROKBOT = "019f9a01-0000-7000-8000-000000000402";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000000a1";
const T0 = 1_760_000_000_000;
const MIN = 60_000;

const DIRECTORY = makeDirectory([
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: GROKBOT,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "그록봇",
    handle: "grokbot",
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
] as never);

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: ME,
        workspaceId: WORKSPACE_ID,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WORKSPACE_ID,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function actionProps(
  actionId: string,
  rows: { label: string; value: string }[],
  requiredRole: string,
  expiresAtMs: number
): Record<string, unknown> {
  return {
    approval_id: APPROVAL_ID,
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    channel_id: CHANNEL_ID,
    action_type: "workspace_action",
    status: "pending",
    expires_at_ms: expiresAtMs,
    title: "채널 만들기",
    summary: "그록봇이 제안했습니다.",
    action: { id: actionId, rows, rationale: null, required_role: requiredRole },
  };
}

const CHANNEL_CREATE_ROWS = [
  { label: "채널", value: "#계획" },
  { label: "공개 범위", value: "비공개" },
  { label: "이 에이전트도 참여", value: "예 (이 채널이 승인 채널에 들어가요)" },
];

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ now: T0, toFake: ["Date", "setTimeout", "clearTimeout"] });
  localStorage.clear();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

function mount(props: Record<string, unknown>): HTMLElement {
  const card = agentCardModel({
    id: "0199aa11-2222-7000-8000-0000000000d1",
    channelId: CHANNEL_ID,
    seq: 7,
    authorMemberId: GROKBOT,
    type: "approval_request",
    body: null,
    state: "sent",
    createdAtMs: T0,
    props,
  } as unknown as Message);
  if (card === null) throw new Error("no card");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(
      createElement(
        SessionProvider,
        { value: sessionValue() },
        createElement(AgentCard, { card, directory: DIRECTORY })
      )
    );
  });
  return host;
}

const q = (el: HTMLElement, id: string) =>
  el.querySelector<HTMLElement>(`[data-testid="${id}"]`);

describe("승인 카드 기한 (#3738)", () => {
  it("10분 1초 전에는 조용하고, 9분 59초 전에는 경고 줄이 선다", () => {
    const quiet = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 + 10 * MIN + 1_000));
    expect(q(quiet, "approval-note-expiry-soon")).toBeNull();
    expect(q(quiet, "approval-approve")).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    quiet.remove();

    const warned = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 + 9 * MIN + 59_000));
    expect(q(warned, "approval-note-expiry-soon")?.textContent).toBe(
      "10분 안에 만료돼요. 결정하지 않으면 에이전트가 다시 제안해야 해요."
    );
    // 경고는 결정을 막지 않는다 — 컨트롤은 그대로 서 있다.
    expect(q(warned, "approval-approve")).not.toBeNull();
  });

  it("시간이 흘러 경계를 지나면 사람이 새로고침하지 않아도 경고가 서고 이어서 만료된다", () => {
    const el = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 + 12 * MIN));
    expect(q(el, "approval-note-expiry-soon")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(2 * MIN + 1_000);
    });
    expect(q(el, "approval-note-expiry-soon")).not.toBeNull();

    // 분이 줄 때 숫자 하나만 움직인다.
    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });
    expect(q(el, "approval-note-expiry-soon")?.textContent).toContain("5분 안에");

    act(() => {
      vi.advanceTimersByTime(5 * MIN);
    });
    expect(q(el, "approval-expired")).not.toBeNull();
    expect(q(el, "approval-approve")).toBeNull();
    expect(q(el, "agent-card")?.dataset.status).toBe("expired");
  });

  it("보는 도중 만료되면 초점이 문서 처음으로 떨어지지 않고 카드가 받는다", () => {
    const el = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 + 2 * MIN));
    const approve = q(el, "approval-approve") as HTMLButtonElement;
    act(() => approve.focus());
    expect(document.activeElement).toBe(approve);
    act(() => {
      vi.advanceTimersByTime(2 * MIN + 1_000);
    });
    expect(q(el, "approval-approve")).toBeNull();
    expect(document.activeElement).toBe(q(el, "agent-card"));
  });

  it("이미 만료된 채 열린 카드는 초점을 훔치지 않는다", () => {
    const el = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 - 1_000));
    expect(document.activeElement).not.toBe(q(el, "agent-card"));
  });

  it("기한이 지난 카드는 컨트롤이 없고 「다시 요청」가 선다", () => {
    const el = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 - 1_000));
    expect(q(el, "approval-approve")).toBeNull();
    expect(q(el, "approval-reject")).toBeNull();
    expect(q(el, "approval-expired")?.textContent).toContain(
      "승인 시간이 지나서 더 이상 결정할 수 없어요."
    );
    expect(q(el, "approval-repropose")?.textContent).toBe("다시 요청");
  });

  it("버튼은 그 에이전트를 멘션한 초안을 그 채널의 입력창에 넣는다 (보내지 않는다)", () => {
    const el = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 - 1_000));
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    act(() => {
      q(el, "approval-repropose")?.click();
    });
    const draft = readDraft(WORKSPACE_ID, CHANNEL_ID);
    expect(draft.startsWith("@grokbot ")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(q(el, "approval-repropose-note")?.textContent).toContain("입력창에 넣어 뒀어요");
    vi.unstubAllGlobals();
  });

  it("쓰던 글이 있으면 덮지 않고 이유를 말한다", () => {
    const el = mount(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", T0 - 1_000));
    localStorage.clear();
    // 입력창에 이미 글이 있는 상태를 저장소로 만든다.
    act(() => {
      q(el, "approval-repropose")?.click();
    });
    // 첫 클릭은 심었다. 두 번째 클릭은 그 글이 이미 있으므로 덮지 않는다.
    act(() => {
      q(el, "approval-repropose")?.click();
    });
    expect(q(el, "approval-repropose-note")?.textContent).toContain("쓰던 글이 있어서");
  });

  it("기한을 모르는 카드는 경고도 만료도 짓지 않는다", () => {
    const props = actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", 0);
    const el = mount(props);
    expect(q(el, "approval-note-expiry-soon")).toBeNull();
    expect(q(el, "approval-expired")).toBeNull();
    expect(q(el, "approval-approve")).not.toBeNull();
  });
});

describe("새 행동 카드 다섯 (#3729)", () => {
  function mountDetails(props: Record<string, unknown>) {
    const el = mount(props);
    const details = el.querySelector<HTMLDetailsElement>('[data-testid="request-bundle-details"]')!;
    act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
    return el;
  }
  const FUTURE = T0 + 3_600_000;

  it("channel.create: 「이 에이전트도 참여」 행이 강조되고 접근 범위 한 줄이 붙는다", () => {
    const el = mountDetails(actionProps("channel.create", CHANNEL_CREATE_ROWS, "admin", FUTURE));
    const rows = [...el.querySelectorAll('[data-testid="approval-action-row"]')];
    expect(rows).toHaveLength(3);
    expect(q(el, "approval-access-widening")?.textContent).toBe(
      "이 에이전트가 새 채널에도 들어가요. 접근 범위가 넓어져요."
    );
    // 「아니요」일 때는 강조가 없다.
    act(() => root?.unmount());
    root = null;
    el.remove();
    const no = mount(
      actionProps(
        "channel.create",
        [{ label: "이 에이전트도 참여", value: "아니요" }],
        "admin",
        FUTURE
      )
    );
    expect(q(no, "approval-access-widening")).toBeNull();
  });

  it.each([
    ["channel.member.add", "admin", "관리자만 승인할 수 있어요."],
    ["agent.rename", "agent_editor", "대상 에이전트의 소유자 또는 관리자만 승인할 수 있어요."],
    ["hosted.channels.grant", "admin", "관리자만 승인할 수 있어요."],
    ["workspace.settings.update", "workspace_operator", "워크스페이스 운영자(관리자)만 승인할 수 있어요."],
  ])("%s: 결정 권한 줄이 %s 의 문장으로 선다", (id, role, copy) => {
    const el = mountDetails(
      actionProps(id, [{ label: "행", value: "값" }], role, FUTURE)
    );
    expect(q(el, "approval-action-role")?.textContent).toContain(copy);
  });

  it("행 값은 평문이다 — 링크도 멘션도 요소가 되지 않는다 (부록 A)", () => {
    const el = mountDetails(
      actionProps(
        "workspace.settings.update",
        [
          {
            label: "환영 문구",
            value: "\"https://evil.test/x <b>굵게</b> @grokbot\" → \"<@member> [링크](https://a.test)\"",
          },
        ],
        "workspace_operator",
        FUTURE
      )
    );
    const row = q(el, "approval-action-row");
    expect(row?.querySelector("a")).toBeNull();
    expect(row?.querySelector("b")).toBeNull();
    expect(row?.textContent).toContain("https://evil.test/x <b>굵게</b> @grokbot");
  });

  it("agent.rename: 「현재 → 새」 행이 서버 문장 그대로 그려진다", () => {
    const el = mountDetails(
      actionProps(
        "agent.rename",
        [{ label: "이름 변경", value: "그록봇 → 그록 2" }],
        "agent_editor",
        FUTURE
      )
    );
    expect(q(el, "approval-action-row")?.textContent).toContain("그록봇 → 그록 2");
  });
});

describe("결과 줄의 새 ref.type 넷 (#3729)", () => {
  function mountResult(refType: string, actionId: string): HTMLElement {
    const card = agentCardModel({
      id: "0199aa11-2222-7000-8000-0000000000d2",
      channelId: CHANNEL_ID,
      seq: 8,
      authorMemberId: GROKBOT,
      type: "tool_result",
      body: "채널을 만들었습니다.",
      state: "sent",
      createdAtMs: T0,
      props: {
        "momo.action_result": {
          v: 1,
          action_id: actionId,
          status: "executed",
          approval_id: APPROVAL_ID,
          decided_by: ME,
          ref: { type: refType, id: "0199aa11-2222-7000-8000-0000000000f1" },
          rows: [{ label: "채널", value: "#계획" }],
          secret_shown_once: false,
        },
      },
    } as unknown as Message);
    if (card === null) throw new Error("no card");
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(AgentCard, { card, directory: DIRECTORY })
        )
      );
    });
    return host;
  }

  it.each([
    ["channel", "channel.create"],
    ["agent", "agent.rename"],
    ["hosted_connection", "hosted.channels.grant"],
    ["workspace_settings", "workspace.settings.update"],
  ])("ref.type=%s 결과는 행으로 말하고 문(next)을 짓지 않는다", (refType, actionId) => {
    const el = mountResult(refType, actionId);
    expect(q(el, "agent-card")?.dataset.cardKind).toBe("action_result");
    expect(q(el, "action-result-row")?.textContent).toContain("#계획");
    expect(q(el, "action-result-next")).toBeNull();
    // 1회 값이 없는 행동이라 「1회 표시됐어요」도 서지 않는다.
    expect(q(el, "action-result-secret-once")).toBeNull();
    // 내부 식별자(ref.id, ref.type 낱말)가 화면에 닿지 않는다.
    expect(el.textContent).not.toContain("0199aa11-2222-7000-8000-0000000000f1");
    expect(el.textContent).not.toContain(refType);
    act(() => root?.unmount());
    root = null;
    el.remove();
    host = null;
  });
});

