import { describe, expect, it, vi } from "vitest";
import {
  anchorMissKind,
  channelPath,
  messageAnchorPath,
  messageShareUrl,
  foldedStandInSelector,
  messageIdSelector,
  messageSelector,
  oldestLoadedSeq,
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

describe("messageShareUrl", () => {
  const CHANNEL = "00000000-0000-7000-8000-000000000201";
  const MESSAGE = "019F94E3-0E04-79CD-9DEE-208F47EDD9A8";

  it("남에게 건넬 주소는 서버 base를 쓰고 msg와 seq를 함께 싣는다", () => {
    expect(
      messageShareUrl(CHANNEL, MESSAGE, 147, {
        origin: "https://app.oor7.com",
        pathname: "/",
      })
    ).toBe(
      "https://app.oor7.com/#/c/00000000-0000-7000-8000-000000000201?msg=019f94e3-0e04-79cd-9dee-208f47edd9a8&seq=147"
    );
  });

  it("Tauri 번들 origin은 건네지 않는다", () => {
    const page = { origin: "tauri://localhost", pathname: "/" };
    const handed = messageShareUrl(CHANNEL, MESSAGE, 147, {
      origin: "https://app.oor7.com",
      pathname: page.pathname,
    });
    expect(handed).toBe(
      "https://app.oor7.com/#/c/00000000-0000-7000-8000-000000000201?msg=019f94e3-0e04-79cd-9dee-208f47edd9a8&seq=147"
    );
    expect(handed).not.toContain("tauri://");
  });

  it("실경로 쿼리는 싣지 않는다. 캡처 심이 공유 링크를 오염시키면 안 된다", () => {
    const url = messageShareUrl(CHANNEL, MESSAGE, 812, {
      origin: "http://127.0.0.1:5178",
      pathname: "/",
    });
    expect(url).not.toContain("agentwork");
    expect(url.startsWith("http://127.0.0.1:5178/#/c/")).toBe(true);
    expect(url).toContain("seq=812");
  });
});

describe("anchorMissKind", () => {
  it("seq가 로드된 머리보다 오래면 older다", () => {
    expect(anchorMissKind(50, 100)).toBe("older");
    expect(anchorMissKind(99, oldestLoadedSeq([{ seq: 100 }, { seq: 140 }]))).toBe(
      "older"
    );
  });

  it("seq가 없으면 unknown이다", () => {
    expect(anchorMissKind(null, 100)).toBe("unknown");
    expect(anchorMissKind(Number.NaN, 100)).toBe("unknown");
  });

  it("seq는 있는데 창 안에 있으면 unknown이다 — 없거나 지워진 것이다", () => {
    expect(anchorMissKind(120, 100)).toBe("unknown");
    expect(anchorMissKind(100, 100)).toBe("unknown");
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

// ---------------------------------------------------------------------------
// 대리 착지 — 접힌 묘비를 겨눈 점프 (design-review U4-5 H-1 · 이슈 1105)
//
// 삭제 원본을 가리킨 인용은 점프 가능한데, 그 원본이 연속 묘비 묶음에 접히면 그
// 행은 DOM에 없다. 그 자리에서 「위로 올려 더 불러오세요」는 **거짓 지시**다 —
// 이미 로드돼 있고 접혀 있을 뿐이다.
// ---------------------------------------------------------------------------

describe("foldedStandInSelector", () => {
  it("공백으로 이은 목록에서 낱개를 고른다", () => {
    expect(foldedStandInSelector("019F94E3-0E04-79CD-9DEE-208F47EDD9A8")).toBe(
      '[data-testid="timeline-message"]' +
        '[data-deleted-folded-ids~="019f94e3-0e04-79cd-9dee-208f47edd9a8"]'
    );
  });

  it("자기 행 선택자와 다른 속성을 본다", () => {
    const id = "019f94e3-0e04-79cd-9dee-208f47edd9a8";
    expect(foldedStandInSelector(id)).not.toBe(messageIdSelector(id));
  });

  it("따옴표를 이스케이프한다: 주소창에서 온 값이 선택자를 깨지 못한다", () => {
    expect(foldedStandInSelector('abc"], script')).toBe(
      '[data-testid="timeline-message"]' +
        '[data-deleted-folded-ids~="abc\\"], script"]'
    );
  });
});

describe("watchForMessageId: 두 자리를 이 순서로 본다", () => {
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

  function row(name: string) {
    return {
      name,
      scrollIntoView: vi.fn(),
      classList: { add: vi.fn(), remove: vi.fn() },
    };
  }

  function docThatAnswers(hits: Record<string, ReturnType<typeof row>>) {
    return {
      querySelector: (selector: string) => hits[selector] ?? null,
    } as unknown as Document;
  }

  const ID = "019f94e3-0e04-79cd-9dee-208f47edd9a8";

  it("자기 행이 있으면 거기 선다", () => {
    const own = row("own");
    const standIn = row("stand-in");
    watchForMessageId(ID, {
      doc: docThatAnswers({
        [messageIdSelector(ID)]: own,
        [foldedStandInSelector(ID)]: standIn,
      }),
      now: () => 0,
      schedule: () => 1,
      cancel: () => {},
    });
    expect(own.scrollIntoView).toHaveBeenCalled();
    expect(standIn.scrollIntoView).not.toHaveBeenCalled();
  });

  it("자기 행이 접혀 없으면 대신 서 있는 행에 착지한다", () => {
    const standIn = row("stand-in");
    const onExpire = vi.fn();
    watchForMessageId(ID, {
      doc: docThatAnswers({ [foldedStandInSelector(ID)]: standIn }),
      now: () => 0,
      schedule: () => 1,
      cancel: () => {},
      onExpire,
    });
    expect(standIn.scrollIntoView).toHaveBeenCalled();
    expect(onExpire).not.toHaveBeenCalled();
  });

  /**
   * **진짜 없는 것은 여전히 없다** (이슈 1105의 네 번째 red proof).
   *
   * 대리 착지가 「못 찾으면 아무거나」로 넓어지면, 아직 불러오지도 않은 옛 메시지를
   * 가리킨 인용이 엉뚱한 묘비에 착지하고 화면은 그것을 원본이라고 말한다 — 고친
   * 거짓 지시가 방향만 바꿔 돌아오는 것이다.
   */
  it("어느 쪽도 없으면 만료가 그대로 온다", () => {
    const { queued, schedule } = fakeSchedule();
    const onExpire = vi.fn();
    let clock = 0;
    watchForMessageId(ID, {
      doc: docThatAnswers({}),
      now: () => clock,
      schedule,
      cancel: () => {},
      watchMs: 100,
      onExpire,
    });
    clock = 1_000;
    queued[0]();
    expect(onExpire).toHaveBeenCalledTimes(1);
  });
});
