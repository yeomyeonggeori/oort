import { describe, expect, it } from "vitest";
import {
  CLICKABLE_OUTCOME,
  readClickableOutcome,
  readNotificationClick,
} from "./bannerClick";

// #5059: 셸이 배너의 클릭에 대해 하는 말의 어휘와 읽기. Rust 쪽(`notification.rs` 의 `ClickableOutcome`)이 소문자로
// 직렬화하는 세 단어를 여기서도 글자 그대로 적는다 — 한쪽만 바뀌면 앱 안에서만 조용히 죽는다.

describe("CLICKABLE_OUTCOME", () => {
  it("셸이 직렬화하는 세 단어와 한 글자도 다르지 않다", () => {
    expect(CLICKABLE_OUTCOME).toEqual({
      clickable: "clickable",
      plain: "plain",
      refused: "refused",
    });
  });
});

describe("readClickableOutcome", () => {
  it("뜬 두 말(`clickable`·`plain`)은 그대로 읽는다", () => {
    expect(readClickableOutcome("clickable")).toBe("clickable");
    expect(readClickableOutcome("plain")).toBe("plain");
  });

  it("`refused` 와, 모르는 말·모양이 틀린 값은 모두 「뜨지 않았다」로 읽는다", () => {
    for (const value of [
      "refused",
      "maybe",
      "Clickable",
      " plain",
      "",
      true,
      1,
      null,
      undefined,
      {},
      ["clickable"],
    ]) {
      expect(readClickableOutcome(value), JSON.stringify(value)).toBe("refused");
    }
  });
});

describe("readNotificationClick", () => {
  it("id 와 target 이 둘 다 문자열인 객체를 그대로 돌려준다", () => {
    expect(readNotificationClick({ id: "n-abc-1", target: "/c/0a?msg=ff" })).toEqual({
      id: "n-abc-1",
      target: "/c/0a?msg=ff",
    });
  });

  it("딸린 필드는 버리고 두 값만 돌려준다", () => {
    expect(readNotificationClick({ id: "n-1", target: "/c/0a", extra: "x" })).toStrictEqual({
      id: "n-1",
      target: "/c/0a",
    });
  });

  it("객체가 아니거나 둘 중 하나가 문자열이 아니면 `null` 이다", () => {
    for (const value of [
      null,
      undefined,
      "n-1",
      7,
      true,
      [],
      {},
      { id: "n-1" },
      { target: "/c/0a" },
      { id: 1, target: "/c/0a" },
      { id: "n-1", target: 1 },
      { id: null, target: "/c/0a" },
      { id: "n-1", target: undefined },
    ]) {
      expect(readNotificationClick(value), JSON.stringify(value)).toBeNull();
    }
  });
});
