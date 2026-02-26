/**
 * Account List Component
 * Displays all accounts under a provider with status and actions
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { 
  DropdownMenu, 
  DropdownMenuContent, 
  DropdownMenuItem, 
  DropdownMenuSeparator, 
  DropdownMenuTrigger 
} from '@/components/ui/dropdown-menu'
import { 
  MoreVertical, 
  Edit, 
  Trash2, 
  Check, 
  X, 
  Clock,
  User,
  RefreshCw,
  AlertCircle,
  Activity,
  Plus
} from 'lucide-react'
import type { Account, AccountStatus } from '@/types/electron'
import { cn } from '@/lib/utils'

interface AccountListProps {
  accounts: Account[]
  providerId: string
  onAddAccount: () => void
  onEditAccount: (account: Account) => void
  onDeleteAccount: (id: string) => void
  onValidateAccount: (id: string) => void
  onViewDetail: (account: Account) => void
}

export function AccountList({
  accounts,
  providerId: _providerId,
  onAddAccount,
  onEditAccount,
  onDeleteAccount,
  onValidateAccount,
  onViewDetail,
}: AccountListProps) {
  const { t } = useTranslation()
  const [validatingIds, setValidatingIds] = useState<Set<string>>(new Set())

  const statusConfig: Record<AccountStatus, { 
    labelKey: string
    color: string
    bgColor: string
    icon: typeof Check
  }> = {
    active: {
      labelKey: 'providers.active',
      color: 'text-green-600',
      bgColor: 'bg-green-100',
      icon: Check,
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
      icon: X,
    },
  }

  const handleValidate = async (id: string) => {
    setValidatingIds(prev => new Set(prev).add(id))
    try {
      await onValidateAccount(id)
    } finally {
      setValidatingIds(prev => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const activeCount = accounts.filter(a => a.status === 'active').length
  const totalCount = accounts.length

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

  const formatUsage = (account: Account) => {
    if (account.dailyLimit) {
      return `${account.todayUsed || 0} / ${account.dailyLimit}`
    }
    return account.todayUsed || 0
  }

  if (accounts.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <User className="h-12 w-12 text-muted-foreground opacity-50 mb-4" />
          <p className="text-lg font-medium text-muted-foreground">{t('common.noData')}</p>
          <p className="text-sm text-muted-foreground mb-4">
            {t('providers.clickToAddProvider')}
          </p>
          <Button onClick={onAddAccount}>
            <Plus className="mr-2 h-4 w-4" />
            {t('providers.addAccount')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>{t('providers.total')}: {totalCount}</span>
          <span>•</span>
          <span className="text-green-600">{activeCount} {t('providers.onlineCount')}</span>
        </div>
        <Button size="sm" onClick={onAddAccount}>
          <Plus className="mr-2 h-4 w-4" />
          {t('providers.addAccount')}
        </Button>
      </div>

      <ScrollArea className="h-[calc(100vh-400px)]">
        <div className="space-y-3 pr-4">
          {accounts.map((account) => {
            const config = statusConfig[account.status]
            const StatusIcon = config.icon
            const isValidating = validatingIds.has(account.id)

            return (
              <Card 
                key={account.id} 
                className="hover:shadow-sm transition-shadow cursor-pointer"
                onClick={() => onViewDetail(account)}
              >
                <CardContent className="p-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className={cn(
                        'h-10 w-10 rounded-full flex items-center justify-center',
                        config.bgColor
                      )}>
                        <User className={cn('h-5 w-5', config.color)} />
                      </div>
                      
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{account.name}</span>
                          <Badge 
                            variant="outline" 
                            className={cn('text-xs', config.color, config.bgColor)}
                          >
                            <StatusIcon className="mr-1 h-3 w-3" />
                            {t(config.labelKey)}
                          </Badge>
                        </div>
                        
                        <div className="flex items-center gap-4 mt-1 text-xs text-muted-foreground">
                          {account.email && (
                            <span className="truncate">{account.email}</span>
                          )}
                          <span>{t('dashboard.totalRequests')}: {account.requestCount || 0}</span>
                          <span>{t('providers.usedToday')}: {formatUsage(account)}</span>
                        </div>
                        
                        {account.status === 'error' && account.errorMessage && (
                          <p className="text-xs text-red-500 mt-1 truncate">
                            {account.errorMessage}
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <div className="text-right text-xs text-muted-foreground">
                        <div>{t('providers.lastCheck')}</div>
                        <div>{formatDate(account.lastUsed)}</div>
                      </div>
                      
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button 
                            variant="ghost" 
                            size="icon"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreVertical className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              onViewDetail(account)
                            }}
                          >
                            <Activity className="mr-2 h-4 w-4" />
                            {t('common.details')}
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              handleValidate(account.id)
                            }}
                            disabled={isValidating}
                          >
                            <RefreshCw className={cn(
                              'mr-2 h-4 w-4',
                              isValidating && 'animate-spin'
                            )} />
                            {isValidating ? t('oauth.validating') : t('providers.validateCredentials')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              onEditAccount(account)
                            }}
                          >
                            <Edit className="mr-2 h-4 w-4" />
                            {t('providers.editAccount')}
                          </DropdownMenuItem>
                          <DropdownMenuItem 
                            onClick={(e) => {
                              e.stopPropagation()
                              onDeleteAccount(account.id)
                            }}
                            className="text-destructive"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            {t('providers.deleteAccount')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

export default AccountList
