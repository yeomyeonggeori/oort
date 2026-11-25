// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError, type WorkSpawnBody } from "@momo/core/lib/api";
import { CALL_MAC_OFF_KEY, CALL_NEEDS_APP_KEY } from "@momo/core/features/auth/personalAgentCall";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocale } from "@/testing/koLocale";
import { PersonalCallNotice, CALL_SENT_LINE } from "./PersonalCallLine";
import type { CallNotice } from "./usePersonalCall";

// 사유의 문장은 사전에 있다(#6064). 한국어 언어 객체 아래에서 예전 한국어를 그대로 단정한다.
const koLocale = await koreanLocale();
const CALL_MAC_OFF_LINE = koLocale.service.formatMessage(CALL_MAC_OFF_KEY);
const CALL_NEEDS_APP_LINE = koLocale.service.formatMessage(CALL_NEEDS_APP_KEY);

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
  act(() =>
    root?.render(
      createElement(LocaleProvider, {
        locale: koLocale,
        children: createElement(PersonalCallNotice, { notice, onRetry, onDismiss: () => undefined }),
      })
    )
  );
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
      call: { state: "not_delivered", stage: "server", message: { key: CALL_MAC_OFF_KEY }, error: new ApiError(409, "", "work_host_offline"), signed },
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
      call: { state: "not_delivered", stage: "server", message: { raw: "x" }, error: null, signed: null },
    });
    expect(host.querySelector("[data-testid='composer-call-retry']")).toBeNull();
  });

  it("a browser's message-only outcome shows the sentence with no retry", () => {
    const { host } = show({
      channelId: "c",
      retrying: false,
      call: { state: "message_only", reason: "no_signer", message: { key: CALL_NEEDS_APP_KEY } },
    });
    expect(host.querySelector("[data-testid='composer-call-label']")?.textContent).toBe("메시지만 보냈어요");
    expect(host.querySelector("[data-testid='composer-call-text']")?.textContent).toBe(CALL_NEEDS_APP_LINE);
    expect(host.querySelector("[data-testid='composer-call-retry']")).toBeNull();
  });
});
