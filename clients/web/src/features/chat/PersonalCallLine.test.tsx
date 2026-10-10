// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkSpawnBody } from "@momo/core/lib/api";
import { CALL_MAC_OFF_LINE } from "@momo/core/features/auth/personalAgentCall";
import { PersonalCallNotice, CALL_SENT_LINE } from "./PersonalCallLine";
import type { CallNotice } from "./usePersonalCall";

let root: Root | null = null;
let host: HTMLElement | null = null;
beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

function show(notice: CallNotice, onRetry = vi.fn()) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(PersonalCallNotice, { notice, onRetry, onDismiss: () => undefined })));
  return { host, onRetry };
}

const signed = { tool: "claude" } as unknown as WorkSpawnBody;

describe("the line after a call", () => {
  it("success says it went and offers no retry", () => {
    const { host } = show({ channelId: "c", retrying: false, call: { state: "called", replayed: false, controlId: "x" } });
    expect(host.querySelector("[data-testid='composer-call-text']")?.textContent).toBe(CALL_SENT_LINE);
    expect(host.querySelector("[data-testid='composer-call-retry']")).toBeNull();
  });

  it("Mac off is labelled 전달 안 됨, says the core sentence, and the retry resends the same signature", () => {
    const { host, onRetry } = show({
      channelId: "c",
      retrying: false,
      call: { state: "not_delivered", stage: "server", text: CALL_MAC_OFF_LINE, error: new ApiError(409, "", "work_host_offline"), signed },
    });
    expect(host.querySelector("[data-testid='composer-call-label']")?.textContent).toBe("전달 안 됨");
    expect(host.querySelector("[data-testid='composer-call-text']")?.textContent).toBe(CALL_MAC_OFF_LINE);
    act(() => host.querySelector<HTMLButtonElement>("[data-testid='composer-call-retry']")?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a refusal that cannot be retried (no stored signature) offers no retry button", () => {
    const { host } = show({
      channelId: "c",
      retrying: false,
      call: { state: "not_delivered", stage: "server", text: "x", error: null, signed: null },
    });
    expect(host.querySelector("[data-testid='composer-call-retry']")).toBeNull();
  });

  it("a browser's message-only outcome shows the sentence with no retry", () => {
    const { host } = show({
      channelId: "c",
      retrying: false,
      call: { state: "message_only", reason: "no_signer", text: "데스크탑·폰에서 불러 주세요" },
    });
    expect(host.querySelector("[data-testid='composer-call-label']")?.textContent).toBe("메시지만 보냈어요");
    expect(host.querySelector("[data-testid='composer-call-text']")?.textContent).toBe("데스크탑·폰에서 불러 주세요");
    expect(host.querySelector("[data-testid='composer-call-retry']")).toBeNull();
  });
});
