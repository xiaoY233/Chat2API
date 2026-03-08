import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ModelList } from '@/components/models'
import { ModelMappingConfig } from '@/components/proxy'
import { 
  Database, ArrowRight, Wrench, CheckCircle2, Settings, Shield, Info, 
  Code, Zap, Users, Layers
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { useState, useEffect } from 'react'
import { useProxyStore } from '@/stores/proxyStore'
import type { ToolPromptConfig } from '@/types/electron'

type InjectionMode = 'always' | 'smart' | 'never' | 'auto'

interface ExtendedToolPromptConfig {
  mode: InjectionMode
  smartThreshold: number
  keywords: string[]
  clientDetection: boolean
  skipKnownClients: string[]
}

const SUPPORTED_MODELS = ['DeepSeek', 'GLM', 'Kimi', 'Qwen', 'MiniMax', 'Z.ai']

const KNOWN_CLIENTS = [
  { id: 'cline', name: 'Cline', desc: 'VS Code AI coding assistant' },
  { id: 'kilocode', name: 'Kilocode', desc: 'AI-powered code editor' },
  { id: 'rooCode', name: 'Roo-Code', desc: 'VS Code extension' },
  { id: 'vscodeCopilot', name: 'VSCode Copilot', desc: 'GitHub Copilot in VS Code' },
  { id: 'cherryStudio', name: 'Cherry Studio', desc: 'Desktop AI client' },
]

const PROMPT_VARIANTS = [
  { id: 'auto', name: 'autoSelect', desc: 'autoSelectDesc', models: ['All models'] },
  { id: 'default', name: 'variantDefault', desc: 'variantDefaultDesc', models: ['All models'] },
  { id: 'qwen', name: 'variantQwen', desc: 'variantQwenDesc', models: ['qwen', 'tongyi', 'dashscope'] },
  { id: 'deepseek', name: 'variantDeepSeek', desc: 'variantDeepSeekDesc', models: ['deepseek'] },
  { id: 'glm', name: 'variantGLM', desc: 'variantGLMDesc', models: ['glm', 'chatglm'] },
]

function ToolUseOverview() {
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState('bracket')

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-purple-500/10 rounded-lg">
            <Wrench className="h-5 w-5 text-purple-500" />
          </div>
          <div>
            <CardTitle className="text-base">{t('prompts.overviewTitle')}</CardTitle>
            <CardDescription>{t('prompts.overviewDesc')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertDescription>{t('prompts.toolUseEnabled')}</AlertDescription>
        </Alert>

        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" />
            {t('prompts.supportedModels')}
          </Label>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_MODELS.map(m => (
              <Badge key={m} variant="secondary">{m}</Badge>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Code className="h-4 w-4 text-muted-foreground" />
            {t('prompts.protocolFormat')}
          </Label>
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="bracket">{t('prompts.bracketFormat')}</TabsTrigger>
              <TabsTrigger value="xml">{t('prompts.xmlFormat')}</TabsTrigger>
            </TabsList>
            <TabsContent value="bracket" className="mt-2">
              <div className="p-3 bg-muted/50 rounded-lg border">
                <p className="text-xs text-muted-foreground mb-2">{t('prompts.bracketFormatDesc')}</p>
                <pre className="text-xs bg-background p-3 rounded-md overflow-x-auto">
{`[function_calls]
[call:tool_name]{"arg": "value"}[/call]
[/function_calls]`}
                </pre>
              </div>
            </TabsContent>
            <TabsContent value="xml" className="mt-2">
              <div className="p-3 bg-muted/50 rounded-lg border">
                <p className="text-xs text-muted-foreground mb-2">{t('prompts.xmlFormatDesc')}</p>
                <pre className="text-xs bg-background p-3 rounded-md overflow-x-auto">
{`<tool_use>
  <name>tool_name</name>
  <arguments>{"arg": "value"}</arguments>
</tool_use>`}
                </pre>
              </div>
            </TabsContent>
          </Tabs>
        </div>
      </CardContent>
    </Card>
  )
}

function InjectionConfigCard() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [localConfig, setLocalConfig] = useState<ExtendedToolPromptConfig>({
    mode: 'smart',
    smartThreshold: 50,
    keywords: [],
    clientDetection: true,
    skipKnownClients: ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
  })

  useEffect(() => {
    if (appConfig?.toolPromptConfig) {
      setLocalConfig({
        mode: appConfig.toolPromptConfig.mode || 'smart',
        smartThreshold: appConfig.toolPromptConfig.smartThreshold || 50,
        keywords: appConfig.toolPromptConfig.keywords || [],
        clientDetection: appConfig.toolPromptConfig.clientDetection ?? true,
        skipKnownClients: appConfig.toolPromptConfig.skipKnownClients || ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
      })
    }
  }, [appConfig?.toolPromptConfig])

  const handleModeChange = (mode: InjectionMode) => {
    setLocalConfig(prev => ({ ...prev, mode }))
    if (appConfig) {
      const newToolPromptConfig: ToolPromptConfig = {
        ...(appConfig.toolPromptConfig || { mode: 'smart', smartThreshold: 50, keywords: [], clientDetection: true, skipKnownClients: [] }),
        mode,
      }
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  const handleThresholdChange = (threshold: number) => {
    setLocalConfig(prev => ({ ...prev, smartThreshold: threshold }))
    if (appConfig) {
      const newToolPromptConfig: ToolPromptConfig = {
        ...(appConfig.toolPromptConfig || { mode: 'smart', smartThreshold: 50, keywords: [], clientDetection: true, skipKnownClients: [] }),
        smartThreshold: threshold,
      }
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  const getModeDescription = (mode: InjectionMode): string => {
    const descriptions: Record<InjectionMode, string> = {
      auto: t('prompts.modeAutoDesc'),
      smart: t('prompts.modeSmartDesc'),
      always: t('prompts.modeAlwaysDesc'),
      never: t('prompts.modeNeverDesc'),
    }
    return descriptions[mode]
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-blue-500/10 rounded-lg">
            <Settings className="h-5 w-5 text-blue-500" />
          </div>
          <div>
            <CardTitle className="text-base">{t('prompts.injectionConfig')}</CardTitle>
            <CardDescription>{t('prompts.configDescription')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('prompts.injectionMode')}</Label>
          <Select value={localConfig.mode} onValueChange={(v) => handleModeChange(v as InjectionMode)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['auto', 'smart', 'always', 'never'] as InjectionMode[]).map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {t(`prompts.mode${mode.charAt(0).toUpperCase() + mode.slice(1)}` as any)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex items-start gap-2 p-3 bg-muted/50 rounded-lg">
            <Info className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
            <p className="text-sm text-muted-foreground">
              {getModeDescription(localConfig.mode)}
            </p>
          </div>
        </div>

        {localConfig.mode === 'smart' && (
          <div className="space-y-4 pt-4 border-t">
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
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function ClientDetectionCard() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [localConfig, setLocalConfig] = useState<ExtendedToolPromptConfig>({
    mode: 'smart',
    smartThreshold: 50,
    keywords: [],
    clientDetection: true,
    skipKnownClients: ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
  })

  useEffect(() => {
    if (appConfig?.toolPromptConfig) {
      setLocalConfig({
        mode: appConfig.toolPromptConfig.mode || 'smart',
        smartThreshold: appConfig.toolPromptConfig.smartThreshold || 50,
        keywords: appConfig.toolPromptConfig.keywords || [],
        clientDetection: appConfig.toolPromptConfig.clientDetection ?? true,
        skipKnownClients: appConfig.toolPromptConfig.skipKnownClients || ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
      })
    }
  }, [appConfig?.toolPromptConfig])

  const handleClientDetectionChange = (enabled: boolean) => {
    setLocalConfig(prev => ({ ...prev, clientDetection: enabled }))
    if (appConfig) {
      const newToolPromptConfig: ToolPromptConfig = {
        ...(appConfig.toolPromptConfig || { mode: 'smart', smartThreshold: 50, keywords: [], clientDetection: true, skipKnownClients: [] }),
        clientDetection: enabled,
      }
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  const handleSkipClientToggle = (clientId: string) => {
    const newSkipClients = localConfig.skipKnownClients.includes(clientId)
      ? localConfig.skipKnownClients.filter(c => c !== clientId)
      : [...localConfig.skipKnownClients, clientId]
    
    setLocalConfig(prev => ({ ...prev, skipKnownClients: newSkipClients }))
    if (appConfig) {
      const newToolPromptConfig: ToolPromptConfig = {
        ...(appConfig.toolPromptConfig || { mode: 'smart', smartThreshold: 50, keywords: [], clientDetection: true, skipKnownClients: [] }),
        skipKnownClients: newSkipClients,
      }
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-green-500/10 rounded-lg">
              <Shield className="h-5 w-5 text-green-500" />
            </div>
            <div>
              <CardTitle className="text-base">{t('prompts.clientDetectionTitle')}</CardTitle>
              <CardDescription>{t('prompts.clientDetectionDesc')}</CardDescription>
            </div>
          </div>
          <Switch
            checked={localConfig.clientDetection}
            onCheckedChange={handleClientDetectionChange}
          />
        </div>
      </CardHeader>
      {localConfig.clientDetection && (
        <CardContent>
          <div className="space-y-2">
            <Label className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              {t('prompts.supportedClients')}
            </Label>
            <div className="grid gap-2">
              {KNOWN_CLIENTS.map(client => (
                <div 
                  key={client.id} 
                  className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 transition-colors"
                >
                  <div className="flex-1">
                    <div className="font-medium text-sm">{client.name}</div>
                    <div className="text-xs text-muted-foreground">{client.desc}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{t('prompts.skipInjection')}</span>
                    <Switch
                      checked={localConfig.skipKnownClients.includes(client.id)}
                      onCheckedChange={() => handleSkipClientToggle(client.id)}
                    />
                  </div>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{t('prompts.skipInjectionHint')}</p>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function PromptVariantCard() {
  const { t } = useTranslation()
  const [selectedVariant, setSelectedVariant] = useState('auto')

  const currentVariant = PROMPT_VARIANTS.find(v => v.id === selectedVariant) || PROMPT_VARIANTS[0]

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-orange-500/10 rounded-lg">
            <Layers className="h-5 w-5 text-orange-500" />
          </div>
          <div>
            <CardTitle className="text-base">{t('prompts.variantTitle')}</CardTitle>
            <CardDescription>{t('prompts.variantDesc')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label>{t('prompts.currentVariant')}</Label>
          <Select value={selectedVariant} onValueChange={setSelectedVariant}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROMPT_VARIANTS.map(variant => (
                <SelectItem key={variant.id} value={variant.id}>
                  {t(`prompts.${variant.name}` as any)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="p-4 bg-muted/50 rounded-lg border">
          <h4 className="text-sm font-medium">{t(`prompts.${currentVariant.name}` as any)}</h4>
          <p className="text-xs text-muted-foreground mt-1">{t(`prompts.${currentVariant.desc}` as any)}</p>
          <div className="mt-3">
            <Label className="text-xs text-muted-foreground">{t('prompts.applicableModels')}</Label>
            <div className="flex flex-wrap gap-1 mt-1">
              {currentVariant.models.map(m => (
                <Badge key={m} variant="outline" className="text-xs">{m}</Badge>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function ToolUsePrompts() {
  return (
    <div className="space-y-6">
      <ToolUseOverview />
      <InjectionConfigCard />
      <ClientDetectionCard />
      <PromptVariantCard />
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
