// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import type { RosterMember } from "@momo/core/lib/api";
import { PendingRow } from "./PendingRow";
import { SEND_SLOW_MS } from "./sendSlow";

// =============================================================================
// #4468: 보낼 때 「전송 중」 줄이 깜빡이지 않는다 — 폰 #4455와 같은 규칙.
//
//   - 정상 전송(1.5초 안): 글자도 시계도 없고 본문은 흐리지 않다(서버 사본과 같은 모양).
//   - 느린 전송(1.5초 넘음): 시계 하나만 서고(낭독 「전송 중」) 흐름에 자리를 차지하지 않는다.
//   - 실패: 기존 그대로(실패 줄·아이콘 둘·흐린 본문, 시계 없음).
//   - 다시 보내기: 새 시도라 그때부터 다시 센다.
//
// jsdom 에는 배치가 없으므로 높이·색은 `PendingRow.height.browser.test.ts` 가 실제 Chromium 에서 잰다. 여기서는 규칙(언제 서는가)과
// 그 규칙이 기대는 클래스 계약(`absolute`)을 가짜 시계로 잠근다.
// =============================================================================

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const T0 = new Date("2026-11-05T05:20:30Z").getTime();

const directory = makeDirectory([
  {
    id: ME,
    workspaceId: WORKSPACE,
    kind: "human",
    status: "active",
    displayName: "박서연",
    handle: "seoyeon",
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember,
]);

function row(over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId: "k1",
    channelId: CHANNEL,
    authorMemberId: ME,
    body: "금요일 배포 공지 초안이에요",
    createdAtMs: T0,
    sinceSeq: 10,
    status: "sending",
    ...over,
  };
}

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: { id: ME, workspaceId: WORKSPACE, kind: "human", displayName: "박서연", handle: "seoyeon" },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: WORKSPACE,
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  } as unknown as SessionContextValue;
}

