import React, { useEffect, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { ThemeProvider } from './components/ThemeProvider'
import {
  clearManagementSecret,
  getStoredManagementSecret,
  setManagementSecret,
  verifyManagementSecret,
} from './web-admin-api'
import './i18n'
import './index.css'

window.__CHAT2API_WEB_ADMIN__ = true

function WebAdminAuthGate() {
  const [secret, setSecret] = useState(() => getStoredManagementSecret() || '')
  const [isChecking, setIsChecking] = useState(Boolean(getStoredManagementSecret()))
  const [isAuthed, setIsAuthed] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const storedSecret = getStoredManagementSecret()
    if (!storedSecret) return

    verifyManagementSecret(storedSecret)
      .then((valid) => {
        if (valid) {
          setIsAuthed(true)
        } else {
          clearManagementSecret()
          setError('Management secret is invalid or expired.')
        }
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : 'Failed to verify management secret.')
      })
      .finally(() => setIsChecking(false))
  }, [])

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setError('')
    setIsChecking(true)

    try {
      const trimmedSecret = secret.trim()
      const valid = await verifyManagementSecret(trimmedSecret)
      if (!valid) {
        setError('Management secret is invalid.')
        return
      }
      setManagementSecret(trimmedSecret)
      setIsAuthed(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to verify management secret.')
    } finally {
      setIsChecking(false)
    }
  }

  if (isAuthed) {
    return (
      <ErrorBoundary>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </ErrorBoundary>
    )
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border bg-card p-6 shadow-sm space-y-4"
      >
        <div>
          <h1 className="text-xl font-semibold">Chat2API Admin</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Enter the Docker management secret to continue.
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="management-secret">
            Management Secret
          </label>
          <input
            id="management-secret"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoFocus
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={isChecking || !secret.trim()}
          className="inline-flex h-10 w-full items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {isChecking ? 'Verifying...' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <WebAdminAuthGate />
  </React.StrictMode>
)
