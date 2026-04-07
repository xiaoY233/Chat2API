import { useEffect, useState, useMemo } from 'react'
import { Power, Copy, Check, Play, Square, RotateCw, ExternalLink, Moon, Sun, Zap, Wifi, WifiOff } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTheme } from '@/hooks/useTheme'
import { useSettingsStore } from '@/stores/settingsStore'
import { useProvidersStore } from '@/stores/providersStore'
import iconsPng from '@/assets/icons/icons.png'

interface ProviderInfo {
  id: string
  name: string
  accountCount: number
  activeCount: number
}

export function TrayView() {
  const { toggleTheme, isDark } = useTheme()
  const { language } = useSettingsStore()
  const { providers, accounts, setProviders, setAccounts, setIsLoading, isLoading } = useProvidersStore()

  const [proxyRunning, setProxyRunning] = useState(false)
  const [proxyLoading, setProxyLoading] = useState(false)
  const [port, setPort] = useState(8080)
  const [host, setHost] = useState('127.0.0.1')
  const [copied, setCopied] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null)

  useEffect(() => {
    const loadProxyStatus = async () => {
      const status = await window.electronAPI?.proxy?.getStatus?.()
      setProxyRunning(status.isRunning)
      
      const config = await window.electronAPI?.config?.get?.()
      if (config) {
        setPort(config.proxyPort || 8080)
        setHost(config.proxyHost || '127.0.0.1')
      }
    }
    
    loadProxyStatus()

    const unsubscribeProxy = window.electronAPI?.proxy?.onStatusChanged?.((status) => {
      setProxyRunning(status.isRunning)
      if (status.port) setPort(status.port)
    })

    const unsubscribeConfig = window.electronAPI?.config?.onConfigChanged?.((config) => {
      setPort(config.proxyPort || 8080)
      setHost(config.proxyHost || '127.0.0.1')
    })

    return () => {
      unsubscribeProxy?.()
      unsubscribeConfig?.()
    }
  }, [])

  useEffect(() => {
    loadData()
  }, [])

  useEffect(() => {
    if (!selectedProvider && providers.length > 0) {
      const firstWithAccounts = providers.find((p) => {
        const count = accounts.filter((a) => a.providerId === p.id).length
        return count > 0
      })
      setSelectedProvider(firstWithAccounts?.id || providers[0]?.id || null)
    }
  }, [providers, accounts, selectedProvider])

  useEffect(() => {
    window.electronAPI?.send?.('tray:set-height', 460)
  }, [])

  const loadData = async () => {
    setIsLoading(true)
    try {
      const [providersData, accountsData, config] = await Promise.all([
        window.electronAPI?.providers?.getAll?.() || [],
        window.electronAPI?.accounts?.getAll?.() || [],
        window.electronAPI?.config?.get?.(),
      ])
      setProviders(providersData)
      setAccounts(accountsData)
      if (config) {
        setPort(config.proxyPort || 8080)
        setHost(config.proxyHost || '127.0.0.1')
      }
    } catch (error) {
      console.error('Failed to load data:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await loadData()
    setTimeout(() => setIsRefreshing(false), 1000)
  }

  const handleCopyUrl = async () => {
    const url = `http://${host}:${port}`
    await navigator.clipboard.writeText(url)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const toggleProxy = async () => {
    if (proxyLoading) return
    setProxyLoading(true)
    try {
      if (proxyRunning) {
        await window.electronAPI?.proxy?.stop?.()
        setProxyRunning(false)
      } else {
        await window.electronAPI?.proxy?.start?.()
        setProxyRunning(true)
      }
    } finally {
      setProxyLoading(false)
    }
  }

  const openDashboard = () => {
    window.electronAPI?.send?.('tray:open-dashboard')
  }

  const quitApp = () => {
    window.electronAPI?.tray?.quitApp?.()
  }

  const providerList: ProviderInfo[] = useMemo(() => {
    return providers.map((p) => {
      const providerAccounts = accounts.filter((a) => a.providerId === p.id)
      return {
        id: p.id,
        name: p.name,
        accountCount: providerAccounts.length,
        activeCount: providerAccounts.filter((a) => a.status === 'active').length,
      }
    })
  }, [providers, accounts])

  const selectedProviderAccounts = useMemo(() => {
    if (!selectedProvider) return []
    return accounts.filter((a) => a.providerId === selectedProvider)
  }, [accounts, selectedProvider])

  const isZh = language === 'zh-CN'

  return (
    <div className="w-full h-[460px] flex flex-col select-none overflow-hidden bg-white/70 dark:bg-slate-900/70 backdrop-blur-2xl">
      <div className="absolute top-0 left-0 right-0 h-6 drag-region z-50" />

      {/* Header with gradient */}
      <div className={cn(
        "flex-none relative overflow-hidden",
        proxyRunning 
          ? "bg-gradient-to-r from-emerald-500/90 via-teal-500/90 to-cyan-500/90" 
          : "bg-gradient-to-r from-slate-400/90 via-slate-500/90 to-slate-600/90"
      )}>
        <div className="absolute inset-0 bg-black/5" />
        <div className="relative px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-xl bg-white/20 backdrop-blur-sm flex items-center justify-center shadow-lg border border-white/30">
              <img src={iconsPng} alt="Chat2API" className="w-8 h-8" />
            </div>
            <div>
              <h1 className="text-base font-bold text-white tracking-tight">Chat2API</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                {proxyRunning ? (
                  <>
                    <Wifi size={12} className="text-white/90" />
                    <span className="text-xs text-white/90 font-medium">{isZh ? '服务运行中' : 'Service Running'}</span>
                  </>
                ) : (
                  <>
                    <WifiOff size={12} className="text-white/90" />
                    <span className="text-xs text-white/90 font-medium">{isZh ? '服务已停止' : 'Service Stopped'}</span>
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-0.5">
            <button
              onClick={handleRefresh}
              disabled={isLoading || isRefreshing}
              className="p-2 rounded-lg hover:bg-white/20 transition-colors disabled:opacity-30"
            >
              <RotateCw size={15} className={cn('text-white', (isLoading || isRefreshing) && 'animate-spin')} />
            </button>
            <button
              onClick={toggleTheme}
              className="p-2 rounded-lg hover:bg-white/20 transition-colors"
            >
              {isDark ? <Sun size={15} className="text-white" /> : <Moon size={15} className="text-white" />}
            </button>
          </div>
        </div>
      </div>

      {/* Endpoint Card */}
      <section className="flex-none px-4 -mt-3 relative z-10 no-drag">
        <div className="bg-white/80 dark:bg-slate-800/80 backdrop-blur-xl rounded-2xl shadow-lg border border-white/50 dark:border-slate-700/50 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 mb-1">
                <Zap size={12} className="text-amber-500" />
                <span className="text-[10px] text-slate-400 dark:text-slate-500 uppercase tracking-wider font-semibold">API Endpoint</span>
              </div>
              <button
                onClick={handleCopyUrl}
                className="flex items-center gap-1.5 group"
              >
                <code className="text-sm font-mono font-semibold text-slate-800 dark:text-white truncate">
                  {host}:{port}
                </code>
                {copied ? (
                  <Check size={12} className="text-emerald-500 flex-shrink-0" />
                ) : (
                  <Copy size={12} className="text-slate-400 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                )}
              </button>
            </div>
            <button
              onClick={toggleProxy}
              disabled={proxyLoading}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 rounded-xl font-semibold text-sm transition-all shadow-md",
                proxyRunning
                  ? "bg-gradient-to-r from-rose-500 to-pink-500 text-white hover:from-rose-600 hover:to-pink-600 shadow-rose-500/25"
                  : "bg-gradient-to-r from-emerald-500 to-teal-500 text-white hover:from-emerald-600 hover:to-teal-600 shadow-emerald-500/25"
              )}
            >
              {proxyRunning ? <Square size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
              <span>{proxyRunning ? (isZh ? '停止' : 'Stop') : (isZh ? '启动' : 'Start')}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Provider Tabs */}
      {providerList.length > 0 && (
        <nav className="flex-none px-4 pt-3 pb-2 no-drag">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
            {providerList.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedProvider(p.id)}
                className={cn(
                  "flex-shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-all backdrop-blur-sm",
                  selectedProvider === p.id
                    ? "bg-slate-900/90 dark:bg-white/90 text-white dark:text-slate-900 shadow-md"
                    : "bg-slate-100/80 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400 hover:bg-slate-200/80 dark:hover:bg-slate-700/80"
                )}
              >
                {p.name}
                <span className={cn(
                  "ml-1",
                  selectedProvider === p.id ? "opacity-70" : "opacity-50"
                )}>
                  {p.activeCount}/{p.accountCount}
                </span>
              </button>
            ))}
          </div>
        </nav>
      )}

      {/* Account List */}
      <main className="flex-1 min-h-0 px-4 overflow-y-auto no-drag">
        {isLoading && selectedProviderAccounts.length === 0 ? (
          <div className="py-10 flex items-center justify-center">
            <div className="w-6 h-6 border-2 border-slate-200 dark:border-slate-700 border-t-blue-500 rounded-full animate-spin" />
          </div>
        ) : selectedProviderAccounts.length === 0 ? (
          <div className="py-10 text-center">
            <div className="w-12 h-12 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mx-auto mb-2">
              <WifiOff size={20} className="text-slate-400" />
            </div>
            <p className="text-xs text-slate-400 dark:text-slate-500">{isZh ? '暂无账户' : 'No accounts'}</p>
          </div>
        ) : (
          <div className="space-y-2 pb-3">
            {selectedProviderAccounts.map((account) => {
              const isActive = account.status === 'active'
              return (
                <div
                  key={account.id}
                  className={cn(
                    "flex items-center justify-between p-3 rounded-xl transition-colors backdrop-blur-sm",
                    isActive 
                      ? "bg-emerald-50/80 dark:bg-emerald-900/30 border border-emerald-200/50 dark:border-emerald-800/30"
                      : "bg-slate-50/80 dark:bg-slate-800/50 border border-slate-200/50 dark:border-slate-700/50"
                  )}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={cn(
                      "w-2.5 h-2.5 rounded-full flex-shrink-0",
                      isActive ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-slate-300 dark:bg-slate-600"
                    )} />
                    <span className="text-sm font-medium text-slate-700 dark:text-slate-200 truncate">
                      {account.name || account.email || 'Unknown'}
                    </span>
                  </div>
                  <span className={cn(
                    "text-[10px] font-semibold px-2 py-1 rounded-full flex-shrink-0",
                    isActive
                      ? "bg-emerald-500 text-white"
                      : "bg-slate-200 dark:bg-slate-700 text-slate-500 dark:text-slate-400"
                  )}>
                    {isActive ? (isZh ? '在线' : 'Active') : (isZh ? '离线' : 'Inactive')}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="flex-none p-4 border-t border-slate-200/50 dark:border-slate-700/50 backdrop-blur-sm no-drag">
        <div className="flex gap-2">
          <button
            onClick={openDashboard}
            className="flex-1 flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gradient-to-r from-blue-500 to-indigo-500 hover:from-blue-600 hover:to-indigo-600 text-white font-semibold text-sm transition-all shadow-md shadow-blue-500/25"
          >
            <ExternalLink size={15} />
            <span>{isZh ? '打开主界面' : 'Open Dashboard'}</span>
          </button>
          <button
            onClick={quitApp}
            className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl bg-slate-100/80 dark:bg-slate-800/80 hover:bg-slate-200/80 dark:hover:bg-slate-700/80 text-slate-600 dark:text-slate-300 font-semibold text-sm transition-colors backdrop-blur-sm border border-slate-200/50 dark:border-slate-700/50"
          >
            <Power size={15} />
            <span>{isZh ? '退出' : 'Quit'}</span>
          </button>
        </div>
      </footer>
    </div>
  )
}

export default TrayView
