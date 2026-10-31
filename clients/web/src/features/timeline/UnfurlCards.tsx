import { useId, useState, type ReactNode, type Ref } from "react";
import { Globe, Play, X } from "lucide-react";
import {
  isUnfurlPending,
  unfurlCardModel,
  visibleUnfurls,
  type MessageUnfurl,
  type UnfurlCardModel,
} from "@momo/core/features/timeline/unfurl";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { isDesktop, openExternalUrl } from "@/lib/tauri";
import {
  useLinkPreviewPreference,
  type LinkPreviewPreference,
} from "./linkPreviewPreference";
import { useUnfurlImage, useVisibleOnce } from "./useUnfurlImage";

// =============================================================================
// 링크 카드 (ADR-0170 D5, #4882). 무엇을 보여 줄지는 코어 표시 모델이 한 곳에서 정한다
// (`unfurlCardModel`, 대체 규칙 표 전 행). 이 파일은 그 모델을 클래스로 그릴 뿐이고
// 규칙을 다시 판단하지 않는다. 읽을 수 있는 형태는 `docs/design-system/link-cards.md`.
//
//   작게(compact, 기본) 왼쪽 그림 칸 + 오른쪽 주소·제목 한 줄·설명 한 줄, 테두리 없음.
//   크게(rich)          글이 위, 1.91:1 그림이 아래. 제목·설명은 두 줄까지.
//   그림 칸은 셋 중 하나다: 보통 그림(104×64, 자름) · 작거나 정사각형인 그림(64×64, 통째로)
//   · 아이콘 타일(64×64, 사이트 아이콘 또는 지구).
//
// 카드 전체가 링크 하나다. 글은 전부 텍스트 노드로 그린다(HTML을 해석하지 않는다).
// =============================================================================

/** 크게 카드의 그림 틀. 불러오는 중과 준비됨이 같은 클래스라서 틀이 뛰지 않는다. */
export const UNFURL_HERO_FRAME_CLASS =
  "relative block aspect-og max-h-unfurl-hero w-full overflow-hidden rounded-md bg-muted-soft";

/** 그림 위의 재생 표시. 카드 자체가 링크라 이 표시는 장식이다. */
function PlayMark() {
  return (
    <span
      aria-hidden="true"
      className="absolute inset-0 m-auto flex size-control-sm items-center justify-center rounded-full bg-surface-raised text-ink shadow-sm"
      data-testid="unfurl-play"
    >
      <Play className="size-3 fill-current" aria-hidden="true" />
    </span>
  );
}

function PictureImage({
  src,
  className,
  onBroken,
}: {
  src: string;
  className: string;
  onBroken: () => void;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={className}
      data-testid="unfurl-image"
      onError={onBroken}
    />
  );
}

function SiteIcon({
  src,
  className,
  onBroken,
}: {
  src: string;
  className: string;
  onBroken: () => void;
}) {
  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={className}
      data-testid="unfurl-icon"
      onError={onBroken}
    />
  );
}

/** 주소 줄: 사이트 아이콘(없으면 지구) + 실제 도메인. 사이트 이름은 여기 오지 않는다. */
function AddressLine({
  domain,
  iconSrc,
  onIconBroken,
}: {
  domain: string;
  iconSrc: string | null;
  onIconBroken: () => void;
}) {
  return (
    <span
      className="flex min-w-0 items-center gap-1 text-timestamp text-ink-muted"
      data-testid="unfurl-address"
    >
      {iconSrc ? (
        <SiteIcon
          src={iconSrc}
          className="size-4 shrink-0 rounded-sm object-contain"
          onBroken={onIconBroken}
        />
      ) : (
        <Globe
          className="size-4 shrink-0"
          aria-hidden="true"
          data-testid="unfurl-globe"
        />
      )}
      <span className="truncate">{domain}</span>
    </span>
  );
}

