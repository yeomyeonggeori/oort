import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { cn } from "@/design/lib/cn";
import { STAGE_MOTION } from "@/design/motion";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { AttachmentDownloadButton } from "@/features/attachments/AttachmentDownloadButton";
import { useAttachmentPreview } from "@/features/attachments/content";
import {
  imageLightboxViewState,
  lightboxInfoLines,
  lightboxPositionLabel,
  nextImageLightboxIndex,
  updateAttachmentIdSet,
} from "@/features/attachments/imageLightboxModel";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { IS_TAURI } from "@/lib/env";
import {
  attachmentDisplayName,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

// =============================================================================
// 이미지 미리보기 (#1686 · #3820 · #4751).
//
// 화면 전체가 뷰어이고, 무대는 블러된 앱이다(흰 머리 띠 없음). 사진은 남는 영역에 `object-contain`으로 가장 크게, 가운데에
// 선다. 조작은 사진 위에 뜬 **둥근 유리 아이콘 버튼**(가는 테두리)이고, 글자 버튼은 없다:
//
//   위 왼쪽      보낸 사람(굵게) + 그 아래 날짜·시각. 파일 이름은 툴팁과 보조 글로 내려갔다. 데스크탑 셸에서는
//               신호등 자리(`--titlebar-inset`)를 비운다.
//   위 오른쪽    받기 · 닫기(X)
//   양옆 가운데  이전 · 다음 (두 장 이상일 때만)
//   아래 가운데  썸네일 줄(두 장 이상) + 「N장 중 n번」 캡션
//
// 칩과 버튼은 전부 `glass`다: 유리를 끄면(투명도 줄이기·고대비) 같은 유틸이 불투명 면으로 돌아가고, 무대도 불투명한 어두운
// 면이 된다(`tokens.css`의 `--lightbox-stage`). 글자는 칩 위에만 서므로 대비는 칩의 면과 짝이다.
// =============================================================================

/**
 * 둥근 유리 아이콘 버튼의 한 벌. `Button`(ghost, icon: 34px 원)에 `glass`(블러 + 가는 테두리)를 얹는다. 위 줄과 양옆 칸은
 * 포인터를 받지 않으므로(빈 곳을 누르면 무대가 닫는다) 버튼이 `pointer-events-auto`로 자기 자리를 되찾는다.
 */
const GLASS_ROUND_BUTTON = "glass pointer-events-auto tap-target";

function LightboxImage({
  workspaceId,
  channelId,
  attachment,
  offline,
  onStageClick,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  offline: boolean;
  /** 사진 둘레의 빈 무대를 눌렀을 때(바깥 클릭: 닫기). */
  onStageClick: (event: MouseEvent<HTMLElement>) => void;
}) {
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment.id,
    true
  );
  const state = imageLightboxViewState({
    hasImage: true,
    previewStatus: preview.status,
    offline,
  });

  if (state === "loading") {
    return (
      <div
        role="status"
        data-testid="image-lightbox-loading"
        className="flex h-preview-frame w-pane max-w-full items-center justify-center rounded-md bg-surface-hover"
      >
        <span className="text-body text-ink-muted">이미지 불러오는 중</span>
      </div>
    );
  }

  if (state === "offline") {
    return (
      <div
        data-testid="image-lightbox-offline"
        className="w-pane max-w-full overflow-hidden rounded-md border border-line bg-surface-raised"
      >
        <InlineBanner
          tone="neutral"
          separator={false}
          message="연결 끊김, 이미지를 불러오려면 다시 연결하세요."
        />
      </div>
    );
  }

  if (state === "error" || preview.status === "failed") {
    return (
      <div
        data-testid="image-lightbox-error"
        className="w-pane max-w-full overflow-hidden rounded-md border border-line bg-surface-raised"
      >
        <InlineBanner
          separator={false}
          message="미리보기를 불러오지 못했습니다. 다시 시도하거나 위에서 파일을 내려받으세요."
          actionLabel="다시 시도"
          onAction={preview.retry}
        />
      </div>
    );
  }

  // 위 상태 함수와 PreviewState의 두 유니온이 서로 다른 모듈에 있어 TypeScript는
  // ready의 상관관계를 자동으로 좁히지 못한다. 이 갈래는 런타임에는 닿지 않는다.
  if (preview.status !== "ready") return null;

  return (
    <div
      className="flex min-h-0 min-w-0 w-full flex-1 flex-col items-center self-stretch"
      onClick={onStageClick}
    >
      {offline ? (
        <InlineBanner
          tone="neutral"
          separator={false}
          className="w-fit max-w-full rounded-md"
          message="연결 끊김, 저장된 이미지를 계속 표시합니다."
          testId="image-lightbox-offline-cached"
        />
      ) : null}
      <div
        data-testid="image-lightbox-ready"
        className="flex min-h-0 min-w-0 w-full flex-1 items-center justify-center"
        onClick={onStageClick}
      >
        <img
          src={preview.dataUrl}
          alt={attachmentDisplayName(attachment)}
          draggable={false}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </div>
  );
}

