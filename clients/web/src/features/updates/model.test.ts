import { describe, expect, it } from "vitest";
import type { AvailableUpdate } from "@/lib/tauri";
import {
  badgeLabel,
  badgeWorthShowing,
  formatBytes,
  formatPublishedAt,
  offeredVersion,
  progressLabel,
  progressPercent,
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
      { kind: "failed", message: "…", detail: null, update: null },
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
    expect(badgeLabel({ kind: "installed", update: UPDATE })).toBe("재시작하면 적용");
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

  it("shows the total only when there is one", () => {
    expect(progressLabel(3_200_000, 12_400_000)).toBe("3.2 / 12.4 MB");
    expect(progressLabel(3_200_000, null)).toBe("3.2 MB");
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
