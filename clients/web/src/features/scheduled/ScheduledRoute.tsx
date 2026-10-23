import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { ApiError, uuidEq } from "@momo/core/lib/api";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import { scheduledErrorLine, type ScheduledErrorLine } from "@momo/core/features/scheduled/errors";
import {
  editLock,
  focusAfterRemoval,
  rowActions,
  scheduledDisplayOrder,
  scheduledPreview,
  scheduledSections,
  type ScheduledActionId,
} from "@momo/core/features/scheduled/model";
import { initialSendAtMs } from "@momo/core/features/scheduled/presets";
import {
  isScheduledFailureReason,
  type ScheduledMessage,
  type ScheduledPatch,
} from "@momo/core/features/scheduled/types";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useTransientStatus } from "@/features/common/useTransientStatus";
import { ScheduleDialog } from "./ScheduleDialog";
import { ScheduledRow } from "./ScheduledRow";
import {
  ScheduledDeleteDialog,
  ScheduledEditDialog,
  ScheduledReviewDialog,
} from "./ScheduledRowDialogs";
import { useScheduled, useScheduledClock, useScheduledPlaces } from "./useScheduled";

// =============================================================================
// 「예약됨」 목록 (UI 명세 1.7·1.8, ADR-0208 D8·D9·D14, #4215). 가운데 영역 한 열, 구획 둘.
//
//   보내지 못함   위. 사람이 할 일이 먼저다.
//   보낼 예정     아래, 마감 임박순.
//
// 구획이 비면 제목도 없다. 채널(스레드)로 거르면 머리에 「#일반 예약만 보고 있어요」와 「모두 보기」가 선다(주소의
// `?channel=<id>[&thread=<rootId>]`, 입력창 배너의 「보기」가 그 주소를 연다). 이 화면의 네 상태: 빈 · 로딩 · 오류 ·
// 오프라인(캐시된 목록은 그대로 보이고 행의 동작은 모두 흐리다).
//
// 목록은 이벤트와 재조회로 갱신된다(`useScheduled`): `sessions_ended`로 멈춘 예약은 이벤트가 도착하는 즉시 「보내지
// 못함」 구획으로 옮겨 온다(owner 결정 6). 행 동작의 쓰기는 이 화면이 부르고 실패 문장은 연산별로 고른다(명세 3.3).
//
// **「지금 보내기」는 한 번 누르면 간다**(확인 없음). 단 `sessions_ended` 행은 본문 전체를 보인 확인 안에서만 간다.
// 행이 사라질 때의 초점은 다음 행의 첫 컨트롤, 다음 행이 없으면 앞 행, 행이 하나도 없으면 목록 제목이다.
// =============================================================================

type DialogKind = "change" | "rearm" | "edit" | "delete" | "review";

/**
 * 행이 사라진 뒤 초점이 갈 곳. 대화상자 안에서 일어난 일(`viaDialog`)은 대화상자의 초점 가둠이 풀린 **뒤에**, 곧 Radix의
 * 초점 반환 자리(`onCloseAutoFocus`)에서 둔다: 가둠이 살아 있는 동안 둔 초점은 가둠이 도로 가져가고, 대화상자가 닫히며
 * 초점이 몸통으로 떨어진다.
 */
interface PendingLanding {
  landing: ReturnType<typeof focusAfterRemoval>;
  viaDialog: boolean;
}

interface OpenDialog {
  kind: DialogKind;
  id: string;
  opener: HTMLElement | null;
  /** change·rearm 대화상자의 처음 값. 열려 있는 동안 바뀌지 않는다. */
  seedAtMs: number;
}