/** 아래 썸네일 한 장. 고른 장은 굵은 테두리이고, 누르면 그 장으로 간다. */
function LightboxThumb({
  workspaceId,
  channelId,
  attachment,
  index,
  count,
  selected,
  onSelect,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  index: number;
  count: number;
  selected: boolean;
  onSelect: (attachmentId: string) => void;
}) {
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment.id,
    true
  );
  const ref = useRef<HTMLButtonElement | null>(null);
  // 줄이 창보다 길면 가로로 스크롤되므로, 고른 장이 늘 보이게 한다.
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [selected]);
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(attachment.id)}
      aria-label={`${lightboxPositionLabel(index, count)} 이미지 보기`}
      aria-current={selected ? "true" : undefined}
      data-testid="image-lightbox-thumb"
      data-selected={selected ? "" : undefined}
      className={cn(
        "size-control-lg shrink-0 overflow-hidden rounded-md border-2 press focus-visible:focus-ring",
        selected
          ? "border-ink"
          : "border-transparent hover:border-line-strong"
      )}
    >
      {preview.status === "ready" ? (
        <img
          src={preview.dataUrl}
          alt=""
          draggable={false}
          className="size-full object-cover"
        />
      ) : (
        <span aria-hidden="true" className="block size-full bg-surface-hover" />
      )}
    </button>
  );
}

