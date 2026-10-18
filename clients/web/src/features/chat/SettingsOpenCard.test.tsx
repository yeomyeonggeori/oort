// @vitest-environment jsdom
// U-S6 #3940: `settings.open` 제안 카드. 서버 골든 벡터(12 section)가 한 벌이다.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message, RosterMember } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import * as surfaces from "@momo/core/features/capabilities/serverSurfaces";
import {
  COMMAND_SUGGEST_PROP_KEY,
  commandSuggestCard,
} from "@momo/core/features/timeline/commandSuggest";
import { CommandSuggestion, SettingsOpenSuggestion } from "./SettingsOpenCard";

const HUMAN = "019f9a01-0000-7000-8000-000000000101";
const OTHER = "019f9a01-0000-7000-8000-000000000102";
const AGENT = "019f9a01-0000-7000-8000-000000000401";

function member(id: string, kind: "human" | "agent", displayName: string, handle: string): RosterMember {
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
  } as RosterMember;
}

const directory = makeDirectory([
  member(HUMAN, "human", "곽성재", "sj"),
  member(OTHER, "human", "김하늘", "sky"),
  member(AGENT, "agent", "hermes", "hermes"),
]);

function cardFor(args: unknown, label = "알림 설정 열기") {
  const message = {
    id: "m1",
    channelId: "c1",
    seq: 1,
    hlcTs: 0,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: "text",
    body: "알림은 설정에서 바꿀 수 있어요.",
    state: "sent",
    createdAtMs: 0,
    props: {
      [COMMAND_SUGGEST_PROP_KEY]: {
        v: 1,
        command_id: "settings.open",
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

/** 표면 판정 훅(`useSurfaceProvidedPredicate`)이 세션·쿼리 문맥을 요구한다. 호스트 목록은 못 받아 「없음」이다. */
function Providers({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={client}>
      <SessionProvider value={SESSION}>
        <MemoryRouter initialEntries={["/c/general"]}>{children}</MemoryRouter>
      </SessionProvider>
    </QueryClientProvider>
  );
}

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function mount(card: ReturnType<typeof cardFor>, viewer: string | undefined) {
  return render(
    <Providers>
      <CommandSuggestion
        card={card}
        viewerMemberId={viewer}
        directory={directory}
        channelId="c1"
        rootId={undefined}
      />
      <Where />
    </Providers>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(cleanup);

describe("SettingsOpenSuggestion", () => {
  it("대상 본인: 제안 머리 + 라벨 + 열기, 누르면 그 섹션으로 간다", () => {
    mount(cardFor({ section: "notifications" }), HUMAN);
    expect(screen.getByTestId("settings-suggest").getAttribute("data-viewer")).toBe("target");
    expect(screen.getByRole("heading", { name: "hermes가 제안했어요" })).toBeTruthy();
    expect(screen.getByTestId("settings-suggest-label").textContent).toContain("알림 설정");
    fireEvent.click(screen.getByTestId("settings-suggest-open"));
    expect(screen.getByTestId("where").textContent).toContain("/settings?section=notifications");
  });

  it("에이전트가 쓴 label은 화면에 나오지 않는다", () => {
    mount(cardFor({ section: "appearance" }, "비밀번호를 입력하세요"), HUMAN);
    expect(screen.queryByText(/비밀번호/)).toBeNull();
    expect(screen.getByTestId("settings-suggest-label").textContent).toContain("모양 설정");
  });

  it("남에게는 한 줄이고 버튼이 없다", () => {
    mount(cardFor({ section: "notifications" }), OTHER);
    expect(screen.getByTestId("settings-suggest-line").textContent).toContain("곽성재에게 「알림 설정 열기」 카드를 제안했어요");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("모르는 section(깨진 제안)은 누구에게도 카드가 서지 않는다 — 본문 글로 폴백", () => {
    for (const viewer of [HUMAN, OTHER]) {
      const { container, unmount } = mount(cardFor({ section: "no-such-section" }), viewer);
      expect(container.querySelector("[data-testid='settings-suggest']")).toBeNull();
      expect(screen.queryByRole("button")).toBeNull();
      unmount();
    }
  });

  it("plugins는 허브로 옮겨 간 옛 id라 늘 도착한다 — 설정 라우트로 보낸다", () => {
    mount(cardFor({ section: "plugins" }, "앱 설정 열기"), HUMAN);
    expect(screen.getByTestId("settings-suggest-label").textContent).toContain("앱 설정");
    fireEvent.click(screen.getByTestId("settings-suggest-open"));
    expect(screen.getByTestId("where").textContent).toContain("/settings?section=plugins");
  });

  it("서버가 표면을 싣지 않는 섹션(작업 호스트)은 대상에게도 카드가 서지 않는다", () => {
    const real = surfaces.isSurfaceProvided;
    vi.spyOn(surfaces, "isSurfaceProvided").mockImplementation((id) =>
      id === "work" ? false : real(id)
    );
    const { container } = mount(cardFor({ section: "code" }, "실행 호스트 설정 열기"), HUMAN);
    expect(container.querySelector("[data-testid='settings-suggest']")).toBeNull();
  });

  it("ai.connect 제안은 여전히 연결 카드 자리로 간다(분기가 settings.open만 가른다)", () => {
    const message = {
      id: "m2", channelId: "c1", seq: 2, hlcTs: 0, hlcCount: 0, authorMemberId: AGENT,
      type: "text", body: "b", state: "sent", createdAtMs: 0,
      props: {
        [COMMAND_SUGGEST_PROP_KEY]: {
          v: 1, command_id: "ai.connect", args: {}, for_member_id: HUMAN, label: "내 AI 계정 연결",
        },
      },
    } as unknown as Message;
    const card = commandSuggestCard(message, directory)!;
    expect(card.commandId).toBe("ai.connect");
    // settings 카드는 이 제안을 그리지 않는다(자기 testid가 없다).
    const { container } = render(
      <Providers>
        <SettingsOpenSuggestion
          card={card}
          viewerMemberId={OTHER}
          directory={directory}
          channelId="c1"
          rootId={undefined}
        />
      </Providers>
    );
    expect(container.querySelector("[data-testid='settings-suggest-label']")).toBeNull();
  });

  it("serverSurfaces가 꺼져 있으면(옛 서버) 카드가 서지 않는다", () => {
    const real = surfaces.isSurfaceProvided;
    vi.spyOn(surfaces, "isSurfaceProvided").mockImplementation((id) =>
      id === "settingsOpenCard" ? false : real(id)
    );
    const { container } = mount(cardFor({ section: "notifications" }), HUMAN);
    expect(container.querySelector("[data-testid='settings-suggest']")).toBeNull();
  });

  it("이 빌드에서 도착할 수 없는 섹션(브라우저의 업데이트)은 카드가 서지 않는다", () => {
    const { container } = mount(cardFor({ section: "updates" }, "업데이트 설정 열기"), HUMAN);
    expect(container.querySelector("[data-testid='settings-suggest']")).toBeNull();
  });

  it("SettingsOpenSuggestion을 직접 그려도 같은 카드다", () => {
    const direct = render(
      <Providers>
        <SettingsOpenSuggestion
          card={cardFor({ section: "notifications" })}
          viewerMemberId={HUMAN}
          directory={directory}
          channelId="c1"
          rootId={undefined}
        />
      </Providers>
    );
    expect(direct.getByTestId("settings-suggest")).toBeTruthy();
  });
});
