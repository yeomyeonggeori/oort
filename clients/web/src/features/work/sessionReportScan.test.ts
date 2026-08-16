import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMPLETION_REPORT_KIND } from "@momo/core/features/timeline/completionReportCard";
import type { Message, MessagePage } from "@momo/core/lib/api";

// =============================================================================
// 검증 칩의 read-model — 채널을 최신부터 (#1463).
//
// 앞 판(#1441)은 세션 스레드를 **오래된 쪽부터** 읽어 그 페이지에서 리포트를 건졌다.
// 그 방향이 남긴 두 결함이 이 파일이 재는 것 전부다:
//
//   1. 목록 행은 스레드를 읽지 않으므로 칩이 아예 설 수 없었다(#1441 이탈 D2).
//   2. 5×200 창이 절단하는 것은 정확히 **가장 최근 리포트**라, 1,000행이 넘는
//      세션에서 칩이 영구 부재였다(grok freeze H2). 리포트가 가장 필요한 세션이
//      정확히 그 세션이다.
//
// 그래서 두 층으로 잰다: ①스캔이 실제로 채널을 최신부터, 예산 안에서, 스레드별로
// 접어 오는가(행동 — 진짜 `fetchMessages` 호출을 가로채 인자를 본다) ②절단된 스레드
// 페이지가 판정에 끼어들지 못하는가(합치기 규율).
// =============================================================================

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const ROOT_LONG = "00000000-0000-7000-8000-0000000006a1";
const ROOT_OTHER = "00000000-0000-7000-8000-0000000006a2";
const AUTHOR = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

/** 이 테스트가 가로챈 `fetchMessages` 호출들과, 돌려줄 페이지들. */
const wire = vi.hoisted(() => ({
  calls: [] as Array<{ workspaceId: string; channelId: string; before?: number }>,
  pages: [] as Array<{ messages: unknown[] }>,
}));

vi.mock("@momo/core/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@momo/core/lib/api")>();
  return {
    ...actual,
    fetchMessages: (
      workspaceId: string,
      channelId: string,
      query: { limit?: number; before?: number } = {}
    ): Promise<MessagePage> => {
      wire.calls.push({
        workspaceId,
        channelId,
        ...(query.before === undefined ? {} : { before: query.before }),
      });
      const page = wire.pages.shift() ?? { messages: [] };
      return Promise.resolve(page as MessagePage);
    },
  };
});

const { fetchChannelSessionReports, sessionVerificationFrom } = await import(
  "./useWorkSessions"
);
const { threadCompletionReports } = await import(
  "@momo/core/features/work/sessionVerification"
);

const CLEAN_REPORT = {
  kind: COMPLETION_REPORT_KIND,
  summary: "게이트를 전부 초록으로 맞췄습니다.",
  gates: [
    {
      surface: "웹",
      checks: [
        { label: "테스트", outcome: "pass" },
        { label: "린트", outcome: "pass" },
      ],
    },
  ],
};

const FAILING_REPORT = {
  kind: COMPLETION_REPORT_KIND,
  summary: "환불 회귀 하나가 아직 빨갛습니다.",
  gates: [
    {
      surface: "엔진",
      checks: [
        { label: "빌드", outcome: "pass" },
        { label: "테스트", outcome: "failed" },
      ],
    },
  ],
};

function message(
  seq: number,
  rootId: string,
  props: Record<string, unknown>
): Message {
  return {
    id: `00000000-0000-7000-8000-${seq.toString().padStart(12, "0")}`,
    channelId: CHANNEL,
    rootId,
    seq,
    hlcTs: 1_760_000_000_000 + seq,
    hlcCount: 0,
    authorMemberId: AUTHOR,
    type: "text",
    body: "작업을 마쳤습니다.",
    createdAtMs: 1_760_000_000_000 + seq,
    props,
  };
}

/** ACP 이벤트 한 줄 — 스레드의 대다수이고 검증에 대해 아무 말도 하지 않는다. */
function noise(seq: number, rootId: string): Message {
  return message(seq, rootId, {
    kind: "work_session_event",
    schema: "momo.work_session.acp_event.v1",
    event_type: "agent.status",
    event_id: `e-${seq}`,
    event_ts: 1_760_000_000_000 + seq,
    event: {},
  });
}

/**
 * 서버 히스토리 페이지: 최신부터(seq 내림차순) + `nextBefore`.
 *
 * `nextBefore` 는 **이 페이지의 가장 작은 seq** 다 — 마지막 페이지에도 값이 있으므로
 * 「더 있는가」의 답이 아니다(routes::messages::history). 그 구분이 스캔의 종료
 * 조건이라, 픽스처가 그 모양을 그대로 흉내 내야 한다.
 */
function historyPage(messages: Message[]) {
  const sorted = [...messages].sort((a, b) => b.seq - a.seq);
  const nextBefore = sorted[sorted.length - 1]?.seq;
  return {
    messages: sorted,
    ...(nextBefore === undefined ? {} : { nextBefore }),
  };
}

