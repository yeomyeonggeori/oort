// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type ReadState } from "@momo/core/lib/api";
import { markAt3Cursor10 } from "@momo/core/features/readState/proof";
import { MARK_UNREAD_ACTION_LABEL } from "@momo/core/features/readState/copy";
import { useMarkUnread } from "./useMarkUnread";

const WS = "00000000-0000-7000-8000-000000000001";
const CH = markAt3Cursor10().channelId;

const advertiseReadState = vi.hoisted(() => vi.fn());

vi.mock("@/features/chat/advertiseReadState", () => ({
  advertiseReadState: (
    workspaceId: string,
    channelId: string,
    lastReadSeq: number,
    reason: string,
    extra?: { markUnreadBeforeSeq?: number }
  ) =>
    advertiseReadState(
      workspaceId,
      channelId,
      lastReadSeq,
      reason,
      extra
    ) as Promise<ReadState>,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  advertiseReadState.mockReset();
});

function Harness({
  client,
  onBanner,
}: {
  client: QueryClient;
  onBanner: (message: string | null) => void;
}) {
  const mark = useMarkUnread(WS);
  const [banner, setBanner] = useState<string | null>(null);
  return createElement(
    QueryClientProvider,
    { client },
    createElement(
      "button",
      {
        type: "button",
        "data-testid": "run-mark",
        onClick: () => {
          void mark
            .run({
              channelId: CH,
              lastReadSeq: 10,
              seq: 3,
            })
            .then(() => {
              setBanner(null);
              onBanner(null);
            })
            .catch((error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              setBanner(message);
              onBanner(message);
            });
        },
      },
      MARK_UNREAD_ACTION_LABEL,
      banner
        ? createElement("div", { "data-testid": "message-action-error" }, banner)
        : null
    )
  );
}

describe("마크 낙관과 400 롤백", () => {
  it("400 이면 로컬 마크가 되돌아가고 행 배너가 선다 (토스트 없음)", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const unmarked: ReadState = { ...markAt3Cursor10(), markedUnreadBeforeSeq: null };
    client.setQueryData(["read-state", WS], [unmarked]);
    advertiseReadState.mockRejectedValue(
      new ApiError(400, "mark_unread_before_seq must name an existing seq")
    );

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    let banner: string | null = null;
    act(() => {
      mountedRoot?.render(
        createElement(Harness, {
          client,
          onBanner: (message) => {
            banner = message;
          },
        })
      );
    });

    await act(async () => {
      host?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cached = client.getQueryData<ReadState[]>(["read-state", WS]);
    expect(cached?.[0]?.markedUnreadBeforeSeq).toBeNull();
    expect(banner).toBeTruthy();
    expect(banner).not.toContain("mark_unread_before_seq");
    expect(host?.querySelector("[data-testid='message-action-error']")).not.toBeNull();
    expect(advertiseReadState).toHaveBeenCalledWith(WS, CH, 10, "mark_unread", {
      markUnreadBeforeSeq: 3,
    });
  });

  it("성공 응답의 marked_unread_before_seq null 은 로컬 마크를 지운다", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    client.setQueryData(["read-state", WS], [markAt3Cursor10()]);
    advertiseReadState.mockResolvedValue({
      ...markAt3Cursor10(),
      markedUnreadBeforeSeq: null,
    });

    host = document.createElement("div");
    document.body.append(host);
    mountedRoot = createRoot(host);
    act(() => {
      mountedRoot?.render(
        createElement(Harness, {
          client,
          onBanner: () => undefined,
        })
      );
    });

    await act(async () => {
      host?.querySelector("button")?.dispatchEvent(
        new MouseEvent("click", { bubbles: true })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const cached = client.getQueryData<ReadState[]>(["read-state", WS]);
    expect(cached?.[0]?.markedUnreadBeforeSeq).toBeNull();
  });
});
