import { ExpressionsContext } from "./context";
import { watchExpressionChanges } from "@/lib/realtime";
import { useEffect, useMemo, type ReactNode } from "react";
import { useSession } from "@/app/session";
import { useOffline } from "@/features/common/useOffline";
import { everyWhileVisible } from "@/features/common/everyWhileVisible";
import { photoFixtureFromQuery } from "@momo/core/features/expressions/photo";
import { MANUAL_UPLOAD_CODES } from "@momo/core/features/expressions/types";
import type { ManualUploadCode } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import { sweepExpressionDiskOutside } from "./disk/boot";
import { openExpressionDisk } from "./disk/open";
import { expressionNoticeHandlers } from "./notices";
import { createExpressionFixtureTransport, expressionHttpTransport } from "./transport";

export function TeamExpressionsProvider({ children }: { children: ReactNode }) {
  const { workspaceId, session, connStatus, realtime } = useSession();
  const offline = useOffline();
  const memberId = session.member.id;
  const store = useMemo(() => {
    const query = new URLSearchParams(window.location.search);
    const failure = query.get("expressionFailure") as ManualUploadCode | null;
    const fixture = import.meta.env.DEV && query.get("expressions") === "fixture";
    const transport = fixture
      ? createExpressionFixtureTransport(workspaceId, memberId, failure && MANUAL_UPLOAD_CODES.includes(failure) ? failure : undefined, photoFixtureFromQuery(query))
      : expressionHttpTransport;
    // 이모티콘 그림의 기기 캐시(ADR-0218 §14): 디스크 칸을 못 열면(`null`: IndexedDB·localStorage·sha256 중 하나가 없다) 지금처럼 메모리만 쓴다. 개발용 가짜 서버의 그림은 디스크에 두지 않는다.
    return new ExpressionStore(workspaceId, memberId, transport, undefined, fixture ? null : openExpressionDisk(workspaceId, memberId));
  }, [workspaceId, memberId]);
  // 시작 청소의 둘째 걸음(§14 M2.5): 세션이 복원돼 현재 `(워크스페이스, 멤버)`를 알게 된 지금, 현재 칸 밖의 보관 칸과 수명이 지난 항목을 지운다.
  useEffect(() => { void sweepExpressionDiskOutside(workspaceId, memberId); }, [workspaceId, memberId]);
  useEffect(() => {
    store.setOffline(offline);
    if (!offline) void store.refresh();
  }, [store, offline, connStatus]);
  useEffect(() => {
    if (!realtime) return;
    const notices = expressionNoticeHandlers(store);
    return watchExpressionChanges(realtime, workspaceId, notices.changed, notices.resync, notices.detail);
  }, [store, realtime, memberId, workspaceId]);
  useEffect(() => {
    const refresh = () => { if (navigator.onLine) void store.refresh(); };
    window.addEventListener("focus", refresh);
    // Foreground and periodic full reads also recover from missed catalogue signals. The periodic read skips a hidden
    // window and catches up once when it is shown again (#5660: the desktop webview keeps running behind the window).
    const stopPeriodic = everyWhileVisible(refresh, 30000);
    return () => { stopPeriodic(); window.removeEventListener("focus", refresh); store.dispose(); };
  }, [store]);
  return <ExpressionsContext.Provider value={store} key={`${workspaceId}:${memberId}`}>{children}</ExpressionsContext.Provider>;
}