/** `nextBefore` 를 싣지 않는 서버(옛 판)를 흉내 낸 페이지. */
function historyPageWithoutCursor(messages: Message[]) {
  return { messages: [...messages].sort((a, b) => b.seq - a.seq) };
}

beforeEach(() => {
  wire.calls.length = 0;
  wire.pages.length = 0;
});

describe("스캔은 채널을 최신부터, 세션 수와 무관한 왕복으로 읽는다", () => {
  it("첫 페이지가 짧으면 거기서 멈춘다 — 조용한 채널의 왕복은 1회", async () => {
    wire.pages.push(historyPage([message(10, ROOT_LONG, CLEAN_REPORT)]));
    const found = await fetchChannelSessionReports(WORKSPACE, CHANNEL);
    expect(wire.calls).toHaveLength(1);
    expect(wire.calls[0]?.before).toBeUndefined();
    expect(found).toHaveLength(1);
  });

  it("한 페이지에서 세션 셋의 칩이 함께 나온다 — 세션마다 /replies 를 열지 않는다", async () => {
    // 이것이 D2 의 답이다: 목록에 세션이 몇 개든 이 채널의 읽기는 하나다.
    wire.pages.push(
      historyPage([
        noise(30, ROOT_LONG),
        message(31, ROOT_LONG, CLEAN_REPORT),
        message(32, ROOT_OTHER, FAILING_REPORT),
      ])
    );
    const found = await fetchChannelSessionReports(WORKSPACE, CHANNEL);
    expect(wire.calls).toHaveLength(1);
    expect(
      sessionVerificationFrom(found, ROOT_LONG)?.lead
    ).toBe("pass");
    expect(
      sessionVerificationFrom(found, ROOT_OTHER)?.lead
    ).toBe("fail");
  });

  it("가득 찬 페이지에서는 더 오래된 쪽으로 한 번 더 간다 — 그리고 거기서 멈춘다", async () => {
    // 예산은 채널당 2페이지다. 세 번째 요청이 나가면 「채널당 최대 2페이지」라는
    // 왕복 계약이 깨진 것이고, 그 숫자가 이 read-model 결정의 절반이다.
    const full = Array.from({ length: 200 }, (_, i) => noise(1_000 - i, ROOT_LONG));
    wire.pages.push(historyPage(full));
    wire.pages.push(
      historyPage([
        ...Array.from({ length: 199 }, (_, i) => noise(800 - i, ROOT_LONG)),
        message(700, ROOT_LONG, FAILING_REPORT),
      ])
    );
    wire.pages.push(historyPage([message(10, ROOT_OTHER, CLEAN_REPORT)]));
    const found = await fetchChannelSessionReports(WORKSPACE, CHANNEL);
    expect(wire.calls).toHaveLength(2);
    // 두 번째 요청은 첫 페이지의 **가장 오래된** seq 앞을 물었다.
    expect(wire.calls[1]?.before).toBe(801);
    expect(sessionVerificationFrom(found, ROOT_LONG)?.lead).toBe("fail");
    // 예산 밖의 세션은 칩이 서지 않는다 — 「미검증」이 아니라 부재.
    expect(sessionVerificationFrom(found, ROOT_OTHER)).toBeNull();
  });

  it("`nextBefore` 가 없는 응답에서도 커서를 잃지 않는다", () => {
    // 그 키는 「더 있는가」의 답이 아니라 이 페이지의 최솟값이라, 없으면 페이지에서
    // 직접 재야 한다. 위치가 아니라 최솟값인 것은 정렬을 계약으로 삼지 않기 위해서다.
    const full = Array.from({ length: 200 }, (_, i) => noise(1_000 - i, ROOT_LONG));
    wire.pages.push(historyPageWithoutCursor(full));
    wire.pages.push(historyPage([message(700, ROOT_LONG, CLEAN_REPORT)]));
    return fetchChannelSessionReports(WORKSPACE, CHANNEL).then((found) => {
      expect(wire.calls[1]?.before).toBe(801);
      expect(sessionVerificationFrom(found, ROOT_LONG)?.lead).toBe("pass");
    });
  });

  it("먼저 만난(더 최신) 리포트가 뒤 페이지의 오래된 것에 덮이지 않는다", async () => {
    const full = [
      message(1_000, ROOT_LONG, CLEAN_REPORT),
      ...Array.from({ length: 199 }, (_, i) => noise(999 - i, ROOT_LONG)),
    ];
    wire.pages.push(historyPage(full));
    wire.pages.push(historyPage([message(500, ROOT_LONG, FAILING_REPORT)]));
    const found = await fetchChannelSessionReports(WORKSPACE, CHANNEL);
    expect(found).toHaveLength(1);
    expect(found[0]?.seq).toBe(1_000);
    expect(sessionVerificationFrom(found, ROOT_LONG)?.lead).toBe("pass");
  });
});

