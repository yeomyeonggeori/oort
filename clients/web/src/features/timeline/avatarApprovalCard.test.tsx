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
import { clearApprovalAvatarPreviews, resetApprovalAvatarPreviewsForTest } from "./useApprovalAvatarPreview";
import { applyLogin, clearSession } from "@/lib/session";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  // React 는 겹친 act 를 경고로만 알린다. 통과하는 실행에도 찍히던 그 경고를 시험이 붙든다(#4522).
  vi.spyOn(console, "error");
  // 베어러는 코어 세션에서 온다(React 컨텍스트가 아니다).
  applyLogin({
    accessToken: "access",
    refreshToken: "refresh",
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    member: { id: ME, workspaceId: WORKSPACE_ID, kind: "human", displayName: "이도현", handle: "dohyun" },
  } as never);
});
afterEach(() => {
  const overlapped = vi
    .mocked(console.error)
    .mock.calls.some((args) => String(args[0]).includes("overlapping act() calls"));
  clearSession();
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  mountHost?.remove();
  mountHost = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // 정리를 다 한 뒤에 단정한다: act 가 겹쳤다면 앞 act 를 await 한 뒤에 다음 act 를 열어야 한다.
  expect(overlapped, "act 가 겹쳤다(React: overlapping act() calls)").toBe(false);
});

// 기다림은 시간이 아니라 조건이다(#4522). 조건이 서기 전에는 act 하나씩 — 렌더·effect 를 비우고 이벤트 루프를
// 한 바퀴 돌린다 — 양보하며 다시 본다. 고정 지연도 타이머도 없고, 부하로 느려져도 바퀴 수는 그대로다. 한도를
// 넘기면 조용히 지나가지 않고 이유를 말하며 실패한다(조용히 지나가면 뒤 단정이 「아직 불러오는 중」을 빈 화면으로 통과한다).
//
// act 는 반드시 앞의 것이 풀린 뒤에 연다. 겹쳐 열면 React 의 act 깊이가 어긋나, 겹친 act 둘 중 어느 쪽이 먼저
// 풀리느냐(= 실제 시간)에 따라 act 큐가 열린 채 굳고 그 뒤의 렌더·effect 는 영영 비워지지 않는다(#4522 의 실패 원인).
const TURNS = 1000;

/** 마운트까지만 — 첫 렌더와 effect 를 act 하나로 비운다. 미리보기 요청은 이 안에서 나가고, 응답은 기다리지 않는다. */
async function mountCardOnly(props: Record<string, unknown>, viewerMemberId?: string): Promise<HTMLElement> {
  const card = agentCardModel(message(props));
  if (card === null) throw new Error("no card for these props");
  mountHost = document.createElement("div");
  document.body.append(mountHost);
  mountedRoot = createRoot(mountHost);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(AgentCard, { card, directory: DIRECTORY, viewerMemberId })
  );
  await act(async () => {
    mountedRoot?.render(tree);
  });
  return mountHost;
}

/** 미리보기 fetch → FileReader 가 끝나 「불러오는 중」을 벗어날 때까지 기다린다. */
async function settleCard(host: HTMLElement): Promise<void> {
  const loading = () => byTestId(host, "approval-avatar-frame")[0]?.dataset.state === "loading";
  for (let turn = 0; turn < TURNS && loading(); turn += 1) {
    await act(async () => undefined);
  }
  if (loading()) throw new Error(`미리보기가 「불러오는 중」을 벗어나지 않았다(${TURNS}바퀴)`);
}

/** fetch 가 `times` 번 불릴 때까지 — 고정 시간이 아니라 spy 호출을 조건으로 기다린다. */
async function untilCalled(spy: ReturnType<typeof vi.fn>, times: number): Promise<void> {
  for (let turn = 0; turn < TURNS && spy.mock.calls.length < times; turn += 1) {
    await act(async () => undefined);
  }
  if (spy.mock.calls.length < times) {
    throw new Error(`fetch 가 ${times}번 불리지 않았다(${spy.mock.calls.length}번, ${TURNS}바퀴)`);
  }
}

