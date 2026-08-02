import { beforeEach, describe, expect, it } from "vitest";
import { formatMicroUsd } from "@momo/core/features/timeline/agentCardModel";
import fixtures from "./usageFixtures.json";
import {
  USAGE_BUCKETS,
  USAGE_PERIODS,
  agentRowLabel,
  barShare,
  bucketUnitLabel,
  budgetGrainLabel,
  budgetStatus,
  costConfidence,
  forgetUsage,
  formatBucketStart,
  formatClock,
  formatIsoDay,
  formatRange,
  isEmptyUsage,
  largestCost,
  modelRowLabel,
  parseUsageSummary,
  peakBucket,
  percentOf,
  recallUsage,
  rememberUsage,
  usageAnnouncement,
  usageErrorCopy,
  usageQuery,
  usageView,
  type UsageScope,
  type UsageSummary,
} from "@momo/core/features/settings/usageModel";

// The three fixtures are the contract shapes the engine ticket (MOMO-615) is
// implementing in parallel: a populated range, an empty range (200 with zeros,
// not a 404), and a workspace sitting on its hard limit. They live in
// usageFixtures.json so scripts/capture-usage.mjs renders the exact same bytes
// these assertions are written against.

const normal = parseUsageSummary(fixtures.normal);
const emptyPeriod = parseUsageSummary(fixtures.emptyPeriod);
const hardLimit = parseUsageSummary(fixtures.budgetHardLimit);

describe("parseUsageSummary (계약 v1)", () => {
  it("reads the populated fixture whole", () => {
    expect(normal.range).toEqual({
      from: "2026-06-25T00:00:00Z",
      to: "2026-07-25T00:00:00Z",
      bucket: "day",
    });
    expect(normal.totals.costMicroUsd).toBe(18_432_500);
    expect(normal.totals.estimatedMicroUsd).toBe(2_140_000);
    expect(normal.buckets).toHaveLength(10);
    expect(normal.byModel.map((m) => m.model)).toEqual([
      "claude-opus-5",
      "gpt-5.6-sol",
      "claude-haiku-4.5",
    ]);
    expect(normal.byAgent).toHaveLength(2);
    expect(normal.budget?.state).toBe("normal");
  });

  it("lower-cases agent UUIDs, because the server sends them upper-cased", () => {
    expect(normal.byAgent[0].agentMemberId).toBe(
      "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90"
    );
    expect(normal.byAgent.every((a) => a.agentMemberId === a.agentMemberId.toLowerCase())).toBe(
      true
    );
  });

  it("keeps an empty range as zeros and a null budget, never as an error", () => {
    expect(emptyPeriod.totals.costMicroUsd).toBe(0);
    expect(emptyPeriod.byModel).toEqual([]);
    expect(emptyPeriod.byAgent).toEqual([]);
    expect(emptyPeriod.budget).toBeNull();
    expect(isEmptyUsage(emptyPeriod)).toBe(true);
    expect(isEmptyUsage(normal)).toBe(false);
  });

  it("tolerates missing lists and fields rather than blanking the panel", () => {
    const sparse = parseUsageSummary({ range: { bucket: "week" } });
    expect(sparse.range.bucket).toBe("week");
    expect(sparse.totals.costMicroUsd).toBe(0);
    expect(sparse.buckets).toEqual([]);
    expect(sparse.budget).toBeNull();
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseUsageSummary(null)).toThrow();
    expect(() => parseUsageSummary("nope")).toThrow();
    expect(() => parseUsageSummary([1, 2])).toThrow();
  });

  it("falls back to day for an unknown bucket and normal for an unknown state", () => {
    const odd = parseUsageSummary({
      range: { from: "", to: "", bucket: "fortnight" },
      budget: { state: "über" },
    });
    expect(odd.range.bucket).toBe("day");
    expect(odd.budget?.state).toBe("normal");
  });
});

describe("usageQuery", () => {
  const NOW = Date.parse("2026-07-25T09:00:00Z");

  it("asks for the selected window and bucket", () => {
    expect(usageQuery("7d", "day", NOW)).toEqual({
      from: "2026-07-18T09:00:00.000Z",
      to: "2026-07-25T09:00:00.000Z",
      bucket: "day",
    });
    expect(usageQuery("30d", "week", NOW).from).toBe("2026-06-25T09:00:00.000Z");
  });

  it("stays far inside the contract ceiling of 93 days", () => {
    for (const period of USAGE_PERIODS) expect(period.days).toBeLessThanOrEqual(93);
  });
});

