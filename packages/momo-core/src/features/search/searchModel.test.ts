import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import {
  channelIdInPath,
  channelScopeRefusalCopy,
  clampQueryForCopy,
  defaultSearchScope,
  isChannelScopeRefusal,
  parseSearchScope,
  isSearchable,
  leadsWithEllipsis,
  noResultsCopy,
  normalizeQuery,
  QUERY_COPY_MAX_CHARS,
  scopedChannelId,
  searchPhase,
  searchPlaceholder,
  scopeChannelName,
  searchQueryKey,
  searchRoutePath,
  SEARCH_CHANNEL_PARAM,
  SEARCH_SCOPE_ALL,
  SEARCH_SCOPE_PARAM,
  searchScopeLabel,
  searchScopeParams,
  searchScopeTabs,
  SEARCH_MIN_CHARS,
  SEARCH_SCOPES,
  snippetSegments,
  trailsWithEllipsis,
  type SearchChannelContext,
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

// ---------------------------------------------------------------------------
// 검색 범위 (BT-3 / #1931)
// ---------------------------------------------------------------------------

const CHANNEL: SearchChannelContext = {
  channelId: "0199C0FF-EE00-7000-8000-000000000001",
  label: "#배포",
  isDirect: false,
  peer: null,
};
const DM: SearchChannelContext = {
  channelId: "0199C0FF-EE00-7000-8000-000000000002",
  label: "김인턴",
  isDirect: true,
  peer: "김인턴",
};
/** 디렉터리가 아직 안 왔거나 실패한 DM — `channelLabel`이 사람 이름을 못 준다. */
const DM_NO_PEER: SearchChannelContext = {
  channelId: "0199C0FF-EE00-7000-8000-000000000003",
  label: "다이렉트 메시지",
  isDirect: true,
  peer: null,
};
/** 동명이인이라 라벨에 핸들이 붙은 DM. 사람 이름은 라벨이 아니라 `peer`다. */
const DM_AMBIGUOUS: SearchChannelContext = {
  channelId: "0199C0FF-EE00-7000-8000-000000000004",
  label: "김민지 @minji",
  isDirect: true,
  peer: "김민지",
};
/** 목록에서 못 푼 채널 — 이름을 모른다. 내부 id로 대신하지 않는다. */
const UNRESOLVED: SearchChannelContext = {
  channelId: "0199C0FF-EE00-7000-8000-000000000005",
  label: null,
  isDirect: false,
  peer: null,
};

describe("검색 범위", () => {
  it("채널 문맥을 들고 오면 그 채널이 기본이다", () => {
    expect(defaultSearchScope(CHANNEL)).toBe("channel");
    expect(defaultSearchScope(DM)).toBe("channel");
    // 문맥 없이 들어오면 좁힐 대상이 없다.
    expect(defaultSearchScope(null)).toBe("workspace");
  });

  it("칩은 둘, 기본값이 먼저다", () => {
    expect(SEARCH_SCOPES).toEqual(["channel", "workspace"]);
  });

  it("DM이면 「채널」이 아니라 「대화」다", () => {
    expect(searchScopeLabel("channel", CHANNEL)).toBe("이 채널에서");
    expect(searchScopeLabel("channel", DM)).toBe("이 대화에서");
    expect(searchScopeLabel("workspace", CHANNEL)).toBe("전체");
    expect(searchScopeLabel("workspace", DM)).toBe("전체");
  });

  it("칩에는 채널 이름을 넣지 않는다", () => {
    // 알약 폭이 이름을 따라 출렁이고 긴 이름은 잘린다. 이름이 실제로 도움이
    // 되는 자리는 안내문과 빈 결과 문구다.
    const long: SearchChannelContext = {
      ...CHANNEL,
      label: "#프로젝트-알림-정말-긴-이름",
    };
    expect(searchScopeLabel("channel", long)).not.toContain(long.label);
    // 대신 tablist의 접근성 이름이 그 이름을 든다 — 이쪽은 잘리지 않는다.
    expect(searchScopeTabs(long).label).toContain(long.label);
  });

  it("탭 명세는 공용 컨트롤이 요구하는 네 규칙을 다 채운다", () => {
    const spec = searchScopeTabs(CHANNEL);
    for (const scope of spec.values) {
      expect(spec.tabId(scope)).toMatch(/^search-scope-tab-/);
      expect(spec.testId(scope)).toBe(`search-scope-${scope}`);
      expect(spec.labelFor(scope).length).toBeGreaterThan(0);
    }
    // 결과 패널은 하나다: 범위를 바꿔도 목록은 같은 자리에서 갈린다.
    expect(spec.panelId("channel")).toBe(spec.panelId("workspace"));
  });

  it("문맥이 없으면 채널 칩이 어느 채널도 가리키지 못한다", () => {
    // 그때 칩은 화면에 없어야 하고, 실수로 렌더돼도 요청은 좁혀지지 않는다.
    expect(scopedChannelId("channel", null)).toBeUndefined();
  });
});

describe("범위 → 요청 파라미터", () => {
  it("전체 범위는 channel= 을 아예 붙이지 않는다", () => {
    expect(scopedChannelId("workspace", CHANNEL)).toBeUndefined();
  });

  it("채널 범위는 그 채널 id를 싣는다", () => {
    expect(scopedChannelId("channel", CHANNEL)).toBe(CHANNEL.channelId);
    expect(scopedChannelId("channel", DM)).toBe(DM.channelId);
  });
});

describe("범위 전환은 커서를 버린다", () => {
  const WS = "0199A000-0000-7000-8000-00000000000A";

  it("범위가 다르면 캐시 키가 다르다", () => {
    const wide = searchQueryKey(WS, "배포", undefined);
    const narrow = searchQueryKey(WS, "배포", CHANNEL.channelId);
    // 이것이 커서 초기화의 전부다. 키가 같으면 tanstack이 이전 범위의 페이지와
    // 커서를 그대로 들고 있다가 다음 「더 보기」에 그 커서를 실어 보내고, 서버가
    // 스코프 봉인 400으로 답한다 — 사람 눈에는 검색이 고장 난 것으로 보인다.
    expect(narrow).not.toEqual(wide);
  });

  it("채널이 다르면 캐시 키도 다르다", () => {
    expect(searchQueryKey(WS, "배포", CHANNEL.channelId)).not.toEqual(
      searchQueryKey(WS, "배포", DM.channelId)
    );
  });

  it("전체 범위 키는 자리를 비우지 않는다", () => {
    // `undefined`를 그대로 두면 직렬화에서 그 자리가 사라져 옛 3원소 키와
    // 같아진다 — 좁힌 페이지가 전체 캐시에 섞인다.
    const wide = searchQueryKey(WS, "배포", undefined);
    expect(wide).toHaveLength(4);
    expect(wide[3]).toBeNull();
  });

  it("같은 요청이면 같은 키다", () => {
    expect(searchQueryKey(WS, "배포", CHANNEL.channelId)).toEqual(
      searchQueryKey(WS.toLowerCase(), "배포", CHANNEL.channelId.toLowerCase())
    );
  });
});

describe("빈 결과는 범위를 말한다", () => {
  it("전체에서 빈손이면 지금까지의 그 문장이다", () => {
    expect(noResultsCopy("배포")).toBe(
      "'배포'가 들어간 메시지를 찾지 못했습니다."
    );
    expect(noResultsCopy("배포", "workspace", CHANNEL)).toBe(
      "'배포'가 들어간 메시지를 찾지 못했습니다."
    );
  });

  it("좁힌 범위에서 빈손이면 **어느 채널에서** 못 찾았는지 말한다", () => {
    // R1 H-1: 「이 채널에는」으로만 말하던 판본에서는 그 화면 어디에도 채널
    // 이름이 없었다. 결과가 있을 때는 행마다 이름이 붙어 우연히 메워지고,
    // 정작 어디서 못 찾았는지가 중요한 것은 결과가 없는 쪽이다.
    const copy = noResultsCopy("배포", "channel", CHANNEL);
    expect(copy).toContain("#배포에는");
    expect(copy).toContain("'배포'가");
    expect(copy).not.toBe("'배포'가 들어간 메시지를 찾지 못했습니다.");
  });

  it("DM이면 사람 이름과 존칭으로 말한다", () => {
    expect(noResultsCopy("배포", "channel", DM)).toContain(
      "김인턴님과의 대화에는"
    );
  });

  it("이름을 모르면 이름 없이 말한다", () => {
    // 못 푼 채널·디렉터리 미도착 DM. 내부 id를 문장에 세우지 않는다(R1 M-1).
    const unresolved = noResultsCopy("배포", "channel", UNRESOLVED);
    expect(unresolved).toContain("이 채널에는");
    expect(unresolved).not.toContain(UNRESOLVED.channelId.slice(0, 8));

    const noPeer = noResultsCopy("배포", "channel", DM_NO_PEER);
    expect(noPeer).toContain("이 대화에는");
    // 「다이렉트 메시지님과의 대화에는」은 사람 이름이 아닌 것에 존칭을 붙인 말이다.
    expect(noPeer).not.toContain("다이렉트 메시지님");
  });

  it("좁힌 문구에서도 조사는 골라 붙인다", () => {
    expect(noResultsCopy("로그인", "channel", CHANNEL)).toContain("'로그인'이");
    expect(noResultsCopy("deploy", "channel", DM)).toContain("'deploy'가");
    expect(noResultsCopy("배포", "channel", CHANNEL)).not.toMatch(
      /\(가\)|\(이\)/
    );
  });

  it("좁힌 문구도 붙여넣은 문단을 헤드라인으로 만들지 않는다", () => {
    const copy = noResultsCopy("가".repeat(400), "channel", CHANNEL);
    expect(copy.length).toBeLessThan(120);
    expect(copy).toContain("…");
  });
});

describe("입력 안내문", () => {
  it("좁혀 있으면 어느 채널인지 이름으로 말한다", () => {
    expect(searchPlaceholder("channel", CHANNEL)).toBe("#배포에서 검색");
    expect(searchPlaceholder("channel", DM)).toBe("김인턴님과의 대화에서 검색");
  });

  it("전체이거나 문맥이 없으면 지금까지의 안내문이다", () => {
    expect(searchPlaceholder("workspace", CHANNEL)).toBe("메시지 내용으로 검색");
    expect(searchPlaceholder("channel", null)).toBe("메시지 내용으로 검색");
  });
});

describe("존칭은 사람에게만 붙는다", () => {
  it("상대를 못 찾은 DM은 존칭 없는 문장으로 물러난다", () => {
    // R1 H-2: `channelLabel`은 상대를 못 찾으면 「다이렉트 메시지」를 돌려준다.
    // 거기에 「님」을 기계적으로 붙이면 「다이렉트 메시지님과의 대화에서 검색」이
    // 난다 — 디렉터리가 늦거나 실패하는, 흔한 상태에서.
    expect(searchPlaceholder("channel", DM_NO_PEER)).toBe("이 대화에서 검색");
    expect(searchPlaceholder("channel", DM_NO_PEER)).not.toContain("님");
    expect(scopeChannelName("channel", DM_NO_PEER)).toBeNull();
  });

  it("동명이인이라 핸들이 붙은 라벨에도 존칭이 핸들 뒤에 붙지 않는다", () => {
    // 라벨은 「김민지 @minji」이지만 사람 이름은 「김민지」다. 라벨에 붙이면
    // 「김민지 @minji님과의 대화에서 검색」이 난다.
    expect(searchPlaceholder("channel", DM_AMBIGUOUS)).toBe(
      "김민지님과의 대화에서 검색"
    );
    expect(searchPlaceholder("channel", DM_AMBIGUOUS)).not.toContain("@minji님");
  });

  it("채널에는 존칭이 없다", () => {
    expect(searchPlaceholder("channel", CHANNEL)).not.toContain("님");
    expect(scopeChannelName("channel", CHANNEL)).toBe("#배포");
  });
});

describe("이름을 모르는 채널", () => {
  it("안내문이 내부 id를 세우지 않는다", () => {
    // R1 M-1: 1차 판본은 「019f9c99에서 검색」이라 적었다. 사람에게 아무것도
    // 말하지 않으면서 내부 식별자를 문장에 세운다.
    const copy = searchPlaceholder("channel", UNRESOLVED);
    expect(copy).toBe("이 채널에서 검색");
    expect(copy).not.toContain(UNRESOLVED.channelId.slice(0, 8));
  });

  it("접근성 이름도 내부 id를 세우지 않는다", () => {
    const label = searchScopeTabs(UNRESOLVED).label;
    expect(label).toBe("검색 범위");
    expect(label).not.toContain(UNRESOLVED.channelId.slice(0, 8));
  });

  it("이름을 알 때는 접근성 이름이 그것을 든다", () => {
    expect(searchScopeTabs(CHANNEL).label).toBe("검색 범위(#배포)");
  });
});

describe("좁힌 범위의 404는 「기능 미제공」이 아니다", () => {
  const notFound = new ApiError(404, "channel not found");

  it("범위가 채널일 때의 404만 이 갈래다", () => {
    // R1 B-3: 1차 판본은 이 404를 `serverSaysAbsent`(404·405·501)로 흘려
    // 「이 서버는 아직 메시지 검색을 제공하지 않습니다」를 그렸다. 서버는 방금
    // 전체 범위로 결과를 돌려줬으므로 그 문장은 거짓이다.
    expect(isChannelScopeRefusal(notFound, "channel", CHANNEL)).toBe(true);
    expect(isChannelScopeRefusal(notFound, "workspace", CHANNEL)).toBe(false);
    expect(isChannelScopeRefusal(notFound, "channel", null)).toBe(false);
  });

  it("다른 상태 코드와 네트워크 실패는 이 갈래가 아니다", () => {
    // 405·501은 여전히 표면 미제공 이야기이고, 5xx·네트워크는 아무도 「없다」고
    // 말하지 않은 것이다.
    for (const status of [401, 403, 405, 500, 501, 503]) {
      expect(
        isChannelScopeRefusal(new ApiError(status, "…"), "channel", CHANNEL)
      ).toBe(false);
    }
    expect(isChannelScopeRefusal(new Error("offline"), "channel", CHANNEL)).toBe(
      false
    );
  });

  it("문장이 볼 수 없는 채널의 이름을 부르지 않는다", () => {
    const copy = channelScopeRefusalCopy(CHANNEL);
    expect(copy.headline).toBe("이 채널의 메시지는 찾을 수 없습니다.");
    expect(copy.headline).not.toContain(CHANNEL.label!);
    // 「채널을 열어 직접 찾아보세요」는 이 오류의 조건 자체와 모순된다.
    expect(copy.detail).not.toContain("채널을 열어");
    expect(copy.detail).toContain("전체를 찾아볼 수 있습니다");
  });

  it("DM이면 「대화」로 말한다", () => {
    expect(channelScopeRefusalCopy(DM).headline).toBe(
      "이 대화의 메시지는 찾을 수 없습니다."
    );
  });
});

describe("범위는 주소에 산다", () => {
  it("문맥이 있고 scope=가 없으면 그 채널이다", () => {
    expect(parseSearchScope(null, CHANNEL)).toBe("channel");
  });

  it("scope=all 이면 전체다", () => {
    expect(parseSearchScope(SEARCH_SCOPE_ALL, CHANNEL)).toBe("workspace");
  });

  it("문맥이 없으면 scope=가 무엇이든 전체다", () => {
    // 파라미터 하나만 손으로 지운 주소가 「채널 범위인데 채널이 없다」는 상태를
    // 만들 수 없어야 한다.
    expect(parseSearchScope(null, null)).toBe("workspace");
    expect(parseSearchScope(SEARCH_SCOPE_ALL, null)).toBe("workspace");
  });

  it("모르는 값은 기본값으로 읽는다", () => {
    expect(parseSearchScope("banana", CHANNEL)).toBe("channel");
  });

  it("승격은 주소에 적히고, 다시 좁히면 지워진다", () => {
    // R1 M-2: 1차 판본은 범위가 `useState`라, 승격한 뒤의 주소가 화면과 반대말을
    // 했다(주소는 channel=…, 화면은 전체 결과). 새로고침하면 기본값이 채널을
    // 다시 골라 사람이 방금 내린 결정을 조용히 되돌렸다.
    const start = new URLSearchParams({
      q: "배포",
      [SEARCH_CHANNEL_PARAM]: CHANNEL.channelId,
    });
    const widened = searchScopeParams(start, "workspace");
    expect(widened.get(SEARCH_SCOPE_PARAM)).toBe(SEARCH_SCOPE_ALL);
    // 문맥은 남는다 — 칩이 사라지면 되돌아갈 길이 없다.
    expect(widened.get(SEARCH_CHANNEL_PARAM)).toBe(CHANNEL.channelId);
    expect(widened.get("q")).toBe("배포");

    const narrowed = searchScopeParams(widened, "channel");
    expect(narrowed.get(SEARCH_SCOPE_PARAM)).toBeNull();
    expect(narrowed.get(SEARCH_CHANNEL_PARAM)).toBe(CHANNEL.channelId);
  });

  it("주소를 되읽으면 같은 범위가 나온다", () => {
    // 새로고침·공유·뒤로가기가 같은 화면을 여는 것은 이 왕복이 닫힌다는 뜻이다.
    for (const scope of ["channel", "workspace"] as const) {
      const written = searchScopeParams(
        new URLSearchParams({ [SEARCH_CHANNEL_PARAM]: CHANNEL.channelId }),
        scope
      );
      expect(parseSearchScope(written.get(SEARCH_SCOPE_PARAM), CHANNEL)).toBe(
        scope
      );
    }
  });

  it("⌘K가 만드는 주소와 칩으로 되좁힌 주소가 같다", () => {
    // 같은 화면이 같은 링크여야 붙여넣기가 뜻을 갖는다.
    const fromPalette = new URLSearchParams(
      searchRoutePath("배포", CHANNEL.channelId).split("?")[1]
    );
    const fromChip = searchScopeParams(
      searchScopeParams(fromPalette, "workspace"),
      "channel"
    );
    expect(fromChip.toString()).toBe(fromPalette.toString());
  });
});

describe("검색 표면으로 가는 주소", () => {
  it("질의도 범위도 없으면 맨 주소다", () => {
    expect(searchRoutePath("")).toBe("/search");
    expect(searchRoutePath("   ")).toBe("/search");
  });

  it("질의는 서버와 같은 방식으로 다듬어 싣는다", () => {
    expect(searchRoutePath("  배포  ")).toBe("/search?q=%EB%B0%B0%ED%8F%AC");
  });

  it("채널을 실으면 도착한 표면이 그 채널로 좁힌다", () => {
    const path = searchRoutePath("배포", CHANNEL.channelId);
    expect(path).toContain(`channel=${CHANNEL.channelId}`);
    expect(path).toContain("q=");
  });

  it("질의 없이 범위만 넘길 수도 있다", () => {
    // 채널에서 ⌘K를 열고 아무것도 치지 않은 채 고른 경우.
    expect(searchRoutePath("", CHANNEL.channelId)).toBe(
      `/search?channel=${CHANNEL.channelId}`
    );
  });

  it("이스케이프는 한 곳에서만 일어난다", () => {
    // 조립이 두 곳이 되면 한쪽만 이스케이프를 잊는 일이 가능해진다.
    expect(searchRoutePath("a&b=c")).toBe("/search?q=a%26b%3Dc");
  });
});

describe("지금 서 있는 채널", () => {
  it("채널 주소에서만 답한다", () => {
    expect(channelIdInPath("/c/0199c0ff-ee00-7000-8000-000000000001")).toBe(
      "0199c0ff-ee00-7000-8000-000000000001"
    );
    expect(channelIdInPath("/c/abc/")).toBe("abc");
  });

  it("채널이 아닌 곳에서는 null이다", () => {
    for (const path of ["/", "/inbox", "/search", "/directory", "/c", "/c/"]) {
      expect(channelIdInPath(path)).toBeNull();
    }
  });

  it("채널 하위 표면은 채널이 아니다", () => {
    // 라우트가 자라도 이 판정이 자동으로 넓어지지 않는다.
    expect(channelIdInPath("/c/abc/thread/def")).toBeNull();
  });

  it("주소에 인코딩된 id를 되돌린다", () => {
    expect(channelIdInPath(`/c/${encodeURIComponent("a b")}`)).toBe("a b");
  });
});
