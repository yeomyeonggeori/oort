import {
  CircleAlert,
  Clapperboard,
  FileText,
  ImageIcon,
  Music,
  Plus,
  RotateCw,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import {
  ATTACH_COPY,
  attachmentDisplayName,
  draftAnnouncement,
  draftStatusLine,
  draftStatusWord,
  formatBytes,
  isRetryableIssue,
  sendBlockCopy,
  splitFileName,
  type AttachmentDraft,
  type UploadReasonFor,
} from "@momo/core/features/attachments/model";
import { uploadReasonKey } from "@momo/core/features/connection/uploadFailure";
import { useDraftThumbnail } from "./draftThumbnail";
import {
  cardKind,
  cardShape,
  focusAfterRemove,
  moveTarget,
  rovingStop,
  stripFade,
  trayCounts,
  trayKeyAction,
  type CardKind,
  type StripFade,
} from "./trayModel";

// =====================================================================
// 입력창 안 첨부 줄 (ADR-0151 D2 / #1202 · #3820 · #5200 Codex 입력창).
//
// **입력칸 테두리 안**, 글 칸 위에 둥근 카드가 **가로 한 줄**로 선다. 넘치면 가로로 밀고
// (넘치는 쪽만 가장자리가 흐리다), 줄 높이는 1개든 20개든 같다. 위 판(#3820)은 입력창
// **위**에 칩이 줄바꿈되며 쌓였고, 20개를 채우면 두 줄 · 세 줄로 자라 최대 높이에서 세로로
// 스크롤했다. owner 가 고른 레퍼런스(Codex 입력창)는 그 반대다: 줄은 하나이고 더 있다는
// 사실은 잘린 카드가 말한다.
//
// ## 카드의 세 모양 (`trayModel.cardShape`)
//
//   thumb   정사각 썸네일. 이름은 화면에 없다(그림으로 알아본다), 낭독에만 있다.
//   file    같은 높이에 가로로 넓다. 가운데 종류 아이콘 + 아래 이름·크기. 영상·PDF·로그,
//           그리고 그림이 못 된 그림(SVG·디코드 실패). 영상의 포스터는 그리지 않는다:
//           배포 CSP(`media-src` 가 `default-src 'self'` 로 떨어진다)가 `blob:` 영상을
//           막고, `createImageBitmap` 은 영상을 읽지 못한다. 그래서 「영상 표시」는 아이콘이다.
//   failed  이유를 읽어야 하므로 종류와 상관없이 이 모양이다. 이름 + 이유 + (되돌릴 값이
//           있으면) 다시 시도. 제거 ×는 늘 보인다.
//
// ## 진행과 완료
//
//   대기 · 확인 중 · 완료   조용하다. 문장은 sr-only (낭독은 live region 이 한다).
//   업로드 중              카드 아래 가장자리에 진행 막대. 아직 못 잰 동안은 흐르는 줄
//                          (indeterminate), 첫 측정부터 값 있는 막대 + 퍼센트.
//   파일 카드의 두 번째 줄  끝나면 크기, 진행 중에는 「크기 · 낱말 퍼센트」.
//
// 지켜진 앞 판의 규율: 「확인 중」에서 막대를 100% 로 세우지 않고 첫 측정 전에 0 짜리
// 막대를 그리지 않는다(B-3), 이름은 가운데에서 생략한다(N-A), 20개를 채워도 창을
// 먹지 않는다(B-2: 이제 한 줄이라 구조로 지켜진다), 발치 안내 줄은 비어도 자리를 지킨다(M-3).
//
// ## 입력창이 필요 이상 자라지 않는다 (#5328, owner 2026-11-05)
//
// 카드 한 변은 80(`--spacing-tray-card`, 처음 96), 카드 줄과 글 사이는 안내 줄 하나(16)다(카드 줄 아래 여백 없음,
// 안내 줄 아래는 글 칸 안여백과 겹침). 첨부를 넣으면 입력창이 126 → 98(css px) 자란다(캡처 레인 `capture-5200.mjs` 가 잰 값).
//
// ## 제거 ×
//
// 작은 원(눈에 보이는 것은 16px, 누르는 면은 24px)이 카드 오른쪽 위 **모서리에 걸친다** —
// 그림 가운데를 가리지 않는다. 호버 · 키보드 초점에서 드러나고(`pointer-hover`: 호버가
// 있는 입력에서만 숨김, 터치는 늘 보임), 실패한 카드에서는 늘 보인다. 네이티브 `title`
// 툴팁은 달지 않는다: 작은 모서리 단추 위에 큰 툴팁이 뜨는 것이 owner 가 짚은 방해였다.
//
// ## 키보드
//
// 카드 줄은 **탭 정거장 하나**다(로빙: 20장이어도 탭 한 번에 지나간다). 카드에서 ←/→/Home/End 로
// 옮기고, Backspace/Delete 로 뺀다. 뺀 뒤 초점은 같은 자리로 올라온 **옆 카드**, 하나뿐이었으면
// **글 칸**이다 — 초점이 사라진 카드와 함께 <body> 로 떨어지지 않는다. ×는 탭 순서에 없다
// (카드 20개 × 2 정거장 = 40번을 막는다). 낭독에는 그대로 있다.
// =====================================================================

/** 줄 상자를 만드는 공백 한 칸. 빈 <p> 는 높이가 0 이라 예약이 되지 않는다. */
const NBSP = "\u00a0";

const KIND_ICON: Record<CardKind, LucideIcon> = {
  image: ImageIcon,
  video: Clapperboard,
  audio: Music,
  file: FileText,
};

/** 카드 위의 제거 ×. 호버·키보드 초점에서 드러나고 터치에서는 늘 보인다. */
function RemoveButton({
  label,
  alwaysVisible,
  onRemove,
}: {
  label: string;
  alwaysVisible: boolean;
  onRemove: () => void;
}) {
  return (
    // 모서리에 걸린 24px 누르는 면(WCAG 2.5.8) 안에 눈에 보이는 16px 원이 있다. 원의 중심은 카드
    // 모서리에서 4px 안쪽이다(Codex 캡처: 134px 카드에서 6px). 원 둘레의 고리(`ring-surface`)는
    // 입력창 면의 색이라 어떤 그림 위에서도 원이 카드 가장자리와 갈라진다.
    <button
      type="button"
      tabIndex={-1}
      onClick={onRemove}
      aria-label={label}
      data-testid="attachment-chip-remove"
      data-always-visible={alwaysVisible ? "" : undefined}
      className="touch-target absolute -right-2 -top-2 flex size-6 items-center justify-center rounded-full press focus-visible:focus-ring pointer-hover:opacity-0 pointer-hover:group-hover:opacity-100 pointer-hover:group-focus-visible:opacity-100 pointer-hover:focus-visible:opacity-100 pointer-hover:data-always-visible:opacity-100"
    >
      <span
        aria-hidden="true"
        className="flex size-4 items-center justify-center rounded-full bg-primary text-on-primary ring-2 ring-surface"
      >
        <X className="size-2" strokeWidth={3} />
      </span>
    </button>
  );
}

/**
 * 업로드 진행 표시. 막대는 카드 **아래 가장자리**에 붙는다(카드 위에 얹힌 진행).
 * 첫 측정 전에는 값 없는 막대(indeterminate), 측정이 오면 값 있는 막대 (B-3:
 * 0 은 「아직 안 쟀다」이지 「하나도 안 갔다」가 아니다).
 */
function CardProgress({
  draft,
  measured,
}: {
  draft: AttachmentDraft;
  measured: boolean;
}) {
  return (
    // `li` 기준이다(면은 위치가 없다). 가장자리에서 12px 들인 이유: 둥근 모서리(반경 10) 밖으로 막대 끝이
    // 삐져나오지 않게 한다. `progress` 의 폭(100%)은 전역 규칙이라 래퍼가 폭을 준다.
    <span className="absolute inset-x-3 bottom-0 block">
      <progress
        data-upload-progress
        data-testid="attachment-chip-progress"
        className="block h-marker w-full"
        // `value` 를 **아예 달지 않는다**: 그것이 indeterminate 다.
        {...(measured ? { value: draft.progress, max: 1 } : {})}
        aria-label={`${attachmentDisplayName(draft)} ${ATTACH_COPY.uploading}`}
      />
    </span>
  );
}

/**
 * 이름. 가운데에서 생략한다 (리뷰 N-A): 끝에서 자르면 확장자가 가장 먼저 죽는다. 잘린 이름의 전체는 이름
 * 글자 위에서만 `title` 로 뜬다 — 카드 전체나 ×에는 툴팁이 없다(× 위에 큰 툴팁이 뜨는 것이 방해였다).
 */
function CardName({ label }: { label: string }) {
  const name = splitFileName(label);
  return (
    <span
      className="flex min-w-0 items-baseline text-label text-ink"
      title={label}
      data-testid="attachment-chip-name"
    >
      <span className="min-w-0 truncate">{name.head}</span>
      {name.tail !== "" && <span className="shrink-0">{name.tail}</span>}
    </span>
  );
}

/**
 * 카드 하나.
 *
 * 바깥 `li` 는 자르지 않는다: ×가 카드 모서리 **밖으로** 걸쳐 나와야 해서다. 그림을 둥글게
 * 자르는 `overflow-hidden` 은 안쪽 면(face)이 진다.
 *
 * 면(face)은 `position` 을 갖지 않는다. 초점 링(`focus-ring`)은 `li` 의 인셋 아웃라인인데, 위치를 가진
 * (`relative`) 자식은 자기 페인트 층을 가져 **부모의 아웃라인 위에 그려진다**(실측: 키보드 초점을 받은
 * 카드에 링이 없었다. `isolate` 로도 안 풀린다). 면이 위치를 갖지 않으면 링이 면 위에 선다. 그래서
 * 진행 막대는 면 안이 아니라 `li` 기준으로 놓고(`inset-x-3`), 둥근 모서리 밖으로 삐져나오지 않게
 * 가장자리에서 12px 들인다.
 */
function DraftCard({
  draft,
  stop,
  removeLabel,
  registerNode,
  onFocusCard,
  onKeyDown,
  onRemove,
  onRetry,
}: {
  draft: AttachmentDraft;
  /** 이 카드가 줄의 탭 정거장인가(로빙). */
  stop: boolean;
  removeLabel: string;
  registerNode: (localId: string, node: HTMLLIElement | null) => void;
  onFocusCard: (localId: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLLIElement>, localId: string) => void;
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  const reasonFor = useUploadReasonFor();
  const line = draftStatusLine(draft, reasonFor);
  const thumbnail = useDraftThumbnail(draft);
  const label = attachmentDisplayName(draft);
  const shape = cardShape(draft, thumbnail.status);
  const Icon = KIND_ICON[cardKind(draft.mime)];
  const uploading = draft.status === "uploading";
  const inFlight = uploading || draft.status === "verifying";
  const measured = uploading && line.percent !== null;
  const failed = shape === "failed";
  const retryable =
    failed && draft.issue !== undefined && isRetryableIssue(draft.issue);
  const settled = draft.status === "uploaded";
  const size = draft.sizeKnown ? formatBytes(draft.sizeBytes) : "";

  const percent = line.percent !== null && (
    <>
      {" "}
      <span data-numeric data-testid="attachment-chip-percent">
        {line.percent}%
      </span>
    </>
  );

  return (
    <li
      ref={(node) => registerNode(draft.localId, node)}
      data-testid="attachment-chip"
      data-attachment-card=""
      data-attachment-status={draft.status}
      data-thumb={thumbnail.status}
      data-card-shape={shape}
      tabIndex={stop ? 0 : -1}
      aria-keyshortcuts="Backspace Delete"
      onFocus={() => onFocusCard(draft.localId)}
      onKeyDown={(event) => onKeyDown(event, draft.localId)}
      className="group relative h-tray-card shrink-0 rounded-md focus-visible:focus-ring data-[card-shape=thumb]:w-tray-card data-[card-shape=file]:w-tray-card-wide data-[card-shape=failed]:w-tray-card-wide"
    >
      <div
        data-failed={failed ? "" : undefined}
        className="flex size-full flex-col overflow-hidden rounded-md border border-line bg-surface-muted data-failed:border-danger"
      >
        {shape === "thumb" && (
          <>
            {thumbnail.status === "ready" ? (
              <img
                src={thumbnail.dataUrl}
                alt=""
                draggable={false}
                data-testid="attachment-chip-thumb"
                data-in-flight={inFlight ? "" : undefined}
                className="size-full object-cover data-in-flight:opacity-70"
              />
            ) : (
              // 로딩 중: 같은 중립 상자 + 아이콘. 카드가 도착 순간에 자라지 않는다.
              <span
                aria-hidden="true"
                className="flex size-full items-center justify-center"
              >
                <Icon className="size-6 text-ink-muted" />
              </span>
            )}
            <span className="sr-only" data-testid="attachment-chip-name">
              {label}
            </span>
            <span className="sr-only" data-testid="attachment-chip-status">
              {line.text}
              {percent}
            </span>
          </>
        )}

        {shape === "file" && (
          <>
            <span
              aria-hidden="true"
              className="flex min-h-0 flex-1 items-center justify-center"
            >
              <Icon className="size-6 text-ink-muted" />
            </span>
            <span className="flex min-w-0 flex-col px-2 pb-2">
              <CardName label={label} />
              <span
                className="min-w-0 truncate text-meta text-ink-muted"
                data-testid="attachment-chip-status"
              >
                {settled ? (
                  <>
                    <span aria-hidden="true">{size}</span>
                    <span className="sr-only">{line.text}</span>
                  </>
                ) : (
                  <>
                    {line.text}
                    {percent}
                  </>
                )}
              </span>
            </span>
          </>
        )}

        {shape === "failed" && (
          <span className="flex size-full flex-col gap-1 p-2">
            <span className="flex min-w-0 items-center gap-2 pr-4">
              <CircleAlert
                aria-hidden="true"
                className="size-4 shrink-0 text-danger"
              />
              <CardName label={label} />
            </span>
            <span className="flex min-h-0 flex-1 items-end gap-2">
              {/* 이유(와 다음 행동)는 두 줄까지 보이고, 전부는 `title` 과 낭독에 있다. */}
              <span
                className="line-clamp-2 min-w-0 flex-1 break-keep text-meta text-danger"
                data-testid="attachment-chip-status"
                title={draftStatusWord(draft, reasonFor)}
              >
                {draftStatusWord(draft, reasonFor)}
              </span>
              {retryable && (
                // 글자 단추는 이 카드에 들지 않는다. 아이콘 단추이고 이름은 낭독이 읽는다.
                // 위험 톤이 아니다 (design-review H-4): 이 컨트롤은 「여기로 나가라」다.
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => onRetry(draft.localId)}
                  aria-label={ATTACH_COPY.retry}
                  data-testid="attachment-chip-retry"
                  className="size-control-sm shrink-0 bg-surface shadow-sm"
                >
                  <RotateCw aria-hidden="true" />
                </Button>
              )}
            </span>
          </span>
        )}

        {uploading && <CardProgress draft={draft} measured={measured} />}
      </div>
      <RemoveButton
        label={removeLabel}
        alwaysVisible={failed}
        onRemove={() => onRemove(draft.localId)}
      />
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
  const reasonFor = useUploadReasonFor();
  useEffect(() => {
    const next = draftAnnouncement(previous.current, drafts, reasonFor);
    previous.current = drafts;
    if (next !== null) setSentence(next);
  }, [drafts, reasonFor]);
  return sentence;
}

/**
 * 실패한 칩의 이유를 **원인의 분류 문장**으로 갈아 끼운다(#5221): 오프라인·서버에 닿지 못함이면 사전의 그 문장을, 아니면
 * `undefined`(칩의 기존 문장). 상태 코드는 문장에 없다. 눈에 보이는 줄과 낭독이 같은 길을 쓴다.
 */
function useUploadReasonFor(): UploadReasonFor {
  const formatMessage = useFormatMessage();
  return useCallback(
    (draft: AttachmentDraft) => {
      const key = uploadReasonKey(draft.failureCause);
      return key === null ? undefined : formatMessage(key);
    },
    [formatMessage]
  );
}

/**
 * 첨부 줄 전체. 첨부가 하나도 없고 알릴 것도 없으면 **서지 않는다** — 빈 줄은 입력창 안의
 * 죽은 공간이다.
 *
 * `returnFocus` 는 카드를 뺀 뒤 초점이 갈 글 칸이다. 줄이 입력창 **안**에 들어오면서 이 컴포넌트가
 * 글 칸의 형제가 되었으므로, 글 칸을 아는 쪽(컴포저)이 손잡이를 쥐여 준다.
 */
export function AttachmentTray({
  drafts,
  rejected,
  folders,
  onRemove,
  onRetry,
  onClear,
  onAcknowledgeNotices,
  returnFocus,
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
  returnFocus?: () => void;
}) {
  // 훅은 이른 반환보다 위에 있어야 한다: 줄이 섰다 사라지는 것은 흔한 일이고,
  // 그 사이에 훅 순서가 달라지면 React 가 상태를 잘못 이어 붙인다.
  const formatMessage = useFormatMessage();
  const announcement = useAttachmentAnnouncement(drafts);
  const counts = trayCounts(drafts, rejected, folders);
  // 비활성 버튼은 자기가 왜 비활성인지 말하지 못한다. 그 문장이 사는 자리는
  // 버튼 옆이 아니라 줄 발치이고, 그 규율은 오프라인 줄이 이미 세워 뒀다.
  const blockedCopy = sendBlockCopy(drafts);
  const ids = useMemo(() => drafts.map((draft) => draft.localId), [drafts]);
  const hasCards = drafts.length > 0;

  const listRef = useRef<HTMLUListElement>(null);
  const nodes = useRef(new Map<string, HTMLLIElement>());
  const [remembered, setRemembered] = useState<string | null>(null);
  const [fade, setFade] = useState<StripFade>("none");
  const stop = rovingStop(ids, remembered);

  const syncFade = useCallback(() => {
    const list = listRef.current;
    setFade(
      list === null
        ? "none"
        : stripFade({
            scrollLeft: list.scrollLeft,
            clientWidth: list.clientWidth,
            scrollWidth: list.scrollWidth,
          })
    );
  }, []);

  // 카드가 **끝에 붙었을 때** 끝으로 민다: 방금 붙인 카드가 보여야 한다(Codex 캡처도 끝에 서 있다).
  const previousIds = useRef<string[]>([]);
  useLayoutEffect(() => {
    const list = listRef.current;
    const before = previousIds.current;
    const appended =
      ids.length > before.length && before.every((id, at) => ids[at] === id);
    if (list !== null && appended) list.scrollLeft = list.scrollWidth;
    previousIds.current = ids;
    syncFade();
  }, [ids, syncFade]);

  // 창 폭·카드 폭이 바뀌면(디코드 실패로 정사각이 넓은 카드가 되는 경우 포함) 흐림을 다시 잰다.
  useEffect(() => {
    const list = listRef.current;
    if (list === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncFade);
    observer.observe(list);
    for (const child of Array.from(list.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [drafts, syncFade]);

  // 마우스 휠(세로)로도 줄이 가로로 밀린다. 가로 휠이 없는 마우스는 스크롤바를 숨긴 이 줄을
  // 달리 밀 방법이 없다. 더 밀 데가 없으면 가로채지 않는다(휠은 원래 자리로 간다).
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
      const max = list.scrollWidth - list.clientWidth;
      const next = Math.max(
        0,
        Math.min(max, list.scrollLeft + event.deltaY * (event.deltaMode === 1 ? 16 : 1))
      );
      if (max <= 0 || next === list.scrollLeft) return;
      list.scrollLeft = next;
      event.preventDefault();
    };
    // React 의 onWheel 은 수동(passive)이라 막지 못한다.
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, [hasCards]);

  const registerNode = useCallback((localId: string, node: HTMLLIElement | null) => {
    if (node === null) nodes.current.delete(localId);
    else nodes.current.set(localId, node);
  }, []);

  const focusCard = (localId: string | null): void => {
    if (localId === null) return;
    nodes.current.get(localId)?.focus();
  };

  /**
   * 카드를 뺀다. **초점이 그 카드 안에 있을 때만** 초점을 옮긴다(없던 초점을 만들지도,
   * 사라지는 카드와 함께 떨어뜨리지도 않는다): 키보드면 옆 카드, 마우스면 글 칸이다. 마우스 뒤에
   * 옆 카드로 가면 곧바로 Backspace 를 누르는 사람이 다음 첨부를 지운다.
   */
  const removeCard = (localId: string, viaKeyboard: boolean) => {
    const card = nodes.current.get(localId);
    if (card !== undefined && card.contains(document.activeElement)) {
      const next = viaKeyboard ? focusAfterRemove(ids, localId) : null;
      if (next === null) returnFocus?.();
      else {
        setRemembered(next);
        focusCard(next);
      }
    }
    onRemove(localId);
  };

  const onCardKeyDown = (event: KeyboardEvent<HTMLLIElement>, localId: string) => {
    // 카드 안의 다시 시도 단추에서 온 키는 그 단추의 것이다.
    if (event.target !== event.currentTarget) return;
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const action = trayKeyAction(event.key);
    if (action === null) return;
    event.preventDefault();
    if (action === "remove") {
      removeCard(localId, true);
      return;
    }
    const target = moveTarget(ids, localId, action);
    if (target !== null) {
      setRemembered(target);
      focusCard(target);
    }
  };

  if (!hasCards && !counts.showsNotice) return null;

  return (
    <div
      className="flex flex-col"
      data-testid="attachment-tray"
      data-attachment-tray=""
    >
      {/* 보조기술이 듣는 한 줄 (design-review H-3).
          카드의 상태 문장에 live region 을 붙이면 진행률이 바뀔 때마다 낭독돼
          소음이 된다. 낱말이 바뀔 때만 바뀌는 문장 하나만 공손히 알린다 — 이 PR 의
          무게중심인 「확인 중 → 업로드 완료」 전이가 여기서 소리를 얻는다. */}
      <p className="sr-only" role="status" data-testid="attachment-announce">
        {announcement}
      </p>
      {/* 제목은 시각에서 빠지고 목록의 이름으로만 남는다 (#3820): 입력창 안의 카드는
          「첨부 파일 N」 머리 없이도 첨부로 읽힌다. */}
      {hasCards && (
        <ul
          ref={listRef}
          aria-label={`${ATTACH_COPY.tray} ${drafts.length}`}
          data-testid="attachment-list-scroll"
          data-fade={fade}
          onScroll={syncFade}
          className="tray-strip flex gap-2 px-3 pt-2"
        >
          {drafts.map((draft) => (
            <DraftCard
              key={draft.localId}
              draft={draft}
              stop={draft.localId === stop}
              removeLabel={formatMessage("attachments.tray.removeNamed", {
                name: attachmentDisplayName(draft),
              })}
              registerNode={registerNode}
              onFocusCard={setRemembered}
              onKeyDown={onCardKeyDown}
              onRemove={(localId) => removeCard(localId, false)}
              onRetry={onRetry}
            />
          ))}
        </ul>
      )}
      {/* 받지 못한 것은 **말하고 나서** 사라진다. mac 은 여기서 말없이 떨궜고,
          말없이 사라진 파일은 사용자가 보낸 줄 아는 파일이다. */}
      {counts.showsNotice && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-x-2 px-3 text-meta text-warn"
          data-testid="attachment-rejected"
        >
          {counts.rejected > 0 && (
            <span>
              {formatMessage("attachments.tray.overflow", {
                count: counts.rejected,
                max: counts.limit,
              })}
            </span>
          )}
          {counts.folders > 0 && <span>{ATTACH_COPY.folderRejected}</span>}
          <button
            type="button"
            onClick={onAcknowledgeNotices}
            className="touch-target rounded-sm underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
          >
            {formatMessage("attachments.tray.noticeDismiss")}
          </button>
        </p>
      )}
      {/* 이 줄은 **비어 있어도 자리를 지킨다** (design-review M-3). 앞 판은
          마지막 파일이 끝나는 순간 이 문장이 사라지면서 대화 전체를 22px 위로
          당겼다. 「모두 지우기」는 이 줄의 오른쪽 끝이다(Codex 입력창에는 없다: 카드 줄은 한 줄이라
          카드 위에 얹을 자리가 없고, 넷 이상일 때만 선다).
          #5328: 카드 줄과 글 사이 간격은 **이 줄 하나(16)** 다. 카드 줄 아래 여백(4)을 걷고, 이 줄 아래를 글 칸의
          위쪽 안여백(8)과 겹친다(`-mb-2`): 글 칸의 첫 글자는 이 줄 바로 밑에서 시작하므로 글자와는 겹치지 않고, 줄이
          더 위(`relative`)라 「모두 지우기」는 겹친 8px 에서도 눌린다. 그 밖의 겹친 면은 글 칸의 빈 안여백이라 눌러도
          그릇의 클릭 규칙이 글 칸에 초점을 돌려준다. 비어 있어도 자리를 지키는 약속(M-3)은 그대로다. */}
      {hasCards && (
        <div className="relative -mb-2 flex items-start justify-between gap-2 px-3">
          <p
            className="min-w-0 text-meta text-ink-muted data-[block-reason=failed]:text-warn"
            data-testid="attachment-blocked"
            {...(counts.blocked === null ? {} : { "data-block-reason": counts.blocked })}
          >
            {/* 할 말이 없을 때의 공백 한 칸. 빈 <p> 는 줄 상자를 만들지 않아 높이가
                0 이 되고, 그러면 이 줄을 예약해 둔 이유가 없어진다. `min-h-*` 대신
                이것을 쓰는 이유는 높이의 정본이 `--text-meta--line-height` 하나여야
                하기 때문이다 — 두 번째 수를 적어 두면 폰트 스케일을 손볼 때 갈라진다. */}
            {blockedCopy ?? NBSP}
          </p>
          {counts.showsClearAll && (
            <button
              type="button"
              onClick={onClear}
              data-testid="attachment-clear"
              className="touch-target shrink-0 rounded-sm text-meta text-ink-muted underline underline-offset-2 hover:text-ink focus-visible:focus-ring"
            >
              {ATTACH_COPY.clearAll}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
