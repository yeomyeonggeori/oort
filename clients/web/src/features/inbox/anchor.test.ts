import { describe, expect, it, vi } from "vitest";
import {
  channelPath,
  messageAnchorPath,
  messageIdSelector,
  messageSelector,
  searchHitPath,
  watchForMessage,
  watchForMessageId,
  workSessionPath,
} from "./anchor";

describe("channelPath", () => {
  it("opens the channel when the source projection carries no seq", () => {
    expect(channelPath("00000000-0000-7000-8000-000000000201")).toBe(
      "/c/00000000-0000-7000-8000-000000000201"
    );
  });

  it("carries the anchor in the url so a reload still names the target", () => {
    expect(channelPath("019F94E3-0E04-79CD-9DEE-208F47EDD9A8", 147)).toBe(
      "/c/019F94E3-0E04-79CD-9DEE-208F47EDD9A8?seq=147"
    );
  });

  it("targets the timeline row identity the seq gate also asserts on", () => {
    expect(messageSelector(147)).toBe(
      '[data-testid="timeline-message"][data-seq="147"]'
    );
  });
});

describe("searchHitPath", () => {
  it("찾을 열쇠와 못 찾았을 때 설명할 열쇠를 함께 싣는다", () => {
    const path = searchHitPath(
      "019F94E3-0E04-79CD-9DEE-208F47EDD9A8",
      "019F94E3-0E04-79CD-9DEE-208F47EDD9A9",
      812
    );
    expect(path).toContain("msg=019f94e3-0e04-79cd-9dee-208f47edd9a9");
    expect(path).toContain("seq=812");
    expect(path.startsWith("/c/019F94E3-0E04-79CD-9DEE-208F47EDD9A8?")).toBe(true);
  });
});

describe("messageAnchorPath", () => {
  it("anchors by id for a projection that never sees a seq", () => {
    expect(
      messageAnchorPath(
        "00000000-0000-7000-8000-000000000201",
        "019F94E3-0E04-79CD-9DEE-208F47EDD9A8"
      )
    ).toBe(
      "/c/00000000-0000-7000-8000-000000000201?msg=019f94e3-0e04-79cd-9dee-208f47edd9a8"
    );
  });

  it("folds the wire's upper-cased UUID, which a CSS selector would not", () => {
    expect(messageIdSelector("019F94E3-0E04-79CD-9DEE-208F47EDD9A8")).toBe(
      '[data-testid="timeline-message"][data-message-id="019f94e3-0e04-79cd-9dee-208f47edd9a8"]'
    );
  });

  // 이 값은 이제 주소창에서 온다(ChatShell이 `?msg=`를 읽는다). 따옴표 하나가
  // 섞이면 `querySelector`가 SyntaxError를 던지는데, 그것은 점프 하나가 실패하는
  // 것이 아니라 채널 표면 전체가 넘어지는 일이다(PR 918 R1 Low).
  it("closes the quoted value a non-uuid could otherwise break out of", () => {
    expect(messageIdSelector('abc"], script')).toBe(
      '[data-testid="timeline-message"][data-message-id="abc\\"], script"]'
    );
  });

  it("escapes the backslash that would otherwise eat the closing quote", () => {
    expect(messageIdSelector("abc\\")).toBe(
      '[data-testid="timeline-message"][data-message-id="abc\\\\"]'
    );
  });

  it("keeps a raw newline out of the string, which CSS does not allow", () => {
    expect(messageIdSelector("abc\ndef")).toBe(
      '[data-testid="timeline-message"][data-message-id="abc def"]'
    );
  });
});

describe("workSessionPath", () => {
  // 작업 세션은 라우트가 아니라 채널 표면 안의 패널이라, 링크가 채널과 세션을
  // 함께 말한다. 작업 흐름 상세의 실행 이력 행이 쓰는 열쇠다(MOMO-679 M5).
  it("names the channel and the session the panel should open on", () => {
    expect(
      workSessionPath(
        "00000000-0000-7000-8000-000000000201",
        "019F94E3-0E04-79CD-9DEE-208F47EDD9A8"
      )
    ).toBe(
      "/c/00000000-0000-7000-8000-000000000201?work=019f94e3-0e04-79cd-9dee-208f47edd9a8"
    );
  });
});

