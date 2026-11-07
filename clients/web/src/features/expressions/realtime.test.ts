import { beforeEach, expect, it, vi } from "vitest";
import { FIXTURE_EXPRESSIONS, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
const mock = vi.hoisted(() => ({ channels: [] as string[], publications: [] as ((ctx: { data?: unknown }) => void)[], subscribed: [] as (() => void)[] }));
vi.mock("centrifuge", () => ({ Centrifuge: class {
  on() {} connect() {} disconnect() {} removeSubscription() {} getSubscription() { return null; }
  newSubscription(name: string) {
    mock.channels.push(name);
    return { state: "subscribed", subscribe() {}, unsubscribe() {},
      on(event: string, listener: unknown) { if (event === "publication") mock.publications.push(listener as (ctx: { data?: unknown }) => void); else if (event === "subscribed") mock.subscribed.push(listener as () => void); },
      off(event: string, listener: unknown) { const list = event === "publication" ? mock.publications : mock.subscribed; const index = list.indexOf(listener as never); if (index >= 0) list.splice(index, 1); },
    };
  }
} }));
beforeEach(() => { mock.channels = []; mock.publications = []; mock.subscribed = []; });
it("uses the dedicated uppercase workspace namespace, validates changes and resyncs on subscribe", async () => {
  const { createRealtime, watchExpressionChanges } = await import("@/lib/realtime");
  const handle = createRealtime("ws://expressions.invalid/connection/websocket", () => {});
  const changed = vi.fn(); const resync = vi.fn();
  const stop = watchExpressionChanges(handle, FIXTURE_WORKSPACE_ID, changed, resync);
  expect(mock.channels).toEqual([`expressions:ws${FIXTURE_WORKSPACE_ID.toUpperCase()}`]);
  mock.subscribed.forEach((emit) => emit()); expect(resync).toHaveBeenCalledOnce();
  mock.publications.forEach((emit) => { emit({ data: { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4" } }); emit({ data: { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: 5 } }); });
  expect(changed).toHaveBeenCalledTimes(1); stop(); expect(mock.publications).toHaveLength(0);
  handle.dispose();
});

// #5491 (ADR-0218 증보 9, §15): 한 변경에 알림이 둘 간다. 상세(`expression.changed.detail`)는 상세 처리기로만, 옛 알림은 `changed` 로만 간다.
// 상세 처리기를 달지 않은 감시(v0.1.44 와 같은 호출 모양)는 상세를 받아도 아무것도 부르지 않는다 — 옛 판이 상세를 무시하는 근거다.
it("routes the detail notice to its own handler and leaves the plain notice to `changed`; a watcher without a detail handler ignores the detail", async () => {
  const { createRealtime, watchExpressionChanges } = await import("@/lib/realtime");
  const handle = createRealtime("ws://expressions.invalid/connection/websocket", () => {});
  const changed = vi.fn(); const resync = vi.fn(); const detail = vi.fn();
  const stop = watchExpressionChanges(handle, FIXTURE_WORKSPACE_ID, changed, resync, detail);
  const hidden = { type: "expression.changed.detail", workspaceId: FIXTURE_WORKSPACE_ID, version: "4", action: "hidden", expressionIds: [FIXTURE_EXPRESSIONS[0].id] };
  mock.publications.forEach((emit) => {
    emit({ data: hidden });
    emit({ data: { ...hidden, action: "hidden", expressionIds: [] } }); // 이름 없는 숨김: 상세가 아니다
    emit({ data: { ...hidden, action: "restored" } }); // 모르는 action: 상세가 아니다
    emit({ data: { ...hidden, workspaceId: "00000000-0000-4000-8000-0000000000aa" } }); // 다른 워크스페이스
    emit({ data: { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "4" } });
  });
  expect(detail).toHaveBeenCalledTimes(1);
  expect(detail).toHaveBeenCalledWith(hidden);
  expect(changed).toHaveBeenCalledTimes(1);
  stop();
  // 옛 호출 모양(상세 처리기 없음)
  const oldChanged = vi.fn();
  const oldStop = watchExpressionChanges(handle, FIXTURE_WORKSPACE_ID, oldChanged, vi.fn());
  mock.publications.forEach((emit) => emit({ data: hidden }));
  expect(oldChanged).not.toHaveBeenCalled();
  mock.publications.forEach((emit) => emit({ data: { type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version: "5" } }));
  expect(oldChanged).toHaveBeenCalledTimes(1);
  oldStop();
  handle.dispose();
});