// 프로그램매틱 Dialog 정본 패턴을 그대로 쓴다: open prop + 바깥 button onClick +
// DialogContent opener. DialogTrigger는 쓰지 않는다. 이 Dialog의 role/data-state를
// escapeLayer.ts가 감지하므로 아래 라우트나 서랍은 같은 Esc를 함께 받지 않는다.
export function ImageLightbox({
  open,
  workspaceId,
  channelId,
  images,
  selectedId,
  opener,
  offline,
  senderName,
  sentAtMs,
  onSelect,
  onOpenChange,
}: {
  open: boolean;
  workspaceId: string;
  channelId: string;
  images: MessageAttachment[];
  selectedId: string | null;
  opener: DialogFocusTarget | null;
  offline: boolean;
  /** 위 왼쪽 칩의 첫 줄(보낸 사람). 모르면 파일 이름이 대신 선다. */
  senderName?: string | null;
  /** 위 왼쪽 칩의 둘째 줄(보낸 시각). 아직 서버 시각이 없으면 생략한다. */
  sentAtMs?: number | null;
  onSelect: (attachmentId: string) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const [downloadBusyIds, setDownloadBusyIds] = useState<Set<string>>(
    () => new Set()
  );
  const [downloadFailureIds, setDownloadFailureIds] = useState<Set<string>>(
    () => new Set()
  );
  const selectedIndex = images.findIndex((image) => image.id === selectedId);
  const selected = selectedIndex >= 0 ? images[selectedIndex] : null;
  const multi = selected !== null && images.length > 1;
  const downloadFailed = selected
    ? downloadFailureIds.has(selected.id)
    : false;
  const fileName = selected
    ? attachmentDisplayName(selected)
    : "이미지 미리보기";
  const info = selected
    ? lightboxInfoLines({ senderName, sentAtMs, fileName })
    : null;

  const move = (key: string) => {
    const next = nextImageLightboxIndex(selectedIndex, images.length, key);
    if (next !== null) onSelect(images[next].id);
    return next !== null;
  };

  // 바깥 클릭. 무대가 창 전체라서 Radix는 「바깥」을 못 본다(패널 안이 곧 창이다): 빈 무대 자신이 눌렸을 때만 닫는다.
  // 칩·버튼·사진을 누른 클릭은 target이 달라 닫지 않는다.
  const closeOnStageClick = (event: MouseEvent<HTMLElement>) => {
    if (event.target === event.currentTarget) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        opener={opener}
        motion={STAGE_MOTION}
        data-testid="image-lightbox"
        className="lightbox-panel left-0 top-0 h-full max-w-none translate-x-0 gap-0 overflow-hidden rounded-none border-0 bg-lightbox-stage"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (!move(event.key)) return;
          event.preventDefault();
        }}
        onClick={closeOnStageClick}
      >
        {/* 대화상자의 이름은 파일 이름이다. 눈에 보이는 첫 줄은 보낸 사람이라 이 둘을 따로 둔다. */}
        <DialogTitle className="sr-only">{fileName}</DialogTitle>
        <DialogDescription className="sr-only">
          {selected
            ? `${lightboxPositionLabel(selectedIndex, images.length)} 이미지입니다. 왼쪽과 오른쪽 화살표로 이미지를 이동합니다.`
            : "표시할 이미지가 없습니다."}
        </DialogDescription>

        <div
          className="lightbox-body"
          data-testid="image-lightbox-stage"
          data-multi={multi ? "" : undefined}
          data-thumbs={multi ? "" : undefined}
          onClick={closeOnStageClick}
        >
          {/* 내려받기 실패는 사진 위 무대 흐름에 선다(전에는 머리 띠 아래 전폭 배너였다). 위 줄(칩·버튼)에 끼우면 좁은 폭이나
              긴 이름에서 폭이 0으로 눌린다. 면은 유리가 아니라 불투명한 `surface-raised`다: 위험 글자(--danger)의 대비는 그 면과
              짝으로만 재어져 있고, 반투명 유리 위에서는 바닥에 따라 4.5:1 아래로 내려갔다. */}
          {downloadFailed ? (
            <div className="pointer-events-auto mb-3 w-full max-w-pane-md shrink-0 overflow-hidden rounded-lg bg-surface-raised shadow-lg">
              <InlineBanner
                separator={false}
                message="파일을 내려받지 못했습니다. 연결을 확인한 뒤 다시 시도하세요."
                testId="image-lightbox-download-error"
              />
            </div>
          ) : null}
          {selected ? (
            <LightboxImage
              key={selected.id}
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={selected}
              offline={offline}
              onStageClick={closeOnStageClick}
            />
          ) : (
            <EmptyInvite
              headline="표시할 이미지가 없습니다."
              detail="라이트박스를 닫고 다른 이미지를 선택하세요."
              actions={
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="tap-target"
                  onClick={() => onOpenChange(false)}
                >
                  닫기
                </Button>
              }
              className="w-pane max-w-full rounded-md bg-surface-raised"
              testId="image-lightbox-empty"
            />
          )}
        </div>

        <div
          className="lightbox-chrome"
          data-desktop-shell={IS_TAURI ? "" : undefined}
        >
          {info ? (
            <div
              data-testid="image-lightbox-info"
              title={info.fileName}
              // 두 줄 모두 `--ink`다(보조 글자색 아님). 칩은 반투명 유리라 바닥이 사이드바 띠(어두운 테마에서는 짙은 남색)여도 글자가
              // 읽혀야 하고, `--ink-muted`는 그 바닥에서 3.7~4.4:1까지 내려갔다(design-review). 위계는 굵기와 크기가 진다.
              className="glass pointer-events-auto flex min-w-0 max-w-pane flex-col rounded-lg px-3 py-1 text-ink"
            >
              <span className="truncate text-label font-semibold">
                {info.primary}
              </span>
              {info.secondary !== null ? (
                <time
                  data-numeric
                  dateTime={
                    sentAtMs !== null && sentAtMs !== undefined
                      ? new Date(sentAtMs).toISOString()
                      : undefined
                  }
                  className="truncate text-meta"
                  data-testid="image-lightbox-sent-at"
                >
                  {info.secondary}
                </time>
              ) : null}
            </div>
          ) : (
            <span aria-hidden="true" />
          )}

          <div className="flex shrink-0 items-center gap-2">
            {selected ? (
              <AttachmentDownloadButton
                workspaceId={workspaceId}
                channelId={channelId}
                attachment={selected}
                busy={downloadBusyIds.has(selected.id)}
                tapTarget
                className="glass pointer-events-auto size-icon-button rounded-full text-ink"
                onBusyChange={(busy) =>
                  setDownloadBusyIds((current) =>
                    updateAttachmentIdSet(current, selected.id, busy)
                  )
                }
                onStarted={() =>
                  setDownloadFailureIds((current) =>
                    updateAttachmentIdSet(current, selected.id, false)
                  )
                }
                onFailed={() =>
                  setDownloadFailureIds((current) =>
                    updateAttachmentIdSet(current, selected.id, true)
                  )
                }
              />
            ) : null}
            <Button
              ref={closeRef}
              type="button"
              variant="ghost"
              size="icon"
              className={GLASS_ROUND_BUTTON}
              onClick={() => onOpenChange(false)}
              aria-label="닫기"
              title="닫기"
              data-testid="image-lightbox-close"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </div>

        {multi ? (
          <>
            <div className="lightbox-side" data-side="start">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={GLASS_ROUND_BUTTON}
                onClick={() => move("ArrowLeft")}
                aria-label="이전 이미지"
                title="이전 이미지"
                data-testid="image-lightbox-previous"
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
            </div>
            <div className="lightbox-side" data-side="end">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={GLASS_ROUND_BUTTON}
                onClick={() => move("ArrowRight")}
                aria-label="다음 이미지"
                title="다음 이미지"
                data-testid="image-lightbox-next"
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>

            <div className="lightbox-foot">
              <div
                role="group"
                aria-label="이미지 목록"
                data-testid="image-lightbox-thumbs"
                className="glass pointer-events-auto flex max-w-full items-center gap-2 overflow-x-auto rounded-2xl p-2"
              >
                {images.map((image, index) => (
                  <LightboxThumb
                    key={image.id}
                    workspaceId={workspaceId}
                    channelId={channelId}
                    attachment={image}
                    index={index}
                    count={images.length}
                    selected={image.id === selected.id}
                    onSelect={onSelect}
                  />
                ))}
              </div>
              <p
                data-numeric
                aria-live="polite"
                aria-atomic="true"
                data-testid="image-lightbox-position"
                className="glass pointer-events-auto flex h-control items-center rounded-full px-4 text-meta text-ink"
              >
                {lightboxPositionLabel(selectedIndex, images.length)}
              </p>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
