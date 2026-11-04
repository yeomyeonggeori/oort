// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ConnectionContext } from "@/features/common/connectionContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { connectionScene, type ConnectionScene } from "@/testing/connectionViews";
import { koreanLocale } from "@/testing/koLocale";

// =============================================================================
// #5239: 입력창 위 막힘 줄은 **연결 상태 모델이 고른 원인**을 말한다. 진짜 `Composer`를 코어 모델이 돌린 모습
// (`connectionScene`) 위에 그려, 원인마다 줄이 무엇을 말하는지(또는 서지 않는지)를 잰다.
//
//   기기 오프라인       「오프라인이라 …」 — 보내기 단추 잠금, 단추 설명도 같은 문장
//   서버에 닿지 못함    「서버에 닿지 못해 …」 — 오프라인이라고 말하지 않는다(이 칸이 고친 거짓말)
//   알 수 없음          모델이 막지 않는다(모르면 막지 않는다): 줄 없음, 보내기 열림
//   실시간만 끊김       보내기는 REST다: 줄 없음, 보내기 열림 (#5201 결정 ③)
//   로그인 만료         모델에 문장이 없다: 원인을 말하지 않는 중립 문장으로 물러난다
//
// 문장은 손으로 적는다(사전의 값을 되풀이하면 코드와 시험이 함께 틀려도 초록이다).
// =============================================================================

const OFFLINE = "오프라인이라 지금은 보낼 수 없어요. 쓰던 글은 그대로 있고, 다시 연결되면 여기서 보낼 수 있어요.";
const SERVER = "서버에 닿지 못해 지금은 보낼 수 없어요. 쓰던 글은 그대로 있고, 다시 연결되면 여기서 보낼 수 있어요.";

const scheduledApi = vi.hoisted(() => ({
  listAllScheduledMessages: vi.fn(),
  createScheduledMessage: vi.fn(),
  updateScheduledMessage: vi.fn(),
  sendScheduledMessageNow: vi.fn(),
  deleteScheduledMessage: vi.fn(),
}));
vi.mock("@momo/core/features/scheduled/api", () => scheduledApi);

const api = vi.hoisted(() => ({
  listChannels: vi.fn(),
  fetchRoster: vi.fn(),
  createAttachmentUpload: vi.fn(),
  completeAttachmentUpload: vi.fn(),
  fetchWorkHosts: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

const transport = vi.hoisted(() => ({ putAttachmentBytes: vi.fn() }));
vi.mock("@/features/attachments/uploadTransport", () => transport);

import { OpenAgentProfileContext } from "@/features/routing/useAgentProfile";
import { resetAttachmentDraftsForTest } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft } from "@/features/chat/draftStore";
import { Composer } from "./Composer";

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel];

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  api.fetchWorkHosts.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  transport.putAttachmentBytes.mockReset();
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  clearDraft(WS, CH);
  onlineManager.setOnline(true);
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

async function mount(scene: ConnectionScene): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(LocaleProvider, {
        locale: ko,
        children: createElement(
          QueryClientProvider,
          { client },
          createElement(
            MemoryRouter,
            { initialEntries: [`/c/${CH}`] },
            createElement(
              OpenAgentProfileContext.Provider,
              { value: () => undefined },
              createElement(
                SessionProvider,
                { value: session() },
                createElement(
                  ConnectionContext.Provider,
                  { value: connectionScene(scene) },
                  createElement(Composer, {
                    workspaceId: WS,
                    channelId: CH,
                    directory: makeDirectory([]),
                    channels: CHANNELS,
                    channelLabel: "일반",
                    recipient: "place",
                    dmAgent: null,
                    quote: null,
                    onCancelQuote: () => undefined,
                    onSend: () => undefined,
                  })
                )
              )
            )
          )
        ),
      })
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  await type("쓰던 글");
}

async function type(value: string) {
  const area = document.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const byId = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const lineText = () => (byId("composer-offline")?.textContent ?? "").replace(/\s+/g, " ").trim();
const send = () => byId("composer-send") as HTMLButtonElement;

describe("입력창 막힘 줄은 막은 원인을 말한다 (#5239)", () => {
  it("기기 오프라인: 「오프라인이라 …」이고 보내기 단추의 설명도 같은 문장이다", async () => {
    expect(connectionScene("deviceOffline").view.cause).toBe("deviceOffline");
    await mount("deviceOffline");
    expect(lineText()).toBe(OFFLINE);
    expect(send().disabled).toBe(true);
    expect(send().getAttribute("title")).toBe(OFFLINE);
  });

  it("서버에 닿지 못함: 「서버에 닿지 못해 …」이고 오프라인이라고 말하지 않는다", async () => {
    expect(connectionScene("serverUnreachable").view.cause).toBe("serverUnreachable");
    await mount("serverUnreachable");
    expect(lineText()).toBe(SERVER);
    expect(lineText()).not.toContain("오프라인");
    expect(send().disabled).toBe(true);
    expect(send().getAttribute("title")).toBe(SERVER);
  });

  // unknown = 알 수 없음, realtimeDown = 실시간만 끊김
  it.each(["unknown", "realtimeDown"] as const)("%s: 줄이 서지 않고 보내기가 열려 있다", async (scene) => {
    expect(connectionScene(scene).view.cause).toBe(scene);
    await mount(scene);
    expect(byId("composer-offline")).toBeNull();
    expect(send().disabled).toBe(false);
    expect(send().getAttribute("title") ?? "").not.toMatch(/오프라인|서버에 닿지/);
  });

  it("로그인 만료: 모델에 문장이 없으므로 원인을 말하지 않는 중립 문장으로 물러난다", async () => {
    expect(connectionScene("expired").view.phase).toBe("expired");
    await mount("expired");
    expect(lineText()).toContain("연결이 끊겨 지금은 보낼 수 없습니다");
    expect(lineText()).not.toContain("오프라인이라");
    expect(send().disabled).toBe(true);
  });
});
