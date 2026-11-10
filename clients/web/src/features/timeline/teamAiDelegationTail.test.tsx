// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunSpent, Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { OpenMemberProfileContext } from "@/features/directory/memberProfileContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { MessageRow } from "./MessageRow";

// =============================================================================
// 도우미가 Hermes에 맡겨 끝낸 답의 꼬리 (ADR-0201 증보 v4 P8·P15-A15, #5375).
//
//   1. 서버 소유 칩 칸이 있는 에이전트의 도우미 답: 모델 칩 **옆**(같은 줄)에 「{이름} 도움 · 그림」, 아래 「이 답이 쓴 양」.
//   2. 칩 칸이 없는 답(운영 꺼짐·맡기지 않음·실패)과 사람이 같은 키를 쓴 메시지에는 아무것도 새로 서지 않는다.
//   3. 쓴 양은 run의 `spent` 그대로다(Hermes 횟수·어림 표지). 숫자가 오기 전에도 줄의 자리(보이지 않는 글)는 서 있다.
//   4. 맡겨 받은 그림은 고정 틀에 선다(그림 바이트가 오기 전에도 같은 틀). 높이를 실제로 재는 것은 브라우저 시험이다.
// =============================================================================

vi.mock("@/features/reminders/RemindDialog", () => ({ RemindDialog: () => null }));
vi.mock("@/features/emoji/EmojiPickerDialog", () => ({ EmojiPickerDialog: () => null }));
vi.mock("@/features/attachments/content", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/attachments/content")>();
  return { ...actual, useAttachmentPreview: () => ({ status: "loading", retry: () => {} }) };
});

const WS = "00000000-0000-7000-8000-000000000001";
const CH = "00000000-0000-7000-8000-000000000002";
const ME = "00000000-0000-7000-8000-0000000001ff";
const HELPER = "00000000-0000-7000-8000-0000000002aa";
const HERMES = "00000000-0000-7000-8000-0000000003bb";
const RUN = "0199eeee-0000-7000-8000-00000000a001";
const MSG = "0199eeee-0000-7000-8000-000000000601";

