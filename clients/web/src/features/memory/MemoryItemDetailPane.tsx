import { useEffect, useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Select } from "@/design/ui/select";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import type { MemoryItemKind } from "@momo/core/features/memory/model";
import {
  BROWSER_GUEST_READONLY,
  BROWSER_NOT_CURRENT,
  BROWSER_OPEN_NEWER,
  BROWSER_PERSONAL_SPACE,
  DETAIL_EVIDENCE_EMPTY,
  DETAIL_EVIDENCE_HEADING,
  DETAIL_EVIDENCE_NOTE,
  DETAIL_HISTORY_EMPTY,
  DETAIL_HISTORY_ERROR,
  DETAIL_HISTORY_HEADING,
  EDIT_CANCEL,
  EDIT_FIELD_LABEL,
  EDIT_LABEL,
  EDIT_MAX_CHARS,
  EDIT_NOTICE,
  EDIT_SAVE,
  EDIT_SAVED,
  FORGET_BUSY,
  FORGET_CANCEL,
  FORGET_CONFIRM,
  FORGET_DESCRIPTION,
  FORGET_IRREVERSIBLE,
  FORGET_LABEL,
  FORGET_TITLE,
  MEMORY_KIND_OPTIONS,
  editCharCount,
  editDraftProblem,
  editedByLine,
  forgottenNotice,
  isCurrentMemoryItem,
  itemReadError,
  itemWriteError,
  memberMayWriteMemory,
  memoryEventLabel,
  memoryKindLabel,
  memoryOriginLabel,
  isMemoryKind,
} from "@momo/core/features/memory/browser";
import { EvidenceLinks } from "./EvidenceLinks";
import {
  memoryKeys,
  useEditMemoryItem,
  useForgetMemoryItem,
  useMemoryItem,
  useMemoryItemEvents,
} from "./useMemory";

// =============================================================================
// 기억 하나의 상세 (ADR-0196 D9 · D12 V4, #3170): 본문, 종류·출처, 근거 역링크, 이력,
// 고치기, 잊기.
//
// 권한은 두 겹이다. 손님(워크스페이스 역할)과 지난 버전은 버튼을 아예 그리지 않고
// 이유를 말한다. 그 밖의 어긋남(채널 역할이 손님, 그 사이 새 버전이 생김)은 서버의
// 403·409가 두 번째 벽이고, 같은 화면에서 문장으로 돌려준다.
//
// 잊기는 되돌릴 수 없고, 이미 만들어진 요약에는 남아 있을 수 있다. 그래서 확인을 한 번
// 거치고, 그 문장은 「다시는 나타나지 않는다」를 약속하지 않는다.
// =============================================================================

