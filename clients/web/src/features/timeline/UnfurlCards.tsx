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
import { cn } from "@/design/lib/cn";
import { isDesktop, openExternalUrl } from "@/lib/tauri";
import {
  unfurlCardLayout,
  useLinkPreviewPreference,
  type LinkPreviewPreference,
} from "./linkPreviewPreference";
import { useUnfurlImage } from "./useUnfurlImage";

function fallbackDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function UnfurlMeta({
  domain,
  title,
  description,
  insetEnd,
}: {
  domain: string;
  title: string;
  description?: string;
  /** Compact: leave room for the corner remove chip. Rich: the chip sits on
   *  the photo, so padding stays symmetric (M-1). */
  insetEnd: boolean;
}) {
  return (
    <span
      className={
        insetEnd
          ? "flex min-w-0 flex-1 flex-col gap-px p-3 pr-control-lg"
          : "flex min-w-0 flex-1 flex-col gap-px p-3"
      }
    >
      <span className="flex min-w-0 items-center gap-1 text-timestamp text-ink-muted">
        <span className="truncate">{domain}</span>
        <ExternalLink className="size-3 shrink-0" aria-hidden="true" />
      </span>
      <span className="line-clamp-2 break-keep text-body font-medium text-ink">
        {title}
      </span>
      {description ? (
        <span className="line-clamp-2 break-keep text-meta text-ink-muted">
          {description}
        </span>
      ) : null}
    </span>
  );
}

/** Rich hero box. Loading and ready share this class so compact→rich jump is 0. */
export const UNFURL_HERO_FRAME_CLASS =
  "block aspect-og max-h-unfurl-hero w-full overflow-hidden bg-muted-soft";

/**
 * Presentational card. `image` is already a same-origin data URL, or null
 * while bytes are still loading / when there is no image. Fetch failure is
 * `imageFailed`; decode failure is a local `brokenSrc`. Either failure
 * degrades rich to compact without painting an empty hero. A present
 * `imageUrl` reserves the rich frame on the first paint (H-1).
 */
export function UnfurlCardView({
  unfurl,
  image,
  preference,
  imageFailed = false,
}: {
  unfurl: MessageUnfurl;
  image: string | null;
  preference: Exclude<LinkPreviewPreference, "off">;
  imageFailed?: boolean;
}) {
  const [openFailed, setOpenFailed] = useState(false);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const decodeFailed = Boolean(image) && image === brokenSrc;
  const failed = imageFailed || decodeFailed;
  const showHeroFrame = Boolean(unfurl.imageUrl || image) && !failed;
  const layout = unfurlCardLayout(preference, showHeroFrame);
  const showImage = Boolean(image) && !decodeFailed;

  const title = unfurl.title || unfurl.domain || fallbackDomain(unfurl.url);
  const domain = unfurl.domain || fallbackDomain(unfurl.url);
  const rich = layout === "rich";

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <a
        href={unfurl.url}
        target="_blank"
        rel="noreferrer noopener"
        // 행의 로빙 그룹에 합류한다(AttachmentList·QuoteBlock과 같은 문법). 카드는
        // 본문 URL 링크가 이미 가진 목적지의 액세서리라, 자연 탭 스톱으로 서면
        // 링크 메시지마다 키보드 여정이 카드 수만큼 늘어난다(리뷰 Blocker-1).
        data-row-action=""
        className={cn(
          "flex min-w-0 flex-1 rounded-md focus-visible:focus-ring",
          rich ? "flex-col" : "items-stretch"
        )}
        data-testid="unfurl-card"
        data-layout={layout}
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
        {rich ? (
          <span className={UNFURL_HERO_FRAME_CLASS} data-testid="unfurl-hero">
            {showImage && image ? (
              <img
                src={image}
                alt=""
                aria-hidden="true"
                className="h-full w-full object-cover"
                data-testid="unfurl-image"
                onError={() => setBrokenSrc(image)}
              />
            ) : null}
          </span>
        ) : showImage && image ? (
          <img
            src={image}
            alt=""
            aria-hidden="true"
            className="size-rail-tile shrink-0 self-center rounded-sm object-cover"
            data-testid="unfurl-image"
            onError={() => setBrokenSrc(image)}
          />
        ) : null}
        <UnfurlMeta
          domain={domain}
          title={title}
          insetEnd={!rich}
          {...(unfurl.description ? { description: unfurl.description } : {})}
        />
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

function UnfurlCard({
  unfurl,
  preference,
}: {
  unfurl: MessageUnfurl;
  preference: Exclude<LinkPreviewPreference, "off">;
}) {
  const image = useUnfurlImage(unfurl.imageUrl);
  return (
    <UnfurlCardView
      unfurl={unfurl}
      image={image.kind === "ready" ? image.dataUrl : null}
      imageFailed={image.kind === "failed"}
      preference={preference}
    />
  );
}

export function UnfurlCards({
  unfurls,
  preference: preferenceProp,
  canRemove,
  onRemove,
}: {
  unfurls: readonly MessageUnfurl[];
  /** Test override. Live surfaces read the device store so a settings change
   *  paints immediately, including ThreadPanel which never subscribed before. */
  preference?: LinkPreviewPreference;
  canRemove: boolean;
  onRemove?: () => Promise<void>;
}) {
  const stored = useLinkPreviewPreference();
  const preference = preferenceProp ?? stored;
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);
  const [opener, setOpener] = useState<HTMLElement | null>(null);
  if (preference === "off") return null;

  const visible = unfurls
    .map(unfurlRenderState)
    .filter((state) => state.kind === "pending" || state.kind === "ok");
  if (visible.length === 0) return null;

  const removeControl = (index: number) =>
    index === 0 && canRemove && onRemove ? (
      // X는 상시 노출이 의도다: hover 표출은 카드 이미지 위에서 발견 불가능하고,
      // 제거는 이 카드의 유일한 소유자 액션이라 숨길 이유가 없다(리뷰 Nit-1 기록).
      // 사진 위에 설 때도 불투명 토큰 칩(bg-surface-raised + line-strong)을 든다.
      // 반투명 스크림은 OG 배경이 임의 색이라 대비 상한이 없고, hover 그릇은
      // (hover: none)에 구제가 없다 (B-1).
      <button
        type="button"
        data-row-action=""
        aria-label="링크 미리보기 제거"
        title="링크 미리보기 제거"
        className="tap-target absolute right-1 top-1 z-10 flex size-control-sm items-center justify-center rounded-sm border border-line-strong bg-surface-raised text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
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
            className="relative h-rail-tile rounded-md border border-line bg-muted-soft"
            role="status"
            aria-label="링크 미리보기를 불러오는 중"
            data-testid="unfurl-pending"
          >
            {removeControl(index)}
          </div>
        ) : (
          <div
            key={state.unfurl.id}
            className="relative flex overflow-hidden rounded-md border border-line bg-surface-raised"
          >
            <UnfurlCard unfurl={state.unfurl} preference={preference} />
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
