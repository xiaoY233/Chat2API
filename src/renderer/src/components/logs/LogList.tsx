import { useCallback, useRef, useEffect } from 'react'
import { List } from 'react-window'
import { Badge } from '@/components/ui/badge'
import { useLogsStore } from '@/stores/logsStore'
import type { LogEntry } from '@/types/electron'
import { cn } from '@/lib/utils'

interface LogListProps {
  height?: number
  onLogClick?: (log: LogEntry) => void
}

const levelColors: Record<string, string> = {
  info: 'bg-blue-500 hover:bg-blue-600',
  warn: 'bg-yellow-500 hover:bg-yellow-600',
  error: 'bg-red-500 hover:bg-red-600',
  debug: 'bg-gray-500 hover:bg-gray-600',
}

const levelTextColors: Record<string, string> = {
  info: 'text-blue-500',
  warn: 'text-yellow-500',
  error: 'text-red-500',
  debug: 'text-gray-500',
}

const formatTime = (timestamp: number): string => {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

interface LogRowProps {
  logs: LogEntry[]
  selectedLogId: string | undefined
  onLogClick: ((log: LogEntry) => void) | undefined
}

interface ListImperativeHandle {
  readonly element: HTMLDivElement | null
  scrollToRow(config: { align?: 'auto' | 'center' | 'end' | 'smart' | 'start'; behavior?: 'auto' | 'instant' | 'smooth'; index: number }): void
}

function LogRow({ 
  index, 
  style, 
  logs, 
  selectedLogId, 
  onLogClick 
}: { 
  index: number
  style: React.CSSProperties
  ariaAttributes: { 'aria-posinset': number; 'aria-setsize': number; role: 'listitem' }
} & LogRowProps) {
  const log = logs[index]
  const isSelected = log.id === selectedLogId

  return (
    <div
      style={style}
      className={cn(
        'flex items-start gap-3 px-4 py-2 border-b border-[var(--glass-border)] cursor-pointer transition-all duration-200',
        isSelected 
          ? 'bg-[var(--accent-primary)]/10 border-l-2 border-l-[var(--accent-primary)]' 
          : 'hover:bg-[var(--glass-bg-hover)] hover:-translate-x-0.5'
      )}
      onClick={() => onLogClick?.(log)}
    >
      <span className="text-muted-foreground text-xs font-mono shrink-0 w-36">
        {formatTime(log.timestamp)}
      </span>
      <Badge
        variant="outline"
        className={cn(
          'text-white text-xs shrink-0 px-2 py-0.5',
          levelColors[log.level]
        )}
      >
        {log.level.toUpperCase()}
      </Badge>
      <span
        className={cn(
          'text-sm font-mono break-all flex-1',
          levelTextColors[log.level]
        )}
        title={log.message}
      >
        {log.message}
      </span>
      {log.providerId && (
        <Badge variant="secondary" className="text-xs shrink-0">
          {log.providerId}
        </Badge>
      )}
    </div>
  )
}

export function LogList({ height = 500, onLogClick }: LogListProps) {
  const { filteredLogs, selectedLog, autoScroll, isLoading, hasMore, loadMore } = useLogsStore()
  const listRef = useRef<ListImperativeHandle>(null)

  useEffect(() => {
    if (autoScroll && filteredLogs.length > 0 && listRef.current) {
      listRef.current.scrollToRow({ index: 0, align: 'start' })
    }
  }, [filteredLogs.length, autoScroll])

  const handleRowsRendered = useCallback(
    ({ stopIndex }: { startIndex: number; stopIndex: number }) => {
      if (
        stopIndex >= filteredLogs.length - 10 &&
        hasMore &&
        !isLoading
      ) {
        loadMore()
      }
    },
    [filteredLogs.length, hasMore, isLoading, loadMore]
  )

  const rowProps: LogRowProps = {
    logs: filteredLogs,
    selectedLogId: selectedLog?.id,
    onLogClick,
  }

  if (filteredLogs.length === 0) {
    return (
      <div
        className="flex items-center justify-center text-muted-foreground"
        style={{ height }}
      >
        <div className="text-center">
          <p className="text-lg">No logs yet</p>
          <p className="text-sm mt-1">Logs will be displayed here in real-time</p>
        </div>
      </div>
    )
  }

  return (
    <div className="relative">
      <List<LogRowProps>
        listRef={listRef as React.Ref<{ readonly element: HTMLDivElement | null; scrollToRow(config: { align?: 'auto' | 'center' | 'end' | 'smart' | 'start'; behavior?: 'auto' | 'instant' | 'smooth'; index: number }): void }>}
        rowComponent={LogRow}
        rowCount={filteredLogs.length}
        rowHeight={48}
        rowProps={rowProps}
        onRowsRendered={handleRowsRendered}
        className="font-mono text-sm"
        style={{ height, width: '100%' }}
      />
      {isLoading && (
        <div className="absolute bottom-0 left-0 right-0 flex justify-center py-2 bg-background/80">
          <div className="animate-spin h-5 w-5 border-2 border-primary border-t-transparent rounded-full" />
        </div>
      )}
    </div>
  )
}
