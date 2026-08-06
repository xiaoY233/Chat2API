import { cn } from '@/lib/utils'

interface RequestLogEntry {
  id: string
  status: 'success' | 'error'
  statusCode: number
  timestamp: string
  time: string
  method?: string
  url?: string
  provider?: string
  providerId?: string
  model?: string
  actualModel?: string
  account?: string
  accountId?: string
  userInput?: string
  requestBody?: string
  duration?: number
  isStream?: boolean
  error?: string
}

interface LogRowProps {
  entry: RequestLogEntry
  onClick?: () => void
}

export function LogRow({ entry, onClick }: LogRowProps) {
  const isSuccess = entry.status === 'success'
  const statusColor = isSuccess
    ? 'bg-green-500'
    : 'bg-red-500'

  const statusBg = isSuccess
    ? 'bg-green-500/10 hover:bg-green-500/20'
    : 'bg-red-500/10 hover:bg-red-500/20'

  return (
    <div
      className={cn(
        'flex items-center gap-3 px-4 py-3 border-b cursor-pointer transition-colors',
        statusBg
      )}
      onClick={onClick}
    >
      <div className={cn('h-2 w-2 rounded-full flex-shrink-0', statusColor)} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground font-mono">
            {entry.time}
          </span>
          <span className={cn(
            'text-xs font-medium px-1.5 py-0.5 rounded',
            isSuccess ? 'bg-green-500/20 text-green-600' : 'bg-red-500/20 text-red-600'
          )}>
            {entry.statusCode}
          </span>
          {entry.isStream && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-600">
              stream
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 mt-1 text-sm">
          {entry.provider && (
            <span className="font-medium">{entry.provider}</span>
          )}
          {entry.model && (
            <span className="text-muted-foreground">/ {entry.model}</span>
          )}
        </div>

        {entry.userInput && (
          <p className="text-xs text-muted-foreground truncate mt-1">
            {entry.userInput}
          </p>
        )}

        {entry.error && (
          <p className="text-xs text-red-500 truncate mt-1">
            {entry.error}
          </p>
        )}
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground flex-shrink-0">
        {entry.duration && (
          <span>{(entry.duration * 1000).toFixed(0)}ms</span>
        )}
        <span className="text-[10px]">
          {new Date(entry.timestamp).toLocaleDateString()}
        </span>
      </div>
    </div>
  )
}
