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
import { resetSettledApprovalsForTest } from "./settledApprovals";
import { isInternalHref, isReachableHref } from "./ActionResultCard";
import { reachableSettingsSections } from "@/features/settings/settingsNav";
import { actionDestination } from "@momo/core/features/commands/serverActions";
import {
  AGENT_INITIATIVE_LABEL,
  AGENT_INITIATIVE_RATIONALE_LABEL,
} from "@momo/core/features/timeline/agentInitiative";

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
  resetSettledApprovalsForTest();
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
  over: Partial<Message> = {},
  directory = DIRECTORY
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
    createElement(AgentCard, { card, directory })
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

function openDetails(host: HTMLElement) {
  const details = host.querySelector<HTMLDetailsElement>('[data-testid="request-bundle-details"]')!;
  act(() => { details.open = true; details.dispatchEvent(new Event("toggle")); });
}

/** 한 번 누르면 결정이 나간다 (#3819). 반환은 응답이 반영된 뒤의 호스트. */
async function decide(host: HTMLElement, response: Response): Promise<void> {
  vi.stubGlobal("fetch", vi.fn(async () => response));
  const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
  // 키보드로 오는 사람은 버튼에 초점을 둔 채 누른다. 눌린 버튼이 초점을 잃지 않는지가
  // 아래 시험들의 관심이다(`aria-disabled` 이지 `disabled` 가 아니다).
  approve.focus();
  await act(async () => {
    approve.click();
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
  it("행·사유·결정 권한은 자세히를 열면 그린다", () => {
    const host = mountCard(approvalProps());
    expect(byTestId(host, "approval-action-row")).toHaveLength(0);
    openDetails(host);
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
      "관리자만 승인할 수 있어요."
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

  it("#3819: 승인 한 번이 곧 결정이다 — 확정 줄도 확정 버튼도 서지 않는다", async () => {
    const host = mountCard(approvalProps());
    const fetchSpy = vi.fn(async () => jsonResponse(APPENDIX_C_BODY));
    vi.stubGlobal("fetch", fetchSpy);
    const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
    await act(async () => {
      approve.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(byTestId(host, "approval-confirm")).toHaveLength(0);
    expect(byTestId(host, "approval-commit")).toHaveLength(0);
  });

  it("#3819: 거부도 한 번에 나간다", async () => {
    const host = mountCard(approvalProps());
    const fetchSpy = vi.fn(async () =>
      jsonResponse({ ...APPENDIX_C_BODY, status: "rejected", result: undefined })
    );
    vi.stubGlobal("fetch", fetchSpy);
    const reject = byTestId(host, "approval-reject")[0] as HTMLButtonElement;
    reject.focus();
    await act(async () => {
      reject.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const init = (fetchSpy.mock.calls[0] as unknown as [string, RequestInit])[1];
    const body = JSON.parse(String(init.body));
    expect(body.approve).toBe(false);
    expect(byTestId(host, "request-bundle-state")[0]?.textContent).toBe("거부");
    // 눌린 버튼은 영수증 줄로 바뀌며 사라진다 — 초점은 카드가 받는다(body 로 떨어지지 않는다).
    expect(document.activeElement).toBe(byTestId(host, "agent-card")[0]);
  });

  it("#3819: 보내는 동안 같은 결정이 두 번 나가지 않는다 — 두 버튼 모두", async () => {
    const host = mountCard(approvalProps());
    let release: (response: Response) => void = () => undefined;
    const fetchSpy = vi.fn(
      () => new Promise<Response>((resolve) => (release = resolve))
    );
    vi.stubGlobal("fetch", fetchSpy);
    const approve = byTestId(host, "approval-approve")[0] as HTMLButtonElement;
    const reject = byTestId(host, "approval-reject")[0] as HTMLButtonElement;
    approve.focus();
    await act(async () => {
      approve.click();
      approve.click();
      reject.click();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // 보내는 중은 `disabled` 가 아니라 `aria-disabled` — 초점이 body 로 떨어지지 않는다.
    expect(approve.textContent).toBe("보내는 중");
    expect(approve.getAttribute("aria-disabled")).toBe("true");
    expect(approve.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(approve);
    await act(async () => {
      release(jsonResponse({ ...APPENDIX_C_BODY, result: undefined }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("#3819: y/n 단축키는 결정하지 않고 버튼에 초점을 놓는다", async () => {
    const host = mountCard(approvalProps());
    const fetchSpy = vi.fn(async () => jsonResponse(APPENDIX_C_BODY));
    vi.stubGlobal("fetch", fetchSpy);
    const card = byTestId(host, "agent-card")[0] as HTMLElement;
    card.focus();
    act(() => {
      card.dispatchEvent(
        new KeyboardEvent("keydown", { key: "y", bubbles: true })
      );
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byTestId(host, "approval-approve")[0]);
    card.focus();
    act(() => {
      card.dispatchEvent(
        new KeyboardEvent("keydown", { key: "n", bubbles: true })
      );
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(byTestId(host, "approval-reject")[0]);
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

  it("403 은 「관리자가 승인해야 해요」와 다음 행동을 카드 안에 세운다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ status: "pending" }, 403));
    const error = byTestId(host, "approval-error")[0];
    expect(error?.textContent).toContain("관리자가 승인해야 해요.");
    expect(error?.textContent).toContain("아직 대기 중");
    // 사고가 아니다: 붉은 alert 이 아니라 조용한 안내로 선다.
    expect(error?.getAttribute("role")).toBe("status");
    expect(error?.dataset.tone).toBe("unavailable");
  });

  it("AX-3b #2549: 영수증이 role_required 라고 말하면 같은 안내가 선다", async () => {
    const host = mountCard(approvalProps());
    // 계약 확정 모양: `ErrorResponse.code` 가 아니라 **영수증의 status** 다.
    await decide(
      host,
      jsonResponse({ approval_id: APPROVAL_ID, status: "role_required" }, 403)
    );
    const error = byTestId(host, "approval-error")[0];
    expect(error?.textContent).toContain("관리자가 승인해야 해요.");
    expect(error?.dataset.tone).toBe("unavailable");
    expect(error?.getAttribute("role")).toBe("status");
    // 초점은 누른 버튼에 남는다 — 다시 누를 자리를 잃지 않는다(#3819).
    expect(byTestId(host, "approval-commit")).toHaveLength(0);
    expect(document.activeElement).toBe(byTestId(host, "approval-approve")[0]);
  });

  it("AX-3b #2549: role_required 영수증도 승인 상태를 뒤집지 않는다", async () => {
    const host = mountCard(approvalProps());
    await decide(
      host,
      jsonResponse({ approval_id: APPROVAL_ID, status: "role_required" }, 403)
    );
    // 칩은 여전히 「승인 필요」다 — §5: approval 은 여전히 pending 이다.
    expect(byTestId(host, "request-bundle-state")[0]?.textContent).toBe("승인 필요");
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
  });

  it("R1 M1: 403 뒤에도 확정 버튼은 없고 승인·거부가 그대로 선다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ status: "pending" }, 403));
    expect(byTestId(host, "approval-commit")).toHaveLength(0);
    // 카드는 여전히 대기다 — 다른 사람이 이어받을 수 있어야 한다.
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
    expect(byTestId(host, "approval-reject")).toHaveLength(1);
  });

  it("R1 H2: 403 뒤 초점이 body 로 떨어지지 않고 누른 버튼에 남는다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ status: "pending" }, 403));
    expect(host.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(byTestId(host, "approval-approve")[0]);
    // 카드는 여전히 이름과 링을 가진 정거장이다.
    const card = byTestId(host, "agent-card")[0];
    expect(card?.getAttribute("aria-label")).toBe("팀원 초대 링크 만들기");
    expect(card?.className).toContain("focus-visible:focus-ring");
  });

  it("R2 H-R2-1: 성공 착지 정거장(1회 링크 그룹)이 house 링을 든다", async () => {
    const settled = mountCard(approvalProps());
    await decide(settled, jsonResponse(APPENDIX_C_BODY));
    const groupRing = (document.activeElement as HTMLElement).className;
    expect(groupRing).toContain("focus-visible:focus-ring");
  });

  it("R2 H-R2-1: 착지 대안인 컨트롤 컨테이너도 링을 든다", () => {
    // 카드가 없는 표면(인박스)에서는 `onLandOnCard` 가 없어 `root` 로 떨어진다.
    // 그 `div` 도 `tabIndex=-1` 로 초점을 받으므로 링이 있어야 한다.
    const host = mountCard(approvalProps());
    const root = byTestId(host, "approval-approve")[0]?.closest(
      "[tabindex='-1']"
    ) as HTMLElement | null;
    expect(root?.className).toContain("focus-visible:focus-ring");
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
      "채널 멤버인지 확인해 주세요"
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
      "실행을 마쳤어요."
    );
    expect(byTestId(host, "action-result-secret-once")[0]?.textContent).toContain(
      "1회 표시됐어요"
    );
  });

  it("R1 H1: 부록 B 원문(`section=invites`)은 이 빌드가 모르는 섹션이라 문이 서지 않는다", () => {
    const host = mountResult();
    // 픽스처는 계약 원문 그대로다. 문이 없는 것이 이 빌드의 참이다 —
    // `SettingsRoute` 가 모르는 섹션을 조용히 프로필로 접기 때문이다.
    expect(byTestId(host, "action-result-next")).toHaveLength(0);
    // 카드는 말을 잃지 않는다.
    expect(byTestId(host, "action-result-note")[0]?.textContent).toBe(
      "실행을 마쳤어요."
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

  it("R2 M-R2-1: 게이트된 섹션에는 문이 서지 않는다", () => {
    // `updates` 는 데스크톱 셸에만, `code` 는 서버가 그 표면을 실었을 때만
    // 있다. 웹 브라우저의 설정 목록에는 없으므로 누르면 프로필로 떨어진다 —
    // `invites` 와 같은 결함의 다른 이름이다.
    for (const section of ["updates", "code", "invites"]) {
      const host = mountResult({
        next: { label: "설정에서 보기", href: `/settings?section=${section}` },
      });
      expect(
        byTestId(host, "action-result-next"),
        `${section} 에 문이 섰다`
      ).toHaveLength(0);
      unmount();
    }
    for (const section of ["members", "webhooks", "profile"]) {
      const host = mountResult({
        next: { label: "설정에서 보기", href: `/settings?section=${section}` },
      });
      expect(
        byTestId(host, "action-result-next"),
        `${section} 에 문이 없다`
      ).toHaveLength(1);
      unmount();
    }
  });

  it("R2 M-R2-1: 도착 가능 판정은 설정 화면의 목록과 같은 함수다", () => {
    // 세 소비자(설정 셸·결과 카드·팔레트)가 같은 답을 든다. 원표를 직접 읽는
    // 쪽이 하나라도 남으면 그쪽이 먼저 낡는다.
    const reachable = reachableSettingsSections().map((item) => item.id);
    expect(reachable).not.toContain("updates");
    expect(reachable).not.toContain("code");
    expect(reachable).toContain("members");
    // 링크 행(`aiHub`)은 목차의 행이지만 `?section=` 값이 아니다(#4111).
    const linkIds = reachableSettingsSections().filter((item) => item.link).map((item) => item.id);
    expect(linkIds).toEqual(["aiHub"]);
    for (const id of reachable.filter((item) => !linkIds.includes(item))) {
      expect(isReachableHref(`/settings?section=${id}`)).toBe(true);
    }
    expect(isReachableHref("/settings?section=aiHub")).toBe(false);
    // 합친 옛 구획(별칭)과 AI 허브로 옮겨 간 옛 구획은 목록에는 없지만 문이 닿는다 (#3578 S1).
    for (const id of ["account", "link-previews", "terminal", "webhooks", "agents", "ai"]) {
      expect(isReachableHref(`/settings?section=${id}`)).toBe(true);
    }
    for (const id of ["updates", "code", "invites"]) {
      expect(isReachableHref(`/settings?section=${id}`)).toBe(false);
    }
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
      ["executed", "끝", "실행을 마쳤어요."],
      ["rejected", "거부", "승인하지 않아 실행하지 않았어요."],
      ["expired", "만료", "승인을 기다리다 만료됐어요"],
      ["role_required", "권한 필요", "관리자가 승인해야 해요."],
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

// =============================================================================
// #3771: 승인 직후 카드가 다시 버튼을 그렸다.
//
// 서버는 결정 때 메시지 props를 고치지만 방송하지 않는다. 그래서 클라이언트가 든 메시지는
// 계속 `status: pending`이고, 결정 결과는 카드의 useState 하나에만 있었다. 가상 리스트가
// 행을 내렸다 올려 카드가 새로 마운트되면 그 state가 사라져 버튼이 되살아났다(운영 실측).
// 아래 시험은 **같은 낡은 pending 스냅샷으로 재마운트**해 그 순간을 그대로 만든다.
// =============================================================================
describe("승인 직후 재마운트해도 카드는 결정 상태다 (#3771)", () => {
  it("승인 → 같은 낡은 pending 스냅샷으로 재마운트 → 버튼이 없고 영수증 줄이 있다", async () => {
    const props = approvalProps();
    const host = mountCard(props);
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
    await decide(host, jsonResponse({ ...APPENDIX_C_BODY, result: undefined }));
    expect(byTestId(host, "approval-approve")).toHaveLength(0);

    // 메시지는 서버가 방송하지 않아 여전히 pending이다 — 그 스냅샷 그대로 새로 마운트.
    unmount();
    const remounted = mountCard(props);
    expect(byTestId(remounted, "approval-approve")).toHaveLength(0);
    expect(byTestId(remounted, "approval-reject")).toHaveLength(0);
    expect(remounted.textContent ?? "").toContain("승인");
  });

  it("재마운트 뒤에도 1회 값은 새로 생기지 않는다 (D4는 그대로)", async () => {
    const props = approvalProps();
    const host = mountCard(props);
    await decide(host, jsonResponse(APPENDIX_C_BODY));
    expect(host.textContent ?? "").toContain(SECRET);
    unmount();
    const remounted = mountCard(props);
    expect(remounted.textContent ?? "").not.toContain(SECRET);
    expect(byTestId(remounted, "approval-approve")).toHaveLength(0);
  });

  it("다른 승인 카드는 영향받지 않는다", async () => {
    const host = mountCard(approvalProps());
    await decide(host, jsonResponse({ ...APPENDIX_C_BODY, result: undefined }));
    unmount();
    const other = mountCard({
      ...approvalProps(),
      approval_id: "0199aa11-2222-7000-8000-0000000000a2",
    });
    expect(byTestId(other, "approval-approve")).toHaveLength(1);
  });
});

// =============================================================================
// #3818: 배포 전에 결정된 옛 카드에 거부/승인 버튼이 다시 보였다.
//
// #3779의 영수증 저장소는 **이번 세션에 결정한** 카드만 안다. 서버가 이미 결정을 적은
// 카드(`message.props`의 status·decided_by)는 영수증이 없으므로, 카드는 서버가 말한
// 사실만으로 버튼을 숨겨야 한다. 이 시험은 영수증을 일부러 비워 둔 채(저장소 reset)
// 서버 props만으로 그린다 — 푸터가 `settled`를 보지 않던 옛 분기로 되돌리면 실패한다.
// =============================================================================
describe("서버가 이미 결정한 옛 카드는 버튼이 없다 (#3818)", () => {
  for (const status of ["approved", "rejected", "cancelled", "expired"] as const) {
    it(`props.status=${status} → 영수증 없이도 승인·거부 버튼과 y/n 단축키가 없다`, () => {
      const host = mountCard({
        ...approvalProps(),
        status,
        approval_status: status,
        decided_by: ME,
        decided_at_ms: 1_753_400_000_000,
      });
      expect(byTestId(host, "approval-approve")).toHaveLength(0);
      expect(byTestId(host, "approval-reject")).toHaveLength(0);
      expect(byTestId(host, "approval-commit")).toHaveLength(0);
      const card = byTestId(host, "agent-card")[0];
      expect(card?.dataset.status).toBe(status);
      expect(card?.getAttribute("aria-keyshortcuts")).toBeNull();
    });
  }

  it("결정자·원장 줄은 그대로 남는다", () => {
    const host = mountCard({
      ...approvalProps(),
      status: "approved",
      approval_status: "approved",
      decided_by: ME,
      decided_at_ms: 1_753_400_000_000,
    });
    openDetails(host);
    expect(byTestId(host, "approval-ledger")[0]?.textContent).toContain("곽성재");
    expect(byTestId(host, "approval-ledger")[0]?.textContent).toContain("원장 #");
  });

  it("status 없는 대기 카드는 여전히 버튼을 그린다 (과잉 숨김 방지)", () => {
    const host = mountCard(approvalProps());
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
    expect(byTestId(host, "approval-reject")).toHaveLength(1);
  });
});

// =============================================================================
// 먼저 제안 카드·고정 카드·만료 줄 (ADR-0186 증보 v5 U-c·U-e, #4705).
//
// 픽스처는 서버 PR A(`agent_initiative.rs`)가 쓰는 모양 그대로다: `props.origin`은 최상위,
// `props.action.preview`는 `{kind:"message", messageId, channelId, totalChars, truncated}`.
// 서버가 아직 이 트랙에 없으므로 실서버 확인은 승격 뒤다(runtime-unverified).
// =============================================================================
describe("먼저 제안 카드와 고정 카드 (#4705)", () => {
  const OWNER = "00000000-0000-7000-8000-0000000001a1";
  const PLANNER = "019f9a01-0000-7000-8000-0000000004a1";
  const TARGET_CHANNEL = "00000000-0000-7000-8000-000000000302";
  const TARGET_MESSAGE = "0199AA11-2222-7000-8000-0000000000C1";

  function pinProps(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      ...approvalProps(),
      title: "승인 요청: 메시지 고정",
      origin: "agent_initiated",
      summary: "플래너가 먼저 제안했어요.",
      action: {
        id: "message.pin",
        rows: [
          { label: "채널", value: "#qa" },
          { label: "글자 수", value: "1234자" },
        ],
        rationale: "안내문을 채널 맨 위에 두고 싶어요",
        required_role: "admin",
        preview: {
          kind: "message",
          messageId: TARGET_MESSAGE,
          channelId: TARGET_CHANNEL,
          totalChars: 1234,
          truncated: true,
        },
      },
      ...over,
    };
  }

  function mountPin(props: Record<string, unknown>): HTMLElement {
    const host = mountCard(props, { authorMemberId: PLANNER });
    openDetails(host);
    return host;
  }

  const headTitle = (host: HTMLElement) =>
    byTestId(host, "agent-card")[0]?.getAttribute("aria-label") ?? "";

  it("제목 끝에 짧은 꼬리표가 붙고, 사유 이름표가 에이전트 글이다(새 행은 없다)", () => {
    const host = mountPin(pinProps());
    expect(headTitle(host)).toContain(AGENT_INITIATIVE_LABEL);
    expect(headTitle(host).startsWith("승인 요청")).toBe(true);
    const rationale = byTestId(host, "approval-action-rationale")[0];
    expect(rationale?.textContent).toContain(AGENT_INITIATIVE_RATIONALE_LABEL);
    // 사유는 평문이다: 링크나 서식으로 바뀌지 않고, 아래 줄을 더 세우지 않는다.
    expect(rationale?.querySelectorAll("a, strong, em, code")).toHaveLength(0);
    expect(byTestId(host, "approval-team-ai-rationale-note")).toHaveLength(0);
    // 서버 행 둘과 요청 줄이 전부다: 먼저 제안이 행을 더 세우지 않는다.
    expect(byTestId(host, "approval-action-row")).toHaveLength(2);
  });

  it("에이전트가 쓴 사유는 평문이다: 링크·멘션·서식이 와도 요소가 되지 않고 글자 그대로 선다", () => {
    // 서버는 이런 글을 거절하지만(`rationale` ≤140자, `@ < > [ ] ( ) : /` 불가), 시킨 사람이 없는 카드에서
    // 이 글이 유일한 설득 수단이라 클라이언트도 믿지 않는다(깊은 방어).
    const hostile = "https://evil.test/x <b>굵게</b> @planner **굵게** `코드` [링크](https://a.test) <script>x</script>";
    const base = pinProps();
    const host = mountPin(
      pinProps({ action: { ...(base.action as Record<string, unknown>), rationale: hostile } })
    );
    const row = byTestId(host, "approval-action-rationale")[0];
    expect(row).toBeDefined();
    expect(row?.querySelectorAll("a, b, strong, em, code, script, img")).toHaveLength(0);
    expect(row?.textContent).toContain(hostile);
    // 이 시험이 실제로 잡는지: 같은 글이 값 칸에 요소 없이 한 글자열로만 들어 있다.
    expect(row?.querySelector("dd")?.children.length ?? 0).toBe(0);
  });

  it("origin 이 없으면 지금까지의 카드 그대로다(꼬리표도 이름표도 없다)", () => {
    const props = pinProps();
    delete props.origin;
    const host = mountPin(props);
    expect(headTitle(host)).not.toContain(AGENT_INITIATIVE_LABEL);
    expect(byTestId(host, "approval-action-rationale")[0]?.textContent).not.toContain(
      AGENT_INITIATIVE_RATIONALE_LABEL
    );
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
  });

  it("모르는 origin 값은 꼬리표를 세우지 않는다", () => {
    const host = mountPin(pinProps({ origin: "scheduled" }));
    expect(headTitle(host)).not.toContain(AGENT_INITIATIVE_LABEL);
  });

  it("결정이 난 카드는 꼬리표가 남고 전문 보기 문은 없다", () => {
    const host = mountPin(
      pinProps({ status: "approved", approval_status: "approved", decided_by: OWNER })
    );
    expect(headTitle(host)).toContain(AGENT_INITIATIVE_LABEL);
    expect(byTestId(host, "approval-message-preview-link")).toHaveLength(0);
  });

  it("고정 카드는 전문 보기 문을 결정 전에 세우고, 문은 그 메시지의 자리로 간다", () => {
    const host = mountPin(pinProps());
    const link = byTestId(host, "approval-message-preview-link")[0] as HTMLAnchorElement;
    expect(link).toBeDefined();
    expect(link.getAttribute("href")).toBe(
      `#/c/${TARGET_CHANNEL}?msg=${TARGET_MESSAGE.toLowerCase()}`
    );
    // 서버 행은 그대로 서고, 문은 결정 버튼과 함께 있다.
    expect(byTestId(host, "approval-action-row")).toHaveLength(2);
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
  });

  it("미리보기가 없거나 모르는 종류면 문이 없고 서버 행만 선다", () => {
    const props = pinProps();
    (props.action as Record<string, unknown>).preview = { kind: "thread" };
    const host = mountPin(props);
    expect(byTestId(host, "approval-message-preview")).toHaveLength(0);
    expect(byTestId(host, "approval-action-row")).toHaveLength(2);
  });

  // 먼저 제안이 올릴 수 있는 네 행동(ADR U-b-2) 모두 같은 카드 몸으로 선다: 서버 행이 그대로 서고,
  // 꼬리표와 결정 컨트롤이 있고, 전문 보기 문은 고정 둘에만 있다.
  const INITIATIVE_ACTIONS: ReadonlyArray<{
    id: string;
    rows: Array<{ label: string; value: string }>;
    pin: boolean;
  }> = [
    {
      id: "channel.create",
      rows: [
        { label: "채널 이름", value: "qa" },
        { label: "공개 범위", value: "비공개" },
        { label: "이 에이전트도 참여", value: "예" },
      ],
      pin: false,
    },
    {
      id: "channel.member.add",
      rows: [
        { label: "채널", value: "#qa" },
        { label: "추가할 멤버", value: "박서연" },
      ],
      pin: false,
    },
    {
      id: "message.pin",
      rows: [
        { label: "채널", value: "#qa" },
        { label: "글자 수", value: "40자" },
      ],
      pin: true,
    },
    {
      id: "message.unpin",
      rows: [
        { label: "채널", value: "#qa" },
        { label: "고정한 사람", value: "최민수" },
        { label: "글자 수", value: "40자" },
      ],
      pin: true,
    },
  ];

  for (const action of INITIATIVE_ACTIONS) {
    it(`${action.id} 먼저 제안 카드도 서버 행 그대로 서고 결정 컨트롤이 있다`, () => {
      const block = pinProps().action as Record<string, unknown>;
      const props = pinProps({
        action: {
          ...block,
          id: action.id,
          rows: action.rows,
          ...(action.pin ? {} : { preview: undefined }),
        },
      });
      const host = mountPin(props);
      expect(headTitle(host)).toContain(AGENT_INITIATIVE_LABEL);
      expect(byTestId(host, "approval-action-row")).toHaveLength(action.rows.length);
      expect(byTestId(host, "approval-approve")).toHaveLength(1);
      expect(byTestId(host, "approval-reject")).toHaveLength(1);
      expect(byTestId(host, "approval-message-preview-link")).toHaveLength(action.pin ? 1 : 0);
    });
  }
});

describe("만료 스윕이 남긴 줄 (#4705, 검수 L4)", () => {
  function mountSweepLine(over: Record<string, unknown> = {}): HTMLElement {
    const card = agentCardModel(
      message({
        type: "tool_result",
        body: "Tool call expired without a human approval.",
        props: {
          call_id: "",
          output: "Tool call expired without a human approval.",
          is_error: true,
          approval_id: APPROVAL_ID,
          run_id: "0199aa11-2222-7000-8000-0000000000b2",
          status: "expired",
          decided_at_ms: 1_753_400_000_000,
          ...over,
        },
      })
    );
    if (card === null) throw new Error("no card for the sweep line");
    mountHost = document.createElement("div");
    document.body.append(mountHost);
    mountedRoot = createRoot(mountHost);
    act(() => {
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

  it("실패 칩이 아니라 중립의 만료 칩이고, 영어 문장이 화면에 없다", () => {
    const host = mountSweepLine();
    const chip = byTestId(host, "agent-status-chip")[0];
    expect(chip?.dataset.status).toBe("expired");
    expect(byTestId(host, "agent-frame")[0]?.textContent).toMatch(/[가-힣]/);
    expect(host.textContent).not.toMatch(/expired without/i);
    expect(byTestId(host, "tool-error")).toHaveLength(0);
  });

  it("스윕 줄이 아닌 오류 도구 결과는 지금처럼 실패 칩이다", () => {
    const host = mountSweepLine({ status: "failed", output: "boom" });
    expect(byTestId(host, "agent-status-chip")[0]?.dataset.status).toBe("error");
  });
});

describe("요청 묶음 카드", () => {
  it("결과의 다음 행동은 이 앱에 실제로 있는 목적지만 연다", () => {
    const host = mountCard({ ...approvalProps(), status: "approved", result: { status: "succeeded", next: { label: "초대에서 보기", href: "/settings?section=invites" } } });
    expect(host.querySelector('a[href="#/settings?section=invites"]')).toBeNull();
  });
  it("머리·값 둘·단추 쌍·조용한 줄만 서고 자세히를 닫으면 라벨 행이 DOM에도 없다", () => {
    const host = mountCard({ ...approvalProps(), intent: "팀원 초대 링크를 만들려고 해요", expires_at_ms: Date.now() + 3_600_000 });
    expect(byTestId(host, "request-bundle-headline")[0]?.textContent).toBe("팀원 초대 링크를 만들려고 해요");
    expect(byTestId(host, "request-bundle-values")[0]?.querySelectorAll('[role="group"]')).toHaveLength(2);
    expect(byTestId(host, "approval-approve")).toHaveLength(1);
    expect(byTestId(host, "approval-reject")).toHaveLength(1);
    expect(byTestId(host, "request-bundle-details")[0]?.textContent).toMatch(/시간 남음 · 자세히/);
    expect(host.querySelector("dt")).toBeNull();
    expect(byTestId(host, "agent-payload")).toHaveLength(0);
    openDetails(host);
    expect(byTestId(host, "approval-action-row")).toHaveLength(3);
    const details = byTestId(host, "request-bundle-details")[0] as HTMLDetailsElement;
    act(() => { details.open = false; details.dispatchEvent(new Event("toggle")); });
    expect(host.querySelector("dt")).toBeNull();
  });

  it("구조화된 값은 이전·이후를 접근성 이름에도 담고, 일반 멤버에게 원장·원본 데이터가 없다", () => {
    const host = mountCard({ ...approvalProps(), status: "approved", decided_by: ME, decided_at_ms: Date.now(),
      action: { id: "agent.profile.update", rows: [{ label: "소개", before: "기존 소개", after: "새 소개" }] },
    }, {}, makeDirectory([]));
    expect(host.querySelector('[aria-label="소개: 이전 값 기존 소개, 이후 값 새 소개"]')).not.toBeNull();
    expect(host.querySelector("s")?.textContent).toBe("기존 소개");
    openDetails(host);
    expect(byTestId(host, "agent-payload")).toHaveLength(0);
    expect(host.textContent).not.toContain("원장 #");
  });

  it("서버가 결정할 수 없다고 한 카드는 버튼·키보드 결정을 숨기고 기다릴 사람을 말한다", () => {
    const host = mountCard({ ...approvalProps(), can_decide: false, decision_mode: "inline" });
    expect(byTestId(host, "approval-approve")).toHaveLength(0);
    expect(byTestId(host, "approval-reject")).toHaveLength(0);
    expect(byTestId(host, "agent-card")[0]?.getAttribute("aria-keyshortcuts")).toBeNull();
    expect(host.textContent).toContain("관리자의 승인을 기다려요");
  });

  it.each([
    [{ result: { status: "succeeded", line: "소개를 바꿨어요" } }, "끝"],
    [{ code: "approval_rejected" }, "거부"],
  ])("기한이 지난 pending 스냅샷의 종결 코드를 만료로 덮지 않는다", (terminal, word) => {
    const host = mountCard({ ...approvalProps(), expires_at_ms: Date.now() - 1000, ...terminal });
    expect(byTestId(host, "request-bundle-state")[0]?.textContent).toBe(word);
    expect(byTestId(host, "approval-expired")).toHaveLength(0);
    expect(byTestId(host, "approval-approve")).toHaveLength(0);
  });

  it.each([
    ["thinking", {}, "생각 중"], ["pending", {}, "승인 필요"],
    ["approved", { action_type: "tool_call", action: undefined, tool_name: "shell" }, "실행 중"],
    ["approved", {}, "끝"], ["rejected", {}, "거부"], ["expired", {}, "만료"],
    ["pending", { result: { status: "failed" } }, "실패"], ["cancelled", {}, "취소"],
  ])("%s 상태를 같은 카드 한 장에서 코어 낱말 %s로 읽는다", (status, extra, word) => {
    const host = mountCard({ ...approvalProps(), status, ...extra });
    expect(byTestId(host, "agent-card")).toHaveLength(1);
    expect(byTestId(host, "request-bundle-state")[0]?.textContent).toBe(word);
    if (word !== "승인 필요") expect(byTestId(host, "approval-approve")).toHaveLength(0);
  });
});
