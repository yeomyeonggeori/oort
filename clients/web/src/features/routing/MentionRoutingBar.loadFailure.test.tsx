// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import type { MentionRoutingTarget } from "@momo/core/features/routing/mentionTargets";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { NetworkError } from "@momo/core/lib/http";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { INHERIT_DRAFT } from "@momo/core/features/routing/routingModel";
import { MentionRoutingBar } from "./MentionRoutingBar";

// =============================================================================
// #5279 A: 멘션 줄의 「프로필을 못 읽어 무엇이 적용될지 모른다」 사유가 결과 문장(제목)과 원인(이유)으로 선다. 곁에 「다시 시도」 단추가 있으므로 이유는 다음 행동을
// 되풀이하지 않는다. 훅은 대역이다: 이 시험이 재는 것은 사유 문장과 그 배선(어느 오류 객체가 원인을 정하는가)이다. 레이아웃·펼친 줄은 다른 시험의 몫이다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";

const agentProfile = vi.hoisted(() => ({ error: null as unknown, isPending: false, profile: null, refetch: vi.fn() }));
const called = vi.hoisted(() => ({ agents: [] as unknown[], unreadable: [] as string[], isPending: false, refetch: vi.fn() }));

vi.mock("./useAgentProfile", () => ({
  useAgentProfile: () => agentProfile,
  useOpenAgentProfile: () => () => undefined,
}));
vi.mock("./useMentionRouting", () => ({ useCalledAgentsRouting: () => called }));
vi.mock("./useExecutionTier", () => ({ useExecutionTierAxis: () => ({ summary: null }) }));
vi.mock("./ExecutionTierField", () => ({ ExecutionTierField: () => null }));
vi.mock("./RoutingFields", () => ({ RoutingFields: () => null }));
vi.mock("./capability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./capability")>()),
  useRoutingCapability: () => ({ support: "ready", table: null, reason: null, recheck: () => undefined }),
  useSendRoutingCapability: () => ({ support: "ready", reason: null, prove: () => undefined }),
  useAllowedAgentModels: () => null,
}));
vi.mock("@/features/workspace/useWorkspace", () => ({
  useDirectory: () => ({ directory: makeDirectory([]) }),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

const agent = (handle: string, name: string): RosterMember =>
  ({ id: `00000000-0000-7000-8000-0000000003${handle.length}${name.length}`, workspaceId: WS, kind: "agent", status: "active", displayName: name, handle, role: "member", channelCount: 1, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0 }) as RosterMember;

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "곽성재", handle: "seongjae" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function mount(target: MentionRoutingTarget): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const bar = createElement(MentionRoutingBar, { channelId: "00000000-0000-7000-8000-000000000201", target, draft: INHERIT_DRAFT, onDraftChange: () => undefined });
  const tree = createElement(LocaleProvider, { locale: ko, children: createElement(SessionProvider, { value: sessionValue() }, bar) });
  act(() => mountedRoot?.render(tree));
  return host;
}

function deviceOnline(value: boolean): void {
  vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(value);
}

beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  agentProfile.error = null;
  called.unreadable = [];
  vi.restoreAllMocks();
});

describe("멘션 줄: 프로필을 못 읽었을 때의 사유 (#5279 A)", () => {
  const one = (): MentionRoutingTarget => ({ kind: "one", agent: agent("hana", "하나봇") }) as MentionRoutingTarget;

  it("한 명: 결과 문장 + 원인 이유 한 줄이고, 곁의 「다시 시도」 단추가 다음 행동을 말하므로 이유는 되풀이하지 않는다", () => {
    deviceOnline(true);
    agentProfile.error = new NetworkError("unreachable", 15_000);
    const root = mount(one());
    const notice = root.querySelector('[data-testid="composer-routing-notice"]');
    expect(notice?.textContent).toBe("이 에이전트의 프로필을 불러오지 못해 무엇이 적용될지 확인하지 못했어요. 서버에 닿지 못했어요.");
    expect(notice?.textContent).not.toContain("다시 시도해 주세요");
    expect(root.querySelector('[data-testid="composer-routing-retry"]')?.textContent).toBe("다시 시도");
  });

  it("한 명: 원인은 그 프로필 읽기의 오류 객체가 정한다(기기가 꺼져 있으면 오프라인)", () => {
    deviceOnline(false);
    agentProfile.error = new NetworkError("unreachable", 15_000);
    const root = mount(one());
    expect(root.querySelector('[data-testid="composer-routing-notice"]')?.textContent).toContain("오프라인이에요. 연결되면 다시 불러올 수 있어요.");
  });

  it("한 명: 상태 코드·서버 원문은 화면에 없다", () => {
    deviceOnline(true);
    agentProfile.error = Object.assign(new Error("HTTP 500 internal boom"), { status: 500 });
    const root = mount(one());
    const text = root.querySelector('[data-testid="composer-routing-notice"]')?.textContent ?? "";
    expect(text).not.toMatch(/\d{3}/);
    expect(text).not.toContain("boom");
  });

  it("여러 명: 못 읽은 이름들이 결과 문장에 들어가고 이유가 뒤에 붙는다", () => {
    deviceOnline(true);
    called.unreadable = ["@hana", "@dul"];
    const root = mount({ kind: "many", agents: [agent("hana", "하나봇"), agent("dul", "둘봇")] } as MentionRoutingTarget);
    const notice = root.querySelector('[data-testid="composer-routing-notice"]');
    expect(notice?.textContent).toBe("@hana, @dul의 프로필을 불러오지 못해 무엇이 적용될지 확인하지 못했어요. 문제가 생겼어요.");
    expect(notice?.textContent).not.toContain("다시 시도해 주세요");
    expect(root.querySelector('[data-testid="composer-routing-retry"]')?.textContent).toBe("다시 시도");
  });
});
