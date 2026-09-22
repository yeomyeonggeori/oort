// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
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
import { AgentCard } from "./AgentCard";
import { isInternalHref, isReachableHref } from "./ActionResultCard";
import { actionDestination } from "@momo/core/features/commands/serverActions";

// =============================================================================
// AX-4 (#2510): 행동 승인 카드 · 1회 링크 · 영속 결과 카드.
//
// 픽스처는 **ADR-0186 부록 A·B·C 그대로**다. 서버(AX-3a/3b)가 아직 없으므로 그
// 부록이 계약이고, 랜딩 뒤 실샘플로 갈아 끼우는 자리가 여기다.
//
// 가장 값어치 있는 단정은 「새로고침 뒤 링크가 없다」이고, 그것을 **픽스처가
// 아니라 렌더 DOM**에서 잰다. 픽스처에 값이 없는 것은 아무것도 증명하지 않는다 —
// 이 파일이 재는 것은 제품이 그 값을 어디에도 적어 두지 않았다는 사실이다.
// =============================================================================

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const HERMES = "019f9a01-0000-7000-8000-000000000401";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000000a1";
const SECRET = "https://oort.test/join?code=Ab3-_xQ7";

/** 부록 A. */
const APPENDIX_A_PROPS = Object.freeze({
  approval_id: APPROVAL_ID,
  run_id: "0199aa11-2222-7000-8000-0000000000b2",
  channel_id: "00000000-0000-7000-8000-000000000201",
  action_type: "workspace_action",
  status: "pending",
  expires_at_ms: 0,
  title: "팀원 초대 링크 만들기",
  summary:
    "hermes가 제안했습니다. 승인하면 관리자 권한으로 초대 링크를 만듭니다.",
  action: {
    id: "invite.create",
    rows: [
      { label: "역할", value: "member" },
      { label: "사용 횟수", value: "1회" },
      { label: "만료", value: "7일" },
    ],
    rationale: "새 팀원 온보딩 요청",
    required_role: "admin",
  },
});

/** 부록 C. */
const APPENDIX_C_BODY = Object.freeze({
  approval_id: APPROVAL_ID,
  status: "approved",
  decided_by: ME,
  decided_at_ms: 1_753_400_000_000,
  result: {
    actionId: "invite.create",
    ref: { type: "invite", id: "0199aa11-2222-7000-8000-0000000000f1" },
    secretOnce: {
      kind: "invite_link",
      value: SECRET,
      expiresAtMs: 1_790_000_000_000,
    },
  },
});

/** 부록 B. */
function appendixBProps(over: Record<string, unknown> = {}) {
  return {
    "momo.action_result": {
      v: 1,
      action_id: "invite.create",
      status: "executed",
      approval_id: APPROVAL_ID,
      decided_by: ME,
      ref: { type: "invite", id: "0199aa11-2222-7000-8000-0000000000f1" },
      rows: [
        { label: "역할", value: "member" },
        { label: "만료", value: "2026-09-29" },
      ],
      secret_shown_once: true,
      // **부록 B 원문 그대로**(R1 H1). 앞 판은 이 자리를 `members` 로 바꿔 두어
      // 하네스가 계약 밖 입력으로 초록이었다 — 「하네스 참·제품 거짓」. 이
      // 클라이언트에 `invites` 섹션은 없으므로(`settingsNav.ts`) 이 픽스처에서
      // 문이 서지 않는 것이 옳고, 그 fail-closed 가 실제로 도는지를 잰다.
      next: {
        label: "설정 › 초대에서 보기",
        href: "/settings?section=invites",
      },
      ...over,
    },
  };
}

function message(over: Partial<Message>): Message {
  return {
    id: "0199aa11-2222-7000-8000-0000000000d1",
    channelId: "00000000-0000-7000-8000-000000000201",
    seq: 1_412,
    authorMemberId: HERMES,
    type: "text",
    body: null,
    state: "sent",
    createdAtMs: 1_753_400_000_000,
    ...over,
  } as unknown as Message;
}

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

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  // R1 S4/M8: 앞 시험이 남긴 hash 가 다음 시험의 「불변」 기준선을 오염시켰다.
  // 기준선은 매번 깨끗한 자리에서 잡는다.
  window.location.hash = "";
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function unmount(): void {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountHost?.remove();
  mountHost = null;
}

function mountCard(
  props: Record<string, unknown>,
  over: Partial<Message> = {}
): HTMLElement {
  const card = agentCardModel(
    message({ type: "approval_request", props, ...over } as Partial<Message>)
  );
  if (card === null) throw new Error("no card for these props");
  mountHost = document.createElement("div");
  document.body.append(mountHost);
  mountedRoot = createRoot(mountHost);
  const tree: ReactElement = createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(AgentCard, { card, directory: DIRECTORY })
  );
  act(() => {
    mountedRoot?.render(tree);
  });
  return mountHost;
}

