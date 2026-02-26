/**
 * Account Detail Component
 * Displays detailed account information and usage statistics
 */

import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { 
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { 
  User, 
  Clock, 
  Activity, 
  AlertCircle,
  CheckCircle2,
  XCircle,
  Calendar,
  BarChart3,
  Zap,
  RefreshCw,
  Edit,
  Trash2,
  ArrowLeft,
  TrendingUp,
  Coins
} from 'lucide-react'
import type { Account, AccountStatus, Provider } from '@/types/electron'
import { cn } from '@/lib/utils'

interface AccountDetailProps {
  account: Account
  provider: Provider | undefined
  onBack: () => void
  onEdit: () => void
  onDelete: () => void
  onValidate: () => Promise<void>
  onStatusChange: (status: AccountStatus) => Promise<void>
}

export function AccountDetail({
  account,
  provider,
  onBack,
  onEdit,
  onDelete,
  onValidate,
  onStatusChange,
}: AccountDetailProps) {
  const { t, i18n } = useTranslation()
  const [isValidating, setIsValidating] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [credits, setCredits] = useState<{
    totalCredits: number
    usedCredits: number
    remainingCredits: number
  } | null>(null)
  const [isLoadingCredits, setIsLoadingCredits] = useState(false)
  const [trendData, setTrendData] = useState<{ date: string; total: number; info: number; warn: number; error: number }[]>([])

  useEffect(() => {
    const fetchTrendData = async () => {
      try {
        const trend = await window.electronAPI.logs.getAccountTrend(account.id, 7)
        console.log('Account trend data:', trend)
        setTrendData(trend)
      } catch (error) {
        console.error('Failed to fetch account trend:', error)
      }
    }
    fetchTrendData()
  }, [account.id])

  const isMiniMaxProvider = provider?.id === 'minimax'

  const statusConfig: Record<AccountStatus, { 
    labelKey: string
    color: string
    bgColor: string
    icon: typeof CheckCircle2
  }> = {
    active: {
      labelKey: 'providers.active',
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      icon: CheckCircle2,
    },
    inactive: {
      labelKey: 'providers.inactive',
      color: 'text-gray-600',
      bgColor: 'bg-gray-100',
      icon: Clock,
    },
    expired: {
      labelKey: 'providers.expired',
      color: 'text-orange-600',
      bgColor: 'bg-orange-100',
      icon: AlertCircle,
    },
    error: {
      labelKey: 'common.error',
      color: 'text-red-600',
      bgColor: 'bg-red-100',
      icon: XCircle,
    },
  }

  const config = statusConfig[account.status]
  const StatusIcon = config.icon

  const formatDate = (timestamp?: number) => {
    if (!timestamp) return '-'
    return new Date(timestamp).toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  const formatRelativeTime = (timestamp?: number) => {
    if (!timestamp) return t('providers.never')
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return t('providers.justNow')
    if (minutes < 60) return `${minutes} ${t('dashboard.minutes')}`
    if (hours < 24) return `${hours} ${t('dashboard.hours')}`
    return `${days}d`
  }

  const usagePercent = account.dailyLimit 
    ? Math.min(100, ((account.todayUsed || 0) / account.dailyLimit) * 100)
    : 0

  const handleValidate = async () => {
    setIsValidating(true)
    try {
      await onValidate()
    } finally {
      setIsValidating(false)
    }
  }

  const handleStatusChange = async (status: AccountStatus) => {
    await onStatusChange(status)
  }

  const handleDelete = async () => {
    await onDelete()
    setShowDeleteDialog(false)
  }

  const handleGetCredits = async () => {
    if (!isMiniMaxProvider) return
    
    setIsLoadingCredits(true)
    try {
      const result = await window.electronAPI.accounts.getCredits(account.id)
      setCredits(result)
    } catch (error) {
      console.error('Failed to get credits:', error)
    } finally {
      setIsLoadingCredits(false)
    }
  }

  const stats = [
    {
      labelKey: 'dashboard.totalRequests',
      value: account.requestCount || 0,
      icon: BarChart3,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
    {
      labelKey: 'providers.usedToday',
      value: account.todayUsed || 0,
      subtitle: account.dailyLimit ? `${t('providers.dailyLimit')}: ${account.dailyLimit}` : undefined,
      icon: Zap,
      color: 'text-amber-600',
      bgColor: 'bg-amber-100',
    },
    {
      labelKey: 'providers.lastCheck',
      value: formatRelativeTime(account.lastUsed),
      icon: Clock,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
    },
    {
      labelKey: 'apiKeys.createdAt',
      value: formatDate(account.createdAt),
      icon: Calendar,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
    },
  ]

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={onBack}>
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="flex-1">
          <h2 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            {account.name}
            <Badge 
              variant="outline" 
              className={cn('text-xs', config.color, config.bgColor)}
            >
              <StatusIcon className="mr-1 h-3 w-3" />
              {t(config.labelKey)}
            </Badge>
          </h2>
          <p className="text-muted-foreground">
            {provider?.name || t('providers.unknown')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleValidate}
            disabled={isValidating}
          >
            <RefreshCw className={cn('mr-2 h-4 w-4', isValidating && 'animate-spin')} />
            {isValidating ? t('oauth.validating') : t('providers.validateCredentials')}
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit}>
            <Edit className="mr-2 h-4 w-4" />
            {t('common.edit')}
          </Button>
          <Button 
            variant="outline" 
            size="sm"
            className="text-destructive"
            onClick={() => setShowDeleteDialog(true)}
          >
            <Trash2 className="mr-2 h-4 w-4" />
            {t('common.delete')}
          </Button>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('providers.credentials')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-3">
              <div className={cn('h-10 w-10 rounded-full flex items-center justify-center', config.bgColor)}>
                <User className={cn('h-5 w-5', config.color)} />
              </div>
              <div>
                <p className="font-medium">{account.name}</p>
                <p className="text-sm text-muted-foreground">ID: {account.id.slice(0, 8)}...</p>
              </div>
            </div>

            <Separator />

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Activity className="h-4 w-4" />
                  <span className="text-sm">{t('providers.status')}</span>
                </div>
                <Badge 
                  variant="outline" 
                  className={cn('text-xs', config.color, config.bgColor)}
                >
                  <StatusIcon className="mr-1 h-3 w-3" />
                  {t(config.labelKey)}
                </Badge>
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Calendar className="h-4 w-4" />
                  <span className="text-sm">{t('providers.lastCheck')}</span>
                </div>
                <span className="text-sm">{formatDate(account.updatedAt)}</span>
              </div>
            </div>

            {account.status === 'error' && account.errorMessage && (
              <div className="mt-4 p-3 bg-red-50 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertCircle className="h-4 w-4 text-red-500 mt-0.5 flex-shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-700">{t('common.error')}</p>
                    <p className="text-sm text-red-600 mt-1">{account.errorMessage}</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('dashboard.providerStats')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              {stats.map((stat) => {
                const Icon = stat.icon
                return (
                  <div key={stat.labelKey} className="p-3 rounded-lg bg-muted/50">
                    <div className="flex items-center gap-2 mb-2">
                      <div className={cn('h-8 w-8 rounded-full flex items-center justify-center', stat.bgColor)}>
                        <Icon className={cn('h-4 w-4', stat.color)} />
                      </div>
                      <span className="text-sm text-muted-foreground">{t(stat.labelKey)}</span>
                    </div>
                    <p className="text-xl font-semibold">{stat.value}</p>
                    {stat.subtitle && (
                      <p className="text-xs text-muted-foreground mt-1">{stat.subtitle}</p>
                    )}
                  </div>
                )
              })}
            </div>

            {account.dailyLimit && (
              <div className="mt-4">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-muted-foreground">{t('providers.usedToday')}</span>
                  <span className="text-sm font-medium">
                    {account.todayUsed || 0} / {account.dailyLimit}
                  </span>
                </div>
                <div className="h-2 bg-muted rounded-full overflow-hidden">
                  <div 
                    className={cn(
                      'h-full transition-all',
                      usagePercent >= 90 ? 'bg-red-500' :
                      usagePercent >= 70 ? 'bg-amber-500' : 'bg-green-500'
                    )}
                    style={{ width: `${usagePercent}%` }}
                  />
                </div>
                {usagePercent >= 90 && (
                  <p className="text-xs text-red-500 mt-1">
                    {t('providers.nearLimit')}
                  </p>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {isMiniMaxProvider && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Coins className="h-4 w-4" />
              {t('minimax.creditsInfo')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between mb-4">
              <Button
                variant="outline"
                size="sm"
                onClick={handleGetCredits}
                disabled={isLoadingCredits}
              >
                <RefreshCw className={cn('mr-2 h-4 w-4', isLoadingCredits && 'animate-spin')} />
                {isLoadingCredits ? t('common.loading') : t('minimax.getCredits')}
              </Button>
            </div>
            
            {credits && (
              <div className="grid grid-cols-3 gap-4">
                <div className="p-4 rounded-lg bg-muted/50 text-center">
                  <p className="text-sm text-muted-foreground mb-1">{t('minimax.totalCredits')}</p>
                  <p className="text-2xl font-bold text-blue-600">{credits.totalCredits.toLocaleString()}</p>
                </div>
                <div className="p-4 rounded-lg bg-muted/50 text-center">
                  <p className="text-sm text-muted-foreground mb-1">{t('minimax.usedCredits')}</p>
                  <p className="text-2xl font-bold text-amber-600">{credits.usedCredits.toLocaleString()}</p>
                </div>
                <div className="p-4 rounded-lg bg-muted/50 text-center">
                  <p className="text-sm text-muted-foreground mb-1">{t('minimax.remainingCredits')}</p>
                  <p className="text-2xl font-bold text-green-600">{credits.remainingCredits.toLocaleString()}</p>
                </div>
              </div>
            )}
            
            {!credits && !isLoadingCredits && (
              <p className="text-sm text-muted-foreground text-center py-4">
                {t('minimax.getCredits')}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            {t('dashboard.requestsTrend')}
          </CardTitle>
          <CardDescription>
            {t('providers.last7days')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between h-32 gap-2">
            {trendData.length > 0 && trendData.some(d => d.total > 0) ? (
              trendData.map((day, i) => {
                const date = new Date(day.date)
                const dayName = date.toLocaleDateString(i18n.language, { weekday: 'short' })
                const maxTotal = Math.max(...trendData.map(d => d.total), 1)
                const heightPercent = maxTotal > 0 ? (day.total / maxTotal) * 100 : 0
                const displayHeight = day.total > 0 ? Math.max(heightPercent, 5) : 2
                
                return (
                  <div key={i} className="flex-1 flex flex-col items-center h-full">
                    <div className="flex-1 w-full flex items-end">
                      <div 
                        className={cn(
                          "w-full rounded-t transition-all",
                          day.total > 0 ? "bg-primary/20 hover:bg-primary/40" : "bg-muted/30"
                        )}
                        style={{ height: `${displayHeight}%` }}
                        title={`${day.total} requests`}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground mt-1">{dayName}</span>
                  </div>
                )
              })
            ) : (
              Array.from({ length: 7 }).map((_, i) => {
                const day = new Date()
                day.setDate(day.getDate() - (6 - i))
                const dayName = day.toLocaleDateString(i18n.language, { weekday: 'short' })
                
                return (
                  <div key={i} className="flex-1 flex flex-col items-center h-full">
                    <div className="flex-1 w-full flex items-end">
                      <div 
                        className="w-full bg-muted/30 rounded-t"
                        style={{ height: '2%' }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground mt-1">{dayName}</span>
                  </div>
                )
              })
            )}
          </div>
          <p className="text-xs text-muted-foreground text-center mt-4">
            {trendData.length > 0 && trendData.some(d => d.total > 0) 
              ? `${trendData.reduce((sum, d) => sum + d.total, 0)} ${t('dashboard.totalRequests')}`
              : t('providers.sampleData')
            }
          </p>
        </CardContent>
      </Card>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('providers.confirmDeleteAccount')}</DialogTitle>
            <DialogDescription>
              {t('providers.confirmDeleteAccount')} "{account.name}"
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDeleteDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

export default AccountDetail
