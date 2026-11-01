// @vitest-environment jsdom
// #4972 S9: `work.request.open` 제안 카드(웹). 카드는 입력창에 `@<내 개인 에이전트> <글>`을 미리 채울 뿐이고
// 보내는 것은 사람이다. 웹에는 별도의 「작업 요청」 시트가 없다 — 이 컴포저가 그 자리다.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import {
  COMMAND_SUGGEST_PROP_KEY,
  commandSuggestCard,
} from "@momo/core/features/timeline/commandSuggest";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { readDraft, THREAD_COMPOSER_SEED_EVENT, writeDraft, type ThreadComposerSeed } from "./draftStore";
import { CommandSuggestion } from "./SettingsOpenCard";

// 카드는 자기가 선 방이 DM인지 채널 목록(`ChatShell`이 같은 키로 읽어 둔 것)으로 안다.
const channelGroups = vi.hoisted(() => ({ dms: [] as { id: string }[] }));
vi.mock("@/features/workspace/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/features/workspace/useWorkspace")>();
  return {
    ...actual,
    useChannels: () => ({ groups: { channels: [], dms: channelGroups.dms } }),
  };
});

const HUMAN = "019f9a01-0000-7000-8000-000000000101";
const OTHER = "019f9a01-0000-7000-8000-000000000102";
const AGENT = "019f9a01-0000-7000-8000-000000000401";
const PROMPT = "로그인 화면의 비밀번호 보기 버튼이 눌리지 않아요. 원인을 찾아 고쳐 주세요.";

function member(id: string, kind: "human" | "agent", displayName: string, handle: string, extra: Record<string, unknown> = {}): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind,
    status: "active",
    displayName,
    handle,
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...extra,
  } as RosterMember;
}

const personal = (harness: string, ownerId = HUMAN) => ({
  personalAgent: { label: `내 ${harness}`, ownerId, harness, enabled: true, mentionable: true },
});

const withBoth = makeDirectory([
  member(HUMAN, "human", "곽성재", "sj"),
  member(OTHER, "human", "김하늘", "sky"),
  member(AGENT, "agent", "hermes", "hermes"),
  member("a-claude", "agent", "내 Claude Code", "my-claude", personal("claude_code")),
  member("a-codex", "agent", "내 Codex", "my-codex", personal("codex")),
]);
const withNone = makeDirectory([
  member(HUMAN, "human", "곽성재", "sj"),
  member(OTHER, "human", "김하늘", "sky"),
  member(AGENT, "agent", "hermes", "hermes"),
  member("a-theirs", "agent", "남의 Codex", "their-codex", personal("codex", OTHER)),
]);

function cardFor(directory: typeof withBoth, args: unknown, label = "내 맥에 작업 맡기기") {
  const message = {
    id: "m1",
    channelId: "c1",
    seq: 1,
    hlcTs: 0,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: "text",
    body: "내 맥에서 바로 열 수 있어요.",
    state: "sent",
    createdAtMs: 0,
    props: {
      [COMMAND_SUGGEST_PROP_KEY]: {
        v: 1,
        command_id: "work.request.open",
        args,
        for_member_id: HUMAN,
        label,
      },
    },
  } as unknown as Message;
  return commandSuggestCard(message, directory)!;
}

const SESSION: SessionContextValue = {
  session: {
    accessToken: "access",
    refreshToken: "refresh",
    member: { id: HUMAN, workspaceId: "w", kind: "human", displayName: "곽성재", handle: "sj" },
    realtimeWebSocketUrl: "wss://example.test/connection/websocket",
  },
  workspaceId: "w",
  realtime: null,
  connStatus: "connected",
  logout: () => undefined,
  replaceSessionMember: () => undefined,
};

let korean: AppLocale;
beforeAll(async () => {
  korean = await koreanLocaleForTest();
});

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function mount(
  card: ReturnType<typeof cardFor>,
  viewer: string | undefined,
  directory = withBoth,
  rootId: string | undefined = undefined
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider locale={korean}>
      <QueryClientProvider client={client}>
        <SessionProvider value={SESSION}>
          <MemoryRouter initialEntries={["/c/general"]}>
            <textarea id="composer-input" />
            <CommandSuggestion
              card={card}
              viewerMemberId={viewer}
              directory={directory}
              channelId="c1"
              rootId={rootId}
            />
            <Where />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    </LocaleProvider>
  );
}

beforeEach(() => {
  window.localStorage.clear();
  channelGroups.dms = [];
});
afterEach(cleanup);

