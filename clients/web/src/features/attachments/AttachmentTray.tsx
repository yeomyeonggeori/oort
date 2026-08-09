import { FileText, ImageIcon, Paperclip, X } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  ATTACH_COPY,
  draftAnnouncement,
  draftStatusLine,
  isImageMime,
  isRetryableIssue,
  sendBlockCopy,
  sendBlockReason,
  type AttachmentDraft,
} from "@momo/core/features/attachments/model";

// =============================================================================
// 컴포저의 첨부 자리 (ADR-0151 D2 / #1202 첨부 축).
//
// **칩이지 카드가 아니다.** 첨부 하나마다 둥근 상자를 씌우면 입력창 위에 작은
// 카드들이 쌓이고, 그것이 이 앱이 금지한 「모든 행을 감싼 과대한 웹 카드」다
// (design-taste-web §8).
//
// ## 두 줄인 이유 (design-review B-1)
//
// R1 은 이름·상태·퍼센트를 **한 줄**에 놓고 이름에만 `truncate`, 상태에는
// `shrink-0` 을 걸었다. 그래서 줄어들 수 있는 유일한 것이 「무엇이」이고 줄어들지
// 않는 것이 「무엇이 잘못됐는지」였다: 320px 스레드 패널과 390px 폰에서 파일명이
// **0px 로 사라지고** 오류 문장이 「다시 시도」·✕ 위에 겹쳐 인쇄됐다. 긴 이름
// 탓이 아니라 6종 실패 문구 중 3종이 항상 그 폭을 넘었다.
//
// 이제 이름과 상태는 각자 줄을 갖는다. 이름은 `truncate`(한 줄이 맞다 — 파일명은
// 접히면 오히려 못 읽는다), 상태는 `break-words` 로 접힌다. 컨트롤은 바깥 행에
// 남아 어느 폭에서도 자기 자리를 잃지 않는다.
//
// ## 네 칸이 화면에서 다르게 보이는 방식
//
//   대기 중   회색 두 줄. 막대 자리는 비어 있다 — 아무 바이트도 안 움직인다.
//   업로드 중 회색 두 줄 + 막대. **아직 못 잰 동안은 흐르는 줄**(indeterminate),
//             첫 측정이 오면 그때부터 값이 있는 막대 + 퍼센트.
//   확인 중   회색 두 줄. 막대가 사라진다 — 셈이 끝났으므로 셈을 그리지 않는다.
//   업로드 완료 회색 두 줄. 조용하다.
//   실패     빨간 상태 줄 + (되돌릴 값이 있으면) 다시 시도 버튼.
//
// 「확인 중」에서 막대를 100%로 세워 두지 않는 것과, 첫 측정 전에 0짜리 막대를
// 그리지 않는 것이 같은 규율의 앞뒤다: 화면은 재지 않은 것을 잰 척하지 않는다.
// 막대 자리(2px)는 모든 칸에서 예약돼 있어서, 그 등장과 퇴장이 아래 줄을 밀지
// 않는다.
// =============================================================================

/** 막대 자리. 모든 칸에서 같은 높이를 차지해 칩이 상태에 따라 자라지 않는다. */
const PROGRESS_ROW_CLASS = "block h-marker w-full";

/** 줄 상자를 만드는 공백 한 칸. 빈 <p> 는 높이가 0 이라 예약이 되지 않는다. */
const NBSP = "\u00a0";

/**
 * 트레이 안쪽 컨트롤의 포커스 링.
 *
 * 집이 쓰는 값은 `outline-offset-2` 인데 여기서는 보이지 않는다: 칩 목록이
 * `overflow-y-auto` 스크롤 컨테이너라(B-2) 자식의 border box **바깥** 2px 에
 * 그려진 링이 위아래 가장자리에서 잘린다. 같은 2px 를 안쪽에 그리면 컨테이너가
 * 자를 수 없는 영역에 들어간다 — `ArtifactCard` 가 같은 이유로 같은 값을 쓴다.
 */
