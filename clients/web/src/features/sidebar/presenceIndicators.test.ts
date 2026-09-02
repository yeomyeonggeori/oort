import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// =============================================================================
// 프로필 행의 두 표시가 서로 다른 물건으로 보이는가 (프레즌스 6b design-review H1·H2)
//
// 이 파일이 있는 이유는 디자인 시스템 §5.3이 말하는 그 자리다: **아무 기계도 재지
// 않던 축**. 6a는 연결점을 `size-2 rounded-sm`으로 두고 주석에 "사각"이라고 적었는데,
// 반지름(6px)이 상자(8px)보다 커서 클램프되어 실제로는 **완전한 원**이 렌더됐다.
// 타입도 테스트도 프리플라이트도 그것을 보지 못했고, 6b가 아바타에 원형 배지를
// 붙이자 한 줄에 8px 원이 둘 서서 away/dnd일 때 서로 모순되는 신호를 냈다
// (호박 배지 + 초록 점). 사람 눈이 스크린샷에서 잡을 때까지 아무것도 붉지 않았다.
//
// 그래서 여기서는 `avatarSize.test.ts`와 같은 다리 검사를 한다 — 소스의 클래스와
// 컴파일된 스케일을 함께 읽어, 「연결 = 바, 프레즌스 = 원」이라는 모양의 분리와
// 「건강하면 침묵」을 되돌리는 diff를 붉게 만든다.
// =============================================================================

const tokensCss = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const sidebar = readFileSync(new URL("./Sidebar.tsx", import.meta.url), "utf8");
const presenceControl = readFileSync(
  new URL("./PresenceControl.tsx", import.meta.url),
  "utf8"
);
const profileCard = readFileSync(
  new URL("./ProfileCard.tsx", import.meta.url),
  "utf8"
);

/** 고정 스케일의 한 단계(px). 표에 없는 단계는 클래스만 있고 CSS 규칙이 없다. */
function spacingStep(step: string): number {
  const match = tokensCss.match(
    new RegExp(`--spacing-${step}:\\s*(\\d+(?:\\.\\d+)?)px`)
  );
  if (match === null) {
    throw new Error(`tokens.css 에 --spacing-${step} 이 없다 (U4-4R W-1)`);
  }
  return Number(match[1]);
}

describe("연결 표시(①)는 건강하면 침묵한다 (H1)", () => {
  it("connected 에서는 요소 자체를 세우지 않는다", () => {
    // 상시 초록 점은 정보가 0이고 SKILL §8이 금지하는 장식이다. 조건 없이
    // 렌더하도록 되돌리면 이 줄이 붉어진다.
    expect(sidebar).toContain("showsConnectionBar(connStatus) && (");
  });

  it("색은 상태에서만 나온다: 하드코딩된 토큰 클래스가 없다", () => {
    expect(sidebar).toContain("connectionBarClass(connStatus)");
    // `bg-ok`가 이 행에 문자열로 돌아오면 그것이 곧 상시 초록 점이다.
    expect(sidebar).not.toContain('"size-2 shrink-0 rounded-sm"');
  });
});

