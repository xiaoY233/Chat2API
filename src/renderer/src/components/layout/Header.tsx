import { useTranslation } from 'react-i18next'
import { Sun, Moon, Languages, Play, Pause } from 'lucide-react'
import { useTheme } from '@/hooks/useTheme'
import { cn } from '@/lib/utils'
import logoIcon from '@/assets/icons/icons.png'
import { useEffect, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'

export function Header() {
  const { t } = useTranslation()
  const { toggleTheme, isDark } = useTheme()
  const { language, setLanguage } = useSettingsStore()
  const [proxyEnabled, setProxyEnabled] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(8080)

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return
    
    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
    })
    
    window.electronAPI.proxy.getStatus().then((status) => {
      setProxyEnabled(status.isRunning)
      if (status.port) setPort(status.port)
    })
    
    return unsubscribe
  }, [])

  const handleToggleProxy = async () => {
    if (proxyLoading) return
    setProxyLoading(true)
    try {
      if (proxyEnabled) {
        await window.electronAPI.proxy.stop()
        setProxyEnabled(false)
      } else {
        await window.electronAPI.proxy.start()
        setProxyEnabled(true)
      }
    } finally {
      setProxyLoading(false)
    }
  }

  const toggleLanguage = () => {
    setLanguage(language === 'zh-CN' ? 'en-US' : 'zh-CN')
  }

  return (
    <header className="glass-topbar flex items-center justify-between px-4 drag-region h-12">
      <div className="flex items-center gap-3 no-drag">
        <div className="sidebar-logo-icon">
          <img 
            src={logoIcon} 
            alt="Chat2API" 
            className="h-7 w-7 object-contain"
          />
        </div>
        <div className="flex flex-col">
          <span className="text-base font-bold text-[var(--text-primary)] leading-tight">
            Chat2API
          </span>
        </div>
      </div>

      <div className="flex items-center gap-4 no-drag">
        <button
          onClick={toggleTheme}
          className="w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-300 group"
          title={isDark ? t('settings.themeLight') : t('settings.themeDark')}
        >
          {isDark ? (
            <Sun className="h-4 w-4 text-[var(--text-primary)] group-hover:text-[var(--accent-primary)]" />
          ) : (
            <Moon className="h-4 w-4 text-[var(--text-primary)] group-hover:text-[var(--accent-primary)]" />
          )}
        </button>

        <button
          onClick={toggleLanguage}
          className="w-8 h-8 flex items-center justify-center rounded-lg transition-all duration-300 group"
          title={language === 'zh-CN' ? t('header.switchToEnglish') : t('header.switchToChinese')}
        >
          <Languages className="h-4 w-4 text-[var(--text-primary)] group-hover:text-[var(--accent-primary)]" />
        </button>

        <div className="flex items-center">
          <div
            className={cn(
              "flex items-center gap-1.5 pl-2.5 pr-1 py-1 rounded-full transition-all duration-300",
              "border",
              proxyEnabled
                ? "proxy-toggle-active"
                : "bg-[var(--glass-bg)] border-[var(--glass-border)]"
            )}
          >
            <div
              className={cn(
                "w-1.5 h-1.5 rounded-full transition-all duration-300",
                proxyLoading
                  ? "bg-[var(--warning)] animate-pulse"
                  : proxyEnabled
                    ? "bg-[var(--accent-primary)] shadow-[0_0_6px_var(--accent-primary)]"
                    : "bg-[var(--text-dim)]"
              )}
            />
            <span
              className={cn(
                "text-xs font-medium transition-colors duration-300",
                proxyEnabled
                  ? "text-[var(--accent-primary)]"
                  : "text-[var(--text-muted)]"
              )}
            >
              127.0.0.1:{port}
            </span>
            <button
              onClick={handleToggleProxy}
              disabled={proxyLoading}
              className={cn(
                "w-6 h-6 flex items-center justify-center rounded-full transition-all duration-200",
                "disabled:opacity-50 disabled:cursor-not-allowed",
                proxyEnabled
                  ? "proxy-toggle-btn-active"
                  : "bg-[var(--text-dim)]/10 text-[var(--text-secondary)]"
              )}
              title={proxyEnabled ? t('proxyStatus.stop') : t('proxyStatus.start')}
            >
              {proxyLoading ? (
                <span className="text-[10px]">...</span>
              ) : proxyEnabled ? (
                <Pause className="h-3 w-3" />
              ) : (
                <Play className="h-3 w-3" />
              )}
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
