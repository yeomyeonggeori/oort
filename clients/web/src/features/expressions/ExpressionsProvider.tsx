import { expressionCacheNeedsRefresh } from "@momo/core/features/expressions/cache";
import { ExpressionsContext } from "./context";
import { watchExpressionChanges } from "@/lib/realtime";
import { useEffect, useMemo, type ReactNode } from "react";
import { useSession } from "@/app/session";
import { useBrowserOffline } from "@/features/common/useOffline";
import { photoFixtureFromQuery } from "@momo/core/features/expressions/photo";
import { MANUAL_UPLOAD_CODES } from "@momo/core/features/expressions/types";
import type { ManualUploadCode } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport, expressionHttpTransport } from "./transport";

export function TeamExpressionsProvider({ children }: { children: ReactNode }) {
  const { workspaceId, session, connStatus, realtime } = useSession();
  const offline = useBrowserOffline() || connStatus === "disconnected";
  const memberId = session.member.id;
  const store = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    const failure = query.get("expressionFailure") as ManualUploadCode | null;
    const transport = import.meta.env.DEV && query.get("expressions") === "fixture"
      ? createExpressionFixtureTransport(workspaceId, memberId, failure && MANUAL_UPLOAD_CODES.includes(failure) ? failure : undefined, photoFixtureFromQuery(query))
      : expressionHttpTransport;
    return new ExpressionStore(workspaceId, memberId, transport);
  }, [workspaceId, memberId]);
  useEffect(() => {
    store.setOffline(offline);
    if (!offline) void store.refresh();
  }, [store, offline, connStatus]);
  useEffect(() => {
    if (!realtime) return;
    return watchExpressionChanges(realtime, workspaceId, (frame) => {
      if (!expressionCacheNeedsRefresh(store.getSnapshot().cache, frame.workspaceId, frame.version)) return;
      store.clearImages();
      void store.refresh(false);
    }, () => { store.clearImages(); void store.refresh(); });
  }, [store, realtime, memberId, workspaceId]);
  useEffect(() => {
    const refresh = () => { if (navigator.onLine) void store.refresh(); };
    window.addEventListener("focus", refresh);
    // Foreground and periodic full reads also recover from missed catalogue signals.
    const timer = window.setInterval(refresh, 30000);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); store.dispose(); };
  }, [store]);
  return <ExpressionsContext.Provider value={store} key={`${workspaceId}:${memberId}`}>{children}</ExpressionsContext.Provider>;
}
