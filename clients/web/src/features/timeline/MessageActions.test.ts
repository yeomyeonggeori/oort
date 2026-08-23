import { describe, expect, it } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { QUICK_REACTIONS } from "@momo/core/features/timeline/reactions";
import {
  MESSAGE_ACTION_SURFACES,
  messageActionItemsForSurface,
} from "./messageActionModel";
import { selectionIsWithinRow } from "./messageContextMenuModel";

const available: MessageActionAvailability = {
  reply: true,
  quote: true,
  react: true,
  pin: true,
  edit: true,
  delete: true,
};

describe("메시지 액션 세 표면", () => {
  it("⋯, 우클릭, 길게 누르기가 같은 액션과 같은 순서를 쓴다", () => {
    const bySurface = MESSAGE_ACTION_SURFACES.map((surface) =>
      messageActionItemsForSurface(surface, available, {
        canCopy: true,
        copied: false,
        pinned: false,
      }).map((item) => item.key)
    );

    expect(bySurface[1]).toEqual(bySurface[0]);
    expect(bySurface[2]).toEqual(bySurface[0]);
    expect(bySurface[0]).toEqual([
      ...QUICK_REACTIONS.map((emoji) => `react:${emoji}`),
      "react-more",
      "reply",
      "quote",
      "copy",
      "pin",
      "edit",
      "delete",
    ]);
  });

  it("복사는 렌더된 HTML이 아니라 본문 원문을 받는 독립 액션이다", () => {
    const items = messageActionItemsForSurface("menu", available, {
      canCopy: true,
      copied: false,
      pinned: false,
    });
    const copy = items.find((item) => item.key === "copy");
    expect(copy).toMatchObject({
      label: "복사",
      accessibleLabel: "메시지 복사",
    });
    expect(items.findIndex((item) => item.key === "copy")).toBeGreaterThan(
      items.findIndex((item) => item.key === "quote")
    );
  });

  it("복사 뒤에는 토스트 대신 그 자리의 라벨이 바뀐다", () => {
    const copy = messageActionItemsForSurface("context", available, {
      canCopy: true,
      copied: true,
      pinned: false,
    }).find((item) => item.key === "copy");
    expect(copy).toMatchObject({
      label: "복사됨",
      accessibleLabel: "메시지 복사됨",
    });
  });
});

describe("선택 영역 우클릭 양보", () => {
  const inside = {} as Node;
  const outside = {} as Node;
  const root = {
    contains(node: Node | null) {
      return node === inside;
    },
  };

  it("이 행 안의 펼친 선택은 브라우저 기본 메뉴에 양보한다", () => {
    expect(
      selectionIsWithinRow(root, {
        isCollapsed: false,
        anchorNode: inside,
        focusNode: inside,
      })
    ).toBe(true);
  });

  it("접힌 선택이나 다른 행의 선택은 메시지 메뉴를 막지 않는다", () => {
    expect(
      selectionIsWithinRow(root, {
        isCollapsed: true,
        anchorNode: inside,
        focusNode: inside,
      })
    ).toBe(false);
    expect(
      selectionIsWithinRow(root, {
        isCollapsed: false,
        anchorNode: outside,
        focusNode: outside,
      })
    ).toBe(false);
  });
});
