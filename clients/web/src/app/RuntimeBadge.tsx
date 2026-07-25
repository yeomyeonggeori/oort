import { IS_TAURI } from "@/lib/env";

/**
 * Proves "one codebase, two runtimes": the same bundle reports web vs desktop.
 * The badge is also where the build identifies itself as a spike, so no product
 * copy has to carry that (or an ADR number) in front of the user.
 */
export function RuntimeBadge() {
  return (
    <span
      data-testid="runtime-badge"
      data-runtime={IS_TAURI ? "desktop" : "web"}
      className="rounded-sm border border-line px-2 py-1 text-timestamp font-medium text-ink-muted"
      title={
        IS_TAURI
          ? "스파이크 빌드, Tauri 데스크톱 웹뷰에서 실행 중"
          : "스파이크 빌드, 브라우저에서 실행 중"
      }
    >
      {IS_TAURI ? "desktop (Tauri)" : "web"}
    </span>
  );
}