describe("cost confidence (추정치 분리 표기)", () => {
  it("splits the total into settled and estimated, never adding them", () => {
    const split = costConfidence(normal.totals);
    expect(split.estimatedMicroUsd).toBe(2_140_000);
    expect(split.settledMicroUsd).toBe(16_292_500);
    expect(split.settledMicroUsd + split.estimatedMicroUsd).toBe(
      normal.totals.costMicroUsd
    );
    expect(split.estimatedPercent).toBe(11);
    expect(split.allSettled).toBe(false);
  });

  it("reports a fully reconciled range as settled", () => {
    const split = costConfidence(hardLimit.totals);
    expect(split.allSettled).toBe(true);
    expect(split.settledMicroUsd).toBe(9_420_000);
    expect(split.estimatedPercent).toBe(0);
  });

  it("never renders a negative charge when the estimate exceeds the total", () => {
    const split = costConfidence({
      costMicroUsd: 1_000,
      estimatedMicroUsd: 5_000,
      promptTokens: 0,
      completionTokens: 0,
    });
    expect(split.settledMicroUsd).toBe(0);
  });

  it("formats cost with the shared formatter, so $0.001 never rounds to $0", () => {
    expect(formatMicroUsd(normal.totals.costMicroUsd)).toBe("$18.43");
    expect(formatMicroUsd(0)).toBe("$0");
  });
});

describe("breakdown bars", () => {
  it("scales each row against the largest row, not the total", () => {
    const max = largestCost(normal.byModel);
    expect(max).toBe(12_100_000);
    expect(barShare(12_100_000, max)).toBe(100);
    expect(barShare(4_832_500, max)).toBe(40);
    expect(barShare(1_500_000, max)).toBe(12);
  });

  it("keeps a nonzero row visible and a zero row empty", () => {
    expect(barShare(1, 10_000_000)).toBe(1);
    expect(barShare(0, 10_000_000)).toBe(0);
    expect(barShare(5, 0)).toBe(0);
  });

  it("finds the most expensive bucket, not the last one", () => {
    const peak = peakBucket(normal.buckets);
    expect(peak?.start).toBe("2026-07-21T00:00:00Z");
    expect(peak?.costMicroUsd).toBe(3_420_000);
    expect(peakBucket(emptyPeriod.buckets)).toBeNull();
    expect(peakBucket([{ start: "x", costMicroUsd: 0, promptTokens: 0, completionTokens: 0 }])).toBeNull();
  });
});

describe("budget", () => {
  it("reads normal state against spent plus reserved", () => {
    const status = budgetStatus(normal.budget!, formatMicroUsd);
    expect(status.tone).toBe("ok");
    expect(status.label).toBe("한도 안");
    expect(status.observedMicroUsd).toBe(19_682_500);
    expect(status.usedPercent).toBe(39);
    expect(status.detail).toBe(
      "한도 $50.00 중 예약을 포함한 사용액이 $19.68입니다."
    );
  });

  it("names the figure the same way in every state, because it is one figure", () => {
    // $19.68 is spent + reserved, and the rows under this line split it back
    // into 사용 $18.43 and 예약 $1.25. Two of the three states used to call it
    // "썼습니다", which put a third number on the card that reconciled with
    // neither of the other two.
    for (const state of ["normal", "soft_limit", "hard_limit"] as const) {
      const status = budgetStatus(
        { ...normal.budget!, state },
        formatMicroUsd
      );
      expect(status.detail).toContain("예약을 포함한 사용액");
      expect(status.detail).toContain("$19.68");
    }
  });

  it("states the hard limit without claiming the server blocks anything", () => {
    const status = budgetStatus(hardLimit.budget!, formatMicroUsd);
    expect(status.tone).toBe("danger");
    expect(status.label).toBe("한도 도달");
    expect(status.observedMicroUsd).toBe(50_200_000);
    expect(status.usedPercent).toBe(100);
    expect(status.detail).toContain("예산을 다시 정하거나");
    expect(status.detail).not.toContain("막힙니다");
  });

  it("marks the soft limit as 주의, not as a failure", () => {
    const status = budgetStatus(
      { ...normal.budget!, state: "soft_limit", spentMicroUsd: 41_000_000 },
      formatMicroUsd
    );
    expect(status.tone).toBe("warn");
    expect(status.label).toBe("주의");
  });

  it("fills the bar when the limit is zero and anything at all was observed", () => {
    // A limit of 0 is a value the server can send. percentOf answers 0 for it
    // (no whole to take a share of), which drew an EMPTY danger bar next to a
    // red 한도 도달 chip: the bar and the chip telling opposite stories, which
    // is exactly what the tone rule exists to stop.
    const zero = {
      ...hardLimit.budget!,
      limitMicroUsd: 0,
      spentMicroUsd: 50_200_000,
      reservedMicroUsd: 0,
    };
    const status = budgetStatus(zero, formatMicroUsd);
    expect(status.tone).toBe("danger");
    expect(status.usedPercent).toBe(100);
    // Nothing spent against a zero limit is not "full", it is untouched.
    expect(
      budgetStatus(
        { ...zero, spentMicroUsd: 0, state: "normal" },
        formatMicroUsd
      ).usedPercent
    ).toBe(0);
  });

  it("names the grain in Korean and passes an unknown grain through", () => {
    expect(budgetGrainLabel("workspace")).toBe("워크스페이스 전체");
    expect(budgetGrainLabel("agent_channel")).toBe("에이전트와 채널별");
    expect(budgetGrainLabel("team_quarter")).toBe("team_quarter");
  });
});

