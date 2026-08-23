import { FileText, ImageIcon } from "lucide-react";
import { useRef, useState } from "react";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { AttachmentDownloadButton } from "@/features/attachments/AttachmentDownloadButton";
import { useAttachmentPreview } from "@/features/attachments/content";
import { ImageLightbox } from "@/features/attachments/ImageLightbox";
import { lightboxAttachments } from "@/features/attachments/imageLightboxModel";
import {
  ATTACH_COPY,
  attachmentMetaLine,
  isImageMime,
  showsInlinePreview,
  type MessageAttachment,
} from "@momo/core/features/attachments/model";

// =============================================================================
// 타임라인의 첨부 (ADR-0151 D2 / #1202 첨부 축).
//
// **메시지의 본문이지 떠 있는 패널이 아니다.** `MessageRow` 가 그리드·아바타·
// 타이포를 그대로 들고, 이것은 본문 자리만 채운다 — `ArtifactCard` 와
// `AgentCard` 가 서 있는 그 자리이고 그 이유도 같다(design-taste-web §9).
//
// ## 두 모양뿐이다
//
//   이미지(상한 아래)  인라인 미리보기 + 그 아래 한 줄(이름 · 타입 · 크기)
//   그 밖의 전부       파일 카드(아이콘 · 이름 · 타입 · 크기 · 내려받기)
//
// SVG 는 이미지여도 카드다. 서버가 프록시 응답에 `nosniff` 와
// `Content-Disposition: attachment` 를 붙인 이유가 정확히 그것 — 올라온 SVG 안의
// 스크립트가 이 앱과 같은 출처에서 도는 것 — 이고, 그 판단을 화면이 뒤집지 않는다.
//
// ## 미리보기는 세 칸을 갖는다
//
// 받는 중 / 받았다 / 못 받았다. 셋째 칸에서 **카드가 사라지지 않는다**: 미리보기를
// 못 연 것과 파일이 없는 것은 다른 사실이고, 내려받기는 여전히 눌린다.
//
// 자리는 미리 잡아 둔다(`min-h-*` 대신 고정 높이 상자). 이미지가 도착하는 순간
// 아래 대화가 밀려 내려가면, 읽고 있던 줄이 눈 밑에서 움직인다.
// =============================================================================

/**
 * 로딩·실패에 자리를 잡아 주는 상자. 셔머 없는 중립 면이다(SKILL §5).
 *
 * 320x180 = 16:9. 바이트가 오기 전에는 비율을 알 수 없으니 이것도 추측이지만,
 * 사람들이 실제로 붙이는 것의 대다수인 스크린샷에서는 도착 순간의 이동이 0 이
 * 된다. 높이는 자기 이름을 가진 토큰이다(design-review M-2: 앞 판은 다이얼로그
 * 버튼 최소**폭** 토큰을 높이로 빌려 썼다).
 */
const PREVIEW_FRAME_CLASS =
  "flex h-preview-frame w-pane max-w-full items-center justify-center overflow-hidden rounded-md border border-line bg-surface-hover hover:bg-surface-raised focus-visible:focus-ring";

/**
 * 한 줄에 「무엇이」와 「무엇을 할 수 있는가」를 놓는 행.
 *
 * 파일 카드와 이미지 캡션이 **같은 행 문법**을 쓴다 (design-review H-2). 앞 판은
 * 카드에서는 624px 폭 끝에 버튼을 못 박고 캡션에서는 이름 바로 옆에 붙여서,
 * 한 타임라인에서 같은 버튼을 두 번 다른 곳에서 찾아야 했다. 게다가 624px 안에
 * 두 줄짜리 라벨 하나뿐인 형상은 `tokens.md §4` 가 `max-w-pane-lg` 를 만들며
 * 경고한 그 읽힘이다 — 라벨과 한 화면 떨어진 오른쪽 열은 카드가 아니라 배너로
 * 읽힌다. 이제 상자가 내용에 맞춰 줄어들어(`w-fit`) 버튼이 늘 이름 곁에 선다.
 */
const ACTION_ROW_CLASS = "flex min-w-0 items-center gap-2";

