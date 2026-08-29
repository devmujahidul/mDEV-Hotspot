import React from 'react';

interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Catches any render-time error in the component tree and shows a
 * recoverable error UI instead of a blank screen.
 */
export default class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // In real apps, ship to a logging service here.
    console.error('ErrorBoundary caught', error, info);
  }

  handleReset = () => this.setState({ error: null });
  handleReload = () => window.location.reload();

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 32, maxWidth: 720, margin: '64px auto' }}>
        <div className="card">
          <h2 style={{ marginTop: 0, color: 'var(--error)' }}>Something went wrong</h2>
          <p className="muted">{this.state.error.message}</p>
          <details style={{ marginTop: 8 }}>
            <summary>Stack trace</summary>
            <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12 }}>
              {this.state.error.stack}
            </pre>
          </details>
          <div className="row" style={{ marginTop: 16 }}>
            <button onClick={this.handleReset}>Dismiss</button>
            <button className="ghost" onClick={this.handleReload}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
