import { FileText, ImageIcon, Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  ATTACH_COPY,
  attachmentDisplayName,
  CLEAR_ALL_MIN_DRAFTS,
  draftAnnouncement,
  draftStatusLine,
  splitFileName,
  isImageMime,
  isRetryableIssue,
  sendBlockCopy,
  sendBlockReason,
  showsDraftThumbnail,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";
import { useDraftThumbnail } from "./draftThumbnail";

// =====================================================================
// 컴포저의 첨부 자리 (ADR-0151 D2 / #1202 · #3820 Buzz 식 칩).
//
// **칩이지 목록이 아니다.** 입력창 안 위쪽에 둥근 칩이 줄바꿈되며 선다. 이미지는
// 썸네일만, 파일은 아이콘과 짧은 이름이다. 파일명 · 크기 · 「업로드 완료」 행을 쌓던
// 앞 판(#1202)은 정상 상태에서도 줄마다 문장을 찍어 목록처럼 읽혔다.
//
// ## 상태가 칩에서 보이는 방식
//
//   대기 · 확인 중 · 완료   조용하다. 문장은 sr-only (낭독은 live region 이 한다).
//   업로드 중              칩 아래 가장자리에 진행 막대. 아직 못 잰 동안은 흐르는
//                          줄(indeterminate), 첫 측정부터 값 있는 막대 + 퍼센트.
//   실패                   파일 칩 모양 + 빨간 이유 문장 + (되돌릴 값이 있으면)
//                          다시 시도. 제거 ×는 늘 보인다.
//
// 지켜진 앞 판의 규율: 「확인 중」에서 막대를 100% 로 세우지 않고 첫 측정 전에 0 짜리
// 막대를 그리지 않는다(B-3), 이름은 가운데에서 생략한다(N-A), 20개를 채워도 창을
// 먹지 않는다(B-2), 발치 안내 줄은 비어도 자리를 지킨다(M-3).
//
// ## 제거 ×
//
// 호버 · 키보드 포커스에서 드러난다(`pointer-hover`: 호버가 있는 입력에서만 숨김,
// 터치는 늘 보임). 숨겨진 상태에서도 탭 순서에는 있어서 키보드 사용자는 Tab 으로
// 닿고, 포커스가 오면 보인다.
// =====================================================================

/** 줄 상자를 만드는 공백 한 칸. 빈 <p> 는 높이가 0 이라 예약이 되지 않는다. */
const NBSP = "\u00a0";

/** 칩 위의 제거 ×. 호버·키보드 포커스에서 드러나고 터치에서는 늘 보인다. */
const REMOVE_BUTTON_CLASS =
  "touch-target absolute right-1 top-1 flex size-control-sm items-center justify-center rounded-full bg-surface text-ink-muted shadow-sm press hover:text-ink focus-visible:focus-ring pointer-hover:opacity-0 pointer-hover:group-hover:opacity-100 pointer-hover:focus-visible:opacity-100";

function RemoveButton({
  draft,
  alwaysVisible,
  onRemove,
}: {
  draft: AttachmentDraft;
  alwaysVisible: boolean;
  onRemove: (localId: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onRemove(draft.localId)}
      aria-label={`${attachmentDisplayName(draft)} ${ATTACH_COPY.remove}`}
      title={ATTACH_COPY.remove}
      data-testid="attachment-chip-remove"
      className={cn(
        REMOVE_BUTTON_CLASS,
        alwaysVisible && "pointer-hover:opacity-100"
      )}
    >
      <X aria-hidden="true" className="size-4" />
    </button>
  );
}

/**
 * 업로드 진행 표시. 막대는 칩 **아래 가장자리**에 붙는다(칩 위에 얹힌 진행).
 * 첫 측정 전에는 값 없는 막대(indeterminate), 측정이 오면 값 있는 막대 (B-3:
 * 0 은 「아직 안 쟀다」이지 「하나도 안 갔다」가 아니다).
 */
function ChipProgress({
  draft,
  measured,
}: {
  draft: AttachmentDraft;
  measured: boolean;
}) {
  return (
    <progress
      data-upload-progress
      data-testid="attachment-chip-progress"
      className="absolute inset-x-0 bottom-0 block h-marker w-full"
      // `value` 를 **아예 달지 않는다**: 그것이 indeterminate 다.
      {...(measured ? { value: draft.progress, max: 1 } : {})}
      aria-label={`${attachmentDisplayName(draft)} ${ATTACH_COPY.uploading}`}
    />
  );
}

/**
 * 칩 (#3820, Buzz 레퍼런스).
 *
 * 앞 판은 칩마다 「이름 · 상태 문장 · 진행 막대」 세 줄 행이었고, 정상일 때도
 * 「업로드 완료」 같은 문장이 줄마다 찍혀 입력창 위가 목록처럼 읽혔다. 이제:
 *
 *   이미지(정상·진행 중)  썸네일만 있는 둥근 정사각형. 이름은 `title` 과 낭독에만.
 *   파일(정상·진행 중)    아이콘 + 짧은 이름 한 줄. 상태 문장은 진행 중에만.
 *   실패한 것(종류 무관)   이유를 읽어야 하므로 파일 칩 모양. 다시 시도 + 제거.
 *
 * 정상 상태의 문장(「업로드 완료」)은 시각에서 빠지고 sr-only 로 남는다. 상태 전이는
 * 트레이의 live region(`useAttachmentAnnouncement`)이 낭독하므로 정보는 줄지 않는다.
 * 화면은 **예외**(진행·실패)만 말한다.
 */
function DraftChip({
  draft,
  onRemove,
  onRetry,
}: {
  draft: AttachmentDraft;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const line = draftStatusLine(draft);
  const uploading = draft.status === "uploading";
  const measured = uploading && line.percent !== null;
  const failed = draft.status === "failed";
  const thumbnail = useDraftThumbnail(draft);
  const label = attachmentDisplayName(draft);
  const retryable =
    failed && draft.issue !== undefined && isRetryableIssue(draft.issue);
  const Icon = isImageMime(draft.mime) ? ImageIcon : FileText;
  const asThumb = showsDraftThumbnail(draft) && !failed;
  const showStatus = failed || uploading || draft.status === "ready" || draft.status === "verifying";
  const name = splitFileName(label);

  const statusText = (
    <span
      className={cn(
        "min-w-0 break-words text-meta",
        line.danger ? "text-danger" : "text-ink-muted",
        !showStatus && "sr-only"
      )}
      data-testid="attachment-chip-status"
    >
      {line.text}
      {line.percent !== null && (
        <>
          {" "}
          <span data-numeric data-testid="attachment-chip-percent">
            {line.percent}%
          </span>
        </>
      )}
    </span>
  );

  if (asThumb) {
    return (
      <li
        data-testid="attachment-chip"
        data-attachment-status={draft.status}
        data-thumb={thumbnail.status}
        title={label}
        className="group relative size-tray-thumb shrink-0 overflow-hidden rounded-md bg-surface-hover"
      >
        {thumbnail.status === "ready" ? (
          <img
            src={thumbnail.dataUrl}
            alt=""
            draggable={false}
            data-testid="attachment-chip-thumb"
            className={cn(
              "size-full object-cover",
              (uploading || draft.status === "verifying") && "opacity-70"
            )}
          />
        ) : (
          // 로딩·디코드 실패: 같은 중립 상자 + 아이콘. 칩이 도착 순간에 자라지 않는다.
          <span
            aria-hidden="true"
            className="flex size-full items-center justify-center"
          >
            <Icon className="size-4 text-ink-muted" />
          </span>
        )}
        <span className="sr-only" data-testid="attachment-chip-name">
          {label}
        </span>
        <span className="sr-only">{statusText}</span>

        {uploading && <ChipProgress draft={draft} measured={measured} />}
        <RemoveButton draft={draft} alwaysVisible={false} onRemove={onRemove} />
      </li>
    );
  }

  return (
    <li
      data-testid="attachment-chip"
      data-attachment-status={draft.status}
      data-thumb={thumbnail.status}
      className={cn(
        "group relative flex min-h-tray-thumb min-w-0 max-w-pane items-center gap-2 overflow-hidden rounded-md bg-surface-hover py-1 pl-3 pr-8",
        failed && "border border-danger"
      )}
    >
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", line.danger ? "text-danger" : "text-ink-muted")}
      />
      <span className="flex min-w-0 flex-col">
        {/* 가운데에서 생략한다 (리뷰 N-A): 끝에서 자르면 확장자가 가장 먼저 죽는다. */}
        <span
          className="flex min-w-0 items-baseline text-label text-ink"
          data-testid="attachment-chip-name"
          title={label}
        >
          <span className="min-w-0 truncate">{name.head}</span>
          {name.tail !== "" && <span className="shrink-0">{name.tail}</span>}
        </span>
        {statusText}
      </span>
      {retryable && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRetry(draft.localId)}
          data-testid="attachment-chip-retry"
          // 위험 톤이 아니다 (design-review H-4): 이 컨트롤은 「여기로 나가라」다.
          className="shrink-0 focus-visible:focus-ring"
        >
          {ATTACH_COPY.retry}
        </Button>
      )}
      {uploading && <ChipProgress draft={draft} measured={measured} />}
      <RemoveButton draft={draft} alwaysVisible={failed} onRemove={onRemove} />
    </li>
  );
}

