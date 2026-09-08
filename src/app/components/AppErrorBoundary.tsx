import { Component, type ErrorInfo, type ReactNode } from "react";
import { AppFailureState } from "./AppFailureState";
import { translateCurrent } from "../../shared/i18n/index";
import { reportFrontendCrash } from "../../shared/platform/logger";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  error: Error | null;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportFrontendCrash({
      kind: "react_render_error",
      message: error.message,
      stack: error.stack,
      componentStack: errorInfo.componentStack ?? undefined,
      url: window.location.href,
    });
    console.error("CLI-Manager render crashed:", error, errorInfo);
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <AppFailureState
        title={translateCurrent("app.runtime.failedTitle")}
        description={translateCurrent("app.runtime.failedDescription")}
        detail={this.state.error.stack || this.state.error.message}
        primaryAction={{
          label: translateCurrent("common.refresh"),
          onClick: () => window.location.reload(),
        }}
      />
    );
  }
}
