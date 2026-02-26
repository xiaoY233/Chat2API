import React from 'react'

interface ErrorBoundaryState {
  hasError: boolean
  error: Error | null
  errorInfo: React.ErrorInfo | null
}

interface ErrorBoundaryProps {
  children: React.ReactNode
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false, error: null, errorInfo: null }
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('ErrorBoundary caught an error:', error, errorInfo)
    this.setState({ errorInfo })
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          padding: '20px',
          fontFamily: 'monospace',
          backgroundColor: '#1a1a1a',
          color: '#fff',
          minHeight: '100vh'
        }}>
          <h1 style={{ color: '#ff6b6b' }}>Application Error</h1>
          <pre style={{ 
            backgroundColor: '#2a2a2a', 
            padding: '10px', 
            borderRadius: '4px',
            overflow: 'auto',
            maxWidth: '100%'
          }}>
            {this.state.error?.toString()}
          </pre>
          {this.state.errorInfo && (
            <details style={{ marginTop: '10px' }}>
              <summary style={{ cursor: 'pointer', color: '#888' }}>Component Stack</summary>
              <pre style={{ 
                backgroundColor: '#2a2a2a', 
                padding: '10px', 
                borderRadius: '4px',
                overflow: 'auto',
                maxWidth: '100%',
                fontSize: '12px'
              }}>
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
          <button 
            onClick={() => window.location.reload()}
            style={{
              marginTop: '20px',
              padding: '10px 20px',
              backgroundColor: '#4a9eff',
              color: '#fff',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}

export default ErrorBoundary
