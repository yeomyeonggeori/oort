// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UNFURL_PREVIEW_DEBOUNCE_MS } from "@momo/core/features/timeline/unfurlDraft";

// =============================================================================
// #5037: 훅이 코어 컨트롤러에 입력칸의 수명을 이어 주는가. 규칙(기다림·차례·429·✕…)은 코어
// `composerLinkPreview.test.ts`와 진짜 입력칸을 올린 `composerLinkPreview.test.tsx`가 재고, 여기서는 그 시험들이 닿지
// 않는 한 줄만 잰다: 입력칸이 사라지면(`dispose`) 나가 있는 요청과 아직 끝나지 않은 기다림을 끊는다.
// =============================================================================

const api = vi.hoisted(() => ({ fetchUnfurlPreview: vi.fn() }));
vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return { ...actual, ...api };
});

import { useComposerLinkPreview } from "./useComposerLinkPreview";

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const A = "https://a.example/one";
const B = "https://b.example/two";

const signals: AbortSignal[] = [];
let root: Root | null = null;
let host: HTMLElement | null = null;

function Probe({ text }: { text: string }) {
  useComposerLinkPreview({ workspaceId: "ws-1", channelId: "ch-1", text });
  return null;
}

function mount(text: string) {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(createElement(Probe, { text })));
}
function unmount() {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
}

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  signals.length = 0;
  api.fetchUnfurlPreview.mockReset();
  // 답이 오지 않는 요청: 끊기면 신호만 선다.
  api.fetchUnfurlPreview.mockImplementation(
    (_ws: string, _ch: string, _url: string, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    }
  );
});
afterEach(() => {
  if (root) unmount();
  vi.useRealTimers();
});

describe("useComposerLinkPreview lifetime (#5037)", () => {
  it("cuts the request that is out when the input goes away", async () => {
    mount(A);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS);
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(false);
    unmount();
    expect(signals[0]!.aborted).toBe(true);
  });

  it("asks nothing for a wait that had not ended when the input went away", async () => {
    mount(B);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS - 1);
    });
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UNFURL_PREVIEW_DEBOUNCE_MS * 3);
    });
    expect(signals).toHaveLength(0);
    expect(api.fetchUnfurlPreview).not.toHaveBeenCalled();
  });
});
