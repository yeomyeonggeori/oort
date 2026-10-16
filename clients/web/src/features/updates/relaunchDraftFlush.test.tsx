// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { ThreadComposer } from "@/features/timeline/ThreadComposer";
import {
  clearAllDrafts,
  readDraft,
  readThreadDraft,
  writeThreadDraft,
} from "@/features/chat/draftStore";
import { flushBeforeRelaunch } from "./relaunchFlush";

// =============================================================================
// 자동 다시 실행 전에 쓰던 글이 디스크에 있다 (성재 결재 2026-10-16, #3904).
// 채널 컴포저는 입력마다 저장하고, 스레드 컴포저는 메모리에만 있었다.
// 여기서는 실제 컴포넌트에 글을 치고 신호만 보내서 저장소를 읽는다.
// =============================================================================

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  if (root) act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

function session(): SessionContextValue {
  return {
    session: {
      accessToken: "a",
      refreshToken: "r",
      member: { id: "viewer", workspaceId: "w", kind: "human", displayName: "하늘", handle: "hanul" },
    },
    workspaceId: "w",
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

function open(): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root?.render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(
          SessionProvider,
          { value: session() },
          createElement(ThreadComposer, {
            workspaceId: "w",
            channelId: "c",
            rootId: "r",
            directory: makeDirectory([]),
            channels: [],
            onSent: vi.fn(),
          })
        )
      )
    );
  });
  return host;
}

function type(el: HTMLElement, value: string) {
  const area = el.querySelector("textarea") as HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  act(() => {
    setter?.call(area, value);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("스레드 답글 초안", () => {
  it("입력만 해서는 저장소에 없고, 다시 실행 신호 뒤에는 있다", () => {
    const el = open();
    type(el, "롤백 계획을 정리하는 중이에요");
    expect(readThreadDraft("w", "r")).toBe("");
    flushBeforeRelaunch();
    expect(readThreadDraft("w", "r")).toBe("롤백 계획을 정리하는 중이에요");
  });

  it("다시 열면 비어 있는 입력창에 복원된다", () => {
    writeThreadDraft("w", "r", "이어서 쓸 글");
    const el = open();
    expect((el.querySelector("textarea") as HTMLTextAreaElement).value).toBe("이어서 쓸 글");
  });

  it("키 모양이 든 글은 디스크에 내리지 않는다", () => {
    const el = open();
    type(el, "sk-ant-" + "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v");
    flushBeforeRelaunch();
    expect(readThreadDraft("w", "r")).toBe("");
  });

  it("로그아웃 청소가 스레드 초안도 지우고, 채널 초안 목록에는 섞이지 않는다", () => {
    writeThreadDraft("w", "r", "초안");
    expect(readDraft("w", "r")).toBe("");
    clearAllDrafts();
    expect(readThreadDraft("w", "r")).toBe("");
  });
});