/**
 * 클립 버튼. 숨은 `<input type="file">`을 여는 label 이 아니라 button 인 이유는
 * 이 컨트롤이 폼 안에 살기 때문이다: label 은 클릭을 input 으로 넘기지만 키보드
 * 포커스 순서에서 자기 자리를 갖지 못하고, 폼 제출을 막지도 못한다.
 */
export function AttachButton({
  onPick,
  disabled,
  className,
}: {
  onPick: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          // 같은 파일을 두 번 고를 수 있어야 한다. 값을 비우지 않으면 두 번째
          // 선택에 change 가 아예 발화하지 않는다.
          event.target.value = "";
          onPick(picked);
        }}
      />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("tap-target", className)}
        disabled={disabled ?? false}
        onClick={() => inputRef.current?.click()}
        aria-label={ATTACH_COPY.attach}
        title={ATTACH_COPY.attach}
        data-testid="composer-attach"
      >
        <Plus />
      </Button>
    </>
  );
}

/**
 * 낭독할 한 줄을 **바뀐 것에서만** 만든다 (리뷰 M-A).
 *
 * live region 의 텍스트는 바뀔 때만 읽힌다. 1차 수리는 그 자리에 목록 전체를
 * 이어 붙였고, 텍스트 노드가 하나라 한 칩이 바뀔 때마다 20줄이 통째로 다시
 * 읽혔다. 이제 앞 상태를 ref 로 들고 다니며 낱말이 달라진 칩만 문장으로 만들고,
 * 아무것도 안 바뀐 렌더에서는 **문장을 그대로 둔다** — 그러면 노드가 안 바뀌고
 * 보조기술은 아무것도 다시 읽지 않는다.
 *
 * 효과에서 계산하는 이유: 렌더 중에 ref 를 쓰면 StrictMode 의 두 번째 렌더가
 * 같은 전이를 두 번 삼키고, 그때 첫 번째 전이가 낭독에서 사라진다.
 */
