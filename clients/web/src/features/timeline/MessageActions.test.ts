import { describe, expect, it } from "vitest";
import type { MessageActionAvailability } from "@momo/core/features/timeline/model";
import { QUICK_REACTIONS } from "@momo/core/features/timeline/reactions";
import {
  COPY_LINK_ACTION_LABEL,
  COPY_LINK_DONE_LABEL,
  COPY_MESSAGE_ACTION_LABEL,
  COPY_MESSAGE_DONE_LABEL,
} from "@momo/core/features/timeline/copyLabels";
import {
  actionKeepsMenuOpen,
  MESSAGE_ACTION_SURFACES,
  messageActionItems,
  messageActionItemsForSurface,
  type MessageActionCopyState,
  type MessageActionItemKey,
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

const copyReady: MessageActionCopyState = {
  canCopy: true,
  copied: false,
  canCopyLink: true,
  copiedLink: false,
  pinned: false,
};

const AUTHOR_KEYS: MessageActionItemKey[] = [
  ...QUICK_REACTIONS.map((emoji) => `react:${emoji}` as const),
  "react-more",
  "reply",
  "quote",
  "copy",
  "copy-link",
  "pin",
  "edit",
  "delete",
];

describe("메시지 액션 세 표면", () => {
  it("⋯, 우클릭, 길게 누르기가 같은 액션과 같은 순서를 쓴다", () => {
    const bySurface = MESSAGE_ACTION_SURFACES.map((surface) =>
      messageActionItemsForSurface(surface, available, copyReady).map(
        (item) => item.key
      )
    );

    expect(bySurface[1]).toEqual(bySurface[0]);
    expect(bySurface[2]).toEqual(bySurface[0]);
    expect(bySurface[0]).toEqual(AUTHOR_KEYS);
  });

  it("저자 인벤토리는 기존 13항목 순서를 유지한 채 링크 복사만 복사 뒤에 더한다", () => {
    const keys = messageActionItems(available, copyReady).map((item) => item.key);
    expect(keys).toHaveLength(14);
    expect(keys.indexOf("copy-link")).toBe(keys.indexOf("copy") + 1);
    expect(keys.slice(0, keys.indexOf("copy") + 1)).toEqual([
      ...QUICK_REACTIONS.map((emoji) => `react:${emoji}` as const),
      "react-more",
      "reply",
      "quote",
      "copy",
    ]);
    expect(keys.slice(keys.indexOf("copy-link") + 1)).toEqual([
      "pin",
      "edit",
      "delete",
    ]);
  });

  it("권한 차등은 저자만 고치기/지우기를 갖고 묘비는 비어 있다", () => {
    const other = messageActionItems(
      { ...available, edit: false, delete: false },
      copyReady
    ).map((item) => item.key);
    expect(other).toHaveLength(12);
    expect(other).not.toContain("edit");
    expect(other).not.toContain("delete");
    expect(other).toContain("copy");
    expect(other).toContain("copy-link");

    const tombstone = messageActionItems(
      {
        reply: false,
        quote: false,
        react: false,
        pin: false,
        edit: false,
        delete: false,
      },
      {
        canCopy: false,
        copied: false,
        canCopyLink: false,
        copiedLink: false,
        pinned: false,
      }
    );
    expect(tombstone).toEqual([]);
  });

  it("복사는 렌더된 HTML이 아니라 본문 원문을 받는 독립 액션이다", () => {
    const items = messageActionItemsForSurface("menu", available, copyReady);
    const copy = items.find((item) => item.key === "copy");
    expect(copy).toMatchObject({
      label: COPY_MESSAGE_ACTION_LABEL,
      accessibleLabel: COPY_MESSAGE_ACTION_LABEL,
    });
    expect(items.findIndex((item) => item.key === "copy")).toBeGreaterThan(
      items.findIndex((item) => item.key === "quote")
    );
  });

  it("복사 뒤에는 토스트 대신 그 자리의 라벨이 바뀐다", () => {
    const copy = messageActionItemsForSurface("context", available, {
      ...copyReady,
      copied: true,
    }).find((item) => item.key === "copy");
    expect(copy).toMatchObject({
      label: COPY_MESSAGE_DONE_LABEL,
      accessibleLabel: COPY_MESSAGE_DONE_LABEL,
    });
  });

  it("링크 복사는 딥링크가 실존하는 행에만 있고 세 표면이 같은 낱말을 쓴다", () => {
    const labels = MESSAGE_ACTION_SURFACES.map((surface) => {
      const item = messageActionItemsForSurface(
        surface,
        available,
        copyReady
      ).find((entry) => entry.key === "copy-link");
      expect(item).toMatchObject({
        key: "copy-link",
        testKey: "copy-link",
        label: COPY_LINK_ACTION_LABEL,
        accessibleLabel: COPY_LINK_ACTION_LABEL,
      });
      return item?.label;
    });
    expect(new Set(labels).size).toBe(1);

    const withoutLink = messageActionItems(available, {
      ...copyReady,
      canCopyLink: false,
    }).map((item) => item.key);
    expect(withoutLink).not.toContain("copy-link");
    expect(withoutLink).toContain("copy");
  });

  it("링크 복사 뒤에도 그 자리의 라벨만 바뀐다", () => {
    const item = messageActionItemsForSurface("sheet", available, {
      ...copyReady,
      copiedLink: true,
    }).find((entry) => entry.key === "copy-link");
    expect(item?.label).toBe(COPY_LINK_DONE_LABEL);
    expect(item?.accessibleLabel).toBe(COPY_LINK_DONE_LABEL);
  });

  it("클립보드 항목과 반응 고르기는 메뉴를 닫지 않는다", () => {
    expect(actionKeepsMenuOpen("copy")).toBe(true);
    expect(actionKeepsMenuOpen("copy-link")).toBe(true);
    expect(actionKeepsMenuOpen("react-more")).toBe(true);
    expect(actionKeepsMenuOpen("delete")).toBe(false);
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
