import { useState } from "react";
import { ExternalLink, X } from "lucide-react";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { unfurlRenderState } from "@momo/core/features/timeline/unfurl";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { isDesktop, openExternalUrl } from "@/lib/tauri";
import { useUnfurlImage } from "./useUnfurlImage";

function fallbackDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function UnfurlCard({ unfurl }: { unfurl: MessageUnfurl }) {
  const image = useUnfurlImage(unfurl.imageUrl);
  const [openFailed, setOpenFailed] = useState(false);
  const title = unfurl.title || unfurl.domain || fallbackDomain(unfurl.url);
  const domain = unfurl.domain || fallbackDomain(unfurl.url);
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <a
        href={unfurl.url}
        target="_blank"
        rel="noreferrer noopener"
        className="flex min-w-0 flex-1 items-stretch rounded-md focus-visible:focus-ring"
        data-testid="unfurl-card"
        onClick={(event) => {
          // WKWebView does not implement target=_blank. Keep the native anchor
          // in browsers and hand desktop clicks to the Tauri opener.
          if (!isDesktop()) return;
          event.preventDefault();
          setOpenFailed(false);
          void openExternalUrl(unfurl.url).then((opened) => {
            setOpenFailed(!opened);
          });
        }}
      >
        {image && (
          <img
            src={image}
            alt=""
            className="size-rail-tile shrink-0 self-center rounded-sm object-cover"
            data-testid="unfurl-image"
          />
        )}
        <span className="flex min-w-0 flex-1 flex-col gap-px p-3 pr-control-lg">
          <span className="flex min-w-0 items-center gap-1 text-timestamp text-ink-muted">
            <span className="truncate">{domain}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
          </span>
          <span className="line-clamp-2 break-keep text-body font-medium text-ink">
            {title}
          </span>
          {unfurl.description && (
            <span className="line-clamp-2 break-keep text-meta text-ink-muted">
              {unfurl.description}
            </span>
          )}
        </span>
      </a>
      {openFailed && (
        <p
          className="border-t border-line px-3 py-2 text-meta text-danger"
          role="alert"
          data-testid="unfurl-open-error"
        >
          브라우저를 열지 못했습니다. 이 주소를 복사해 브라우저에 붙여넣으세요.{" "}
          <span className="break-all font-mono">{unfurl.url}</span>
        </p>
      )}
    </div>
  );
}

export function UnfurlCards({
  unfurls,
  folded,
  canRemove,
  onRemove,
}: {
  unfurls: readonly MessageUnfurl[];
  folded: boolean;
  canRemove: boolean;
  onRemove?: () => Promise<void>;
}) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  if (folded) return null;

  const visible = unfurls
    .map(unfurlRenderState)
    .filter((state) => state.kind === "pending" || state.kind === "ok");
  if (visible.length === 0) return null;

  const removeControl = (index: number) =>
    index === 0 && canRemove && onRemove ? (
      <button
        type="button"
        data-row-action=""
        aria-label="링크 미리보기 제거"
        title="링크 미리보기 제거"
        className="tap-target absolute right-1 top-1 flex size-control-sm items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
        onClick={(event) => {
          setOpener(event.currentTarget);
          setError(false);
          setConfirmOpen(true);
        }}
        data-testid="unfurl-remove"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    ) : null;

  return (
    <div className="mt-2 flex max-w-pane-lg flex-col gap-1" data-testid="unfurl-group">
      {visible.map((state, index) =>
        state.kind === "pending" ? (
          // Reserve one compact row. When the server is off there is no row at
          // all, so this placeholder can only represent a real pending record.
          <div
            key={state.unfurl.id}
            className="relative h-rail-tile rounded-md border border-line bg-surface-hover"
            role="status"
            aria-label="링크 미리보기를 불러오는 중"
            data-testid="unfurl-pending"
          >
            {removeControl(index)}
          </div>
        ) : (
          <div
            key={state.unfurl.id}
            className="relative flex overflow-hidden rounded-md border border-line bg-surface-raised hover:bg-surface-hover"
          >
            <UnfurlCard unfurl={state.unfurl} />
            {removeControl(index)}
          </div>
        )
      )}
      {canRemove && onRemove && (
        <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <DialogContent opener={opener} className="gap-3 p-4" data-testid="unfurl-remove-dialog">
            <DialogTitle>링크 미리보기를 제거할까요?</DialogTitle>
            <DialogDescription>
              제거하면 이 메시지의 링크 미리보기는 다시 만들어지지 않습니다.
              메시지와 링크 본문은 그대로 남습니다.
            </DialogDescription>
            {error && (
              <p
                className="text-meta text-danger"
                role="alert"
                data-testid="unfurl-remove-error"
              >
                링크 미리보기를 제거하지 못했습니다. 연결을 확인하고 다시 시도하세요.
              </p>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
                취소
              </Button>
              <Button
                variant="destructive"
                aria-busy={pending || undefined}
                onClick={() => {
                  if (pending) return;
                  setPending(true);
                  setError(false);
                  void onRemove()
                    .then(() => setConfirmOpen(false))
                    .catch(() => setError(true))
                    .finally(() => setPending(false));
                }}
                data-testid="unfurl-remove-commit"
              >
                {pending ? "제거 중" : "제거"}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
