// @vitest-environment jsdom

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Channel } from "@momo/core/lib/api";
import type { PinMap } from "@momo/core/features/timeline/pins";
import { TOOLTIP_DELAY_MS } from "@/design/motion";
import { resetEscapeLayers } from "@/design/ui/escapeLayer";
import type { Directory } from "@/features/workspace/useWorkspace";
import { PinListMenu } from "@/features/timeline/PinListMenu";
import { ChannelMemberPanel } from "@/features/channels/ChannelContextControls";
import { HuddleHeaderControl } from "@/features/huddles/HuddleHeaderControl";
import type { HuddleController } from "@/features/huddles/useHuddle";
import { ChannelHeaderMenu } from "./ChannelHeaderMenu";

// =============================================================================
// 대화 머리 단추는 전부 디자인 시스템 툴팁이고, 네이티브 `title`은 없다 (#4591).
//
// 머리 단추 다섯 종(터미널·고정 목록·멤버·허들·⋮)은 지금까지 `title` 속성 하나로 툴팁을 갖고 있었다. 그것은 운영체제가
// 그리는 툴팁이라 모양도 지연도 디자인 시스템 것이 아니고, `Tooltip`을 얹으면 두 개가 뜬다. 이 시험은 **진짜 컴포넌트를
// 렌더해** 단추마다 (1) `title`이 없고 (2) 툴팁 래퍼 안에 서고 (3) 가리키면 500ms 뒤 **아래 방향** 툴팁이 뜨고
// (4) 그 문구가 접근성 이름과 같음을 잰다(문구가 이름과 갈라지면 눈으로 보는 사람과 듣는 사람이 다른 말을 듣는다).
// 터미널 단추는 ChatShell 안에 있어 `workSurfaceEntryPoints.test.tsx`가 같은 단정을 건다.
// 소스를 읽는 짝은 `ChatShell.header.test.ts`다(새 머리 단추가 툴팁 없이 들어오는 길을 닫는다).
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
  resetEscapeLayers();
  vi.useRealTimers();
});

const WS = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-000000000101";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";

