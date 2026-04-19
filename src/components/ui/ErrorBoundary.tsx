import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  /** Optional label to identify where in the tree this boundary sits.
   *  Gets included in the console log so we can tell a root-level crash
   *  from a per-view crash at a glance. */
  label?: string;
  /** Render override — when set, takes precedence over the default
   *  "Something went wrong" panel. Used by per-view boundaries that
   *  want a scoped "this view failed, rest of the app still works"
   *  surface instead of the full-screen default. */
  fallback?: (err: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * Catches render-time + lifecycle errors below this point in the tree
 * and shows a recovery fallback instead of a blank screen.
 *
 * One instance wraps the whole app at the root (see main.tsx). Future
 * per-view boundaries with a scoped `fallback` prop can keep a single
 * failing view from taking down the chrome around it.
 *
 * Reporting: currently console-only. When the client error reporter
 * ships (see NEXT.md "Later" queue) hook it in here — one line in
 * `componentDidCatch` + metadata (`label`, `info.componentStack`).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: ErrorInfo): void {
    // Console is the only surface today. Include the label + component
    // stack so a user pasting devtools output gives us enough to chase.
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`,
      err,
      info.componentStack,
    );
  }

  reset = (): void => {
    this.setState({ err: null });
  };

  render(): ReactNode {
    const { err } = this.state;
    if (!err) return this.props.children;
    if (this.props.fallback) return this.props.fallback(err, this.reset);
    return <DefaultFallback err={err} onReset={this.reset} />;
  }
}

function DefaultFallback({ err, onReset }: { err: Error; onReset: () => void }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-space-900 text-gray-100">
      <div className="max-w-md w-full rounded-xl border border-red-700/60 bg-red-950/40 p-6 shadow-xl">
        <h1 className="swu-display text-base text-red-200 mb-2">
          Something went wrong.
        </h1>
        <p className="text-sm text-gray-300 leading-relaxed mb-4">
          SWUTrade hit an unexpected error and can't render this view.
          Your saved trades and lists are safe — reloading the page
          usually recovers. If it keeps happening, send the message
          below to the maintainer.
        </p>
        <pre className="text-[11px] text-red-300 bg-black/40 border border-red-900/60 rounded-md p-3 overflow-x-auto whitespace-pre-wrap break-words mb-4">
          {err.message || String(err)}
        </pre>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onReset}
            className="px-3 h-9 rounded-lg bg-space-800/60 border border-space-700 hover:border-gold/40 text-xs font-medium text-gray-200"
          >
            Try again
          </button>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="px-3 h-9 rounded-lg bg-gold text-space-900 font-bold text-xs hover:bg-gold-bright"
          >
            Reload
          </button>
        </div>
      </div>
    </div>
  );
}