function approvalProps(): Record<string, unknown> {
  // 구조적 복제. 프리즈된 원본을 그대로 넘기면 「props 가 변하지 않았다」가
  // 프리즈 덕분인지 제품 덕분인지 구별되지 않는다.
  return structuredClone(APPENDIX_A_PROPS) as Record<string, unknown>;
}

function byTestId(host: HTMLElement, id: string): HTMLElement[] {
  return [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
}

/** 무장 → 시간 게이트 통과 → 확정. 반환은 확정 뒤의 호스트. */
async function decide(host: HTMLElement, response: Response): Promise<void> {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
  act(() => {
    approve.click();
  });
  // CONFIRM_GUARD_MS 를 넘긴다. 한 번의 누름이 무장과 확정을 관통하지 못하게
  // 막는 그 가드이고, 시험이 그것을 우회하지 않고 **지나간다**.
  now += 1_000;
  const commit = byTestId(host, "approval-commit")[0] as HTMLButtonElement;
  await act(async () => {
    commit.click();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("행동 승인 카드 (ADR-0186 부록 A)", () => {
  it("행·사유·결정 권한을 카드 표면에 그린다", () => {
    const host = mountCard(approvalProps());
    const rows = byTestId(host, "approval-action-row").map(
      (row) => row.textContent ?? ""
    );
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("역할");
    expect(rows[0]).toContain("member");
    expect(byTestId(host, "approval-action-rationale")[0]?.textContent).toContain(
      "새 팀원 온보딩 요청"
    );
    expect(byTestId(host, "approval-action-role")[0]?.textContent).toContain(
      "관리자만 승인할 수 있습니다."
    );
  });

  it("tool_call 승인 카드는 그대로다 — 행동 행이 하나도 붙지 않는다 (회귀 0)", () => {
    const host = mountCard({
      approval_id: APPROVAL_ID,
      action_type: "shell",
      tool_name: "shell",
      title: "빌드 캐시 정리",
      summary: "빌드 산출물 디렉터리를 지웁니다.",
      status: "pending",
      arguments: { command: "rm -rf build/" },
    });
    expect(byTestId(host, "approval-action-row")).toHaveLength(0);
    expect(byTestId(host, "approval-action-role")).toHaveLength(0);
    // 결정 컨트롤은 그대로 선다.
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
  });
});

describe("1회 링크는 결정 응답에서만 그려지고 새로고침을 견디지 않는다 (ADR-0186 D4)", () => {
  it("승인 확정 직후 버튼 자리에 링크가 선다 (ADR-0182 ①)", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse(APPENDIX_C_BODY));
    expect(byTestId(host, "approval-link-once")).toHaveLength(1);
    expect(byTestId(host, "approval-link-once-value")[0]?.textContent).toBe(
      SECRET
    );
    // 복사 컨트롤은 설정의 것과 같은 한 벌이다(ADR-0182 ① 훅).
    expect(byTestId(host, "approval-link-once-copy")).toHaveLength(1);
    // 결정 컨트롤은 자리를 내줬다.
    expect(byTestId(host, "approval-approve")).toHaveLength(0);
  });

  it("새로고침(스토어 초기화 + 재마운트) 뒤 렌더 DOM 에 링크 문자열이 0회다", async () => {
    const props = approvalProps();
    const before = JSON.stringify(props);
    const hashBefore = window.location.hash;

    const host = mountCard(props);
    await decide(host, jsonResponse(APPENDIX_C_BODY));
    // 먼저 **있었다**는 것을 잰다. 없던 것이 없는 시험은 아무것도 막지 못한다.
    expect(host.textContent ?? "").toContain(SECRET);

    // 새로고침 시뮬레이션: 이 페이지가 값을 둘 수 있었을 모든 자리를 확인한다.
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(window.location.hash).toBe(hashBefore);
    expect(window.location.href).not.toContain(SECRET);
    // props 는 결정 전과 **한 글자도** 다르지 않다. 카드가 새로고침을 견디게
    // 하려고 값을 메시지에 적어 두는 것이 D4 가 이름으로 금지한 구현이다.
    expect(JSON.stringify(props)).toBe(before);
    expect(before).not.toContain(SECRET);

    unmount();
    // 언마운트 **뒤에도** URL 을 다시 읽는다 (R1 S4/M8). 언마운트 정리 경로가
    // 값을 주소에 적어 두는 구현이 있다면 그것도 새로고침을 견디는 기록이다.
    expect(window.location.hash).toBe(hashBefore);
    expect(window.location.href).not.toContain(SECRET);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);

    const remounted = mountCard(props);
    expect(remounted.textContent ?? "").not.toContain(SECRET);
    expect(byTestId(remounted, "approval-link-once")).toHaveLength(0);
    expect(document.body.textContent ?? "").not.toContain(SECRET);
  });

  it("R1 B1: 값은 잘리지 않고 접힌다 — 390 에서 꼬리가 말줄임에 먹히지 않는다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse(APPENDIX_C_BODY));
    const value = byTestId(host, "approval-link-once-value")[0];
    expect(value?.className).not.toContain("truncate");
    expect(value?.className).toContain("break-all");
    expect(value?.className).toContain("select-all");
    // 값 전체가 DOM 에 있다 — 말줄임은 CSS 가 하는 일이라 문자열로는 잡히지
    // 않는다. 잘림 여부는 캡처 레인이 scrollWidth 로 잰다.
    expect(value?.textContent).toBe(SECRET);
  });

  it("R1 H2: 확정 직후 초점이 카드 안에 남는다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse(APPENDIX_C_BODY));
    const region = byTestId(host, "approval-link-once")[0];
    expect(document.activeElement).toBe(region);
    expect(host.contains(document.activeElement)).toBe(true);
    // 그룹의 접근성 이름이 「이 화면에서만」 문장이다.
    const labelledBy = region?.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toContain(
      "이 화면에서만"
    );
  });

  it("R1 N1: 승인 뒤 카드 안 라이브 리전은 하나다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse(APPENDIX_C_BODY));
    expect(host.querySelectorAll('[role="status"]')).toHaveLength(1);
  });

  it("R1 M2: 행동 승인의 확정 문장은 에이전트 재개를 약속하지 않는다", () => {
    const host = mountCard(approvalProps());
    const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
    act(() => {
      approve.click();
    });
    const confirm = byTestId(host, "approval-confirm")[0];
    expect(confirm?.textContent).toContain("승인하면 서버가 관리자 권한으로");
    expect(confirm?.textContent).not.toContain("에이전트가 이어서");
  });

  it("R1 M2: 행동 블록이 없으면 확정 문장도 그대로다 (회귀 0)", () => {
    const host = mountCard({
      approval_id: APPROVAL_ID,
      action_type: "shell",
      tool_name: "shell",
      title: "빌드 캐시 정리",
      status: "pending",
    });
    const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
    act(() => {
      approve.click();
    });
    expect(byTestId(host, "approval-confirm")[0]?.textContent).toContain(
      "승인하면 에이전트가 이어서 진행합니다."
    );
  });

  it("거부로 확정된 결정에는 링크가 서지 않는다", async () => {
    const host = mountCard(approvalProps());
    await decide(
      host,
      jsonResponse({ ...APPENDIX_C_BODY, status: "rejected" })
    );
    expect(byTestId(host, "approval-link-once")).toHaveLength(0);
    expect(host.textContent ?? "").not.toContain(SECRET);
  });

  it("403 은 「관리자가 승인해야 합니다」와 다음 행동을 카드 안에 세운다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ status: "pending" }, 403));
    const error = byTestId(host, "approval-error")[0];
    expect(error?.textContent).toContain("관리자가 승인해야 합니다.");
    expect(error?.textContent).toContain("아직 대기 중");
    // 사고가 아니다: 붉은 alert 이 아니라 조용한 안내로 선다.
    expect(error?.getAttribute("role")).toBe("status");
    expect(error?.dataset.tone).toBe("unavailable");
  });

  it("R1 M1: 403 뒤 성공할 수 없는 「승인 확정」이 남지 않는다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ status: "pending" }, 403));
    expect(byTestId(host, "approval-commit")).toHaveLength(0);
    // 카드는 여전히 대기다 — 다른 사람이 이어받을 수 있어야 한다.
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
    expect(byTestId(host, "approval-reject")).toHaveLength(1);
  });

  it("R1 H2: 403 뒤에도 초점이 카드 안에 남는다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ status: "pending" }, 403));
    expect(host.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("행동 블록이 없는 승인의 403 은 지금까지의 문장 그대로다", async () => {
    const host = mountCard({
      approval_id: APPROVAL_ID,
      action_type: "shell",
      tool_name: "shell",
      title: "빌드 캐시 정리",
      status: "pending",
    });
    await decide(host, jsonResponse({ status: "pending" }, 403));
    expect(byTestId(host, "approval-error")[0]?.textContent).toContain(
      "채널 멤버인지 확인하세요"
    );
  });
});

