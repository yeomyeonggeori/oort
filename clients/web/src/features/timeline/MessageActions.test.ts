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
  MESSAGE_ACTION_GROUP,
  MESSAGE_ACTION_GROUP_PLACEMENT,
  MESSAGE_ACTION_PLACE,
  MESSAGE_ACTION_SURFACES,
  messageActionGroups,
  messageActionItems,
  messageActionItemsForSurface,
  messageToolbarItems,
  type MessageActionCopyState,
  type MessageActionItemKey,
} from "./messageActionModel";
import { selectionIsWithinRow } from "./messageContextMenuModel";

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

const REACTION_KEYS: MessageActionItemKey[] = [
  ...QUICK_REACTIONS.map((emoji) => `react:${emoji}` as const),
  "react-more",
];

/**
 * Buzz 대응표(#5192)가 정한 ⋯·우클릭 목록. 반응·답글은 도구 막대가 직접 보여 주므로 메뉴에 없다.
 * 묶음: 이 메시지에 하는 일(고치기가 첫 줄, Buzz와 같다) | 복사 | 지우기(구분선 아래 혼자). 순서를 바꾸는 것은 표를 바꾸는
 * 결정이라 일부러 값을 적어 둔다.
 */
const MENU_AUTHOR_KEYS: MessageActionItemKey[] = [
  "edit",
  "quote",
  "pin",
  "remind",
  "mark-unread",
  "copy",
  "copy-link",
  "delete",
];

/** 도구 막대가 직접 보여 주는 항목(반응 여섯 + 더 고르기 + 답글). 반응 칸 수는 빈도 저장소가 정한다. */
const TOOLBAR_KEYS: MessageActionItemKey[] = [...REACTION_KEYS, "reply"];

/** 길게 누르기 시트는 도구 막대가 없는 터치 표면이라 전부다: 반응 · 답글 · 메뉴 목록. */
const SHEET_AUTHOR_KEYS: MessageActionItemKey[] = [
  ...TOOLBAR_KEYS,
  ...MENU_AUTHOR_KEYS,
];

const keysOf = (items: Array<{ key: MessageActionItemKey }>) =>
  items.map((item) => item.key);

