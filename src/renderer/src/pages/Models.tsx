import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ModelList } from '@/components/models'
import { ModelMappingConfig } from '@/components/proxy'
import { 
  Database, ArrowRight, Wrench, CheckCircle2, Settings, Info,
  Code, XCircle, HelpCircle
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProxyStore } from '@/stores/proxyStore'

type InjectionMode = 'auto' | 'always' | 'never'
type ProtocolFormat = 'bracket' | 'xml'

interface ExtendedToolPromptConfig {
  mode: InjectionMode
  defaultFormat: ProtocolFormat
  customPromptTemplate?: string
  enableToolCallParsing: boolean
}

const SUPPORTED_CLIENTS = [
  { id: 'cline', name: 'Cline' },
  { id: 'rooCode', name: 'RooCode' },
  { id: 'claudeCode', name: 'Claude Code' },
  { id: 'cherryStudio', name: 'Cherry Studio' },
  { id: 'kilocode', name: 'Kilocode' },
  { id: 'codexCli', name: 'Codex CLI' },
  { id: 'vscodeAgent', name: 'VSCode Agent' },
]

const DEFAULT_TOOL_PROMPT_CONFIG: ExtendedToolPromptConfig = {
  mode: 'auto',
  defaultFormat: 'bracket',
  customPromptTemplate: undefined,
  enableToolCallParsing: true,
}

