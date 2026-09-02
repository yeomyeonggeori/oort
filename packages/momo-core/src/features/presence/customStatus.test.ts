import { describe, expect, it } from "vitest";
import {
  clampStatusText,
  clearCustomStatusWrite,
  CUSTOM_STATUS_PRESETS,
  CUSTOM_STATUS_TEXT_MAX,
  customExpiryAtMs,
  customStatusAccessibleText,
  presenceWriteBody,
  statusExpiryAtMs,
  visibleCustomStatus,
} from "./customStatus";

const NOW = 1_800_000_000_000;

describe("presenceWriteBody (omit vs null)", () => {
  it("omits custom keys when only declared status is written", () => {
    expect(JSON.stringify(presenceWriteBody({ status: "auto" }))).toBe(
      '{"status":"auto"}'
    );
    expect(JSON.stringify(presenceWriteBody({ status: "away" }))).toBe(
      '{"status":"away"}'
    );
    expect(JSON.stringify(presenceWriteBody({ status: "dnd" }))).toBe(
      '{"status":"dnd"}'
    );
  });

  it("emits JSON null for a present clear, not a dropped key", () => {
    expect(
      JSON.stringify(
        presenceWriteBody({
          status: "auto",
          statusEmoji: null,
          statusText: null,
          statusExpiresAtMs: null,
        })
      )
    ).toBe(
      '{"status":"auto","statusEmoji":null,"statusText":null,"statusExpiresAtMs":null}'
    );
    expect(JSON.stringify(clearCustomStatusWrite("away"))).toBe(
      '{"status":"away","statusEmoji":null,"statusText":null,"statusExpiresAtMs":null}'
    );
  });

  it("sets all three custom keys when the dialog saves a status", () => {
    expect(
      JSON.stringify(
        presenceWriteBody({
          status: "auto",
          statusEmoji: "📅",
          statusText: "회의 중",
          statusExpiresAtMs: NOW + 1_800_000,
        })
      )
    ).toBe(
      `{"status":"auto","statusEmoji":"📅","statusText":"회의 중","statusExpiresAtMs":${NOW + 1_800_000}}`
    );
  });

  it("treats blank strings as JSON null, not omit", () => {
    expect(
      JSON.stringify(
        presenceWriteBody({
          status: "auto",
          statusEmoji: "  ",
          statusText: "   ",
          statusExpiresAtMs: null,
        })
      )
    ).toBe(
      '{"status":"auto","statusEmoji":null,"statusText":null,"statusExpiresAtMs":null}'
    );
  });

  it("does not treat an undefined field as a clear", () => {
    expect(
      JSON.stringify(
        presenceWriteBody({
          status: "auto",
          statusText: undefined,
          statusExpiresAtMs: undefined,
        })
      )
    ).toBe('{"status":"auto"}');
  });
});

describe("visibleCustomStatus", () => {
  it("hides a status whose expiry is in the past at the injected now", () => {
    expect(
      visibleCustomStatus(
        {
          statusEmoji: "📅",
          statusText: "회의 중",
          statusExpiresAtMs: NOW - 1,
        },
        NOW
      )
    ).toBeNull();
  });

  it("still shows a status that expires at now (not yet past)", () => {
    expect(
      visibleCustomStatus(
        { statusText: "회의 중", statusExpiresAtMs: NOW },
        NOW
      )
    ).toEqual({ text: "회의 중" });
  });

  it("returns emoji alone when there is no text", () => {
    expect(visibleCustomStatus({ statusEmoji: "🏠" }, NOW)).toEqual({
      emoji: "🏠",
    });
  });

  it("returns text alone when there is no emoji", () => {
    expect(visibleCustomStatus({ statusText: "재택" }, NOW)).toEqual({
      text: "재택",
    });
  });

  it("returns null when both fields are empty", () => {
    expect(visibleCustomStatus({ statusEmoji: " ", statusText: "" }, NOW)).toBeNull();
  });
});

describe("customStatusAccessibleText", () => {
  it("exposes the text and not the emoji when both are present", () => {
    expect(
      customStatusAccessibleText(
        { statusEmoji: "📅", statusText: "회의 중" },
        NOW
      )
    ).toBe("회의 중");
  });

  it("exposes the emoji when that is the only fact", () => {
    expect(customStatusAccessibleText({ statusEmoji: "📅" }, NOW)).toBe("📅");
  });
});

describe("A-42 preset chips", () => {
  it("ships the five fixed Korean copies in order", () => {
    expect(CUSTOM_STATUS_PRESETS.map((preset) => preset.label)).toEqual([
      "회의 중",
      "이동 중",
      "병가",
      "휴가",
      "재택",
    ]);
    expect(CUSTOM_STATUS_PRESETS).toHaveLength(5);
  });
});

describe("clampStatusText", () => {
  it("caps at the server 80-character bound", () => {
    const over = "가".repeat(CUSTOM_STATUS_TEXT_MAX + 1);
    expect(clampStatusText(over).length).toBe(CUSTOM_STATUS_TEXT_MAX);
  });
});

describe("statusExpiryAtMs", () => {
  it("offsets 30 minutes and 1 hour from the injected now", () => {
    expect(statusExpiryAtMs("30m", NOW)).toBe(NOW + 30 * 60_000);
    expect(statusExpiryAtMs("1h", NOW)).toBe(NOW + 60 * 60_000);
  });

  it("lands 오늘까지 on local 23:59:59.999 of the injected day", () => {
    const stamp = Date.UTC(2026, 7, 30, 4, 0, 0);
    const local = new Date(stamp);
    const expected = new Date(stamp);
    expected.setHours(23, 59, 59, 999);
    expect(statusExpiryAtMs("today", local.getTime())).toBe(expected.getTime());
  });
});

describe("customExpiryAtMs", () => {
  it("reads local date+time the way the native inputs emit them", () => {
    const ms = customExpiryAtMs("2026-08-30", "18:30");
    expect(ms).not.toBeNull();
    const date = new Date(ms!);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(7);
    expect(date.getDate()).toBe(30);
    expect(date.getHours()).toBe(18);
    expect(date.getMinutes()).toBe(30);
  });

  it("rejects an unreadable pair instead of guessing", () => {
    expect(customExpiryAtMs("2026-13-01", "18:30")).toBeNull();
    expect(customExpiryAtMs("2026-08-30", "24:00")).toBeNull();
    expect(customExpiryAtMs("", "09:00")).toBeNull();
  });
});
