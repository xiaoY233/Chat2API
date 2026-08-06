import { useMemo } from 'react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useLogsStore } from '@/stores/logsStore'
import { Info, AlertTriangle, AlertCircle, Bug, TrendingUp } from 'lucide-react'
import { cn } from '@/lib/utils'

interface LogStatsProps {
  showTrend?: boolean
}

export function LogStats({ showTrend = true }: LogStatsProps) {
  const { stats, trend } = useLogsStore()

  const maxTrendTotal = useMemo(() => {
    return Math.max(...trend.map((t) => t.total), 1)
  }, [trend])

  const statItems = [
    {
      label: 'Info',
      value: stats.info,
      icon: Info,
      color: 'text-blue-500',
      bgColor: 'bg-blue-500/10',
    },
    {
      label: 'Warn',
      value: stats.warn,
      icon: AlertTriangle,
      color: 'text-yellow-500',
      bgColor: 'bg-yellow-500/10',
    },
    {
      label: 'Error',
      value: stats.error,
      icon: AlertCircle,
      color: 'text-red-500',
      bgColor: 'bg-red-500/10',
    },
    {
      label: 'Debug',
      value: stats.debug,
      icon: Bug,
      color: 'text-gray-500',
      bgColor: 'bg-gray-500/10',
    },
  ]

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Info className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            Log Statistics
          </CardTitle>
          <CardDescription>
            Total <span className="font-semibold">{stats.total}</span> logs
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-4 gap-4">
            {statItems.map((item) => (
              <div
                key={item.label}
                className={cn(
                  'flex flex-col items-center justify-center p-3 rounded-xl transition-all duration-200 hover:-translate-y-0.5',
                  item.bgColor
                )}
              >
                <item.icon className={cn('h-5 w-5 mb-1', item.color)} />
                <span className={cn('text-2xl font-bold', item.color)}>
                  {item.value}
                </span>
                <span className="text-xs text-muted-foreground">{item.label}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {showTrend && trend.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg flex items-center gap-2">
                <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
                  <TrendingUp className="h-4 w-4 text-[var(--accent-primary)]" />
                </div>
                Log Trend
              </CardTitle>
              <Badge variant="outline">Last 7 days</Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-end justify-between gap-2 h-32">
              {trend.map((day) => (
                <div
                  key={day.date}
                  className="flex-1 flex flex-col items-center gap-1"
                >
                  <div className="w-full flex flex-col gap-0.5 h-24 justify-end">
                    {day.error > 0 && (
                      <div
                        className="w-full bg-red-500 rounded-t"
                        style={{
                          height: `${(day.error / maxTrendTotal) * 100}%`,
                          minHeight: day.error > 0 ? 4 : 0,
                        }}
                        title={`Error: ${day.error}`}
                      />
                    )}
                    {day.warn > 0 && (
                      <div
                        className="w-full bg-yellow-500"
                        style={{
                          height: `${(day.warn / maxTrendTotal) * 100}%`,
                          minHeight: day.warn > 0 ? 4 : 0,
                        }}
                        title={`Warn: ${day.warn}`}
                      />
                    )}
                    {day.info > 0 && (
                      <div
                        className="w-full bg-blue-500 rounded-b"
                        style={{
                          height: `${(day.info / maxTrendTotal) * 100}%`,
                          minHeight: day.info > 0 ? 4 : 0,
                        }}
                        title={`Info: ${day.info}`}
                      />
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground text-center">
                    <div className="font-medium">{day.total}</div>
                    <div className="text-[10px]">
                      {new Date(day.date).toLocaleDateString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-center gap-4 mt-4 text-xs">
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-blue-500 rounded" />
                <span>Info</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-yellow-500 rounded" />
                <span>Warn</span>
              </div>
              <div className="flex items-center gap-1">
                <div className="w-3 h-3 bg-red-500 rounded" />
                <span>Error</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
