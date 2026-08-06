import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle2, FlaskConical, Settings2, Wrench, XCircle } from 'lucide-react'
import {
  DEFAULT_TOOL_CALLING_CONFIG,
  P0_TOOL_CLIENT_ADAPTERS,
  P0_TOOL_PROVIDER_SUPPORT,
  type ToolCallingConfig,
  type ToolCallingModeSetting,
  type ToolClientAdapterId,
} from '../../../../shared/toolCalling'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useProxyStore } from '@/stores/proxyStore'

function mergeToolCallingConfig(
  config: ToolCallingConfig,
  updates: Partial<ToolCallingConfig>,
): ToolCallingConfig {
  return {
    ...config,
    ...updates,
    advanced: {
      ...config.advanced,
      ...updates.advanced,
    },
    enabled: updates.mode === 'off' ? false : updates.enabled ?? config.enabled,
  }
}

export function ToolCallingPanel() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [smokeStatus, setSmokeStatus] = useState<'not_run' | 'running' | 'pass' | 'failed'>('not_run')
  const config = appConfig?.toolCallingConfig ?? DEFAULT_TOOL_CALLING_CONFIG
  const clientAdapters = P0_TOOL_CLIENT_ADAPTERS.filter(
    (adapter) => adapter.id === 'standard-openai-tools' || adapter.id === 'cherry-studio-mcp',
  )

  const selectedClient = useMemo(
    () => clientAdapters.find((adapter) => adapter.id === config.clientAdapterId),
    [config.clientAdapterId],
  )

  const saveConfig = (updates: Partial<ToolCallingConfig>) => {
    if (!appConfig) return
    saveAppConfig({ toolCallingConfig: mergeToolCallingConfig(config, updates) })
  }

  const runSmoke = async () => {
    setSmokeStatus('running')
    try {
      const result = await window.electronAPI?.toolCalling?.runSmoke?.({
        clientAdapterId: config.clientAdapterId,
      })
      setSmokeStatus(result?.success ? 'pass' : 'failed')
    } catch {
      setSmokeStatus('failed')
    }
  }

  const enabled = config.enabled && config.mode !== 'off'

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-primary/10 p-2">
              <Wrench className="h-5 w-5 text-primary" />
            </div>
            <div>
              <CardTitle className="text-base">{t('toolCalling.title')}</CardTitle>
              <CardDescription>{t('toolCalling.description')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert variant={enabled ? 'default' : 'destructive'}>
            {enabled ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            <AlertDescription>
              {enabled ? t('toolCalling.statusEnabled') : t('toolCalling.statusDisabled')}
            </AlertDescription>
          </Alert>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label>{t('toolCalling.clientType')}</Label>
              <Select
                value={config.clientAdapterId}
                onValueChange={(value) => saveConfig({ clientAdapterId: value as ToolClientAdapterId })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {clientAdapters.map((adapter) => (
                    <SelectItem key={adapter.id} value={adapter.id}>{adapter.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {selectedClient ? t(selectedClient.descriptionKey) : t('toolCalling.clients.unknown')}
              </p>
            </div>

            <div className="space-y-2">
              <Label>{t('toolCalling.mode')}</Label>
              <Select
                value={config.mode}
                onValueChange={(value) => saveConfig({
                  mode: value as ToolCallingModeSetting,
                  enabled: value !== 'off',
                })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="off">{t('toolCalling.modes.off')}</SelectItem>
                  <SelectItem value="auto">{t('toolCalling.modes.auto')}</SelectItem>
                  <SelectItem value="force">{t('toolCalling.modes.force')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-2">
            <Label>{t('toolCalling.providerMatrix')}</Label>
            <div className="grid gap-2 md:grid-cols-3 lg:grid-cols-5">
              {P0_TOOL_PROVIDER_SUPPORT.map((provider) => (
                <div key={provider.providerId} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{provider.label}</span>
                    <Badge variant="secondary">{t('toolCalling.supported')}</Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div>
              <Label>{t('toolCalling.smoke.title')}</Label>
              <p className="text-xs text-muted-foreground">{t('toolCalling.smoke.description')}</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant={smokeStatus === 'pass' ? 'default' : 'outline'}>
                {t(`toolCalling.smoke.${smokeStatus}`)}
              </Badge>
              <Button variant="outline" size="sm" onClick={runSmoke} disabled={smokeStatus === 'running'}>
                <FlaskConical className="mr-2 h-4 w-4" />
                {t('toolCalling.smoke.run')}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <Settings2 className="h-5 w-5 text-muted-foreground" />
              <div>
                <CardTitle className="text-base">{t('toolCalling.advanced.title')}</CardTitle>
                <CardDescription>{t('toolCalling.advanced.description')}</CardDescription>
              </div>
            </div>
            <Switch
              checked={config.diagnosticsEnabled}
              onCheckedChange={(diagnosticsEnabled) => saveConfig({ diagnosticsEnabled })}
            />
          </div>
        </CardHeader>
        {config.diagnosticsEnabled && (
          <CardContent className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <Label>{t('toolCalling.advanced.promptPreview')}</Label>
                <p className="text-xs text-muted-foreground">{t('toolCalling.advanced.promptPreviewDesc')}</p>
              </div>
              <Switch
                checked={config.advanced.promptPreviewEnabled}
                onCheckedChange={(promptPreviewEnabled) => saveConfig({ advanced: { promptPreviewEnabled } })}
              />
            </div>
            <div className="space-y-2">
              <Label>{t('toolCalling.advanced.customTemplate')}</Label>
              <Textarea
                className="min-h-[160px] font-mono text-xs"
                value={config.advanced.customPromptTemplate ?? ''}
                onChange={(event) => saveConfig({
                  advanced: { customPromptTemplate: event.target.value || undefined },
                })}
                placeholder={t('toolCalling.advanced.customTemplatePlaceholder')}
              />
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  )
}
