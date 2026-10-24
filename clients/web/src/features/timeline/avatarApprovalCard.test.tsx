// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/coreHost";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { agentCardModel } from "@momo/core/features/timeline/agentCardModel";
import type { Message } from "@momo/core/lib/api";
import { AgentCard } from "./AgentCard";
import { resetSettledApprovalsForTest } from "./settledApprovals";
import { resetApprovalAvatarPreviewsForTest } from "./useApprovalAvatarPreview";
import { applyLogin, clearSession } from "@/lib/session";

// =============================================================================
// #4394: `member.avatar.set` 승인 카드 — 한 문장 · 제안된 사진 · 사진 주인 본인 문구.
//
// 픽스처는 **서버 계약 그대로**다(ADR-0186 증보 v4, #4385 PR #4398 의 카드 props:
// `agent_port_tools.rs` 의 `avatar_preview`, `actions.rs` 의 title·rows). 이 트리에는 서버가
// 없으므로 runtime-unverified 다 — 서버가 실제로 이 모양을 보내는지는 #4385 랜딩 뒤 실샘플로
// 갈아 끼운다. 이름·핸들은 가상 인물이다.
// =============================================================================

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const AGENT = "019f9a01-0000-7000-8000-000000000401";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000000a1";
const SHA = "ab".repeat(32);
const PREVIEW_PATH = `/v1/workspaces/${WORKSPACE_ID}/approvals/${APPROVAL_ID}/avatar-preview?v=${SHA}`;

function avatarProps(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    approval_id: APPROVAL_ID,
    run_id: "0199aa11-2222-7000-8000-0000000000b2",
    channel_id: "00000000-0000-7000-8000-000000000201",
    action_type: "workspace_action",
    status: "pending",
    expires_at_ms: 0,
    title: "내 프로필 사진 바꾸기",
    summary:
      "내가 이 대화에 보낸 사진으로 내 프로필 사진을 바꿔요. 대상은 말을 건 본인뿐이고, 본인만 승인할 수 있어요.",
    action: {
      id: "member.avatar.set",
      rows: [
        { label: "대상", value: "이도현 (@dohyun)" },
        { label: "프로필 사진", value: "없음 → 새 이미지" },
        { label: "사진 출처", value: "내가 이 대화에 보낸 첨부" },
      ],
      required_role: "requesting_member",
      preview: {
        kind: "avatar_image",
        imageId: "11111111-1111-4111-8111-111111111111",
        sha256: SHA,
        mime: "image/png",
        width: 512,
        height: 384,
        sizeBytes: 48213,
        origin: "attachment",
      },
    },
    ...over,
  };
}

function message(props: Record<string, unknown>): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 1_412,
    authorMemberId: AGENT,
    type: "approval_request",
    body: "승인 요청: 내 프로필 사진 바꾸기",
    state: "sent",
    createdAtMs: 1_753_400_000_000,
    props,
  } as unknown as Message;
}

