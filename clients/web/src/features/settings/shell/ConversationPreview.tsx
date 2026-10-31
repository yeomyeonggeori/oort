import type { ReactNode } from "react";
import { Eye, Globe, ImageIcon } from "lucide-react";
import type { LinkPreviewPreference } from "@/features/timeline/linkPreviewPreference";
import { cn } from "@/design/lib/cn";
import { MESSAGE_BODY_CLASS, MessageBody } from "@/features/timeline/MessageBody";
import { UNFURL_HERO_FRAME_CLASS } from "@/features/timeline/UnfurlCards";
import {
  MESSAGE_AVATAR_GUTTER_CLASS,
  MESSAGE_AVATAR_SIZE_CLASS,
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
} from "@/features/timeline/spacing";

// 대화 미리보기 (#3578 S3a, AP-2a #4189): 「미리보기」 표식이 붙은 안쪽 상자에 메시지를 가짜 데이터로 그린다.
// **글자 크기·대화 밀도·링크 미리보기 선택에 즉시 반응한다.**
//
// 개념 출처: Buzz desktop `src/features/settings/ui/AppearanceSettingsControls.tsx:77-254`(Apache-2.0, Copyright 2026
// Block, Inc., 커밋 af5bb0a)의 「설정 안에서 같은 대화 몇 줄이 선택에 따라 즉시 바뀐다」는 구성. 코드는 복사하지 않았고
// oort 토큰·타임라인 상수로 다시 짰다(끌어서 보는 미리보기는 가져오지 않았다).
//
// 이 상자가 타임라인과 같은 값을 읽는 것이 요점이다. 눌러 보는 사람이 상자에서 본 간격과 실제 대화의 간격이 다르면 미리보기가
// 거짓말이 된다. 그래서 간격·아바타 클래스를 손으로 적지 않고 타임라인 행이 읽는 상수(`features/timeline/spacing.ts`)를 그대로
// 받고, 글은 타임라인과 같은 컴포넌트(`MessageBody`)로 그린다. 글자는 `text-*` 역할이라 글자 크기 배율을 자동으로 따른다.
// 행의 모양(이름 줄·시각 형식·에이전트 표기)도 타임라인 행과 같다. `ConversationPreview.test.ts`(소스)와
// `AppearanceSection.test.tsx`(렌더)가 같은 값을 읽는지 잰다.
//
// 순서: 밀도에 민감한 행(이어지는 행·묶음 머리·문단·목록)이 위에, 크기가 밀도와 무관한 링크 카드(히어로)는 맨 아래에 둔다 —
// 컨트롤에서 가까운 곳에서 바뀐 간격이 보이게 하려는 것이다. 폭은 카드의 전폭이라 글자 크기를 바꿔도 상자의 오른쪽 가장자리가
// 움직이지 않는다(글꼴 미리보기 상자와 같다).
//
// 실제 타임라인 행(`MessageRow`)을 그대로 쓰지 않는 이유: 행은 호버 툴바·프로필 버튼·스레드 같은 눌리는 것을 달고 있고, 이 상자의
// 것은 아무것도 눌러서는 안 된다(`aria-hidden`). 그 껍데기를 빼고 **간격과 크기를 정하는 것만** 같게 둔다. 링크 카드의 모양
// (히어로 비율·작은 그림·여백)도 타임라인의 `UnfurlCardView`와 같은 토큰을 읽는다. 줄바꿈 규칙도 타임라인과 같다(타임라인 본문이
// 어절 중간에서 끊기는 기존 동작을 미리보기도 그대로 보여 준다 — 고치려면 두 곳이 같이 바뀐다).

const SAMPLE_URL = "example.com/release-notes";

/** 에이전트 답: 문단 둘과 목록 하나라서 문단 간격·목록 간격이 둘 다 보인다. */
const AGENT_REPLY = [
  "확인했어요. 바로 정리할게요.",
  "바뀐 곳은 두 군데예요.",
  "- 배포 노트 요약\n- 설정 기본값 정리",
].join("\n\n");