function ToolUseOverview() {
  const { t } = useTranslation()
  const { appConfig } = useProxyStore()

  const isToolUseEnabled = appConfig?.toolPromptConfig?.mode !== 'never'

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
        {isToolUseEnabled ? (
          <Alert>
            <CheckCircle2 className="h-4 w-4" />
            <AlertDescription>{t('prompts.toolUseEnabled')}</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <XCircle className="h-4 w-4" />
            <AlertDescription>{t('prompts.toolUseDisabled')}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-2">
          <Label className="text-sm text-muted-foreground">{t('prompts.supportedClientsLabel')}</Label>
          <div className="flex flex-wrap gap-1.5">
            {SUPPORTED_CLIENTS.map(client => (
              <Badge key={client.id} variant="outline" className="text-xs">
                {client.name}
              </Badge>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function InjectionConfigCard() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [localConfig, setLocalConfig] = useState<ExtendedToolPromptConfig>(DEFAULT_TOOL_PROMPT_CONFIG)

  useEffect(() => {
    if (appConfig?.toolPromptConfig) {
      setLocalConfig({
        mode: (appConfig.toolPromptConfig.mode as InjectionMode) || DEFAULT_TOOL_PROMPT_CONFIG.mode,
        defaultFormat: (appConfig.toolPromptConfig.defaultFormat as ProtocolFormat) || DEFAULT_TOOL_PROMPT_CONFIG.defaultFormat,
        customPromptTemplate: appConfig.toolPromptConfig.customPromptTemplate,
        enableToolCallParsing: appConfig.toolPromptConfig.enableToolCallParsing ?? DEFAULT_TOOL_PROMPT_CONFIG.enableToolCallParsing,
      })
    }
  }, [appConfig?.toolPromptConfig])

  const buildToolPromptConfig = useCallback((updates: Partial<ExtendedToolPromptConfig>) => {
    const currentConfig = appConfig?.toolPromptConfig || DEFAULT_TOOL_PROMPT_CONFIG
    return {
      mode: updates.mode ?? currentConfig.mode,
      defaultFormat: updates.defaultFormat ?? currentConfig.defaultFormat,
      customPromptTemplate: updates.customPromptTemplate ?? currentConfig.customPromptTemplate,
      enableToolCallParsing: updates.enableToolCallParsing ?? currentConfig.enableToolCallParsing,
    }
  }, [appConfig?.toolPromptConfig])

  const handleModeChange = (mode: InjectionMode) => {
    setLocalConfig(prev => ({ ...prev, mode }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ mode }) })
    }
  }

  const handleFormatChange = (defaultFormat: ProtocolFormat) => {
    setLocalConfig(prev => ({ ...prev, defaultFormat }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ defaultFormat }) })
    }
  }

  const handleEnableParsingChange = (enableToolCallParsing: boolean) => {
    setLocalConfig(prev => ({ ...prev, enableToolCallParsing }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ enableToolCallParsing }) })
    }
  }

  const getModeDescription = (mode: InjectionMode): string => {
    const descriptions: Record<InjectionMode, string> = {
      auto: t('prompts.modeAutoDesc'),
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
              {(['auto', 'always', 'never'] as InjectionMode[]).map((mode) => (
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

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label>{t('prompts.protocolFormat')}</Label>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" align="start" className="max-w-xs z-50">
                  <p className="text-xs">{t('prompts.protocolFormatTooltip')}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Select value={localConfig.defaultFormat} onValueChange={(v) => handleFormatChange(v as ProtocolFormat)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bracket">{t('prompts.bracketFormat')}</SelectItem>
              <SelectItem value="xml">{t('prompts.xmlFormat')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label>{t('prompts.enableToolCallParsing')}</Label>
            <p className="text-xs text-muted-foreground">{t('prompts.enableToolCallParsingDesc')}</p>
          </div>
          <Switch
            checked={localConfig.enableToolCallParsing}
            onCheckedChange={handleEnableParsingChange}
          />
        </div>
      </CardContent>
    </Card>
  )
}

function PromptTemplateCard() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [localConfig, setLocalConfig] = useState<ExtendedToolPromptConfig>(DEFAULT_TOOL_PROMPT_CONFIG)

  useEffect(() => {
    if (appConfig?.toolPromptConfig) {
      setLocalConfig({
        mode: (appConfig.toolPromptConfig.mode as InjectionMode) || DEFAULT_TOOL_PROMPT_CONFIG.mode,
        defaultFormat: (appConfig.toolPromptConfig.defaultFormat as ProtocolFormat) || DEFAULT_TOOL_PROMPT_CONFIG.defaultFormat,
        customPromptTemplate: appConfig.toolPromptConfig.customPromptTemplate,
        enableToolCallParsing: appConfig.toolPromptConfig.enableToolCallParsing ?? DEFAULT_TOOL_PROMPT_CONFIG.enableToolCallParsing,
      })
    }
  }, [appConfig?.toolPromptConfig])

  const buildToolPromptConfig = useCallback((updates: Partial<ExtendedToolPromptConfig>) => {
    const currentConfig = appConfig?.toolPromptConfig || DEFAULT_TOOL_PROMPT_CONFIG
    return {
      mode: updates.mode ?? currentConfig.mode,
      defaultFormat: updates.defaultFormat ?? currentConfig.defaultFormat,
      customPromptTemplate: updates.customPromptTemplate ?? currentConfig.customPromptTemplate,
      enableToolCallParsing: updates.enableToolCallParsing ?? currentConfig.enableToolCallParsing,
    }
  }, [appConfig?.toolPromptConfig])

  const handleCustomTemplateChange = (customPromptTemplate: string) => {
    setLocalConfig(prev => ({ ...prev, customPromptTemplate }))
  }

  const handleSaveCustomTemplate = () => {
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ customPromptTemplate: localConfig.customPromptTemplate || undefined }) })
    }
  }

  const handleClearCustomTemplate = () => {
    setLocalConfig(prev => ({ ...prev, customPromptTemplate: undefined }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ customPromptTemplate: undefined }) })
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-green-500/10 rounded-lg">
            <Code className="h-5 w-5 text-green-500" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <CardTitle className="text-base">{t('prompts.promptTemplate')}</CardTitle>
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <HelpCircle className="h-4 w-4 text-muted-foreground cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent side="right" align="start" className="max-w-sm z-50">
                    <p className="text-xs">{t('prompts.promptTemplateTooltip')}</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
            <CardDescription>{t('prompts.promptTemplateDesc')}</CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{t('prompts.customTemplateDesc')}</p>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={handleClearCustomTemplate}>
              {t('common.reset')}
            </Button>
            <Button variant="outline" size="sm" onClick={handleSaveCustomTemplate}>
              {t('common.save')}
            </Button>
          </div>
        </div>
        <Textarea
          value={localConfig.customPromptTemplate || ''}
          onChange={(e) => handleCustomTemplateChange(e.target.value)}
          placeholder={t('prompts.customTemplatePlaceholder')}
          className="font-mono text-xs min-h-[200px]"
        />
      </CardContent>
    </Card>
  )
}

function ToolUsePrompts() {
  return (
    <div className="space-y-6">
      <ToolUseOverview />
      <InjectionConfigCard />
      <PromptTemplateCard />
    </div>
  )
}

export function Models() {
  const { t } = useTranslation()
  const { fetchAppConfig } = useProxyStore()
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab')
  const [activeTab, setActiveTab] = useState(tabFromUrl || 'list')
  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (hasLoadedRef.current) return
    hasLoadedRef.current = true
    
    fetchAppConfig()
  }, [fetchAppConfig])

  useEffect(() => {
    if (tabFromUrl && ['list', 'mapping', 'prompts'].includes(tabFromUrl)) {
      setActiveTab(tabFromUrl)
    }
  }, [tabFromUrl])

  const handleTabChange = (value: string) => {
    setActiveTab(value)
    setSearchParams({ tab: value })
  }
  
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">{t('models.title')}</h2>
        <p className="text-muted-foreground">{t('models.description')}</p>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="w-full">
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
