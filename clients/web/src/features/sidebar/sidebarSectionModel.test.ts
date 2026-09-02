import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  countSectionActionTabStops,
  sectionUnreadTotals,
  shouldShowSectionActions,
} from "./sidebarSectionModel";

const sectionSource = readFileSync(
  fileURLToPath(new URL("./SidebarRow.tsx", import.meta.url)),
  "utf8"
);
const sidebarSource = readFileSync(
  fileURLToPath(new URL("./Sidebar.tsx", import.meta.url)),
  "utf8"
);

describe("shouldShowSectionActions", () => {
  const rest = {
    pointerCanHover: true,
    headerHovered: false,
    headerKeyboardFocused: false,
    overlayOpen: false,
  };

  it("포인터 rest 헤더에는 안 뜬다", () => {
    expect(shouldShowSectionActions(rest)).toBe(false);
  });

  it("hover 또는 키보드 포커스이면 뜬다", () => {
    expect(shouldShowSectionActions({ ...rest, headerHovered: true })).toBe(
      true
    );
    expect(
      shouldShowSectionActions({ ...rest, headerKeyboardFocused: true })
    ).toBe(true);
  });

  it("열린 오버레이가 있으면 포인터가 떠나도 유지한다", () => {
    expect(shouldShowSectionActions({ ...rest, overlayOpen: true })).toBe(true);
  });

  it("터치에서는 항상 뜬다 (hover 가 없다)", () => {
    expect(
      shouldShowSectionActions({
        ...rest,
        pointerCanHover: false,
        headerHovered: false,
      })
    ).toBe(true);
  });
});

describe("UX-HT 계약 (소스)", () => {
  it("opacity / visibility 트릭으로 숨기지 않는다", () => {
    expect(sectionSource).not.toMatch(/\bopacity-0\b/);
    expect(sectionSource).not.toContain("invisible");
    expect(sectionSource).not.toMatch(/\bvisibility-hidden\b/);
  });

  it("접기는 호버와 별개의 상시 탭 스톱이다", () => {
    expect(sectionSource).toContain("data-testid={`section-collapse-${sectionId}`}");
    expect(sectionSource).toContain("shouldShowSectionActions");
  });

  it("overlayOpen 은 섹션 props 이고, 닫힘 전이가 hold 를 푼다 (B-1 / R2-1)", () => {
    expect(sectionSource).not.toContain("useCreateChannelOpen");
    expect(sectionSource).toContain("overlayHeld");
    expect(sectionSource).toContain("overlayOpen: overlayOpen || overlayHeld");
    expect(sectionSource).toContain("requestAnimationFrame");
    expect(sectionSource).not.toMatch(/overlayOpen:\s*false/);
  });

  it("rest 헤더는 컨트롤 높이를 바닥선으로 예약한다 (M-1 / R2-2)", () => {
    // BT-5(#1933)가 이 클래스 목록을 `cn(...)` 으로 바꿨다 - 커스텀 섹션 머리글이
    // 끌리는 손잡이라 커서 하나가 조건부로 붙는다. 재는 것은 그대로 **바닥선**
    // 이므로, 문자열 한 벌 대신 그 낱말을 찾는다.
    expect(sectionSource).toContain(
      '"flex min-h-control-sm items-center gap-1 px-2"'
    );
    expect(sectionSource).not.toMatch(
      /"flex h-control-sm items-center gap-1 px-2"/
    );
    expect(sectionSource).not.toMatch(/rounded-sm py-1 text-left text-meta/);
  });

  it("제목 버튼은 보이는 글자를 이름으로 쓴다 (N-3)", () => {
    expect(sectionSource).not.toContain("aria-label={`${title} 섹션");
    expect(sectionSource).toContain("aria-controls={collapsed ? undefined : listId}");
  });

  it("포인터 클릭 링은 focus-visible 만 쓴다", () => {
    expect(sectionSource).toContain("focus-visible:focus-ring");
    expect(sectionSource).not.toMatch(/className=\{[^}]*\bfocus:focus-ring/);
  });
});

describe("countSectionActionTabStops", () => {
  it("mounted section-action 탭 스톱만 센다", () => {
    const action = { hasAttribute: () => false, tabIndex: 0 };
    const disabled = { hasAttribute: (name: string) => name === "disabled", tabIndex: 0 };
    const root = {
      querySelectorAll: () => [action, disabled],
    } as unknown as ParentNode;
    expect(countSectionActionTabStops(root)).toBe(1);
  });
});

