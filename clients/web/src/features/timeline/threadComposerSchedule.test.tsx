// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import { COMPOSER_OFFLINE_COPY } from "@momo/core/features/chat/composerCopy";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// ADR-0208 부록 B(#4215): 스레드 입력창의 「예약해서 보내기」.
//
// 채널 입력창과 같은 훅을 쓰지만 호스트가 다르다(UI 명세 0.3·0.4): 보이는 3초 상태줄 자리가 없어서 확인은 지속 배너가
// 맡고 낭독은 늘 붙어 있는 안 보이는 `role="status"` 노드가 읽는다. ▾는 서버에 예약이 있으면 늘 그려지고, 이 입력창이
// 이전에 갖지 않던 오프라인 판정을 같은 훅으로 연결한다. 예약에는 `rootId`가 실린다.
// =============================================================================

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
  sendThreadReply: vi.fn(),
}));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { clearThreadDraft, readThreadDraft } from "@/features/chat/draftStore";
import { resetAttachmentDraftsForTest } from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { ThreadComposer } from "./ThreadComposer";

const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const TOMORROW_9 = new Date("2026-10-23T09:00:00+09:00").getTime();

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ROOT = "00000000-0000-7000-8000-000000000301";
const OTHER_ROOT = "00000000-0000-7000-8000-000000000302";
const CHANNELS = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false }] as unknown as Channel[];

function scheduledRow(over: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: "00000000-0000-7000-8000-0000000004a1",
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    rootId: ROOT,
    body: "스레드에 거는 답글",
    sendAtMs: TOMORROW_9,
    status: "pending",
    editableUntilMs: TOMORROW_9 - 30_000,
    rev: 0,
    createdAtMs: NOW - 3_600_000,
    updatedAtMs: NOW - 3_600_000,
    ...over,
  };
}

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let here = "";
let sent = 0;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  for (const fn of Object.values(scheduledApi)) fn.mockReset();
  for (const fn of Object.values(api)) fn.mockReset();
  api.listChannels.mockResolvedValue(CHANNELS);
  api.fetchRoster.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  api.sendThreadReply.mockImplementation(async () => {
    sent += 1;
  });
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  clearThreadDraft(WS, ROOT);
  sent = 0;
  onlineManager.setOnline(true);
  window.dispatchEvent(new Event("online"));
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
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

