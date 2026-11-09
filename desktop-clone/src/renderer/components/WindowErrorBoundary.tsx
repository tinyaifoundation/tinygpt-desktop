import { Component, type ReactNode } from 'react';

/** A renderer error must leave a visible recovery action, even in a transparent window. */
export class WindowErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return <main role="alert" style={{ minHeight: '100vh', display: 'grid', placeContent: 'center', gap: 16, padding: 32, background: '#161619', color: '#f5f5f5', fontFamily: 'system-ui' }}>
      <p>TinyGPT couldn’t display this window.</p>
      <button style={{ padding: '10px 18px', borderRadius: 8, cursor: 'pointer' }} onClick={() => window.location.reload()}>Reload window</button>
    </main>;
  }
}