export function ScheduledRoute() {
  const data = useScheduled();
  const places = useScheduledPlaces();
  const offline = useOffline();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const channelParam = params.get("channel");
  const threadParam = params.get("thread");
  const nowMs = useScheduledClock(data.rows);
  const { status, announce } = useTransientStatus();

  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pendingLanding = useRef<PendingLanding | null>(null);

  const [dialog, setDialog] = useState<OpenDialog | null>(null);
  const [dialogError, setDialogError] = useState<ScheduledErrorLine | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, ScheduledErrorLine>>({});
  const [busy, setBusy] = useState<{ id: string; action: ScheduledActionId } | null>(null);

  const rows = useMemo(
    () =>
      data.rows.filter(
        (row) =>
          (channelParam === null || uuidEq(row.channelId, channelParam)) &&
          (threadParam === null || uuidEq(row.rootId, threadParam))
      ),
    [data.rows, channelParam, threadParam]
  );
  const sections = scheduledSections(rows);
  const order = scheduledDisplayOrder(rows);
  const filtered = channelParam !== null || threadParam !== null;
  const total = sections.failed.length + sections.pending.length;

  // 대화상자가 닫히는 렌더에서는 `dialog`가 이미 null이다. 초점 반환은 그 뒤 한 틱에 일어나므로, 열었던 단추를
  // 마지막 값으로 쥐고 있어야 Radix가 돌려줄 곳을 안다(없으면 대화상자가 처음 그려질 때 초점이 있던 사이드바 줄로 간다).
  const lastOpener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (dialog !== null) lastOpener.current = dialog.opener;
  }, [dialog]);
  const dialogOpener = dialog?.opener ?? lastOpener.current;

  const dialogRow =
    dialog === null ? undefined : data.rows.find((row) => uuidEq(row.id, dialog.id));
  const dialogPlace = dialogRow === undefined ? places("") : places(dialogRow.channelId);

  const landFocus = useCallback((landing: ReturnType<typeof focusAfterRemoval>) => {
    if (landing.kind === "row") {
      const target = listRef.current?.querySelector<HTMLElement>(
        `[data-row-id="${landing.id}" i] button`
      );
      if (target) {
        target.focus();
        return;
      }
    }
    headingRef.current?.focus();
  }, []);

  // 행이 사라진 뒤의 초점(명세 1.7). 목록이 다시 그려진 직후에 둔다(대화상자 밖에서 일어난 일만: 안의 일은 아래).
  useLayoutEffect(() => {
    const pending = pendingLanding.current;
    if (pending === null || pending.viaDialog) return;
    pendingLanding.current = null;
    landFocus(pending.landing);
  }, [data.rows, landFocus]);

  /** 대화상자가 닫힌 뒤의 초점. 행이 사라진 일이 없으면(취소·Esc·고치기) 열었던 단추로 돌아가게 둔다. */
  const landAfterDialog = useCallback(
    (event: Event) => {
      const pending = pendingLanding.current;
      if (pending === null || !pending.viaDialog) return;
      pendingLanding.current = null;
      event.preventDefault();
      landFocus(pending.landing);
    },
    [landFocus]
  );

  const closeDialog = useCallback(() => {
    setDialog(null);
    setDialogError(null);
  }, []);

  const clearRowError = (id: string) =>
    setRowErrors((current) => {
      if (!(id in current)) return current;
      const { [id]: _removed, ...rest } = current;
      return rest;
    });

  /** 「지금 보내기」. 성공하면 행이 사라지고 목록 머리의 상태줄이 3초 선다. */
  const sendNow = async (row: ScheduledMessage, fromDialog: boolean): Promise<void> => {
    if (busy !== null) return;
    const place = places(row.channelId);
    setBusy({ id: row.id, action: "sendNow" });
    clearRowError(row.id);
    setDialogError(null);
    const landing = focusAfterRemoval(order, row.id);
    try {
      await data.mutations.sendNow(row.id);
      announce(SCHEDULED_COPY.status.sentNow);
      pendingLanding.current = { landing, viaDialog: fromDialog };
      closeDialog();
    } catch (error) {
      const line = scheduledErrorLine("sendNow", error, place.errorWord);
      // 서버가 거절하며 사유를 돌려준 것은 행이 `failed`가 됐다는 뜻이다: 행이 보내지 못함 구획으로 옮겨 가고 그 행의
      // 사유 줄이 선다(같은 말을 행에 한 번 더 쓰지 않는다). 대화상자 안에서는 이유 줄이 그 안에 선다.
      const refused =
        error instanceof ApiError &&
        error.status === 409 &&
        error.code !== undefined &&
        isScheduledFailureReason(error.code);
      if (fromDialog) setDialogError(line);
      else if (!refused) setRowErrors((current) => ({ ...current, [row.id]: line }));
    } finally {
      setBusy(null);
    }
  };

  const onAction = (action: ScheduledActionId, row: ScheduledMessage, opener: HTMLElement | null) => {
    pendingLanding.current = null;
    clearRowError(row.id);
    setDialogError(null);
    switch (action) {
      case "sendNow":
        void sendNow(row, false);
        return;
      case "change":
      case "rearm":
        setDialog({ kind: action, id: row.id, opener, seedAtMs: initialSendAtMs(row.sendAtMs, Date.now()) });
        return;
      case "edit":
      case "delete":
      case "review":
        setDialog({ kind: action, id: row.id, opener, seedAtMs: 0 });
        return;
      case "copy":
        return;
    }
  };

  /** 쓰기 한 번(고치기·시간 바꾸기·다시 예약). */
  const update = async (row: ScheduledMessage, patch: ScheduledPatch): Promise<void> => {
    if (busy !== null) return;
    const place = places(row.channelId);
    setBusy({ id: row.id, action: "edit" });
    setDialogError(null);
    const op =
      patch.sendAtMs === undefined ? "edit" : row.status === "failed" ? "rearm" : "change";
    // 다시 예약은 행을 「보내지 못함」에서 「보낼 예정」으로 옮긴다: 열었던 단추가 사라지므로 행이 사라질 때와 같은 규칙이다.
    const landing = op === "rearm" ? focusAfterRemoval(order, row.id) : null;
    try {
      await data.mutations.update(row.id, patch);
      if (landing !== null) pendingLanding.current = { landing, viaDialog: true };
      closeDialog();
    } catch (error) {
      setDialogError(scheduledErrorLine(op, error, place.errorWord));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (row: ScheduledMessage): Promise<void> => {
    if (busy !== null) return;
    const place = places(row.channelId);
    setBusy({ id: row.id, action: "delete" });
    setDialogError(null);
    const landing = focusAfterRemoval(order, row.id);
    try {
      await data.mutations.remove(row.id);
      pendingLanding.current = { landing, viaDialog: true };
      closeDialog();
    } catch (error) {
      setDialogError(scheduledErrorLine("delete", error, place.errorWord));
    } finally {
      setBusy(null);
    }
  };

  const clearFilter = () => setParams({}, { replace: true });
  const filterLabel =
    channelParam === null
      ? SCHEDULED_COPY.nav.label
      : threadParam === null
        ? places(channelParam).markedLabel
        : `${places(channelParam).markedLabel} 스레드`;

  const renderSection = (title: string, list: readonly ScheduledMessage[], testId: string) =>
    list.length === 0 ? null : (
      <section aria-label={title} data-testid={testId}>
        <h2 className="px-4 pb-1 pt-3 text-meta font-medium text-ink-muted">{title}</h2>
        <ul>
          {list.map((row) => (
            <ScheduledRow
              key={row.id}
              row={row}
              place={places(row.channelId)}
              nowMs={nowMs}
              offline={offline}
              busy={busy?.id === row.id ? busy.action : null}
              error={rowErrors[row.id] ?? null}
              onAction={onAction}
            />
          ))}
        </ul>
      </section>
    );

  const absent = data.surface === "absent";
  const lock = editLock(dialogRow, nowMs);

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="scheduled-route">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SidebarDrawerToggle />
          <h1
            ref={headingRef}
            tabIndex={-1}
            data-testid="scheduled-heading"
            className="text-body font-semibold focus-visible:focus-ring"
          >
            {SCHEDULED_COPY.list.title}
          </h1>
        </div>
        {/* 머리 오른쪽의 고정 자리: 「내 예약 N개」가 서는 곳이다. 「메시지를 보냈어요」는 3초 동안 이 자리를 **대신** 쓰고
            원래 줄로 돌아온다. 새 줄을 만들지 않는다: 그러면 목록 전체가 한 줄만큼 밀렸다가 3초 뒤에 당겨지고, 그 순간은
            사람이 다음 행으로 손을 옮기는 바로 그때다(design-review #4215 M1). 입력창의 메타 슬롯 대체와 같은 문법이다
            (ADR-0182 ②, #1749). 낭독은 아래의 늘 붙어 있는 안 보이는 `role="status"` 노드가 맡아서 이 줄은 낭독에서 뺀다. */}
        {!absent && !data.isPending && !data.isError && (
          status === null ? (
            <span className="text-meta text-ink-muted" data-numeric data-testid="scheduled-count">
              {SCHEDULED_COPY.list.count(total)}
            </span>
          ) : (
            <span
              aria-hidden="true"
              className="min-w-0 truncate text-meta text-ink-muted"
              data-testid="scheduled-status-line"
            >
              {status}
            </span>
          )
        )}
      </header>

      {/* 「메시지를 보냈어요」의 낭독 노드: 늘 붙어 있다(조건부로 처음 생기는 `role="status"`는 낭독이 보장되지 않는다). 높이 0. */}
      <div role="status" className="sr-only" data-testid="scheduled-status">
        {status}
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message={SCHEDULED_COPY.offline.list}
          testId="scheduled-offline"
        />
      )}
      {filtered && (
        <InlineBanner
          tone="neutral"
          message={SCHEDULED_COPY.list.filter(filterLabel)}
          actionLabel={SCHEDULED_COPY.list.filterAction}
          onAction={clearFilter}
          testId="scheduled-filter"
        />
      )}

      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto">
        {absent ? (
          // 이 서버에는 예약이 없다(구서버): 입구는 서지 않았고, 옛 링크로 온 사람에게만 이 줄이 보인다.
          <EmptyInvite
            headline={SCHEDULED_COPY.disabled.unavailable.reason}
            detail={SCHEDULED_COPY.disabled.unavailable.next}
            testId="scheduled-absent"
            actions={
              <Button
                type="button"
                variant="secondary"
                data-testid="scheduled-absent-back"
                onClick={() => navigate("/")}
              >
                {SCHEDULED_COPY.empty.action}
              </Button>
            }
          />
        ) : (
          <Skeleton ready={!data.isPending} rows={3} className="p-4">
            {data.isPending ? null : data.isError ? (
              <InlineBanner
                message={SCHEDULED_COPY.load.error}
                actionLabel={SCHEDULED_COPY.load.retry}
                onAction={data.refetch}
                testId="scheduled-error"
              />
            ) : total === 0 ? (
              <EmptyInvite
                headline={SCHEDULED_COPY.empty.title}
                detail={SCHEDULED_COPY.empty.bodyWeb}
                testId="scheduled-empty"
                actions={
                  <Button
                    type="button"
                    variant="secondary"
                    data-testid="scheduled-empty-back"
                    onClick={() => navigate(channelParam === null ? "/" : `/c/${encodeURIComponent(channelParam)}`)}
                  >
                    {SCHEDULED_COPY.empty.action}
                  </Button>
                }
              />
            ) : (
              <>
                {renderSection(SCHEDULED_COPY.list.sectionFailed, sections.failed, "scheduled-section-failed")}
                {renderSection(SCHEDULED_COPY.list.sectionPending, sections.pending, "scheduled-section-pending")}
              </>
            )}
          </Skeleton>
        )}
      </div>

      {/* 대화상자들. 한 번에 하나만 열린다. */}
      <ScheduleDialog
        open={dialog !== null && (dialog.kind === "change" || dialog.kind === "rearm")}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        mode={dialog?.kind === "rearm" ? "rearm" : "change"}
        opener={dialogOpener}
        placeLabel={dialogPlace.markedLabel}
        preview={dialogRow === undefined ? "" : scheduledPreview(dialogRow)}
        initialAtMs={dialog?.seedAtMs ?? 0}
        pending={busy?.action === "edit"}
        error={dialogError}
        offline={offline}
        unavailable={data.schedulerDisabled}
        lock={lock}
        onCommit={(atMs) => {
          if (dialogRow !== undefined) void update(dialogRow, { sendAtMs: atMs });
        }}
        onCloseAutoFocus={landAfterDialog}
        nowMs={nowMs}
      />
      <ScheduledEditDialog
        open={dialog?.kind === "edit"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        opener={dialogOpener}
        row={dialogRow}
        placeLabel={dialogPlace.markedLabel}
        hasTime={dialogRow === undefined ? false : rowActions(dialogRow, nowMs).editHasTime}
        pending={busy?.action === "edit"}
        error={dialogError}
        offline={offline}
        lock={lock}
        onCommit={(patch) => {
          if (dialogRow !== undefined) void update(dialogRow, patch);
        }}
        onCloseAutoFocus={landAfterDialog}
        nowMs={nowMs}
      />
      <ScheduledDeleteDialog
        open={dialog?.kind === "delete"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        opener={dialogOpener}
        pending={busy?.action === "delete"}
        error={dialogError}
        offline={offline}
        onConfirm={() => {
          if (dialogRow !== undefined) void remove(dialogRow);
        }}
        onCloseAutoFocus={landAfterDialog}
      />
      <ScheduledReviewDialog
        open={dialog?.kind === "review"}
        onOpenChange={(open) => {
          if (!open) closeDialog();
        }}
        opener={dialogOpener}
        row={dialogRow}
        placeLabel={dialogPlace.markedLabel}
        pending={busy?.action === "sendNow" ? "sendNow" : busy?.action === "delete" ? "delete" : null}
        error={dialogError}
        offline={offline}
        onSendNow={() => {
          if (dialogRow !== undefined) void sendNow(dialogRow, true);
        }}
        onRearm={() => {
          // 이 대화상자를 닫고 「다시 예약하기」를 연다(겹치지 않는다). 그 대화상자의 취소·Esc는 초점을 목록 행의
          // 「내용 확인」 단추로 돌려준다.
          if (dialogRow === undefined || dialog === null) return;
          setDialogError(null);
          const opener =
            listRef.current?.querySelector<HTMLElement>(
              `[data-row-id="${dialogRow.id}" i] [data-testid="scheduled-row-review"]`
            ) ?? dialog.opener;
          setDialog({
            kind: "rearm",
            id: dialogRow.id,
            opener,
            seedAtMs: initialSendAtMs(dialogRow.sendAtMs, Date.now()),
          });
        }}
        onDelete={() => {
          if (dialogRow !== undefined) void remove(dialogRow);
        }}
        onCloseAutoFocus={landAfterDialog}
        nowMs={nowMs}
      />
    </div>
  );
}
