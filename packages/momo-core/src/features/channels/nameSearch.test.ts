import { describe, expect, it } from "vitest";
import { looseTailIncludes, looseTailMatches, nameMatchTier } from "./nameSearch";

// ADR-0225 D12: 「디자인」을 치는 여섯 단계에서 이름이 목록에 남는다.
describe("looseTailMatches — 한글 조합 중 마지막 글자만 느슨하게", () => {
  it.each([
    ["ㄷ", true],
    ["디", true],
    ["딪", true],
    ["디ㅈ", true],
    ["디자", true],
    ["디장", true],
    ["디자이", true],
    ["디자인", true],
  ])("「디자인」을 치는 중 `%s` → 「디자인」이 남는다: %s", (query, kept) => {
    expect(looseTailIncludes(query, "디자인")).toBe(kept);
  });

  it.each([
    ["ㄷ", true],
    ["디", true],
    ["딪", true],
    ["디ㅈ", true],
    ["디자", false],
    ["디장", false],
    ["디자이", false],
    ["디자인", false],
  ])("무관한 「디저트」는 `%s` → %s (`디자`부터 빠진다)", (query, kept) => {
    expect(looseTailIncludes(query, "디저트")).toBe(kept);
  });

  it("받침이 다음 글자의 첫소리로 넘어가는 칸의 구간을 돌려준다", () => {
    expect(looseTailMatches("디장", "디자인")).toEqual([{ start: 0, end: 3 }]);
    expect(looseTailMatches("자이", "디자인")).toEqual([{ start: 1, end: 3 }]);
  });

  it("겹받침은 앞 받침이 남고 뒤 받침이 넘어간다 (`닭` → `달기`)", () => {
    expect(looseTailIncludes("닭", "달기")).toBe(true);
    expect(looseTailIncludes("닭", "달가")).toBe(true); // ㄱ 첫소리 글자
    expect(looseTailIncludes("닭", "달나")).toBe(false);
    expect(looseTailIncludes("값", "가시")).toBe(false); // ㅂ 받침이 남지 않았다
    expect(looseTailIncludes("값", "갑시")).toBe(true);
  });

  it("받침 없는 마지막 글자는 이름의 받침 있는 같은 글자에 맞는다", () => {
    expect(looseTailIncludes("디자이", "디자인")).toBe(true);
    expect(looseTailIncludes("디자이", "디자임")).toBe(true);
    expect(looseTailIncludes("디자이", "디자어")).toBe(false);
  });

  it("홀로 선 자음은 그 자음이 첫소리인 글자에 맞는다", () => {
    expect(looseTailIncludes("디ㅈ", "디자인")).toBe(true);
    expect(looseTailIncludes("디ㅈ", "디어")).toBe(false);
    // 받침 자리의 ㅇ 은 첫소리가 아니다.
    expect(looseTailIncludes("ㅇ", "강")).toBe(false);
  });

  it("앞 글자는 글자 그대로다: 받침을 옮겨 붙이지 않고 초성 검색도 없다", () => {
    expect(looseTailIncludes("안자", "아니자")).toBe(false);
    expect(looseTailIncludes("ㄷㅈㅇ", "디자인")).toBe(false);
    expect(looseTailIncludes("자디", "디자인")).toBe(false);
  });

  it("마지막 글자가 한글이 아니면 아무것도 맞추지 않는다 (지금 견줌의 몫)", () => {
    expect(looseTailMatches("design", "design-review")).toEqual([]);
    expect(looseTailMatches("디자인-", "디자인-리뷰")).toEqual([]);
    expect(looseTailMatches("", "디자인")).toEqual([]);
  });

  it("앞의 글자들은 서버와 같은 접기로 맞춘다 (대소문자·전각·풀어쓴 한글)", () => {
    expect(looseTailIncludes("ＡＢ디장", "ab디자인")).toBe(true);
    // 풀어쓴(NFD) 한글 질의도 NFC 로 모은 뒤 견준다.
    expect(looseTailIncludes("디장".normalize("NFD"), "디자인")).toBe(true);
  });

  it("이름 한가운데도 찾는다", () => {
    expect(looseTailMatches("리뷰", "디자인-리뷰")).toEqual([{ start: 4, end: 6 }]);
    expect(looseTailMatches("-리", "디자인-리뷰")).toEqual([{ start: 3, end: 5 }]);
  });

  it("앞 글자는 받침까지 글자 그대로다 (마지막 글자 앞의 받침은 느슨하지 않다)", () => {
    expect(looseTailIncludes("가시", "갑시다")).toBe(false);
    expect(looseTailIncludes("디자이", "딘자인")).toBe(false);
  });

  it.each([
    ["호", "회의"], ["호", "화면"], ["고", "관리"], ["우", "원격"], ["으", "의견"],
    ["회으", "회의"], ["기호", "기획"],
  ])("겹모음을 치는 도중 `%s` 에서 「%s」가 남는다", (query, name) => {
    expect(looseTailIncludes(query, name)).toBe(true);
  });

  it.each([
    ["달", "닭갈비"], ["갑", "값어치"], ["안", "앉은자리"], ["업", "없는것"], ["일", "읽을거리"],
  ])("홑받침에서 겹받침으로 가는 도중 `%s` 에서 「%s」가 남는다", (query, name) => {
    expect(looseTailIncludes(query, name)).toBe(true);
  });

  it("겹모음·겹받침 느슨함은 이어 붙는 자모에만 열린다", () => {
    expect(looseTailIncludes("호", "해외")).toBe(false);
    expect(looseTailIncludes("달", "딸기")).toBe(false);
    expect(looseTailIncludes("고", "구름")).toBe(false);
  });

  it("낱자 하나는 이름의 첫 글자(또는 낱말 첫 글자)의 첫소리에만 맞는다", () => {
    expect(looseTailIncludes("ㄱ", "공지")).toBe(true);
    expect(looseTailIncludes("ㄱ", "기획-공지")).toBe(true);
    expect(looseTailIncludes("ㄱ", "디자인")).toBe(false);
    expect(looseTailIncludes("ㄱ", "회고")).toBe(false); // 이름 가운데 글자의 첫소리
    // 두 글자부터는 이름 가운데도 맞는다 (`디ㅈ` ↔ 디자인).
    expect(looseTailIncludes("디ㅈ", "새디자인")).toBe(true);
  });
});

describe("nameMatchTier — 글자 그대로가 느슨함 앞", () => {
  it("글자 그대로 맞으면 strict, 느슨하게만 맞으면 loose, 아니면 null", () => {
    expect(nameMatchTier(true, "복", "복지")).toBe("strict");
    expect(nameMatchTier(false, "복", "보고")).toBe("loose");
    expect(nameMatchTier(false, "복", "디자인")).toBeNull();
  });
});
