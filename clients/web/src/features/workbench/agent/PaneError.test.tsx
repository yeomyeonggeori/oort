// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { PaneError } from "./agentPaneSource";

// =============================================================================
// #5279 B: 격자의 에이전트 칸이 세션 스레드를 처음부터 못 읽었을 때. 옛 「진행을 읽지 못했어요. 연결을 확인한 뒤 다시 읽으세요.」 / 「다시 읽기」는 이유를
// 짐작하게 했다. 이제 칸이 통째로 비었으므로 상자(제목 + 원인 이유 + 다시 시도)가 원인(오프라인 / 서버에 닿지 못함 / 그 밖)을 말한다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let root: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;
let onLine: MockInstance<() => boolean>;

beforeAll(async () => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  ko = await koreanLocale();
});
beforeEach(() => {
  onLine = vi.spyOn(globalThis.navigator, "onLine", "get");
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  onLine.mockRestore();
});

function mount(failure: unknown, onRetry: () => void): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(LocaleProvider, { locale: ko, children: createElement(PaneError, { failure, onRetry }) }));
  });
  return host;
}

describe("에이전트 칸의 스레드 읽기 실패 (#5279 B)", () => {
  const causes: [string, () => unknown, boolean, string][] = [
    ["오프라인", () => new NetworkError("unreachable", 15_000), false, "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
    ["서버에 닿지 못함", () => new NetworkError("unreachable", 15_000), true, "서버에 닿지 못했어요."],
    ["그 밖", () => new ApiError(500, "boom", "internal"), true, "문제가 생겼어요."],
  ];

  it("원인마다 다른 이유를 상자로 말하고, 다시 시도가 스레드를 다시 읽는다. 상태 코드는 없다", () => {
    for (const [name, failure, online, reason] of causes) {
      onLine.mockReturnValue(online);
      const onRetry = vi.fn();
      const el = mount(failure(), onRetry);
      const box = el.querySelector<HTMLElement>('[data-testid="agent-pane-error"]');
      expect(box?.getAttribute("role"), name).toBe("alert");
      expect(box?.textContent, name).toContain("진행을 불러오지 못했어요");
      expect(el.querySelector('[data-testid="load-failure-reason"]')?.textContent, name).toBe(reason);
      expect(box?.textContent, name).not.toMatch(/\d{3}/);
      const retry = box?.querySelector("button");
      expect(retry?.textContent, name).toBe("다시 시도");
      act(() => retry?.click());
      expect(onRetry, name).toHaveBeenCalledTimes(1);
      act(() => root?.unmount());
      host?.remove();
    }
  });
});
