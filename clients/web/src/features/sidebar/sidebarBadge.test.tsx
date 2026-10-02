// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { WorkspaceRail } from "./WorkspaceRail";
import { badgeFor, destinationMarks } from "./sidebarBadge";
import { SessionStateChip } from "./SessionStateChip";

vi.mock("@/features/workspace/useAddWorkspace", () => ({
  useOpenAddWorkspace: () => () => undefined,
}));
vi.mock("./useWorkspaceAvatar", () => ({ useWorkspaceAvatar: () => undefined }));
vi.mock("@/features/emoji/useHoverNone", () => ({ useHoverNone: () => false }));

afterEach(cleanup);

// 표시 문법(#3338): 잉크 = 나에게 필요(멘션 포함), 호박 = 일반 안 읽음. 색은 클래스가 진다.
const INK = "bg-primary";
const AMBER = "bg-signal";

function row(props: { unreadCount?: number; mentionCount?: number }) {
  return render(
    <MemoryRouter>
      <ul>
        <SidebarRow to="/x" icon={null} label="채널" {...props} />
      </ul>
    </MemoryRouter>
  );
}

describe("알약 문법: 규칙 함수", () => {
  it("필요가 있으면 잉크, 없고 안 읽음만 있으면 호박, 둘 다 있으면 잉크 하나", () => {
    expect(badgeFor({ needsMe: 2, unread: 5 })).toEqual({ tone: "ink", count: 2 });
    expect(badgeFor({ unread: 5 })).toEqual({ tone: "amber", count: 5 });
    expect(badgeFor({})).toBeNull();
  });
});

describe("알약 문법: 줄", () => {
  it("멘션은 잉크이고 호박이 아니다", () => {
    const { getByTestId } = row({ mentionCount: 2, unreadCount: 7 });
    const pill = getByTestId("mention-badge");
    expect(pill.className).toContain(INK);
    expect(pill.className).not.toContain(AMBER);
    expect(pill.textContent).toBe("2");
  });
  it("일반 안 읽음은 호박이고 잉크가 아니다", () => {
    const { getByTestId } = row({ unreadCount: 3 });
    const pill = getByTestId("unread-count");
    expect(pill.className).toContain(AMBER);
    expect(pill.className).not.toContain(INK);
  });
  it("접힌 구획 머리도 같은 문법이다", () => {
    const mk = (p: { unreadCount?: number; mentionCount?: number }) =>
      render(
        <SidebarSection title="채널" sectionId="channels" collapsed onCollapsedChange={() => undefined} {...p}>
          {null}
        </SidebarSection>
      );
    const a = mk({ mentionCount: 1, unreadCount: 4 });
    expect(a.getByTestId("section-unread-channels").className).toContain(INK);
    a.unmount();
    const b = mk({ unreadCount: 4 });
    expect(b.getByTestId("section-unread-channels").className).toContain(AMBER);
    expect(b.getByTestId("section-unread-channels").className).not.toContain(INK);
  });
});

describe("접힌 레일 = 펼친 줄", () => {
  const needs = { total: 6, panes: 1 };
  const marks = destinationMarks({ needsMe: needs, unreadChannels: 2, doneUnseen: false });

  it("같은 입력에서 인박스·내 작업 알약의 색과 수가 줄과 레일이 같다", () => {
    const rail = render(
      <MemoryRouter>
        <WorkspaceRail
          workspace={{ name: "w", isPending: false, isError: false }}
          workspaceId="w"
          active={null}
          collapsed
          marks={marks}
        />
      </MemoryRouter>
    );
    // 줄에는 needsMe의 수를 **그대로**(함수를 거치지 않고) 넣어 독립 기대값을 만든다.
    const rows = row({ mentionCount: needs.total });
    const railInbox = rail.getByTestId("rail-inbox-badge");
    const rowInbox = rows.getByTestId("mention-badge");
    expect(railInbox.textContent).toBe(rowInbox.textContent);
    expect(railInbox.textContent).toBe(String(needs.total));
    expect(railInbox.className).toContain(INK);
    expect(railInbox.className).not.toContain(AMBER);
    const railMine = rail.getByTestId("rail-mine-badge");
    expect(railMine.textContent).toBe("1");
    expect(railMine.className).toContain(INK);
    // 안 읽은 채널은 수 없이 호박 점으로만 선다(펼침에서는 채널 줄이 수를 말한다).
    const dot = rail.getByTestId("rail-chat-dot");
    expect(dot.className).toContain(AMBER);
    expect(rail.queryByTestId("rail-chat-badge")).toBeNull();
  });

  it("알약이 있으면 점은 없고, 응답 필요가 풀리면 안 본 끝남이 초록 점이다", () => {
    expect(marks.mine.dot).toBeNull();
    const done = destinationMarks({ needsMe: { total: 0, panes: 0 }, unreadChannels: 0, doneUnseen: true });
    expect(done.mine).toEqual({ pill: null, dot: "ok" });
    expect(done.chat).toEqual({ pill: null, dot: null });
  });
});

describe("세션 칩", () => {
  it.each([
    ["running", "실행 중"],
    ["waiting", "응답 필요"],
    ["done", "끝남"],
    ["idle", "대기"],
  ] as const)("%s = 글자 %s", (status, text) => {
    const { getByTestId } = render(<SessionStateChip status={status} />);
    expect(getByTestId("session-state-chip").textContent).toBe(text);
  });
});
