import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Copy, Check, Clock, Zap, Server, User, FileJson, AlertCircle, Globe, Brain } from 'lucide-react'

interface RequestLogEntry {
  id: string
  timestamp: number
  status: 'success' | 'error'
  statusCode: number
  method: string
  url: string
  model: string
  actualModel?: string
  providerId?: string
  providerName?: string
  accountId?: string
  accountName?: string
  requestBody?: string
  userInput?: string
  webSearch?: boolean
  reasoningEffort?: 'low' | 'medium' | 'high'
  responseStatus: number
  responsePreview?: string
  responseBody?: string
  latency: number
  isStream: boolean
  errorMessage?: string
  errorStack?: string
}

interface RequestLogDetailProps {
  log: RequestLogEntry
  onClose: () => void
}

interface CopyButtonProps {
  text: string
  className?: string
}

function CopyButton({ text, className = '' }: CopyButtonProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy:', err)
    }
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      className={`h-7 px-2 text-xs gap-1.5 hover:bg-muted/80 transition-all ${className}`}
    >
      {copied ? (
        <>
          <Check className="h-3.5 w-3.5 text-green-500" />
          <span className="text-green-500">{t('common.copied')}</span>
        </>
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" />
          <span>{t('common.copy')}</span>
        </>
      )}
    </Button>
  )
}

interface SectionHeaderProps {
  title: string
  icon?: React.ReactNode
  copyText?: string
}

function SectionHeader({ title, icon, copyText }: SectionHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        {icon && <span className="text-muted-foreground">{icon}</span>}
        <label className="text-sm font-semibold text-foreground">{title}</label>
      </div>
      {copyText && <CopyButton text={copyText} />}
    </div>
  )
}

interface InfoItemProps {
  label: string
  value: React.ReactNode
  icon?: React.ReactNode
}

function InfoItem({ label, value, icon }: InfoItemProps) {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-medium break-all">{value}</div>
    </div>
  )
}

