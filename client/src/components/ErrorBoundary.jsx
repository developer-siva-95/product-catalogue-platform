import { Component } from 'react';

/**
 * Top-level error boundary.
 *
 * React unmounts the whole tree when a render throws, so this must be a class
 * component (hooks cannot catch render errors). It shows a recovery screen rather
 * than a white page, and exposes the error message for the developer console.
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
    this.handleReload = this.handleReload.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('Unhandled UI error', error, info?.componentStack);
  }

  handleReload() {
    this.setState({ error: null });
    window.location.assign('/');
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="full-page-center" role="alert">
        <div className="card auth-card" style={{ maxWidth: 520 }}>
          <h1>Something went wrong</h1>
          <p className="auth-card__subtitle">
            The page failed to render. Your session is unaffected — reloading usually fixes it.
          </p>
          <pre
            className="alert alert--error mono"
            style={{ whiteSpace: 'pre-wrap', fontSize: 12, display: 'block' }}
          >
            {String(error.message ?? error)}
          </pre>
          <div className="row" style={{ marginTop: 24 }}>
            <button type="button" className="btn btn--primary" onClick={this.handleReload}>
              Back to storefront
            </button>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => window.location.reload()}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