const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function MemoryItemDetailPane({
  workspaceId,
  itemId,
  offline,
  channelNames,
  onOpenItem,
  onChanged,
  focusOnMount = false,
}: {
  workspaceId: string;
  itemId: string;
  offline: boolean;
  channelNames: ReadonlyMap<string, string>;
  onOpenItem: (itemId: string) => void;
  /** A finished write: where to go next (`null` = back to the list) and what to say. */
  onChanged: (change: { nextItemId: string | null; message: string }) => void;
  focusOnMount?: boolean;
}) {
  const { session } = useSession();
  const client = useQueryClient();
  const directory = useDirectory(workspaceId).directory;
  const role = memberFor(directory, session.member.id)?.role;
  const detail = useMemoryItem(workspaceId, itemId);
  const events = useMemoryItemEvents(workspaceId, itemId);
  const edit = useEditMemoryItem(workspaceId);
  const forget = useForgetMemoryItem(workspaceId);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftKind, setDraftKind] = useState<MemoryItemKind>("fact");
  const [draftProblem, setDraftProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const fieldId = useId();
  const problemId = useId();

  useEffect(() => {
    if (focusOnMount && detail.data) headingRef.current?.focus();
  }, [focusOnMount, detail.data]);

  if (detail.isPending) {
    return (
      <div className="px-4 py-4" data-testid="memory-detail-loading">
        <Skeleton ready={false} rows={5} />
      </div>
    );
  }
  if (detail.isError || !detail.data) {
    const view = itemReadError(detail.error, "detail");
    if (view.kind === "gone") {
      return (
        <EmptyInvite
          headline={view.message}
          detail="이미 잊었거나, 내가 볼 수 없는 기억일 수 있어요."
          testId="memory-detail-gone"
        />
      );
    }
    return (
      <InlineBanner
        message={view.message}
        actionLabel="다시 시도"
        onAction={() => void detail.refetch()}
        testId="memory-detail-error"
      />
    );
  }

  const { item, evidence } = detail.data;
  const mayWrite = memberMayWriteMemory(role);
  const current = isCurrentMemoryItem(item);
  const canAct = mayWrite && current && !offline;
  const reason = !mayWrite
    ? BROWSER_GUEST_READONLY
    : !current
      ? BROWSER_NOT_CURRENT
      : offline
        ? "연결이 끊겨 있어서 지금은 바꿀 수 없어요."
        : null;
  const reasonId = "memory-detail-reason";
  const channelName =
    item.spaceKind === "personal"
      ? BROWSER_PERSONAL_SPACE
      : (channelNames.get(item.channelId.toLowerCase()) ?? "");
  const editor =
    item.editedByMemberId !== undefined
      ? (memberFor(directory, item.editedByMemberId)?.displayName ?? null)
      : null;

  function startEdit() {
    setDraft(item.body);
    setDraftKind(item.kind);
    setDraftProblem(null);
    setWriteError(null);
    setEditing(true);
  }

  function submitEdit() {
    if (edit.isPending) return;
    const problem = editDraftProblem(draft, item.body);
    if (problem !== null) {
      setDraftProblem(problem);
      return;
    }
    setDraftProblem(null);
    setWriteError(null);
    edit.mutate(
      {
        itemId: item.id,
        input: {
          body: draft.trim(),
          ...(draftKind !== item.kind ? { kind: draftKind } : {}),
        },
      },
      {
        onSuccess: (result) => {
          setEditing(false);
          onChanged({ nextItemId: result.item.id, message: EDIT_SAVED });
        },
        onError: (error) => handleWriteError(error, "edit"),
      }
    );
  }

  function confirmForget() {
    if (forget.isPending) return;
    setWriteError(null);
    forget.mutate(item.id, {
      onSuccess: (count) => {
        setConfirming(false);
        onChanged({ nextItemId: null, message: forgottenNotice(count) });
      },
      onError: (error) => {
        setConfirming(false);
        handleWriteError(error, "forget");
      },
    });
  }

  function handleWriteError(error: unknown, action: "edit" | "forget") {
    const view = itemWriteError(error, action);
    setWriteError(view.message);
    if (view.refetch) {
      void client.invalidateQueries({ queryKey: memoryKeys.items(workspaceId) });
    }
    if (view.gone) onChanged({ nextItemId: null, message: view.message });
  }

  return (
    <article
      aria-labelledby={headingId}
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4"
      data-testid="memory-detail"
      data-item-id={item.id}
    >
      <header className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className="rounded-full bg-surface-muted px-2 py-1 text-meta text-ink-muted"
            data-testid="memory-detail-kind"
          >
            {memoryKindLabel(item.kind)}
          </span>
          <span className="text-meta text-ink-muted" data-testid="memory-detail-origin">
            {memoryOriginLabel(item.origin)}
          </span>
          {!current && (
            <span className="text-meta text-ink-muted" data-testid="memory-detail-old">
              지난 버전
            </span>
          )}
        </div>
        <h2
          id={headingId}
          ref={headingRef}
          tabIndex={-1}
          className="whitespace-pre-line break-keep text-body font-semibold text-ink focus-visible:focus-ring"
          data-testid="memory-detail-body"
        >
          {item.body}
        </h2>
        <p className="text-meta text-ink-muted">
          {channelName !== "" && item.spaceKind !== "personal"
            ? `# ${channelName} · `
            : item.spaceKind === "personal"
              ? `${BROWSER_PERSONAL_SPACE} · `
              : ""}
          {DATE_TIME.format(item.recordedAtMs)}에 기록했어요 · 근거 {item.sourceCount}개
        </p>
        {item.origin === "curated" && item.editedByMemberId !== undefined && (
          <p className="text-meta text-ink-muted" data-testid="memory-detail-edited-by">
            {editedByLine(
              editor,
              item.editedAtMs !== undefined ? DATE_TIME.format(item.editedAtMs) : null
            )}
          </p>
        )}
        {(item.supersedesId !== undefined || item.supersededById !== undefined) && (
          <div className="flex flex-wrap gap-2">
            {item.supersedesId !== undefined && (
              <Button
                variant="secondary"
                size="sm"
                className="tap-target"
                onClick={() => onOpenItem(item.supersedesId ?? "")}
                data-testid="memory-detail-open-older"
              >
                이전 버전 보기
              </Button>
            )}
            {item.supersededById !== undefined && (
              <Button
                variant="secondary"
                size="sm"
                className="tap-target"
                onClick={() => onOpenItem(item.supersededById ?? "")}
                data-testid="memory-detail-open-newer"
              >
                {BROWSER_OPEN_NEWER}
              </Button>
            )}
          </div>
        )}
      </header>

      <section aria-label={DETAIL_EVIDENCE_HEADING} className="flex flex-col gap-1">
        <h3 className="text-meta font-medium text-ink-muted">{DETAIL_EVIDENCE_HEADING}</h3>
        {evidence.length === 0 ? (
          <p className="text-meta text-ink-muted" data-testid="memory-detail-evidence-empty">
            {DETAIL_EVIDENCE_EMPTY}
          </p>
        ) : (
          <>
            <EvidenceLinks
              evidence={evidence}
              currentChannelId={null}
              testId="memory-detail-evidence"
            />
            <p className="break-keep text-meta text-ink-muted">{DETAIL_EVIDENCE_NOTE}</p>
          </>
        )}
      </section>

      {writeError !== null && (
        <InlineBanner
          message={writeError}
          actionLabel="닫기"
          onAction={() => setWriteError(null)}
          testId="memory-detail-write-error"
        />
      )}

      {editing ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitEdit();
          }}
          data-testid="memory-edit-form"
        >
          <label htmlFor={fieldId} className="text-meta font-medium text-ink-muted">
            {EDIT_FIELD_LABEL}
          </label>
          <textarea
            id={fieldId}
            value={draft}
            rows={4}
            maxLength={EDIT_MAX_CHARS}
            disabled={edit.isPending}
            aria-invalid={draftProblem !== null ? true : undefined}
            aria-describedby={draftProblem !== null ? problemId : undefined}
            onChange={(event) => {
              setDraft(event.target.value);
              setDraftProblem(null);
            }}
            className="tap-target w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
            data-testid="memory-edit-field"
          />
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Select
              aria-label="종류"
              value={draftKind}
              onChange={(event) => {
                if (isMemoryKind(event.target.value)) setDraftKind(event.target.value);
              }}
              className="w-auto"
              data-testid="memory-edit-kind"
            >
              {MEMORY_KIND_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
            <span className="text-meta text-ink-muted" data-numeric="">
              {editCharCount(draft)}
            </span>
          </div>
          {draftProblem !== null && (
            <p id={problemId} role="alert" className="text-meta text-danger" data-testid="memory-edit-problem">
              {draftProblem}
            </p>
          )}
          <p className="break-keep text-meta text-ink-muted" data-testid="memory-edit-notice">
            {EDIT_NOTICE}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              size="sm"
              className="tap-target"
              aria-busy={edit.isPending || undefined}
              data-testid="memory-edit-save"
            >
              {edit.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {EDIT_SAVE}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="tap-target"
              disabled={edit.isPending}
              onClick={() => setEditing(false)}
              data-testid="memory-edit-cancel"
            >
              {EDIT_CANCEL}
            </Button>
          </div>
        </form>
      ) : (
        <div className="flex flex-col gap-2">
          {reason !== null && (
            <p id={reasonId} className="break-keep text-meta text-ink-muted" data-testid="memory-detail-reason">
              {reason}
            </p>
          )}
          {canAct && (
            <div className="flex flex-wrap gap-2" data-testid="memory-detail-actions">
              <Button
                size="sm"
                variant="secondary"
                className="tap-target"
                onClick={startEdit}
                data-testid="memory-detail-edit"
              >
                {EDIT_LABEL}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                className="tap-target"
                onClick={(event) => {
                  setOpener(event.currentTarget);
                  setConfirming(true);
                }}
                data-testid="memory-detail-forget"
              >
                {FORGET_LABEL}
              </Button>
            </div>
          )}
        </div>
      )}

      <section aria-label={DETAIL_HISTORY_HEADING} className="flex flex-col gap-2">
        <h3 className="text-meta font-medium text-ink-muted">{DETAIL_HISTORY_HEADING}</h3>
        {events.isPending ? (
          <p className="text-meta text-ink-muted">불러오고 있어요.</p>
        ) : events.isError || !events.data ? (
          <p className="text-meta text-ink-muted" data-testid="memory-detail-events-error">
            {DETAIL_HISTORY_ERROR}
          </p>
        ) : events.data.length === 0 ? (
          <p className="text-meta text-ink-muted">{DETAIL_HISTORY_EMPTY}</p>
        ) : (
          <ol className="flex flex-col gap-2" data-testid="memory-detail-events">
            {events.data.map((event) => {
              const actor =
                event.actorMemberId !== undefined
                  ? (memberFor(directory, event.actorMemberId)?.displayName ?? null)
                  : null;
              return (
                <li key={event.id} className="flex flex-col text-meta" data-testid="memory-detail-event">
                  <span className="text-ink">{memoryEventLabel(event.action)}</span>
                  <span className="text-ink-muted">
                    {actor !== null ? `${actor} · ` : ""}
                    {DATE_TIME.format(event.createdAtMs)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <Dialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !forget.isPending) setConfirming(false);
        }}
      >
        <DialogContent
          opener={opener}
          onEscapeKeyDown={(event) => {
            event.stopPropagation();
            if (forget.isPending) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            if (forget.isPending) event.preventDefault();
          }}
          data-testid="memory-forget-dialog"
        >
          <div className="flex flex-col gap-3 p-4">
            <DialogTitle>{FORGET_TITLE}</DialogTitle>
            <DialogDescription data-testid="memory-forget-description">
              {FORGET_DESCRIPTION}
            </DialogDescription>
            <p className="line-clamp-3 break-keep text-body text-ink">{item.body}</p>
            <p className="break-keep text-meta text-ink-muted">{FORGET_IRREVERSIBLE}</p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={forget.isPending}
                onClick={() => setConfirming(false)}
                data-testid="memory-forget-cancel"
              >
                {FORGET_CANCEL}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                aria-busy={forget.isPending || undefined}
                onClick={confirmForget}
                data-testid="memory-forget-confirm"
              >
                {forget.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
                {forget.isPending ? FORGET_BUSY : FORGET_CONFIRM}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </article>
  );
}