export function RequestLogDetail({ log, onClose }: RequestLogDetailProps) {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('info')

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  const formatLatency = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(2)}s`
  }

  const getStatusColor = (status: 'success' | 'error') => {
    return status === 'success'
      ? 'bg-green-500/10 text-green-600 border-green-500/20 hover:bg-green-500/20'
      : 'bg-red-500/10 text-red-600 border-red-500/20 hover:bg-red-500/20'
  }

  const renderJsonViewer = (jsonString: string | undefined) => {
    if (!jsonString) return (
      <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
        <FileJson className="h-12 w-12 mb-3 opacity-30" />
        <p className="text-sm">{t('logs.noRequestData')}</p>
      </div>
    )

    try {
      const parsed = JSON.parse(jsonString)
      const formatted = JSON.stringify(parsed, null, 2)
      return (
        <pre className="text-xs bg-muted/50 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-border/50">
          {formatted}
        </pre>
      )
    } catch {
      return (
        <pre className="text-xs bg-muted/50 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-border/50">
          {jsonString}
        </pre>
      )
    }
  }

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl w-[90vw] h-[85vh] max-h-[800px] p-0 flex flex-col overflow-hidden bg-background/95 backdrop-blur-sm">
        {/* Header */}
        <DialogHeader className="px-6 pt-6 pb-4 shrink-0 border-b border-border/50">
          <DialogTitle className="flex items-center gap-3 flex-wrap text-base">
            <Badge 
              variant="outline" 
              className={`${getStatusColor(log.status)} font-semibold px-2.5 py-0.5`}
            >
              {log.statusCode}
            </Badge>
            <span className="break-all font-mono text-sm">{log.model}</span>
            {log.actualModel && log.actualModel !== log.model && (
              <span className="text-sm text-muted-foreground font-normal break-all">
                → {log.actualModel}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <div className="px-6 pt-4 shrink-0 overflow-hidden">
            <TabsList className="grid w-full grid-cols-5 bg-muted/50 p-1 rounded-lg">
              <TabsTrigger
                value="info"
                className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md transition-all"
              >
                <FileJson className="h-3.5 w-3.5 mr-1.5" />
                {t('logs.tabInfo')}
              </TabsTrigger>
              <TabsTrigger
                value="request"
                className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md transition-all"
              >
                <Server className="h-3.5 w-3.5 mr-1.5" />
                {t('logs.tabRequest')}
              </TabsTrigger>
              <TabsTrigger
                value="response"
                className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md transition-all"
              >
                <FileJson className="h-3.5 w-3.5 mr-1.5" />
                {t('logs.tabResponse')}
              </TabsTrigger>
              <TabsTrigger
                value="user"
                className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md transition-all"
              >
                <User className="h-3.5 w-3.5 mr-1.5" />
                {t('logs.tabUserInput')}
              </TabsTrigger>
              <TabsTrigger
                value="error"
                className="text-xs data-[state=active]:bg-background data-[state=active]:shadow-sm rounded-md transition-all"
              >
                <AlertCircle className="h-3.5 w-3.5 mr-1.5" />
                {t('logs.tabError')}
              </TabsTrigger>
            </TabsList>
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-0 px-6 py-4 overflow-y-auto">
            {/* Info Tab */}
            <TabsContent value="info" className="mt-0">
              <div className="grid grid-cols-2 gap-3">
                <InfoItem 
                  label={t('logs.timestamp')} 
                  value={formatTime(log.timestamp)}
                  icon={<Clock className="h-3 w-3" />}
                />
                <InfoItem 
                  label={t('logs.latency')} 
                  value={formatLatency(log.latency)}
                  icon={<Zap className="h-3 w-3" />}
                />
                <InfoItem 
                  label={t('logs.method')} 
                  value={<span className="font-mono text-xs bg-muted px-2 py-0.5 rounded">{log.method}</span>}
                />
                <InfoItem 
                  label={t('logs.url')} 
                  value={<span className="font-mono text-xs break-all">{log.url}</span>}
                />
                <InfoItem 
                  label={t('logs.provider')} 
                  value={log.providerName || log.providerId || '-'}
                />
                <InfoItem 
                  label={t('logs.account')} 
                  value={log.accountName || log.accountId || '-'}
                />
                <InfoItem 
                  label={t('logs.stream')} 
                  value={log.isStream ? t('common.yes') : t('common.no')}
                />
                <InfoItem 
                  label={t('logs.responseStatus')} 
                  value={log.responseStatus}
                />
                <InfoItem 
                  label={t('logs.webSearch')} 
                  value={log.webSearch ? t('common.enabled') : t('common.disabled')}
                  icon={<Globe className="h-3 w-3" />}
                />
                <InfoItem 
                  label={t('logs.reasoningEffort')} 
                  value={log.reasoningEffort || '-'}
                  icon={<Brain className="h-3 w-3" />}
                />
              </div>
            </TabsContent>

            {/* Request Tab */}
            <TabsContent value="request" className="mt-0">
              <SectionHeader
                title={t('logs.requestBody')}
                icon={<FileJson className="h-4 w-4" />}
                copyText={log.requestBody || ''}
              />
              {renderJsonViewer(log.requestBody)}
            </TabsContent>

            {/* Response Tab */}
            <TabsContent value="response" className="mt-0">
              <SectionHeader
                title={t('logs.responseBody')}
                icon={<FileJson className="h-4 w-4" />}
                copyText={log.responseBody || ''}
              />
              {renderJsonViewer(log.responseBody)}
            </TabsContent>

            {/* User Input Tab */}
            <TabsContent value="user" className="mt-0">
              {log.userInput ? (
                <div>
                  <SectionHeader 
                    title={t('logs.userInput')} 
                    icon={<User className="h-4 w-4" />}
                    copyText={log.userInput}
                  />
                  <div className="p-4 bg-muted/30 rounded-lg border border-border/50">
                    <pre className="text-sm whitespace-pre-wrap break-all font-sans leading-relaxed">
                      {log.userInput}
                    </pre>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <User className="h-12 w-12 mb-3 opacity-30" />
                  <p className="text-sm">{t('logs.noUserInput')}</p>
                </div>
              )}
            </TabsContent>

            {/* Error Tab */}
            <TabsContent value="error" className="mt-0">
              {log.errorMessage ? (
                <div className="space-y-4">
                  {/* Error Message */}
                  <div>
                    <SectionHeader 
                      title={t('logs.errorMessage')} 
                      icon={<AlertCircle className="h-4 w-4 text-red-500" />}
                      copyText={log.errorMessage}
                    />
                    <div className="p-4 bg-red-500/5 border border-red-500/20 rounded-lg">
                      <pre className="text-sm text-red-600 font-medium whitespace-pre-wrap break-all font-sans leading-relaxed">
                        {log.errorMessage}
                      </pre>
                    </div>
                  </div>

                  {/* Stack Trace */}
                  {log.errorStack && (
                    <div>
                      <SectionHeader 
                        title={t('logs.stackTrace')} 
                        icon={<FileJson className="h-4 w-4" />}
                        copyText={log.errorStack}
                      />
                      <pre className="text-xs bg-muted/50 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap break-all border border-border/50 font-mono leading-relaxed">
                        {log.errorStack}
                      </pre>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <AlertCircle className="h-12 w-12 mb-3 opacity-30" />
                  <p className="text-sm">{t('logs.noError')}</p>
                </div>
              )}
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