const INSET_FOCUS_RING =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

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
  // 0 은 「아직 안 쟀다」이지 「하나도 안 갔다」가 아니다 (design-review B-3).
  // 잰 값이 없는 동안은 값 없는 막대(indeterminate)를 그리고 퍼센트를 찍지 않는다.
  const measured = uploading && draft.progress > 0;
  const percent = Math.round(draft.progress * 100);
  const Icon = isImageMime(draft.mime) ? ImageIcon : FileText;
  const retryable =
    draft.status === "failed" &&
    draft.issue !== undefined &&
    isRetryableIssue(draft.issue);

  return (
    <li
      data-testid="attachment-chip"
      data-attachment-status={draft.status}
      className="flex items-center gap-2 rounded-sm px-2 py-1 hover:bg-surface-hover"
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          line.danger ? "text-danger" : "text-ink-muted"
        )}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-px">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className="min-w-0 truncate text-body text-ink"
            data-testid="attachment-chip-name"
            title={draft.name}
          >
            {draft.name}
          </span>
          {measured && (
            <span
              className="shrink-0 text-timestamp text-ink-muted"
              data-numeric
              data-testid="attachment-chip-percent"
            >
              {percent}%
            </span>
          )}
        </span>
        {/* `shrink-0` 이 없다. 좁은 폭에서 줄어들어야 하는 것은 이 줄이 아니라
            이 줄의 **줄 수**이고, 그래서 접힌다(B-1). */}
        <span
          className={cn(
            "min-w-0 break-words text-meta",
            line.danger ? "text-danger" : "text-ink-muted"
          )}
          data-testid="attachment-chip-status"
        >
          {line.text}
        </span>
        {uploading ? (
          <progress
            data-upload-progress
            data-testid="attachment-chip-progress"
            className={PROGRESS_ROW_CLASS}
            // `value` 를 **아예 달지 않는다**: 그것이 indeterminate 다. `undefined`
            // 를 넘기면 React 가 속성을 렌더하지 않으므로 이 한 줄이 두 주장을
            // 가른다 — "얼마인지 모른다" vs "0 이다".
            {...(measured ? { value: draft.progress, max: 1 } : {})}
            aria-label={`${draft.name} ${ATTACH_COPY.uploading}`}
          />
        ) : (
          <span aria-hidden="true" className={PROGRESS_ROW_CLASS} />
        )}
      </span>
      {retryable && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onRetry(draft.localId)}
          data-testid="attachment-chip-retry"
          // 위험 톤이 아니다 (design-review H-4). 빨강은 「이것이 잘못됐다」의
          // 언어고 이 컨트롤은 「여기로 나가라」다. 앞 판은 이 표면에서 유일하게
          // 누를 수 있는 것에 위험색을 입히고 hover 에서 중성색으로 물러났다.
          className={cn("shrink-0", INSET_FOCUS_RING)}
        >
          {ATTACH_COPY.retry}
        </Button>
      )}
      <button
        type="button"
        onClick={() => onRemove(draft.localId)}
        aria-label={`${draft.name} ${ATTACH_COPY.remove}`}
        title={ATTACH_COPY.remove}
        data-testid="attachment-chip-remove"
        className={cn(
          "touch-target flex size-control-sm shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink",
          INSET_FOCUS_RING
        )}
      >
        <X aria-hidden="true" className="size-4" />
      </button>
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
}: {
  onPick: (files: File[]) => void;
  disabled?: boolean;
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
        className="tap-target"
        disabled={disabled ?? false}
        onClick={() => inputRef.current?.click()}
        aria-label={ATTACH_COPY.attach}
        title={ATTACH_COPY.attach}
        data-testid="composer-attach"
      >
        <Paperclip />
      </Button>
    </>
  );
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
  if (drafts.length === 0 && rejected === 0 && folders === 0) return null;
  // 비활성 버튼은 자기가 왜 비활성인지 말하지 못한다. 그 문장이 사는 자리는
  // 버튼 옆이 아니라 트레이 발치이고, 그 규율은 오프라인 줄이 이미 세워 뒀다.
  const blocked = sendBlockReason(drafts);
  const blockedCopy = sendBlockCopy(drafts);

  return (
    <div
      className="flex flex-col gap-1 border-b border-line px-3 py-2"
      data-testid="attachment-tray"
    >
      {/* 보조기술이 듣는 한 줄 (design-review H-3).
          칩의 상태 문장에 live region 을 붙이면 진행률이 바뀔 때마다 낭독돼
          소음이 된다. 낱말이 바뀔 때만 바뀌는 문장 하나만 공손히 알린다 — 이 PR 의
          무게중심인 「확인 중 → 업로드 완료」 전이가 여기서 소리를 얻는다. */}
      <p className="sr-only" role="status" data-testid="attachment-announce">
        {draftAnnouncement(drafts)}
      </p>
      {drafts.length > 0 && (
        <div className="flex items-baseline justify-between gap-2 px-2">
          <h2 className="text-meta font-semibold text-ink-muted">
            {ATTACH_COPY.tray}{" "}
            <span data-numeric className="font-mono">
              {drafts.length}
            </span>
          </h2>
          <button
            type="button"
            onClick={onClear}
            data-testid="attachment-clear"
            className={cn(
              "touch-target rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink",
              INSET_FOCUS_RING
            )}
          >
            {ATTACH_COPY.clearAll}
          </button>
        </div>
      )}
      {drafts.length > 0 && (
        // 상한만큼 채워도 창을 먹지 않는다 (design-review B-2). 20개면 칩이
        // 720px 이라 타임라인이 통째로 밀려났고, 컴포저 하단은 `app-shell` 의
        // clip 밖으로 나가 스크롤로도 못 되찾았다.
        <ul
          className="flex max-h-tray-max flex-col overflow-y-auto"
          aria-label={ATTACH_COPY.tray}
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
              INSET_FOCUS_RING
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
