import { useState, useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  FileText,
  Trash2,
  Download,
  Search,
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
} from 'lucide-react'
import { toast } from '@/hooks/use-toast'
import { cn } from '@/lib/utils'

type LogLevel = 'info' | 'warn' | 'error' | 'debug'

interface LogEntry {
  id: string
  level: LogLevel
  message: string
  timestamp: number
  source?: string
}

const levelConfig: Record<LogLevel, { icon: React.ElementType; className: string }> = {
  info: { icon: Info, className: 'bg-blue-500/10 text-blue-500 border-blue-500/20' },
  warn: { icon: AlertTriangle, className: 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' },
  error: { icon: AlertCircle, className: 'bg-red-500/10 text-red-500 border-red-500/20' },
  debug: { icon: Bug, className: 'bg-gray-500/10 text-gray-500 border-gray-500/20' },
}

export default function LogsPage() {
  const { t } = useTranslation()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [levelFilter, setLevelFilter] = useState<LogLevel | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const logsRef = useRef<LogEntry[]>([])

  useEffect(() => {
    if (!window.electronAPI?.logs?.onNewLog) return

    const unsubscribe = window.electronAPI.logs.onNewLog((newLog: LogEntry) => {
      logsRef.current = [...logsRef.current.slice(-999), newLog]
      setLogs([...logsRef.current])
    })

    window.electronAPI.logs.get().then((allLogs: LogEntry[]) => {
      logsRef.current = allLogs
      setLogs(allLogs)
    })

    return unsubscribe
  }, [])

  const filteredLogs = logs.filter((log) => {
    if (levelFilter !== 'all' && log.level !== levelFilter) return false
    if (searchQuery && !log.message.toLowerCase().includes(searchQuery.toLowerCase())) {
      return false
    }
    return true
  })

  const handleClearLogs = async () => {
    setIsLoading(true)
    try {
      if (window.electronAPI?.logs?.clear) {
        await window.electronAPI.logs.clear()
        logsRef.current = []
        setLogs([])
        toast({
          title: t('logs.clearSuccess'),
          description: t('logs.allLogsCleared'),
        })
      }
    } catch (error) {
      toast({
        title: t('logs.clearFailed'),
        description: t('logs.cannotClearLogs'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
      setShowClearConfirm(false)
    }
  }

  const handleExportLogs = async (format: 'json' | 'txt') => {
    setIsLoading(true)
    try {
      if (window.electronAPI?.logs?.export) {
        const content = await window.electronAPI.logs.export(format)
        const blob = new Blob([content], { 
          type: format === 'json' ? 'application/json' : 'text/plain' 
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `logs-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'txt'}`
        a.click()
        URL.revokeObjectURL(url)
        toast({
          title: t('logs.exportSuccess'),
          description: t('logs.logsExportedAs', { format: format.toUpperCase() }),
        })
      } else {
        const content = format === 'json' 
          ? JSON.stringify(filteredLogs, null, 2)
          : filteredLogs.map(l => `[${new Date(l.timestamp).toISOString()}] [${l.level.toUpperCase()}] ${l.message}`).join('\n')
        const blob = new Blob([content], { 
          type: format === 'json' ? 'application/json' : 'text/plain' 
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `logs-${new Date().toISOString().slice(0, 10)}.${format === 'json' ? 'json' : 'txt'}`
        a.click()
        URL.revokeObjectURL(url)
        toast({
          title: t('logs.exportSuccess'),
          description: t('logs.logsExportedAs', { format: format.toUpperCase() }),
        })
      }
    } catch (error) {
      toast({
        title: t('logs.exportFailed'),
        description: t('logs.cannotExportLogs'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
      setShowExportDialog(false)
    }
  }

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('logs.title')}</h1>
          <p className="text-muted-foreground">{t('logs.description')}</p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5" />
                {t('logs.realtimeLogs')}
              </CardTitle>
              <CardDescription>
                {filteredLogs.length} {t('logs.message').toLowerCase()}s
              </CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowExportDialog(true)}
                disabled={logs.length === 0}
              >
                <Download className="h-4 w-4 mr-2" />
                {t('logs.exportLogs')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setShowClearConfirm(true)}
                disabled={logs.length === 0}
              >
                <Trash2 className="h-4 w-4 mr-2" />
                {t('logs.clearLogs')}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4 mb-4">
            <div className="flex items-center gap-2 flex-1">
              <Search className="h-4 w-4 text-muted-foreground" />
              <Input
                placeholder={t('logs.search')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="flex-1"
              />
            </div>
            <Select
              value={levelFilter}
              onValueChange={(value) => setLevelFilter(value as LogLevel | 'all')}
            >
              <SelectTrigger className="w-[120px]">
                <SelectValue placeholder={t('logs.level')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('logs.filter')}</SelectItem>
                <SelectItem value="info">{t('logs.info')}</SelectItem>
                <SelectItem value="warn">{t('logs.warn')}</SelectItem>
                <SelectItem value="error">{t('logs.error')}</SelectItem>
                <SelectItem value="debug">{t('logs.debug')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <ScrollArea className="h-[calc(100vh-350px)]" ref={scrollRef}>
            <div className="space-y-1 font-mono text-sm">
              {filteredLogs.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>{t('common.noData')}</p>
                </div>
              ) : (
                filteredLogs.map((log) => {
                  const config = levelConfig[log.level]
                  const Icon = config.icon
                  return (
                    <div
                      key={log.id}
                      className={cn(
                        'flex items-start gap-2 p-2 rounded-md hover:bg-muted/50 transition-colors',
                      )}
                    >
                      <Badge 
                        variant="outline" 
                        className={cn('shrink-0 gap-1', config.className)}
                      >
                        <Icon className="h-3 w-3" />
                        {log.level.toUpperCase()}
                      </Badge>
                      <span className="text-muted-foreground shrink-0">
                        {formatTimestamp(log.timestamp)}
                      </span>
                      <span className="break-all">{log.message}</span>
                    </div>
                  )
                })
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <Dialog open={showClearConfirm} onOpenChange={setShowClearConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('logs.clearConfirm')}</DialogTitle>
            <DialogDescription>
              {t('logs.clearConfirmDesc')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowClearConfirm(false)}>
              {t('common.cancel')}
            </Button>
            <Button 
              variant="destructive" 
              onClick={handleClearLogs}
              disabled={isLoading}
            >
              {t('logs.confirmClear')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showExportDialog} onOpenChange={setShowExportDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('logs.exportTitle')}</DialogTitle>
            <DialogDescription>
              {t('logs.exportDesc')}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-4 py-4">
            <Button
              className="flex-1"
              variant="outline"
              onClick={() => handleExportLogs('json')}
              disabled={isLoading}
            >
              <Download className="h-4 w-4 mr-2" />
              {t('logs.jsonFormat')}
            </Button>
            <Button
              className="flex-1"
              variant="outline"
              onClick={() => handleExportLogs('txt')}
              disabled={isLoading}
            >
              <Download className="h-4 w-4 mr-2" />
              {t('logs.textFormat')}
            </Button>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowExportDialog(false)}>
              {t('common.cancel')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
