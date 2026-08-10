import { Component, createRef, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// A rendering failure must stay in the surface that owns it. The fallback is
// deliberately terse: diagnostics belong in developer tools, not this screen.
export class RenderErrorBoundary extends Component<{
  children: ReactNode;
  title: string;
  message: string;
  retryLabel: string;
  onRetry?: () => void;
  /**
   * Changing this clears a previous failure — navigating away from a broken
   * route must not leave the next one showing its error.
   *
   * This is a prop and not a `key` on purpose. A `key` rebuilds the children
   * too, so every navigation would discard the route subtree: measured, that
   * threw away composer text and refetched history even when the user clicked
   * the channel they were already reading. The boundary resets itself; the
   * children keep their identity.
   */
  resetKey?: string | number;
  /**
   * Whether the fallback supplies its own inset. True for a surface that
   * replaces a whole route or the app frame, because their containers pad
   * nothing. False where the container already pads its children (the settings
   * pane), otherwise a failed section starts 32px in while healthy ones start
   * at 16px.
   */
  padded?: boolean;
}, { failed: boolean }> {
  static defaultProps = { padded: true };
  state = { failed: false };
  private fallbackRef = createRef<HTMLElement>();

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The boundary intentionally avoids exposing application details in UI.
  }

  componentDidMount() {
    // 자식이 경계의 첫 렌더에서 던지면 update가 아니라 mount로 끝난다(딥링크·
    // 새로고침·key로 갈리는 설정 섹션이 전부 이 경로다). 이걸 빼면 같은
    // 컴포넌트가 호출 지점에 따라 포커스를 옮기기도 하고 안 옮기기도 한다.
    if (this.state.failed) this.fallbackRef.current?.focus();
  }

  componentDidUpdate(
    prevProps: { resetKey?: string | number },
    prevState: { failed: boolean }
  ) {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
      return;
    }
    // 실패로 '전환'된 순간에만 옮긴다. 조건이 "실패 중 아무 업데이트"이면
    // 사이드바에 둔 포커스를 관계없는 리렌더가 도로 끌어온다(측정됨).
    if (this.state.failed && !prevState.failed) this.fallbackRef.current?.focus();
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section
        ref={this.fallbackRef}
        tabIndex={-1}
        // measure matches SectionShell so a long Korean sentence does not run
        // the width of a 1280px window.
        // 경계가 뜰 때 여기로 포커스를 옮긴다(tabIndex=-1). Chromium은 이
        // 프로그램적 포커스에 :focus-visible을 조건부로 매칭한다 — 직전 입력이
        // 키보드였을 때만이다. 그래서 마우스로 온 사람은 링을 보지 않고, 키보드로
        // 온 사람만 "지금 여기"를 본다. 링을 숨기는 대신 집안 토큰을 쓴다.
        //
        // self-start가 함께 있어야 한다: 이 section이 flex 부모의 유일한 자식일
        // 때 판 전체 높이로 늘어나, 링이 콘텐츠가 아니라 판을 두르는 800px
        // 세로줄로 그려진다(측정됨).
        className={cn(
          "flex min-w-0 max-w-2xl flex-col items-start gap-3 self-start",
          "focus-visible:focus-ring",
          this.props.padded && "p-4"
        )}
        role="alert"
        // `role="alert"` alone cannot identify this: inline field and section
        // errors use it too, and those are the graceful degradation we want.
        // gate:wire needs to tell "the surface reported a problem" apart from
        // "the surface threw and was rescued".
        data-testid="render-error-boundary"
      >
        <h2 className="text-title font-semibold text-ink">{this.props.title}</h2>
        <p className="text-body text-ink-muted">{this.props.message}</p>
        <Button variant="outline" size="sm" onClick={this.retry}>
          {this.props.retryLabel}
        </Button>
      </section>
    );
  }
}
