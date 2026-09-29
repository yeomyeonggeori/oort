import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RosterMember } from "@momo/core/lib/api";
import type {
  MemoryDigest,
  MemoryDigestPage,
  MemorySettings,
} from "@momo/core/features/memory/model";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// Shared mount + fixtures for the team-memory component tests (#3165). Realistic
// Korean team content, not "테스트 메시지 1".

export const WS = "00000000-0000-7000-8000-000000000001";
export const CH = "00000000-0000-7000-8000-000000000201";
export const OTHER_CH = "00000000-0000-7000-8000-000000000202";
export const ME = "00000000-0000-7000-8000-000000000101";
export const RUN = "00000000-0000-7000-8000-000000000501";

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

function rosterMember(role: RosterMember["role"]): RosterMember {
  return {
    id: ME,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName: "곽성재",
    handle: "seongjae",
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

export function mount(
  element: ReactElement,
  options: { role?: RosterMember["role"] } = {}
): { host: HTMLElement; client: QueryClient } {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, retryDelay: 0, staleTime: Infinity },
      mutations: { retry: false },
    },
  });
  client.setQueryData(["roster", WS], [rosterMember(options.role ?? "member")]);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const tree = createElement(
    QueryClientProvider,
    { client },
    createElement(
      SessionProvider,
      { value: sessionValue() },
      createElement(MemoryRouter, null, element)
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
