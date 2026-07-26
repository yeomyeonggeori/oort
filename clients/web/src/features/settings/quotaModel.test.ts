import { beforeEach, describe, expect, it } from "vitest";
import fixtures from "./quotaFixtures.json";
import {
  QUOTA_FRESH_SECONDS,
  agedSeconds,
  forgetQuota,
  formatCheckedAt,
  groupByProvider,
  lowestGauge,
  parseQuotaSnapshots,
  providerLabel,
  quotaAge,
  quotaAnnouncement,
  quotaErrorCopy,
  quotaGauge,
  quotaReset,
  quotaView,
  recallQuota,
  rememberQuota,
  windowLabel,
  type QuotaSnapshot,
  type QuotaSnapshots,
} from "./quotaModel";

// The four fixtures are the contract shapes ADR-0135 D2 landed on track/engine
// (ProviderQuotaSnapshotRoutes.swift): a healthy pair of gauges on two
// providers, a set old enough to have been overtaken by its own reset, an empty
// list from a server whose adapter has not probed yet, and a provider on the
// edge of its limit. They live in quotaFixtures.json so scripts/capture-usage.mjs
// renders the exact same bytes these assertions are written against.

const healthy = parseQuotaSnapshots(fixtures.healthy);
const stale = parseQuotaSnapshots(fixtures.staleSnapshot);
const absent = parseQuotaSnapshots(fixtures.absent);
const nearLimit = parseQuotaSnapshots(fixtures.nearLimit);

/** The instant every fixture is written against (18:12 KST, 일요일). Tests pass
 *  it explicitly so nothing here depends on the day it runs. */
const NOW = Date.parse(fixtures._anchor);

describe("parseQuotaSnapshots (ADR-0135 D2 계약)", () => {
  it("reads the healthy fixture whole", () => {
    expect(healthy.observedAt).toBe("2026-07-26T09:12:04Z");
    expect(healthy.snapshots).toHaveLength(4);
    expect(healthy.snapshots[0]).toEqual({
      providerRef: "anthropic",
      window: "short",
      remainingRatio: 0.62,
      resetsAt: "2026-07-26T13:00:00Z",
      probedAt: "2026-07-26T09:08:20Z",
      ingestedAt: "2026-07-26T09:08:21Z",
      ageSeconds: 224,
    });
  });

  it("keeps an empty list as an empty list, not as a failure", () => {
    expect(absent.snapshots).toEqual([]);
    expect(absent.observedAt).toBe("2026-07-26T09:12:04Z");
  });

  it("lower-cases the provider ref so one provider is one row", () => {
    const parsed = parseQuotaSnapshots({
      observedAt: "2026-07-26T09:12:04Z",
      snapshots: [
        { providerRef: "Anthropic", window: "short", remainingRatio: 0.5, ageSeconds: 10 },
        { providerRef: "anthropic", window: "weekly", remainingRatio: 0.4, ageSeconds: 10 },
      ],
    });
    expect(groupByProvider(parsed.snapshots)).toHaveLength(1);
  });

  it("drops a row with no ratio instead of reading it as 0%", () => {
    // The whole reason this parser is stricter than usageModel: a missing cost
    // is truthfully 0, a missing remaining ratio is not truthfully "exhausted".
    const parsed = parseQuotaSnapshots({
      snapshots: [
        { providerRef: "anthropic", window: "short", ageSeconds: 10 },
        { providerRef: "anthropic", window: "weekly", remainingRatio: null, ageSeconds: 10 },
        { providerRef: "anthropic", window: "short", remainingRatio: "0.4", ageSeconds: 10 },
      ],
    });
    expect(parsed.snapshots).toEqual([]);
  });

  it("drops a window it cannot name and a row with no provider", () => {
    const parsed = parseQuotaSnapshots({
      snapshots: [
        { providerRef: "anthropic", window: "monthly", remainingRatio: 0.5, ageSeconds: 1 },
        { providerRef: "", window: "short", remainingRatio: 0.5, ageSeconds: 1 },
        { providerRef: "anthropic", window: "weekly", remainingRatio: 0.5, ageSeconds: 1 },
      ],
    });
    expect(parsed.snapshots).toHaveLength(1);
    expect(parsed.snapshots[0].window).toBe("weekly");
  });

  it("clamps a ratio outside the track it is drawn in", () => {
    const parsed = parseQuotaSnapshots({
      snapshots: [
        { providerRef: "a", window: "short", remainingRatio: 1.4, ageSeconds: 1 },
        { providerRef: "b", window: "short", remainingRatio: -0.2, ageSeconds: 1 },
      ],
    });
    expect(parsed.snapshots.map((s) => s.remainingRatio)).toEqual([1, 0]);
  });

  it("refuses a body that is not an object", () => {
    expect(() => parseQuotaSnapshots(null)).toThrow();
    expect(() => parseQuotaSnapshots([1, 2])).toThrow();
  });

  it("survives a body with no snapshots key", () => {
    expect(parseQuotaSnapshots({}).snapshots).toEqual([]);
  });
});

