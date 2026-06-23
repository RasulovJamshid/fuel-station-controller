import React from "react";
import { RotateCcw } from "lucide-react";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Unexpected desktop UI error", error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-dvh items-center justify-center bg-bg-primary p-6 text-text-primary">
        <div className="w-full max-w-xl rounded-lg border border-border bg-bg-card p-6 shadow-card">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-accent-red">
            Unexpected error
          </p>
          <h1 className="mt-3 text-2xl font-bold">App recovered to a safe screen</h1>
          <p className="mt-3 text-sm leading-6 text-text-secondary">
            The desktop interface caught an unknown error instead of freezing. Pump service
            communication continues in the background if the service is still running.
          </p>
          <pre className="mt-4 max-h-40 overflow-auto rounded-md border border-border bg-bg-secondary p-3 text-xs text-text-secondary">
            {this.state.error.message || "Unknown UI error"}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 inline-flex items-center gap-2 rounded-md bg-accent-blue px-4 py-2 text-sm font-semibold text-white shadow-button hover:brightness-110"
          >
            <RotateCcw className="h-4 w-4" />
            Reload
          </button>
        </div>
      </div>
    );
  }
}
