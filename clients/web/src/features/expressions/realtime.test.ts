import { beforeEach, expect, it, vi } from "vitest";
import { FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
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