describe("groupByProvider", () => {
  it("pairs the two windows per provider in server order", () => {
    const providers = groupByProvider(healthy.snapshots);
    expect(providers.map((p) => p.providerRef)).toEqual(["anthropic", "openai"]);
    expect(providers[0].short?.remainingRatio).toBe(0.62);
    expect(providers[0].weekly?.remainingRatio).toBe(0.41);
  });

  it("leaves a window absent when the adapter did not report it", () => {
    const providers = groupByProvider(nearLimit.snapshots);
    const openai = providers.find((p) => p.providerRef === "openai");
    expect(openai?.short).toBeNull();
    expect(openai?.weekly?.remainingRatio).toBe(0.66);
  });
});

describe("labels", () => {
  it("names the two windows", () => {
    expect(windowLabel("short")).toBe("짧은 창");
    expect(windowLabel("weekly")).toBe("주간");
  });

  it("gives an unnamed provider a noun, never a blank heading", () => {
    expect(providerLabel("anthropic")).toBe("anthropic");
    expect(providerLabel("   ")).toBe("이름 없는 프로바이더");
  });
});

describe("quotaAge", () => {
  it("has a word rather than a number under a minute", () => {
    expect(quotaAge(0)).toEqual({ amount: null, unit: "", stale: false });
    expect(quotaAge(59).amount).toBeNull();
  });

  it("counts in 분 / 시간 / 일", () => {
    expect(quotaAge(224)).toEqual({ amount: 3, unit: "분", stale: false });
    expect(quotaAge(5_400)).toEqual({ amount: 1, unit: "시간", stale: true });
    expect(quotaAge(200_000)).toEqual({ amount: 2, unit: "일", stale: true });
  });

  it("turns stale exactly at the freshness deadline", () => {
    expect(quotaAge(QUOTA_FRESH_SECONDS - 1).stale).toBe(false);
    expect(quotaAge(QUOTA_FRESH_SECONDS).stale).toBe(true);
  });
});

describe("agedSeconds", () => {
  const snapshot = healthy.snapshots[0];

  it("adds the time the answer has been held in this tab", () => {
    // Nothing re-renders this panel on a timer, so an unadjusted ageSeconds
    // would freeze at 3분 전 and start lying about its own age.
    expect(agedSeconds(snapshot, 0)).toBe(224);
    expect(agedSeconds(snapshot, 600_000)).toBe(824);
  });

  it("never runs a clock backwards", () => {
    expect(agedSeconds(snapshot, -60_000)).toBe(224);
  });
});