describe("영속 결과 카드 (ADR-0186 부록 B)", () => {
  function mountResult(over: Record<string, unknown> = {}): HTMLElement {
    return mountCard(appendixBProps(over), {
      type: "tool_result",
      body: "초대 링크를 만들었습니다.",
    });
  }

  it("행·1회 고지를 그린다", () => {
    const host = mountResult();
    expect(byTestId(host, "action-result-row")).toHaveLength(2);
    expect(byTestId(host, "action-result-note")[0]?.textContent).toBe(
      "실행을 마쳤습니다."
    );
    expect(byTestId(host, "action-result-secret-once")[0]?.textContent).toContain(
      "1회 표시됐습니다"
    );
  });

  it("R1 H1: 부록 B 원문(`section=invites`)은 이 빌드가 모르는 섹션이라 문이 서지 않는다", () => {
    const host = mountResult();
    // 픽스처는 계약 원문 그대로다. 문이 없는 것이 이 빌드의 참이다 —
    // `SettingsRoute` 가 모르는 섹션을 조용히 프로필로 접기 때문이다.
    expect(byTestId(host, "action-result-next")).toHaveLength(0);
    // 카드는 말을 잃지 않는다.
    expect(byTestId(host, "action-result-note")[0]?.textContent).toBe(
      "실행을 마쳤습니다."
    );
    expect(byTestId(host, "action-result-secret-once")).toHaveLength(1);
  });

  it("R1 H1: 실재하는 섹션이면 문이 선다", () => {
    const host = mountResult({
      next: { label: "설정 › 멤버와 초대에서 보기", href: "/settings?section=members" },
    });
    const next = byTestId(host, "action-result-next")[0];
    expect(next?.getAttribute("href")).toBe("#/settings?section=members");
    expect(next?.textContent).toBe("설정 › 멤버와 초대에서 보기");
  });

  it("R1 H1: 카드와 팔레트가 같은 질문에 같은 답을 한다", () => {
    // 팔레트는 모르는 행동 id 에 `null`(=줄이 눌리지 않는다)을 답한다. 카드는
    // 모르는 목적지에 문을 세우지 않는다. 두 규칙이 갈라지면 한 클라이언트가
    // 같은 질문에 두 가지로 답하게 된다.
    expect(isReachableHref("/settings?section=invites")).toBe(false);
    expect(isReachableHref("/settings?section=members")).toBe(true);
    expect(isReachableHref("/settings")).toBe(true);
    expect(isReachableHref("/inbox")).toBe(false);
    expect(isReachableHref("https://evil.test/take")).toBe(false);
    expect(isReachableHref("//evil.test/take")).toBe(false);
    expect(actionDestination("invite.create")).toBe(
      "/settings?section=members"
    );
    expect(actionDestination("channel.archive")).toBeNull();
  });

  it("카드에는 링크 값이 없다 — 있는 것은 사실과 문 하나뿐이다 (D4)", () => {
    const host = mountResult();
    expect(host.textContent ?? "").not.toContain(SECRET);
    expect(host.textContent ?? "").not.toContain("code=");
  });

  it("네 상태가 각자 다른 칩과 문장을 세운다", () => {
    const seen = new Set<string>();
    for (const [status, label, note] of [
      ["executed", "실행됨", "실행을 마쳤습니다."],
      ["rejected", "거부됨", "승인하지 않아 실행하지 않았습니다."],
      ["expired", "만료됨", "기한이 지나 실행하지 않았습니다."],
      ["role_required", "권한 필요", "관리자가 승인해야 합니다."],
    ] as const) {
      const host = mountResult({ status });
      expect(byTestId(host, "agent-status-chip")[0]?.textContent).toBe(label);
      expect(byTestId(host, "action-result-note")[0]?.textContent).toBe(note);
      seen.add(byTestId(host, "agent-status-chip")[0]?.className ?? "");
      unmount();
    }
    // 네 상태가 같은 옷을 입지 않는다.
    expect(seen.size).toBe(4);
  });

  it("바깥 주소는 문이 되지 않는다", () => {
    const host = mountResult({
      next: { label: "외부로", href: "https://evil.test/take" },
    });
    expect(byTestId(host, "action-result-next")).toHaveLength(0);
    expect(isInternalHref("https://evil.test/take")).toBe(false);
    expect(isInternalHref("//evil.test/take")).toBe(false);
    expect(isInternalHref("/settings?section=members")).toBe(true);
  });

  it("모르는 판은 카드가 아니라 도구 결과로 떨어진다 (본문 폴백)", () => {
    const host = mountCard(appendixBProps({ v: 2 }), {
      type: "tool_result",
      body: "초대 링크를 만들었습니다.",
    });
    expect(byTestId(host, "agent-card")[0]?.dataset.cardKind).toBe("tool");
  });
});
