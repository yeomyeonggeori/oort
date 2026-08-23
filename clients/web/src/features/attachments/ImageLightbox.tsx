import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRef, useState } from "react";
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
  nextImageLightboxIndex,
  updateAttachmentIdSet,
} from "@/features/attachments/imageLightboxModel";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import type { MessageAttachment } from "@momo/core/features/attachments/model";

function LightboxImage({
  workspaceId,
  channelId,
  attachment,
  offline,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  offline: boolean;
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
    <div className="flex min-h-0 w-full flex-1 flex-col">
      {offline ? (
        <InlineBanner
          tone="neutral"
          message="연결 끊김, 저장된 이미지를 계속 표시합니다."
          testId="image-lightbox-offline-cached"
        />
      ) : null}
      <div
        data-testid="image-lightbox-ready"
        className="flex min-h-0 flex-1 items-center justify-center p-4"
      >
        <img
          src={preview.dataUrl}
          alt={attachment.name}
          draggable={false}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    </div>
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
  const downloadFailed = selected
    ? downloadFailureIds.has(selected.id)
    : false;

  const move = (key: string) => {
    const next = nextImageLightboxIndex(selectedIndex, images.length, key);
    if (next !== null) onSelect(images[next].id);
    return next !== null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        opener={opener}
        data-testid="image-lightbox"
        className="lightbox-panel left-0 top-0 h-full max-w-none translate-x-0 gap-0 rounded-none border-0 bg-transparent"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          closeRef.current?.focus();
        }}
        onKeyDown={(event) => {
          if (!move(event.key)) return;
          event.preventDefault();
        }}
      >
        <div className="flex min-w-0 items-center gap-2 border-b border-line bg-surface-raised px-4 py-2">
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate">
              {selected?.name ?? "이미지 미리보기"}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {selected
                ? `전체 ${images.length}개 중 ${selectedIndex + 1}번째 이미지입니다. 왼쪽과 오른쪽 화살표로 이미지를 이동합니다.`
                : "표시할 이미지가 없습니다."}
            </DialogDescription>
          </div>

          {selected && images.length > 1 ? (
            <div
              role="group"
              aria-label="이미지 이동"
              className="flex shrink-0 items-center gap-1"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="tap-target"
                onClick={() => move("ArrowLeft")}
                aria-label="이전 이미지"
                title="이전 이미지"
                data-testid="image-lightbox-previous"
              >
                <ChevronLeft aria-hidden="true" />
              </Button>
              <span
                data-numeric
                aria-live="polite"
                aria-atomic="true"
                className="px-1 text-center font-mono text-meta text-ink-muted"
                data-testid="image-lightbox-position"
              >
                {selectedIndex + 1} / {images.length}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="tap-target"
                onClick={() => move("ArrowRight")}
                aria-label="다음 이미지"
                title="다음 이미지"
                data-testid="image-lightbox-next"
              >
                <ChevronRight aria-hidden="true" />
              </Button>
            </div>
          ) : null}

          {selected ? (
            <AttachmentDownloadButton
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={selected}
              busy={downloadBusyIds.has(selected.id)}
              tapTarget
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
            variant="outline"
            size="sm"
            className="tap-target"
            onClick={() => onOpenChange(false)}
            data-testid="image-lightbox-close"
          >
            닫기
          </Button>
        </div>

        {downloadFailed ? (
          <InlineBanner
            message="파일을 내려받지 못했습니다. 연결을 확인한 뒤 다시 시도하세요."
            testId="image-lightbox-download-error"
          />
        ) : null}

        <div className="flex min-h-0 flex-1 items-center justify-center">
          {selected ? (
            <LightboxImage
              key={selected.id}
              workspaceId={workspaceId}
              channelId={channelId}
              attachment={selected}
              offline={offline}
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
      </DialogContent>
    </Dialog>
  );
}
