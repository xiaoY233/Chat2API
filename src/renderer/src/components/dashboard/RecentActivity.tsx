import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  latency?: number
  statusCode?: number
}

export interface RecentActivityProps {
  activities: ActivityItem[]
  onItemClick?: (item: ActivityItem) => void
  className?: string
  maxVisible?: number
}

const ITEM_HEIGHT = 88
const GAP = 8

export function RecentActivity({
  activities,
  onItemClick,
  className,
  maxVisible = 7,
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

    if (minutes < 1) return t('dashboard.justNow')
    if (minutes < 60) return t('dashboard.minutesAgo', { count: minutes })
    if (hours < 24) return t('dashboard.hoursAgo', { count: hours })
    return t('dashboard.daysAgo', { count: days })
  }

  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const visibleActivities = activities.slice(0, maxVisible)
  const scrollHeight = ITEM_HEIGHT * maxVisible + GAP * (maxVisible - 1)

  return (
    <Card className={cn('h-full flex flex-col', className)}>
      <CardHeader className="pb-2 flex-shrink-0">
        <CardTitle className="flex items-center gap-2 text-base">
          <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
            <History className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          {t('dashboard.recentActivity')}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 min-h-0 p-4 pt-0">
        {activities.length === 0 ? (
          <div className="text-center text-muted-foreground py-8">
            {t('dashboard.noActivity')}
          </div>
        ) : (
          <ScrollArea className="pr-2" style={{ height: scrollHeight }}>
            <div className="space-y-2">
              {visibleActivities.map((item) => (
                <div
                  key={item.id}
                  className={cn(
                    'p-3 rounded-lg transition-all duration-200',
                    'bg-muted/30 hover:bg-muted/50 hover:-translate-y-0.5',
                    onItemClick && 'cursor-pointer'
                  )}
                  onClick={() => onItemClick?.(item)}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <div
                        className={cn(
                          'h-2 w-2 rounded-full',
                          getTypeColor(item.type)
                        )}
                      />
                      <span className="font-medium text-sm truncate">
                        {item.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {item.statusCode && (
                        <Badge
                          variant={getTypeBadge(item.type) as "default" | "secondary" | "destructive" | "outline"}
                          className="text-xs"
                        >
                          {item.statusCode}
                        </Badge>
                      )}
                      {onItemClick && (
                        <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                    </div>
                  </div>
                  {item.description && (
                    <p className="text-xs text-muted-foreground mb-1 truncate pl-4">
                      {item.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 text-xs text-muted-foreground pl-4">
                    <span>{formatTime(item.timestamp)}</span>
                    {item.providerName && (
                      <>
                        <span>·</span>
                        <span>{item.providerName}</span>
                      </>
                    )}
                    {item.latency !== undefined && (
                      <>
                        <span>·</span>
                        <span>{formatLatency(item.latency)}</span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </CardContent>
    </Card>
  )
}
