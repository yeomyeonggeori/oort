// @vitest-environment jsdom
// #5191: 입력칸의 ↑ 가 보낸 「이 메시지를 고쳐 줘」 요청을 행이 받는 길. 행은 편집 상태를 자기가 쥐므로(편집기는 그 행 안에서 열린다)
// 요청이 **이 행을 가리킬 때만** 열고, 그 사이 고칠 수 없게 된 행(지워졌거나 남의 글)은 열지 않은 채 요청만 비운다. 첨부가 든
// 글도 같은 행이라 열리고, 편집기는 지금 글로 선다. 열린 편집기가 끝나면(저장·취소) 요청한 쪽에 알린다.

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { EditRequestContext, type EditRequestChannel } from "./editRequest";
import { MessageRow } from "./MessageRow";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const MINE_ID = "0199eeee-0000-7000-8000-000000000601";
const OTHER_ID = "0199eeee-0000-7000-8000-000000000602";

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));
vi.mock("@/features/attachments/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/attachments/content")>();
  return {
    ...actual,
    useAttachmentPreview: () => ({ status: "ready", dataUrl: "data:image/png;base64,AAAA", retry: () => {} }),
  };
});

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
  HTMLElement.prototype.scrollIntoView = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {
        return undefined;
      }
      unobserve() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    };
  }
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
});

afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
});

function member(id: string, displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: "human",
    status: "active",
    displayName,
    handle,
    role: "member",
    channelCount: 1,
    channelIds: [CH],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WS, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WS,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: MINE_ID,
    channelId: CH,
    seq: 7,
    hlcTs: 7,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: "회의 시간은 3시예요",
    state: "sent",
    createdAtMs: 7000,
    ...over,
  };
}

interface Channel {
  channel: EditRequestChannel;
  consume: ReturnType<typeof vi.fn>;
  finished: ReturnType<typeof vi.fn>;
}

function requestChannel(messageId: string | null, nonce = 1): Channel {
  const consume = vi.fn();
  const finished = vi.fn();
  return {
    channel: { request: messageId === null ? null : { messageId, nonce }, consume, finished },
    consume,
    finished,
  };
}

const onEditMessage = vi.fn(async () => undefined);
const actions = {
  myMemberId: ME,
  chips: [],
  pinned: false,
  onToggleReaction: async () => undefined,
  onTogglePin: async () => undefined,
  onEditMessage,
  onDeleteMessage: async () => undefined,
};

function mountRow(msg: Message, channel: EditRequestChannel | null): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const row: ReactElement = createElement(MessageRow, {
    message: msg,
    startsGroup: true,
    directory: makeDirectory([member(OTHER, "이도현", "dohyeon"), member(ME, "박서연", "seoyeon")]),
    actions,
  });
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        null,
        createElement(
          SessionProvider,
          { value: sessionValue() },
          createElement(
            OpenMemberProfileContext.Provider,
            { value: () => undefined },
            createElement(
              QueryClientProvider,
              { client },
              createElement(EditRequestContext.Provider, { value: channel }, row)
            )
          )
        )
      )
    );
  });
  return host;
}

const editor = (root: HTMLElement) => root.querySelector('[data-testid="message-editor-input"]') as HTMLTextAreaElement | null;

