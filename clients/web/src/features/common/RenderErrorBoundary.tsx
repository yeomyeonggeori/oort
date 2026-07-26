import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/design/ui/button";

// A rendering failure must stay in the surface that owns it. The fallback is
// deliberately terse: diagnostics belong in developer tools, not this screen.
export class RenderErrorBoundary extends Component<{
  children: ReactNode;
  title: string;
  message: string;
  retryLabel: string;
  onRetry?: () => void;
}, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: true } {
    return { failed: true };
  }

  componentDidCatch(_error: Error, _info: ErrorInfo) {
    // The boundary intentionally avoids exposing application details in UI.
  }

  private retry = () => {
    this.props.onRetry?.();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <section
        // 여백은 이 표면을 담는 쪽이 이미 갖고 있다. 폴백이 p-4를 또 얹으면
        // 정상 섹션은 16px에서 시작하는데 실패 섹션만 32px에서 시작해, 화면이
        // 실패할 때 눈에 띄게 어긋난다. measure(max-w-2xl)는 SectionShell과
        // 같은 값이어야 넓은 창에서 문장이 창 폭을 가로지르지 않는다.
        className="flex min-w-0 max-w-2xl flex-col items-start gap-3"
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