const DIRECTORY = makeDirectory([
  {
    id: AGENT,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "달무리봇",
    handle: "dalmuri",
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
      member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WORKSPACE_ID,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let mountHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  resetSettledApprovalsForTest();
  resetApprovalAvatarPreviewsForTest();
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = "";
  // 베어러는 코어 세션에서 온다(React 컨텍스트가 아니다).
  applyLogin({
    accessToken: "access",
    refreshToken: "refresh",
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" },
  } as never);
});
afterEach(() => {
  clearSession();
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountHost?.remove();
  mountHost = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mountCard(props: Record<string, unknown>): Promise<HTMLElement> {
  const card = agentCardModel(message(props));
  if (card === null) throw new Error("no card for these props");
  mountHost = document.createElement("div");
  document.body.append(mountHost);
  mountedRoot = createRoot(mountHost);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(AgentCard, { card, directory: DIRECTORY })
  );
  await act(async () => {
    mountedRoot?.render(tree);
  });
  // 미리보기 fetch → FileReader 가 끝나 「불러오는 중」을 벗어날 때까지 기다린다(상한 2초).
  for (let i = 0; i < 200; i += 1) {
    const frame = byTestId(mountHost, "approval-avatar-frame")[0];
    if (frame === undefined || frame.dataset.state !== "loading") break;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  return mountHost;
}

function byTestId(host: HTMLElement, id: string): HTMLElement[] {
  return [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function stubPreviewFetch(status: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
    status === 200
      ? new Response(PNG, { status, headers: { "content-type": "image/png" } })
      : new Response(JSON.stringify({ error: { message: "avatar preview not found" } }), { status })
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("member.avatar.set 승인 카드 (#4394)", () => {
  it("한 문장과 제안된 사진을 버튼 위에 그린다 — 사진은 베어러로 받아 data: 로 싣는다", async () => {
    const fetchMock = stubPreviewFetch(200);
    const host = await mountCard(avatarProps());

    expect(byTestId(host, "approval-avatar-headline")[0]?.textContent).toBe(
      "달무리봇이 내 프로필 사진을 이 사진으로 바꾸려고 해요"
    );
    const image = byTestId(host, "approval-avatar-image")[0] as HTMLImageElement | undefined;
    expect(image?.getAttribute("src")?.startsWith("data:")).toBe(true);
    expect(byTestId(host, "approval-avatar-caption")[0]?.textContent).toContain("승인하면");

    // 정확히 이 승인·이 해시의 주소로, 베어러를 실어 한 번.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
    expect(String(url).endsWith(PREVIEW_PATH)).toBe(true);
    expect(init.headers.get("Authorization")).toBe("Bearer access");

    // 서버 행은 그대로 서고, 사진은 승인·거부 버튼 앞에 있다.
    expect(byTestId(host, "approval-action-row")).toHaveLength(3);
    const preview = byTestId(host, "approval-avatar-preview")[0] as HTMLElement;
    const approve = byTestId(host, "approval-approve")[0] as HTMLElement;
    expect(preview.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("결정 권한 줄은 관리자가 아니라 사진 주인 본인을 말한다", async () => {
    stubPreviewFetch(200);
    const host = await mountCard(avatarProps());
    expect(byTestId(host, "approval-action-role")[0]?.textContent).toContain(
      "사진 주인 본인만 승인할 수 있어요."
    );
    expect(host.textContent ?? "").not.toContain("requesting_member");
  });

  it("본인이 아니라 서버가 404 를 주면 사진 자리가 본인만 볼 수 있다고 말한다 — 버튼 판정은 서버 몫이다", async () => {
    stubPreviewFetch(404);
    const host = await mountCard(avatarProps());
    expect(byTestId(host, "approval-avatar-image")).toHaveLength(0);
    expect(byTestId(host, "approval-avatar-caption")[0]?.textContent).toBe(
      "이 사진은 요청한 본인만 볼 수 있어요."
    );
    expect(byTestId(host, "approval-avatar-frame")[0]?.dataset.state).toBe("unavailable");
    // 클라이언트는 주인을 추측하지 않는다: 버튼은 서 있고 403 이 서버의 답이다.
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
  });

  it("미리보기 블록이 어긋난 카드는 사진 요청 없이 서버 행만 그린다", async () => {
    const fetchMock = stubPreviewFetch(200);
    const props = avatarProps();
    (props.action as Record<string, unknown>).preview = { kind: "avatar_image", sha256: "nope" };
    const host = await mountCard(props);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(byTestId(host, "approval-avatar-caption")[0]?.textContent).toContain("본인만");
    expect(byTestId(host, "approval-action-row")).toHaveLength(3);
  });

  it("결정이 난 카드에는 사진 블록이 서지 않는다(결과는 결과 카드가 말한다)", async () => {
    const fetchMock = stubPreviewFetch(200);
    const host = await mountCard(avatarProps({ status: "approved" }));
    expect(byTestId(host, "approval-avatar-preview")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("다른 행동 카드에는 사진 블록이 붙지 않는다 (회귀 0)", async () => {
    const fetchMock = stubPreviewFetch(200);
    const props = avatarProps();
    (props.action as Record<string, unknown>).id = "agent.rename";
    const host = await mountCard(props);
    expect(byTestId(host, "approval-avatar-preview")).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403 뒤에는 사진 주인 본인이 승인해야 한다고 말하고 카드는 대기로 남는다", async () => {
    stubPreviewFetch(200);
    const host = await mountCard(avatarProps());
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ approval_id: APPROVAL_ID, status: "role_required" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
    approve.focus();
    await act(async () => {
      approve.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const error = byTestId(host, "approval-error")[0];
    expect(error?.textContent).toContain("사진 주인 본인이 승인해야 해요.");
    expect(error?.textContent).not.toContain("관리자");
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
  });
});

describe("member.avatar.set 결과 카드 (#4394)", () => {
  async function mountResult(status: string): Promise<HTMLElement> {
    const card = agentCardModel({
      ...message({}),
      type: "tool_result",
      body: "프로필 사진을 바꿨어요",
      props: {
        "momo.action_result": {
          v: 1,
          action_id: "member.avatar.set",
          status,
          approval_id: APPROVAL_ID,
          decided_by: ME,
          ref: { type: "member", id: ME },
          rows: [{ label: "프로필 사진", value: "카드에 보인 이미지로 바뀌었어요" }],
          secret_shown_once: false,
        },
      },
    } as unknown as Message);
    if (card === null) throw new Error("no result card");
    mountHost = document.createElement("div");
    document.body.append(mountHost);
    mountedRoot = createRoot(mountHost);
    await act(async () => {
      mountedRoot?.render(
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(AgentCard, { card, directory: DIRECTORY })
        )
      );
    });
    return mountHost;
  }

  it("권한이 모자란 결정은 관리자가 아니라 사진 주인 본인을 가리킨다", async () => {
    const host = await mountResult("role_required");
    expect(byTestId(host, "action-result-note")[0]?.textContent).toBe("사진 주인 본인이 승인해야 해요.");
  });

  it("거부·만료 줄은 프로필 사진이 그대로라고 말한다", async () => {
    const rejected = await mountResult("rejected");
    expect(byTestId(rejected, "action-result-note")[0]?.textContent).toBe("승인하지 않아 프로필 사진은 그대로예요.");
  });

  it("실행됨은 서버 행(프로필 사진)과 기본 문장을 그린다", async () => {
    const host = await mountResult("executed");
    expect(byTestId(host, "action-result-note")[0]?.textContent).toBe("실행을 마쳤어요.");
    expect(host.textContent ?? "").toContain("카드에 보인 이미지로 바뀌었어요");
  });
});

