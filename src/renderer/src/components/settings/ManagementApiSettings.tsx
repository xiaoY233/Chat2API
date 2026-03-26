import { useState, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Key, Copy, RefreshCw, AlertTriangle, Terminal, Check, Eye, EyeOff } from 'lucide-react'

interface ManagementApiConfig {
  enableManagementApi: boolean
  managementApiSecret: string
  managementApiPort?: number
}

export function ManagementApiSettings() {
  const { t } = useTranslation()
  const [config, setConfig] = useState<ManagementApiConfig>({
    enableManagementApi: false,
    managementApiSecret: '',
  })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [isGenerating, setIsGenerating] = useState(false)
  const [showConfirmDialog, setShowConfirmDialog] = useState(false)
  const [copied, setCopied] = useState(false)
  const [proxyPort, setProxyPort] = useState<number>(8181)
  const [showSecret, setShowSecret] = useState(false) // 默认隐藏

  useEffect(() => {
    loadConfig()
  }, [])

  const loadConfig = async () => {
    try {
      const result = await window.electronAPI.invoke('managementApi:getConfig') as ManagementApiConfig
      if (result) {
        setConfig(result)
      }
      const appConfig = await window.electronAPI.config.get()
      if (appConfig?.proxyPort) {
        setProxyPort(appConfig.proxyPort)
      }
    } catch (error) {
      console.error('Failed to load management API config:', error)
    } finally {
      setIsLoading(false)
    }
  }

  const handleToggle = async (enabled: boolean) => {
    setIsSaving(true)
    try {
      await window.electronAPI.invoke('managementApi:updateConfig', {
        enableManagementApi: enabled,
      })
      setConfig(prev => ({ ...prev, enableManagementApi: enabled }))
    } catch (error) {
      console.error('Failed to update management API config:', error)
    } finally {
      setIsSaving(false)
    }
  }

  const handleCopy = async () => {
    if (!config.managementApiSecret) return
    try {
      await navigator.clipboard.writeText(config.managementApiSecret)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (error) {
      console.error('Failed to copy secret:', error)
    }
  }

  const handleGenerateNew = async () => {
    setIsGenerating(true)
    try {
      const newSecret = await window.electronAPI.invoke('managementApi:generateSecret') as string
      if (newSecret) {
        setConfig(prev => ({ ...prev, managementApiSecret: newSecret }))
      }
      setShowConfirmDialog(false)
    } catch (error) {
      console.error('Failed to generate new secret:', error)
    } finally {
      setIsGenerating(false)
    }
  }

  const maskSecret = (secret: string) => {
    if (!secret || secret.length < 12) return secret
    // 显示前 4 位和后 4 位，中间用 **** 隐藏
    return secret.slice(0, 4) + '****' + secret.slice(-4)
  }

  const apiEndpoint = `http://127.0.0.1:${config.managementApiPort || proxyPort}/v0/management`

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-6">
          <p className="text-center text-muted-foreground">{t('common.loading')}</p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {t('settings.managementApi.title')}
          </CardTitle>
          <CardDescription>{t('settings.managementApi.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label htmlFor="management-api-toggle">{t('settings.managementApi.enableToggle')}</Label>
              <p className="text-sm text-muted-foreground">{t('settings.managementApi.enableDescription')}</p>
            </div>
            <Switch
              id="management-api-toggle"
              checked={config.enableManagementApi}
              onCheckedChange={handleToggle}
              disabled={isSaving}
            />
          </div>

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{t('settings.managementApi.status')}:</span>
            {config.enableManagementApi ? (
              <span className="text-sm text-green-600 dark:text-green-400">{t('settings.managementApi.enabled')}</span>
            ) : (
              <span className="text-sm text-muted-foreground">{t('settings.managementApi.disabled')}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {config.enableManagementApi && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{t('settings.managementApi.secretKey')}</CardTitle>
              <CardDescription>{t('settings.managementApi.secretKeyDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>{t('settings.managementApi.warning')}</AlertDescription>
              </Alert>

              <div className="flex items-center gap-2">
                <Input
                  type="text"
                  value={config.managementApiSecret ? (showSecret ? config.managementApiSecret : maskSecret(config.managementApiSecret)) : t('settings.managementApi.secretKeyPlaceholder')}
                  readOnly
                  className="font-mono"
                />
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => setShowSecret(!showSecret)}
                  disabled={!config.managementApiSecret}
                  title={showSecret ? t('settings.managementApi.hideSecret') : t('settings.managementApi.showSecret')}
                >
                  {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={handleCopy}
                  disabled={!config.managementApiSecret}
                  title={t('settings.managementApi.copySecret')}
                >
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>

              <Button
                variant="outline"
                onClick={() => setShowConfirmDialog(true)}
                disabled={isGenerating}
              >
                <RefreshCw className={`h-4 w-4 mr-2 ${isGenerating ? 'animate-spin' : ''}`} />
                {t('settings.managementApi.generateNew')}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Terminal className="h-5 w-5" />
                {t('settings.managementApi.apiDocumentation')}
              </CardTitle>
              <CardDescription>{t('settings.managementApi.exampleUsage')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>{t('settings.managementApi.apiEndpoint')}</Label>
                <code className="block w-full rounded-md bg-muted p-3 text-sm font-mono break-all">
                  {apiEndpoint}
                </code>
              </div>

              <div className="space-y-2">
                <Label>curl {t('settings.managementApi.exampleUsage')}</Label>
                <pre className="block w-full rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
{`curl -X GET "${apiEndpoint}/config" \\
  -H "Authorization: Bearer YOUR_SECRET_KEY"`}
                </pre>
              </div>

              <div className="space-y-2">
                <Label>PUT {t('settings.managementApi.exampleUsage')}</Label>
                <pre className="block w-full rounded-md bg-muted p-3 text-sm font-mono overflow-x-auto whitespace-pre-wrap break-all">
{`curl -X PUT "${apiEndpoint}/config" \\
  -H "Authorization: Bearer YOUR_SECRET_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"proxyPort": 8181}'`}
                </pre>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('settings.managementApi.generateNew')}</DialogTitle>
            <DialogDescription>
              {t('settings.managementApi.generateConfirm')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleGenerateNew} disabled={isGenerating}>
              {isGenerating ? t('common.loading') : t('common.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
