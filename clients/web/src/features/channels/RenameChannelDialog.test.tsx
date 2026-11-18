// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Channel } from "@momo/core/lib/api";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { RenameChannelDialog } from "./RenameChannelDialog";

// 채널 이름 바꾸기 창 (#5835, ADR-0225 D10 · D13). 이름 칸은 만들기 창과 같은 칸 부품이라 조합 · 자리 예약은 그쪽 시험(
// `CreateChannelDialog.nameRule.*`)이 잰다. 여기서는 이 창만의 약속을 본다: 지금 이름이 채워져 선택되고, 친 것과 저장될 이름이 다를 때만
// 미리보기가 서고, 보낼 때 접은 이름이 나가고, 성공하면 캐시의 줄이 새 이름이 되고, 거절은 칸 아래 문장으로 말한다.

const api = vi.hoisted(() => ({ renameChannel: vi.fn() }));
vi.mock("@momo/core/features/channels/rename", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@momo/core/features/channels/rename")>()),
  renameChannel: (...args: unknown[]) => api.renameChannel(...args),
}));

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let korean: AppLocale;
let client: QueryClient;
let closed: boolean[] = [];

const channel: Channel = { id: "c1", workspaceId: "ws", kind: "public", name: "ops-room", muted: false, browseListed: true };

async function mount(): Promise<void> {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(["channels", "ws"], [channel]);
  await act(async () => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(LocaleProvider, {
          locale: korean,
          children: createElement(RenameChannelDialog, {
            workspaceId: "ws",
            channel,
            open: true,
            onOpenChange: (next: boolean) => closed.push(next),
          }),
        })
      )
    );
    await Promise.resolve();
  });
}

const q = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
const input = () => q("rename-channel-name") as HTMLInputElement;
const submitButton = () => q("rename-channel-submit") as HTMLButtonElement;
/** 보이는 문장(보이지 않게 겹쳐 둔 자리 예약 층은 aria-hidden이다). */
const visible = () => q("rename-channel-name-status")!.children[1]!.textContent ?? "";
const type = (value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new InputEvent("input", { bubbles: true }));
  });
const send = () =>
  act(async () => {
    submitButton().click();
    await new Promise((done) => setTimeout(done, 0));
  });

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  api.renameChannel.mockReset();
  closed = [];
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = "";
});

describe("열기", () => {
  it("지금 이름이 채워지고 전체가 선택되어 초점이 칸에 있고, 바꾸기는 잠겨 있다", async () => {
    await mount();
    expect(input().value).toBe("ops-room");
    expect(document.activeElement).toBe(input());
    expect([input().selectionStart, input().selectionEnd]).toEqual([0, "ops-room".length]);
    expect(submitButton().disabled).toBe(true);
  });
});

describe("미리보기 · 보내기", () => {
  it("친 것과 저장될 이름이 다를 때만 「이름으로 바뀌어요」 줄이 서고, 보낼 때는 접은 이름이 나간다(칸은 친 그대로)", async () => {
    await mount();
    await type("Design Review");
    expect(input().value).toBe("Design Review");
    expect(visible()).toBe("#design-review 이름으로 바뀌어요");
    expect(submitButton().disabled).toBe(false);
    api.renameChannel.mockResolvedValue({ ...channel, name: "design-review" });
    await send();
    expect(api.renameChannel).toHaveBeenCalledTimes(1);
    expect(api.renameChannel).toHaveBeenCalledWith("ws", "c1", "design-review");
    // 성공하면 응답의 줄이 캐시에 서고(사이드바 · 머리가 같은 캐시를 읽는다) 창이 닫힌다.
    expect(client.getQueryData<Channel[]>(["channels", "ws"])?.[0]?.name).toBe("design-review");
    expect(closed).toEqual([false]);
  });

  it("이미 접힌 이름을 치면 미리보기 줄이 서지 않고 안내 글이 그대로다", async () => {
    await mount();
    await type("ops-room-2");
    expect(q("rename-channel-name-preview")).toBeNull();
    expect(q("rename-channel-name-hint")).not.toBeNull();
    expect(submitButton().disabled).toBe(false);
  });

  it("접으면 지금 이름과 같아지는 입력과 거절되는 이름은 바꾸기가 잠긴다", async () => {
    await mount();
    await type("OPS ROOM");
    expect(submitButton().disabled).toBe(true);
    await type("a.b");
    expect(q("rename-channel-name-error")).not.toBeNull();
    expect(submitButton().disabled).toBe(true);
    expect(api.renameChannel).not.toHaveBeenCalled();
  });
});

describe("거절은 칸 아래 같은 자리에서 말한다", () => {
  it.each([
    [new ApiError(409, "general channel name is locked", "general_channel_locked"), "general 채널의 이름은 바꿀 수 없어요."],
    [new ApiError(409, "channel name already exists"), "같은 이름의 채널이 이미 있습니다. 다른 이름으로 다시 시도하세요."],
    [new ApiError(404, "channel not found"), "이 채널을 찾을 수 없어요."],
  ])("%o", async (error, sentence) => {
    api.renameChannel.mockRejectedValue(error);
    await mount();
    await type("design-review");
    await send();
    expect(q("rename-channel-name-error")?.textContent).toBe(sentence);
    // 창은 열린 채이고 칸에는 친 이름이 그대로 있다.
    expect(closed).toEqual([]);
    expect(input().value).toBe("design-review");
    // 이름을 고치면 그 거절은 걷힌다.
    await type("design-review-2");
    expect(q("rename-channel-name-error")).toBeNull();
  });
});

describe("보내는 중", () => {
  it("답이 오기 전에는 진행 표시만 서고 취소는 잠기며 둘째 보내기는 버려진다", async () => {
    let answer!: (value: Channel) => void;
    api.renameChannel.mockReturnValue(new Promise<Channel>((resolve) => (answer = resolve)));
    await mount();
    await type("design-review");
    await send();
    await send();
    expect(api.renameChannel).toHaveBeenCalledTimes(1);
    expect(submitButton().getAttribute("aria-busy")).toBe("true");
    expect((q("rename-channel-cancel") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => answer({ ...channel, name: "design-review" }));
    expect(closed).toEqual([false]);
  });
});