describe("watchForMessageId", () => {
  it("scrolls the anchor card into view and expires quietly when it never mounts", () => {
    const row = {
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const found: (() => void)[] = [];
    watchForMessageId("019F94E3-0E04-79CD-9DEE-208F47EDD9A8", {
      doc: {
        querySelector: (selector: string) =>
          selector ===
          '[data-testid="timeline-message"][data-message-id="019f94e3-0e04-79cd-9dee-208f47edd9a8"]'
            ? row
            : null,
      } as unknown as Document,
      now: () => 0,
      schedule: (fn: () => void) => found.push(fn),
      cancel: () => {},
    });
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center" });

    let clock = 0;
    const queued: (() => void)[] = [];
    watchForMessageId("019f94e3-0e04-79cd-9dee-208f47edd9a9", {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => clock,
      schedule: (fn: () => void) => queued.push(fn),
      cancel: () => {},
      watchMs: 100,
    });
    expect(queued).toHaveLength(1);
    clock = 1_000;
    queued[0]();
    expect(queued).toHaveLength(1);
  });
});

describe("watchForMessage", () => {
  function fakeSchedule() {
    const queued: (() => void)[] = [];
    return {
      queued,
      schedule: (fn: () => void) => {
        queued.push(fn);
        return queued.length;
      },
    };
  }

  it("scrolls the row into view as soon as virtuoso has mounted it", () => {
    const row = {
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const { queued, schedule } = fakeSchedule();
    watchForMessage(147, {
      doc: { querySelector: () => row } as unknown as Document,
      now: () => 0,
      schedule,
      cancel: () => {},
    });
    expect(row.scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(row.classList.add).toHaveBeenCalled();
    // The only thing still queued is the highlight teardown.
    expect(queued).toHaveLength(1);
    queued[0]();
    expect(row.classList.remove).toHaveBeenCalled();
  });

  it("gives up quietly once the watch window is spent", () => {
    const { queued, schedule } = fakeSchedule();
    let clock = 0;
    watchForMessage(147, {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => clock,
      schedule,
      cancel: () => {},
      watchMs: 100,
    });
    expect(queued).toHaveLength(1);
    clock = 1_000;
    queued[0]();
    expect(queued).toHaveLength(1);
  });

  // goal B12 R1 High-3: 만료가 조용한 것은 인박스의 기본값으로 남기되, 검색처럼
  // 만료가 흔한 표면이 그 사실을 말할 수 있어야 한다.
  it("만료를 호출자에게 알린다", () => {
    const { queued, schedule } = fakeSchedule();
    const onExpire = vi.fn();
    let clock = 0;
    watchForMessage(147, {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => clock,
      schedule,
      cancel: () => {},
      watchMs: 100,
      onExpire,
    });
    expect(onExpire).not.toHaveBeenCalled();
    clock = 1_000;
    queued[0]();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it("행을 찾으면 만료를 알리지 않는다", () => {
    const row = {
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    };
    const onExpire = vi.fn();
    watchForMessage(147, {
      doc: { querySelector: () => row } as unknown as Document,
      now: () => 0,
      schedule: (fn: () => void) => {
        void fn;
        return 1;
      },
      cancel: () => {},
      onExpire,
    });
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("취소된 감시자는 만료를 알리지 않는다", () => {
    // 채널을 옮겨서 그만둔 것은 실패가 아니다. 그것을 만료로 셈하면 사용자가
    // 떠난 화면에 대해 배너가 뜬다.
    const { queued, schedule } = fakeSchedule();
    const onExpire = vi.fn();
    let clock = 0;
    const stop = watchForMessage(147, {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => clock,
      schedule,
      cancel: () => {},
      watchMs: 100,
      onExpire,
    });
    stop();
    clock = 1_000;
    queued[0]();
    expect(onExpire).not.toHaveBeenCalled();
  });

  it("stops polling when the caller cancels", () => {
    const { queued, schedule } = fakeSchedule();
    const cancel = vi.fn();
    const stop = watchForMessage(147, {
      doc: { querySelector: () => null } as unknown as Document,
      now: () => 0,
      schedule,
      cancel,
      watchMs: 10_000,
    });
    stop();
    expect(cancel).toHaveBeenCalled();
    queued[0]();
    expect(queued).toHaveLength(1);
  });
});
