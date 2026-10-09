import type { ThemeId } from "@momo/core/design/themes";
import { THEME_LABELS } from "@momo/core/design/themes";
import { cn } from "@/design/lib/cn";
import type { AccentId } from "@/design/theme";

// 테마 미리보기 카드 (#3578 S3a): 미니 앱 화면 한 장. 캔버스 바닥 + 목록 열 + 본문 면 +
// 신호 알약 + 에이전트 점으로 「이 테마·이 모드의 앱」을 그린다. 글자는 몇 줄뿐이고
// 나머지는 막대다(색을 보는 자리이지 글을 읽는 자리가 아니다).
//
// 값은 한 줄도 적지 않는다. `data-palette-preview`가 생성 팔레트 CSS의 범위 변형을 불러
// 이 요소의 색 역할을 그 팔레트로 묶고(`themesCss.ts`), `data-preview-mode`가 이
// 요소의 `color-scheme`을 갈라 `light-dark()`가 그 모드로 풀린다. 「시스템」은 라이트
// 층 위에 다크 층을 대각선으로 반만 겹친다. 신호 알약은 `data-accent-swatch`가 자기
// 요소에서 신호 네 값을 다시 묶는다(팔레트 규칙이 루트 `data-accent`보다 요소에
// 가까워 액센트를 덮으므로, 알약만 따로 묶는다).
//
// 한계(S3b가 정할 것): 신호 알약을 묶는 액센트 바인딩 5종은 새벽하늘 값 전용이다
// (`themes/<id>.css`, DS2-7이 `data-signal`로 옮기며 걷는다). `palette`를 흑연·노을띠로
// 바꿔도 알약은 새벽하늘의 액센트 색이므로, 세 팔레트 카드를 열 때 신호 프리셋의 팔레트별
// 범위 변형을 같이 결정해야 한다.
//
// 장식이다. 고르는 컨트롤은 옆의 세그먼트이고 이 카드는 그 결과를 보여 줄 뿐이라
// 보조기술에는 숨긴다(`aria-hidden`).

export type PreviewMode = "light" | "dark" | "system";

function Layer({
  palette,
  mode,
  accent,
  split,
}: {
  palette: ThemeId;
  mode: "light" | "dark";
  accent: AccentId;
  split?: boolean;
}) {
  return (
    <div
      className="theme-preview-layer canvas-gradient"
      data-palette-preview={palette}
      data-preview-mode={mode}
      data-split={split ? "" : undefined}
      data-testid={`theme-preview-layer-${mode}`}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <span className="h-2 w-2/3 rounded-full bg-ink" />
        <span className="flex h-4 items-center rounded-full bg-surface px-1">
          <span className="h-1 w-3/4 rounded-full bg-ink-muted" />
        </span>
        <span className="h-1 w-1/2 rounded-full bg-icon" />
        <span className="h-1 w-3/5 rounded-full bg-icon" />
      </div>
      <div className="flex min-w-0 flex-col gap-1 rounded-md bg-surface p-2">
        <div className="flex items-center gap-1">
          <span className="truncate text-timestamp font-semibold text-ink" data-testid="theme-preview-title">
            오늘 배포
          </span>
          <span
            data-accent-swatch={accent}
            className="shrink-0 rounded-full bg-signal px-1 text-timestamp font-semibold text-on-signal"
            data-testid="theme-preview-pill"
          >
            새 글 3
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="size-2 shrink-0 rounded-full bg-agent" />
          <span className="truncate text-timestamp text-ink-muted" data-testid="theme-preview-muted">
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
  accent,
  palette,
  className,
}: {
  mode: PreviewMode;
  accent: AccentId;
  palette: ThemeId;
  className?: string;
}) {
  return (
    <div
      aria-hidden="true"
      className={cn("theme-preview", className)}
      data-testid="theme-preview"
      data-mode={mode}
      data-palette={palette}
      data-palette-label={THEME_LABELS[palette]}
    >
      {mode === "system" ? (
        <>
          <Layer palette={palette} mode="light" accent={accent} />
          <Layer palette={palette} mode="dark" accent={accent} split />
        </>
      ) : (
        <Layer palette={palette} mode={mode} accent={accent} />
      )}
    </div>
  );
}