describe("formatting", () => {
  it("renders a range as two local days plus the bucket unit", () => {
    expect(formatRange(normal.range)).toBe("2026-06-25 ~ 2026-07-25 · 일별");
    expect(formatRange({ ...normal.range, bucket: "week" })).toContain("주별");
  });

  it("labels a month-grained answer as 월별, not as the default", () => {
    // The panel only ever asks for day or week, but the contract lets the
    // server answer with month, and parseBucketUnit keeps it. A range line
    // reading 일별 above a "가장 비쌌던 달" row is the card contradicting itself.
    expect(bucketUnitLabel("month")).toBe("월별");
    expect(formatRange({ ...normal.range, bucket: "month" })).toBe(
      "2026-06-25 ~ 2026-07-25 · 월별"
    );
    expect(USAGE_BUCKETS.map((b) => b.id)).toEqual(["day", "week"]);
  });

  it("labels a bucket at the grain it covers", () => {
    expect(formatBucketStart("2026-07-21T00:00:00Z", "day")).toBe("2026-07-21");
    expect(formatBucketStart("2026-07-21T00:00:00Z", "week")).toBe("2026-07-21 주");
    expect(formatBucketStart("2026-07-01T00:00:00Z", "month")).toBe("2026-07");
  });

  it("returns unparseable input untouched instead of Invalid Date", () => {
    expect(formatIsoDay("not-a-date")).toBe("not-a-date");
  });

  it("floors percentages so a remainder never rounds up to a full share", () => {
    expect(percentOf(999, 1000)).toBe(99);
    expect(percentOf(1, 0)).toBe(0);
  });

  it("stamps the last-known instant absolutely, not relatively", () => {
    // Nothing re-renders this panel on a timer, so "3분 전" would freeze at
    // whatever it said when the read failed and start lying about its own age.
    const at = new Date(2026, 6, 25, 23, 7).getTime();
    expect(formatClock(at)).toBe("2026-07-25 23:07");
  });
});

describe("failure copy", () => {
  it("turns the pre-engine 404 into a sentence with a next step", () => {
    expect(usageErrorCopy(404, "HTTP 404")).toBe(
      "이 서버는 아직 사용량 집계를 제공하지 않습니다. 서버를 업데이트한 뒤 다시 열어보세요."
    );
  });

  it("points a rejected range back at the control that sets it", () => {
    expect(usageErrorCopy(400, "HTTP 400")).toContain("기간을 좁혀");
  });

  it("keeps the server's own message for everything else", () => {
    expect(usageErrorCopy(503, "집계 중입니다.")).toBe("집계 중입니다.");
    expect(usageErrorCopy(null, "서버에 닿지 못했습니다.")).toBe(
      "서버에 닿지 못했습니다."
    );
  });
});

