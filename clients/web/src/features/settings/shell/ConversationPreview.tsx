import type { ReactNode } from "react";
import { Eye, ImageIcon } from "lucide-react";
import type { LinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { cn } from "@/design/lib/cn";
import { MESSAGE_BODY_CLASS, MessageBody } from "@/features/timeline/MessageBody";
import {
  MESSAGE_AVATAR_GUTTER_CLASS,
  MESSAGE_AVATAR_SIZE_CLASS,
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
} from "@/features/timeline/spacing";

// 대화 미리보기 (#3578 S3a, AP-2a #4189): 「미리보기」 표식이 붙은 안쪽 상자에 메시지 셋과 링크 카드
// 하나를 가짜 데이터로 그린다. **글자 크기·대화 밀도·링크 미리보기 선택에 즉시 반응한다.**
//
// 이 상자가 타임라인과 같은 값을 읽는 것이 요점이다. 눌러 보는 사람이 상자에서 본 간격과 실제 대화의
// 간격이 다르면 미리보기가 거짓말이 된다. 그래서 간격·아바타 클래스를 손으로 적지 않고 타임라인 행이
// 읽는 상수(`features/timeline/spacing.ts`)를 그대로 받고, 마크다운 글은 타임라인과 같은 컴포넌트
// (`MessageBody`)로 그린다. 글자는 `text-*` 역할이라 글자 크기 배율을 자동으로 따른다.
// `ConversationPreview.test.ts`가 이 파일이 상수를 쓰고 손으로 적은 간격이 없다는 것을 잰다.
//
// 실제 타임라인 행(`MessageRow`)을 그대로 쓰지 않는 이유: 행은 호버 툴바·프로필 버튼·스레드 같은 눌리는
// 것을 달고 있고, 이 상자의 것은 아무것도 눌러서는 안 된다(`aria-hidden`). 그 껍데기를 빼고 **간격과
// 크기를 정하는 것만** 같게 둔다. 링크 카드의 모양(히어로 비율·작은 그림·여백)도 타임라인의
// `UnfurlCardView`와 같은 토큰을 읽는다.

const SAMPLE_URL = "example.com/release-notes";

/** 에이전트 답: 문단 둘과 목록 하나라서 문단 간격·목록 간격이 둘 다 보인다. */
const AGENT_REPLY = [
  "확인했어요. 변경점만 추려서 정리할게요.",
  "바뀐 곳은 두 군데예요.",
  "- 배포 노트 요약\n- 설정 기본값 정리",
].join("\n\n");

function LinkCard({ layout }: { layout: Exclude<LinkPreviewPreference, "off"> }) {
  const rich = layout === "rich";
  return (
    <div
      className={cn(
        // `mt-2`는 타임라인의 링크 카드 묶음(`UnfurlCards`)이 본문 아래에서 여는 간격과 같다.
        "mt-2 flex max-w-pane min-w-0 overflow-hidden rounded-md border border-line bg-surface",
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

/**
 * 한 행. `MessageRow`의 뼈대(거터 + 본문 칸)에서 간격과 크기를 정하는 것만 같은 상수로 받는다.
 * `startsGroup`이면 묶음 머리 행 패딩, 아니면 이어지는 행 패딩이다.
 */
function PreviewRow({
  startsGroup,
  avatar,
  children,
}: {
  startsGroup: boolean;
  avatar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn("flex gap-2", startsGroup ? ROW_GROUP_START_PAD_CLASS : ROW_CONTINUATION_PAD_CLASS)}
      data-testid="preview-row"
      data-starts-group={startsGroup ? "" : undefined}
    >
      <div className={cn("shrink-0", MESSAGE_AVATAR_GUTTER_CLASS)}>{avatar}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function ConversationPreview({ linkPreview }: { linkPreview: LinkPreviewPreference }) {
  return (
    <div
      aria-hidden="true"
      className="flex min-w-0 flex-col rounded-lg border border-line bg-canvas-mid px-4 pb-3 pt-3"
      data-testid="conversation-preview"
    >
      <div className="flex items-center gap-1 text-timestamp text-ink-muted">
        <Eye className="size-3" aria-hidden="true" />
        미리보기
      </div>
      <PreviewRow
        startsGroup
        avatar={
          <span
            data-testid="preview-avatar"
            className={cn(
              "flex items-center justify-center overflow-hidden rounded-full bg-muted-soft text-meta font-semibold text-ink",
              MESSAGE_AVATAR_SIZE_CLASS
            )}
          >
            성
          </span>
        }
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-body font-semibold text-ink">성재</span>
          <span className="text-timestamp text-ink-muted">오후 2:14</span>
        </div>
        {/* 링크는 눌리면 안 되는 상자 안이라 진짜 `<a>`가 아니라 링크처럼 보이는 글자다. 글자·줄 높이는
            타임라인 본문과 같은 상수다. */}
        <p className={cn("whitespace-pre-wrap", MESSAGE_BODY_CLASS)}>
          이번 주 배포 노트를 올렸어요.{" "}
          <span className="text-signal-text underline">{SAMPLE_URL}</span>
        </p>
        {linkPreview === "off" ? null : <LinkCard layout={linkPreview} />}
      </PreviewRow>
      <PreviewRow startsGroup={false} avatar={null}>
        <MessageBody body="3쪽 숫자만 같이 봐 주세요." />
      </PreviewRow>
      <PreviewRow
        startsGroup
        avatar={
          <span
            data-testid="preview-avatar"
            className={cn(
              "flex items-center justify-center overflow-hidden rounded-sm bg-agent-soft text-meta font-semibold text-agent",
              MESSAGE_AVATAR_SIZE_CLASS
            )}
          >
            김
          </span>
        }
      >
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-body font-semibold text-ink">김인턴</span>
          <span className="text-timestamp text-ink-muted">오후 2:15</span>
        </div>
        <MessageBody body={AGENT_REPLY} />
      </PreviewRow>
    </div>
  );
}
