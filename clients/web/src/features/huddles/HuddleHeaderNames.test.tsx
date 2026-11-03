// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Huddle } from "@momo/core/lib/api";
import { HuddleHeaderControl, HuddleHeaderNames } from "./HuddleHeaderControl";
import { huddleControlShown, huddleNamesTarget } from "@momo/core/features/huddles/huddleModel";
import type { HuddleController } from "./useHuddle";

// =============================================================================
// 허들 참가자 이름 글은 Live 칩 밖, 제목 칸의 꼬리로 옮겨 갔다 (#5184).
//
// 칩 폭이 컨트롤 묶음의 기본 폭을 부풀려 제목이 먼저 깎이던 결함을 고친 구조의 약속이다. 폭이 실제로 어떻게 나뉘는지(이름 글이
// 제목이 다 선 뒤 남는 폭만 받는지)는 `gate:channel-header-fit`이 실브라우저에서 잰다. 여기서는 **누가 언제 서는가**를 잰다:
//   - 이름 글(`HuddleHeaderNames`)과 허들 컨트롤(`HuddleHeaderControl`)이 같은 판단으로 선다(칩 없는 이름·이름 없는 칩 금지).
//   - 칩은 이름을 품지 않지만 전문은 낭독(`sr-only`)과 `title`에 남는다.
//   - ChatShell이 ⋮를 허들 컨트롤과 묶을지 정하는 `huddleControlShown`은 실제 렌더와 갈라지지 않는다.
// =============================================================================

