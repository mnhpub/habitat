import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null; info: ErrorInfo | null }

/**
 * Keeps one broken screen from blanking the whole app. Shows the error itself, so the
 * cause can be reported instead of guessed at.
 */
export class PageBoundary extends Component<Props, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Screen failed to render', error, info.componentStack);
    this.setState({ info });
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="panel stack tight" role="alert" style={{ maxWidth: 720 }}>
        <b>This screen failed to load</b>
        <span className="small muted">The rest of the event is still working. Send this text to the event team.</span>
        <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0 }}>
          {`${error.name}: ${error.message}${error.stack ? `\n${error.stack.split('\n').slice(1, 6).join('\n')}` : ''}${info?.componentStack ? `\nComponent stack:${info.componentStack.split('\n').slice(0, 6).join('\n')}` : ''}`}
        </pre>
        <div className="row">
          <button className="btn sm" onClick={() => this.setState({ error: null, info: null })}>Try again</button>
        </div>
      </div>
    );
  }
}
