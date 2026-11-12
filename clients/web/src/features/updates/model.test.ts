import { describe, expect, it } from "vitest";
import type { AvailableUpdate } from "@/lib/tauri";
import {
  badgeLabel,
  badgeWorthShowing,
  formatBytes,
  formatPublishedAt,
  offeredVersion,
  progressLabel,
  pillTooltip,
  pillWorthShowing,
  progressPercent,
  railCardBottomPadding,
  type UpdateState,
} from "./model";

// The version strings and the manifest shape asserted here are the ones
// `scripts/publish_next_build.sh` actually writes into update-next.json, so a
// change to the publish format breaks a test rather than a tester's badge.

const UPDATE: AvailableUpdate = {
  version: "0.1.0-next.2",
  currentVersion: "0.1.0-next.1",
  notes: "인박스 필터가 새로고침 뒤에도 유지됩니다.",
  publishedAt: "2026-07-25T09:12:00Z",
};

describe("badge visibility", () => {
  it("stays silent until there is something to act on", () => {
    const quiet: UpdateState[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current" },
      { kind: "failed", phase: "check", message: "…", detail: null, update: null },
    ];
    for (const state of quiet) expect(badgeWorthShowing(state)).toBe(false);
  });

  it("shows through the whole offer, download and restart run", () => {
    const loud: UpdateState[] = [
      { kind: "available", update: UPDATE },
      { kind: "installing", update: UPDATE, downloaded: 10, total: 100 },
      { kind: "installed", update: UPDATE },
    ];
    for (const state of loud) expect(badgeWorthShowing(state)).toBe(true);
  });

  it("names the version on offer, then the progress, then the restart", () => {
    expect(badgeLabel({ kind: "available", update: UPDATE })).toBe(
      "새 버전 0.1.0-next.2"
    );
    expect(
      badgeLabel({ kind: "installing", update: UPDATE, downloaded: 25, total: 100 })
    ).toBe("업데이트 받는 중 25%");
    expect(badgeLabel({ kind: "installed", update: UPDATE })).toBe("곧 다시 시작");
    expect(badgeLabel({ kind: "current" })).toBeNull();
  });

  it("drops the percent when the download has no known length", () => {
    expect(
      badgeLabel({ kind: "installing", update: UPDATE, downloaded: 25, total: null })
    ).toBe("업데이트 받는 중");
  });
});

describe("offeredVersion", () => {
  it("is the version being moved to, in every state that has one", () => {
    expect(offeredVersion({ kind: "available", update: UPDATE })).toBe("0.1.0-next.2");
    expect(offeredVersion({ kind: "installed", update: UPDATE })).toBe("0.1.0-next.2");
    expect(offeredVersion({ kind: "current" })).toBeNull();
  });
});

describe("progress", () => {
  it("is a whole percent of a known length", () => {
    expect(progressPercent(0, 200)).toBe(0);
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(200, 200)).toBe(100);
  });

  it("is unknown without a Content-Length", () => {
    expect(progressPercent(500, null)).toBeNull();
    expect(progressPercent(500, 0)).toBeNull();
  });

  it("clamps rather than rendering 130% from a truncated length", () => {
    expect(progressPercent(260, 200)).toBe(100);
    expect(progressPercent(-5, 200)).toBe(0);
  });

  it("labels bytes in SI units, because MB is what the release page says", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(12_000)).toBe("12 KB");
    expect(formatBytes(12_400_000)).toBe("12.4 MB");
  });

  it("shows the total only when there is one, and a word (never bytes) when there is not", () => {
    expect(progressLabel(3_200_000, 12_400_000)).toBe("3.2 / 12.4 MB");
    expect(progressLabel(3_200_000, null)).toBe("받는 중");
    expect(progressLabel(0, null)).toBe("받는 중");
    expect(progressLabel(3_200_000, 0)).toBe("받는 중");
  });
});

describe("publish date", () => {
  it("renders the manifest timestamp in the reader's locale", () => {
    expect(formatPublishedAt("2026-07-25T09:12:00Z", "en-US")).toBe("July 25, 2026");
  });

  it("drops an absent or unparseable timestamp instead of showing Invalid Date", () => {
    expect(formatPublishedAt(null)).toBeNull();
    expect(formatPublishedAt("어제")).toBeNull();
  });
});

describe("업데이트 알약 (성재 결재 2026-10-16)", () => {
  const installFailed: UpdateState = {
    kind: "failed",
    phase: "install",
    message: "…",
    detail: null,
    update: null,
  };
  const checkFailed: UpdateState = { ...installFailed, phase: "check" };

  it("새 버전·받는 중·설치 후·설치 실패에서만 서고, 그 밖에는 없다", () => {
    expect(pillWorthShowing({ kind: "available", update: UPDATE })).toBe(true);
    expect(
      pillWorthShowing({ kind: "installing", update: UPDATE, downloaded: 1, total: 2 })
    ).toBe(true);
    expect(pillWorthShowing({ kind: "installed", update: UPDATE })).toBe(true);
    expect(pillWorthShowing(installFailed)).toBe(true);
    for (const quiet of [{ kind: "idle" }, { kind: "checking" }, { kind: "current" }, checkFailed] as UpdateState[]) {
      expect(pillWorthShowing(quiet)).toBe(false);
    }
  });

  it("툴팁 문장은 상태마다 정해져 있고 줄표가 없다", () => {
    const texts = [
      pillTooltip({ kind: "available", update: UPDATE }),
      pillTooltip({ kind: "installing", update: UPDATE, downloaded: 26, total: 100 }),
      pillTooltip({ kind: "installing", update: UPDATE, downloaded: 26, total: null }),
      pillTooltip({ kind: "installed", update: UPDATE }),
      pillTooltip(installFailed),
    ];
    expect(texts).toEqual([
      "0.1.0-next.2로 업데이트할 수 있어요. 누르면 받고 다시 시작해요.",
      "받는 중 26%",
      "받는 중이에요.",
      "곧 다시 시작돼요.",
      "업데이트하지 못했어요. 눌러서 다시 확인해요.",
    ]);
    for (const text of texts) expect(text).not.toMatch(/[—–]/);
    expect(pillTooltip(checkFailed)).toBeNull();
    expect(pillTooltip({ kind: "current" })).toBeNull();
  });
});

describe("접힌 레일 카드의 아래 여백 (#5661 수리 2회차 H2)", () => {
  const rect = (left: number, top: number, width: number, height: number) =>
    ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRectReadOnly;

  it("카드가 닿는 폭의 입력창 독 위 끝보다 8px 위까지만 내려온다", () => {
    // 1280×800: 레일 알약 오른쪽 끝 48, 대화 판 입력창 독 top 640.
    expect(railCardBottomPadding(48, 800, [rect(72, 640, 1180, 152)])).toBe(800 - 640 + 8);
  });

  it("여러 독 가운데 가장 높이 선 것, 카드가 닿지 않는 오른쪽 스레드 판의 독은 빼고", () => {
    expect(railCardBottomPadding(48, 800, [rect(72, 660, 700, 132), rect(72, 600, 700, 192), rect(900, 300, 360, 492)])).toBe(208);
  });

  it("입력창이 없거나 그려지지 않았으면 기본 여백 8px", () => {
    expect(railCardBottomPadding(48, 800, [])).toBe(8);
    expect(railCardBottomPadding(48, 800, [rect(72, 640, 0, 0)])).toBe(8);
  });
});