// 마이크 장치 목록은 브라우저 장치 API가 없는 jsdom에서 시험의 관심사가 아니다.
vi.mock("@/features/huddles/useAudioInputDevices", () => ({
  useAudioInputDevices: () => ({ devices: [], permission: "prompt" }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

function mount(element: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(element);
  });
  return host;
}

function huddleController(over: Partial<HuddleController> = {}): HuddleController {
  return {
    status: "ready",
    active: null,
    joined: false,
    muted: false,
    busy: null,
    notice: null,
    microphoneDeviceId: "",
    microphoneGainPercent: 100,
    retry: vi.fn(),
    startOrJoin: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    toggleMicrophone: vi.fn(async () => undefined),
    setMicrophoneDevice: vi.fn(async () => undefined),
    setMicrophoneGain: vi.fn(),
    ...over,
  };
}

const NAMES = ["Nadia Rahman — 제품 디자인 운영", "곽성재 — 웹 클라이언트 담당", "이도현", "팀원 1", "팀원 2"];
const SUMMARY = "Nadia Rahman — 제품 디자인 운영, 곽성재 — 웹 클라이언트 담당 외 3명";

function activeHuddle(): Huddle {
  return {
    id: "00000000-0000-7000-8000-000000000643",
    workspaceId: "00000000-0000-7000-8000-000000000001",
    channelId: "00000000-0000-7000-8000-000000000201",
    startedBy: "00000000-0000-7000-8000-000000000101",
    startedAtMs: 1,
    participants: NAMES.map((displayName, index) => ({
      memberId: `00000000-0000-7000-8000-00000000070${index}`,
      displayName,
      joinedAtMs: index,
    })),
  };
}

type Status = HuddleController["status"];
const STATUSES: Status[] = ["loading", "ready", "unconfigured", "error"];

describe("#5184 이름 글이 서는 때(huddleNamesTarget)", () => {
  it("참가 중이면 REST 투영의 어떤 상태보다 앞서 서 있는 허들을 돌려준다", () => {
    for (const status of STATUSES) {
      for (const offline of [false, true]) {
        const active = activeHuddle();
        expect(huddleNamesTarget(huddleController({ joined: true, status, active }), offline)).toBe(active);
      }
    }
    expect(huddleNamesTarget(huddleController({ joined: true, active: null }), false)).toBeNull();
  });

  it("참가 전에는 오프라인·불러오는 중·허들 없는 서버·오류에서 서지 않고, 준비된 서 있는 허들에서만 선다", () => {
    const active = activeHuddle();
    expect(huddleNamesTarget(huddleController({ status: "ready", active }), false)).toBe(active);
    expect(huddleNamesTarget(huddleController({ status: "ready", active }), true)).toBeNull();
    for (const status of ["loading", "unconfigured", "error"] as const) {
      expect(huddleNamesTarget(huddleController({ status, active }), false)).toBeNull();
    }
    // 서 있는 허들이 없으면 이름도 없다.
    expect(huddleNamesTarget(huddleController({ status: "ready", active: null }), false)).toBeNull();
  });
});

describe("#5184 이름 글 렌더(HuddleHeaderNames)", () => {
  it("전문 요약을 aria-hidden 글로 그린다(칩이 같은 전문을 낭독한다)", () => {
    const host = mount(
      createElement(HuddleHeaderNames, {
        huddle: huddleController({ active: activeHuddle() }),
        offline: false,
      })
    );
    const names = host.querySelector('[data-testid="huddle-participants"]');
    expect(names).not.toBeNull();
    expect(names?.textContent).toBe(SUMMARY);
    expect(names?.getAttribute("aria-hidden")).toBe("true");
    // 말줄임된 이름 글 위에서도 전문이 뜬다: 칩의 title과 같은 글.
    expect(names?.getAttribute("title")).toBe(NAMES.join(", "));
    expect(names?.className).toContain("channel-head-names");
    // 참가 전에는 칩과 함께 양보하는 규칙(`[data-joined]`)을 받지 않는다: 참가 단추 옆 칩은 허들이 열려 있다는 유일한 표지다.
    expect(names?.hasAttribute("data-joined")).toBe(false);
  });

  it("참가 중이면 칩과 함께 양보하는 규칙을 받는다", () => {
    const host = mount(
      createElement(HuddleHeaderNames, {
        huddle: huddleController({ joined: true, active: activeHuddle() }),
        offline: false,
      })
    );
    expect(host.querySelector('[data-testid="huddle-participants"]')?.hasAttribute("data-joined")).toBe(true);
  });

  it("서지 않을 때는 아무것도 그리지 않는다", () => {
    const host = mount(
      createElement(HuddleHeaderNames, {
        huddle: huddleController({ status: "unconfigured", active: activeHuddle() }),
        offline: false,
      })
    );
    expect(host.querySelector('[data-testid="huddle-participants"]')).toBeNull();
    expect(host.innerHTML).toBe("");
  });
});

describe("#5184 Live 칩은 이름을 품지 않지만 전문은 낭독과 title에 남는다", () => {
  it("서 있는 허들의 칩: 이름 글 없음, sr-only 전문, title에 전체 이름, 폰 폭의 인원수", () => {
    const host = mount(
      createElement(HuddleHeaderControl, {
        huddle: huddleController({ active: activeHuddle() }),
        offline: false,
      })
    );
    const chip = host.querySelector('[data-testid="huddle-live"]');
    expect(chip).not.toBeNull();
    // 칩 안에는 보이는 이름 글(huddle-participants)이 없다: 있으면 그 글 폭이 컨트롤 묶음을 부풀린다.
    expect(chip?.querySelector('[data-testid="huddle-participants"]')).toBeNull();
    expect(host.querySelector('[data-testid="huddle-participants"]')).toBeNull();
    expect(chip?.querySelector(".sr-only")?.textContent).toBe(SUMMARY);
    expect(chip?.getAttribute("title")).toBe(NAMES.join(", "));
    expect(chip?.querySelector('[data-testid="huddle-participant-count"]')?.textContent).toBe("5");
  });
});

describe("#5184 참가 중에는 참가자 전문이 칩 래퍼 밖의 한 곳에서 낭독된다", () => {
  it("칩이 양보해 display: none이 돼도 낭독에서 안 빠지고(래퍼 밖), 칩과 둘로 읽히지도 않는다", () => {
    const host = mount(
      createElement(HuddleHeaderControl, {
        huddle: huddleController({ joined: true, active: activeHuddle() }),
        offline: false,
      })
    );
    const spoken = Array.from(host.querySelectorAll(".sr-only")).filter(
      (element) => element.textContent === SUMMARY
    );
    expect(spoken).toHaveLength(1);
    // 칩 래퍼(머리가 좁으면 display: none이 되는 곳) 밖에 있어야 접근성 트리에 남는다.
    expect(spoken[0]?.closest(".channel-head-live-joined")).toBeNull();
    // 칩 자신은 마우스용 title(전문)을 그대로 가진다.
    expect(host.querySelector('[data-testid="huddle-live"]')?.getAttribute("title")).toBe(NAMES.join(", "));
  });
});

describe("#5206 huddleControlShown은 HuddleHeaderControl이 실제로 그리는 때와 같다", () => {
  const cases: Array<{ name: string; huddle: Partial<HuddleController>; offline: boolean }> = [];
  for (const status of STATUSES) {
    for (const offline of [false, true]) {
      cases.push({ name: `${status} · 오프라인 ${offline}`, huddle: { status, active: activeHuddle() }, offline });
      cases.push({ name: `${status} · 오프라인 ${offline} · 서 있는 허들 없음`, huddle: { status, active: null }, offline });
    }
  }
  for (const { name, huddle, offline } of cases) {
    it(`${name}`, () => {
      const controller = huddleController(huddle);
      const host = mount(createElement(HuddleHeaderControl, { huddle: controller, offline }));
      const drew = host.querySelector("*") !== null;
      expect(huddleControlShown(controller, offline)).toBe(drew);
      // 일치만 재면 판단 함수와 컨트롤이 같이 틀려도 초록이다: 절대 기대도 못 박는다. 참가 전에는 오프라인이거나 허들 없는 서버면 아무것도 안 그린다.
      expect(drew).toBe(!offline && controller.status !== "unconfigured");
    });
  }

  it("참가 중이면 늘 그린다(오프라인이어도 나가기는 쓸 수 있다)", () => {
    for (const offline of [false, true]) {
      const controller = huddleController({ joined: true, active: activeHuddle() });
      const host = mount(createElement(HuddleHeaderControl, { huddle: controller, offline }));
      expect(host.querySelector('[data-testid="huddle-leave"]')).not.toBeNull();
      expect(huddleControlShown(controller, offline)).toBe(true);
    }
  });
});