function Probe() {
  const location = useLocation();
  here = `${location.pathname}${location.search}`;
  return null;
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  await act(async () => {
    mountedRoot?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          MemoryRouter,
          { initialEntries: [`/c/${CH}`] },
          createElement(
            SessionProvider,
            { value: session() },
            createElement(ThreadComposer, {
              workspaceId: WS,
              channelId: CH,
              rootId: ROOT,
              directory: makeDirectory([]),
              channels: CHANNELS,
              onSent: () => undefined,
            }),
            createElement(Probe)
          )
        )
      )
    );
  });
  await settle();
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const byId = (testId: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
function need(testId: string): HTMLElement {
  const el = byId(testId);
  if (!el) throw new Error(`없다: ${testId}`);
  return el;
}
const textOf = (testId: string): string => (byId(testId)?.textContent ?? "").replace(/\s+/g, " ").trim();
const inputEl = () => need("thread-composer-input") as HTMLTextAreaElement;
const triggerEl = () => need("thread-composer-schedule-trigger");

async function type(value: string) {
  const area = inputEl();
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keydown(target: HTMLElement, key: string, init: KeyboardEventInit = {}) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
  await settle(1);
}

async function press(target: HTMLElement) {
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

async function openMenu() {
  await act(async () => {
    triggerEl().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await settle(1);
}

function manualCreate() {
  let resolve!: (row: ScheduledMessage) => void;
  const done = new Promise<ScheduledMessage>((ok) => {
    resolve = ok;
  });
  scheduledApi.createScheduledMessage.mockImplementationOnce(() => done);
  return { resolve };
}

describe("입구와 막힌 이유 (UI 명세 0.4: 스레드 입력창)", () => {
  it("서버에 예약이 있으면 입력이 비어 있어도 ▾가 서고, 흐리며, 이유는 title과 낭독에 실린다", async () => {
    await mount();
    expect(triggerEl().getAttribute("aria-label")).toBe("예약해서 보내기");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    expect(triggerEl().getAttribute("title")).toBe("보낼 내용을 쓰면 예약할 수 있어요");
    const reasonId = triggerEl().getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe("보낼 내용을 쓰면 예약할 수 있어요");
    // 보내기와 ▾가 한 알약이다.
    expect(need("thread-composer-send").className).toContain("rounded-r-none");
  });

  it("첫 목록이 404면 ▾도 배너도 없고 보내기는 예전 그대로 원 하나다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(404, "not found"));
    await mount();
    expect(byId("thread-composer-schedule-trigger")).toBeNull();
    expect(byId("thread-composer-scheduled-banner")).toBeNull();
    expect(need("thread-composer-send").className).toContain("rounded-full");
    expect(need("thread-composer-send").className).not.toContain("rounded-r-none");
  });

  it("흐린 ▾를 누르면 눈에 보이는 줄이 아니라 늘 붙어 있는 안 보이는 status 노드가 이유를 읽는다", async () => {
    await mount();
    expect(need("thread-composer-status").getAttribute("role")).toBe("status");
    expect(need("thread-composer-status").className).toContain("sr-only");
    expect(textOf("thread-composer-status")).toBe("");
    await keydown(triggerEl(), "Enter");
    expect(textOf("thread-composer-status")).toBe("보낼 내용을 쓰면 예약할 수 있어요");
    // 이 호스트에는 보이는 상태줄이 없다.
    expect(byId("thread-composer-status-line")).toBeNull();
    expect(byId("thread-composer-schedule-menu")).toBeNull();
  });

  it("오프라인: 이 입력창에도 오프라인 줄이 서고 보내기와 ▾가 같은 판정으로 함께 흐려진다", async () => {
    await mount();
    await type("답글");
    expect((need("thread-composer-send") as HTMLButtonElement).disabled).toBe(false);
    expect(triggerEl().getAttribute("aria-disabled")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(textOf("thread-composer-offline")).toBe(COMPOSER_OFFLINE_COPY);
    expect((need("thread-composer-send") as HTMLButtonElement).disabled).toBe(true);
    expect(need("thread-composer-send").getAttribute("title")).toBe(COMPOSER_OFFLINE_COPY);
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    expect(triggerEl().getAttribute("title")).toBe(COMPOSER_OFFLINE_COPY);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(byId("thread-composer-offline")).toBeNull();
    expect((need("thread-composer-send") as HTMLButtonElement).disabled).toBe(false);
  });

  it("오프라인에서는 Enter도 답글을 보내지 않는다", async () => {
    await mount();
    await type("답글");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await keydown(inputEl(), "Enter");
    expect(sent).toBe(0);
  });
});

describe("예약 흐름: 스레드 답글 (ADR-0208 D1, UI 명세 0.5)", () => {
  it("rootId가 실리고, 201 뒤에만 비우며, 확인은 안 보이는 노드와 배너가 맡는다", async () => {
    const inflight = manualCreate();
    await mount();
    await type("스레드에 거는 답글");
    await openMenu();
    await press(need("thread-composer-schedule-preset-tomorrow"));
    const [workspaceId, input] = scheduledApi.createScheduledMessage.mock.calls[0]!;
    expect(workspaceId).toBe(WS);
    expect(input).toMatchObject({ channelId: CH, rootId: ROOT, body: "스레드에 거는 답글", sendAtMs: TOMORROW_9, attachmentIds: [] });
    // 응답 전에는 비우지 않는다.
    expect(inputEl().value).toBe("스레드에 거는 답글");
    await act(async () => {
      inflight.resolve(scheduledRow());
    });
    await settle();
    expect(inputEl().value).toBe("");
    expect(readThreadDraft(WS, ROOT)).toBe("");
    expect(textOf("thread-composer-status")).toBe("내일 오전 9:00에 보낼게요");
    expect(byId("thread-composer-status-line")).toBeNull();
    expect(textOf("thread-composer-scheduled-banner")).toContain("이 스레드에 예약된 메시지 1개");
    expect(sent).toBe(0);
    expect(document.activeElement).toBe(inputEl());
  });

  it("배너는 이 스레드의 예약만 센다(같은 채널의 다른 스레드·스레드가 아닌 글은 세지 않는다)", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([
      scheduledRow(),
      scheduledRow({ id: "00000000-0000-7000-8000-0000000004a2", rootId: OTHER_ROOT }),
      scheduledRow({ id: "00000000-0000-7000-8000-0000000004a3", rootId: undefined }),
    ]);
    await mount();
    expect(textOf("thread-composer-scheduled-banner")).toContain("이 스레드에 예약된 메시지 1개");
  });

  it("스레드 배너는 입력 틀에 닿지 않는다: 아래 여백 8px을 둔다(채널 입력창의 배너는 틀 위의 자기 띠라 필요 없다) (design-review #4215 M3)", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([scheduledRow()]);
    await mount();
    expect(need("thread-composer-scheduled-banner").className).toContain("mb-2");
  });

  it("실패한 예약이 있으면 실패 어조 한 줄이 서고, 「보기」는 그 스레드로 거른 목록을 연다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([
      scheduledRow({ status: "failed", failureReason: "missed", sendAtMs: NOW - 3_600_000, editableUntilMs: undefined }),
    ]);
    await mount();
    const banner = need("thread-composer-scheduled-banner");
    expect(banner.textContent).toContain("예약한 메시지 1개를 보내지 못했어요");
    expect(banner.getAttribute("role")).toBe("alert");
    await act(async () => {
      banner.querySelector("button")?.click();
    });
    expect(here).toBe(`/scheduled?channel=${CH}&thread=${ROOT}`);
  });

  it("실패하면 글이 남고 고른 시각이 채워진 직접 고르기가 오류 줄과 함께 열린다", async () => {
    scheduledApi.createScheduledMessage.mockRejectedValueOnce(new ApiError(403, "forbidden"));
    await mount();
    await type("남아야 하는 답글");
    await openMenu();
    await press(need("thread-composer-schedule-preset-tomorrow"));
    expect(byId("schedule-dialog")).not.toBeNull();
    expect(textOf("schedule-dialog-error")).toBe("이 채널에 예약할 수 없어요. 들어가 있는 채널인지, 첨부가 내 파일인지 확인해 주세요.");
    expect(inputEl().value).toBe("남아야 하는 답글");
  });

  it("예약 요청이 나는 동안 같은 글이 답글로도 나가지 않는다(Enter·보내기 단추 모두)", async () => {
    manualCreate();
    await mount();
    await type("글");
    await openMenu();
    await press(need("thread-composer-schedule-preset-tomorrow"));
    expect(need("thread-composer-send").getAttribute("aria-busy")).toBe("true");
    expect(triggerEl().getAttribute("aria-busy")).toBe("true");
    // 이 호스트에는 눈에 보이는 줄이 없으니 안 보이는 status 노드가 「예약 중」을 읽는다.
    expect(textOf("thread-composer-status")).toBe("예약 중");
    expect(byId("thread-composer-status-line")).toBeNull();
    await keydown(inputEl(), "Enter");
    await act(async () => {
      need("thread-composer-send").click();
    });
    expect(api.sendThreadReply).not.toHaveBeenCalled();
  });

  it("답글이 나가는 동안은 ▾가 잠겨 같은 글이 예약으로도 나가지 않는다", async () => {
    let finish!: () => void;
    api.sendThreadReply.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    await mount();
    await type("글");
    await act(async () => {
      need("thread-composer-send").click();
    });
    expect(api.sendThreadReply).toHaveBeenCalledTimes(1);
    expect(triggerEl().getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      triggerEl().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    await settle(1);
    expect(byId("thread-composer-schedule-menu")).toBeNull();
    await act(async () => {
      finish();
    });
    await settle();
    expect(triggerEl().getAttribute("aria-busy")).toBeNull();
  });

  it("키 모양 글: 예약을 고르면 막히고 줄의 첫 문장이 「예약하지 않았어요」, 보내기에서는 「보내지 않았어요」", async () => {
    await mount();
    await type("키예요 sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90");
    await openMenu();
    await press(need("thread-composer-schedule-preset-tomorrow"));
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
    expect(textOf("thread-composer-secret-block")).toContain("이 메시지는 예약하지 않았어요.");
    await keydown(inputEl(), "Enter");
    expect(textOf("thread-composer-secret-block")).toContain("이 메시지는 보내지 않았어요.");
    expect(api.sendThreadReply).not.toHaveBeenCalled();
  });

  it("한도(50개): 메뉴는 열리고 항목은 aria-disabled이며 문장이 맨 위에 선다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => scheduledRow({ id: `00000000-0000-7000-8000-0000000005${String(i).padStart(2, "0")}`, rootId: undefined, sendAtMs: TOMORROW_9 + i * 60_000 }))
    );
    await mount();
    await type("글");
    await openMenu();
    expect(textOf("thread-composer-schedule-limit")).toBe("예약은 50개까지 걸 수 있어요. 대기 중인 예약을 지우거나 지금 보낸 뒤에 다시 해 보세요.");
    expect(need("thread-composer-schedule-preset-tomorrow").getAttribute("aria-disabled")).toBe("true");
  });
});


it("#4790 입력창 호출부도 다섯 줄에서 멈추고 내부 스크롤한다", async () => {
  const height = vi.spyOn(HTMLTextAreaElement.prototype, "scrollHeight", "get").mockReturnValue(600);
  try {
    await mount();
    const input = document.querySelector("textarea")!;
    // jsdom에서 CSS 없는 기본값은 16px × 1.5 = 24px다.
    const css = window.getComputedStyle(input);
    const row = Number.parseFloat(css.lineHeight) || (Number.parseFloat(css.fontSize) || 16) * 1.5;
    const frame = [css.paddingTop, css.paddingBottom, css.borderTopWidth, css.borderBottomWidth]
      .reduce((sum, value) => sum + (Number.parseFloat(value) || 0), 0);
    expect(Number.parseFloat(input.style.height)).toBe(Math.round(5 * row + frame));
    expect(input.style.overflowY).toBe("auto");
  } finally {
    height.mockRestore();
  }
});