function CardLink({
  model,
  rich = false,
  label,
  describedBy,
  onClick,
  children,
}: {
  model: UnfurlCardModel;
  rich?: boolean;
  label: string;
  describedBy?: string | undefined;
  onClick: (event: { preventDefault: () => void }) => void;
  children: ReactNode;
}) {
  return (
    <a
      href={model.url}
      target="_blank"
      rel="noreferrer noopener"
      // 행의 로빙 그룹에 합류한다(AttachmentList·QuoteBlock과 같은 문법). 카드는
      // 본문 URL 링크가 이미 가진 목적지의 액세서리라, 자연 탭 스톱으로 서면
      // 링크 메시지마다 키보드 여정이 카드 수만큼 늘어난다(리뷰 Blocker-1).
      data-row-action=""
      aria-label={label}
      aria-describedby={describedBy}
      // 전폭 행이라 눌림은 채움뿐이다(눌림 장부 H5-1). 앞 줄은 두 모양이 같이 쓰는 클래스이고,
      // 리터럴로 여기 있어야 장부가 채움 눌림을 읽는다.
      className={cn(
        "flex w-full min-w-0 flex-1 rounded-md hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring",
        rich ? "flex-col gap-2 p-3" : "items-center gap-3 p-2"
      )}
      data-testid="unfurl-card"
      data-layout={model.layout}
      onClick={onClick}
    >
      {children}
    </a>
  );
}

/**
 * Presentational card. `image` is already a same-origin data URL, or null while bytes are
 * still loading / when there is no picture; `icon` is the same for the site icon. A fetch
 * failure is `imageFailed`, a decode failure a local `brokenSrc`: either one turns the picture
 * into the icon tile (the model decides), never an empty frame. A present `imageUrl` reserves
 * the picture frame on the first paint, so the row does not jump when bytes arrive (H-1).
 */
