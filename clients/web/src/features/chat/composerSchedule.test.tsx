// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel, type RosterMember } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { ScheduledMessage } from "@momo/core/features/scheduled/types";
import type { QuoteDraft } from "@momo/core/features/timeline/quote";
import { SessionProvider, type SessionContextValue } from "@/app/session";

// =============================================================================
// ADR-0208 부록 B(#4215): 채널 입력창의 「예약해서 보내기」 한 벌.
//
// 서버 대신 `@momo/core/features/scheduled/api`를 막는다(예약 서버는 이 트리에 없다). 그 밖은 진짜다: 진짜
// `Composer`, 진짜 첨부 트레이 저장소, 진짜 판정(`scheduleGate`), 진짜 Radix 메뉴·대화상자.
// 시계는 2026-10-22(목) 14:30 KST로 고정한다(`TZ=Asia/Seoul`은 웹 시험 설정이 정한다): 「내일 오전 9:00」이
// 매번 같은 에포크다.
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
import {
  addFiles,
  readSurface,
  resetAttachmentDraftsForTest,
  surfaceKey,
} from "@/features/attachments/draftStore";
import { resetSchedulerDisabledForTest } from "@/features/scheduled/useScheduled";
import { clearDraft, readDraft, writeDraft } from "@/features/chat/draftStore";
import { Composer } from "./Composer";
import { usePersonalCall } from "./usePersonalCall";

const NOW = new Date("2026-10-22T14:30:00+09:00").getTime();
const TOMORROW_9 = new Date("2026-10-23T09:00:00+09:00").getTime();
const NEXT_MONDAY_9 = new Date("2026-10-26T09:00:00+09:00").getTime();

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CH = "00000000-0000-7000-8000-000000000201";
const ROW_ID = "00000000-0000-7000-8000-0000000004a1";
const TRAY = surfaceKey(WS, CH);

const CHANNELS: Channel[] = [{ id: CH, workspaceId: WS, kind: "public", name: "일반", muted: false } as Channel];

function scheduledRow(over: Partial<ScheduledMessage> = {}): ScheduledMessage {
  return {
    id: ROW_ID,
    workspaceId: WS,
    memberId: ME,
    channelId: CH,
    body: "내일 회의 전에 자료 올려 둘게요",
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
const sends: Array<{ body: string }> = [];

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
  api.fetchWorkHosts.mockResolvedValue([]);
  scheduledApi.listAllScheduledMessages.mockResolvedValue([]);
  transport.putAttachmentBytes.mockReset();
  resetSchedulerDisabledForTest();
  resetAttachmentDraftsForTest();
  // 초안은 채널의 것이고 시험 사이를 넘어간다: 이 시험의 첫 렌더가 앞 시험의 글을 읽지 않게 비운다.
  clearDraft(WS, CH);
  sends.length = 0;
  // React Query의 온라인 관리자는 모듈 하나를 시험 파일 전체가 쓴다: 오프라인 시험이 끊어 둔 채로 넘기면 다음 시험의
  // 읽기가 멈춘다.
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

/** 내 개인 에이전트: 이 글이 부르면 예약은 막힌다. */
function personalAgent(handle: string): RosterMember {
  return {
    id: `agent-${handle}`,
    workspaceId: WS,
    kind: "agent",
    status: "active",
    displayName: handle,
    handle,
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    personalAgent: { label: handle, ownerId: ME, ownerDisplayName: "x", harness: "claude", enabled: true, mentionable: true },
  } as unknown as RosterMember;
}

/** 지금 주소. 배너의 「보기」가 어디로 가는지 읽는다. */
let here = "";
function LocationProbe() {
  const location = useLocation();
  here = `${location.pathname}${location.search}`;
  return null;
}

interface MountOptions {
  quote?: QuoteDraft | null;
  /** `@my-claude`가 내 개인 에이전트로 읽히는 명부를 쓴다. */
  personal?: boolean;
}

function ComposerHost({ options }: { options: MountOptions }) {
  const directory = makeDirectory(options.personal ? [personalAgent("my-claude")] : []);
  const personalCall = usePersonalCall({
    workspaceId: WS,
    channelId: CH,
    channelKind: "public",
    members: directory.members,
    selfId: ME,
    dmAgent: null,
  });
  return createElement(Composer, {
    workspaceId: WS,
    channelId: CH,
    directory,
    channels: CHANNELS,
    channelLabel: "일반",
    recipient: "place",
    dmAgent: null,
    quote: options.quote ?? null,
    onCancelQuote: () => undefined,
    onSend: (body) => {
      sends.push({ body });
    },
    ...(options.personal ? { personalCall } : {}),
  });
}

async function mount(options: MountOptions = {}): Promise<HTMLElement> {
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
            OpenAgentProfileContext.Provider,
            { value: () => undefined },
            createElement(
              SessionProvider,
              { value: session() },
              createElement(ComposerHost, { options }),
              createElement(LocationProbe)
            )
          )
        )
      )
    );
  });
  await settle();
  return host;
}

