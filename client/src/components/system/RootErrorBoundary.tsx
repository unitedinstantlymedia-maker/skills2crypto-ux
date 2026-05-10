import React from "react";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
};

/**
 * Top-level error boundary that catches anything thrown during render and
 * displays the actual error message on screen. Critical for mobile where we
 * cannot inspect the browser console — without this, a thrown error during
 * provider init renders as a pure black screen with no diagnostic info.
 */
export class RootErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): State {
    return { error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[RootErrorBoundary]", error, errorInfo);
    this.setState({ error, errorInfo });
  }

  private handleReload = () => {
    try {
      window.location.reload();
    } catch {
      // ignore
    }
  };

  private handleClearAndReload = () => {
    try {
      window.localStorage.clear();
      window.sessionStorage.clear();
    } catch {
      // ignore
    }
    this.handleReload();
  };

  render(): React.ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    const message = error?.message || String(error);
    const stack = error?.stack || "";
    const componentStack = errorInfo?.componentStack || "";

    return (
      <div
        style={{
          minHeight: "100vh",
          width: "100%",
          background: "#0a0a0a",
          color: "#f5f5f5",
          padding: "20px",
          fontFamily:
            "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          fontSize: "14px",
          lineHeight: 1.5,
          boxSizing: "border-box",
          overflowY: "auto",
        }}
      >
        <h1
          style={{
            fontSize: "20px",
            color: "#f87171",
            marginBottom: "12px",
          }}
        >
          Something went wrong
        </h1>
        <p style={{ marginBottom: "16px", color: "#d4d4d8" }}>
          The app failed to start. Details below — please screenshot this and
          send it so we can fix it.
        </p>

        <div
          style={{
            background: "#1a1a1a",
            border: "1px solid #3f3f46",
            borderRadius: "8px",
            padding: "12px",
            marginBottom: "12px",
            wordBreak: "break-word",
          }}
        >
          <div style={{ color: "#fbbf24", marginBottom: "6px" }}>Error:</div>
          <div style={{ color: "#fecaca" }}>{message}</div>
        </div>

        {stack && (
          <div style={{ marginBottom: "12px" }}>
            <div style={{ color: "#a1a1aa", marginBottom: "6px" }}>
              Stack trace:
            </div>
            <pre
              style={{
                background: "#1a1a1a",
                border: "1px solid #3f3f46",
                borderRadius: "8px",
                padding: "12px",
                overflowX: "auto",
                fontSize: "11px",
                color: "#d4d4d8",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "300px",
                overflowY: "auto",
              }}
            >
              {stack}
            </pre>
          </div>
        )}

        {componentStack && (
          <div style={{ marginBottom: "16px" }}>
            <div style={{ color: "#a1a1aa", marginBottom: "6px" }}>
              Component stack:
            </div>
            <pre
              style={{
                background: "#1a1a1a",
                border: "1px solid #3f3f46",
                borderRadius: "8px",
                padding: "12px",
                overflowX: "auto",
                fontSize: "11px",
                color: "#d4d4d8",
                whiteSpace: "pre-wrap",
                wordBreak: "break-word",
                maxHeight: "200px",
                overflowY: "auto",
              }}
            >
              {componentStack}
            </pre>
          </div>
        )}

        <div
          style={{
            marginBottom: "12px",
            color: "#71717a",
            fontSize: "11px",
            fontFamily: "monospace",
            wordBreak: "break-all",
          }}
        >
          UA: {typeof navigator !== "undefined" ? navigator.userAgent : "?"}
        </div>

        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          <button
            onClick={this.handleReload}
            style={{
              background: "#10b981",
              color: "#0a0a0a",
              border: "none",
              borderRadius: "6px",
              padding: "10px 16px",
              fontSize: "14px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Reload
          </button>
          <button
            onClick={this.handleClearAndReload}
            style={{
              background: "transparent",
              color: "#f5f5f5",
              border: "1px solid #3f3f46",
              borderRadius: "6px",
              padding: "10px 16px",
              fontSize: "14px",
              cursor: "pointer",
            }}
          >
            Clear storage &amp; reload
          </button>
        </div>
      </div>
    );
  }
}
