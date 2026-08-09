import { Download, FileText, ImageIcon } from "lucide-react";
import { useState } from "react";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import {
  downloadAttachment,
  useAttachmentPreview,
} from "@/features/attachments/content";
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
 * 높이가 144px 인 것은 추측이다 — 바이트가 도착하기 전에는 이 이미지의 비율을
 * 알 방법이 없다. 추측인 이상 **작게** 추측한다: 400px 짜리 빈 칸을 잡아 두면
 * 실제 이미지가 그보다 작을 때 대화가 위로 접히고, 그 움직임이 자리를 미리
 * 잡아서 막으려던 바로 그 움직임이다.
 */
const PREVIEW_FRAME_CLASS =
  "flex h-action w-pane max-w-full items-center justify-center overflow-hidden rounded-md border border-line bg-surface-hover";

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

function DownloadButton({
  workspaceId,
  channelId,
  attachment,
  onFailed,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
  onFailed: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void downloadAttachment(workspaceId, channelId, attachment)
          .catch(onFailed)
          .finally(() => setBusy(false));
      }}
      aria-label={`${attachment.name} ${ATTACH_COPY.download}`}
      title={ATTACH_COPY.download}
      data-testid="attachment-download"
      className="touch-target flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
    >
      <Download aria-hidden="true" className="size-4" />
    </button>
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
      className="flex max-w-pane-lg items-center gap-2 rounded-md border border-line bg-surface-raised px-3 py-2"
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
      <DownloadButton
        workspaceId={workspaceId}
        channelId={channelId}
        attachment={attachment}
        onFailed={() => setFailed(true)}
      />
    </div>
  );
}

function ImageCard({
  workspaceId,
  channelId,
  attachment,
}: {
  workspaceId: string;
  channelId: string;
  attachment: MessageAttachment;
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
      className="flex max-w-pane-lg flex-col gap-1"
    >
      {preview.status === "ready" ? (
        <img
          src={preview.dataUrl}
          alt={attachment.name}
          // `self-start` 가 load-bearing 이다. `figure` 는 `flex flex-col` 이고
          // 그 기본 정렬은 `stretch` 라서, 이것이 없으면 96px 짜리 스크린샷이
          // 640px 로 늘어나 뭉개진다. 상한만 두고 원래 크기는 그대로 둔다.
          className="max-h-diff-body max-w-full self-start rounded-md border border-line object-contain"
        />
      ) : (
        <div className={PREVIEW_FRAME_CLASS}>
          <span className="text-meta text-ink-muted">
            {preview.status === "loading"
              ? ATTACH_COPY.previewLoading
              : ATTACH_COPY.previewFailed}
          </span>
        </div>
      )}
      <figcaption className="flex items-center gap-2">
        <MetaLine attachment={attachment} />
        {failed && (
          <span className="text-meta text-danger" data-testid="attachment-download-failed">
            {ATTACH_COPY.downloadFailed}
          </span>
        )}
        <DownloadButton
          workspaceId={workspaceId}
          channelId={channelId}
          attachment={attachment}
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
  const { workspaceId } = useSession();
  if (attachments.length === 0) return null;
  return (
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
  );
}
