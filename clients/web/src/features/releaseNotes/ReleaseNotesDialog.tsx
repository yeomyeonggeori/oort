import { useRef } from "react";
import { DESKTOP_SURFACE, itemsForSurface, type ReleaseNote } from "@momo/core/features/releaseNotes/model";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { useReleaseNotesMessages } from "./useReleaseNotesMessages";

// =============================================================================
// 업데이트 뒤 처음 열 때 한 번 뜨는 작은 「업데이트 소식」 (#4937, owner 10-31).
//
// 작게 둔다: 제목, 버전과 공개일, 한 문장 요약, **이 화면(데스크탑)에서 보이는** 변화의 제목 몇 줄, 그리고 닫기와
// 「자세히 보기」. 항목의 바뀐 점·써 보는 방법은 설정의 버전별 내용에 있다(「자세히 보기」가 거기로 간다).
//
// 처음 포커스는 단추가 아니라 대화상자 자신에게 둔다. 이 창은 사람이 부르지 않고 뜬다: 입력창에서 글을 치는
// 도중에 뜨면 첫 단추에 포커스가 가서 다음 Enter·Space가 그 단추를 눌러 버린다. 대화상자 자신이 포커스를 받으면
// 낭독은 제목과 요약을 읽고, 키는 아무것도 누르지 않는다. 닫기는 Esc와 「닫기」 단추다(이 집 대화상자는 구석 ✕가 없다).
// 이 파일은 그리기만 한다: 열고 닫는 시점과 「봤다」 기록은 `ReleaseNotesHost`가 진다.
// =============================================================================

/** 작은 창에 제목을 몇 줄까지 보일까. 나머지는 「그 밖에 N가지」로 접는다. */
const SHOWN_TITLES = 4;

export function ReleaseNotesDialog({
  open,
  note,
  onClose,
  onDetails,
}: {
  open: boolean;
  note: ReleaseNote;
  onClose: () => void;
  onDetails: () => void;
}) {
  const { messages, noteLocale } = useReleaseNotesMessages();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const items = itemsForSurface(note, DESKTOP_SURFACE);
  const shown = items.slice(0, SHOWN_TITLES);
  const hidden = items.length - shown.length;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent
        ref={contentRef}
        className="gap-3 p-4"
        data-testid="release-notes-dialog"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          contentRef.current?.focus({ preventScroll: true });
        }}
      >
        <div className="flex min-w-0 flex-col gap-px">
          <DialogTitle>{messages.formatMessage("releaseNotes.popup.title")}</DialogTitle>
          <p className="break-keep text-meta text-ink-muted" data-numeric data-testid="release-notes-dialog-version">
            {messages.formatMessage("releaseNotes.version.label", { version: note.version })}
            {" · "}
            {note.releasedOn}
          </p>
        </div>
        <DialogDescription className="break-keep">{note.summary[noteLocale]}</DialogDescription>
        {shown.length > 0 ? (
          <ul className="flex min-w-0 flex-col gap-1" data-testid="release-notes-dialog-titles">
            {shown.map((item) => (
              <li key={item.id} className="break-keep text-body text-ink">
                {item.copy[noteLocale].title}
              </li>
            ))}
            {hidden > 0 ? (
              <li className="break-keep text-meta text-ink-muted">
                {messages.formatMessage("releaseNotes.popup.more", { count: hidden })}
              </li>
            ) : null}
          </ul>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={onClose} data-testid="release-notes-close">
            {messages.formatMessage("releaseNotes.action.close")}
          </Button>
          <Button onClick={onDetails} data-testid="release-notes-details">
            {messages.formatMessage("releaseNotes.action.details")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