describe("마지막 확인값 폴백 (P15 내구층)", () => {
  const WS = "00000000-0000-7000-8000-000000000001";
  const NOW = Date.parse("2026-07-25T09:00:00Z");
  const CHECKED = NOW - 180_000;
  const CHECKED_CLOCK = formatClock(CHECKED);
  const W30: UsageScope = { period: "30d", bucket: "day" };
  const W7: UsageScope = { period: "7d", bucket: "day" };

  beforeEach(() => forgetUsage());

  it("recalls a remembered summary case-insensitively by workspace id", () => {
    rememberUsage(WS.toUpperCase(), W30, normal, CHECKED);
    expect(recallUsage(WS, W30)?.summary.totals.costMicroUsd).toBe(18_432_500);
    expect(recallUsage(WS, W30)?.checkedAtMs).toBe(CHECKED);
  });

  it("files an answer under the window it covers, not under the workspace", () => {
    // The whole point: 30일 was confirmed, 7일 never was. A 7일 read that fails
    // must not be answered with the 30일 total while the 7일 segment is lit.
    rememberUsage(WS, W30, normal, CHECKED);
    expect(recallUsage(WS, W7)).toBeNull();
    expect(recallUsage(WS, { period: "30d", bucket: "week" })).toBeNull();
    expect(recallUsage(WS, W30)?.summary.totals.costMicroUsd).toBe(18_432_500);
  });

  it("keeps each window's own answer side by side", () => {
    rememberUsage(WS, W30, normal, CHECKED);
    rememberUsage(WS, W7, emptyPeriod, CHECKED);
    expect(recallUsage(WS, W30)?.summary.totals.costMicroUsd).toBe(18_432_500);
    expect(recallUsage(WS, W7)?.summary.totals.costMicroUsd).toBe(0);
  });

  it("forgets every window of a workspace, and everything on sign-out", () => {
    rememberUsage(WS, W30, normal, CHECKED);
    rememberUsage(WS, W7, normal, CHECKED);
    forgetUsage(WS.toUpperCase());
    expect(recallUsage(WS, W30)).toBeNull();
    expect(recallUsage(WS, W7)).toBeNull();

    rememberUsage(WS, W30, normal, CHECKED);
    forgetUsage();
    expect(recallUsage(WS, W30)).toBeNull();
  });

  function view(over: Partial<Parameters<typeof usageView>[0]> = {}) {
    return usageView({
      data: null,
      dataUpdatedAtMs: 0,
      errorMessage: null,
      paused: false,
      lastKnown: null,
      ...over,
    });
  }

  it("prefers fresh data over anything cached", () => {
    const state = view({
      data: normal,
      dataUpdatedAtMs: NOW,
      lastKnown: { summary: emptyPeriod, checkedAtMs: CHECKED },
    });
    expect(state.kind).toBe("ready");
    expect(state.kind === "ready" && state.summary.totals.costMicroUsd).toBe(
      18_432_500
    );
  });

  it("labels data that survived a failed refresh instead of passing it off as live", () => {
    const state = view({
      data: normal,
      dataUpdatedAtMs: CHECKED,
      errorMessage: "서버에 닿지 못했습니다.",
    });
    expect(state.kind).toBe("last-known");
    if (state.kind !== "last-known") throw new Error("expected last-known");
    expect(state.checkedAtMs).toBe(CHECKED);
    expect(state.notice).toContain(`${CHECKED_CLOCK}에 확인한 값을 표시합니다.`);
  });

  it("shows the last confirmed answer with its age when the read fails", () => {
    const state = view({
      errorMessage: "서버가 15초 안에 응답하지 않았습니다.",
      lastKnown: { summary: normal, checkedAtMs: CHECKED },
    });
    expect(state.kind).toBe("last-known");
    if (state.kind !== "last-known") throw new Error("expected last-known");
    // One line, one statement of when: the panel used to repeat the same fact
    // on a second line, once relative and once absolute.
    expect(state.notice).toBe(
      `서버가 15초 안에 응답하지 않았습니다. ${CHECKED_CLOCK}에 확인한 값을 표시합니다.`
    );
    expect(state.checkedAtMs).toBe(CHECKED);
    expect(state.summary.totals.costMicroUsd).toBe(18_432_500);
  });

  it("says what happened with nothing to fall back on", () => {
    const state = view({ errorMessage: "요청을 끝내지 못했습니다." });
    expect(state).toEqual({ kind: "error", message: "요청을 끝내지 못했습니다." });
  });

  // `paused` is react-query's own fetchStatus for "the browser is offline, so
  // the request was never sent". It is the state the panel can actually reach:
  // a paused query stays pending and never errors, so it has to be answered
  // before the loading branch or the bars would never resolve.
  it("keeps the cached range rendering while the browser is offline, undimmed", () => {
    const state = view({
      paused: true,
      lastKnown: { summary: normal, checkedAtMs: CHECKED },
    });
    expect(state.kind).toBe("last-known");
    expect(state.kind === "last-known" && state.notice).toContain("연결이 끊겼습니다.");
  });

  it("states the offline case plainly when there is no cached answer", () => {
    const state = view({ paused: true });
    expect(state).toEqual({
      kind: "error",
      message: "연결이 끊겼습니다. 다시 연결되면 사용량을 불러옵니다.",
    });
  });

  it("labels data already on screen when the next read cannot be sent", () => {
    const state = view({ data: normal, dataUpdatedAtMs: CHECKED, paused: true });
    expect(state.kind).toBe("last-known");
    expect(state.kind === "last-known" && state.notice).toContain(
      "연결이 끊겼습니다."
    );
  });

  it("shows bars, not the previous range's numbers, while a new range loads", () => {
    const state = view({
      lastKnown: { summary: normal, checkedAtMs: CHECKED },
    });
    expect(state).toEqual({ kind: "loading" });
  });

  it("carries the empty flag through the cached path too", () => {
    const state = view({
      errorMessage: "요청을 끝내지 못했습니다.",
      lastKnown: { summary: emptyPeriod, checkedAtMs: CHECKED },
    });
    expect(state.kind === "last-known" && state.empty).toBe(true);
  });

  it("round-trips a remembered summary through the view without reshaping it", () => {
    rememberUsage(WS, W30, hardLimit, CHECKED);
    const cached = recallUsage(WS, W30);
    const state = view({ errorMessage: "끊겼습니다.", lastKnown: cached });
    const summary: UsageSummary | undefined =
      state.kind === "last-known" ? state.summary : undefined;
    expect(summary?.budget?.state).toBe("hard_limit");
  });

  describe("live region copy", () => {
    it("announces the wait and then the number", () => {
      expect(usageAnnouncement({ kind: "loading" }, formatMicroUsd)).toBe(
        "사용량을 불러오는 중입니다."
      );
      expect(
        usageAnnouncement(
          { kind: "ready", summary: normal, empty: false },
          formatMicroUsd
        )
      ).toBe("사용량 합계 $18.43을 불러왔습니다.");
      expect(
        usageAnnouncement(
          { kind: "ready", summary: emptyPeriod, empty: true },
          formatMicroUsd
        )
      ).toBe("이 기간에 기록된 사용량이 없습니다.");
    });

    it("stays silent where a banner is already a live region", () => {
      expect(
        usageAnnouncement({ kind: "error", message: "끊겼습니다." }, formatMicroUsd)
      ).toBe("");
      expect(
        usageAnnouncement(
          {
            kind: "last-known",
            summary: normal,
            empty: false,
            notice: "끊겼습니다.",
            checkedAtMs: CHECKED,
          },
          formatMicroUsd
        )
      ).toBe("");
    });
  });
});

