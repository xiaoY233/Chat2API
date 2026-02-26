import { useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Activity, CheckCircle, Clock, Users, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  StatsCard,
  ProviderStatusCard,
  RequestChart,
  QuickActions,
  RecentActivity,
} from '@/components/dashboard'
import { useDashboardStore } from '@/stores/dashboardStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'

export function Dashboard() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const {
    proxyStatus,
    stats,
    providers,
    activities,
    chartData,
    isLoading,
    error,
    lastUpdated,
    refreshData,
  } = useDashboardStore()
  const { proxyEnabled, setProxyEnabled } = useSettingsStore()
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (!hasLoadedRef.current) {
      hasLoadedRef.current = true
      refreshData()
    }
  }, [])

  useEffect(() => {
    const interval = setInterval(() => {
      useDashboardStore.getState().refreshData()
    }, 60000)
    
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (proxyStatus) {
      setProxyEnabled(proxyStatus.isRunning)
    }
  }, [proxyStatus, setProxyEnabled])

  useEffect(() => {
    if (!window.electronAPI?.proxy?.onStatusChanged) return
    
    const unsubscribe = window.electronAPI.proxy.onStatusChanged((status) => {
      useDashboardStore.getState().setProxyStatus(status)
      setProxyEnabled(status.isRunning)
    })
    
    return unsubscribe
  }, [setProxyEnabled])

  const handleToggleProxy = useCallback(async () => {
    if (!window.electronAPI?.proxy) return
    
    try {
      if (proxyStatus?.isRunning) {
        await window.electronAPI.proxy.stop()
        setProxyEnabled(false)
      } else {
        await window.electronAPI.proxy.start()
        setProxyEnabled(true)
      }
      refreshData()
    } catch (err) {
      console.error('Failed to toggle proxy:', err)
    }
  }, [proxyStatus, setProxyEnabled, refreshData])

  const handleAddAccount = useCallback(() => {
    navigate('/providers')
  }, [navigate])

  const handleViewLogs = useCallback(() => {
    navigate('/logs')
  }, [navigate])

  const handleActivityClick = useCallback((item: { id: string; type: string; title: string }) => {
    console.log('Activity clicked:', item)
  }, [])

  const formatUptime = (uptime: number) => {
    const hours = Math.floor(uptime / 3600)
    const minutes = Math.floor((uptime % 3600) / 60)
    if (hours > 0) {
      return `${hours} ${t('dashboard.hours')} ${minutes} ${t('dashboard.minutes')}`
    }
    return `${minutes} ${t('dashboard.minutes')}`
  }

  const isElectron = !!window.electronAPI

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('dashboard.title')}</h1>
          <p className="text-muted-foreground">
            {t('dashboard.description')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {lastUpdated && (
            <span className="text-xs text-muted-foreground">
              {t('dashboard.lastUpdated')}: {new Date(lastUpdated).toLocaleTimeString()}
            </span>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={refreshData}
            disabled={isLoading}
          >
            <RefreshCw className={cn('h-4 w-4 mr-2', isLoading && 'animate-spin')} />
            {t('dashboard.refresh')}
          </Button>
        </div>
      </div>

      {!isElectron && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-4 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400">
          <p className="font-medium">{t('dashboard.browserMode')}</p>
          <p>{t('dashboard.browserModeDesc')}</p>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-600 dark:border-red-800 dark:bg-red-950 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <StatsCard
          title={t('dashboard.totalRequests')}
          value={stats.totalRequests.toLocaleString()}
          icon={Activity}
          trend={{
            value: stats.requestsTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.successRate')}
          value={`${stats.successRate}%`}
          icon={CheckCircle}
          trend={{
            value: stats.successRateTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.avgResponseTime')}
          value={`${stats.avgLatency}ms`}
          icon={Clock}
          trend={{
            value: stats.latencyTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
        <StatsCard
          title={t('dashboard.activeAccountCount')}
          value={stats.activeAccounts}
          icon={Users}
          trend={{
            value: stats.accountsTrend,
            label: t('dashboard.vsYesterday'),
          }}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <RequestChart data={chartData} />
        </div>
        <div>
          <QuickActions
            proxyRunning={proxyStatus?.isRunning ?? proxyEnabled}
            onToggleProxy={handleToggleProxy}
            onAddAccount={handleAddAccount}
            onViewLogs={handleViewLogs}
            isLoading={isLoading}
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2 items-stretch">
        <ProviderStatusCard providers={providers} />
        <RecentActivity
          activities={activities}
          onItemClick={handleActivityClick}
        />
      </div>

      {proxyStatus && (
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    'h-3 w-3 rounded-full',
                    proxyStatus.isRunning ? 'bg-green-500 animate-pulse' : 'bg-red-500'
                  )}
                />
                <span className="font-medium">
                  {proxyStatus.isRunning ? t('dashboard.proxyRunning') : t('dashboard.proxyStopped')}
                </span>
              </div>
              <div className="text-sm text-muted-foreground">
                {t('dashboard.port')}: {proxyStatus.port}
              </div>
              {proxyStatus.isRunning && (
                <>
                  <div className="text-sm text-muted-foreground">
                    {t('dashboard.runtime')}: {formatUptime(proxyStatus.uptime)}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t('dashboard.activeConnections')}: {proxyStatus.connections}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
