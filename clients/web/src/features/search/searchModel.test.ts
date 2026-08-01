import { describe, expect, it } from "vitest";
import {
  clampQueryForCopy,
  isSearchable,
  leadsWithEllipsis,
  noResultsCopy,
  normalizeQuery,
  QUERY_COPY_MAX_CHARS,
  searchPhase,
  SEARCH_MIN_CHARS,
  snippetSegments,
  trailsWithEllipsis,
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

  it("80 미만은 확실히 안 잘린 것이다", () => {
    // strpos <= 80이면 창 시작은 1이고 offset은 strpos-1이라 80에 닿지 못한다.
    expect(leadsWithEllipsis(0)).toBe(false);
    expect(leadsWithEllipsis(4)).toBe(false);
    expect(leadsWithEllipsis(79)).toBe(false);
  });

  it("본문 첫머리에서 일치한 스니펫에 말줄임을 붙이지 않는다", () => {
    // "금요일 배포는 하지 맙시다"의 배포는 4번째 문자다. 여기에 말줄임이 붙으면
    // 앞에 잘라낸 말이 있는 것처럼 읽히는데, 서버는 아무것도 자르지 않았다.
    // 첫 판본이 `matchOffset > 0`이라 이 캡처가 틀렸었다.
    expect(leadsWithEllipsis(4)).toBe(false);
  });

  it("80은 와이어에서 갈라낼 수 없는 경계이고, 과장이 0자인 쪽을 고른다", () => {
    // strpos == 81 -> 창 시작 1(안 잘림), offset 80
    // strpos >= 82 -> 창 시작 >= 2(잘림),   offset 80
    // 둘이 같은 값을 내므로 구분이 불가능하다. "…"를 붙이면 틀리는 경우는
    // 앞의 하나뿐이고 그때 감춰진 글자는 0자인 반면, 안 붙이면 뒤의 모든
    // 스니펫이 잘린 사실을 숨긴다.
    expect(leadsWithEllipsis(80)).toBe(true);
    expect(leadsWithEllipsis(81)).toBe(true);
  });

  it("뒤가 잘린 스니펫도 말줄임을 갖는다", () => {
    // 창 길이는 char_length(q) + 160으로 묶여 있다. 상한을 꽉 채웠으면 본문이
    // 창 끝까지 이어졌다는 뜻이다. 앞쪽만 붙이고 뒤를 두면 문장이 거기서
    // 끝난 것처럼 읽힌다.
    const q = "배포";
    const capped = "가".repeat(q.length + 160);
    expect(trailsWithEllipsis(capped, q)).toBe(true);
    expect(trailsWithEllipsis("가".repeat(q.length + 159), q)).toBe(false);
    expect(trailsWithEllipsis("짧은 조각", q)).toBe(false);
  });

  it("뒤쪽 판정도 코드포인트로 센다", () => {
    const q = "ab";
    // 이모지는 UTF-16 코드 단위로 둘이라 `.length`로 세면 상한을 일찍 넘긴다.
    expect(trailsWithEllipsis("👋".repeat(q.length + 159), q)).toBe(false);
    expect(trailsWithEllipsis("👋".repeat(q.length + 160), q)).toBe(true);
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

describe("결과 없음 문구", () => {
  it("조사를 골라 붙인다", () => {
    // 받침이 있으면 이, 없으면 가. 뒤따옴표는 발음되지 않으므로 판정에서 빠진다.
    expect(noResultsCopy("로그인")).toContain("'로그인'이 들어간");
    expect(noResultsCopy("배포")).toContain("'배포'가 들어간");
  });

  it("한글이 아닌 끝은 열린 음절로 다룬다", () => {
    // 공용 헬퍼(lib/koreanParticle)의 규칙 그대로다: 라틴·이모지·숫자로 끝나면
    // 받침 없음으로 본다. 영어 단어에는 이것이 한국 독자가 기대하는 형태다.
    expect(noResultsCopy("deploy")).toContain("'deploy'가 들어간");
    expect(noResultsCopy("v2")).toContain("'v2'가 들어간");
  });

  it("[알려진 한계] 숫자로 끝나는 질의는 주격에서 읽히지 않는다", () => {
    // "031"은 "공삼일"로 읽히므로 엄밀히는 '031이'가 맞다. 공용 헬퍼에서 숫자를
    // 소리로 읽는 것은 `directionParticle`(로/으로)뿐이고 `attachParticle`은
    // 아니다. 이 배치에서 고치지 않는 이유는 그 함수가 기존 호출처 7곳의
    // 출력을 함께 바꾸기 때문이다. 여기서 두 번째 규칙을 세우면 리뷰가 지적한
    // 바로 그 문제(판정이 두 벌로 갈라짐)를 다시 만든다.
    expect(noResultsCopy("031")).toContain("'031'가 들어간");
  });

  it("'이(가)' 같은 회피형을 쓰지 않는다", () => {
    // 기계가 독자 앞에서 결정을 거부한 자국.
    for (const q of ["로그인", "배포", "deploy", "5"]) {
      expect(noResultsCopy(q)).not.toMatch(/\(가\)|\(이\)|이\(가\)/);
    }
  });

  it("붙여넣은 문단이 헤드라인이 되지 않는다", () => {
    const paragraph = "가".repeat(400);
    const copy = noResultsCopy(paragraph);
    expect(copy.length).toBeLessThan(120);
    expect(copy).toContain("…");
  });

  it("자를 때도 코드포인트로 센다", () => {
    const emoji = "👋".repeat(100);
    const clamped = clampQueryForCopy(emoji);
    // 반 토막 난 서러게이트가 남지 않는다.
    expect([...clamped].every((c) => c === "👋" || c === "…")).toBe(true);
    expect(Array.from(clamped).length).toBe(QUERY_COPY_MAX_CHARS + 1);
  });

  it("짧은 질의는 그대로 둔다", () => {
    expect(clampQueryForCopy("배포")).toBe("배포");
  });
});