let korean: AppLocale;
beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  korean = await koreanLocaleForTest();
});
beforeEach(() => {
  // 시계와 타이머 모두 가짜: 1.5초 문턱의 앞뒤를 ms 단위로 건넌다.
  vi.useFakeTimers({ now: T0 });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const tree = (pending: PendingMessage, startsGroup: boolean) => (
  <LocaleProvider locale={korean}>
    <SessionProvider value={sessionValue()}>
      <PendingRow
        pending={pending}
        startsGroup={startsGroup}
        directory={directory}
        onResend={() => undefined}
        onDiscard={() => undefined}
      />
    </SessionProvider>
  </LocaleProvider>
);

const mount = (pending: PendingMessage, startsGroup = true) => render(tree(pending, startsGroup));
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
const article = () => screen.getByTestId("timeline-pending");
const bodyParagraph = () => article().querySelector("p") as HTMLElement;

describe("PendingRow: 보낼 때 깜빡이지 않는다 (#4468)", () => {
  it("정상 전송: 1.5초 안에는 글자도 시계도 없고 본문은 흐리지 않다. 머리 행은 보낸 시각을 이미 그린다", () => {
    mount(row());
    expect(screen.queryByTestId("pending-sending")).toBeNull();
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    expect(article().textContent).not.toContain("전송 중");
    // 서버 사본이 오면 바뀌는 것이 없어야 하므로 흐리게 그리지 않는다(흐림은 실패한 행만).
    expect(bodyParagraph().className).not.toContain("text-ink-muted");
    // 시각 글자가 교체 때 새로 생기지 않는다(같은 분이면 글자 변화 0).
    const time = screen.getByTestId("pending-time");
    expect(time.textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(time.getAttribute("datetime")).toBe(new Date(T0).toISOString());
    advance(SEND_SLOW_MS - 1);
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    expect(article().textContent).not.toContain("전송 중");
  });

  it("느린 전송: 기준 시간(1.5초)에 시계만 서고 새 줄은 없다. 낭독은 「전송 중」이고 흐름에 자리가 없다", () => {
    mount(row());
    const before = article().textContent;
    advance(SEND_SLOW_MS - 1);
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    advance(1);
    const mark = screen.getByRole("img", { name: "전송 중" });
    expect(mark.getAttribute("data-testid")).toBe("pending-slow");
    // 글자 줄이 아니라 시계다: 행의 글자는 그대로이고, 시계 자신은 글자가 없으며 흐름 밖(`absolute`)이다.
    expect(article().textContent).toBe(before);
    expect(mark.textContent).toBe("");
    expect(mark.className).toContain("absolute");
    expect(mark.querySelector("svg")?.getAttribute("class")).toContain("lucide-clock");
    expect(screen.queryByTestId("pending-sending")).toBeNull();
    // 머리 행에서는 시각 바로 곁(시각 상자 안의 `absolute`)에 선다.
    expect(within(screen.getByTestId("pending-time")).getByTestId("pending-slow")).toBe(mark);
  });

  it("이미 느린 전송으로 마운트되면(가상 목록이 되돌려 놓은 행) 첫 렌더부터 시계가 서 있고, 이어지는 행은 거터에 선다", () => {
    mount(row({ createdAtMs: T0 - 3000 }), false);
    const mark = screen.getByTestId("pending-slow");
    expect(mark.getAttribute("aria-label")).toBe("전송 중");
    // 이어지는 행에는 시각이 없다(서버 사본도 같다): 시계는 거터(시각이 서는 자리)에 `right-0 top-0`으로 앉는다.
    expect(screen.queryByTestId("pending-time")).toBeNull();
    expect(mark.className).toContain("absolute");
    expect(mark.className).toContain("right-0");
    expect(mark.parentElement?.className).toContain("relative");
    // 보낸 시각이 지금보다 미래여도(기기 시계가 뒤로 감김) 기다림은 정확히 1.5초다. 묶지 않으면 대기가 미래까지의 거리(30일 =
    // 2^31-1 ms 초과)가 되고, 타이머는 그런 값을 1ms 로 바꿔 곧바로 터뜨린다(브라우저와 가짜 타이머가 같다) — 문턱 직전에 이미 서 있다.
    cleanup();
    mount(row({ createdAtMs: T0 + 30 * 24 * 60 * 60 * 1000 }));
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    advance(SEND_SLOW_MS - 1);
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    advance(1);
    expect(screen.getByTestId("pending-slow")).toBeTruthy();
  });

  it("실패: 기존 그대로 — 실패 줄과 아이콘 둘이 서고 본문은 흐리며 시계는 없다 (오래된 행이어도)", () => {
    mount(row({ status: "failed", createdAtMs: T0 - 10_000 }));
    expect(screen.getByTestId("pending-failed").textContent).toBe("전송 실패");
    expect(screen.getByTestId("pending-resend")).toBeTruthy();
    expect(screen.getByTestId("pending-discard")).toBeTruthy();
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    expect(screen.queryByTestId("pending-sending")).toBeNull();
    expect(bodyParagraph().className).toContain("text-ink-muted");
    expect(article().getAttribute("data-status")).toBe("failed");
  });

  it("다시 보내기: 실패에서 보내는 중으로 돌아오면 새 시도라 그때부터 다시 1.5초를 센다", () => {
    const view = mount(row({ status: "failed", createdAtMs: T0 - 10_000 }));
    advance(4000);
    view.rerender(tree(row({ status: "sending", createdAtMs: T0 - 10_000 }), true));
    // 보낸 시각은 10초 전이지만(멱등키 재사용) 이번 시도는 방금 시작했다: 곧바로 시계를 띄우지 않는다.
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    expect(bodyParagraph().className).not.toContain("text-ink-muted");
    advance(SEND_SLOW_MS - 1);
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    advance(1);
    expect(screen.getByTestId("pending-slow")).toBeTruthy();
    // 다시 실패하면 시계는 걷히고 실패 줄이 선다.
    view.rerender(tree(row({ status: "failed", createdAtMs: T0 - 10_000 }), true));
    expect(screen.queryByTestId("pending-slow")).toBeNull();
    expect(screen.getByTestId("pending-failed")).toBeTruthy();
  });
});

describe("폰과 같은 기준 시간 (#4468 ↔ #4455)", () => {
  // 폰의 `SEND_SLOW_MS` 는 폰 트리 안에 있고 그 훅은 React Native 파일이라 웹이 가져다 쓸 수 없다. 같은 값을 `sendSlow.ts` 에 두었으므로 한쪽만
  // 고치면 같은 보냄이 폰에서는 시계가 서고 웹에서는 서지 않는다 — 여기서 글자로 대조한다(`wallpaper.phoneParity.test.ts` 와 같은 읽기 가드).
  it("웹 `SEND_SLOW_MS` 는 폰 `sendSlow.ts` 의 값과 같다", () => {
    // jsdom 환경에서는 전역 `URL` 이 node 의 것이 아니라서 문자열 경로로 푼다.
    const phone = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../mobile/src/features/conversation/sendSlow.ts");
    const source = (() => {
      try {
        return readFileSync(phone, "utf8");
      } catch {
        throw new Error("폰 sendSlow.ts 를 읽지 못했다. 폰 경로가 바뀌었다면 이 시험의 경로도 옮긴다(PendingRow.slow.test.tsx).");
      }
    })();
    const match = /export const SEND_SLOW_MS = (\d+);/.exec(source);
    expect(match, "폰 sendSlow.ts 에서 SEND_SLOW_MS 선언을 못 찾았다").not.toBeNull();
    expect(SEND_SLOW_MS).toBe(Number(match?.[1]));
  });
});