describe("장스레드에서도 최신 리포트에 닿는다 (grok H2)", () => {
  it("절단된 스레드 읽기가 리포트를 하나도 못 건져도 칩이 선다", async () => {
    // 실제 병리: 1,000행이 넘는 세션. `/replies` 는 오래된 쪽부터 5×200을 읽고
    // 절단되며, 그 창 안에는 ACP 이벤트뿐이다(리포트는 스레드 맨 끝에 있다).
    const threadHead = {
      events: [],
      truncated: true,
      reports: [],
    };
    // RED PROOF: 앞 판의 판정은 `truncated → null` 이었고, 그것이 전부였다.
    expect(sessionVerificationFrom(undefined, ROOT_LONG, threadHead)).toBeNull();

    // 같은 세션을 채널 최신부터 훑으면 리포트가 첫 페이지에 있다.
    wire.pages.push(
      historyPage([
        message(12_400, ROOT_LONG, FAILING_REPORT),
        noise(12_399, ROOT_LONG),
      ])
    );
    const found = await fetchChannelSessionReports(WORKSPACE, CHANNEL);
    const verdict = sessionVerificationFrom(found, ROOT_LONG, threadHead);
    expect(verdict?.lead).toBe("fail");
    expect(verdict?.leadCount).toBe(1);
  });

  it("절단된 스레드 페이지의 리포트는 판정에 끼어들지 못한다", async () => {
    // 절단된 읽기가 손에 쥔 리포트는 스레드의 **머리** 쪽 것이라 지난 이야기다.
    // 스캔이 최신을 들고 있으면 그쪽이 이기고, 스캔이 없으면 침묵이 옳다.
    const stale = threadCompletionReports([
      message(12, ROOT_LONG, FAILING_REPORT),
    ]);
    const truncatedPage = {
      events: [],
      truncated: true,
      reports: stale,
    };
    expect(sessionVerificationFrom(undefined, ROOT_LONG, truncatedPage)).toBeNull();

    const scanned = threadCompletionReports([
      message(9_000, ROOT_LONG, CLEAN_REPORT),
    ]);
    expect(sessionVerificationFrom(scanned, ROOT_LONG, truncatedPage)?.lead).toBe(
      "pass"
    );
  });

  it("절단되지 않은 스레드 읽기는 여전히 발언권이 있다 — 스캔 예산 밖의 세션을 위해", () => {
    // 스캔이 못 닿은 세션이라도 그 스레드를 통째로 읽은 표면(미리보기·상세)은
    // 최신 리포트를 실제로 봤다. 그 자리에서까지 침묵하면 앞 판보다 후퇴다.
    const wholeThread = {
      events: [],
      truncated: false,
      reports: threadCompletionReports([
        message(40, ROOT_LONG, CLEAN_REPORT),
        message(41, ROOT_LONG, FAILING_REPORT),
      ]),
    };
    expect(sessionVerificationFrom(undefined, ROOT_LONG, wholeThread)?.lead).toBe(
      "fail"
    );
  });

  it("두 원천 중 더 최신인 것이 이긴다", () => {
    const scanned = threadCompletionReports([
      message(9_000, ROOT_LONG, CLEAN_REPORT),
    ]);
    const wholeThread = {
      events: [],
      truncated: false,
      reports: threadCompletionReports([
        message(8_999, ROOT_LONG, FAILING_REPORT),
      ]),
    };
    expect(sessionVerificationFrom(scanned, ROOT_LONG, wholeThread)?.lead).toBe(
      "pass"
    );
  });
});

describe("그 스캔이 필요한 자리마다 무효화가 배선돼 있다", () => {
  const source = readFileSync(
    new URL("./useWorkSessions.ts", import.meta.url),
    "utf8"
  );

  it("꼬리를 버리는 두 분기와 재동기화가 리포트 스캔도 다시 읽는다", () => {
    // G-H1 이 스레드에 대해 고친 그 결함이, 원천만 바뀐 채 돌아오지 않게. 리포트는
    // 세션이 끝나는 바로 그 순간 떨어지고, 이제 그것을 나르는 읽기는 스캔이다.
    for (const frameType of ["work.session.ended", "work.session.idle"]) {
      const branch = source.slice(source.indexOf(`frame.type === "${frameType}"`));
      const body = branch.slice(0, branch.indexOf("refetchSessionsAfterTransition"));
      expect(
        body.includes("invalidateSessionReports(queryClient)"),
        `${frameType} 이 꼬리를 버리고도 리포트 스캔을 다시 읽지 않는다`
      ).toBe(true);
    }
    expect(
      source.split("invalidateSessionReports(queryClient)").length - 1
    ).toBeGreaterThanOrEqual(3);
  });

  it("목록 행은 스레드를 열지 않는다 — 스캔만으로 칩을 세운다", () => {
    const panel = readFileSync(
      new URL("./WorkPanel.tsx", import.meta.url),
      "utf8"
    );
    const row = panel.slice(
      panel.indexOf("function SessionRow({"),
      panel.indexOf("function MySessionRow({")
    );
    expect(row).toContain("useSessionVerification(workspaceId, session)");
    // 스레드 읽기는 미리보기가 열릴 때만 일어난다(`SessionPeek`). 행에서 그것을
    // 부르면 목록 하나가 세션 수만큼의 `/replies` 를 연다.
    expect(row).not.toContain("useSessionEvents");
  });
});