describe("두 표시는 모양이 다르다 (H1)", () => {
  it("연결은 12x4 바다 — 레일 마커의 바 문법", () => {
    expect(sidebar).toContain('"h-1 w-3 shrink-0 rounded-full"');
    // 그 두 단계가 실제로 컴파일되는 단계여야 한다. 없으면 클래스만 있고 규칙이
    // 없어 0px로 렌더된다(이 레포가 이미 한 번 겪은 결함).
    expect(spacingStep("1")).toBe(4);
    expect(spacingStep("3")).toBe(12);
  });

  it("프레즌스는 원이다 — 그리고 연결 표시는 더 이상 원이 아니다", () => {
    expect(presenceControl).toContain("size-2 rounded-full border");
    // 8px 상자 + `rounded-sm`(6px)은 클램프되어 원이 된다. 연결 표시가 그
    // 조합으로 돌아가면 두 원이 다시 한 줄에 선다.
    expect(sidebar).not.toMatch(/size-2[^"]*rounded-sm/);
  });
});

describe("상태 트리거는 이웃과 같은 크기로 눌린다 (H2)", () => {
  it("프로필 카드 전체가 tap-target 이다", () => {
    // 예전 트리거는 아바타 24×24 이고 옆 톱니가 44px 이었다. UX-D4 는 행
    // 전체를 트리거로 올려 그 불일치를 없앤다.
    expect(profileCard).toContain("tap-target flex min-w-0 flex-1");
    expect(presenceControl).not.toContain('"tap-target flex size-6 shrink-0');
  });

  it("배지는 버튼이 아니라 안쪽 아바타에 붙는다", () => {
    // 이것이 H2의 함정이다: 버튼만 44px로 키우면 버튼 모서리에 앵커된 배지가
    // 24px 아바타에서 떨어져 허공에 뜬다. 앵커는 아바타 span 이어야 한다.
    expect(presenceControl).toContain(
      '"relative flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover'
    );
    expect(presenceControl).toContain("absolute bottom-0 right-0 size-2");
  });
});

describe("상태 메뉴는 하나를 고르는 자리다 (M1)", () => {
  it("menuitemradio 로 서서 현재 값을 스스로 말한다", () => {
    // 평범한 menuitem 세 줄은 스크린리더에게 「명령 셋」이고, 지금 어디에 있는지
    // 말하지 않는다. 체크 표시는 눈에게만 하는 말이었다.
    expect(presenceControl).toContain("DropdownMenuRadioGroup value={current}");
    expect(presenceControl).toContain("DropdownMenuRadioItem");
    expect(presenceControl).not.toContain("<DropdownMenuItem");
  });

  it("그룹 제목이 실제로 그룹의 이름이다 (이슈 #1383)", () => {
    // `DropdownMenuLabel` 은 Radix 가 아무 id 도 안 붙이는 맨 div 다. 그래서 제목을
    // 그려 두고 `aria-labelledby` 를 빠뜨리면 **눈에만 있는 이름**이 되고, 그룹은
    // 여전히 이름이 없다 — 그리고 그 결함은 화면상 아무 차이도 만들지 않으므로
    // 스크린샷도 잡지 못한다. 두 짝을 함께 잰다.
    expect(presenceControl).toContain("<DropdownMenuLabel id={menuLabelId}>");
    expect(presenceControl).toContain("aria-labelledby={menuLabelId}");
  });

  it("제목은 실패 배너보다 위에 선다 — 오류가 패널의 이름을 밀어내지 않는다", () => {
    // 배너가 위로 가면 「쓰기가 방금 실패했고 그래서 메뉴가 아직 열려 있는」 바로
    // 그 상태에서만 패널이 이름을 잃는다: 오류 → 제목 → 선택지. 하필 가장 읽기
    // 어려운 순간에 제목이 비켜서는 것이고, 그게 제목이 있으나 마나가 되는 유일한
    // 자리다. 이건 실패 상태에서만 보이는 순서라 평상시 스크린샷이 못 잡는다.
    const title = presenceControl.indexOf("<DropdownMenuLabel id={menuLabelId}>");
    const banner = presenceControl.indexOf('testId="presence-error"');
    const options = presenceControl.indexOf("<DropdownMenuRadioGroup");
    expect(title).toBeGreaterThan(-1);
    expect(banner).toBeGreaterThan(title);
    expect(options).toBeGreaterThan(banner);
  });

  it("제목의 낱말은 트리거와 같은 한 자리에서 온다", () => {
    // 「내 상태」를 여기 직접 적으면 코어의 `presenceTriggerLabel` 과 두 벌이 되고,
    // 한쪽만 고쳐도 테스트는 전부 초록이다(PRESENCE_OPTIONS 가 M2 에서 겪은 그 결함).
    expect(presenceControl).toContain("PRESENCE_MENU_LABEL");
    expect(presenceControl).not.toContain("내 상태");
  });
});

describe("프로필 카드 트리거는 코어 이름을 쓴다 (M-6)", () => {
  it("title 과 aria-label 이 같은 presenceTriggerLabel 문장이다", () => {
    expect(profileCard).toContain("presenceTriggerLabel");
    expect(profileCard).toContain("aria-label={triggerName}");
    expect(profileCard).toContain("title={triggerName}");
    expect(profileCard).not.toContain("프로필 열기");
    expect(profileCard).toContain('title="설정 (⌘,)"');
  });
});

describe("프로필 카드 커스텀 상태 축 (#1889)", () => {
  it("adds 상태 설정 as a sibling of the declared radios, not a replacement", () => {
    expect(profileCard).toContain("PresenceStatusItems");
    expect(profileCard).toContain("profile-set-status");
    expect(profileCard).toContain("CUSTOM_STATUS_MENU_LABEL");
    expect(profileCard).toContain("SetStatusDialog");
    expect(profileCard).toContain("CustomStatusMark");
    expect(profileCard).not.toContain("DropdownMenuSub");
  });

  it("caps the menu at pane-sm so status copy cannot widen it (#1889 R2-B1)", () => {
    expect(profileCard).toContain("max-w-pane-sm");
    expect(profileCard).toContain("profile-card-status-head");
  });
});

describe("프로필 카드는 실존 표면만 재배선한다 (UX-D4)", () => {
  it("서브메뉴를 들이지 않고 레일의 워크스페이스 추가를 연다", () => {
    expect(profileCard).not.toContain("DropdownMenuSub");
    expect(profileCard).toContain("useOpenAddWorkspace");
    expect(profileCard).toContain("워크스페이스 추가");
    expect(profileCard).not.toContain("전환");
    expect(profileCard).not.toMatch(/["'`]Send feedback["'`]/);
  });

  it("설정은 카드 안의 실존 라우트다", () => {
    expect(profileCard).toContain('data-testid="nav-settings"');
    expect(profileCard).toContain('navigate("/settings")');
    expect(sidebar).not.toContain('data-testid="nav-settings"');
  });

  it("로그아웃은 설정 뒤의 실존 동사다 (#1858)", () => {
    expect(profileCard).toContain('data-testid="profile-logout"');
    expect(profileCard).toContain("useSession");
    expect(profileCard).toContain('tone="danger"');
    expect(profileCard).toContain("setConfirmLogout(true)");
    expect(profileCard).toContain("onClick={() => logout()}");
    expect(profileCard).toContain("<LogOut className=\"size-4\" aria-hidden=\"true\" />");
    expect(profileCard).toContain("로그아웃하면 이 기기에 쓰다 만 초안이 지워집니다.");
    expect(profileCard).toContain("로그아웃할까요?");
    const settings = profileCard.indexOf('data-testid="nav-settings"');
    const logout = profileCard.indexOf('data-testid="profile-logout"');
    expect(settings).toBeGreaterThan(-1);
    expect(logout).toBeGreaterThan(settings);
  });
});
