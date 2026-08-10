import { Download, FileText, ImageIcon, Loader2 } from "lucide-react";
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
 * 320x180 = 16:9. 바이트가 오기 전에는 비율을 알 수 없으니 이것도 추측이지만,
 * 사람들이 실제로 붙이는 것의 대다수인 스크린샷에서는 도착 순간의 이동이 0 이
 * 된다. 높이는 자기 이름을 가진 토큰이다(design-review M-2: 앞 판은 다이얼로그
 * 버튼 최소**폭** 토큰을 높이로 빌려 썼다).
 */
const PREVIEW_FRAME_CLASS =
  "flex h-preview-frame w-pane max-w-full items-center justify-center overflow-hidden rounded-md border border-line bg-surface-hover";

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

/**
 * 내려받기 하나.
 *
 * **바쁜 버튼은 비활성 버튼이 아니다** (design-review H-1, `tokens.md §5b` 가
 * 이 정확한 실수에 이름을 붙여 뒀다). 앞 판은 `disabled + opacity-50` 만으로
 * 진행을 말했고, 그러면 100MB 짜리를 누른 뒤 수십 초 동안 **흐려진 아이콘이
 * 유일한 신호**이면서 동시에 대비가 2.2:1 로 떨어진다. 이제 대비를 그대로 두고
 * 회전을 신호로 쓰며 `aria-busy` 를 단다. 비활성은 「지금 이걸 할 수 없다」의
 * 언어이고, 여기서는 하고 있는 중이다.
 */
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
      aria-busy={busy || undefined}
      onClick={() => {
        // 두 번 누르면 두 번 받는다. 막는 대신 같은 요청을 다시 보내지 않게만
        // 한다 — 비활성화는 포커스를 <body> 로 던지고 돌려주지 않는다(SKILL §6).
        if (busy) return;
        setBusy(true);
        void downloadAttachment(workspaceId, channelId, attachment)
          .catch(onFailed)
          .finally(() => setBusy(false));
      }}
      aria-label={`${attachment.name} ${ATTACH_COPY.download}`}
      title={busy ? ATTACH_COPY.downloading : ATTACH_COPY.download}
      data-testid="attachment-download"
      data-busy={busy ? "" : undefined}
      className="touch-target flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      {busy ? (
        <Loader2 aria-hidden="true" className="size-4 spinner-busy" />
      ) : (
        <Download aria-hidden="true" className="size-4" />
      )}
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
      className="flex w-fit max-w-pane-lg flex-col gap-1"
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