function mount(element: ReactElement): HTMLElement {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  const channel = channelFixture();
  client.setQueryData<Channel[]>(["channels", WS], [channel]);
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/c/${CHANNEL_ID}`] },
        createElement(QueryClientProvider, { client }, element)
      )
    );
  });
  return host;
}

function channelFixture(): Channel {
  return {
    id: CHANNEL_ID,
    workspaceId: WS,
    kind: "public",
    name: "design-lab",
    muted: false,
    topic: "달무리 스튜디오 디자인 점검",
  };
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

function hover(el: Element) {
  const event = new MouseEvent("pointerover", { bubbles: true });
  Object.defineProperty(event, "pointerType", { value: "mouse" });
  act(() => {
    el.dispatchEvent(event);
  });
}

/** 단추를 가리키고, 지연 한 틱 전과 정확히 그때를 잰 뒤 뜬 툴팁을 돌려준다. */
function tooltipAfterHover(button: HTMLElement): HTMLElement {
  hover(button);
  act(() => void vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 1));
  expect(button.parentElement?.querySelector('[data-testid="tooltip"]')).toBeNull();
  act(() => void vi.advanceTimersByTime(1));
  const tip = button.parentElement?.querySelector<HTMLElement>('[data-testid="tooltip"]');
  expect(tip, "툴팁이 지연 뒤에도 뜨지 않았다").not.toBeNull();
  return tip as HTMLElement;
}

interface Case {
  name: string;
  testId: string;
  /** 툴팁에 보여야 하는 문구. 접근성 이름과 같다. */
  label: string;
  render: () => ReactElement;
  /** 머리의 맨 오른쪽 끝 단추는 오른쪽 끝을 맞춘다. */
  alignEnd?: boolean;
}

const noPins: PinMap = {};
const noDirectory = {} as unknown as Directory;

const CASES: Case[] = [
  {
    name: "고정 목록",
    testId: "open-pin-list",
    label: "고정한 메시지",
    render: () =>
      createElement(PinListMenu, {
        pins: noPins,
        status: "ready",
        directory: noDirectory,
        onJump: vi.fn(),
        onRetry: vi.fn(),
      }),
  },
  {
    name: "멤버",
    testId: "channel-member-count",
    label: "채널 멤버 0명",
    render: () =>
      createElement(ChannelMemberPanel, {
        channelName: "design-lab",
        members: [],
        status: "ready",
        offline: false,
        onRetry: vi.fn(),
        onAddMember: vi.fn(),
      }),
  },
  {
    name: "⋮ 메뉴",
    testId: "channel-title-menu",
    label: "design-lab 채널 메뉴",
    alignEnd: true,
    render: () =>
      createElement(ChannelHeaderMenu, {
        workspaceId: WS,
        channel: channelFixture(),
        title: "design-lab",
        selfMemberId: ME,
        selfRole: "owner" as const,
      }),
  },
  {
    name: "허들 시작",
    testId: "huddle-start",
    label: "허들 시작",
    render: () =>
      createElement(HuddleHeaderControl, { huddle: huddleController(), offline: false }),
  },
  {
    name: "허들 다시 불러오기",
    testId: "huddle-error-retry",
    label: "다시 불러오기",
    render: () =>
      createElement(HuddleHeaderControl, {
        huddle: huddleController({ status: "error" }),
        offline: false,
      }),
  },
  {
    name: "허들 마이크",
    testId: "huddle-microphone",
    label: "마이크 끄기",
    render: () =>
      createElement(HuddleHeaderControl, {
        huddle: huddleController({ joined: true }),
        offline: false,
      }),
  },
  {
    name: "허들 마이크 선택",
    testId: "huddle-mic-devices",
    label: "마이크 선택",
    render: () =>
      createElement(HuddleHeaderControl, {
        huddle: huddleController({ joined: true }),
        offline: false,
      }),
  },
  {
    name: "허들 나가기",
    testId: "huddle-leave",
    label: "허들 나가기",
    render: () =>
      createElement(HuddleHeaderControl, {
        huddle: huddleController({ joined: true }),
        offline: false,
      }),
  },
];

describe("머리 단추의 툴팁 (#4591)", () => {
  for (const c of CASES) {
    it(`${c.name}: title 없이 디자인 시스템 툴팁이 아래로 뜨고, 문구는 접근성 이름과 같다`, () => {
      vi.useFakeTimers();
      const host = mount(c.render());
      const button = host.querySelector<HTMLElement>(`[data-testid="${c.testId}"]`);
      expect(button, `${c.testId}가 렌더되지 않았다`).not.toBeNull();
      const el = button as HTMLElement;

      // (1) 네이티브 툴팁이 같이 뜨지 않는다.
      expect(el.hasAttribute("title")).toBe(false);
      // (2) 이름은 `aria-label`이 진다.
      expect(el.getAttribute("aria-label")).toBe(c.label);
      // (3) 툴팁 래퍼가 단추 바로 바깥이다(디자인 시스템 `Tooltip`의 `relative inline-flex` 상자).
      expect(el.parentElement?.className).toContain("inline-flex");
      expect(el.parentElement?.className).toContain("relative");

      // (4) 가리키면 지연 뒤에 뜨고, 아래 방향이며, 문구는 이름과 같다.
      const tip = tooltipAfterHover(el);
      expect(tip.textContent).toBe(c.label);
      expect(tip.getAttribute("data-side")).toBe("bottom");
      expect(tip.getAttribute("aria-hidden")).toBe("true");
      if (c.alignEnd) {
        expect(tip.className).toContain("right-0");
        expect(tip.className).not.toContain("left-1/2");
      } else {
        expect(tip.className).toContain("left-1/2");
      }
    });
  }

  it("누르면 툴팁이 닫힌다: 메뉴가 열린 채 툴팁이 덮지 않는다", () => {
    vi.useFakeTimers();
    const host = mount(CASES[0].render());
    const button = host.querySelector<HTMLElement>('[data-testid="open-pin-list"]') as HTMLElement;
    tooltipAfterHover(button);
    const down = new MouseEvent("pointerdown", { bubbles: true });
    Object.defineProperty(down, "pointerType", { value: "mouse" });
    act(() => {
      button.dispatchEvent(down);
    });
    expect(button.parentElement?.querySelector('[data-testid="tooltip"]')).toBeNull();
  });
});
