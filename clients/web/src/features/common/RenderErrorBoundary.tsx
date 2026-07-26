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

  componentDidUpdate(prevProps: { resetKey?: string | number }) {
    if (this.state.failed && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
      return;
    }
    // The surface the keyboard was in has just been replaced. Without this the
    // caret lands on <body> and the user tabs from the top of the document
    // again — on every retry that fails, not only the first.
    if (this.state.failed) this.fallbackRef.current?.focus();
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
        // 경계가 뜰 때 여기로 포커스를 옮긴다(tabIndex=-1). Chromium은 그
        // 프로그램적 포커스에도 :focus-visible을 매칭하므로 링이 뜨는데, 이건
        // 숨길 게 아니라 키보드 사용자에게 "지금 여기"를 알려주는 신호다.
        // 집안 링과 같은 토큰을 쓴다.
        className={cn(
          "flex min-w-0 max-w-2xl flex-col items-start gap-3",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
