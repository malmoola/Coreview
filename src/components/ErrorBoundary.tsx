import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Keeps one broken component from taking the application with it (LT-073).
 *
 * A backup whose event payload arrived in an unexpected shape threw while
 * rendering, React unmounted the whole tree, and the operator was left with
 * an empty dark window — no message, no way back, work still unsaved in
 * memory. A diagram tool that can lose an afternoon to a render error is not
 * one anybody should trust.
 *
 * So a fault is caught here and reported where it happened: the rest of the
 * interface keeps working, the error text is shown rather than swallowed, and
 * "Try again" re-renders the subtree once the cause is gone.
 */
interface Props {
  children: ReactNode;
  /** What broke, in the operator's words — "The backups panel". */
  what: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console rather than a silent swallow: the stack is what makes the next
    // one findable, and there is no telemetry to send it to.
    console.error(`${this.props.what} failed to render`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="cv-boundary" role="alert">
        <strong>{this.props.what} stopped working.</strong>
        <p className="cv-help">
          The rest of Coreview is still running and nothing has been lost. If it keeps
          happening, this is the detail worth reporting:
        </p>
        <pre className="cv-boundary-detail">{error.message}</pre>
        <button type="button" className="cv-btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