describe("quotaReset", () => {
  it("says 오늘 for an instant later today", () => {
    expect(quotaReset("2026-07-26T13:00:00Z", NOW)).toEqual({
      text: "오늘 22:00 리셋",
      passed: false,
    });
  });

  it("says 내일 for tomorrow, even a few hours away across midnight", () => {
    // 05:00 KST 월요일: under half a day away, but a different calendar day, so
    // calling it 오늘 would be wrong by a date.
    expect(quotaReset("2026-07-26T20:00:00Z", NOW)?.text).toBe("내일 05:00 리셋");
  });

  it("names the weekday inside the week it can be read in", () => {
    expect(quotaReset("2026-07-27T15:00:00Z", NOW)?.text).toBe("화요일 00:00 리셋");
  });

  it("falls back to the date once a weekday would be ambiguous", () => {
    // Past this week a bare 월요일 could be any of several Mondays, so the
    // absolute date is the only honest label.
    expect(quotaReset("2026-08-10T01:00:00Z", NOW)?.text).toBe(
      "2026-08-10 10:00 리셋"
    );
  });

  it("marks an instant already behind us and writes it in the past tense", () => {
    const reset = quotaReset("2026-07-26T04:00:00Z", NOW);
    expect(reset).toEqual({ text: "오늘 13:00 리셋됨", passed: true });
  });

  it("has nothing to say when the provider reported no reset", () => {
    expect(quotaReset(null, NOW)).toBeNull();
    expect(quotaReset("not-a-timestamp", NOW)).toBeNull();
  });
});

describe("quotaGauge", () => {
  const [anthropicShort, anthropicWeekly] = healthy.snapshots;

  it("reads the remaining ratio as a floored percent", () => {
    expect(quotaGauge(anthropicShort, NOW, 0).remainingPercent).toBe(62);
    // Floored, so a 99.9% never renders as a 100% that is not true.
    expect(
      quotaGauge({ ...anthropicShort, remainingRatio: 0.999 }, NOW, 0)
        .remainingPercent
    ).toBe(99);
  });

  it("leaves a healthy gauge uncoloured and unchipped", () => {
    // The calm state gets neither a chip nor a coloured bar: a column of 여유
    // chips over green bars is a status board reporting that nothing is
    // happening, and colour on this block has to mean "look at this one".
    const gauge = quotaGauge(anthropicShort, NOW, 0);
    expect(gauge.tone).toBe("ok");
    expect(gauge.stateLabel).toBeNull();
    expect(gauge.barTone).toBe("neutral");
    expect(gauge.outdated).toBe(false);
    expect(gauge.windowLabel).toBe("짧은 창");
    expect(gauge.reset?.text).toBe("오늘 22:00 리셋");
    expect(gauge.age).toEqual({ amount: 3, unit: "분", stale: false });
  });

  it("splits 주의 and 임박 at a quarter and a tenth", () => {
    const at = (ratio: number) =>
      quotaGauge({ ...anthropicWeekly, remainingRatio: ratio }, NOW, 0);
    expect(at(0.25).tone).toBe("ok");
    expect(at(0.24).tone).toBe("warn");
    expect(at(0.24).stateLabel).toBe("주의");
    expect(at(0.1).tone).toBe("warn");
    expect(at(0.09).tone).toBe("danger");
    expect(at(0.09).stateLabel).toBe("임박");
    expect(at(0).tone).toBe("danger");
  });

  it("gives the bar the chip's tone wherever there is a chip", () => {
    // tokens.md §5a: a bar and the chip beside it can never tell different
    // stories. Where there is no chip there is no colour either.
    const at = (ratio: number) =>
      quotaGauge({ ...anthropicWeekly, remainingRatio: ratio }, NOW, 0);
    expect(at(0.6)).toMatchObject({ stateLabel: null, barTone: "neutral" });
    expect(at(0.2)).toMatchObject({ stateLabel: "주의", barTone: "warn" });
    expect(at(0.05)).toMatchObject({ stateLabel: "임박", barTone: "danger" });
  });

  it("tones the near-limit fixture the way its numbers read", () => {
    const [short, weekly] = nearLimit.snapshots;
    expect(quotaGauge(short, NOW, 0)).toMatchObject({
      remainingPercent: 4,
      tone: "danger",
      barTone: "danger",
      stateLabel: "임박",
    });
    expect(quotaGauge(weekly, NOW, 0)).toMatchObject({
      remainingPercent: 18,
      tone: "warn",
      barTone: "warn",
      stateLabel: "주의",
    });
  });

  it("removes the state colour from a reading old enough to be wrong", () => {
    // 7.5 hours old AND past its own reset: an old 19% may have been 100% for
    // most of that time, so it is shown, aged, and no longer toned.
    const gauge = quotaGauge(stale.snapshots[0], NOW, 0);
    expect(gauge.remainingPercent).toBe(19);
    expect(gauge.tone).toBe("neutral");
    expect(gauge.barTone).toBe("neutral");
    expect(gauge.stateLabel).toBe("오래된 값");
    expect(gauge.outdated).toBe(true);
    expect(gauge.age).toEqual({ amount: 7, unit: "시간", stale: true });
    expect(gauge.reset).toEqual({ text: "오늘 13:00 리셋됨", passed: true });
  });

  it("treats a passed reset as outdated even when the reading is fresh", () => {
    // The stronger of the two signals: the window itself no longer exists, so
    // the age being a minute old does not make the number current.
    const gauge = quotaGauge(
      { ...nearLimit.snapshots[0], resetsAt: "2026-07-26T04:00:00Z" },
      NOW,
      0
    );
    expect(gauge.age.stale).toBe(false);
    expect(gauge.tone).toBe("neutral");
    expect(gauge.outdated).toBe(true);
  });

  it("ages out a fresh gauge once the answer has been held long enough", () => {
    const gauge = quotaGauge(nearLimit.snapshots[0], NOW, 3_600_000);
    expect(gauge.tone).toBe("neutral");
    expect(gauge.age).toEqual({ amount: 1, unit: "시간", stale: true });
  });
});

