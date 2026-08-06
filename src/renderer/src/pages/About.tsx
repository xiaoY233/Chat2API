import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Loader2,
  Globe,
  Download,
  CheckCircle2,
  AlertCircle,
  Github,
  FileText,
  Bug,
  Zap,
  RefreshCw,
} from 'lucide-react'
import logoIcon from '@/assets/icons/icons.png'

type UpdatePhase = 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'

interface UpdateInfo {
  phase: UpdatePhase
  latestVersion: string | null
  error: string | null
}

interface DownloadProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
}

export function About() {
  const { t } = useTranslation()
  const [appVersion, setAppVersion] = useState<string>('')

  useEffect(() => {
    if (window.electronAPI?.app?.getVersion) {
      window.electronAPI.app.getVersion().then((v: string) => {
        if (v) setAppVersion(v)
      })
    }
  }, [])

  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ phase: 'idle', latestVersion: null, error: null })
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null)
  const displayAppVersion = appVersion || '...'

  useEffect(() => {
    if (!window.electronAPI?.app) return

    const unsubscribeChecking = window.electronAPI.app.onUpdateChecking(() => {
      setUpdateInfo((current) => ({
        ...current,
        phase: 'checking',
        error: null,
      }))
      setDownloadProgress(null)
    })

    const unsubscribeAvailable = window.electronAPI.app.onUpdateAvailable((info) => {
      setUpdateInfo({
        phase: 'available',
        latestVersion: info?.version || null,
        error: null,
      })
      setDownloadProgress(null)
    })

    const unsubscribeNotAvailable = window.electronAPI.app.onUpdateNotAvailable((info) => {
      setUpdateInfo({
        phase: 'not-available',
        latestVersion: info?.version || null,
        error: null,
      })
      setDownloadProgress(null)
    })

    const unsubscribeProgress = window.electronAPI.app.onUpdateProgress((progress: DownloadProgress) => {
      setDownloadProgress(progress)
      setUpdateInfo((current) => ({
        ...current,
        phase: 'downloading',
        error: null,
      }))
    })

    const unsubscribeDownloaded = window.electronAPI.app.onUpdateDownloaded((info) => {
      setUpdateInfo({
        phase: 'downloaded',
        latestVersion: info?.version || null,
        error: null,
      })
      setDownloadProgress(null)
    })

    const unsubscribeError = window.electronAPI.app.onUpdateError((error: any) => {
      setDownloadProgress(null)
      setUpdateInfo((current) => ({
        ...current,
        phase: 'error',
        error: typeof error === 'string' ? error : error?.message || 'Update failed',
      }))
    })

    return () => {
      unsubscribeChecking()
      unsubscribeAvailable()
      unsubscribeNotAvailable()
      unsubscribeProgress()
      unsubscribeDownloaded()
      unsubscribeError()
    }
  }, [])

  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }

  const formatSpeed = (bytesPerSecond: number): string => {
    return `${formatBytes(bytesPerSecond)}/s`
  }

  const getUpdateErrorMessage = (error: unknown, fallback: string): string => {
    if (typeof error === 'string') return error
    return error instanceof Error ? error.message : fallback
  }

  const handleCheckAppUpdate = async () => {
    setUpdateInfo((current) => ({
      ...current,
      phase: 'checking',
      error: null,
    }))
    setDownloadProgress(null)
    try {
      const status = await window.electronAPI.app.checkUpdate()
      setUpdateInfo({
        phase: status.error
          ? 'error'
          : status.checking
            ? 'checking'
            : status.downloaded
              ? 'downloaded'
              : status.downloading
                ? 'downloading'
                : status.available
                  ? 'available'
                  : 'not-available',
        latestVersion: status.version || null,
        error: status.error,
      })
    } catch (error) {
      setUpdateInfo((current) => ({
        ...current,
        phase: 'error',
        error: getUpdateErrorMessage(error, 'Update check failed'),
      }))
    }
  }

  const handleDownloadUpdate = async () => {
    try {
      setUpdateInfo((current) => ({
        ...current,
        phase: 'downloading',
        error: null,
      }))
      setDownloadProgress(null)
      await window.electronAPI.app.downloadUpdate()
    } catch (error) {
      setDownloadProgress(null)
      setUpdateInfo((current) => ({
        ...current,
        phase: 'error',
        error: getUpdateErrorMessage(error, 'Download failed'),
      }))
    }
  }

  const handleInstallUpdate = async () => {
    try {
      await window.electronAPI.app.installUpdate()
    } catch (error) {
      setUpdateInfo((current) => ({
        ...current,
        phase: 'error',
        error: getUpdateErrorMessage(error, 'Install failed'),
      }))
    }
  }

  const handleOpenExternal = (url: string) => {
    if (window.electronAPI?.app?.openExternal) {
      window.electronAPI.app.openExternal(url)
    } else {
      window.open(url, '_blank')
    }
  }

  const links = [
    {
      label: t('about.github'),
      icon: Github,
      url: 'https://github.com/xiaoY233/Chat2API',
    },
    {
      label: t('about.documentation'),
      icon: FileText,
      url: 'https://chat2api-doc.vercel.app/',
    },
    {
      label: t('about.reportIssue'),
      icon: Bug,
      url: 'https://github.com/xiaoY233/Chat2API/issues',
    },
  ]

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
      <div className="max-w-4xl mx-auto space-y-6 pb-12 px-4 animate-fade-in">
        <div className="flex flex-col items-center justify-center py-10 text-center relative">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 bg-[var(--accent-primary)]/10 blur-[80px] rounded-full pointer-events-none" />

          <div className="relative mb-6 animate-scale-in">
            <div className="relative w-24 h-24 rounded-[2rem] glass-card p-4 shadow-2xl border border-[var(--glass-border)] bg-[var(--glass-bg)] overflow-hidden">
              <img
                src={logoIcon}
                alt="Chat2API Logo"
                className="w-full h-full object-contain drop-shadow-md"
              />
            </div>
          </div>

          <div className="space-y-2 z-10">
            <h1 className="text-4xl font-bold tracking-tight text-[var(--text-primary)]">
              {t('settings.appName')}
            </h1>
            <p className="text-[var(--text-muted)] font-medium max-w-sm mx-auto">
              {t('about.tagline')}
            </p>
            <div className="inline-flex items-center gap-2 px-3 py-1 mt-3 rounded-full bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent-primary)]" />
              <span className="text-xs font-mono text-[var(--text-muted)]">
                v{displayAppVersion}
              </span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4">
          <div className="glass-card p-6 space-y-5">
            <h3 className="text-xs font-bold uppercase tracking-widest text-[var(--text-dim)] flex items-center gap-2">
              <Globe className="w-3.5 h-3.5" />
              {t('about.links')}
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {links.map((link) => (
                <button
                  key={link.label}
                  onClick={() => handleOpenExternal(link.url)}
                  className="w-full flex items-center justify-between p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)] hover:bg-[var(--glass-bg-hover)] hover:border-[var(--glass-border-hover)] transition-all group cursor-pointer text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="p-1.5 rounded-lg bg-[var(--bg-tertiary)]/50 text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors">
                      <link.icon className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-sm text-[var(--text-muted)] group-hover:text-[var(--text-primary)] transition-colors font-medium">
                      {link.label}
                    </span>
                  </div>
                  <div className="w-6 h-6 flex items-center justify-center rounded-full bg-[var(--bg-tertiary)]/30 opacity-0 group-hover:opacity-100 transition-all -translate-x-2 group-hover:translate-x-0">
                    <span className="text-[10px] text-[var(--text-primary)]">
                      ↗
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="glass-card p-6 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[var(--accent-primary)]/5 rounded-full blur-3xl -translate-y-1/2 translate-x-1/2 pointer-events-none transition-opacity opacity-50 group-hover:opacity-100" />

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 relative z-10">
            <div className="space-y-1">
              <h3 className="text-sm font-bold text-[var(--text-primary)] flex items-center gap-2">
                <Zap className="w-4 h-4 text-[var(--accent-primary)]" />
                {t('about.appUpdates')}
              </h3>
              <p className="text-xs text-[var(--text-muted)]">
                {t('settings.currentVersion')}:{' '}
                <span className="text-[var(--text-primary)] font-mono ml-1">
                  {displayAppVersion}
                </span>
              </p>
            </div>

            <div className="flex items-center gap-3">
              {updateInfo.phase === 'checking' ? (
                <div className="flex items-center gap-2 px-4 py-2 rounded-full bg-[var(--glass-bg)] border border-[var(--glass-border)] text-[var(--text-muted)]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="text-sm font-medium">{t('settings.checking')}</span>
                </div>
              ) : updateInfo.phase === 'downloading' ? (
                <div className="flex flex-col gap-2 min-w-[200px]">
                  <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                    <span>{t('settings.downloadingUpdate')}</span>
                    {downloadProgress && (
                      <span className="font-mono">{downloadProgress.percent.toFixed(1)}%</span>
                    )}
                  </div>
                  {downloadProgress ? (
                    <>
                      <div className="w-full h-2 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                        <div
                          className="h-full bg-[var(--accent-primary)] transition-all duration-300"
                          style={{ width: `${downloadProgress.percent}%` }}
                        />
                      </div>
                      <div className="flex items-center justify-between text-xs text-[var(--text-dim)]">
                        <span>{formatSpeed(downloadProgress.bytesPerSecond)}</span>
                        <span>
                          {formatBytes(downloadProgress.transferred)} / {formatBytes(downloadProgress.total)}
                        </span>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 text-xs text-[var(--text-dim)]">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>{t('settings.downloadingUpdate')}</span>
                    </div>
                  )}
                </div>
              ) : updateInfo.phase === 'downloaded' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--success)]/10 shadow-[0_0_8px_var(--success)]">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[var(--success)]" />
                    <span className="text-xs font-medium text-[var(--success)]">
                      {t('settings.updateDownloaded')}
                    </span>
                  </div>
                  <button
                    onClick={handleInstallUpdate}
                    className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/90 text-white text-sm font-medium rounded-full transition-colors flex items-center gap-2 shadow-lg shadow-[var(--accent-primary)]/20"
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t('settings.restartAndInstall')}
                  </button>
                </div>
              ) : updateInfo.phase === 'error' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--accent-error)]/10">
                    <AlertCircle className="w-3.5 h-3.5 text-[var(--accent-error)]" />
                    <span className="text-xs font-medium text-[var(--accent-error)]">
                      {t('settings.updateCheckFailed')}
                    </span>
                  </div>
                  <button
                    onClick={handleCheckAppUpdate}
                    className="px-4 py-2 bg-[var(--glass-bg)] hover:bg-[var(--glass-bg-hover)] border border-[var(--glass-border)] hover:border-[var(--glass-border-hover)] rounded-full text-sm text-[var(--text-primary)] font-medium transition-all duration-200 flex items-center gap-2"
                  >
                    <RefreshCw className="h-4 w-4 text-[var(--text-muted)]" />
                    {t('settings.retry')}
                  </button>
                </div>
              ) : updateInfo.phase === 'available' ? (
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--success)]/10 shadow-[0_0_8px_var(--success)]">
                    <span className="relative flex h-2 w-2">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--success)] opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--success)]"></span>
                    </span>
                    <span className="text-xs font-medium text-[var(--success)]">
                      {t('settings.updateAvailable')}
                      {updateInfo.latestVersion ? ` v${updateInfo.latestVersion}` : ''}
                    </span>
                  </div>
                  <button
                    onClick={handleDownloadUpdate}
                    className="px-4 py-2 bg-[var(--accent-primary)] hover:bg-[var(--accent-primary)]/90 text-white text-sm font-medium rounded-full transition-colors flex items-center gap-2 shadow-lg shadow-[var(--accent-primary)]/20"
                  >
                    <Download className="w-4 h-4" />
                    {t('settings.downloadUpdate')}
                  </button>
                </div>
              ) : (
                <button
                  onClick={handleCheckAppUpdate}
                  className="px-4 py-2 bg-[var(--glass-bg)] hover:bg-[var(--glass-bg-hover)] border border-[var(--glass-border)] hover:border-[var(--glass-border-hover)] rounded-full text-sm text-[var(--text-primary)] font-medium transition-all duration-200 flex items-center gap-2"
                >
                  <Globe className="h-4 w-4 text-[var(--text-muted)]" />
                  {t('settings.checkUpdates')}
                </button>
              )}
            </div>
          </div>

          {(updateInfo.phase === 'error' || updateInfo.phase === 'not-available') && (
            <div className="mt-4 pt-4 border-t border-[var(--glass-border)]">
              {updateInfo.phase === 'error' ? (
                <div className="flex items-center gap-2 text-[var(--accent-error)]">
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-sm font-medium">
                    {updateInfo.error || t('settings.updateCheckFailed')}
                  </span>
                </div>
              ) : updateInfo.phase === 'not-available' ? (
                <div className="flex items-center gap-2 text-[var(--accent-success)]">
                  <CheckCircle2 className="w-4 h-4" />
                  <span className="text-sm font-medium">{t('settings.upToDate')}</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <div className="text-center space-y-3 pt-8 pb-4 border-t border-[var(--glass-border)] opacity-60">
          <p className="text-[11px] font-bold tracking-[0.2em] text-[var(--text-dim)] uppercase">
            {t('about.credits')}
          </p>
          <p className="text-xs text-[var(--text-muted)] max-w-lg mx-auto leading-relaxed">
            {t('about.builtWith')}
          </p>
          <p className="text-[10px] text-[var(--text-dim)] font-mono">
            © {new Date().getFullYear()} {t('settings.appName')} • GPL-3.0 License
          </p>
        </div>
      </div>
    </div>
  )
}
