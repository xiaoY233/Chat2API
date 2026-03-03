import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ModelList } from '@/components/models'
import { ModelMappingConfig } from '@/components/proxy'
import { Database, ArrowRight, Wrench, CheckCircle2, Settings } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { useState, useEffect } from 'react'
import { useProxyStore } from '@/stores/proxyStore'
import type { ToolPromptConfig } from '@/types/electron'

function ToolPromptConfig() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [localConfig, setLocalConfig] = useState({
    mode: 'smart' as 'always' | 'smart' | 'never',
    smartThreshold: 50,
  })

  useEffect(() => {
    if (appConfig?.toolPromptConfig) {
      setLocalConfig({
        mode: appConfig.toolPromptConfig.mode,
        smartThreshold: appConfig.toolPromptConfig.smartThreshold,
      })
    }
  }, [appConfig?.toolPromptConfig])

  const handleModeChange = (mode: 'always' | 'smart' | 'never') => {
    setLocalConfig(prev => ({ ...prev, mode }))
    if (appConfig) {
      const newToolPromptConfig: ToolPromptConfig = {
        ...(appConfig.toolPromptConfig || { mode: 'smart', smartThreshold: 50, keywords: [] }),
        mode,
      }
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  const handleThresholdChange = (threshold: number) => {
    setLocalConfig(prev => ({ ...prev, smartThreshold: threshold }))
    if (appConfig) {
      const newToolPromptConfig: ToolPromptConfig = {
        ...(appConfig.toolPromptConfig || { mode: 'smart', smartThreshold: 50, keywords: [] }),
        smartThreshold: threshold,
      }
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-lg">
            <Settings className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <CardTitle className="text-base">{t('prompts.configTitle')}</CardTitle>
            <CardDescription>{t('prompts.configDescription')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('prompts.injectionMode')}</Label>
          <Select value={localConfig.mode} onValueChange={(v) => handleModeChange(v as 'always' | 'smart' | 'never')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="always">{t('prompts.modeAlways')}</SelectItem>
              <SelectItem value="smart">{t('prompts.modeSmart')}</SelectItem>
              <SelectItem value="never">{t('prompts.modeNever')}</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {localConfig.mode === 'always' && t('prompts.modeAlwaysDesc')}
            {localConfig.mode === 'smart' && t('prompts.modeSmartDesc')}
            {localConfig.mode === 'never' && t('prompts.modeNeverDesc')}
          </p>
        </div>

        {localConfig.mode === 'smart' && (
          <div className="space-y-2">
            <Label>{t('prompts.threshold')}</Label>
            <Input
              type="number"
              value={localConfig.smartThreshold}
              onChange={(e) => handleThresholdChange(parseInt(e.target.value) || 50)}
              min={10}
              max={500}
            />
            <p className="text-xs text-muted-foreground">{t('prompts.thresholdDesc')}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ToolUsePrompts() {
  const { t } = useTranslation()
  
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-purple-500/10 rounded-lg">
              <Wrench className="h-6 w-6 text-purple-500" />
            </div>
            <div>
              <CardTitle>{t('prompts.toolUseTitle')}</CardTitle>
              <CardDescription>{t('prompts.toolUseShortDesc')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{t('prompts.toolUseEnabled')}</AlertDescription>
          </Alert>
          
          <div className="mt-4 space-y-2">
            <p className="text-sm text-muted-foreground">{t('prompts.supportedModelsShort')}</p>
            <div className="flex flex-wrap gap-2">
              {['DeepSeek', 'GLM', 'Kimi', 'Qwen', 'MiniMax'].map(m => (
                <Badge key={m} variant="secondary">{m}</Badge>
              ))}
            </div>
          </div>
          
          <div className="mt-4 p-4 bg-muted/50 rounded-lg border">
            <h4 className="text-sm font-medium mb-2">{t('prompts.protocolFormat')}</h4>
            <pre className="text-xs bg-background p-3 rounded-md overflow-x-auto">
{`[function_calls]
[call:tool_name]{"arg": "value"}[/call]
[/function_calls]`}
            </pre>
          </div>
        </CardContent>
      </Card>
      
      <ToolPromptConfig />
    </div>
  )
}

export function Models() {
  const { t } = useTranslation()
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('models.title')}</h2>
        <p className="text-muted-foreground">{t('models.description')}</p>
      </div>

      <Tabs defaultValue="list" className="w-full">
        <TabsList className="grid w-full grid-cols-3 h-auto">
          <TabsTrigger value="list" className="flex items-center gap-2 py-2">
            <Database className="h-4 w-4" />
            <span className="hidden sm:inline">{t('models.modelList')}</span>
          </TabsTrigger>
          <TabsTrigger value="mapping" className="flex items-center gap-2 py-2">
            <ArrowRight className="h-4 w-4" />
            <span className="hidden sm:inline">{t('models.modelMapping')}</span>
          </TabsTrigger>
          <TabsTrigger value="prompts" className="flex items-center gap-2 py-2">
            <Wrench className="h-4 w-4" />
            <span className="hidden sm:inline">{t('models.prompts')}</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="list" className="mt-6">
          <ModelList />
        </TabsContent>

        <TabsContent value="mapping" className="mt-6">
          <ModelMappingConfig />
        </TabsContent>

        <TabsContent value="prompts" className="mt-6">
          <ToolUsePrompts />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default Models
