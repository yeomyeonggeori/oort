import type { ReactNode } from "react";
import { cn } from "@/design/lib/cn";

// 실제 크기 미리보기 틀 (#4261): 설정 안에서 「이 선택이 앱에서 이 크기로 이렇게 보인다」를 한 줄로 늘어놓는 상자.
//
// 아바타 편집기(`avatarEditor/AvatarEditorPreview`)가 처음 쓴다. 같은 문법(둥근 `surface-muted` 상자 안에 이름표 달린 그림 여럿)을
// 쓰는 다른 설정 미리보기(말풍선 꾸미기 등)가 **틀만** 가져다 쓰도록 편집기 폴더 밖, 설정 판의 다른 미리보기(`ThemePreviewCard`·
// `ConversationPreview`) 곁에 둔다. 틀은 안을 모른다: 무엇을 그릴지, 어떤 값으로 그릴지는 호출자가 정한다. 그래서 여기에는 아바타도
// 편집기 모델도 들어오지 않고(편집기는 지연 청크이고 이 파일은 그 청크의 것이 아니다), 색·간격은 토큰 역할만 쓴다.
//
// 장식이다(`aria-hidden`): 고르는 값은 옆의 컨트롤이 글자로 말하고, 이 상자는 그 결과를 보여 줄 뿐이다.

export function ActualSizePreview({
  children,
  className,
  testId,
  dataAttrs,
}: {
  children: ReactNode;
  className?: string;
  /** 시험·캡처가 읽는 `data-testid`(한 화면에 하나만). */
  testId?: string;
  /** 호출자가 상태를 알리는 `data-*`(예: 지금 고른 것이 초안인가). */
  dataAttrs?: Record<`data-${string}`, string>;
}) {
  return (
    <div
      aria-hidden="true"
      data-testid={testId}
      {...dataAttrs}
      className={cn("flex items-end justify-center gap-8 rounded-lg bg-surface-muted p-3", className)}
    >
      {children}
    </div>
  );
}

/** 한 크기의 그림과 그 밑의 이름표. 이름표는 상자의 다른 이름표와 같은 문법이라 호출자가 글만 넘긴다. */
export function ActualSizeFigure({
  caption,
  children,
  className,
}: {
  caption: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("m-0 flex flex-col items-center gap-2", className)}>
      {children}
      <figcaption className="text-meta text-ink-muted">{caption}</figcaption>
    </figure>
  );
}