describe("breakdown row labels", () => {
  const [intern] = normal.byAgent;

  it("prefers the roster name and never falls back to a member id", () => {
    expect(agentRowLabel(intern, null)).toEqual({
      text: "김인턴",
      handle: null,
    });
    expect(
      agentRowLabel(
        { ...intern, displayName: "" },
        { displayName: "김인턴", handle: "kim-intern", ambiguous: false }
      )
    ).toEqual({ text: "김인턴", handle: null });
    // Neither source named it: a plain noun, not 019f94e3-8b21-...
    const nameless = agentRowLabel({ ...intern, displayName: "  " }, null);
    expect(nameless.text).toBe("이름 없는 에이전트");
    expect(nameless.text).not.toContain(intern.agentMemberId.slice(0, 8));
  });

  it("adds the handle exactly where the name names two members", () => {
    // This workspace really has two 김인턴: a human @intern-kim and an agent
    // @kim-intern. Two identical rows in a cost ledger is a coin toss.
    expect(
      agentRowLabel(intern, {
        displayName: "김인턴",
        handle: "kim-intern",
        ambiguous: true,
      })
    ).toEqual({ text: "김인턴", handle: "@kim-intern" });
    expect(
      agentRowLabel(intern, {
        displayName: "hermes",
        handle: "hermes",
        ambiguous: false,
      }).handle
    ).toBeNull();
  });

  it("gives a model row with no name a label rather than a blank line", () => {
    expect(modelRowLabel("claude-opus-5")).toBe("claude-opus-5");
    expect(modelRowLabel("")).toBe("이름 없는 모델");
    expect(modelRowLabel("   ")).toBe("이름 없는 모델");
  });
});
