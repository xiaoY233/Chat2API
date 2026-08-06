import { useState, useCallback } from 'react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Card, CardContent } from '@/components/ui/card'
import { Search, X, Calendar, RefreshCw } from 'lucide-react'
import { useLogsStore } from '@/stores/logsStore'
import type { LogLevel } from '@/types/electron'

export function LogFilter() {
  const { filter, setFilter, autoScroll, setAutoScroll, refresh } = useLogsStore()
  const [keyword, setKeyword] = useState(filter.keyword)

  const handleKeywordChange = useCallback(
    (value: string) => {
      setKeyword(value)
    },
    []
  )

  const handleKeywordSubmit = useCallback(() => {
    setFilter({ keyword })
  }, [keyword, setFilter])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleKeywordSubmit()
      }
    },
    [handleKeywordSubmit]
  )

  const handleLevelChange = useCallback(
    (value: string) => {
      setFilter({ level: value as LogLevel | 'all' })
    },
    [setFilter]
  )

  const handleClearFilter = useCallback(() => {
    setKeyword('')
    setFilter({ level: 'all', keyword: '', startTime: undefined, endTime: undefined })
  }, [setFilter])

  const handleQuickTimeFilter = useCallback(
    (hours: number) => {
      const now = Date.now()
      const startTime = now - hours * 60 * 60 * 1000
      setFilter({ startTime, endTime: undefined })
    },
    [setFilter]
  )

  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2 flex-1 min-w-[200px]">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search logs..."
                value={keyword}
                onChange={(e) => handleKeywordChange(e.target.value)}
                onKeyDown={handleKeyDown}
                onBlur={handleKeywordSubmit}
                className="pl-9"
              />
              {keyword && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="absolute right-1 top-1/2 transform -translate-y-1/2 h-6 w-6 p-0"
                  onClick={() => {
                    setKeyword('')
                    setFilter({ keyword: '' })
                  }}
                >
                  <X className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>

          <Select value={filter.level} onValueChange={handleLevelChange}>
            <SelectTrigger className="w-[120px]">
              <SelectValue placeholder="Log Level" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Levels</SelectItem>
              <SelectItem value="info">Info</SelectItem>
              <SelectItem value="warn">Warn</SelectItem>
              <SelectItem value="error">Error</SelectItem>
              <SelectItem value="debug">Debug</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleQuickTimeFilter(1)}
              title="Last 1 hour"
            >
              <Calendar className="h-4 w-4 mr-1" />
              1h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleQuickTimeFilter(24)}
              title="Last 24 hours"
            >
              24h
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => handleQuickTimeFilter(168)}
              title="Last 7 days"
            >
              7d
            </Button>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant={autoScroll ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAutoScroll(!autoScroll)}
            >
              {autoScroll ? 'Auto Scroll' : 'Manual Scroll'}
            </Button>
            <Button variant="outline" size="sm" onClick={refresh}>
              <RefreshCw className="h-4 w-4 mr-1" />
              Refresh
            </Button>
            <Button variant="ghost" size="sm" onClick={handleClearFilter}>
              <X className="h-4 w-4 mr-1" />
              Clear Filter
            </Button>
          </div>
        </div>

        {(filter.startTime || filter.endTime) && (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            <Calendar className="h-4 w-4" />
            <span>
              Time Range:
              {filter.startTime && ` ${new Date(filter.startTime).toLocaleString()}`}
              {' - '}
              {filter.endTime ? new Date(filter.endTime).toLocaleString() : 'Now'}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2"
              onClick={() => setFilter({ startTime: undefined, endTime: undefined })}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
