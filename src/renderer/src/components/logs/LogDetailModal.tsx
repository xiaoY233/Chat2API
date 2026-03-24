import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { X, Copy, Check, Download } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
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

interface LogDetailModalProps {
  log: RequestLogEntry | null
  open: boolean
  onClose: () => void
}

function JsonViewer({ data }: { data: string }) {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(data)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }, [data])

  return (
    <div className="relative">
      <div className="bg-muted/50 rounded-lg p-3 overflow-x-auto">
        <pre className="text-xs font-mono whitespace-pre-wrap break-all">
          {data}
        </pre>
      </div>
      <div className="absolute top-2 right-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2"
          onClick={handleCopy}
        >
          {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
        </Button>
      </div>
    </div>
  )
}

export function LogDetailModal({ log, open, onClose }: LogDetailModalProps) {
  const { t } = useTranslation()

  if (!log) return null

  const handleExport = useCallback(() => {
    const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `log-${log.id}.json`
    a.click()
    URL.revokeObjectURL(url)
  }, [log])

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl w-[90vw] h-[85vh] max-h-[800px] p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0">
          <DialogTitle className="flex items-center justify-between flex-wrap gap-2">
            <span>{t('logs.detail')}</span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleExport}>
                <Download className="h-4 w-4 mr-1" />
                {t('logs.export')}
              </Button>
              <Button variant="ghost" size="sm" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </DialogTitle>
        </DialogHeader>
        <ScrollArea className="flex-1 px-6 pb-6 min-h-0">
          <div className="space-y-4 pr-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="min-w-0">
                <label className="text-sm text-muted-foreground">{t('logs.time')}</label>
                <p className="font-medium break-all">{log.timestamp}</p>
              </div>
              <div className="min-w-0">
                <label className="text-sm text-muted-foreground">{t('logs.status')}</label>
                <p className="font-medium flex items-center gap-2 flex-wrap">
                  <span
                    className={cn(
                      'h-2 w-2 rounded-full shrink-0',
                      log.status === 'success' ? 'bg-green-500' : 'bg-red-500'
                    )}
                  />
                  <span className="break-all">{log.statusCode}</span>
                </p>
              </div>
              <div className="min-w-0">
                <label className="text-sm text-muted-foreground">{t('logs.provider')}</label>
                <p className="font-medium break-all">{log.provider || '-'}</p>
              </div>
              <div className="min-w-0">
                <label className="text-sm text-muted-foreground">{t('logs.model')}</label>
                <p className="font-medium break-all">{log.model || '-'}</p>
              </div>
              <div className="min-w-0">
                <label className="text-sm text-muted-foreground">{t('logs.account')}</label>
                <p className="font-medium break-all">{log.account || '-'}</p>
              </div>
              <div className="min-w-0">
                <label className="text-sm text-muted-foreground">{t('logs.duration')}</label>
                <p className="font-medium">{log.duration ? `${(log.duration * 1000).toFixed(0)}ms` : '-'}</p>
              </div>
            </div>

            {log.userInput && (
              <div>
                <label className="text-sm text-muted-foreground">{t('logs.userInput')}</label>
                <div className="mt-1 p-3 bg-muted/50 rounded-lg">
                  <pre className="text-sm whitespace-pre-wrap break-all font-sans">
                    {log.userInput}
                  </pre>
                </div>
              </div>
            )}

            {log.error && (
              <div>
                <label className="text-sm text-red-500">{t('logs.error')}</label>
                <div className="mt-1 p-3 bg-red-500/10 rounded-lg border border-red-500/20">
                  <pre className="text-sm text-red-600 whitespace-pre-wrap break-all font-sans">
                    {log.error}
                  </pre>
                </div>
              </div>
            )}

            {log.requestBody && (
              <div>
                <label className="text-sm text-muted-foreground">{t('logs.requestBody')}</label>
                <div className="mt-1">
                  <JsonViewer data={log.requestBody} />
                </div>
              </div>
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
