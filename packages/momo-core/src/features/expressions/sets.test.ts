import { describe, expect, it } from "vitest";
import { EXPRESSION_SET_MIN_SIZE, expressionSetPrefix, groupExpressionSets } from "./sets";

// 세트 앞머리 규칙 (ADR-0218 §12 L9, 읽기만 하는 기준 핀 442b3da27): `<prefix>_<나머지>`, prefix는 ^[a-z0-9]{2,12}$, 나머지는 1자 이상,
// 공통 태그는 칸 태그 앞에 합쳐진다. 묶는 열쇠는 앞머리이고 이름표는 모든 칸이 함께 가진 첫 태그(없으면 앞머리)다.

const entry = (name: string, tags: string[] = []) => ({ name, tags });

describe("expressionSetPrefix — L9의 이름 모양", () => {
  it("첫 _ 앞의 낱말이 앞머리이고, 나머지는 1자 이상이다", () => {
    expect(expressionSetPrefix("cat_hello")).toBe("cat");
    expect(expressionSetPrefix("cat_hello_world")).toBe("cat");
    expect(expressionSetPrefix("cat_1")).toBe("cat");
    expect(expressionSetPrefix("a1_b-c")).toBe("a1");
    expect(expressionSetPrefix("abcdefghijkl_x")).toBe("abcdefghijkl");
  });
  it("앞머리 길이 2~12, 영문 소문자·숫자만, 나머지가 비면 앞머리가 아니다", () => {
    expect(expressionSetPrefix("c_hello")).toBeNull();
    expect(expressionSetPrefix("abcdefghijklm_x")).toBeNull();
    expect(expressionSetPrefix("cat_")).toBeNull();
    expect(expressionSetPrefix("Cat_hello")).toBeNull();
    expect(expressionSetPrefix("cat-hello")).toBeNull();
    expect(expressionSetPrefix("hello")).toBeNull();
    expect(expressionSetPrefix("_hello")).toBeNull();
    expect(expressionSetPrefix("고양이_hello")).toBeNull();
  });
});

describe("groupExpressionSets — 같은 앞머리를 둘 이상 가진 등록이 한 묶음", () => {
  const items = [
    entry("cat_wave", ["고양이", "귀여움"]),
    entry("solo_one"),
    entry("dog_a", ["강아지"]),
    entry("cat_nap", ["고양이"]),
    entry("plain"),
    entry("dog_b", ["산책"]),
    entry("cat_eat", ["Cat", "고양이"]),
  ];
  const grouping = groupExpressionSets(items);
  it("묶음은 첫 등록이 나온 차례이고 묶음 안의 차례는 들어온 그대로다", () => {
    expect(grouping.sets.map((set) => set.prefix)).toEqual(["cat", "dog"]);
    expect(grouping.sets[0].items.map((item) => item.name)).toEqual(["cat_wave", "cat_nap", "cat_eat"]);
    expect(grouping.sets[1].items.map((item) => item.name)).toEqual(["dog_a", "dog_b"]);
  });
  it("앞머리가 없거나 혼자인 등록은 낱개로 남는다(들어온 차례)", () => {
    expect(grouping.loose.map((item) => item.name)).toEqual(["solo_one", "plain"]);
    expect(EXPRESSION_SET_MIN_SIZE).toBe(2);
  });
  it("이름표는 모든 칸이 함께 가진 첫 태그이고, 함께 가진 태그가 없으면 앞머리다", () => {
    expect(grouping.sets[0].label).toBe("고양이");
    expect(grouping.sets[1].label).toBe("dog");
  });
  it("모든 등록은 묶음이나 낱개 정확히 한 곳에 있다", () => {
    const placed = [...grouping.sets.flatMap((set) => set.items), ...grouping.loose];
    expect(placed.length).toBe(items.length);
    expect(new Set(placed).size).toBe(items.length);
    for (const item of items) expect(placed.filter((other) => other === item)).toHaveLength(1);
  });
  it("태그 비교는 대소문자를 가리지 않고, 보이는 글자는 첫 칸의 것이다", () => {
    const out = groupExpressionSets([entry("fox_a", ["Fox"]), entry("fox_b", ["fox"])]);
    expect(out.sets).toHaveLength(1);
    expect(out.sets[0].label).toBe("Fox");
  });
  it("빈 목록과 낱개뿐인 목록은 묶음이 없다", () => {
    expect(groupExpressionSets([])).toEqual({ sets: [], loose: [] });
    const lone = [entry("aa_one"), entry("bb_one")];
    expect(groupExpressionSets(lone)).toEqual({ sets: [], loose: lone });
  });
});
