import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useSettingsStore, LogLevel } from '@/stores/settingsStore'
import { useToast } from '@/hooks/use-toast'
import { Database, Download, Upload, Trash2, RotateCcw, AlertTriangle } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

export function DataManagement() {
  const { t } = useTranslation()
  const { logLevel, setLogLevel, logRetentionDays, setLogRetentionDays, maxLogs, setMaxLogs } = useSettingsStore()
  const { toast } = useToast()
  const [isExporting, setIsExporting] = useState(false)
  const [isImporting, setIsImporting] = useState(false)
  const [isClearing, setIsClearing] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  const handleExportConfig = async () => {
    setIsExporting(true)
    try {
      const config = {
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        settings: localStorage.getItem('chat2api-settings'),
      }
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `chat2api-config-${new Date().toISOString().split('T')[0]}.json`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      toast({
        title: t('common.success'),
        description: t('settings.exportSuccess'),
      })
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.exportFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsExporting(false)
    }
  }

  const handleImportConfig = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return

    setIsImporting(true)
    try {
      const text = await file.text()
      const config = JSON.parse(text)
      if (config.settings) {
        localStorage.setItem('chat2api-settings', config.settings)
        toast({
          title: t('common.success'),
          description: t('settings.importSuccess'),
        })
        setTimeout(() => {
          window.location.reload()
        }, 1500)
      }
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.importFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
      event.target.value = ''
    }
  }

  const handleClearCache = async () => {
    setIsClearing(true)
    try {
      sessionStorage.clear()
      toast({
        title: t('common.success'),
        description: t('settings.cacheCleared'),
      })
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.cacheClearFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsClearing(false)
    }
  }

  const handleResetApp = async () => {
    setIsResetting(true)
    try {
      localStorage.clear()
      sessionStorage.clear()
      
      if (window.electronAPI?.store?.clearAll) {
        await window.electronAPI.store.clearAll()
      }
      
      toast({
        title: t('common.success'),
        description: t('settings.resetSuccess'),
      })
      setTimeout(() => {
        window.location.reload()
      }, 1500)
    } catch {
      toast({
        title: t('common.error'),
        description: t('settings.resetFailed'),
        variant: 'destructive',
      })
    } finally {
      setIsResetting(false)
    }
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Database className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.logSettings')}
          </CardTitle>
          <CardDescription>{t('settings.logRetentionDays')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <div className="space-y-2 p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <Label htmlFor="log-level">{t('settings.logLevel')}</Label>
              <Select value={logLevel} onValueChange={(value) => setLogLevel(value as LogLevel)}>
                <SelectTrigger id="log-level">
                  <SelectValue placeholder={t('settings.selectLogLevel')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="debug">Debug</SelectItem>
                  <SelectItem value="info">Info</SelectItem>
                  <SelectItem value="warn">Warn</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('settings.logLevelHelp')}</p>
            </div>
            <div className="space-y-2 p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <Label htmlFor="log-retention">{t('settings.logRetentionDays')}</Label>
              <Input
                id="log-retention"
                type="number"
                min={1}
                max={365}
                value={logRetentionDays}
                onChange={(e) => setLogRetentionDays(parseInt(e.target.value) || 30)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.logRetentionHelp')}</p>
            </div>
            <div className="space-y-2 p-3 rounded-xl bg-[var(--glass-bg)] border border-[var(--glass-border)]">
              <Label htmlFor="max-logs">{t('settings.maxLogs')}</Label>
              <Input
                id="max-logs"
                type="number"
                min={100}
                max={100000}
                value={maxLogs}
                onChange={(e) => setMaxLogs(parseInt(e.target.value) || 10000)}
              />
              <p className="text-xs text-muted-foreground">{t('settings.maxLogsHelp')}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-lg bg-[var(--accent-primary)]/10 flex items-center justify-center">
              <Download className="h-4 w-4 text-[var(--accent-primary)]" />
            </div>
            {t('settings.dataManagement')}
          </CardTitle>
          <CardDescription>{t('settings.dataManagementDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleExportConfig}
              disabled={isExporting}
              className="flex items-center gap-2"
            >
              <Download className="h-4 w-4" />
              {isExporting ? t('settings.exporting') : t('settings.exportConfig')}
            </Button>
            <div className="relative">
              <input
                type="file"
                accept=".json"
                onChange={handleImportConfig}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={isImporting}
              />
              <Button
                variant="outline"
                disabled={isImporting}
                className="flex items-center gap-2"
              >
                <Upload className="h-4 w-4" />
                {isImporting ? t('settings.importing') : t('settings.importConfig')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="h-5 w-5" />
            {t('settings.dangerZone')}
          </CardTitle>
          <CardDescription>{t('settings.dangerZoneDesc')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={handleClearCache}
              disabled={isClearing}
              className="flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" />
              {isClearing ? t('settings.clearing') : t('settings.clearCache')}
            </Button>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="destructive" className="flex items-center gap-2">
                  <RotateCcw className="h-4 w-4" />
                  {t('settings.resetApp')}
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t('settings.confirmReset')}</DialogTitle>
                  <DialogDescription>
                    {t('settings.confirmResetDesc')}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button variant="outline" onClick={() => {}}>
                    {t('common.cancel')}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={handleResetApp}
                    disabled={isResetting}
                  >
                    {isResetting ? t('settings.resetting') : t('settings.confirmReset')}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