describe("lowestGauge", () => {
  it("finds the window closest to running out", () => {
    const lowest = lowestGauge(groupByProvider(healthy.snapshots), NOW, 0);
    expect(lowest?.providerRef).toBe("anthropic");
    expect(lowest?.gauge.remainingPercent).toBe(41);
  });

  it("ignores readings too old to mean anything", () => {
    expect(lowestGauge(groupByProvider(stale.snapshots), NOW, 0)).toBeNull();
  });

  it("is null when nothing was reported", () => {
    expect(lowestGauge(groupByProvider(absent.snapshots), NOW, 0)).toBeNull();
  });
});

describe("quotaErrorCopy", () => {
  it("explains a 404 as a server that predates the route", () => {
    // The live case: momowebqa answers exactly this until the ADR-0135 engine
    // layer lands on it.
    expect(quotaErrorCopy(404, "HTTP 404")).toContain("아직 구독 잔여량을 제공하지 않습니다");
  });

  it("explains a 403 as a membership answer, not a network one", () => {
    expect(quotaErrorCopy(403, "HTTP 403")).toContain("멤버만");
  });

  it("passes anything else through rather than inventing a reason", () => {
    expect(quotaErrorCopy(500, "서버가 응답하지 않았습니다.")).toBe(
      "서버가 응답하지 않았습니다."
    );
    expect(quotaErrorCopy(null, "끊겼습니다.")).toBe("끊겼습니다.");
  });
});

describe("마지막 확인값 cache", () => {
  const WS = "019f94e3-7a10-79cd-9dee-208f47edd9a8";

  beforeEach(() => forgetQuota());

  it("remembers and recalls one answer per workspace", () => {
    rememberQuota(WS, healthy, 1_800_000_000_000);
    expect(recallQuota(WS)?.snapshots.snapshots).toHaveLength(4);
    expect(recallQuota(WS)?.checkedAtMs).toBe(1_800_000_000_000);
    expect(recallQuota("019f94e3-0000-0000-0000-000000000000")).toBeNull();
  });

  it("treats an upper-cased workspace id as the same workspace", () => {
    // Server UUIDs arrive upper-cased from other surfaces; a second cache entry
    // for the same workspace would answer with whichever was written last.
    rememberQuota(WS.toUpperCase(), healthy, 1_800_000_000_000);
    expect(recallQuota(WS)).not.toBeNull();
    forgetQuota(WS.toUpperCase());
    expect(recallQuota(WS)).toBeNull();
  });

  it("forgets everything on sign-out", () => {
    rememberQuota(WS, healthy, 1);
    rememberQuota("019f94e3-0000-0000-0000-000000000000", absent, 2);
    forgetQuota();
    expect(recallQuota(WS)).toBeNull();
  });
});

