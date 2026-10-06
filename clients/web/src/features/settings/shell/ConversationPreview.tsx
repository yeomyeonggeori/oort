import { Eye, ImageIcon } from "lucide-react";
import type { LinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { cn } from "@/design/lib/cn";

// 대화 미리보기 (#3578 S3a): 「미리보기」 표식이 붙은 안쪽 상자에 메시지 둘과 링크 카드
// 하나를 가짜 데이터로 그린다. 링크 미리보기 선택에 **즉시** 반응한다(사진 카드 / 작은
// 카드 / 숨기기). 실제 타임라인 컴포넌트를 쓰지 않는 이유: 카드는 링크이고 이 상자의
// 것은 아무것도 눌러서는 안 된다. 카드 모양(히어로 비율·작은 그림·여백)은 타임라인의
// `UnfurlCardView`와 같은 토큰을 읽는다.
//
// 글자 크기·밀도는 이 상자가 따르지 않는다: 그 컨트롤은 앱이 실제로 따를 때 열린다
// (S3b, 눌러도 안 바뀌는 컨트롤 금지).

const SAMPLE_URL = "example.com/release-notes";

function LinkCard({ layout }: { layout: Exclude<LinkPreviewPreference, "off"> }) {
  const rich = layout === "rich";
  return (
    <div
      className={cn(
        "flex max-w-pane min-w-0 overflow-hidden rounded-md border border-line bg-surface",
        rich ? "flex-col" : "items-stretch"
      )}
      data-testid="preview-link-card"
      data-layout={layout}
    >
      {rich ? (
        <span className="flex aspect-og max-h-unfurl-hero w-full items-center justify-center bg-muted-soft text-icon">
          <ImageIcon className="size-4" aria-hidden="true" />
        </span>
      ) : (
        <span className="m-3 flex size-rail-tile shrink-0 items-center justify-center self-center rounded-sm bg-muted-soft text-icon">
          <ImageIcon className="size-4" aria-hidden="true" />
        </span>
      )}
      <span className={cn("flex min-w-0 flex-1 flex-col gap-px p-3", !rich && "pl-0")}>
        <span className="truncate text-timestamp text-ink-muted">example.com</span>
        <span className="line-clamp-2 break-keep text-body font-medium text-ink">
          v0.1.19 릴리스 노트
        </span>
        <span className="line-clamp-2 break-keep text-meta text-ink-muted">
          이번 배포에서 바뀐 점을 정리했어요.
        </span>
      </span>
    </div>
  );
}

export function ConversationPreview({ linkPreview }: { linkPreview: LinkPreviewPreference }) {
  return (
    <div
      aria-hidden="true"
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-canvas-mid p-4"
      data-testid="conversation-preview"
    >
      <div className="flex items-center gap-1 text-timestamp text-ink-muted">
        <Eye className="size-3" aria-hidden="true" />
        미리보기
      </div>
      <div className="flex min-w-0 gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted-soft text-body font-semibold text-ink">
          성
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-body font-semibold text-ink">성재</span>
            <span className="text-timestamp text-ink-muted">오후 2:14</span>
          </div>
          <p className="break-keep text-body text-ink">
            이번 주 배포 노트를 올렸어요.{" "}
            <span className="text-signal-text underline">{SAMPLE_URL}</span>
          </p>
          {linkPreview === "off" ? null : <LinkCard layout={linkPreview} />}
        </div>
      </div>
      <div className="flex min-w-0 gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-agent-soft text-body font-semibold text-agent">
          김
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-2">
            <span className="text-body font-semibold text-ink">김인턴</span>
            <span className="text-timestamp text-ink-muted">오후 2:15</span>
          </div>
          <p className="break-keep text-body text-ink">확인했어요. 변경점만 추려서 정리할게요.</p>
        </div>
      </div>
    </div>
  );
}