function MetaLine({ attachment }: { attachment: MessageAttachment }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="min-w-0 truncate text-body text-ink" title={attachment.name}>
        {attachment.name}
      </span>
      <span className="text-meta text-ink-muted" data-testid="attachment-meta">
        {attachmentMetaLine(attachment)}
      </span>
    </span>
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
  const Icon = isImageMime(attachment.mime) ? ImageIcon : FileText;
  return (
    <div
      data-testid="attachment-card"
      className={cn(
        ACTION_ROW_CLASS,
        "w-fit max-w-pane-lg rounded-md border border-line bg-surface-raised px-3 py-2"
      )}
    >
      <Icon aria-hidden="true" className="size-4 shrink-0 text-ink-muted" />
      <span className="flex min-w-0 flex-1 flex-col">
        <MetaLine attachment={attachment} />
        {failed && (
          <span className="text-meta text-danger" data-testid="attachment-download-failed">
            {ATTACH_COPY.downloadFailed}
          </span>
        )}
      </span>
      <AttachmentDownloadButton
        workspaceId={workspaceId}
        channelId={channelId}
        attachment={attachment}
        joinsMessageRow
        onStarted={() => setFailed(false)}
        onFailed={() => setFailed(true)}
      />
    </div>
  );
}

function ImageCard({
  workspaceId,
  channelId,
  attachment,
  onOpen,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  onOpen: (opener: HTMLButtonElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  const preview = useAttachmentPreview(
    workspaceId,
    channelId,
    attachment.id,
    true
  );

  return (
    <figure
      data-testid="attachment-image"
      data-preview={preview.status}
      className="flex w-fit max-w-pane-lg flex-col gap-1"
    >
      <button
        type="button"
        data-row-action=""
        onClick={(event) => onOpen(event.currentTarget)}
        aria-label={`${attachment.name} 전체 화면 미리보기 열기`}
        title="전체 화면 미리보기 열기"
        className={
          preview.status === "ready"
            ? "max-w-full self-start rounded-md focus-visible:focus-ring"
            : PREVIEW_FRAME_CLASS
        }
      >
        {preview.status === "ready" ? (
          <img
            src={preview.dataUrl}
            alt={attachment.name}
            // `self-start`가 load-bearing이다. figure는 flex-col이고 기본 정렬은
            // stretch라, 버튼과 이미지 모두 내용 폭을 지켜야 작은 이미지가 늘지 않는다.
            className="block max-h-diff-body max-w-full rounded-md border border-line object-contain"
          />
        ) : (
          <span className="text-meta text-ink-muted">
            {preview.status === "loading"
              ? ATTACH_COPY.previewLoading
              : ATTACH_COPY.previewFailed}
          </span>
        )}
      </button>
      {/* 카드와 **같은 행**이다 (design-review H-2): 왼쪽에 이름과 메타, 오른쪽
          끝에 같은 버튼. 두 모양 사이를 오갈 때 같은 동작을 두 번 찾지 않는다. */}
      <figcaption className={ACTION_ROW_CLASS}>
        <span className="flex min-w-0 flex-1 flex-col">
          <MetaLine attachment={attachment} />
          {failed && (
            <span className="text-meta text-danger" data-testid="attachment-download-failed">
              {ATTACH_COPY.downloadFailed}
            </span>
          )}
        </span>
        <AttachmentDownloadButton
          workspaceId={workspaceId}
          channelId={channelId}
          attachment={attachment}
          joinsMessageRow
          onStarted={() => setFailed(false)}
          onFailed={() => setFailed(true)}
        />
      </figcaption>
    </figure>
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
}: {
  /** 첨부는 채널에 속한다. 프록시 주소가 그 사실 위에 서 있다. */
  channelId: string;
  attachments: MessageAttachment[];
  muted?: boolean;
}) {
  // 워크스페이스는 셸이 이미 알고 있다. 타임라인 전체에 프롭으로 흘려보내는 대신
  // 여기서 읽는다 — `Composer` 가 같은 값을 같은 방법으로 읽는다.
  const { workspaceId, connStatus } = useSession();
  const [lightbox, setLightbox] = useState<{
    attachmentId: string;
  } | null>(null);
  // 닫힘 state를 먼저 반영해도 opener 자체는 남아 있어야 Radix의 closeAutoFocus가
  // WebKit에서도 원래 미리보기 버튼으로 돌아간다(dialog.tsx의 명시 opener 계약).
  const lightboxOpener = useRef<HTMLButtonElement | null>(null);
  const images = lightboxAttachments(attachments);
  if (attachments.length === 0) return null;
  return (
    <>
      <ul
        className={cn("mt-1 flex flex-col gap-1", muted && "opacity-70")}
        data-testid="attachment-list"
      >
        {attachments.map((attachment) => (
          <li key={attachment.id} className="min-w-0">
            {showsInlinePreview(attachment) ? (
              <ImageCard
                workspaceId={workspaceId}
                channelId={channelId}
                attachment={attachment}
                onOpen={(opener) => {
                  lightboxOpener.current = opener;
                  setLightbox({ attachmentId: attachment.id });
                }}
              />
            ) : (
              <FileCard
                workspaceId={workspaceId}
                channelId={channelId}
                attachment={attachment}
              />
            )}
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
        offline={connStatus === "disconnected"}
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
