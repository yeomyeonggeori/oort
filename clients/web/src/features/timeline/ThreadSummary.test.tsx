// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { RosterMember, ThreadRollup } from "@momo/core/lib/api";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import { koreanLocale } from "@/testing/koLocale";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { ThreadSummaryLine } from "./ThreadSummary";

// =============================================================================
// 스레드 요약 줄 (#4878, owner 10-31): 겹친 얼굴(≤3) + 「답글 N개」 + 안 읽은 답글이 있으면 신호색과 「새 답글 M」 칩.
// 「마지막 답글 X 전」은 없다. 줄 전체가 「스레드 열기」 버튼 하나다.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const ids = {
  a: "00000000-0000-7000-8000-0000000000a1",
  b: "00000000-0000-7000-8000-0000000000a2",
  c: "00000000-0000-7000-8000-0000000000a3",
  d: "00000000-0000-7000-8000-0000000000a4",
  e: "00000000-0000-7000-8000-0000000000a5",
  agent: "00000000-0000-7000-8000-000000000102",
  gone: "00000000-0000-7000-8000-0000000000ff",
};

function member(id: string, name: string, kind: "human" | "agent" = "human"): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind,
    status: "active",
    displayName: name,
    handle: name,
    role: "member",
    channelCount: 1,
    channelIds: [],
    capabilities: [],
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

const directory = makeDirectory([
  member(ids.a, "가영"),
  member(ids.b, "나래"),
  member(ids.c, "다온"),
  member(ids.d, "라온"),
  member(ids.e, "마루"),
  member(ids.agent, "달무리봇", "agent"),
]);

function rollup(over: Partial<ThreadRollup> = {}): ThreadRollup {
  return {
    replyCount: 3,
    lastReplySeq: 10,
    lastReplyAtMs: Date.now() - 5 * 60_000,
    participantIds: [ids.a, ids.b],
    participantCount: 2,
    ...over,
  };
}

let ko: AppLocale;
beforeAll(async () => {
  ko = await koreanLocale();
});
afterEach(cleanup);

function line(value: ThreadRollup, onOpen?: () => void, korean = true) {
  const node = <ThreadSummaryLine rollup={value} directory={directory} onOpen={onOpen} />;
  return render(korean ? <LocaleProvider locale={ko}>{node}</LocaleProvider> : node);
}

const faces = () => screen.queryAllByTestId("thread-face");
const TIME_WORDS = /마지막|분 전|시간 전|일 전|방금|ago|last|just now/i;

describe("겹친 얼굴", () => {
  it("참여자가 다섯이어도 얼굴은 셋이고 서버가 준 순서(최근 먼저) 그대로다", () => {
    line(rollup({ participantIds: [ids.e, ids.d, ids.c, ids.b, ids.a], participantCount: 5 }));
    expect(faces().map((face) => face.textContent)).toEqual(["마", "라", "다"]);
  });

  it("4명 이상이어도 얼굴 뒤에 숫자(+N)를 붙이지 않는다 — 글은 「답글 N개」뿐이다", () => {
    line(rollup({ participantIds: [ids.e, ids.d, ids.c], participantCount: 9, replyCount: 12 }));
    expect(screen.getByTestId("thread-anchor").textContent).not.toMatch(/\+\d/);
    expect(screen.getByTestId("thread-count").textContent).toBe("답글 12개");
  });

  it("규격은 이름 클래스다: 한 변 20, 바탕색 2px 링, 둘째부터 −6 겹침", () => {
    line(rollup({ participantIds: [ids.a, ids.b, ids.c] }));
    const [first, second, third] = faces();
    for (const face of [first, second, third]) {
      expect(face.className).toContain("size-thread-face");
      expect(face.className).toContain("ring-2");
      expect(face.className).toContain("ring-pane");
      expect(face.className).not.toContain("size-8");
    }
    expect(first.className).not.toContain("-ml-thread-face-overlap");
    expect(second.className).toContain("-ml-thread-face-overlap");
    expect(third.className).toContain("-ml-thread-face-overlap");
  });

  it("에이전트는 기존 아바타 규칙(둥근 사각·agent), 사람은 원, 명부에서 못 푸는 id는 「알 수 없는 사람」", () => {
    line(rollup({ participantIds: [ids.agent, ids.a, ids.gone] }));
    const [agent, human, unknown] = faces();
    expect(agent.getAttribute("data-avatar-kind")).toBe("agent");
    expect(agent.className).toContain("rounded-sm");
    expect(human.getAttribute("data-avatar-kind")).toBe("human");
    expect(human.className).toContain("rounded-full");
    expect(unknown.getAttribute("data-avatar-kind")).toBe("unknown");
  });

  it("얼굴은 보조기술에 나가지 않는다 — 줄의 이름은 버튼 라벨 하나다", () => {
    line(rollup(), () => undefined);
    expect(screen.getByTestId("thread-faces").getAttribute("aria-hidden")).toBe("true");
  });

  it("옛 서버(참여자 없음)는 얼굴 없이 지금 모양 그대로다", () => {
    line(rollup({ participantIds: undefined, participantCount: undefined }));
    expect(screen.queryByTestId("thread-faces")).toBeNull();
    expect(faces()).toHaveLength(0);
    expect(screen.getByTestId("thread-count").textContent).toBe("답글 3개");
    cleanup();
    line(rollup({ participantIds: [] }));
    expect(screen.queryByTestId("thread-faces")).toBeNull();
  });
});