describe("quotaView", () => {
  const WS = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
  const CHECKED = Date.parse("2026-07-26T09:12:04Z");

  function input(over: Partial<Parameters<typeof quotaView>[0]> = {}) {
    return quotaView({
      data: null,
      dataUpdatedAtMs: 0,
      errorMessage: null,
      paused: false,
      lastKnown: null,
      nowMs: NOW,
      ...over,
    });
  }

  beforeEach(() => forgetQuota());

  it("waits with bars while the first read is in flight", () => {
    expect(input()).toEqual({ kind: "loading" });
  });

  it("renders a live answer with no elapsed time on it", () => {
    const view = input({ data: healthy, dataUpdatedAtMs: NOW });
    expect(view).toMatchObject({ kind: "ready", empty: false, elapsedMs: 0 });
  });

  it("calls an empty list ready-and-empty, never an error", () => {
    // A 200 with no snapshots is a server whose adapter has not probed yet.
    const view = input({ data: absent, dataUpdatedAtMs: NOW });
    expect(view).toMatchObject({ kind: "ready", empty: true });
  });

  it("holds the previous answer when a refresh fails, labelled", () => {
    const view = input({
      data: healthy,
      dataUpdatedAtMs: CHECKED,
      errorMessage: "서버가 응답하지 않았습니다.",
      nowMs: CHECKED + 600_000,
    });
    expect(view.kind).toBe("last-known");
    if (view.kind !== "last-known") throw new Error("expected last-known");
    expect(view.notice).toContain("서버가 응답하지 않았습니다.");
    expect(view.notice).toContain(formatCheckedAt(CHECKED));
    expect(view.checkedAtMs).toBe(CHECKED);
    // The held answer ages while it is held, so the gauges under this banner
    // report how old they actually are and not how old they were on arrival.
    expect(view.elapsedMs).toBe(600_000);
  });

  it("falls back to the remembered answer when the query has none", () => {
    rememberQuota(WS, healthy, CHECKED);
    const view = input({
      errorMessage: "서버가 응답하지 않았습니다.",
      lastKnown: recallQuota(WS),
    });
    expect(view.kind).toBe("last-known");
  });

  it("says so plainly when there is nothing to fall back on", () => {
    const view = input({ errorMessage: "서버가 응답하지 않았습니다." });
    expect(view).toEqual({
      kind: "error",
      message: "서버가 응답하지 않았습니다.",
    });
  });

  it("resolves an offline read instead of holding the skeleton forever", () => {
    // A paused query is never sent and never fails, so nothing but this branch
    // would ever take the bars off the screen.
    expect(input({ paused: true })).toEqual({
      kind: "error",
      message: "연결이 끊겼습니다. 다시 연결되면 잔여량을 불러옵니다.",
    });
  });

  it("keeps rendering cached gauges while offline", () => {
    const view = input({
      paused: true,
      data: healthy,
      dataUpdatedAtMs: CHECKED,
    });
    expect(view.kind).toBe("last-known");
    if (view.kind !== "last-known") throw new Error("expected last-known");
    expect(view.notice).toContain("연결이 끊겼습니다.");
    expect(view.providers).toHaveLength(2);
  });

  it("checks the failure branches before the ready branch", () => {
    // Data on screen while the current read cannot complete is a last-known
    // value, and passing it off as live is the failure this exists to prevent.
    const view = input({
      data: healthy,
      dataUpdatedAtMs: CHECKED,
      errorMessage: "끊겼습니다.",
    });
    expect(view.kind).toBe("last-known");
  });

  it("cannot label an arrival it has no instant for", () => {
    // Data with no arrival instant would be stamped 1970, so it falls through
    // to the remembered answer instead.
    rememberQuota(WS, absent, CHECKED);
    const view = input({
      data: healthy,
      dataUpdatedAtMs: 0,
      errorMessage: "끊겼습니다.",
      lastKnown: recallQuota(WS),
    });
    expect(view.kind).toBe("last-known");
    if (view.kind !== "last-known") throw new Error("expected last-known");
    expect(view.empty).toBe(true);
  });

  it("is not keyed by the 기간/단위 controls of the block below it", () => {
    // The 616 lesson, applied rather than copied: there the cache HAD to carry
    // the window, because a 7일 failure answered with a 30일 total put the
    // control and the number in disagreement. This read takes no parameters, so
    // one workspace has exactly one answer and the cost controls cannot reach
    // it.
    rememberQuota(WS, healthy, CHECKED);
    const first = recallQuota(WS);
    rememberQuota(WS, nearLimit, CHECKED + 1_000);
    const second = recallQuota(WS);
    expect(first?.snapshots.snapshots).toHaveLength(4);
    expect(second?.snapshots.snapshots).toHaveLength(3);
  });
});

