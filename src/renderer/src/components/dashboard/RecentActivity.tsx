import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { History, ExternalLink } from 'lucide-react'

export interface ActivityItem {
  id: string
  type: 'success' | 'error' | 'warning' | 'info'
  title: string
  description?: string
  timestamp: number
  providerName?: string
  modelName?: string
}

export interface RecentActivityProps {
  activities: ActivityItem[]
  onItemClick?: (item: ActivityItem) => void
  className?: string
}

export function RecentActivity({
  activities,
  onItemClick,
  className,
}: RecentActivityProps) {
  const { t } = useTranslation()

  const getTypeColor = (type: ActivityItem['type']) => {
    switch (type) {
      case 'success':
        return 'bg-green-500'
      case 'error':
        return 'bg-red-500'
      case 'warning':
        return 'bg-yellow-500'
      default:
        return 'bg-blue-500'
    }
  }

  const getTypeBadge = (type: ActivityItem['type']) => {
    switch (type) {
      case 'success':
        return 'default'
      case 'error':
        return 'destructive'
      case 'warning':
        return 'secondary'
      default:
        return 'outline'
    }
  }

  const formatTime = (timestamp: number) => {
    const now = Date.now()
    const diff = now - timestamp
    const minutes = Math.floor(diff / 60000)
    const hours = Math.floor(diff / 3600000)
    const days = Math.floor(diff / 86400000)

    if (minutes < 1) return 'Just now'
    if (minutes < 60) return `${minutes}m ago`
    if (hours < 24) return `${hours}h ago`
    return `${days}d ago`
  }

  const getTypeLabel = (type: ActivityItem['type']) => {
    switch (type) {
      case 'success':
        return t('common.success')
      case 'error':
        return t('common.error')
      case 'warning':
        return t('common.warning')
      default:
        return t('logs.info')
    }
  }

  return (
    <Card className={cn('h-full flex flex-col', className)}>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
            <History className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          {t('dashboard.recentActivity')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0">
        <ScrollArea className="h-[520px] pr-4">
          {activities.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              {t('dashboard.noActivity')}
            </div>
          ) : (
            <div className="space-y-3">
              {activities.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'flex items-start gap-3 p-3 rounded-xl transition-all duration-200',
                    'bg-[var(--glass-bg)] border border-[var(--glass-border)]',
                    onItemClick && 'cursor-pointer hover:bg-[var(--glass-bg-hover)] hover:border-[var(--glass-border-hover)] hover:-translate-y-0.5'
                  )}
                  onClick={() => onItemClick?.(item)}
                >
                  <div
                    className={cn(
                      'mt-1.5 h-2 w-2 rounded-full flex-shrink-0',
                      getTypeColor(item.type)
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm truncate">
                        {item.title}
                      </span>
                      <Badge
                        variant={getTypeBadge(item.type) as "default" | "secondary" | "destructive" | "outline"}
                        className="text-xs"
                      >
                        {getTypeLabel(item.type)}
                      </Badge>
                    </div>
                    {item.description && (
                      <p className="text-xs text-muted-foreground mt-1 truncate">
                        {item.description}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                      <span>{formatTime(item.timestamp)}</span>
                      {item.providerName && (
                        <>
                          <span>·</span>
                          <span>{item.providerName}</span>
                        </>
                      )}
                      {item.modelName && (
                        <>
                          <span>·</span>
                          <span className="truncate max-w-[100px]">
                            {item.modelName}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  {onItemClick && (
                    <ExternalLink className="h-4 w-4 text-muted-foreground flex-shrink-0" />
                  )}
                </div>
              ))}
            </div>
          )}
        </ScrollArea>
      </CardContent>
    </Card>
  )
}