describe("행이 받는 편집 요청", () => {
  it("이 행을 가리키는 요청이면 그 행 안에서 편집기를 열고, 지금 글로 선다", () => {
    const c = requestChannel(MINE_ID, 4);
    const root = mountRow(message(), c.channel);
    expect(editor(root)).not.toBeNull();
    expect(editor(root)?.value).toBe("회의 시간은 3시예요");
    expect(c.consume).toHaveBeenCalledWith(4);
  });

  it("id 대소문자가 달라도 같은 행이다(서버는 대문자 UUID 를 보내기도 한다)", () => {
    const c = requestChannel(MINE_ID.toUpperCase());
    const root = mountRow(message(), c.channel);
    expect(editor(root)).not.toBeNull();
  });

  it("첨부가 든 글도 같은 행이라 열리고, 첨부는 그대로 그려진다", () => {
    const c = requestChannel(MINE_ID);
    const root = mountRow(
      message({ attachments: [{ id: "0199eeee-0000-7000-8000-0000000006f1", name: "현장.png", mime: "image/png", sizeBytes: 4096 }] }),
      c.channel
    );
    expect(editor(root)?.value).toBe("회의 시간은 3시예요");
    expect(root.querySelector('[data-testid="attachment-list"]')).not.toBeNull();
  });

  it("다른 메시지를 가리키는 요청이면 열지 않고 비우지도 않는다(그 행이 받을 몫이다)", () => {
    const c = requestChannel(OTHER_ID);
    const root = mountRow(message(), c.channel);
    expect(editor(root)).toBeNull();
    expect(c.consume).not.toHaveBeenCalled();
  });

  it("요청이 없으면 아무 일도 없다", () => {
    const c = requestChannel(null);
    const root = mountRow(message(), c.channel);
    expect(editor(root)).toBeNull();
    expect(c.consume).not.toHaveBeenCalled();
  });

  it("채널(Provider)이 없는 표면(스레드 패널·작업 패널)에서도 행은 그대로 그려진다", () => {
    const root = mountRow(message(), null);
    expect(editor(root)).toBeNull();
    expect(root.textContent).toContain("회의 시간은 3시예요");
  });

  it("그 사이 지워진 행은 열지 않은 채 요청만 비운다(편집기가 열릴 자격은 메뉴의 「고치기」와 같다)", () => {
    const c = requestChannel(MINE_ID, 9);
    const root = mountRow(message({ state: "deleted", body: undefined }), c.channel);
    expect(editor(root)).toBeNull();
    expect(c.consume).toHaveBeenCalledWith(9);
  });

  it("남의 글을 가리키는 요청도 열지 않는다(고치기는 작성자만이다)", () => {
    const c = requestChannel(OTHER_ID, 3);
    const root = mountRow(message({ id: OTHER_ID, authorMemberId: OTHER }), c.channel);
    expect(editor(root)).toBeNull();
    expect(c.consume).toHaveBeenCalledWith(3);
  });

  it("요청으로 연 편집기를 Esc 로 닫으면 요청한 쪽에 알린다(입력칸이 초점을 돌려받는다)", () => {
    const c = requestChannel(MINE_ID, 6);
    const root = mountRow(message(), c.channel);
    const input = editor(root) as HTMLTextAreaElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(editor(root)).toBeNull();
    expect(c.finished).toHaveBeenCalledTimes(1);
    expect(c.finished).toHaveBeenCalledWith(6);
  });

  it("요청으로 연 편집기를 저장하면 저장 뒤 요청한 쪽에 알린다", async () => {
    onEditMessage.mockClear();
    const c = requestChannel(MINE_ID, 8);
    const root = mountRow(message(), c.channel);
    const input = editor(root) as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input, "회의 시간은 4시로 바꿨어요");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(onEditMessage).toHaveBeenCalledTimes(1);
    expect(onEditMessage.mock.calls[0]).toEqual([expect.objectContaining({ id: MINE_ID }), "회의 시간은 4시로 바꿨어요"]);
    expect(editor(root)).toBeNull();
    expect(c.finished).toHaveBeenCalledWith(8);
  });

  it("같은 요청은 한 번만 연다: 닫은 뒤 같은 nonce 가 남아 있어도 다시 열리지 않는다", () => {
    const c = requestChannel(MINE_ID, 5);
    const root = mountRow(message(), c.channel);
    const input = editor(root) as HTMLTextAreaElement;
    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(editor(root)).toBeNull();
    // 부모가 같은 요청을 든 채 다시 그려도(consume 이 mock 이라 비워지지 않는다) 편집기는 다시 열리지 않는다.
    act(() => {
      mountedRoot?.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            SessionProvider,
            { value: sessionValue() },
            createElement(
              OpenMemberProfileContext.Provider,
              { value: () => undefined },
              createElement(
                QueryClientProvider,
                { client: new QueryClient() },
                createElement(
                  EditRequestContext.Provider,
                  { value: { ...c.channel } },
                  createElement(MessageRow, {
                    message: message(),
                    startsGroup: true,
                    directory: makeDirectory([member(ME, "박서연", "seoyeon")]),
                    actions,
                  })
                )
              )
            )
          )
        )
      );
    });
    expect(editor(root)).toBeNull();
  });
});