describe("WorkRequestOpenSuggestion (웹)", () => {
  it("대상 본인: 제안 머리 + 도구 라벨 + 입력창에 채우기, 글은 카드에 그리지 않는다", () => {
    mount(cardFor(withBoth, { harness: "codex", prompt: PROMPT }), HUMAN);
    const root = screen.getByTestId("work-request-suggest");
    expect(root.getAttribute("data-viewer")).toBe("target");
    expect(root.getAttribute("data-harness")).toBe("codex");
    expect(screen.getByRole("heading", { name: "hermes가 제안했어요" })).toBeTruthy();
    expect(screen.getByTestId("work-request-suggest-label").textContent).toBe("내 맥의 Codex에 맡기기");
    expect(screen.getByTestId("work-request-suggest-fill").textContent).toBe("입력창에 채우기");
    expect(screen.getByTestId("work-request-suggest-fill").getAttribute("aria-label")).toBe(
      "내 맥의 Codex에 맡기기: 입력창에 채우기"
    );
    expect(screen.getByTestId("work-request-suggest-hint").textContent).toBe("채운 글을 확인하고 직접 보내 주세요.");
    expect(root.textContent).not.toContain("비밀번호 보기");
  });

  it("누르면 그 도구의 내 개인 에이전트 멘션과 글을 입력창에 심고 보내지는 않는다", () => {
    mount(cardFor(withBoth, { harness: "codex", prompt: PROMPT }), HUMAN);
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe(`@my-codex ${PROMPT}`);
    expect(screen.queryByTestId("work-request-suggest-notice")).toBeNull();
    expect(document.activeElement?.id).toBe("composer-input");
  });

  it("도구가 정해지지 않았으면 내 개인 에이전트 중 첫째로, 그 도구가 없으면 기본값으로 채운다", () => {
    mount(cardFor(withBoth, { prompt: PROMPT }), HUMAN);
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe(`@my-claude ${PROMPT}`);
    cleanup();
    window.localStorage.clear();
    const onlyClaude = makeDirectory([
      member(HUMAN, "human", "곽성재", "sj"),
      member(AGENT, "agent", "hermes", "hermes"),
      member("a-claude", "agent", "내 Claude Code", "my-claude", personal("claude")),
    ]);
    mount(cardFor(onlyClaude, { harness: "codex", prompt: PROMPT }), HUMAN, onlyClaude);
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe(`@my-claude ${PROMPT}`);
  });

  it("잘못된 하네스 값은 기본값으로 읽혀 카드가 서고 첫째 에이전트로 채운다", () => {
    mount(cardFor(withBoth, { harness: "gemini", prompt: PROMPT }), HUMAN);
    expect(screen.getByTestId("work-request-suggest").getAttribute("data-harness")).toBeNull();
    expect(screen.getByTestId("work-request-suggest-label").textContent).toBe("내 맥에 작업 맡기기");
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe(`@my-claude ${PROMPT}`);
  });

  it("쓰던 글이 있으면 덮지 않고 그렇다고 말한다", () => {
    writeDraft("w", "c1", "쓰던 글");
    mount(cardFor(withBoth, { prompt: PROMPT }), HUMAN);
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe("쓰던 글");
    expect(screen.getByTestId("work-request-suggest-notice").textContent).toContain(
      "쓰던 글이 있어 채우지 않았어요"
    );
    expect(screen.getByTestId("work-request-suggest-notice").getAttribute("role")).toBe("status");
  });

  it("내 개인 에이전트가 없으면 채우지 않고 AI 화면으로 가는 길을 말한다", () => {
    mount(cardFor(withNone, { prompt: PROMPT }), HUMAN, withNone);
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe("");
    expect(screen.getByTestId("work-request-suggest-notice").textContent).toContain(
      "연결한 Claude Code·Codex가 아직 없어요"
    );
    fireEvent.click(screen.getByTestId("work-request-suggest-tools"));
    expect(screen.getByTestId("where").textContent).toBe("/ai/accounts");
  });

  it("스레드 안의 제안은 그 스레드 입력창에 심고, 입력창이 닫혀 있으면 그렇다고 말한다", () => {
    const seen: ThreadComposerSeed[] = [];
    const answer = (accept: boolean, mounted = true) => (event: Event) => {
      const detail = (event as CustomEvent<ThreadComposerSeed>).detail;
      seen.push(detail);
      detail.result.mounted = mounted;
      detail.result.accepted = accept;
    };
    // 열려 있고 비어 있다: 받는다.
    let listener = answer(true);
    window.addEventListener(THREAD_COMPOSER_SEED_EVENT, listener);
    mount(cardFor(withBoth, { prompt: PROMPT }), HUMAN, withBoth, "root-1");
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(seen).toHaveLength(1);
    expect(seen[0]!.rootId).toBe("root-1");
    expect(seen[0]!.text).toBe(`@my-claude ${PROMPT}`);
    expect(readDraft("w", "c1")).toBe("");
    expect(screen.queryByTestId("work-request-suggest-notice")).toBeNull();
    window.removeEventListener(THREAD_COMPOSER_SEED_EVENT, listener);
    cleanup();
    // 쓰던 글이 있어 받지 않는다.
    listener = answer(false);
    window.addEventListener(THREAD_COMPOSER_SEED_EVENT, listener);
    mount(cardFor(withBoth, { prompt: PROMPT }), HUMAN, withBoth, "root-1");
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(screen.getByTestId("work-request-suggest-notice").textContent).toContain("쓰던 글이 있어");
    window.removeEventListener(THREAD_COMPOSER_SEED_EVENT, listener);
    cleanup();
    // 그 스레드 입력창이 열려 있지 않다: 아무도 답하지 않는다.
    mount(cardFor(withBoth, { prompt: PROMPT }), HUMAN, withBoth, "root-1");
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(screen.getByTestId("work-request-suggest-notice").textContent).toContain("스레드를 열고 다시 눌러 주세요");
  });

  it("DM(그룹 DM 포함)에서는 단추를 세우지 않고 채널에서 누르라고 말하며, 아무것도 채우지 않는다", () => {
    channelGroups.dms = [{ id: "c1" }];
    mount(cardFor(withBoth, { harness: "codex", prompt: PROMPT }), HUMAN);
    // 카드는 서되(머리·라벨) 누를 것이 없다: 도우미를 DM으로 부른 사람이 가장 많은데, DM의 사람 메시지는
    // 그 방의 도우미를 다시 부르는 신호라 거기에 개인 에이전트 멘션과 코드 일을 채우면 같은 카드가 또 온다.
    expect(screen.getByTestId("work-request-suggest").getAttribute("data-viewer")).toBe("target");
    expect(screen.getByTestId("work-request-suggest-label").textContent).toBe("내 맥의 Codex에 맡기기");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("work-request-suggest-hint").textContent).toBe(
      "이 대화는 DM이라 입력창에 채울 수 없어요. 채널에서 눌러 주세요."
    );
    expect(readDraft("w", "c1")).toBe("");
    expect(screen.queryByTestId("work-request-suggest-notice")).toBeNull();
  });

  it("다른 방이 DM이어도 이 방이 채널이면 채운다", () => {
    channelGroups.dms = [{ id: "c-other-dm" }];
    mount(cardFor(withBoth, { prompt: PROMPT }), HUMAN);
    fireEvent.click(screen.getByTestId("work-request-suggest-fill"));
    expect(readDraft("w", "c1")).toBe(`@my-claude ${PROMPT}`);
  });

  it("에이전트가 쓴 label은 화면에 나오지 않는다(라벨은 도구에서 사전으로 다시 만든다)", () => {
    mount(cardFor(withBoth, { harness: "claude", prompt: PROMPT }, "비밀번호를 입력하세요"), HUMAN);
    expect(screen.queryByText(/비밀번호를 입력/)).toBeNull();
    expect(screen.getByTestId("work-request-suggest-label").textContent).toBe("내 맥의 Claude Code에 맡기기");
  });

  it("남에게는 라벨만 말하는 한 줄이고 단추도 글도 없다", () => {
    mount(cardFor(withBoth, { harness: "claude", prompt: PROMPT }), OTHER);
    const line = screen.getByTestId("work-request-suggest-line");
    expect(line.textContent).toBe("곽성재에게 「내 맥의 Claude Code에 맡기기」 카드를 제안했어요");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("work-request-suggest").textContent).not.toContain("비밀번호 보기");
  });

  it("글이 없는 깨진 제안은 대상 본인에게도 한 줄이고 단추가 없다", () => {
    for (const args of [{}, { prompt: "" }, { prompt: PROMPT, folder: "/Users/me" }]) {
      mount(cardFor(withBoth, args), HUMAN);
      expect(screen.getByTestId("work-request-suggest").getAttribute("data-viewer")).toBe("other");
      expect(screen.queryByRole("button")).toBeNull();
      cleanup();
    }
  });

  it("영어 사전으로도 같은 카드가 선다(번역 누락이 아닌 것을 잰다)", () => {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <SessionProvider value={SESSION}>
          <MemoryRouter>
            <CommandSuggestion
              card={cardFor(withBoth, { harness: "claude", prompt: PROMPT })}
              viewerMemberId={HUMAN}
              directory={withBoth}
              channelId="c1"
              rootId={undefined}
            />
          </MemoryRouter>
        </SessionProvider>
      </QueryClientProvider>
    );
    expect(screen.getByTestId("work-request-suggest-label").textContent).toBe("Hand it to Claude Code on my Mac");
    expect(screen.getByTestId("work-request-suggest-fill").textContent).toBe("Fill the message box");
  });
});