function useAttachmentAnnouncement(drafts: AttachmentDraft[]): string {
  const previous = useRef<AttachmentDraft[]>([]);
  const [sentence, setSentence] = useState("");
  useEffect(() => {
    const next = draftAnnouncement(previous.current, drafts);
    previous.current = drafts;
    if (next !== null) setSentence(next);
  }, [drafts]);
  return sentence;
}

/**
 * 트레이 전체. 첨부가 하나도 없고 알릴 것도 없으면 **서지 않는다** — 빈 제목
 * 줄은 컴포저 위의 죽은 공간이다.
 */
export function AttachmentTray({
  drafts,
  rejected,
  folders,
  onRemove,
  onRetry,
  onClear,
  onAcknowledgeNotices,
}: {
  drafts: AttachmentDraft[];
  /** 20개 상한에 걸려 자리를 못 얻은 개수. */
  rejected: number;
  /** 폴더라서 받지 못한 개수 (design-review M-4). */
  folders: number;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
  onClear: () => void;
  onAcknowledgeNotices: () => void;
}) {
  // 훅은 이른 반환보다 위에 있어야 한다: 트레이가 섰다 사라지는 것은 흔한 일이고,
  // 그 사이에 훅 순서가 달라지면 React 가 상태를 잘못 이어 붙인다.
  const announcement = useAttachmentAnnouncement(drafts);
  // 비활성 버튼은 자기가 왜 비활성인지 말하지 못한다. 그 문장이 사는 자리는
  // 버튼 옆이 아니라 트레이 발치이고, 그 규율은 오프라인 줄이 이미 세워 뒀다.
  const blocked = sendBlockReason(drafts);
  const blockedCopy = sendBlockCopy(drafts);

  if (drafts.length === 0 && rejected === 0 && folders === 0) return null;

  return (
    <div
      className="attachment-tray flex flex-col gap-1"
      data-testid="attachment-tray"
    >
      {/* 보조기술이 듣는 한 줄 (design-review H-3).
          칩의 상태 문장에 live region 을 붙이면 진행률이 바뀔 때마다 낭독돼
          소음이 된다. 낱말이 바뀔 때만 바뀌는 문장 하나만 공손히 알린다 — 이 PR 의
          무게중심인 「확인 중 → 업로드 완료」 전이가 여기서 소리를 얻는다. */}
      <p className="sr-only" role="status" data-testid="attachment-announce">
        {announcement}
      </p>
      {/* 제목은 시각에서 빠지고 목록의 이름으로만 남는다 (#3820): 입력창 안의 칩은
          「첨부 파일 N」 머리 없이도 첨부로 읽힌다. */}
      {drafts.length > 0 && (
        // 상한만큼 채워도 창을 먹지 않는다 (design-review B-2): 칩이 줄바꿈되고
        // 최대 높이에서 스크롤한다.
        <ul
          className="flex max-h-tray-max flex-wrap gap-2 overflow-y-auto py-1"
          aria-label={`${ATTACH_COPY.tray} ${drafts.length}`}
          data-testid="attachment-list-scroll"
        >
          {drafts.map((draft) => (
            <DraftChip
              key={draft.localId}
              draft={draft}
              onRemove={onRemove}
              onRetry={onRetry}
            />
          ))}
        </ul>
      )}
      {/* 칩이 많을 때만 (CLEAR_ALL_MIN_DRAFTS): 셋 이하는 하나씩 지우는 쪽이 빠르다. */}
      {drafts.length >= CLEAR_ALL_MIN_DRAFTS && (
        <div className="flex justify-end px-2">
          <button
            type="button"
            onClick={onClear}
            data-testid="attachment-clear"
            className={cn(
              "touch-target rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink",
              "focus-visible:focus-ring"
            )}
          >
            {ATTACH_COPY.clearAll}
          </button>
        </div>
      )}
      {/* 받지 못한 것은 **말하고 나서** 사라진다. mac 은 여기서 말없이 떨궜고,
          말없이 사라진 파일은 사용자가 보낸 줄 아는 파일이다. */}
      {(rejected > 0 || folders > 0) && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 px-2 text-meta text-warn"
          data-testid="attachment-rejected"
        >
          {rejected > 0 && (
            <span>
              <span data-numeric>{rejected}</span>개는 한 메시지의 상한을 넘어 넣지
              못했습니다.
            </span>
          )}
          {folders > 0 && <span>{ATTACH_COPY.folderRejected}</span>}
          <button
            type="button"
            onClick={onAcknowledgeNotices}
            className={cn(
              "touch-target rounded-sm underline underline-offset-2 hover:text-ink",
              "focus-visible:focus-ring"
            )}
          >
            확인
          </button>
        </p>
      )}
      {/* 이 줄은 **비어 있어도 자리를 지킨다** (design-review M-3). 앞 판은
          마지막 파일이 끝나는 순간 이 문장이 사라지면서 대화 전체를 22px 위로
          당겼다 — 같은 PR 의 `AttachmentList` 가 "이미지가 도착하는 순간 아래
          대화가 밀려 내려가면 읽고 있던 줄이 눈 밑에서 움직인다"고 스스로 세운
          규율이 정작 트레이에는 적용되지 않았다. */}
      {drafts.length > 0 && (
        <p
          className={cn(
            "px-2 text-meta",
            blocked === "failed" ? "text-warn" : "text-ink-muted"
          )}
          data-testid="attachment-blocked"
          {...(blocked === null ? {} : { "data-block-reason": blocked })}
        >
          {/* 할 말이 없을 때의 공백 한 칸. 빈 <p> 는 줄 상자를 만들지 않아 높이가
              0 이 되고, 그러면 이 줄을 예약해 둔 이유가 없어진다. `min-h-*` 대신
              이것을 쓰는 이유는 높이의 정본이 `--text-meta--line-height` 하나여야
              하기 때문이다 — 두 번째 수를 적어 두면 폰트 스케일을 손볼 때 갈라진다. */}
          {blockedCopy ?? NBSP}
        </p>
      )}
    </div>
  );
}
