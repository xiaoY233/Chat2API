import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useProxyStore } from '@/stores/proxyStore'
import { useToast } from '@/hooks/use-toast'
import type { ProxyStatistics } from '@/types/electron'
import {
  Activity,
  Play,
  Square,
  RefreshCw,
  Clock,
  Zap,
  TrendingUp,
  CheckCircle2,
  XCircle,
  BarChart3,
  Timer,
} from 'lucide-react'

interface ProxyStatusProps {
  onStatusChange?: () => void
}

export function ProxyStatus({ onStatusChange }: ProxyStatusProps) {
  const { t } = useTranslation()
  const {
    proxyStatus,
    proxyStatistics,
    fetchProxyStatus,
    fetchProxyStatistics,
    startProxy,
    stopProxy,
    isLoading,
  } = useProxyStore()
  const { toast } = useToast()
  
  const [isRefreshing, setIsRefreshing] = useState(false)

  useEffect(() => {
    fetchProxyStatus()
    fetchProxyStatistics()
    
    const statusInterval = setInterval(() => {
      fetchProxyStatus()
      fetchProxyStatistics()
    }, 5000)
    
    return () => {
      clearInterval(statusInterval)
    }
  }, [fetchProxyStatus, fetchProxyStatistics])

  const handleStart = async () => {
    const success = await startProxy()
    if (success) {
      toast({
        title: t('common.success'),
        description: t('dashboard.proxyRunning'),
      })
      onStatusChange?.()
    } else {
      toast({
        title: t('common.error'),
        description: t('dashboard.proxyStopped'),
        variant: 'destructive',
      })
    }
  }

  const handleStop = async () => {
    const success = await stopProxy()
    if (success) {
      toast({
        title: t('common.success'),
        description: t('dashboard.proxyStopped'),
      })
      onStatusChange?.()
    } else {
      toast({
        title: t('common.error'),
        description: 'Unable to stop proxy service',
        variant: 'destructive',
      })
    }
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    await Promise.all([fetchProxyStatus(), fetchProxyStatistics()])
    setIsRefreshing(false)
  }

  const handleResetStatistics = async () => {
    try {
      await window.electronAPI.invoke('proxy:resetStatistics')
      await fetchProxyStatistics()
      toast({
        title: t('common.success'),
        description: 'Statistics have been reset',
      })
    } catch (error) {
      toast({
        title: t('common.error'),
        description: 'Unable to reset statistics',
        variant: 'destructive',
      })
    }
  }

  const formatUptime = (ms: number): string => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const formatLatency = (ms: number): string => {
    if (ms < 1000) return `${Math.round(ms)}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const getSuccessRate = (stats: ProxyStatistics): number => {
    if (stats.totalRequests === 0) return 0
    return Math.round((stats.successRequests / stats.totalRequests) * 100)
  }

  const isRunning = proxyStatus?.isRunning ?? false

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              <CardTitle>{t('dashboard.proxyStatus')}</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={isRunning ? 'default' : 'secondary'}
                className={isRunning ? 'bg-green-500 hover:bg-green-600' : ''}
              >
                {isRunning ? (
                  <>
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    {t('dashboard.running')}
                  </>
                ) : (
                  <>
                    <Square className="h-3 w-3 mr-1" />
                    {t('dashboard.stopped')}
                  </>
                )}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                onClick={handleRefresh}
                disabled={isRefreshing}
              >
                <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>
          <CardDescription>{t('proxy.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('dashboard.port')}</p>
              <p className="text-2xl font-bold">{proxyStatus?.port ?? '-'}</p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('dashboard.runtime')}</p>
              <p className="text-2xl font-bold">
                {isRunning && proxyStatus?.uptime
                  ? formatUptime(proxyStatus.uptime)
                  : '-'}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-sm text-muted-foreground">{t('dashboard.activeConnections')}</p>
              <p className="text-2xl font-bold">
                {proxyStatistics?.activeConnections ?? 0}
              </p>
            </div>
          </div>

          <div className="flex gap-2 pt-4">
            {!isRunning ? (
              <Button onClick={handleStart} disabled={isLoading} className="flex-1">
                <Play className="h-4 w-4 mr-2" />
                {t('dashboard.startProxy')}
              </Button>
            ) : (
              <Button
                onClick={handleStop}
                disabled={isLoading}
                variant="destructive"
                className="flex-1"
              >
                <Square className="h-4 w-4 mr-2" />
                {t('dashboard.stopProxy')}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <BarChart3 className="h-5 w-5 text-primary" />
              <CardTitle>{t('logs.title')}</CardTitle>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleResetStatistics}
            >
              {t('common.reset')}
            </Button>
          </div>
          <CardDescription>{t('proxy.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-4">
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('dashboard.totalRequests')}</span>
              </div>
              <p className="text-2xl font-bold">
                {proxyStatistics?.totalRequests ?? 0}
              </p>
            </div>
            
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-4 w-4 text-green-500" />
                <span className="text-sm text-muted-foreground">{t('common.success')}</span>
              </div>
              <p className="text-2xl font-bold text-green-500">
                {proxyStatistics?.successRequests ?? 0}
              </p>
            </div>
            
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <XCircle className="h-4 w-4 text-destructive" />
                <span className="text-sm text-muted-foreground">{t('common.error')}</span>
              </div>
              <p className="text-2xl font-bold text-destructive">
                {proxyStatistics?.failedRequests ?? 0}
              </p>
            </div>
            
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                <span className="text-sm text-muted-foreground">Req/min</span>
              </div>
              <p className="text-2xl font-bold text-amber-500">
                {proxyStatistics?.requestsPerMinute ?? 0}
              </p>
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">{t('dashboard.successRate')}</span>
              <span className="text-sm font-medium">
                {getSuccessRate(proxyStatistics ?? {
                  totalRequests: 0,
                  successRequests: 0,
                  failedRequests: 0,
                  avgLatency: 0,
                  requestsPerMinute: 0,
                  activeConnections: 0,
                  modelUsage: {},
                  providerUsage: {},
                  accountUsage: {},
                })}%
              </span>
            </div>
            <Progress
              value={getSuccessRate(proxyStatistics ?? {
                totalRequests: 0,
                successRequests: 0,
                failedRequests: 0,
                avgLatency: 0,
                requestsPerMinute: 0,
                activeConnections: 0,
                modelUsage: {},
                providerUsage: {},
                accountUsage: {},
              })}
              className="h-2"
            />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <Timer className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('dashboard.avgLatency')}</span>
              </div>
              <p className="text-xl font-bold">
                {formatLatency(proxyStatistics?.avgLatency ?? 0)}
              </p>
            </div>
            
            <div className="space-y-2 p-4 bg-muted/50 rounded-lg">
              <div className="flex items-center gap-2">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">{t('dashboard.activeConnections')}</span>
              </div>
              <p className="text-xl font-bold">
                {proxyStatistics?.activeConnections ?? 0}
              </p>
            </div>
          </div>

          {proxyStatistics?.modelUsage && Object.keys(proxyStatistics.modelUsage).length > 0 && (
            <div className="space-y-3 pt-4 border-t">
              <h4 className="text-sm font-medium">{t('providers.models')} Usage</h4>
              <div className="space-y-2">
                {(Object.entries(proxyStatistics.modelUsage) as [string, number][])
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 5)
                  .map(([model, count]) => (
                    <div key={model} className="flex items-center justify-between">
                      <code className="text-sm">{model}</code>
                      <Badge variant="secondary">{count}</Badge>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {proxyStatistics?.providerUsage && Object.keys(proxyStatistics.providerUsage).length > 0 && (
            <div className="space-y-3 pt-4 border-t">
              <h4 className="text-sm font-medium">{t('providers.title')} Usage</h4>
              <div className="space-y-2">
                {(Object.entries(proxyStatistics.providerUsage) as [string, number][])
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 5)
                  .map(([providerId, count]) => (
                    <div key={providerId} className="flex items-center justify-between">
                      <span className="text-sm">{providerId}</span>
                      <Badge variant="secondary">{count}</Badge>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export default ProxyStatus
