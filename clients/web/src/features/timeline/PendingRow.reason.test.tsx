// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import type { SendFailureKind } from "@momo/core/features/connection/sendFailure";
import type { RosterMember } from "@momo/core/lib/api";
import { PendingRow } from "./PendingRow";

// =============================================================================
// #5221: 보내지 못한 글 곁의 원인 한 줄과 「모두 다시 보내기」.
//
// 원인은 닫힌 분류의 완결된 문장이다: 상태 코드·서버 원문은 어떤 줄에도 없다. 「모두 다시 보내기」는 실패한 행이 둘 이상일
// 때 마지막 실패 행에만 서고(개수는 `resendAllCount`), 하나일 때는 아이콘이 그 일을 한다.
// =============================================================================

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const ME = "00000000-0000-7000-8000-0000000001ff";
const CHANNEL = "00000000-0000-7000-8000-000000000201";

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
    createdAtMs: Date.UTC(2026, 10, 3, 5, 0, 0),
    sinceSeq: 10,
    status: "failed",
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
afterEach(() => cleanup());

function mount(props: {
  pending?: PendingMessage;
  failureKind?: SendFailureKind | null;
  resendAllCount?: number;
  onResendAll?: () => Promise<void> | void;
}) {
  return render(
    <LocaleProvider locale={korean}>
      <SessionProvider value={sessionValue()}>
        <PendingRow
          pending={props.pending ?? row()}
          startsGroup
          directory={directory}
          onResend={vi.fn()}
          onDiscard={vi.fn()}
          failureKind={props.failureKind}
          resendAllCount={props.resendAllCount}
          onResendAll={props.onResendAll}
        />
      </SessionProvider>
    </LocaleProvider>
  );
}

describe("PendingRow: 원인 한 줄", () => {
  // 지키는 것: 원인 한 줄이 실제 종류를 따라간다(서로 다른 완결된 문장). 코드·원문 없음.
  it("종류마다 다른 문장을 말하고, 종류를 모르면 지금까지처럼 「전송 실패」만 말한다", () => {
    const sentences: Record<SendFailureKind, string> = {
      offline: "오프라인이라 보내지 못했어요",
      server: "서버에 닿지 못해 보내지 못했어요",
      rejected: "서버가 받지 못했어요",
    };
    for (const kind of ["offline", "server", "rejected"] as const) {
      const { unmount } = mount({ failureKind: kind });
      const reason = screen.getByTestId("pending-failed-reason");
      expect(reason.textContent).toBe(sentences[kind]);
      expect(reason.getAttribute("data-failure-kind")).toBe(kind);
      expect(screen.getByTestId("pending-failed").textContent).not.toMatch(/\d{3}/);
      unmount();
    }
    mount({ failureKind: null });
    expect(screen.getByTestId("pending-failed-reason").textContent).toBe("전송 실패");
  });

  // 지키는 것: 보내는 중인 행에는 원인도 「모두 다시 보내기」도 없다.
  it("보내는 중인 행에는 원인 줄도 모두 다시 보내기도 없다", () => {
    mount({ pending: row({ status: "sending" }), failureKind: "server", resendAllCount: 3, onResendAll: vi.fn() });
    expect(screen.queryByTestId("pending-failed-reason")).toBeNull();
    expect(screen.queryByTestId("pending-resend-all")).toBeNull();
    // 정상 전송에는 「전송 중」 줄이 없다(#4468): 잠깐 서고 사라지는 글자가 곧 깜빡임이다. 글자로 단정해 이름만 바꾼 줄도 잡는다.
    expect(screen.queryByTestId("pending-sending")).toBeNull();
    expect(screen.getByTestId("timeline-pending").textContent).not.toContain("전송 중");
  });
});

describe("PendingRow: 모두 다시 보내기", () => {
  // 지키는 것: 둘 이상일 때만 선다. 개수가 단추 이름에 들어가고 누르면 핸들러가 한 번 불린다.
  it("실패가 둘 이상일 때만 서고 개수를 말하며, 누르면 한 번 불리고 도는 동안 두 번 눌러도 한 번이다", async () => {
    let finish: () => void = () => undefined;
    const onResendAll = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    mount({ resendAllCount: 3, onResendAll });
    const button = screen.getByTestId("pending-resend-all");
    expect(button.textContent).toBe("3개 모두 다시 보내기");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(onResendAll).toHaveBeenCalledTimes(1);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => finish());
    expect(button.getAttribute("aria-busy")).toBeNull();
  });

  it("하나뿐이거나 개수가 없거나 핸들러가 없으면 그리지 않는다", () => {
    for (const props of [
      { resendAllCount: 1, onResendAll: vi.fn() },
      { resendAllCount: undefined, onResendAll: vi.fn() },
      { resendAllCount: 2, onResendAll: undefined },
    ]) {
      const { unmount } = mount(props);
      expect(screen.queryByTestId("pending-resend-all")).toBeNull();
      unmount();
    }
  });
});
