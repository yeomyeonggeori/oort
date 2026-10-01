import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RosterMember } from "@momo/core/lib/api";
import type {
  MemoryDigest,
  MemoryDigestPage,
  MemoryItem,
  MemoryProposal,
  MemorySettings,
} from "@momo/core/features/memory/model";
import { ShellNavProvider, type ShellNavValue } from "@/app/shellNav";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// Shared mount + fixtures for the team-memory component tests (#3165). Realistic
// Korean team content, not "테스트 메시지 1".

export const WS = "00000000-0000-7000-8000-000000000001";
export const CH = "00000000-0000-7000-8000-000000000201";
export const OTHER_CH = "00000000-0000-7000-8000-000000000202";
export const ME = "00000000-0000-7000-8000-000000000101";
export const RUN = "00000000-0000-7000-8000-000000000501";
export const AGENT = "00000000-0000-7000-8000-000000000102";
export const JIHOON = "00000000-0000-7000-8000-000000000103";
export const PROPOSAL = "00000000-0000-7000-8000-000000000601";
export const ITEM = "00000000-0000-7000-8000-000000000701";
export const MSG_A = "00000000-0000-7000-8000-000000000801";
export const MSG_B = "00000000-0000-7000-8000-000000000802";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

export function unmount(): void {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

export function digest(over: Partial<MemoryDigest> = {}): MemoryDigest {
  return {
    id: "00000000-0000-7000-8000-000000000401",
    channelId: CH,
    level: "window",
    fromSeq: 12,
    toSeq: 30,
    body: "결제 오류는 재시도 큐를 늘려 해결하기로 했어요.\n배포는 목요일 오전으로 미뤘어요.",
    sourceCount: 18,
    createdAtMs: 1_800_000_000_000,
    evidence: [
      { messageId: "00000000-0000-7000-8000-000000000301", channelId: CH, seq: 14 },
      { messageId: "00000000-0000-7000-8000-000000000302", channelId: CH, seq: 27 },
    ],
    ...over,
  };
}

export function page(over: Partial<MemoryDigestPage> = {}): MemoryDigestPage {
  return { digests: [digest()], afterSeq: 10, summarizedThroughSeq: 30, ...over };
}

export function settings(over: Partial<MemorySettings> = {}): MemorySettings {
  return {
    workspace: { enabled: true, paused: false, resetEpoch: 0 },
    channels: [],
    me: { paused: false },
    ...over,
  };
}

function rosterMember(
  role: RosterMember["role"],
  id = ME,
  kind: RosterMember["kind"] = "human",
  displayName = "곽성재",
  handle = "seongjae"
): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName,
    handle,
    role,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: ME,
        workspaceId: WS,
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

const SHELL_NAV: ShellNavValue = {
  isMobile: false,
  drawerOpen: false,
  openDrawer: () => undefined,
  closeDrawer: () => undefined,
};

export function mount(
  element: ReactElement,
  options: {
    role?: RosterMember["role"];
    route?: string;
    mobile?: boolean;
  } = {}
): { host: HTMLElement; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(
    ["roster", WS],
    [
      rosterMember(options.role ?? "member"),
      rosterMember("member", JIHOON, "human", "박지훈", "jihoon"),
      rosterMember("member", AGENT, "agent", "김인턴", "kim-intern"),
    ]
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const tree = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(
        ShellNavProvider,
        { value: { ...SHELL_NAV, isMobile: options.mobile === true } },
        createElement(
          MemoryRouter,
          { initialEntries: [options.route ?? "/"] },
          element
        )
      )
    )
  );
  act(() => root?.render(tree));
  return { host, client };
}

export async function flush(): Promise<void> {
  // React Query batches notifications on a macrotask, so microtasks are not enough.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Condition-based wait (#3236): a fixed number of flushes assumes how many macrotasks the
// fetch -> query -> render chain needs, which does not hold on a loaded CI runner. Poll the
// actual DOM/mock condition instead. Bounded below vitest's 5s test timeout so a real
// regression fails here with its label instead of timing out the test and leaving this loop
// running into the next one; it also stops once the view is unmounted.
export async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 4000
): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`waitUntil timed out: ${label}`);
    if (root === null) throw new Error(`waitUntil aborted, view unmounted: ${label}`);
    await flush();
  }
}

export function byTestId<T extends HTMLElement = HTMLElement>(
  scope: ParentNode,
  id: string
): T | null {
  return scope.querySelector<T>(`[data-testid="${id}"]`);
}

export function click(el: Element | null): void {
  if (!el) throw new Error("element to click is missing");
  act(() => {
    (el as HTMLElement).click();
  });
}

export function proposal(over: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: PROPOSAL,
    channelId: CH,
    runId: RUN,
    agentMemberId: AGENT,
    requesterMemberId: JIHOON,
    kind: "decision",
    status: "pending",
    text: "결제 재시도 큐는 크기를 두 배로 늘려서 운영하기로 했어요.",
    evidenceMessageIds: [MSG_A, MSG_B],
    evidence: [
      { messageId: MSG_A, seq: 41, authorMemberId: JIHOON },
      { messageId: MSG_B, seq: 42, authorMemberId: ME },
    ],
    callerIsRequester: false,
    createdAtMs: 1_800_000_000_000,
    expiresAtMs: 1_801_200_000_000,
    ...over,
  };
}

export function item(over: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: ITEM,
    channelId: CH,
    spaceKind: "channel",
    kind: "decision",
    origin: "confirmed",
    body: "결제 재시도 큐는 크기를 두 배로 늘려서 운영하기로 했어요.",
    validFromMs: 1_800_000_000_000,
    recordedAtMs: 1_800_000_000_000,
    confidence: 0.9,
    sourceCount: 2,
    ...over,
  };
}

export function type(el: HTMLInputElement | HTMLTextAreaElement | null, value: string): void {
  if (!el) throw new Error("field to type into is missing");
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  act(() => {
    setter?.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
