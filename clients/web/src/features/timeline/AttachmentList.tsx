import { Expand, FileText, ImageIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { AttachmentDownloadButton } from "@/features/attachments/AttachmentDownloadButton";
import { AttachmentOpenPdfButton } from "@/features/attachments/AttachmentOpenPdfButton";
import {
  canOpenPdf,
  pdfOpenFailureCopy,
} from "@/features/attachments/pdfOpenModel";
import type { PdfOpenFailure } from "@/features/attachments/content";
import { useAttachmentPreview } from "@/features/attachments/content";
import { ImageLightbox } from "@/features/attachments/ImageLightbox";
import { lightboxAttachments } from "@/features/attachments/imageLightboxModel";
import { useRevealOnHover } from "@/features/attachments/useRevealOnHover";
import {
  ATTACH_COPY,
  attachmentDisplayName,
  formatBytes,
  formatMimeLabel,
  genericAttachmentName,
  imageGridColumns,
  isImageMime,
  showsInlinePreview,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

// =============================================================================
// 타임라인의 첨부 (ADR-0151 D2 / #1202 · #3820 Buzz 식 재배치).
//
// **메시지의 본문이지 떠 있는 패널이 아니다.** `MessageRow` 가 그리드·아바타·
// 타이포를 그대로 들고, 이것은 본문 자리만 채운다.
//
// ## 세 모양
//
//   이미지(상한 아래)  테두리 없는 인라인 그림. 한 장은 최대 폭·높이 안에서 비율을
//                      지키고, 여러 장은 정사각 격자(2열, 5장부터 3열).
//                      **파일명·크기·타입 줄이 없다.** 그림이 곧 내용이다.
//   PDF               컴팩트 파일 카드(아이콘 · 이름 · 「PDF · 크기」).
//   그 밖의 전부       같은 카드. 호버하면 내려받기가 선다(PDF 는 미리보기도).
//
// 앞 판(#2701)은 모든 첨부에 「이름 + 타입 · 크기 + 내려받기」 캡션 행을 붙였고
// (design-review H-2 가 그 행 문법을 카드와 맞추게 했다), 올린 파일의 이름이
// 무작위 토큰(`geGngQ…pQ.webp`)이면 그 캡션이 본문을 난잡하게 만들었다. 이제
// 이미지는 캡션을 갖지 않으므로 H-2 의 「같은 행 문법」은 파일 카드끼리의 약속으로
// 좁아졌다.
//
// ## 이름
//
// 화면과 보조기술의 이름은 `attachmentDisplayName` 만 거친다: 사람이 지은 이름은
// 그대로, 무작위 토큰 같은 이름은 「이미지」「PDF 문서」「파일」로 갈음한다.
//
// ## 행동은 드러날 때만 선다 (`useRevealOnHover`)
//
// 호버 · 키보드 포커스 · (파일 카드 한정) 터치. `opacity-0` 로 숨긴 버튼이 아니다.
//
// ## SVG
//
// SVG 는 이미지여도 카드다. 서버가 프록시 응답에 `nosniff` 와
// `Content-Disposition: attachment` 를 붙인 이유 — 올라온 SVG 안의 스크립트가 이
// 앱과 같은 출처에서 도는 것 — 를 화면이 뒤집지 않는다.
//
// ## 자리
//
// 서버는 이미지 치수를 주지 않는다. 받는 중에는 높이 `preview-frame`(180) 상자가
// 서고, 도착하면 그림의 비율대로 선다. 세로로 긴 그림은 상한(320)까지 자라고
// 가로로 긴 그림은 더 낮아진다. 격자 타일은 정사각 고정이라 이동이 없다.
// =============================================================================

/** 단일 이미지가 오는 동안의 자리. 셔머 없는 중립 면이다(SKILL §5). */
const PREVIEW_FRAME_CLASS =
  "flex h-preview-frame w-pane max-w-full items-center justify-center overflow-hidden rounded-md bg-surface-hover press hover:bg-surface-raised focus-visible:focus-ring";

/** 이미지 위에 뜨는 행동 줄. 면 위에 얹으므로 사진 위에서도 읽힌다. */
const OVERLAY_CLASS =
  "absolute right-2 top-2 flex items-center gap-1 rounded-md bg-surface shadow-sm";

function ImageTile({
  workspaceId,
  channelId,
  attachment,
  layout,
  position,
  onOpen,
  registerSource,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  layout: "single" | "grid-2" | "grid-3";
  /** 여러 장일 때의 「n/N」. 같은 이름(「이미지」)의 버튼들이 서로 구별되게 한다. */
  position: string | null;
  onOpen: (opener: HTMLButtonElement) => void;
  registerSource: (id: string, node: HTMLImageElement | null) => void;
}) {
  const [failed, setFailed] = useState(false);
  const { revealed, handlers } = useRevealOnHover();
  const label = attachmentDisplayName(attachment);
  const actionName = `${label}${position === null ? "" : ` ${position}`} ${ATTACH_COPY.expandImage}`;
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment.id,
    true
  );
  const single = layout === "single";
  const tileClass =
    layout === "grid-3" ? "size-inline-image-tile-sm" : "size-inline-image-tile";

  return (
    <figure
      data-testid="attachment-image"
      data-preview={preview.status}
      data-revealed={revealed ? "" : undefined}
      className={cn("relative m-0", single ? "w-fit max-w-full" : tileClass)}
      {...handlers}
    >
      <button
        type="button"
        data-row-action=""
        onClick={(event) => onOpen(event.currentTarget)}
        aria-label={actionName}
        title={label}
        className={
          preview.status === "ready"
            ? cn(
                "block max-w-full overflow-hidden rounded-md press focus-visible:focus-ring",
                !single && "size-full"
              )
            : cn(PREVIEW_FRAME_CLASS, !single && "size-full")
        }
      >
        {preview.status === "ready" ? (
          <img
            ref={node => registerSource(attachment.id, node)}
            src={preview.dataUrl}
            alt={label}
            className={
              single
                ? "block max-h-inline-image-h max-w-inline-image-w rounded-md object-contain"
                : "block size-full rounded-md object-cover"
            }
          />
        ) : (
          <span className="px-2 text-meta text-ink-muted">
            {preview.status === "loading"
              ? ATTACH_COPY.previewLoading
              : ATTACH_COPY.previewFailed}
          </span>
        )}
      </button>
      {revealed && (
        <div className={OVERLAY_CLASS} data-testid="attachment-image-actions">
          <AttachmentDownloadButton
            workspaceId={workspaceId}
            channelId={channelId}
            attachment={attachment}
            joinsMessageRow
            onStarted={() => setFailed(false)}
            onFailed={() => setFailed(true)}
          />
          <button
            type="button"
            data-row-action=""
            data-testid="attachment-expand"
            onClick={(event) => onOpen(event.currentTarget)}
            aria-label={actionName}
            title={ATTACH_COPY.expandImage}
            className="touch-target flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
          >
            <Expand aria-hidden="true" className="size-4" />
          </button>
        </div>
      )}
      {failed && (
        // 타일 위에 얹는다(자리를 예약할 필요가 없다): 아래로 흘리면 격자 줄이 밀린다.
        <span
          role="status"
          className="absolute inset-x-1 bottom-1 rounded-sm bg-surface px-1 text-meta text-danger"
          data-testid="attachment-download-failed"
        >
          {ATTACH_COPY.downloadFailed}
        </span>
      )}
    </figure>
  );
}

function ImageGroup({
  workspaceId,
  channelId,
  images,
  onOpen,
  registerSource,
}: {
  workspaceId: string;
  channelId: string;
  images: MessageAttachment[];
  onOpen: (attachmentId: string, opener: HTMLButtonElement) => void;
  registerSource: (id: string, node: HTMLImageElement | null) => void;
}) {
  const columns = imageGridColumns(images.length);
  const tiles = images.map((attachment, index) => (
    <ImageTile
      key={attachment.id}
      workspaceId={workspaceId}
      channelId={channelId}
      attachment={attachment}
      layout={columns === 1 ? "single" : columns === 2 ? "grid-2" : "grid-3"}
      registerSource={registerSource}
      position={images.length > 1 ? `${index + 1}/${images.length}` : null}
      onOpen={(opener) => onOpen(attachment.id, opener)}
    />
  ));
  if (columns === 1) return <>{tiles}</>;
  return (
    // 진짜 격자다: 열 수가 장수로 정해진다(폭이 넉넉하다고 한 줄로 늘어서지 않는다).
    <div
      data-testid="attachment-image-grid"
      data-columns={columns}
      className={cn("grid w-fit gap-1", columns === 2 ? "grid-cols-2" : "grid-cols-3")}
    >
      {tiles}
    </div>
  );
}

function FileCard({
  workspaceId,
  channelId,
  attachment,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
}) {
  const [failed, setFailed] = useState(false);
  const [openFailure, setOpenFailure] = useState<PdfOpenFailure | null>(null);
  const { revealed, handlers } = useRevealOnHover({ alwaysOnTouch: true });
  const Icon = isImageMime(attachment.mime) ? ImageIcon : FileText;
  const opensPdf = canOpenPdf(attachment);
  const label = attachmentDisplayName(attachment);
  const openFailureRef = useRef<HTMLParagraphElement | null>(null);
  // 실패 줄이 타임라인 맨 아래 행에서 생기면 컴포저 뒤로 들어간다(캡처에서 실측:
  // 행이 자라도 목록은 따라 내려가지 않는다). 문장이 선 순간 그 줄만 보이는
  // 자리로 당긴다. `nearest` 라 이미 보이면 아무것도 움직이지 않고, behavior 를
  // 주지 않아 즉시 이동이다(움직임 연출 없음).
  useEffect(() => {
    if (openFailure !== null) openFailureRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [openFailure]);
  // 한 카드에 실패 문장은 하나다 (design-review M1): 어느 행동을 새로 시작하든
  // 앞 행동의 실패는 지운다. 빨간 두 줄이 서로 다른 과거를 말하지 않게.
  const clearFailures = () => {
    setFailed(false);
    setOpenFailure(null);
  };
  const card = (
    <div
      data-testid="attachment-card"
      data-revealed={revealed ? "" : undefined}
      // 키보드 진입점: 카드가 포커스를 받으면(`:focus-visible`) 행동이 서고 Tab 이 그
      // 안으로 이어진다. 카드에 포커스할 것이 없으면 호버 없는 사람은 미리보기·
      // 내려받기에 닿지 못한다(design-review B1). 행 로빙 그룹에도 합류한다.
      tabIndex={0}
      role="group"
      aria-label={label}
      data-row-action=""
      // 폭은 고정이다(`w-pane`). 앞 판은 내용 폭(`w-fit`)이라 이름이 짧으면 카드가
      // 줄고, 행동 줄을 이름 위에 얹으면 이름 끝을 가리고 위 가장자리에 걸치면 앞
      // 줄 글자를 가렸다(캡처에서 둘 다 실측). 고정 폭 + 고정 크기의 행동 자리가
      // 호버가 아무것도 움직이지 않는 유일한 배치다.
      className="flex w-pane max-w-full items-center gap-3 rounded-lg border border-line bg-surface-raised px-3 py-2 focus-visible:focus-ring"
      {...handlers}
    >
      <span className="flex size-control shrink-0 items-center justify-center rounded-md bg-surface-hover">
        <Icon aria-hidden="true" className="size-4 text-ink-muted" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="min-w-0 truncate text-body text-ink" title={label}>
          {label}
        </span>
        <span className="text-meta text-ink-muted" data-testid="attachment-meta">
          {label === genericAttachmentName(attachment.mime)
            ? formatBytes(attachment.sizeBytes)
            : `${formatMimeLabel(attachment.mime)} · ${formatBytes(attachment.sizeBytes)}`}
        </span>
        {failed && (
          <span className="text-meta text-danger" data-testid="attachment-download-failed">
            {ATTACH_COPY.downloadFailed}
          </span>
        )}
      </span>
      {/* 행동 자리는 늘 같은 폭이다: 서 있지 않을 때는 같은 크기의 빈 상자가 자리를
          지킨다. 줄이 서고 접힐 때 이름 열이 움직이면 호버만으로 본문이 흔들린다. */}
      <span
        className="flex shrink-0 items-center gap-1"
        data-testid="attachment-card-actions"
        data-revealed={revealed ? "" : undefined}
      >
        {revealed ? (
          <>
            {/* PDF 만 연다 (#2701). 순서는 「보기 → 내려받기」: 더 가벼운 행동이 먼저다. */}
            {opensPdf && (
              <AttachmentOpenPdfButton
                workspaceId={workspaceId}
                channelId={channelId}
                attachment={attachment}
                onStarted={clearFailures}
                onFailed={setOpenFailure}
              />
            )}
            <AttachmentDownloadButton
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={attachment}
              joinsMessageRow
              onStarted={clearFailures}
              onFailed={() => setFailed(true)}
            />
          </>
        ) : (
          <>
            {opensPdf && <span aria-hidden="true" className="size-control shrink-0" />}
            <span aria-hidden="true" className="size-control shrink-0" />
          </>
        )}
      </span>
    </div>
  );
  if (!opensPdf) return card;
  return (
    <div className="flex min-w-0 flex-col">
      {card}
      {/* 열기 실패는 카드 **아래** 한 줄이다. 비어 있어도 서 있어서(높이 0)
          문장이 들어오는 순간 낭독된다. */}
      <p
        ref={openFailureRef}
        role="status"
        className={cn("max-w-pane-lg text-meta text-danger", openFailure !== null && "mt-1")}
        data-testid="attachment-open-failed"
      >
        {openFailure === null ? null : pdfOpenFailureCopy(openFailure)}
      </p>
    </div>
  );
}

/**
 * 한 메시지의 첨부 전부. 없으면 아무것도 그리지 않는다.
 *
 * `muted` 는 아직 확정되지 않은 행(낙관적 echo)이라는 뜻이다. 바이트는 이미
 * 보관소에 있으므로 카드는 **진짜**이고, 그래서 seq 가 도착해도 이 자리에서
 * 자라거나 줄어들 것이 없다 — 그 동일함이 행이 튀지 않는 이유다.
 */
export function AttachmentList({
  channelId,
  attachments,
  muted,
  senderName,
  sentAtMs,
}: {
  /** 첨부는 채널에 속한다. 프록시 주소가 그 사실 위에 서 있다. */
  channelId: string;
  attachments: MessageAttachment[];
  muted?: boolean;
  /** 이미지 미리보기 위 왼쪽 칩에 쓰는 보낸 사람(#4751). 모르면 칩이 파일 이름을 대신 쓴다. */
  senderName?: string;
  /** 같은 칩의 보낸 시각. 서버 시각이 아직 없는 echo 행은 넘기지 않는다. */
  sentAtMs?: number;
}) {
  // 워크스페이스는 셸이 이미 알고 있다. 타임라인 전체에 프롭으로 흘려보내는 대신
  // 여기서 읽는다 — `Composer` 가 같은 값을 같은 방법으로 읽는다.
  const { workspaceId, connStatus } = useSession();
  const [lightbox, setLightbox] = useState<{
    attachmentId: string;
  } | null>(null);
  // 닫힘 state를 먼저 반영해도 opener 자체는 남아 있어야 Radix의 closeAutoFocus가
  // WebKit에서도 원래 미리보기 버튼으로 돌아간다(dialog.tsx의 명시 opener 계약).
  const sources = useRef(new Map<string, HTMLImageElement>());
  const lightboxOpener = useRef<HTMLButtonElement | null>(null);
  const images = lightboxAttachments(attachments);
  const files = attachments.filter((attachment) => !showsInlinePreview(attachment));
  if (attachments.length === 0) return null;
  return (
    <>
      <ul
        className={cn("mt-1 flex flex-col gap-1", muted && "opacity-70")}
        data-testid="attachment-list"
      >
        {images.length > 0 && (
          <li className="min-w-0">
            <ImageGroup
              workspaceId={workspaceId}
              channelId={channelId}
              images={images}
              registerSource={(id, node) => {
                if (node) sources.current.set(id, node);
                else sources.current.delete(id);
              }}
              onOpen={(attachmentId, opener) => {
                lightboxOpener.current = opener;
                setLightbox({ attachmentId });
              }}
            />
          </li>
        )}
        {files.map((attachment) => (
          <li key={attachment.id} className="min-w-0">
            <FileCard
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={attachment}
            />
          </li>
        ))}
      </ul>
      <ImageLightbox
        open={lightbox !== null}
        workspaceId={workspaceId}
        channelId={channelId}
        images={images}
        selectedId={lightbox?.attachmentId ?? null}
        opener={lightboxOpener.current}
        source={id => sources.current.get(id) ?? null}
        offline={connStatus === "disconnected"}
        senderName={senderName ?? null}
        sentAtMs={sentAtMs ?? null}
        onSelect={(attachmentId) =>
          setLightbox((current) =>
            current === null ? null : { ...current, attachmentId }
          )
        }
        onOpenChange={(open) => {
          if (!open) setLightbox(null);
        }}
      />
    </>
  );
}