describe("글과 시간 문구", () => {
  it("「답글 N개」만 있고 「마지막 답글 X 전」은 어떤 값에서도 없다", () => {
    for (const lastReplyAtMs of [Date.now(), Date.now() - 90 * 60_000, Date.now() - 4 * 86_400_000]) {
      for (const unreadReplyCount of [undefined, 0, 3]) {
        const view = line(rollup({ lastReplyAtMs, unreadReplyCount }), () => undefined);
        const all = `${view.container.textContent}|${screen.getByTestId("thread-anchor").getAttribute("aria-label")}`;
        expect(all).not.toMatch(TIME_WORDS);
        view.unmount();
      }
    }
  });

  it("공급자가 없으면 번들된 영어로 선다(폴백 문구를 화면 코드에 두지 않는다)", () => {
    line(rollup({ unreadReplyCount: 2 }), () => undefined, false);
    expect(screen.getByTestId("thread-count").textContent).toBe("3 replies");
    expect(screen.getByTestId("thread-unread-chip").textContent).toBe("2 new replies");
    expect(screen.getByTestId("thread-anchor").getAttribute("aria-label")).toBe(
      "Open thread, 3 replies, 2 new replies"
    );
  });
});

describe("안 읽은 답글 — 강조색과 「새 답글 M」 칩", () => {
  it("양수면 글이 신호색이 되고 칩이 붙는다", () => {
    line(rollup({ unreadReplyCount: 2 }));
    const count = screen.getByTestId("thread-count");
    expect(count.className).toContain("text-signal-text");
    expect(count.className).not.toContain("text-ink");
    expect(screen.getByTestId("thread-unread-chip").textContent).toBe("새 답글 2");
    expect(screen.getByTestId("thread-unread-chip").className).toContain("bg-signal");
    expect(screen.getByTestId("thread-unread-chip").className).toContain("text-on-signal");
    expect(screen.getByTestId("thread-anchor").getAttribute("data-unread")).toBe("true");
  });

  it.each([undefined, 0])("값이 %s 이면 지금 모양 — 칩도 강조도 없다", (unreadReplyCount) => {
    line(rollup({ unreadReplyCount }));
    expect(screen.queryByTestId("thread-unread-chip")).toBeNull();
    expect(screen.getByTestId("thread-count").className).toContain("text-ink");
    expect(screen.getByTestId("thread-count").className).not.toContain("text-signal-text");
    expect(screen.getByTestId("thread-anchor").hasAttribute("data-unread")).toBe(false);
  });

  it("접근성 라벨에 안 읽은 수가 들어간다: 「스레드 열기, 답글 3개, 새 답글 2개」", () => {
    line(rollup({ unreadReplyCount: 2 }), () => undefined);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("스레드 열기, 답글 3개, 새 답글 2개");
    cleanup();
    line(rollup(), () => undefined);
    expect(screen.getByRole("button").getAttribute("aria-label")).toBe("스레드 열기, 답글 3개");
  });
});

describe("줄 전체가 하나의 버튼", () => {
  it("버튼은 하나이고, 얼굴·글·칩 어디를 눌러도 같은 한 번의 열기다", () => {
    const open = vi.fn();
    line(rollup({ unreadReplyCount: 1, participantIds: [ids.a, ids.b] }), open);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("thread-unread-chip"));
    fireEvent.click(screen.getByTestId("thread-count"));
    fireEvent.click(faces()[0]);
    expect(open).toHaveBeenCalledTimes(3);
  });

  it("키보드 초점 링이 서고 행 키 이동 그룹에 든다(data-row-action)", () => {
    line(rollup(), () => undefined);
    const button = screen.getByRole("button");
    expect(button.className).toContain("focus-visible:focus-ring");
    expect(button.hasAttribute("data-row-action")).toBe(true);
    button.focus();
    expect(document.activeElement).toBe(button);
  });

  it("열 곳이 없으면 죽은 버튼 대신 같은 모양의 글이다", () => {
    line(rollup({ unreadReplyCount: 2 }));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    const anchor = screen.getByTestId("thread-anchor");
    expect(anchor.tagName).toBe("SPAN");
    expect(anchor.hasAttribute("tabindex")).toBe(false);
    expect(anchor.textContent).toContain("답글 3개");
    expect(anchor.textContent).toContain("새 답글 2");
  });
});