function LinkCard({ layout }: { layout: Exclude<LinkPreviewPreference, "off"> }) {
  const rich = layout === "rich";
  const address = (
    <span className="flex min-w-0 items-center gap-1 text-timestamp text-ink-muted">
      <Globe className="size-4 shrink-0" aria-hidden="true" />
      <span className="truncate">example.com</span>
    </span>
  );
  return (
    <div
      // `mt-2`는 타임라인의 링크 카드 묶음(`UnfurlCards`)이 본문 아래에서 여는 간격과 같다. 면(`relative isolate
      // flex rounded-md bg-surface-muted`)과 그림 칸은 타임라인 카드와 같은 클래스이고 `ConversationPreview.test.ts`가 소스로 맞대 본다.
      className="relative isolate mt-2 flex max-w-pane min-w-0 rounded-md bg-surface-muted"
      data-testid="preview-link-card"
      data-layout={layout}
    >
      {rich ? (
        <span className="flex min-w-0 flex-1 flex-col gap-2 p-3">
          <span className="flex min-w-0 flex-col gap-px">
            {address}
            <span className="line-clamp-2 break-keep text-body font-medium text-ink">
              v0.1.19 릴리스 노트
            </span>
            <span className="line-clamp-2 break-keep text-meta text-ink-muted">
              이번 배포에서 바뀐 점을 정리했어요.
            </span>
          </span>
          <span className={cn(UNFURL_HERO_FRAME_CLASS, "flex items-center justify-center text-icon")}>
            <ImageIcon className="size-4" aria-hidden="true" />
          </span>
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-3 p-2">
          <span className="relative flex h-unfurl-tile w-unfurl-thumb shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted-soft text-icon">
            <ImageIcon className="size-4" aria-hidden="true" />
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-px">
            {address}
            <span className="truncate text-body font-medium text-ink">v0.1.19 릴리스 노트</span>
            <span className="truncate text-meta text-ink-muted">이번 배포에서 바뀐 점을 정리했어요.</span>
          </span>
        </span>
      )}
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

/** 타임라인 행의 작성자 줄: 이름(과 에이전트 표기) 한 덩어리 + 시각(24시간제 `HH:MM`, `timeLabel`과 같다). */
function AuthorLine({ time, children }: { time: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <span className="flex min-w-0 items-baseline gap-1">{children}</span>
      <span className="text-timestamp text-ink-muted" data-numeric>
        {time}
      </span>
    </div>
  );
}

export function ConversationPreview({ linkPreview }: { linkPreview: LinkPreviewPreference }) {
  return (
    <div
      aria-hidden="true"
      className="flex w-full min-w-0 flex-col rounded-lg border border-line bg-canvas-mid px-4 pb-3 pt-3"
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
        <AuthorLine time="14:14">
          <span className="truncate text-body font-semibold text-ink">성재</span>
        </AuthorLine>
        <MessageBody body="이번 주 배포 노트를 올렸어요." />
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
        <AuthorLine time="14:15">
          <span className="truncate text-body font-semibold text-agent">@kim</span>
          <span className="truncate text-meta text-ink-muted">· 성재 님이 관리</span>
        </AuthorLine>
        <MessageBody body={AGENT_REPLY} />
      </PreviewRow>
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
        <AuthorLine time="14:16">
          <span className="truncate text-body font-semibold text-ink">성재</span>
        </AuthorLine>
        {/* 링크는 눌리면 안 되는 상자 안이라 진짜 `<a>`가 아니라 링크처럼 보이는 글자다. 글자·줄 높이는 타임라인 본문과 같은 상수다. */}
        <p className={cn("whitespace-pre-wrap", MESSAGE_BODY_CLASS)}>
          릴리스 노트는 여기 있어요.{" "}
          <span className="text-signal-text underline">{SAMPLE_URL}</span>
        </p>
        {linkPreview === "off" ? null : <LinkCard layout={linkPreview} />}
      </PreviewRow>
    </div>
  );
}