async function mountCard(props: Record<string, unknown>): Promise<HTMLElement> {
  const host = await mountCardOnly(props);
  await settleCard(host);
  return host;
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

  it("사진 칸의 크기 클래스는 닫힌 스케일에 정의된 토큰이다 (미정의 size-20 은 CSS 가 생기지 않아 원본 크기로 퍼졌다)", () => {
    const tokens = readFileSync(resolve(process.cwd(), "src/design/tokens.css"), "utf8");
    const source = readFileSync(resolve(process.cwd(), "src/features/timeline/AvatarPreviewBlock.tsx"), "utf8");
    const used = [...source.matchAll(/\bsize-([a-z][a-z-]*)\b/g)].map((m) => m[1]).filter((n) => n !== "full");
    expect(used).toContain("avatar-preview");
    for (const name of used) expect(tokens).toContain(`--spacing-${name}:`);
  });

  it("로그아웃·계정 교체 뒤에는 같은 카드가 서버에 다시 묻는다 — 앞 계정의 사진이 남지 않는다 (보안 검수 H1)", async () => {
    const fetchMock = stubPreviewFetch(200);
    const host = await mountCard(avatarProps());
    expect(byTestId(host, "approval-avatar-image")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 주인 A 가 나가고 다른 사람 B 가 같은 카드를 연다: 서버는 B 에게 404 를 준다.
    clearApprovalAvatarPreviews();
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountHost?.remove();
    const notMine = stubPreviewFetch(404);
    const next = await mountCard(avatarProps());

    expect(notMine).toHaveBeenCalledTimes(1);
    expect(byTestId(next, "approval-avatar-image")).toHaveLength(0);
    expect(byTestId(next, "approval-avatar-frame")[0]?.dataset.state).toBe("unavailable");
  });

  it("비우는 사이에 끝난 요청은 캐시를 채우지 않는다 (보안 검수 H1)", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow = vi.fn(async (_url: unknown, _init?: unknown) => {
      await gate;
      return new Response(PNG, { status: 200, headers: { "content-type": "image/png" } });
    });
    vi.stubGlobal("fetch", slow);
    // 「요청이 날아가는 중」을 실제 시간이 아니라 시험이 붙든다(#4522). 마운트 act 하나가 풀리면 요청은 이미 나갔고
    // 응답은 gate 가 쥐고 있다. mountCard 와 act 를 겹쳐 열지도, 20ms 를 기다리지도 않는다.
    const host = await mountCardOnly(avatarProps());
    await untilCalled(slow, 1);
    expect(slow).toHaveBeenCalledTimes(1);
    expect(byTestId(host, "approval-avatar-frame")[0]?.dataset.state).toBe("loading");
    clearApprovalAvatarPreviews(); // 로그아웃 — 요청은 아직 날아가는 중
    release?.();
    await settleCard(host);
    // 앞 계정의 응답은 버려진다: 사진이 서지 않는다.
    expect(byTestId(host, "approval-avatar-image")).toHaveLength(0);
    expect(byTestId(host, "approval-avatar-frame")[0]?.dataset.state).toBe("unavailable");
    // 같은 경로를 다시 열면 서버에 다시 묻는다(캐시가 채워지지 않았다).
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
    mountHost?.remove();
    const again = stubPreviewFetch(200);
    const reopened = await mountCardOnly(avatarProps());
    await untilCalled(again, 1);
    expect(again).toHaveBeenCalledTimes(1);
    await settleCard(reopened);
    expect(byTestId(reopened, "approval-avatar-image")).toHaveLength(1);
  });
});


it("DM admission only offers decision controls to the server-named participant", async () => {
  const props = avatarProps({ title: "에이전트 들이기", expires_at_ms: Date.now() + 900_000,
    action: { id: "dm.agent.admit", rows: [], required_role: "dm_participant", target_member_id: ME } });
  const host = await mountCardOnly(props, AGENT);
  expect(host.textContent).toContain("이 카드에 표시된 참여자의 허락을 기다려요.");
  expect(host.querySelector('[data-testid$="-approve"]')).toBeNull();
});