describe("메시지 액션 세 표면", () => {
  it("⋯와 우클릭은 늘 같은 목록·같은 순서이고, 시트는 전체 인벤토리다", () => {
    const [menu, context, sheet] = MESSAGE_ACTION_SURFACES.map((surface) =>
      keysOf(messageActionItemsForSurface(surface, available, copyReady))
    );

    expect(context).toEqual(menu);
    expect(menu).toEqual(MENU_AUTHOR_KEYS);
    expect(sheet).toEqual(SHEET_AUTHOR_KEYS);
  });

  it("반응·답글은 도구 막대의 몫이라 포인터 메뉴가 되풀이하지 않는다(Buzz: 메뉴 안에 반응 줄이 없다)", () => {
    const menu = keysOf(messageActionItemsForSurface("menu", available, copyReady));
    expect(menu.filter((key) => key.startsWith("react"))).toEqual([]);
    expect(menu).not.toContain("reply");
    expect(keysOf(messageToolbarItems(available, copyReady))).toEqual(TOOLBAR_KEYS);
  });

  it("도구 막대 ∪ 메뉴 = 시트 = 전체 인벤토리: 어떤 동작도 포인터에서 사라지지 않고 두 곳에 겹치지도 않는다", () => {
    const scenarios: Array<[string, Partial<MessageActionAvailability>, Partial<MessageActionCopyState>]> = [
      ["내 글 메시지", {}, {}],
      ["남의 메시지", { edit: false, delete: false }, {}],
      ["에이전트 메시지(고치기·지우기 없음, 읽음 표시 없음)", { edit: false, delete: false, markUnread: false }, {}],
      ["답글 불가·반응 불가", { reply: false, react: false }, {}],
      ["복사 불가", {}, { canCopy: false, canCopyLink: false }],
    ];
    for (const [name, overAvailable, overCopy] of scenarios) {
      const a = { ...available, ...overAvailable };
      const c = { ...copyReady, ...overCopy };
      const all = keysOf(messageActionItems(a, c)).sort();
      const toolbar = keysOf(messageToolbarItems(a, c));
      const menu = keysOf(messageActionItemsForSurface("menu", a, c));
      expect([...toolbar, ...menu].sort(), name).toEqual(all);
      expect(keysOf(messageActionItemsForSurface("sheet", a, c)).sort(), name).toEqual(all);
      expect(toolbar.filter((key) => menu.includes(key)), `${name}: 겹침`).toEqual([]);
    }
  });

  it("묶음: 이 메시지에 하는 일(고치기 첫 줄) | 복사 | 지우기. 구분선은 묶음 사이에만 서고 빈 묶음은 없다", () => {
    const groups = (a: MessageActionAvailability, c: MessageActionCopyState) =>
      messageActionGroups(messageActionItemsForSurface("menu", a, c)).map(keysOf);

    expect(groups(available, copyReady)).toEqual([
      ["edit", "quote", "pin", "remind", "mark-unread"],
      ["copy", "copy-link"],
      ["delete"],
    ]);
    // 남의 메시지: 내 메시지 묶음이 통째로 빠지고, 마지막 묶음 뒤에 구분선이 남지 않는다.
    expect(groups({ ...available, edit: false, delete: false }, copyReady)).toEqual([
      ["quote", "pin", "remind", "mark-unread"],
      ["copy", "copy-link"],
    ]);
    // 묶음이 하나만 남으면 구분선이 없다.
    expect(groups({ ...available, edit: false, delete: false, quote: false, pin: false, remind: false, markUnread: false }, copyReady)).toEqual([
      ["copy", "copy-link"],
    ]);
    // 아무것도 없으면 묶음도 없다(빈 판을 열지 않는다).
    expect(
      groups(
        { ...available, quote: false, pin: false, remind: false, markUnread: false, edit: false, delete: false },
        { ...copyReady, canCopy: false, canCopyLink: false }
      )
    ).toEqual([]);
  });

  it("고치기는 내 메시지 메뉴의 첫 줄(Buzz), 지우기는 구분선 아래 혼자 맨 아래이고 위험 톤은 지우기 하나뿐이다", () => {
    const menu = messageActionItemsForSurface("menu", available, copyReady);
    expect(menu[0].key).toBe("edit");
    expect(menu[menu.length - 1].key).toBe("delete");
    expect(menu.filter((item) => item.tone === "danger").map((item) => item.key)).toEqual(["delete"]);
    // 지우기는 자기 묶음에 혼자라서 고치기와 붙어 있지 않다(자주 쓰는 동작 옆의 되돌릴 수 없는 동작은 잘못 누르기 쉽다).
    const groups = messageActionGroups(menu).map(keysOf);
    expect(groups[groups.length - 1]).toEqual(["delete"]);
    expect(groups[0]).toContain("edit");
    // 남의 메시지에는 고치기·지우기가 없으니 첫 줄은 인용이다.
    const other = messageActionItemsForSurface("menu", { ...available, edit: false, delete: false }, copyReady);
    expect(other[0].key).toBe("quote");
  });

  it("고치기·지우기는 어떤 행에서도 도구 막대에 올리지 않는다(결정: Buzz·Slack 모두 ⋮ 안), 시트에는 있다", () => {
    const toolbar = keysOf(messageToolbarItems(available, copyReady));
    expect(toolbar).not.toContain("edit");
    expect(toolbar).not.toContain("delete");
    expect(MESSAGE_ACTION_GROUP_PLACEMENT[MESSAGE_ACTION_GROUP.message]).toEqual([MESSAGE_ACTION_PLACE.menu]);
    expect(MESSAGE_ACTION_GROUP_PLACEMENT[MESSAGE_ACTION_GROUP.destructive]).toEqual([MESSAGE_ACTION_PLACE.menu]);
    const sheet = keysOf(messageActionItemsForSurface("sheet", available, copyReady));
    expect(sheet).toContain("edit");
    expect(sheet).toContain("delete");
  });

  it("저자 인벤토리의 라벨: 나중에 알림은 고정 뒤에, 링크 복사는 복사 뒤에 있다", () => {
    const keys = keysOf(messageActionItems(available, copyReady));
    expect(keys).toHaveLength(16);
    expect(keys.indexOf("copy-link")).toBe(keys.indexOf("copy") + 1);
    expect(keys.indexOf("remind")).toBe(keys.indexOf("pin") + 1);
    expect(
      messageActionItems(available, copyReady).find((item) => item.key === "remind")
        ?.label
    ).toBe("나중에 알림");
  });

  it("권한 차등은 저자만 고치기/지우기를 갖고 묘비는 비어 있다", () => {
    const other = messageActionItems(
      { ...available, edit: false, delete: false },
      copyReady
    ).map((item) => item.key);
    expect(other).toHaveLength(14);
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
        remind: false,
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
    expect(COPY_MESSAGE_ACTION_LABEL).toBe("메시지 복사하기");
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
      expect(COPY_LINK_ACTION_LABEL).toBe("링크 복사하기");
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

  it("클립보드 항목만 메뉴를 닫지 않는다(반응 고르기는 이제 메뉴에 없다)", () => {
    expect(actionKeepsMenuOpen("copy")).toBe(true);
    expect(actionKeepsMenuOpen("copy-link")).toBe(true);
    expect(actionKeepsMenuOpen("react-more")).toBe(false);
    expect(actionKeepsMenuOpen("delete")).toBe(false);
    expect(actionKeepsMenuOpen("remind")).toBe(false);
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