async function settle(rounds = 3) {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const byId = (id: string): HTMLElement | null =>
  document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
function need(id: string): HTMLElement {
  const el = byId(id);
  if (!el) throw new Error(`없다: ${id}`);
  return el;
}
const textOf = (id: string): string => (byId(id)?.textContent ?? "").replace(/\s+/g, " ").trim();

async function type(value: string) {
  const area = need("composer-input") as HTMLTextAreaElement;
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
}

/** 메뉴를 포인터로 연다(Radix는 pointerdown으로 연다). */
async function openMenu() {
  await act(async () => {
    need("composer-schedule-trigger").dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  });
  await settle(1);
}

/** 메뉴 항목을 고른다: 포인터 한 번(down·up·click). */
async function choose(id: string) {
  const target = need(id);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

async function click(id: string) {
  const target = need(id);
  await act(async () => {
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await settle(2);
}

/** 손으로 여닫는 쓰기 한 건. 요청이 나는 동안의 상태를 시험이 쥔다. */
function manualCreate() {
  let resolve!: (row: ScheduledMessage) => void;
  let reject!: (error: unknown) => void;
  const done = new Promise<ScheduledMessage>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  scheduledApi.createScheduledMessage.mockImplementationOnce(() => done);
  return { resolve, reject };
}

const TARGET = { workspaceId: WS, channelId: CH };
let attachSerial = 0;

function file(name: string): File {
  return { name, size: 8, type: "text/plain" } as unknown as File;
}

/** 올라간 첨부 한 건(준비됨)을 트레이에 놓는다. */
async function attach(name: string, id: string) {
  attachSerial += 1;
  api.createAttachmentUpload.mockResolvedValueOnce({ id, status: "pending", uploadUrl: `https://archive.invalid/${attachSerial}` });
  api.completeAttachmentUpload.mockResolvedValueOnce({
    id, channelId: CH, uploaderMemberId: ME, name, mime: "text/plain", size: 8, status: "complete", createdAtMs: 0,
  });
  transport.putAttachmentBytes.mockImplementationOnce(() => ({ done: Promise.resolve({ ok: true }), abort: () => {} }));
  await act(async () => {
    addFiles(TRAY, TARGET, [file(name)]);
  });
  await settle(5);
}

/** 올라가는 중인 첨부 한 건. 끝내지 않는다. */
async function attachUploading(name: string, id: string) {
  api.createAttachmentUpload.mockResolvedValueOnce({ id, status: "pending", uploadUrl: "https://archive.invalid/slow" });
  transport.putAttachmentBytes.mockImplementationOnce(() => ({ done: new Promise(() => {}), abort: () => {} }));
  await act(async () => {
    addFiles(TRAY, TARGET, [file(name)]);
  });
  await settle(5);
}

const triggerEl = () => need("composer-schedule-trigger");
const inputEl = () => need("composer-input") as HTMLTextAreaElement;

/** 막힌 ▾를 키보드로 누른다(Enter). */
async function pressBlockedTrigger() {
  await keydown(triggerEl(), "Enter");
  await settle(1);
}
const createdWith = (call = 0) => scheduledApi.createScheduledMessage.mock.calls[call]?.[1] as Record<string, unknown>;

describe("입구: 서버에 예약이 있을 때만 선다 (UI 명세 0.4 첫 행, 0.6)", () => {
  it("첫 목록이 열리면 ▾가 보내기 옆에 서고 이름은 「예약해서 보내기」다", async () => {
    await mount();
    const trigger = triggerEl();
    expect(trigger.getAttribute("aria-label")).toBe("예약해서 보내기");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // 보내기와 ▾가 한 알약이다: 보내기는 오른쪽 모서리를 접는다.
    expect(need("composer-send").className).toContain("rounded-r-none");
  });

  it("첫 목록이 404면 ▾도 배너도 서지 않고 보내기는 예전 그대로 원 하나다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(404, "not found"));
    await mount();
    expect(byId("composer-schedule-trigger")).toBeNull();
    expect(byId("composer-scheduled-banner")).toBeNull();
    expect(need("composer-send").className).not.toContain("rounded-r-none");
  });

  it("목록이 5xx로 실패하면 없는 서버가 아니라 장애로 읽어 ▾를 둔다", async () => {
    scheduledApi.listAllScheduledMessages.mockRejectedValue(new ApiError(503, "unavailable"));
    await mount();
    expect(byId("composer-schedule-trigger")).not.toBeNull();
  });
});


const KEY_LIKE = "sk-ant-api03-Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90";

describe("막힌 ▾는 눌러서 이유를 듣는다 (UI 명세 0.4: 한 번에 한 가지, 위가 먼저)", () => {
  it("빈 입력: aria-disabled로 흐리고 포커스를 받으며, 누르면 이유가 보이는 3초 줄과 낭독 노드에 선다", async () => {
    await mount();
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    expect(triggerEl().hasAttribute("disabled")).toBe(false);
    triggerEl().focus();
    expect(document.activeElement).toBe(triggerEl());
    // 낭독 노드는 늘 붙어 있다: 조건부로 처음 생기는 라이브 리전은 낭독이 보장되지 않는다.
    expect(need("composer-status").textContent).toBe("");
    expect(byId("composer-status-line")).toBeNull();
    await pressBlockedTrigger();
    expect(byId("composer-schedule-menu")).toBeNull();
    expect(textOf("composer-status-line")).toBe("보낼 내용을 쓰면 예약할 수 있어요");
    expect(need("composer-status").getAttribute("role")).toBe("status");
    expect(textOf("composer-status")).toBe("보낼 내용을 쓰면 예약할 수 있어요");
  });

  it("이유 줄과 다음 행동 줄은 title과 낭독(aria-describedby)에 「이유. 다음 행동.」으로 합쳐 실린다", async () => {
    await mount({ quote: { targetId: "m1", targetSeq: 1, authorMemberId: ME, block: { kind: "ready", targetId: "m1", targetSeq: 1, authorMemberId: ME, lines: ["원본"], truncated: false, quotesAnother: false, edited: false } } });
    await type("인용에 답해요");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    expect(triggerEl().getAttribute("title")).toBe("인용 답장은 예약할 수 없어요. 인용을 지우면 예약할 수 있어요.");
    const reasonId = triggerEl().getAttribute("aria-describedby") ?? "";
    expect(document.getElementById(reasonId)?.textContent).toBe("인용 답장은 예약할 수 없어요. 인용을 지우면 예약할 수 있어요.");
    // 눈에 보이는 줄은 한 줄 슬롯이므로 이유 줄만 말한다.
    await pressBlockedTrigger();
    expect(textOf("composer-status-line")).toBe("인용 답장은 예약할 수 없어요");
  });

  it("명령(/) 작성 중: 명령은 예약할 수 없어요", async () => {
    await mount();
    await type("/");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    await pressBlockedTrigger();
    expect(textOf("composer-status-line")).toBe("명령은 예약할 수 없어요");
  });

  it("내 개인 에이전트를 부르는 글: 개인 에이전트 호출은 예약할 수 없어요", async () => {
    await mount({ personal: true });
    await type("@my-claude 빌드를 봐 줘");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    await pressBlockedTrigger();
    expect(textOf("composer-status-line")).toBe("개인 에이전트 호출은 예약할 수 없어요");
    // 호출을 빼면 풀린다.
    await type("빌드를 봐 줘");
    expect(triggerEl().getAttribute("aria-disabled")).toBeNull();
  });

  it("첨부가 올라가는 중: 파일이 올라가는 중이에요", async () => {
    await mount();
    await attachUploading("a.log", "att-slow");
    await type("글");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    await pressBlockedTrigger();
    expect(textOf("composer-status-line")).toBe("파일이 올라가는 중이에요");
  });

  it("올리지 못한 첨부가 있다: 올리지 못한 파일이 있어요", async () => {
    await mount();
    api.createAttachmentUpload.mockRejectedValueOnce(new ApiError(500, "boom"));
    await act(async () => {
      addFiles(TRAY, TARGET, [file("broken.log")]);
    });
    await settle(5);
    await type("글");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    await pressBlockedTrigger();
    expect(textOf("composer-status-line")).toBe("올리지 못한 파일이 있어요");
  });

  it("첨부만 있고 글이 없어도 예약할 수 있다(보낼 내용 있음)", async () => {
    await mount();
    await attach("a.log", "att-1");
    expect(triggerEl().getAttribute("aria-disabled")).toBeNull();
  });

  it("오프라인: ▾는 흐리고 이유는 앱의 오프라인 줄이 말한다(예약용 문장을 따로 만들지 않는다)", async () => {
    await mount();
    await type("글");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    expect(byId("composer-offline")).not.toBeNull();
    expect(triggerEl().getAttribute("title")).toBe(need("composer-offline").textContent);
    // 오프라인 사유에는 낭독용 이유 줄이 따로 없다.
    await pressBlockedTrigger();
    expect(byId("composer-status-line")).toBeNull();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(triggerEl().getAttribute("aria-disabled")).toBeNull();
  });

  it("서버가 예약을 껐다(쓰기 503 scheduler_disabled): ▾는 서되 흐리고 이유를 말한다", async () => {
    scheduledApi.createScheduledMessage.mockRejectedValueOnce(new ApiError(503, "off", "scheduler_disabled"));
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    // 실패한 프리셋은 직접 고르기가 열려 이유와 다음 행동을 말하고, 「예약하기」는 흐리다(명세 0.5 ③: 눌러도 같은 거절만 돌아오는
    // 단추는 만들지 않는다. design-review #4215 2회차 M1).
    expect(byId("schedule-dialog")).not.toBeNull();
    expect(textOf("schedule-dialog-error")).toContain("이 서버에서는 예약을 쓸 수 없어요");
    expect(textOf("schedule-dialog-error")).toContain("관리자에게 물어보세요");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
    await click("schedule-dialog-commit");
    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(1);
    await click("schedule-dialog-cancel");
    expect(triggerEl().getAttribute("aria-disabled")).toBe("true");
    await pressBlockedTrigger();
    expect(textOf("composer-status-line")).toBe("이 서버에서는 예약을 쓸 수 없어요");
  });

  it("우선순위: 오프라인이 명령보다, 명령이 인용·빈 입력보다 먼저 말한다", async () => {
    await mount();
    await type("/");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(triggerEl().getAttribute("title")).toBe(need("composer-offline").textContent);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect(triggerEl().getAttribute("title")).toBe("명령은 예약할 수 없어요. 명령을 지우면 예약할 수 있어요.");
  });
});

describe("대기 50개: 메뉴는 열리고 항목이 흐리다 (명세 0.4)", () => {
  const fifty = Array.from({ length: 50 }, (_, i) =>
    scheduledRow({ id: `00000000-0000-7000-8000-0000000005${String(i).padStart(2, "0")}`, sendAtMs: TOMORROW_9 + i * 60_000 })
  );

  it("한도 문장이 메뉴 맨 위에 서고 항목은 aria-disabled이며 고르면 아무것도 보내지 않는다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue(fifty);
    await mount();
    await type("글");
    expect(triggerEl().getAttribute("aria-disabled")).toBeNull();
    await openMenu();
    expect(textOf("composer-schedule-limit")).toBe("예약은 50개까지 걸 수 있어요. 대기 중인 예약을 지우거나 지금 보낸 뒤에 다시 해 보세요.");
    const items = [...need("composer-schedule-menu").querySelectorAll<HTMLElement>('[role="menuitem"]')];
    expect(items.length).toBe(3);
    for (const item of items) {
      expect(item.getAttribute("aria-disabled")).toBe("true");
      expect(item.hasAttribute("data-disabled")).toBe(false);
      expect(item.getAttribute("aria-describedby")).toBe(need("composer-schedule-limit").id);
    }
    await choose("composer-schedule-preset-tomorrow");
    await choose("composer-schedule-custom");
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
    expect(byId("schedule-dialog")).toBeNull();
    // 메뉴는 열린 채로 남는다: 문장을 계속 읽을 수 있다.
    expect(byId("composer-schedule-menu")).not.toBeNull();
  });

  it("흐린 항목에 키보드가 닿는다: Radix가 건너뛰지 않으므로 한도 문장을 낭독으로 듣는다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue(fifty);
    await mount();
    await type("글");
    await openMenu();
    const first = need("composer-schedule-preset-tomorrow");
    expect(document.activeElement).toBe(first);
    await keydown(first, "ArrowDown");
    await settle(1);
    expect(document.activeElement).toBe(need("composer-schedule-preset-next-monday"));
    await keydown(need("composer-schedule-preset-next-monday"), "ArrowDown");
    await settle(1);
    expect(document.activeElement).toBe(need("composer-schedule-custom"));
  });

  it("49개면 아직 걸 수 있다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue(fifty.slice(0, 49));
    await mount();
    await type("글");
    await openMenu();
    expect(byId("composer-schedule-limit")).toBeNull();
    expect(need("composer-schedule-preset-tomorrow").getAttribute("aria-disabled")).toBeNull();
  });
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("예약 흐름 (UI 명세 0.5, ADR-0208 D16)", () => {
  it("프리셋: 서버가 201을 준 뒤에 비우고, 응답의 시각으로 3초 줄을 말하고, 초점은 입력창으로 돌아온다", async () => {
    scheduledApi.createScheduledMessage.mockResolvedValue(scheduledRow());
    await mount();
    await type("내일 회의 전에 자료 올려 둘게요");
    await openMenu();
    expect(textOf("composer-schedule-preset-tomorrow")).toContain("내일 오전 9:00");
    expect(textOf("composer-schedule-preset-next-monday")).toContain("다음 주 월요일 오전 9:00");
    expect(textOf("composer-schedule-zone")).toBe("Asia/Seoul (UTC+9) 기준이에요");
    // 메뉴가 열리면 초점은 첫 항목이다.
    expect(document.activeElement).toBe(need("composer-schedule-preset-tomorrow"));
    await choose("composer-schedule-preset-tomorrow");

    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(1);
    const [workspaceId, input] = scheduledApi.createScheduledMessage.mock.calls[0]!;
    expect(workspaceId).toBe(WS);
    expect(input).toMatchObject({ channelId: CH, body: "내일 회의 전에 자료 올려 둘게요", sendAtMs: TOMORROW_9, attachmentIds: [] });
    expect(input.clientRequestId).toMatch(UUID);
    expect(input).not.toHaveProperty("rootId");
    // 일반 메시지로는 아무것도 나가지 않았다.
    expect(sends).toEqual([]);
    expect(inputEl().value).toBe("");
    expect(readDraft(WS, CH)).toBe("");
    expect(textOf("composer-status-line")).toBe("내일 오전 9:00에 보낼게요");
    expect(textOf("composer-status")).toBe("내일 오전 9:00에 보낼게요");
    expect(document.activeElement).toBe(inputEl());
    expect(textOf("composer-scheduled-banner")).toContain("이 채널에 예약된 메시지 1개");
  });

  it("상태줄은 요청한 시각이 아니라 응답의 sendAtMs로 그린다", async () => {
    scheduledApi.createScheduledMessage.mockResolvedValue(scheduledRow({ sendAtMs: NEXT_MONDAY_9 }));
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(textOf("composer-status-line")).toBe("10월 26일 (월) 오전 9:00에 보낼게요");
  });

  it("서버가 응답하기 전에는 글도 초안도 비우지 않는다", async () => {
    const inflight = manualCreate();
    await mount();
    await type("답을 기다리는 글");
    writeDraft(WS, CH, "답을 기다리는 글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(inputEl().value).toBe("답을 기다리는 글");
    expect(readDraft(WS, CH)).toBe("답을 기다리는 글");
    await act(async () => {
      inflight.resolve(scheduledRow());
    });
    await settle();
    expect(inputEl().value).toBe("");
    expect(readDraft(WS, CH)).toBe("");
  });

  it("요청이 나는 동안 잠긴다: 두 번째 예약도, Enter 전송도, 보내기 단추도 나가지 않는다. 눈에는 「예약 중」이 보인다", async () => {
    const inflight = manualCreate();
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(need("composer-send").getAttribute("aria-busy")).toBe("true");
    expect(triggerEl().getAttribute("aria-busy")).toBe("true");
    // `aria-busy`는 낭독이 알리지 않고 눈에는 신호가 없다: 3초 줄 자리와 낭독 노드가 「예약 중」을 말한다(design-review #4215 2회차 M4).
    expect(textOf("composer-status-line")).toBe("예약 중");
    expect(textOf("composer-status")).toBe("예약 중");

    await keydown(inputEl(), "Enter");
    expect(sends).toEqual([]);
    await act(async () => {
      need("composer-send").click();
    });
    expect(sends).toEqual([]);
    await act(async () => {
      triggerEl().dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
    });
    await settle(1);
    expect(byId("composer-schedule-menu")).toBeNull();
    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(1);

    await act(async () => {
      inflight.resolve(scheduledRow());
    });
    await settle();
    expect(need("composer-send").getAttribute("aria-busy")).toBeNull();
    expect(triggerEl().getAttribute("aria-busy")).toBeNull();
    // 성공하면 같은 자리가 확인으로 바뀐다.
    expect(textOf("composer-status-line")).toBe("내일 오전 9:00에 보낼게요");
  });

  it("요청 중에 글을 고쳤으면 글은 남기고 상태줄만 보인다(스냅샷이 같을 때만 비운다)", async () => {
    const inflight = manualCreate();
    await mount();
    await type("처음 글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    await type("처음 글에 덧붙인 글");
    await act(async () => {
      inflight.resolve(scheduledRow());
    });
    await settle();
    expect(inputEl().value).toBe("처음 글에 덧붙인 글");
    expect(textOf("composer-status-line")).toBe("내일 오전 9:00에 보낼게요");
  });

  it("스냅샷의 첨부는 글이 바뀌었어도 항상 트레이에서 빼고, 요청 중에 새로 붙인 첨부는 남긴다", async () => {
    const inflight = manualCreate();
    await mount();
    await attach("a.log", "att-1");
    await type("첨부와 함께");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(createdWith(0)).toMatchObject({ attachmentIds: ["att-1"] });
    // 요청 중에 글을 고치고 파일을 하나 더 붙인다.
    await type("첨부와 함께 고친 글");
    await attach("b.log", "att-2");
    await act(async () => {
      inflight.resolve(scheduledRow({ attachments: [{ id: "att-1", name: "a.log", mime: "text/plain", sizeBytes: 8 }] }));
    });
    await settle();
    expect(readSurface(TRAY).drafts.map((draft) => draft.attachmentId)).toEqual(["att-2"]);
    expect(inputEl().value).toBe("첨부와 함께 고친 글");
  });

  it("첨부만 있는 예약: 글이 비어도 걸리고 비운 뒤 트레이도 빈다", async () => {
    scheduledApi.createScheduledMessage.mockResolvedValue(scheduledRow({ body: undefined }));
    await mount();
    await attach("a.log", "att-1");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(createdWith(0)).toMatchObject({ body: "", attachmentIds: ["att-1"] });
    expect(readSurface(TRAY).drafts).toHaveLength(0);
  });

  it("실패하면 글·첨부·초안이 그대로 남고, 고른 시각이 채워진 직접 고르기가 오류 줄과 함께 열린다", async () => {
    scheduledApi.createScheduledMessage.mockRejectedValueOnce(new ApiError(400, "too soon", "send_at_too_soon"));
    await mount();
    await attach("a.log", "att-1");
    await type("남아야 하는 글");
    writeDraft(WS, CH, "남아야 하는 글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");

    expect(byId("schedule-dialog")).not.toBeNull();
    expect((need("schedule-dialog-date") as HTMLInputElement).value).toBe("2026-10-23");
    expect((need("schedule-dialog-time") as HTMLInputElement).value).toBe("09:00");
    expect(textOf("schedule-dialog-error")).toBe("1분 뒤부터 예약할 수 있어요");
    expect(need("schedule-dialog-error").getAttribute("role")).toBe("alert");
    expect(inputEl().value).toBe("남아야 하는 글");
    expect(readDraft(WS, CH)).toBe("남아야 하는 글");
    expect(readSurface(TRAY).drafts).toHaveLength(1);
    expect(textOf("schedule-dialog-place")).toBe("#일반");
    expect(textOf("schedule-dialog-preview")).toBe("남아야 하는 글");
  });

  it("연결이 끊겨 결과를 모를 때: 같은 내용으로 다시 누르면 같은 clientRequestId, 글을 고치면 새 id", async () => {
    scheduledApi.createScheduledMessage
      .mockRejectedValueOnce(new NetworkError("unreachable", 10_000))
      .mockRejectedValueOnce(new NetworkError("timeout", 10_000))
      .mockResolvedValueOnce(scheduledRow());
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(textOf("schedule-dialog-error")).toBe("예약됐는지 확인하지 못했어요. 연결을 확인하고 다시 눌러 주세요.");

    await click("schedule-dialog-commit");
    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(2);
    expect(createdWith(1).clientRequestId).toBe(createdWith(0).clientRequestId);

    await type("글을 고쳤어요");
    await click("schedule-dialog-commit");
    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(3);
    expect(createdWith(2).body).toBe("글을 고쳤어요");
    expect(createdWith(2).clientRequestId).not.toBe(createdWith(0).clientRequestId);
    expect(byId("schedule-dialog")).toBeNull();
  });

  it("시각을 바꿔 다시 걸어도 새 clientRequestId다(서버는 같은 id에 옛 행을 돌려준다)", async () => {
    scheduledApi.createScheduledMessage
      .mockRejectedValueOnce(new NetworkError("unreachable", 10_000))
      .mockResolvedValueOnce(scheduledRow());
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    const date = need("schedule-dialog-date") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(date, "2026-10-24");
      date.dispatchEvent(new Event("input", { bubbles: true }));
      date.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await click("schedule-dialog-commit");
    expect(createdWith(1).sendAtMs).toBe(new Date("2026-10-24T09:00:00+09:00").getTime());
    expect(createdWith(1).clientRequestId).not.toBe(createdWith(0).clientRequestId);
  });

  it("직접 고르기에서 건 예약이 성공하면 대화상자가 닫히고 초점은 입력창으로 간다", async () => {
    scheduledApi.createScheduledMessage.mockResolvedValue(scheduledRow());
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-custom");
    expect(byId("schedule-dialog")).not.toBeNull();
    expect(textOf("schedule-dialog-result")).toBe("내일 오전 9:00에 보내요");
    await click("schedule-dialog-commit");
    await settle(2);
    expect(byId("schedule-dialog")).toBeNull();
    expect(document.activeElement).toBe(inputEl());
    expect(inputEl().value).toBe("");
    expect(textOf("composer-status-line")).toBe("내일 오전 9:00에 보낼게요");
  });

  it("직접 고르기를 Esc로 닫으면 연 단추(▾)로 초점이 돌아가고 아무것도 걸리지 않는다", async () => {
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-custom");
    expect(document.activeElement).toBe(need("schedule-dialog-date"));
    await keydown(need("schedule-dialog-date"), "Escape");
    await settle(2);
    expect(byId("schedule-dialog")).toBeNull();
    expect(document.activeElement).toBe(triggerEl());
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
    expect(inputEl().value).toBe("글");
  });

  it("직접 고르기: 지금보다 1분 안의 시각은 서버를 부르기 전에 오류 줄로 말한다", async () => {
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-custom");
    const date = need("schedule-dialog-date") as HTMLInputElement;
    const time = need("schedule-dialog-time") as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(date, "2026-10-22");
      date.dispatchEvent(new Event("input", { bubbles: true }));
      setter?.call(time, "14:30");
      time.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("schedule-dialog-commit");
    expect(textOf("schedule-dialog-error")).toBe("1분 뒤부터 예약할 수 있어요");
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
  });

  it("대화상자가 열린 동안 연결이 끊기면 오프라인 줄이 서고 예약하기가 흐려진다", async () => {
    await mount();
    await type("글");
    await openMenu();
    await choose("composer-schedule-custom");
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    expect(textOf("schedule-dialog-error")).toBe("연결이 없어서 지금은 할 수 없어요. 연결되면 다시 눌러 주세요.");
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    expect((need("schedule-dialog-commit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("키 모양 글: 고르는 순간 막히고 키 차단 줄이 「예약하지 않았어요」로 선다. 보내기에서는 「보내지 않았어요」", async () => {
    await mount();
    await type(`키예요 ${KEY_LIKE}`);
    // 켜져 있다(막히지 않았다): 고르면 막힌다.
    expect(triggerEl().getAttribute("aria-disabled")).toBeNull();
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();
    expect(textOf("composer-secret-block")).toContain("키는 채팅에 붙여 넣지 마세요. 이 메시지는 예약하지 않았어요.");
    expect(inputEl().value).toContain(KEY_LIKE);

    // 직접 고르기도 막는다.
    await openMenu();
    await choose("composer-schedule-custom");
    expect(byId("schedule-dialog")).toBeNull();
    expect(scheduledApi.createScheduledMessage).not.toHaveBeenCalled();

    // 같은 글을 보내려 하면 문장이 보내기의 것으로 바뀐다.
    await keydown(inputEl(), "Enter");
    expect(textOf("composer-secret-block")).toContain("이 메시지는 보내지 않았어요.");
    expect(textOf("composer-secret-block")).not.toContain("예약하지 않았어요");
    expect(sends).toEqual([]);
  });

  it("키를 지운 글은 예약이 걸리고 키 차단 줄은 글을 고치는 순간 이미 걷혀 있다", async () => {
    scheduledApi.createScheduledMessage.mockResolvedValue(scheduledRow());
    await mount();
    await type(`키예요 ${KEY_LIKE}`);
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(byId("composer-secret-block")).not.toBeNull();
    await type("키를 지운 글");
    await openMenu();
    await choose("composer-schedule-preset-tomorrow");
    expect(scheduledApi.createScheduledMessage).toHaveBeenCalledTimes(1);
    expect(byId("composer-secret-block")).toBeNull();
  });
});

describe("메뉴의 키보드와 접근성 (UI 명세 1.10)", () => {
  it("Enter·Space·↓로 열고 초점은 첫 항목이며, Esc로 닫으면 ▾로 돌아간다", async () => {
    await mount();
    await type("글");
    triggerEl().focus();
    for (const key of ["Enter", " ", "ArrowDown"]) {
      await keydown(triggerEl(), key);
      await settle(1);
      expect(byId("composer-schedule-menu"), key).not.toBeNull();
      expect(document.activeElement, key).toBe(need("composer-schedule-preset-tomorrow"));
      expect(triggerEl().getAttribute("aria-expanded")).toBe("true");
      await keydown(need("composer-schedule-preset-tomorrow"), "Escape");
      await settle(2);
      expect(byId("composer-schedule-menu"), key).toBeNull();
      expect(document.activeElement, key).toBe(triggerEl());
    }
  });

  it("항목의 낭독 이름은 요일까지 푼 시각이다", async () => {
    await mount();
    await type("글");
    await openMenu();
    expect(need("composer-schedule-preset-tomorrow").getAttribute("aria-label")).toBe("내일 오전 9:00, 10월 23일 금요일");
    expect(need("composer-schedule-preset-next-monday").getAttribute("aria-label")).toBe("10월 26일 월요일 오전 9:00");
  });

  it("일요일에는 「다음 주 월요일」이 없다(내일과 같은 시각이라 숨긴다)", async () => {
    vi.setSystemTime(new Date("2026-10-25T22:00:00+09:00").getTime());
    await mount();
    await type("글");
    await openMenu();
    expect(byId("composer-schedule-preset-next-monday")).toBeNull();
    expect(byId("composer-schedule-preset-tomorrow")).not.toBeNull();
  });
});

describe("배너 (UI 명세 1.6)", () => {
  it("대기만 있으면 neutral status 한 줄, 실패가 있으면 위험 alert 한 줄만 선다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([
      scheduledRow(),
      scheduledRow({ id: "00000000-0000-7000-8000-0000000004a2", sendAtMs: NEXT_MONDAY_9 }),
    ]);
    await mount();
    expect(textOf("composer-scheduled-banner")).toContain("이 채널에 예약된 메시지 2개");
    expect(need("composer-scheduled-banner").getAttribute("role")).toBe("status");
  });

  it("실패가 하나라도 있으면 「예약한 메시지 N개를 보내지 못했어요」 한 줄이 대기 줄 대신 선다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([
      scheduledRow(),
      scheduledRow({ id: "00000000-0000-7000-8000-0000000004a2", status: "failed", failureReason: "missed", sendAtMs: NOW - 3_600_000 }),
    ]);
    await mount();
    expect(textOf("composer-scheduled-banner")).toContain("예약한 메시지 1개를 보내지 못했어요");
    expect(need("composer-scheduled-banner").getAttribute("role")).toBe("alert");
    expect(textOf("composer-scheduled-banner")).not.toContain("예약된 메시지");
  });

  it("다른 채널의 예약은 세지 않고, 0개면 배너가 없다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([
      scheduledRow({ channelId: "00000000-0000-7000-8000-000000000299" }),
    ]);
    await mount();
    expect(byId("composer-scheduled-banner")).toBeNull();
  });

  it("「보기」는 그 채널로 거른 목록 주소를 연다", async () => {
    scheduledApi.listAllScheduledMessages.mockResolvedValue([scheduledRow()]);
    await mount();
    const button = need("composer-scheduled-banner").querySelector("button");
    expect(button?.textContent).toBe("보기");
    await act(async () => {
      button?.click();
    });
    expect(here).toBe(`/scheduled?channel=${CH}`);
  });
});
