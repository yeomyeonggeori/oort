import { describe, expect, it } from "vitest";
import {
  isSearchable,
  leadsWithEllipsis,
  normalizeQuery,
  searchPhase,
  SEARCH_MIN_CHARS,
  snippetSegments,
} from "./searchModel";

// 계약의 출처는 서버 두 파일이다:
//   server-rust/bins/momo-server/src/routes/search.rs
//   server-rust/crates/momo-messaging/src/search.rs

describe("질의 다듬기", () => {
  it("서버와 같은 방식으로 공백을 걷어낸다", () => {
    expect(normalizeQuery("  안녕  ")).toBe("안녕");
    expect(normalizeQuery("\t배포\n")).toBe("배포");
  });

  it("2자 미만은 보내지 않는다: 서버가 400으로 거절할 것을 알기 때문이다", () => {
    expect(SEARCH_MIN_CHARS).toBe(2);
    expect(isSearchable("")).toBe(false);
    expect(isSearchable(" ")).toBe(false);
    expect(isSearchable("a")).toBe(false);
    expect(isSearchable(" 배 ")).toBe(false);
    expect(isSearchable("ab")).toBe(true);
    expect(isSearchable("배포")).toBe(true);
  });

  it("길이를 코드포인트로 센다: 서버가 chars().count()로 세기 때문이다", () => {
    // 이모지 하나는 UTF-16 코드 단위로는 둘이다. `.length`로 세면 서버가 400을
    // 답할 질의를 보낼 수 있게 되고, 그 400이 오류 문구로 그려진다.
    expect("👋".length).toBe(2);
    expect(isSearchable("👋")).toBe(false);
    expect(isSearchable("👋👋")).toBe(true);
  });
});

describe("스니펫 강조", () => {
  it("서버가 준 위치에서 질의 길이만큼 자른다", () => {
    expect(snippetSegments("어제 배포한 빌드", 3, "배포")).toEqual({
      before: "어제 ",
      match: "배포",
      after: "한 빌드",
    });
  });

  it("오프셋을 코드포인트로 센다", () => {
    // "👋👋 배포": 서버는 배포를 문자 3번째로 센다. UTF-16으로 자르면 5가 되어
    // 강조가 두 칸 밀린다.
    const segments = snippetSegments("👋👋 배포", 3, "배포");
    expect(segments.match).toBe("배포");
    expect(segments.before).toBe("👋👋 ");
  });

  it("값이 이상하면 강조를 버리고 본문을 살린다", () => {
    // strpos가 0을 답하는 드문 짝에서 서버 산술은 -1을 낼 수 있다.
    expect(snippetSegments("본문", -1, "본")).toEqual({
      before: "본문",
      match: "",
      after: "",
    });
    expect(snippetSegments("본문", 99, "본")).toEqual({
      before: "본문",
      match: "",
      after: "",
    });
    expect(snippetSegments("본문", 1.5, "본")).toEqual({
      before: "본문",
      match: "",
      after: "",
    });
    expect(snippetSegments("본문", 0, "")).toEqual({
      before: "본문",
      match: "",
      after: "",
    });
  });

  it("일치가 스니펫 끝을 넘어가도 잘라낸 만큼만 강조한다", () => {
    expect(snippetSegments("배포", 0, "배포한다")).toEqual({
      before: "",
      match: "배포",
      after: "",
    });
  });

  it("앞이 잘린 스니펫만 말줄임을 갖는다", () => {
    // 서버 창은 greatest(strpos - 80, 1)에서 열린다. 일치가 앞쪽 81자 안이면
    // 창은 1에서 시작하므로 자른 것이 없고, offset은 80보다 작다. 그보다 뒤면
    // offset은 정확히 80이 된다.
    expect(leadsWithEllipsis(0)).toBe(false);
    expect(leadsWithEllipsis(4)).toBe(false);
    expect(leadsWithEllipsis(79)).toBe(false);
    expect(leadsWithEllipsis(80)).toBe(true);
  });

  it("본문 첫머리에서 일치한 스니펫에 말줄임을 붙이지 않는다", () => {
    // "금요일 배포는 하지 맙시다"의 배포는 4번째 문자다. 여기에 말줄임이 붙으면
    // 앞에 잘라낸 말이 있는 것처럼 읽히는데, 서버는 아무것도 자르지 않았다.
    expect(leadsWithEllipsis(4)).toBe(false);
  });
});

describe("표면 상태", () => {
  const base = {
    raw: "배포",
    isFetching: false,
    hasError: false,
    hitCount: 0,
    settled: true,
  };

  it("입력 전과 너무 짧은 입력은 다른 상태다", () => {
    expect(searchPhase({ ...base, raw: "" })).toBe("idle");
    expect(searchPhase({ ...base, raw: "  " })).toBe("idle");
    expect(searchPhase({ ...base, raw: "배" })).toBe("tooShort");
  });

  it("결과가 없으면 결과 없음이지 오류가 아니다", () => {
    expect(searchPhase({ ...base, hitCount: 0 })).toBe("empty");
    expect(searchPhase({ ...base, hitCount: 3 })).toBe("results");
  });

  it("답을 받기 전에는 결과 없음이라고 말하지 않는다", () => {
    // settled=false로 empty를 그리면, 첫 요청이 날아가는 동안 화면이 "찾지
    // 못했습니다"를 한 프레임 보여준다.
    expect(searchPhase({ ...base, settled: false })).toBe("searching");
  });

  it("재시도가 날아가는 동안에는 오류보다 로딩을 먼저 말한다", () => {
    expect(
      searchPhase({ ...base, isFetching: true, hasError: true, hitCount: 0 })
    ).toBe("searching");
    expect(searchPhase({ ...base, hasError: true, settled: false })).toBe("error");
  });

  it("짧은 입력은 앞선 오류를 덮는다: 지우는 중에 빨간 줄이 남지 않는다", () => {
    expect(searchPhase({ ...base, raw: "배", hasError: true })).toBe("tooShort");
  });
});
