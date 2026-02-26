import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { Server, Wifi, WifiOff, AlertCircle } from 'lucide-react'
import type { ProviderStatus } from '@/types/electron'

export interface ProviderStats {
  id: string
  name: string
  status: ProviderStatus
  requestCount: number
  successCount: number
  quotaUsed?: number
  quotaTotal?: number
  latency?: number
}

export interface ProviderStatusCardProps {
  providers: ProviderStats[]
  className?: string
}

export function ProviderStatusCard({ providers, className }: ProviderStatusCardProps) {
  const { t } = useTranslation()

  const getStatusIcon = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return <Wifi className="h-3 w-3" />
      case 'offline':
        return <WifiOff className="h-3 w-3" />
      default:
        return <AlertCircle className="h-3 w-3" />
    }
  }

  const getStatusColor = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return 'bg-green-500'
      case 'offline':
        return 'bg-red-500'
      default:
        return 'bg-yellow-500'
    }
  }

  const getStatusBadge = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return 'default'
      case 'offline':
        return 'destructive'
      default:
        return 'secondary'
    }
  }

  const getStatusText = (status: ProviderStatus) => {
    switch (status) {
      case 'online':
        return t('providers.online')
      case 'offline':
        return t('providers.offline')
      default:
        return t('providers.unknown')
    }
  }

  const getSuccessRate = (success: number, total: number) => {
    if (total === 0) return 0
    return Math.round((success / total) * 100)
  }

  return (
    <Card className={cn('h-full flex flex-col', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
            <Server className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          {t('dashboard.providerStats')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-[520px] pr-4">
          <div className="space-y-4">
            {providers.length === 0 ? (
              <div className="text-center text-muted-foreground py-4">
                {t('providers.noProvidersFound')}
              </div>
            ) : (
              providers.map((provider) => {
                const successRate = getSuccessRate(
                  provider.successCount,
                  provider.requestCount
                )
                const quotaPercentage =
                  provider.quotaTotal && provider.quotaUsed
                    ? Math.round((provider.quotaUsed / provider.quotaTotal) * 100)
                    : undefined

                return (
                  <div
                    key={provider.id}
                    className="flex items-start justify-between p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)] transition-all duration-200 hover:bg-[var(--glass-bg-hover)] hover:border-[var(--glass-border-hover)] hover:-translate-y-0.5"
                  >
                    <div className="flex items-start gap-3">
                      <div
                        className={cn(
                          'mt-1 h-2 w-2 rounded-full',
                          getStatusColor(provider.status)
                        )}
                      />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{provider.name}</span>
                          <Badge variant={getStatusBadge(provider.status) as "default" | "secondary" | "destructive"}>
                            {getStatusIcon(provider.status)}
                            <span className="ml-1">{getStatusText(provider.status)}</span>
                          </Badge>
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {t('dashboard.totalRequests')}: {provider.requestCount.toLocaleString()} |
                          {t('dashboard.successRate')}: {successRate}%
                          {provider.latency && ` | ${t('providers.latency')}: ${provider.latency}ms`}
                        </div>
                        {quotaPercentage !== undefined && (
                          <div className="w-32">
                            <Progress value={quotaPercentage} className="h-1.5" />
                            <div className="text-xs text-muted-foreground mt-1">
                              Quota: {provider.quotaUsed?.toLocaleString()} / {provider.quotaTotal?.toLocaleString()}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
