import { expressionCacheNeedsRefresh } from "@momo/core/features/expressions/cache";
import { createExpressionNoticeGate } from "@momo/core/features/expressions/changeNotice";
import type { ExpressionChanged, ExpressionChangedDetail } from "@momo/core/features/expressions/types";
import type { ExpressionStore } from "./ExpressionStore";

/**
 * 변경 알림을 저장소 동작으로 옮기는 세 처리기(ADR-0218 §15, #5491). 한 변경에 알림이 둘 온다: 상세(`expression.changed.detail`)가 먼저, 옛
 * `expression.changed` 가 뒤따른다. 같은 version 의 둘째는 건너뛴다. 상세는 순서·유실에 기대지 않는다 — 상세 없이 옛 알림만 오면 지금처럼 전부 폐기하고 읽는다.
 */
export function expressionNoticeHandlers(store: ExpressionStore) {
  const gate = createExpressionNoticeGate();
  return {
    /** 옛 `expression.changed`: 상세가 이미 처리한 version 이 아니면 전부 폐기하고 읽는다(v0.1.44 의 동작 그대로). */
    changed(frame: ExpressionChanged) {
      if (gate.changed(frame.version).kind === "already-handled") return;
      if (!expressionCacheNeedsRefresh(store.getSnapshot().cache, frame.workspaceId, frame.version)) return;
      store.clearImages();
      void store.refresh(false);
    },
    /** 재구독: 앞서 본 version 은 그 틈 뒤를 말해 주지 않는다. 전부 폐기하고 전체를 읽는다(D3 재연결 전체 갱신). */
    resync() {
      gate.reset();
      store.clearImages();
      void store.refresh();
    },
    /** 상세: 숨김·삭제는 그 id 의 그림만 내리고, 등록·고치기·정책은 그리던 그림을 그대로 두고 목록만 읽는다. */
    detail(detail: ExpressionChangedDetail) {
      const verdict = gate.detail(detail);
      if (verdict.kind === "already-handled") return;
      // 읽기는 항상 새로 한다: 앞서 시작한 읽기의 답은 `evictImages` 가 버렸다.
      if (verdict.kind === "revoke-ids") { store.evictImages(verdict.ids); void store.refresh(false); return; }
      // 이름 없는 숨김·삭제(계약이 막지만 판정은 안전한 쪽으로 닫는다): 전부 내린다.
      if (verdict.kind === "revoke-all") { store.clearImages(); void store.refresh(false); return; }
      // 등록·고치기·정책: 이미 그 version 을 가졌으면(내 응답이 먼저 왔다) 읽지 않는다.
      if (expressionCacheNeedsRefresh(store.getSnapshot().cache, detail.workspaceId, detail.version)) void store.refresh(false);
    },
  };
}
