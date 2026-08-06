import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Activity } from 'lucide-react'

export interface ChartDataPoint {
  time: string
  requests: number
  success: number
  failed: number
}

export interface RequestChartProps {
  data: ChartDataPoint[]
  className?: string
}

const CHART_WIDTH = 640
const CHART_HEIGHT = 260
const CHART_PADDING = {
  top: 18,
  right: 18,
  bottom: 38,
  left: 44,
}

export function RequestChart({ data, className }: RequestChartProps) {
  const { t } = useTranslation()
  const series = useMemo(() => [
    { key: 'requests' as const, label: t('dashboard.totalRequests'), color: 'hsl(var(--primary))' },
    { key: 'success' as const, label: t('common.success'), color: 'hsl(142, 76%, 36%)' },
    { key: 'failed' as const, label: t('common.error'), color: 'hsl(0, 84%, 60%)' },
  ], [t])

  const chart = useMemo(() => {
    const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right
    const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom
    const maxValue = Math.max(1, ...data.flatMap(point => [point.requests, point.success, point.failed]))
    const yTicks = [maxValue, Math.ceil(maxValue / 2), 0]
    const xStep = data.length > 1 ? plotWidth / (data.length - 1) : 0
    const labelEvery = Math.max(1, Math.ceil(data.length / 6))

    const x = (index: number) => CHART_PADDING.left + index * xStep
    const y = (value: number) => CHART_PADDING.top + (1 - value / maxValue) * plotHeight
    const pathFor = (key: keyof Pick<ChartDataPoint, 'requests' | 'success' | 'failed'>) =>
      data
        .map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(2)} ${y(point[key]).toFixed(2)}`)
        .join(' ')

    return { plotWidth, plotHeight, maxValue, yTicks, labelEvery, x, y, pathFor }
  }, [data])

  return (
    <Card className={cn('', className)}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
            <Activity className="h-4 w-4 text-[var(--accent-primary)]" />
          </div>
          {t('dashboard.requestsTrend')}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-[300px] w-full">
          {data.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('common.noData')}
            </div>
          ) : (
            <svg
              viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
              className="h-full w-full overflow-visible"
              role="img"
              aria-label={t('dashboard.requestsTrend')}
            >
              {chart.yTicks.map(tick => (
                <g key={tick}>
                  <line
                    x1={CHART_PADDING.left}
                    x2={CHART_WIDTH - CHART_PADDING.right}
                    y1={chart.y(tick)}
                    y2={chart.y(tick)}
                    stroke="hsl(var(--border))"
                    strokeDasharray="3 3"
                  />
                  <text
                    x={CHART_PADDING.left - 10}
                    y={chart.y(tick)}
                    textAnchor="end"
                    dominantBaseline="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {tick}
                  </text>
                </g>
              ))}

              {data.map((point, index) => (
                index % chart.labelEvery === 0 || index === data.length - 1 ? (
                  <text
                    key={`${point.time}-${index}`}
                    x={chart.x(index)}
                    y={CHART_HEIGHT - 10}
                    textAnchor="middle"
                    className="fill-muted-foreground text-[11px]"
                  >
                    {point.time}
                  </text>
                ) : null
              ))}

              {series.map(item => (
                <path
                  key={item.key}
                  d={chart.pathFor(item.key)}
                  fill="none"
                  stroke={item.color}
                  strokeWidth={2}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
          )}
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
          {series.map(item => (
            <div key={item.key} className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
              <span>{item.label}</span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
