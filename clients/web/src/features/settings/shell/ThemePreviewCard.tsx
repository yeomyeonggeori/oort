import type { ThemeRef } from "@momo/core/design/themeResolve";
import { cn } from "@/design/lib/cn";

// 테마 미리보기 (#3578 S3a, AP-1b #4188): 미니 앱 화면 한 장. 바닥 + 목록 열 + 본문 판 + 신호 알약 + 에이전트 점으로
// 「이 테마·이 모드의 앱」을 그린다. 글자는 몇 줄뿐이고 나머지는 막대다(색을 보는 자리이지 글을 읽는 자리가 아니다).
//
// 값은 한 줄도 적지 않고, 층은 **변수를 물려받는다**. `ThemePreviewCard`는 루트의 변수를 그대로 받는다(지금 고른
// 테마·신호·모드의 앱이므로 루트가 답을 이미 들고 있다). 갤러리 타일(`ThemeTile`, 지연 청크)은 층을 감싼 요소에 자기
// 테마의 변수 열셋을 CSSOM으로 꽂는다: 아직 고르지 않은 테마도 자기 색으로 그려진다. `data-preview-mode`가 이
// 요소의 `color-scheme`을 갈라 `light-dark()`가 그 모드로 풀린다. 「시스템」은 라이트 층 위에 다크 층을 대각선으로
// 반만 겹친다.
//
// S3a의 `data-palette-preview`(팔레트 범위 변형)와 알약의 `data-accent-swatch`(새벽하늘 프리셋 값 전용 바인딩)는
// 걷었다: 두 가지가 한계였다(흑연·노을띠 카드의 알약이 새벽하늘 주황으로 그려졌다). 이제 알약은 그 테마·모드의 신호
// 변수를 그대로 읽는다.
//
// 장식이다. 고르는 컨트롤은 옆의 세그먼트·갤러리이고 이 카드는 그 결과를 보여 줄 뿐이라 보조기술에는 숨긴다.

export type PreviewMode = "light" | "dark" | "system";

export function PreviewLayer({
  mode,
  split,
  testIds,
}: {
  mode: "light" | "dark";
  split?: boolean;
  /** 시험·캡처가 읽는 `data-testid`를 단다(한 화면에 하나만). */
  testIds?: boolean;
}) {
  return (
    <div
      className="theme-preview-layer canvas-gradient"
      data-preview-mode={mode}
      data-split={split ? "" : undefined}
      data-testid={testIds ? `theme-preview-layer-${mode}` : undefined}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="h-2 w-2/3 rounded-full bg-ink" />
        <span className="flex h-4 items-center rounded-full bg-surface px-1">
          <span className="h-1 w-3/4 rounded-full bg-ink-muted" />
        </span>
        <span className="h-1 w-1/2 rounded-full bg-icon" />
        <span className="h-1 w-3/5 rounded-full bg-icon" />
      </div>
      <div className="theme-preview-pane flex min-w-0 flex-col gap-1 rounded-md bg-pane p-2">
        <div className="flex items-center gap-1">
          <span
            className="theme-preview-title truncate text-timestamp font-semibold text-ink"
            data-testid={testIds ? "theme-preview-title" : undefined}
          >
            오늘 배포
          </span>
          <span
            className="shrink-0 rounded-full bg-signal px-1 text-timestamp font-semibold text-on-signal"
            data-testid={testIds ? "theme-preview-pill" : undefined}
          >
            새 글 3
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="size-2 shrink-0 rounded-full bg-agent" />
          <span
            className="theme-preview-reply truncate text-timestamp text-ink-muted"
            data-testid={testIds ? "theme-preview-muted" : undefined}
          >
            김인턴 답장
          </span>
        </div>
        <span className="h-1 w-full rounded-full bg-line-strong" />
        <span className="h-1 w-3/4 rounded-full bg-line-strong" />
      </div>
    </div>
  );
}

export function ThemePreviewCard({
  mode,
  theme,
  className,
}: {
  mode: PreviewMode;
  /** 지금 고른 테마. 색은 루트가 들고 있고, 이 값은 이름표(`data-theme-ref`)에만 쓴다. */
  theme: ThemeRef;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("theme-preview", className)}
      data-testid="theme-preview"
      data-mode={mode}
      data-theme-ref={theme}
    >
      {mode === "system" ? (
        <>
          <PreviewLayer mode="light" testIds />
          <PreviewLayer mode="dark" split testIds />
        </>
      ) : (
        <PreviewLayer mode={mode} testIds />
      )}
    </div>
  );
}
