// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import type { AppLocale } from "@/i18n/localeStore";
import { makeDirectory } from "@momo/core/features/workspace/directory";
import type { PendingMessage } from "@momo/core/features/timeline/model";
import type { RosterMember } from "@momo/core/lib/api";
import { PendingRow } from "./PendingRow";

// =============================================================================
// #5210: 보내지 못한 메시지 곁의 아이콘 둘 — 새로고침(다시 보내기) · 빨간 X(지우기).
//
// jsdom 에는 배치가 없으므로 상자 크기는 클래스 계약(`size-6` = 24px, `tap-target` = 600px 미만 44px)으로 잠그고,
// 렌더된 상자는 `scripts/capture-5210.mjs` 가 실제 엔진에서 잰다.
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

function mount(pending: PendingMessage, handlers: { onResend?: (id: string) => unknown; onDiscard?: (id: string) => void }) {
  return render(
    <LocaleProvider locale={korean}>
      <SessionProvider value={sessionValue()}>
        <PendingRow
          pending={pending}
          startsGroup
          directory={directory}
          onResend={handlers.onResend as never}
          onDiscard={handlers.onDiscard}
        />
      </SessionProvider>
    </LocaleProvider>
  );
}

describe("PendingRow: 보내지 못한 메시지의 아이콘 둘", () => {
  it("짧은 「전송 실패」 곁에 새로고침(다시 보내기)과 빨간 X(지우기)가 선다. 글자 단추는 없다", () => {
    mount(row(), { onResend: vi.fn(), onDiscard: vi.fn() });
    const failed = screen.getByTestId("pending-failed");
    expect(failed.textContent).toBe("전송 실패");
    const resend = screen.getByRole("button", { name: "다시 보내기" });
    const discard = screen.getByRole("button", { name: "지우기" });
    expect(resend.getAttribute("data-testid")).toBe("pending-resend");
    expect(discard.getAttribute("data-testid")).toBe("pending-discard");
    // 이름은 낭독과 툴팁이 읽는다: 단추 안에 글자가 없다.
    expect(resend.textContent).toBe("");
    expect(discard.textContent).toBe("");
    // 글리프: 레포의 Lucide 한 벌(RotateCw · X). 새로 그리지 않았고 낭독에서는 숨는다.
    const glyph = (button: HTMLElement) => button.querySelector("svg");
    expect(glyph(resend)?.getAttribute("class")).toContain("lucide-rotate-cw");
    expect(glyph(discard)?.getAttribute("class")).toContain("lucide-x");
    expect(glyph(resend)?.getAttribute("aria-hidden")).toBe("true");
    expect(glyph(discard)?.getAttribute("aria-hidden")).toBe("true");
  });

  it("위계: 파괴인 X 만 위험색이고 다시 보내기는 중립색이다 (둘 다 붉지 않다)", () => {
    mount(row(), { onResend: vi.fn(), onDiscard: vi.fn() });
    const resend = screen.getByTestId("pending-resend");
    const discard = screen.getByTestId("pending-discard");
    expect(discard.className).toContain("text-danger");
    expect(resend.className).not.toContain("text-danger");
    expect(resend.className).toContain("text-ink-muted");
  });

  it("누를 자리: 글리프 16 · 누르는 면 24(size-6) · 600px 미만에서는 tap-target 이 44로 키운다", () => {
    mount(row(), { onResend: vi.fn(), onDiscard: vi.fn() });
    for (const id of ["pending-resend", "pending-discard"]) {
      const button = screen.getByTestId(id);
      expect(button.className).toContain("size-6");
      expect(button.className).toContain("tap-target");
      expect(button.className).toContain("focus-visible:focus-ring");
      expect(button.querySelector("svg")?.getAttribute("class")).toContain("size-4");
    }
  });

  it("X 는 지우기만, 새로고침은 다시 보내기만 부른다. 둘 다 이 행의 키를 넘긴다", async () => {
    const onResend = vi.fn();
    const onDiscard = vi.fn();
    mount(row({ clientMsgId: "k-42" }), { onResend, onDiscard });
    fireEvent.click(screen.getByTestId("pending-discard"));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledWith("k-42");
    expect(onResend).not.toHaveBeenCalled();
    // 다시 보내기의 응답은 클릭 뒤 마이크로태스크에서 `resending` 을 푼다: act 안에서 비운다.
    await act(async () => {
      fireEvent.click(screen.getByTestId("pending-resend"));
    });
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(onResend).toHaveBeenCalledWith("k-42");
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("다시 보내는 요청이 도는 동안 새로고침은 잠기고 끝나면 풀린다 (두 번 눌러도 한 번만 나간다)", async () => {
    let finish: () => void = () => undefined;
    const onResend = vi.fn(
      () => new Promise<void>((done) => { finish = done; })
    );
    mount(row(), { onResend, onDiscard: vi.fn() });
    const resend = screen.getByTestId("pending-resend") as HTMLButtonElement;
    fireEvent.click(resend);
    expect(resend.disabled).toBe(true);
    fireEvent.click(resend);
    expect(onResend).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
    expect(resend.disabled).toBe(false);
  });

  it("핸들러가 없는 아이콘은 그리지 않는다", () => {
    const view = mount(row(), { onResend: vi.fn() });
    expect(screen.queryByTestId("pending-discard")).toBeNull();
    expect(screen.getByTestId("pending-resend")).toBeTruthy();
    view.unmount();
    mount(row(), { onDiscard: vi.fn() });
    expect(screen.queryByTestId("pending-resend")).toBeNull();
    expect(screen.getByTestId("pending-discard")).toBeTruthy();
    cleanup();
    mount(row(), {});
    expect(screen.getByTestId("pending-failed").textContent).toBe("전송 실패");
    expect(screen.queryByTestId("pending-actions")).toBeNull();
  });

  it("보내는 중인 행에는 아이콘이 없다: 이 키의 요청이 날아가는 중이라 지울 수 없다", () => {
    mount(row({ status: "sending" }), { onResend: vi.fn(), onDiscard: vi.fn() });
    expect(screen.getByTestId("pending-sending").textContent).toBe("전송 중");
    expect(screen.queryByTestId("pending-failed")).toBeNull();
    expect(screen.queryByTestId("pending-resend")).toBeNull();
    expect(screen.queryByTestId("pending-discard")).toBeNull();
  });

  it("키보드 초점이 닿으면 툴팁이 이름을 말한다 (네이티브 title 은 쓰지 않는다)", () => {
    mount(row(), { onResend: vi.fn(), onDiscard: vi.fn() });
    const resend = screen.getByTestId("pending-resend");
    const discard = screen.getByTestId("pending-discard");
    expect(resend.getAttribute("title")).toBeNull();
    expect(discard.getAttribute("title")).toBeNull();
    // 진짜 초점이어야 `:focus-visible` 이 맞는다(합성 focus 이벤트는 요소를 포커스하지 않는다).
    act(() => discard.focus());
    expect(screen.getByTestId("tooltip").textContent).toBe("지우기");
    act(() => discard.blur());
    expect(screen.queryByTestId("tooltip")).toBeNull();
    act(() => resend.focus());
    expect(screen.getByTestId("tooltip").textContent).toBe("다시 보내기");
  });

  it("첨부가 든 메시지가 실패해도 같은 두 아이콘이 서고 파일 카드가 보인다", () => {
    const attachments = [
      { id: "0199cccc-0000-7000-8000-0000000000f1", name: "견적서.pdf", mime: "application/pdf", sizeBytes: 48_213 },
    ];
    mount(row({ body: "", attachments }), { onResend: vi.fn(), onDiscard: vi.fn() });
    const article = screen.getByTestId("timeline-pending");
    expect(within(article).getByText("견적서.pdf")).toBeTruthy();
    expect(within(article).getByRole("button", { name: "다시 보내기" })).toBeTruthy();
    expect(within(article).getByRole("button", { name: "지우기" })).toBeTruthy();
    expect(article.getAttribute("data-status")).toBe("failed");
  });
});
