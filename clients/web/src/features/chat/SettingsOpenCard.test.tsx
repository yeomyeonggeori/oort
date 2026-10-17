// @vitest-environment jsdom
// U-S6 #3940: `settings.open` 제안 카드. 서버 골든 벡터(12 section)가 한 벌이다.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
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

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function mount(card: ReturnType<typeof cardFor>, viewer: string | undefined) {
  return render(
    <MemoryRouter initialEntries={["/c/general"]}>
      <CommandSuggestion
        card={card}
        viewerMemberId={viewer}
        directory={directory}
        channelId="c1"
        rootId={undefined}
      />
      <Where />
    </MemoryRouter>
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

  it("모르는 section(깨진 제안)은 대상에게도 한 줄이고 버튼이 없다 — 글로 폴백", () => {
    mount(cardFor({ section: "no-such-section" }), HUMAN);
    expect(screen.getByTestId("settings-suggest").getAttribute("data-viewer")).toBe("other");
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByTestId("settings-suggest-line").textContent).toContain("「설정 열기」");
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
      <MemoryRouter>
        <SettingsOpenSuggestion
          card={cardFor({ section: "notifications" })}
          viewerMemberId={HUMAN}
          directory={directory}
          channelId="c1"
          rootId={undefined}
        />
      </MemoryRouter>
    );
    expect(direct.getByTestId("settings-suggest")).toBeTruthy();
  });
});
