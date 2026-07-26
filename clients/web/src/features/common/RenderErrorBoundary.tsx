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
        className="flex min-w-0 flex-1 flex-col gap-3 p-4"
        role="alert"
        // `role="alert"` alone cannot identify this: inline field and section
        // errors use it too, and those are the graceful degradation we want.
        // gate:wire needs to tell "the surface reported a problem" apart from
        // "the surface threw and was rescued".
        data-testid="render-error-boundary"
      >
        <h2 className="text-body font-semibold text-ink">{this.props.title}</h2>
        <p className="text-body text-ink-muted">{this.props.message}</p>
        <div>
          <Button variant="outline" size="sm" onClick={this.retry}>
            {this.props.retryLabel}
          </Button>
        </div>
      </section>
    );
  }
}
