import { useEffect, useId, useRef, useState } from "react";
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
// 작게 둔다: 제목, 버전과 공개일, 한 문장 요약, **이 화면(데스크탑)에서 보이는** 변화의 제목(불릿 목록), 그리고 닫기와
// 「자세히 보기」. 항목의 바뀐 점·써 보는 방법은 설정의 버전별 내용에 있다(「자세히 보기」가 거기로 간다).
//
// 제목은 네 개까지 보이고, 넘치면 목록 아래 「더보기」가 나머지를 **그 자리에서** 펼친다(owner 11-04, #5298: 「그 밖에 N가지」로
// 접지 않는다). 다시 접지는 않는다: 단추는 펼치는 순간 사라지므로 초점이 <body>로 떨어지지 않게 처음 새로 선 항목이 받는다
// (Tab 순서에는 끼지 않고 프로그램만 옮긴다). 낭독은 그 항목부터 읽고, 아래로 이어서 나머지를 읽는다.
//
// 초점 링(#5307 L3): 링은 상자 안쪽 2px 로 그려져(`focus-ring`) 글자에 바로 붙은 상자는 링이 글자 가장자리를 긋는다. 링은 글자를 감싸는 줄 안 `span`이 받고, 그
// `span`은 좌우 8px 숨 쉴 자리를 안으로 갖는다(바깥 여백으로 되돌려 글자와 불릿의 자리는 그대로). 링은 목록 폭 전체가 아니라 글자를 따라 둥글게 선다.
// 간격은 고정 눈금(4·8·12 …)이다 — 반 칸(`px-1.5`)은 눈금에 없어 아무 스타일도 만들지 않는다(캡처로 잰 값이 0이었다).
// 「더보기」는 390 폭에서 손가락 크기(44)로 자란다(`tap-target`: 폭 600 미만에서만).
//
// 처음 포커스는 단추가 아니라 대화상자 자신에게 둔다. 이 창은 사람이 부르지 않고 뜬다: 입력창에서 글을 치는
// 도중에 뜨면 첫 단추에 포커스가 가서 다음 Enter·Space가 그 단추를 눌러 버린다. 대화상자 자신이 포커스를 받으면
// 낭독은 제목과 요약을 읽고, 키는 아무것도 누르지 않는다. 닫기는 Esc와 「닫기」 단추다(이 집 대화상자는 구석 ✕가 없다).
// 이 파일은 그리기만 한다: 열고 닫는 시점과 「봤다」 기록은 `ReleaseNotesHost`가 진다.
// =============================================================================

/** 작은 창에 제목을 몇 줄까지 처음 보일까. 넘치는 것은 「더보기」가 한 번에 펼친다. */
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
  const { messages } = useReleaseNotesMessages();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const firstExtraRef = useRef<HTMLSpanElement | null>(null);
  const listId = useId();
  const [expanded, setExpanded] = useState(false);
  const items = itemsForSurface(note, DESKTOP_SURFACE);
  const folded = items.length > SHOWN_TITLES && !expanded;
  const shown = folded ? items.slice(0, SHOWN_TITLES) : items;

  // 눌린 「더보기」는 펼치는 순간 사라진다: 초점이 <body>로 떨어지지 않게 처음 새로 선 항목이 받는다.
  useEffect(() => {
    if (expanded) firstExtraRef.current?.focus();
  }, [expanded]);

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
        <DialogDescription className="break-keep">{messages.formatMessage(note.summary)}</DialogDescription>
        {shown.length > 0 ? (
          <div className="flex min-h-0 min-w-0 flex-col gap-1">
            {/* 짧은 창에서는 패널이 아니라 이 목록이 스크롤한다(`dialog-panel`: 스크롤 상자는 호출부가 안에 둔다). */}
            <ul
              id={listId}
              className="flex min-h-0 min-w-0 list-disc flex-col gap-1 overflow-y-auto pl-4 marker:text-ink-muted"
              data-testid="release-notes-dialog-titles"
            >
              {shown.map((item, index) => {
                const firstExtra = expanded && index === SHOWN_TITLES;
                return (
                  <li key={item.id} className="break-keep text-body text-ink">
                    <span
                      ref={firstExtra ? firstExtraRef : undefined}
                      tabIndex={firstExtra ? -1 : undefined}
                      className="-mx-2 rounded-sm px-2 py-1 focus-visible:focus-ring"
                    >
                      {messages.formatMessage(item.title)}
                    </span>
                  </li>
                );
              })}
            </ul>
            {folded ? (
              <Button
                variant="ghost"
                size="sm"
                className="tap-target ml-1 self-start"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setExpanded(true)}
                data-testid="release-notes-dialog-more"
              >
                {messages.formatMessage("releaseNotes.popup.showMore")}
              </Button>
            ) : null}
          </div>
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