describe("quotaAnnouncement", () => {
  it("announces the wait", () => {
    expect(quotaAnnouncement({ kind: "loading" }, NOW)).toBe(
      "구독 잔여량을 불러오는 중입니다."
    );
  });

  it("announces the window closest to running out", () => {
    const view = quotaView({
      data: nearLimit,
      dataUpdatedAtMs: NOW,
      errorMessage: null,
      paused: false,
      lastKnown: null,
      nowMs: NOW,
    });
    expect(quotaAnnouncement(view, NOW)).toBe(
      "구독 잔여량을 불러왔습니다. 가장 적게 남은 창은 anthropic 짧은 창 4% 남음입니다."
    );
  });

  it("says the list is empty rather than reading a number that is not there", () => {
    const view = quotaView({
      data: absent,
      dataUpdatedAtMs: NOW,
      errorMessage: null,
      paused: false,
      lastKnown: null,
      nowMs: NOW,
    });
    expect(quotaAnnouncement(view, NOW)).toBe("보고된 구독 잔여량이 없습니다.");
  });

  it("says the readings are old when every one of them is", () => {
    const view = quotaView({
      data: stale,
      dataUpdatedAtMs: NOW,
      errorMessage: null,
      paused: false,
      lastKnown: null,
      nowMs: NOW,
    });
    expect(quotaAnnouncement(view, NOW)).toContain("오래된 값");
  });

  it("stays silent where a banner already speaks", () => {
    // Error and 마지막 확인값 render their own role=alert / role=status banner;
    // a second live region would read the same sentence twice.
    expect(quotaAnnouncement({ kind: "error", message: "끊겼습니다." }, NOW)).toBe("");
  });
});

describe("formatCheckedAt", () => {
  it("writes an absolute local instant, not a relative one", () => {
    // Nothing re-renders the banner on a timer, so a relative stamp would
    // freeze at whatever it said when the read failed.
    const ms = new Date(2026, 6, 26, 18, 12).getTime();
    expect(formatCheckedAt(ms)).toBe("2026-07-26 18:12");
  });
});

describe("fixture shapes stay usable as fixtures", () => {
  it("covers the four cases the panel has to render", () => {
    const cases: [string, QuotaSnapshots][] = [
      ["2게이지 정상", healthy],
      ["스냅샷 노후", stale],
      ["스냅샷 부재", absent],
      ["한도 임박", nearLimit],
    ];
    expect(cases.map(([name]) => name)).toHaveLength(4);
    expect(healthy.snapshots.every((s: QuotaSnapshot) => s.ageSeconds < 300)).toBe(true);
    expect(stale.snapshots.every((s: QuotaSnapshot) => s.ageSeconds > QUOTA_FRESH_SECONDS)).toBe(true);
    expect(absent.snapshots).toHaveLength(0);
    expect(nearLimit.snapshots[0].remainingRatio).toBeLessThan(0.1);
  });
});