export function UnfurlCardView({
  unfurl,
  image,
  preference,
  imageFailed = false,
  icon = null,
  rootRef,
}: {
  unfurl: MessageUnfurl;
  image: string | null;
  preference: Exclude<LinkPreviewPreference, "off">;
  imageFailed?: boolean;
  icon?: string | null;
  rootRef?: Ref<HTMLDivElement> | undefined;
}) {
  const formatMessage = useFormatMessage();
  const noteId = useId();
  const [openFailed, setOpenFailed] = useState(false);
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [brokenIcon, setBrokenIcon] = useState<string | null>(null);
  const decodeFailed = Boolean(image) && image === brokenSrc;
  const model = unfurlCardModel(unfurl, {
    size: preference,
    imageFailed: imageFailed || decodeFailed,
  });
  if (!model) return null;

  const iconSrc = icon !== null && icon !== brokenIcon ? icon : null;
  const onIconBroken = () => setBrokenIcon(icon);
  const onImageBroken = () => setBrokenSrc(image);
  // 이름은 늘 「링크 미리보기: 제목, 도메인」이다. 동영상이라는 사실은 그림 위 표시가 눈으로만
  // 말하므로, 보조기술에는 설명으로 따로 읽힌다.
  const label = formatMessage("timeline.unfurl.label", {
    title: model.title,
    domain: model.domain,
  });
  const videoNoteId = model.isVideo ? `${noteId}-video` : undefined;
  const open = (event: { preventDefault: () => void }) => {
    // WKWebView does not implement target=_blank. Keep the native anchor
    // in browsers and hand desktop clicks to the Tauri opener.
    if (!isDesktop()) return;
    event.preventDefault();
    setOpenFailed(false);
    void openExternalUrl(unfurl.url).then((opened) => {
      setOpenFailed(!opened);
    });
  };
  const address = (
    <AddressLine
      domain={model.domain}
      iconSrc={iconSrc}
      onIconBroken={onIconBroken}
    />
  );
  const play = model.isVideo ? <PlayMark /> : null;
  const picture = model.picture;
  const showImage = picture.kind === "image" && image !== null;

  return (
    <div ref={rootRef} className="flex min-w-0 flex-1 flex-col">
      {model.layout === "rich" ? (
        <CardLink
          model={model}
          rich
          label={label}
          describedBy={videoNoteId}
          onClick={open}
        >
          {/* 끝 여백은 오른쪽 위 「지우기」 칩 자리다. 칩은 글 위에 서므로 두 모양 모두 비워 둔다. */}
          <span className="flex min-w-0 flex-col gap-px pr-control-lg">
            {address}
            <span
              className="line-clamp-2 break-keep text-body font-medium text-ink"
              data-testid="unfurl-title"
            >
              {model.title}
            </span>
            {model.description ? (
              <span
                className="line-clamp-2 break-keep text-meta text-ink-muted"
                data-testid="unfurl-description"
              >
                {model.description}
              </span>
            ) : null}
          </span>
          <span className={UNFURL_HERO_FRAME_CLASS} data-testid="unfurl-hero">
            {showImage ? (
              <PictureImage
                src={image}
                className="size-full object-cover"
                onBroken={onImageBroken}
              />
            ) : null}
            {play}
          </span>
        </CardLink>
      ) : (
        <CardLink
          model={model}
          label={label}
          describedBy={videoNoteId}
          onClick={open}
        >
          {picture.kind === "tile" ? (
            <span
              className="relative flex size-unfurl-tile shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-soft text-icon"
              data-testid="unfurl-tile"
            >
              {model.isVideo ? (
                play
              ) : iconSrc ? (
                <SiteIcon
                  src={iconSrc}
                  className="size-control rounded-sm object-contain"
                  onBroken={onIconBroken}
                />
              ) : (
                <Globe className="size-6" aria-hidden="true" />
              )}
            </span>
          ) : picture.shape === "small" ? (
            <span
              className="relative flex size-unfurl-tile shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-soft text-icon"
              data-testid="unfurl-thumb"
            >
              {showImage ? (
                <PictureImage
                  src={image}
                  className="size-full object-contain"
                  onBroken={onImageBroken}
                />
              ) : null}
              {play}
            </span>
          ) : (
            <span
              className="relative flex h-unfurl-tile w-unfurl-thumb shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-soft text-icon"
              data-testid="unfurl-thumb"
            >
              {showImage ? (
                <PictureImage
                  src={image}
                  className="size-full object-cover"
                  onBroken={onImageBroken}
                />
              ) : null}
              {play}
            </span>
          )}
          <span className="flex min-w-0 flex-1 flex-col gap-px pr-control-lg">
            {address}
            <span
              className="truncate text-body font-medium text-ink"
              data-testid="unfurl-title"
            >
              {model.title}
            </span>
            {model.description ? (
              <span
                className="truncate text-meta text-ink-muted"
                data-testid="unfurl-description"
              >
                {model.description}
              </span>
            ) : null}
          </span>
        </CardLink>
      )}
      {videoNoteId ? (
        <span id={videoNoteId} className="sr-only" data-testid="unfurl-video-note">
          {formatMessage("timeline.unfurl.video")}
        </span>
      ) : null}
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
  // 사이트 아이콘은 카드가 화면에 보일 때 처음 부른다. 프록시가 그때 사이트로 나가기
  // 때문이다(ADR-0170 증보 D9). 그림은 이전처럼 카드가 서면 바로 받는다.
  const [rootRef, onScreen] = useVisibleOnce();
  const image = useUnfurlImage(unfurl.imageUrl);
  const icon = useUnfurlImage(unfurl.iconUrl, { enabled: onScreen });
  return (
    <UnfurlCardView
      unfurl={unfurl}
      image={image.kind === "ready" ? image.dataUrl : null}
      imageFailed={image.kind === "failed"}
      icon={icon.kind === "ready" ? icon.dataUrl : null}
      preference={preference}
      rootRef={rootRef}
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

  // 앞의 서로 다른 링크 3개까지, 불러오는 중이거나 보여 줄 것이 있는 것만(코어가 정한다).
  const visible = visibleUnfurls(unfurls);
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
        className="tap-target absolute right-1 top-1 layer-content-float flex size-control-sm items-center justify-center rounded-sm border border-line-strong bg-surface-raised text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
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
      {visible.map((unfurl, index) =>
        isUnfurlPending(unfurl) ? (
          // 작은 카드 한 줄만큼 자리를 잡는다(그림 칸 64 + 위아래 8). 서버가 꺼져 있으면 행
          // 자체가 없으므로 이 자리는 실제 불러오는 기록만 나타낸다.
          <div
            key={unfurl.id}
            className="relative isolate rounded-md bg-surface-muted p-2"
            role="status"
            aria-label="링크 미리보기를 불러오는 중"
            data-testid="unfurl-pending"
          >
            <span className="block h-unfurl-tile rounded-sm bg-muted-soft" />
            {removeControl(index)}
          </div>
        ) : (
          // `isolate` (#2485 R1 M-3): the X below floats over THIS card, and
          // nothing else. Without a stacking context here it floated at the
          // document root next to the hover toolbar, which sits on the same
          // layer — so which one won came down to DOM order, and DOM order is
          // the reverse of the order the two used to have (toolbar z-20 over
          // unfurl X z-10). Where `hover-toolbar-straddle-below` drops a
          // toolbar into this row's band, the toolbar is the transient thing
          // under the cursor and it wins; the X is furniture on a card.
          // 테두리 없는 카드(#4882): 면은 보조 채움 하나이고, 눌림·호버는 안쪽 링크가 입힌다.
          <div
            key={unfurl.id}
            className="relative isolate flex rounded-md bg-surface-muted"
          >
            <UnfurlCard unfurl={unfurl} preference={preference} />
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
