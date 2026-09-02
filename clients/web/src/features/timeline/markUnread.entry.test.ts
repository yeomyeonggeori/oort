import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import {
  MESSAGE_ACTION_SURFACES,
  messageActionItems,
  messageActionItemsForSurface,
  type MessageActionCopyState,
} from "./messageActionModel";
import { MARK_UNREAD_ACTION_LABEL } from "@momo/core/features/readState/copy";

const available: MessageActionAvailability = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
  remind: true,
  markUnread: true,
  edit: true,
  delete: true,
};

const copyReady: MessageActionCopyState = {
  canCopy: true,
  copied: false,
  canCopyLink: true,
  copiedLink: false,
  pinned: false,
};

describe("⋯ 메뉴 「여기부터 안 읽음」", () => {
  it("세 표면이 같은 열쇠와 같은 한글 낱말을 쓴다", () => {
    const labels = MESSAGE_ACTION_SURFACES.map((surface) => {
      const item = messageActionItemsForSurface(
        surface,
        available,
        copyReady
      ).find((entry) => entry.key === "mark-unread");
      expect(item).toMatchObject({
        key: "mark-unread",
        testKey: "mark-unread",
        label: MARK_UNREAD_ACTION_LABEL,
      });
      return item?.label;
    });
    expect(new Set(labels).size).toBe(1);
    expect(labels[0]).toBe("여기부터 안 읽음");
  });

  it("인벤토리에 항목이 있고 Accrued 주석 자리에 들어온다", () => {
    const keys = messageActionItems(available, copyReady).map((item) => item.key);
    expect(keys).toContain("mark-unread");
    expect(keys.indexOf("mark-unread")).toBeGreaterThan(keys.indexOf("copy-link"));
    expect(keys.indexOf("mark-unread")).toBeLessThan(keys.indexOf("edit"));
  });

  it("읽음 상태 문법은 Mail 을 쓴다 (숨김 EyeOff 가 아니다)", () => {
    const source = readFileSync(
      new URL("./MessageActions.tsx", import.meta.url),
      "utf8"
    );
    expect(source).toMatch(/case "mark-unread":\s*return <Mail /);
    expect(source).not.toMatch(/EyeOff/);
  });
});