let korean: AppLocale;
beforeAll(async () => {
  korean = await koreanLocaleForTest();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }));
  if (typeof globalThis.ResizeObserver === "undefined") {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

function member(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
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

const DIRECTORY = makeDirectory([
  member(ME, "human", "박서연", "seoyeon"),
  member(HELPER, "agent", "오르트 도우미", "oort"),
  member(HERMES, "agent", "팀 Hermes", "hermes"),
]);

function answer(props: Record<string, unknown>, extra: Partial<Message> = {}): Message {
  return {
    id: MSG,
    channelId: CH,
    seq: 12,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: HELPER,
    type: "text",
    body: "고양이 그림을 그렸어요. 창가에 앉은 모습이에요.",
    state: "sent",
    createdAtMs: Date.UTC(2026, 10, 10, 5, 20),
    props,
    ...extra,
  };
}

const DELEGATED = {
  source: "team_ai",
  run_id: RUN,
  team_ai_model: { model: "claude-sonnet-4-5", wire: "messages" },
  team_ai_delegated: [{ kind: "image", agent_member_id: HERMES }],
};

const PICTURE = { id: "0199cccc-0000-7000-8000-0000000000a1", name: "picture.png", mime: "image/png", sizeBytes: 812_000 };

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  if (root) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function renderRow(message: Message, spent?: AgentRunSpent | null): HTMLElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 쓴 양은 진행 읽기에 없을 때 run 상세를 읽는다(같은 키): 시험은 그 캐시를 미리 채워 요청 없이 그린다.
  if (spent !== undefined) client.setQueryData(["agent-run-spent", WS, RUN], spent);
  const session = {
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
  } as SessionContextValue;
  const node: ReactElement = createElement(LocaleProvider, {
    locale: korean,
    children: createElement(
      SessionProvider,
      { value: session },
      createElement(
        OpenMemberProfileContext.Provider,
        { value: () => undefined },
        createElement(
          QueryClientProvider,
          { client },
          createElement(MessageRow, { message, directory: DIRECTORY, startsGroup: true })
        )
      )
    ),
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root?.render(node));
  return host;
}

const SPENT: AgentRunSpent = { promptTokens: 9_000, completionTokens: 3_345, webSearches: 0, estimated: false, delegations: 1 };

describe("Hermes 도움 칩 (P8·A15)", () => {
  it("서버 소유 칸이 있는 도우미 답: 모델 칩과 같은 줄에 「팀 Hermes 도움 · 그림」", () => {
    const view = renderRow(answer(DELEGATED), SPENT);
    const chip = view.querySelector<HTMLElement>('[data-testid="team-ai-delegation-chip"]');
    expect(chip?.textContent).toBe("팀 Hermes 도움 · 그림");
    expect(chip?.dataset.kind).toBe("image");
    const model = view.querySelector<HTMLElement>('[data-testid="team-ai-model-chip"]');
    expect(model).not.toBeNull();
    // 같은 줄(같은 부모)이다: 모델 칩 바로 다음 형제.
    expect(model?.parentElement).toBe(chip?.parentElement);
    expect(model?.nextElementSibling).toBe(chip);
  });

  it("검색을 맡긴 답은 「… 도움 · 검색」", () => {
    const view = renderRow(
      answer({ ...DELEGATED, team_ai_delegated: [{ kind: "web_search", agent_member_id: HERMES }] }),
      SPENT
    );
    expect(view.querySelector('[data-testid="team-ai-delegation-chip"]')?.textContent).toBe("팀 Hermes 도움 · 검색");
  });

  it("멤버 목록에 없는 Hermes는 사전의 이름", () => {
    const gone = "00000000-0000-7000-8000-0000000004cc";
    const view = renderRow(answer({ ...DELEGATED, team_ai_delegated: [{ kind: "image", agent_member_id: gone }] }), SPENT);
    expect(view.querySelector('[data-testid="team-ai-delegation-chip"]')?.textContent).toBe("Hermes 도움 · 그림");
  });

  it("서버 소유 칸이 없는 답·사람이 같은 키를 쓴 메시지에는 칩도 쓴 양 줄도 없다", () => {
    const { team_ai_delegated: _omit, ...plain } = DELEGATED;
    void _omit;
    const noKey = renderRow(answer(plain), SPENT);
    expect(noKey.querySelector('[data-testid="team-ai-delegation-chip"]')).toBeNull();
    expect(noKey.querySelector('[data-testid="team-ai-spent"]')).toBeNull();
    // 예전 꼬리(모델 칩)는 그대로 선다.
    expect(noKey.querySelector('[data-testid="team-ai-model-chip"]')).not.toBeNull();
    act(() => root?.unmount());
    root = null;
    host?.remove();

    const forged = renderRow(answer(DELEGATED, { authorMemberId: ME }), SPENT);
    expect(forged.querySelector('[data-testid="team-ai-delegation-chip"]')).toBeNull();
    expect(forged.querySelector('[data-testid="team-ai-spent"]')).toBeNull();
    expect(forged.querySelector('[data-testid="team-ai-model-chip"]')).toBeNull();
  });
});

describe("이 답이 쓴 양 (P7·P8)", () => {
  it("run의 spent 그대로: 크레딧 토큰(도우미 행만)·Hermes 횟수·구독 문장", () => {
    const view = renderRow(answer(DELEGATED), SPENT);
    expect(view.querySelector('[data-testid="team-ai-spent-line"]')?.textContent).toBe(
      "이 답이 쓴 양: 크레딧 토큰 12.3k · 팀 Hermes 1회(구독이라 oort가 금액을 못 재요)"
    );
  });

  it("어림이면 그렇다고 말한다", () => {
    const view = renderRow(answer(DELEGATED), { ...SPENT, estimated: true });
    expect(view.querySelector('[data-testid="team-ai-spent-line"]')?.textContent).toBe(
      "이 답이 쓴 양: 크레딧 토큰 약 12.3k(어림) · 팀 Hermes 1회(구독이라 oort가 금액을 못 재요)"
    );
  });

  it("숫자가 아직 없으면 글은 없고 자리(낭독하지 않는 보이지 않는 글)만 서 있다", () => {
    const view = renderRow(answer(DELEGATED), null);
    const slot = view.querySelector<HTMLElement>('[data-testid="team-ai-spent"]');
    expect(slot).not.toBeNull();
    expect(view.querySelector('[data-testid="team-ai-spent-line"]')).toBeNull();
    const sizer = slot?.querySelector<HTMLElement>('[aria-hidden="true"]');
    expect(sizer?.className).toContain("invisible");
    expect(sizer?.textContent).toContain("888.8k");
  });
});

describe("맡겨 받은 그림의 자리", () => {
  it("그림 바이트가 오기 전부터 고정 정사각 틀(같은 클래스의 자리 canvas)", () => {
    const view = renderRow(answer(DELEGATED, { attachments: [PICTURE] }), SPENT);
    const canvas = view.querySelector<HTMLCanvasElement>('[data-testid="attachment-image-reserve"]');
    expect(canvas).not.toBeNull();
    expect(canvas?.className).toContain("aspect-square");
    expect(canvas?.className).toContain("w-inline-image-h");
  });

  it("칩 칸이 없는 답의 같은 그림은 예전 길(크기를 모르면 180 자리)이다", () => {
    const { team_ai_delegated: _omit, ...plain } = DELEGATED;
    void _omit;
    const view = renderRow(answer(plain, { attachments: [PICTURE] }), SPENT);
    expect(view.querySelector('[data-testid="attachment-image-reserve"]')).toBeNull();
    expect(view.querySelector('[data-testid="attachment-image"]')?.querySelector("button")?.className).toContain(
      "h-preview-frame"
    );
  });
});