describe("채널 만들기 오버레이 스코프 (R2-1)", () => {
  // BT-4(#1932) 로 섹션이 데이터가 되면서 `sectionId="dms"` 라는 리터럴이 사라졌다
  // (`sectionId={dmSection.id}`). 지키는 사실은 그대로다: **워크스페이스 전역**
  // 열림 상태인 `createChannelOpen` 은 채널 섹션 하나에만 붙는다. 커스텀 섹션이
  // 자기 메뉴·다이얼로그로 `overlayOpen` 을 갖는 것은 정반대의 것이라(자기
  // 오버레이) 이 규칙에 걸리지 않는다.
  it("전역 열림 상태는 채널 섹션에만 배선한다", () => {
    expect(sidebarSource).toContain("useCreateChannelOpen");

    const overlayProps = sidebarSource.match(/overlayOpen=\{[^}]*\}/g) ?? [];
    const globalFlagUses = overlayProps.filter((prop) =>
      prop.includes("createChannelOpen")
    );
    expect(globalFlagUses).toHaveLength(1);
    // 그 하나는 기본 채널 섹션의 것이다.
    const channelBlock =
      sidebarSource.split("sectionId={baseChannelSection.id}")[1] ?? "";
    expect(channelBlock.slice(0, channelBlock.indexOf("</SidebarSection>"))).toContain(
      globalFlagUses[0]
    );

    const dmBlock = sidebarSource.split("sectionId={dmSection.id}")[1] ?? "";
    const dmHeader = dmBlock.slice(0, dmBlock.indexOf("</SidebarSection>"));
    expect(dmHeader).not.toBe("");
    expect(dmHeader).not.toContain("overlayOpen");
  });
});

describe("sectionUnreadTotals", () => {
  it("접힌 섹션이 헤더에 올릴 합을 낸다", () => {
    expect(
      sectionUnreadTotals([
        { unreadCount: 5, mentionCount: 1 },
        { unreadCount: 2, mentionCount: 0 },
      ])
    ).toEqual({ unreadCount: 7, mentionCount: 1 });
  });
});

// =============================================================================
// design-review #1932 R1 — 배선 회귀 (소스 스캔).
//
// 이 셋은 **행동 시험이 닿지 않는 자리**다. Sidebar 는 세션·셸 내비·여러 쿼리가
// 딸린 트리라 단위 시험이 통째로 마운트하지 않고, 그래서 「이 프롭이 저 가드
// 안에 있는가」는 렌더로 물을 수 없다. 이 파일이 위에서 R2-1 오버레이 스코프를
// 같은 방식으로 이미 지키고 있고(`channelActionCanon.test.ts` 도 같은 갈래),
// 실브라우저 쪽 자는 캡처 레인이 든다(`sidebar-prefs-unavailable-*` 프레임과
// 터치 서랍의 편집 문 0건 단정).
// =============================================================================

describe("B-1 — 배치를 못 읽은 표면에는 편집 문이 없다", () => {
  it("편집 가능 여부가 한 곳에서 계산된다", () => {
    // `canEdit`(부트스트랩 정착) 과 `!touchSurface`(배치를 줄 수 있는 표면) 둘
    // 다여야 한다. 두 조건이 흩어지면 다음 문이 하나만 보고 열린다.
    expect(sidebarSource).toContain(
      "const canEditSections = sidebarPrefs.canEdit && !touchSurface;"
    );
  });

  it("「새 섹션」과 섹션 메뉴가 그 가드 안에 있다", () => {
    const door = sidebarSource.slice(
      0,
      sidebarSource.indexOf('data-testid="new-section"')
    );
    // 문 바로 앞의 마지막 조건이 그 가드다.
    expect(door.lastIndexOf("canEditSections &&")).toBeGreaterThan(
      door.lastIndexOf("sidebarPrefs.canCreate &&")
    );
    expect(sidebarSource).toContain("canEditSections ? (");
  });

  it("행 메뉴의 배치도 같은 가드를 탄다", () => {
    expect(sidebarSource).toContain(
      "sections={canEditSections ? sectionChoices : undefined}"
    );
  });

  it("읽기 실패가 자기 배너를 갖고, 저장 실패 배너와 겹치지 않는다", () => {
    // 저장 실패 배너와 **다른 자리**다: 하나는 「방금 한 것이 저장되지 않았다」,
    // 다른 하나는 「아직 아무것도 모른다」이고 뒤에 오는 행동이 다르다.
    expect(sidebarSource).toContain('testId="sidebar-prefs-load-error"');
    expect(sidebarSource).toContain("sidebarPrefs.retryLoad");
    // 하나만 선다: 읽지 못한 상태에서 훅이 쓰기를 거절하면 그 사유가 곧 읽기
    // 실패라, 두 배너가 같은 문장을 두 번 말하게 된다.
    expect(sidebarSource).toContain("sidebarPrefs.loadError ? (");
    expect(sidebarSource).toContain(") : sidebarPrefs.error ? (");
  });
});

describe("H-2 — 커스텀 섹션에서도 로딩은 빈 상태가 아니다", () => {
  it("본문이 기본 섹션과 같은 스켈레톤을 그린다", () => {
    const custom = sidebarSource.slice(
      sidebarSource.indexOf("{customSections.map((section) => (")
    );
    const body = custom.slice(0, custom.indexOf("</SidebarSection>"));
    expect(body).toContain("channelsQuery.isLoading && <SkeletonRows");
    // 그리고 빈 상태 문장은 로딩·오류가 아닐 때만 선다.
    expect(body).toContain("!channelsQuery.isLoading &&");
    expect(body).toContain("!channelsQuery.error &&");
  });

  it("빈 상태 문장은 코어가 표면별로 고른다", () => {
    // 문장을 여기 하드코딩하면 터치 갈래가 웹에만 생기고 폰이 다시 짠다.
    expect(sidebarSource).toContain("sidebarEmptySectionHint(!touchSurface)");
    expect(sidebarSource).not.toContain("채널 행을 우클릭해");
  });
});
