import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ModelList } from '@/components/models'
import { ModelMappingConfig } from '@/components/proxy'
import { 
  Database, ArrowRight, Wrench, CheckCircle2, Settings, Shield, Info, 
  Code, Zap, Users, Layers, XCircle, Eye, Edit2
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Input } from '@/components/ui/input'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useState, useEffect, useCallback, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useProxyStore } from '@/stores/proxyStore'
import type { ToolPromptConfig } from '@/types/electron'

type InjectionMode = 'always' | 'smart' | 'never' | 'auto'
type ClientInjectionBehavior = 'skip' | 'replace' | 'append'

interface ExtendedToolPromptConfig {
  mode: InjectionMode
  smartThreshold: number
  keywords: string[]
  clientDetection: boolean
  skipKnownClients: string[]
  protocolFormat: 'bracket' | 'xml'
  preferredVariant?: string
  clientInjectionBehavior: ClientInjectionBehavior
}

const SUPPORTED_PROVIDERS = ['DeepSeek', 'GLM', 'Kimi', 'Qwen', 'Qwen-AI', 'MiniMax', 'Z.ai', 'Perplexity']

const KNOWN_CLIENTS = [
  { id: 'cline', name: 'Cline', desc: 'VS Code AI coding assistant' },
  { id: 'kilocode', name: 'Kilocode', desc: 'AI-powered code editor' },
  { id: 'rooCode', name: 'Roo-Code', desc: 'VS Code extension' },
  { id: 'vscodeCopilot', name: 'VSCode Copilot', desc: 'GitHub Copilot in VS Code' },
  { id: 'cherryStudio', name: 'Cherry Studio', desc: 'Desktop AI client' },
]

const PROMPT_VARIANTS = [
  { id: 'auto', name: 'autoSelect', desc: 'autoSelectDesc', providers: ['All providers'] },
  { id: 'default', name: 'variantDefault', desc: 'variantDefaultDesc', providers: ['All providers'] },
  { id: 'qwen', name: 'variantQwen', desc: 'variantQwenDesc', providers: ['qwen', 'qwen-ai'] },
  { id: 'deepseek', name: 'variantDeepSeek', desc: 'variantDeepSeekDesc', providers: ['deepseek'] },
  { id: 'glm', name: 'variantGLM', desc: 'variantGLMDesc', providers: ['glm'] },
  { id: 'perplexity', name: 'variantPerplexity', desc: 'variantPerplexityDesc', providers: ['perplexity'] },
]

const DEFAULT_TOOL_PROMPT_CONFIG: ExtendedToolPromptConfig = {
  mode: 'smart',
  smartThreshold: 50,
  keywords: ['search', 'find', 'get', 'call', 'use', 'tool', 'query', 'fetch', 'read', 'write', 'list', 'delete', 'update', 'create'],
  clientDetection: true,
  skipKnownClients: ['cline', 'kilocode', 'rooCode', 'vscodeCopilot', 'cherryStudio'],
  protocolFormat: 'bracket',
  clientInjectionBehavior: 'skip',
}

function ToolUseOverview() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [localProtocolFormat, setLocalProtocolFormat] = useState<'bracket' | 'xml'>('bracket')

  const isToolUseEnabled = appConfig?.toolPromptConfig?.mode !== 'never'

  useEffect(() => {
    if (appConfig?.toolPromptConfig?.protocolFormat) {
      setLocalProtocolFormat(appConfig.toolPromptConfig.protocolFormat)
    }
  }, [appConfig?.toolPromptConfig?.protocolFormat])

  const handleProtocolFormatChange = (format: 'bracket' | 'xml') => {
    setLocalProtocolFormat(format)
    if (appConfig?.toolPromptConfig) {
      saveAppConfig({
        toolPromptConfig: {
          ...appConfig.toolPromptConfig,
          protocolFormat: format,
        },
      })
    }
  }

  const bracketFormatExample = `[function_calls]
[call:tool_name]{"arg": "value"}[/call]
[/function_calls]`

  const xmlFormatExample = `<tool_use>
  <name>tool_name</name>
  <arguments>{"arg": "value"}</arguments>
</tool_use>`

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
          <Label className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-muted-foreground" />
            {t('prompts.supportedProviders')}
          </Label>
          <div className="flex flex-wrap gap-2">
            {SUPPORTED_PROVIDERS.map(m => (
              <Badge key={m} variant="secondary">{m}</Badge>
            ))}
          </div>
        </div>

        <div className="space-y-2">
          <Label className="flex items-center gap-2">
            <Code className="h-4 w-4 text-muted-foreground" />
            {t('prompts.protocolFormat')}
          </Label>
          <Select value={localProtocolFormat} onValueChange={(v) => handleProtocolFormatChange(v as 'bracket' | 'xml')}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bracket">{t('prompts.bracketFormat')}</SelectItem>
              <SelectItem value="xml">{t('prompts.xmlFormat')}</SelectItem>
            </SelectContent>
          </Select>
          <div className="p-3 bg-muted/50 rounded-lg border">
            <p className="text-xs text-muted-foreground mb-2">
              {localProtocolFormat === 'bracket' ? t('prompts.bracketFormatDesc') : t('prompts.xmlFormatDesc')}
            </p>
            <pre className="text-xs bg-background p-3 rounded-md overflow-x-auto">
              {localProtocolFormat === 'bracket' ? bracketFormatExample : xmlFormatExample}
            </pre>
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
        mode: appConfig.toolPromptConfig.mode || DEFAULT_TOOL_PROMPT_CONFIG.mode,
        smartThreshold: appConfig.toolPromptConfig.smartThreshold || DEFAULT_TOOL_PROMPT_CONFIG.smartThreshold,
        keywords: appConfig.toolPromptConfig.keywords || DEFAULT_TOOL_PROMPT_CONFIG.keywords,
        clientDetection: appConfig.toolPromptConfig.clientDetection ?? DEFAULT_TOOL_PROMPT_CONFIG.clientDetection,
        skipKnownClients: appConfig.toolPromptConfig.skipKnownClients || DEFAULT_TOOL_PROMPT_CONFIG.skipKnownClients,
        protocolFormat: appConfig.toolPromptConfig.protocolFormat || DEFAULT_TOOL_PROMPT_CONFIG.protocolFormat,
        clientInjectionBehavior: appConfig.toolPromptConfig.clientInjectionBehavior ?? DEFAULT_TOOL_PROMPT_CONFIG.clientInjectionBehavior,
      })
    }
  }, [appConfig?.toolPromptConfig])

  const buildToolPromptConfig = useCallback((updates: Partial<ExtendedToolPromptConfig>): ToolPromptConfig => {
    const currentConfig = appConfig?.toolPromptConfig || DEFAULT_TOOL_PROMPT_CONFIG
    return {
      mode: updates.mode ?? currentConfig.mode,
      smartThreshold: updates.smartThreshold ?? currentConfig.smartThreshold,
      keywords: updates.keywords ?? currentConfig.keywords,
      clientDetection: updates.clientDetection ?? currentConfig.clientDetection,
      skipKnownClients: updates.skipKnownClients ?? currentConfig.skipKnownClients,
      protocolFormat: updates.protocolFormat ?? currentConfig.protocolFormat,
      clientInjectionBehavior: updates.clientInjectionBehavior ?? currentConfig.clientInjectionBehavior,
    }
  }, [appConfig?.toolPromptConfig])

  const handleModeChange = (mode: InjectionMode) => {
    setLocalConfig(prev => ({ ...prev, mode }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ mode }) })
    }
  }

  const handleThresholdChange = (threshold: number) => {
    setLocalConfig(prev => ({ ...prev, smartThreshold: threshold }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ smartThreshold: threshold }) })
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
  const [localConfig, setLocalConfig] = useState<ExtendedToolPromptConfig>(DEFAULT_TOOL_PROMPT_CONFIG)

  useEffect(() => {
    if (appConfig?.toolPromptConfig) {
      setLocalConfig({
        mode: appConfig.toolPromptConfig.mode || DEFAULT_TOOL_PROMPT_CONFIG.mode,
        smartThreshold: appConfig.toolPromptConfig.smartThreshold || DEFAULT_TOOL_PROMPT_CONFIG.smartThreshold,
        keywords: appConfig.toolPromptConfig.keywords || DEFAULT_TOOL_PROMPT_CONFIG.keywords,
        clientDetection: appConfig.toolPromptConfig.clientDetection ?? DEFAULT_TOOL_PROMPT_CONFIG.clientDetection,
        skipKnownClients: appConfig.toolPromptConfig.skipKnownClients || DEFAULT_TOOL_PROMPT_CONFIG.skipKnownClients,
        protocolFormat: appConfig.toolPromptConfig.protocolFormat || DEFAULT_TOOL_PROMPT_CONFIG.protocolFormat,
        clientInjectionBehavior: appConfig.toolPromptConfig.clientInjectionBehavior || DEFAULT_TOOL_PROMPT_CONFIG.clientInjectionBehavior,
      })
    }
  }, [appConfig?.toolPromptConfig])

  const buildToolPromptConfig = useCallback((updates: Partial<ExtendedToolPromptConfig>): ToolPromptConfig => {
    const currentConfig = appConfig?.toolPromptConfig || DEFAULT_TOOL_PROMPT_CONFIG
    return {
      mode: updates.mode ?? currentConfig.mode,
      smartThreshold: updates.smartThreshold ?? currentConfig.smartThreshold,
      keywords: updates.keywords ?? currentConfig.keywords,
      clientDetection: updates.clientDetection ?? currentConfig.clientDetection,
      skipKnownClients: updates.skipKnownClients ?? currentConfig.skipKnownClients,
      protocolFormat: updates.protocolFormat ?? currentConfig.protocolFormat,
      clientInjectionBehavior: updates.clientInjectionBehavior ?? currentConfig.clientInjectionBehavior,
    }
  }, [appConfig?.toolPromptConfig])

  const handleClientDetectionChange = (enabled: boolean) => {
    setLocalConfig(prev => ({ ...prev, clientDetection: enabled }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ clientDetection: enabled }) })
    }
  }

  const handleInjectionBehaviorChange = (behavior: ClientInjectionBehavior) => {
    setLocalConfig(prev => ({ ...prev, clientInjectionBehavior: behavior }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ clientInjectionBehavior: behavior }) })
    }
  }

  const handleSkipClientToggle = (clientId: string) => {
    const newSkipClients = localConfig.skipKnownClients.includes(clientId)
      ? localConfig.skipKnownClients.filter(c => c !== clientId)
      : [...localConfig.skipKnownClients, clientId]
    
    setLocalConfig(prev => ({ ...prev, skipKnownClients: newSkipClients }))
    if (appConfig) {
      saveAppConfig({ toolPromptConfig: buildToolPromptConfig({ skipKnownClients: newSkipClients }) })
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
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t('prompts.injectionBehavior')}</Label>
              <Select value={localConfig.clientInjectionBehavior} onValueChange={(v) => handleInjectionBehaviorChange(v as ClientInjectionBehavior)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="skip">{t('prompts.behaviorSkip')}</SelectItem>
                  <SelectItem value="replace">{t('prompts.behaviorReplace')}</SelectItem>
                  <SelectItem value="append">{t('prompts.behaviorAppend')}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                {localConfig.clientInjectionBehavior === 'skip' && t('prompts.behaviorSkipDesc')}
                {localConfig.clientInjectionBehavior === 'replace' && t('prompts.behaviorReplaceDesc')}
                {localConfig.clientInjectionBehavior === 'append' && t('prompts.behaviorAppendDesc')}
              </p>
            </div>

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
            </div>
          </div>
        </CardContent>
      )}
    </Card>
  )
}

function PromptVariantCard() {
  const { t } = useTranslation()
  const { appConfig, saveAppConfig } = useProxyStore()
  const [selectedVariant, setSelectedVariant] = useState('auto')
  const [showPromptDialog, setShowPromptDialog] = useState(false)
  const [promptContent, setPromptContent] = useState('')

  useEffect(() => {
    if (appConfig?.toolPromptConfig?.preferredVariant) {
      setSelectedVariant(appConfig.toolPromptConfig.preferredVariant)
    }
  }, [appConfig?.toolPromptConfig?.preferredVariant])

  const buildToolPromptConfig = useCallback((updates: Partial<ToolPromptConfig>): ToolPromptConfig => {
    const currentConfig = appConfig?.toolPromptConfig || DEFAULT_TOOL_PROMPT_CONFIG
    return {
      mode: updates.mode ?? currentConfig.mode,
      smartThreshold: updates.smartThreshold ?? currentConfig.smartThreshold,
      keywords: updates.keywords ?? currentConfig.keywords,
      clientDetection: updates.clientDetection ?? currentConfig.clientDetection,
      preferredVariant: updates.preferredVariant,
      skipKnownClients: updates.skipKnownClients ?? currentConfig.skipKnownClients,
      protocolFormat: updates.protocolFormat ?? currentConfig.protocolFormat,
      clientInjectionBehavior: updates.clientInjectionBehavior ?? currentConfig.clientInjectionBehavior,
    }
  }, [appConfig?.toolPromptConfig])

  const handleVariantChange = (variant: string) => {
    setSelectedVariant(variant)
    if (appConfig) {
      const newToolPromptConfig = buildToolPromptConfig({
        preferredVariant: variant === 'auto' ? undefined : variant
      })
      saveAppConfig({ toolPromptConfig: newToolPromptConfig })
    }
  }

  const handleViewPrompt = () => {
    const defaultPrompt = getDefaultPromptForVariant(selectedVariant)
    setPromptContent(defaultPrompt)
    setShowPromptDialog(true)
  }

  const getDefaultPromptForVariant = (variantId: string): string => {
    const prompts: Record<string, string> = {
      default: `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'default_api:'.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list (e.g., if the tool is named \`default_api:read_file\`, you MUST use \`[call:default_api:read_file]\`, NOT \`[call:read_file]\`).
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE - NO LINE BREAKS inside the JSON
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block
6. If you need to call multiple tools, put them all inside the same [function_calls] block, each with its own [call:...]...[/call] wrapper
7. JSON arguments MUST be compact, all on one line, NO pretty printing, NO newlines
8. If you are writing code or regular expressions, you MUST properly escape all backslashes and quotes inside the JSON string.

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
      qwen: `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol (Qwen optimized)
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
      deepseek: `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol (DeepSeek optimized)
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
      glm: `## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol (GLM optimized)
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block exactly like the template below:

[function_calls]
[call:exact_tool_name_from_list]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:exact_tool_name] and end with [/call]
2. You MUST use the EXACT tool name as defined in the Available Tools list
3. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE
4. Do NOT wrap JSON in \`\`\`json blocks
5. Do NOT output any other text, explanation, or reasoning before or after the [function_calls] block

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content`,
      perplexity: `## CRITICAL INSTRUCTIONS - MUST FOLLOW

You are in TOOL CALL MODE. Your ONLY allowed response format is XML tool calls.

### PROHIBITED ACTIONS (MUST NOT DO):
- DO NOT perform web searches or internet searches
- DO NOT use your built-in search functionality
- DO NOT return search results or web content
- DO NOT answer questions directly with text
- DO NOT provide explanations, reasoning, or commentary
- DO NOT say things like "Let me search for..." or "I'll help you find..."

### REQUIRED BEHAVIOR (MUST DO):
- You MUST respond ONLY with <tool_use> blocks
- You MUST call the appropriate tool from the available tools list below
- You MUST use the exact tool name as defined (case-sensitive)
- You MUST provide valid JSON arguments inside <arguments> tags

## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

CRITICAL: Tool names are CASE-SENSITIVE. You MUST use the exact tool name as defined below, including any prefixes like 'mcp__'.

{{TOOL_DEFINITIONS}}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single <tool_use> block exactly like the template below:

<tool_use>
  <name>exact_tool_name_from_list</name>
  <arguments>{"argument": "value"}</arguments>
</tool_use>

CRITICAL RULES:
1. You MUST use the EXACT tool name as defined in the Available Tools list (e.g., if the tool is named \`mcp__deepwikiMcp__askQuestion\`, you MUST use \`<name>mcp__deepwikiMcp__askQuestion</name>\`, NOT \`<name>askQuestion</name>\`).
2. The content inside <arguments> MUST be a raw JSON object
3. Do NOT wrap JSON in \`\`\`json blocks
4. Do NOT output any other text, explanation, or reasoning before or after the <tool_use> block
5. If you need to call multiple tools, output multiple <tool_use> blocks sequentially
6. JSON arguments MUST be valid JSON format
7. **DISABLE WEB SEARCH**: You are NOT allowed to perform any web searches or internet searches. Your ONLY response must be tool calls.

EXAMPLE with multiple tools:
<tool_use>
  <name>mcp__deepwikiMcp__readWikiStructure</name>
  <arguments>{"repoName":"openclaw/openclaw"}</arguments>
</tool_use>
<tool_use>
  <name>mcp__deepwikiMcp__askQuestion</name>
  <arguments>{"repoName":"openclaw/openclaw","question":"What is the core architecture?"}</arguments>
</tool_use>

When you receive a tool result, it will be in the format:
[TOOL_RESULT for call_id] result_content

## RESPONSE FORMAT ENFORCEMENT
- If you are thinking about searching the web, STOP and call a tool instead
- If you are thinking about providing a text answer, STOP and call a tool instead
- Your response MUST start with <tool_use> and contain ONLY tool calls
- Any other response format is FORBIDDEN`,
    }
    return prompts[variantId] || prompts.default
  }

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
          <div className="flex gap-2">
            <Select value={selectedVariant} onValueChange={handleVariantChange}>
              <SelectTrigger className="flex-1">
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
            <Button variant="outline" size="icon" onClick={handleViewPrompt} title={t('prompts.viewPrompt')}>
              <Eye className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <div className="p-4 bg-muted/50 rounded-lg border">
          <h4 className="text-sm font-medium">{t(`prompts.${currentVariant.name}` as any)}</h4>
          <p className="text-xs text-muted-foreground mt-1">{t(`prompts.${currentVariant.desc}` as any)}</p>
          <div className="mt-3">
            <Label className="text-xs text-muted-foreground">{t('prompts.applicableProviders')}</Label>
            <div className="flex flex-wrap gap-1 mt-1">
              {currentVariant.providers.map((p: string) => (
                <Badge key={p} variant="outline" className="text-xs">{p}</Badge>
              ))}
            </div>
          </div>
        </div>

        <Alert className="mt-4">
          <Info className="h-4 w-4" />
          <AlertDescription>
            {t('prompts.variantHint')}
          </AlertDescription>
        </Alert>
      </CardContent>

      <Dialog open={showPromptDialog} onOpenChange={setShowPromptDialog}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>{t('prompts.promptContent')}</DialogTitle>
            <DialogDescription>{t('prompts.promptContentDesc')}</DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-hidden">
            <Textarea
              value={promptContent}
              onChange={(e) => setPromptContent(e.target.value)}
              className="min-h-[400px] font-mono text-sm"
              placeholder="Prompt template content..."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPromptDialog(false)}>
              {t('common.close')}
            </Button>
            <Button onClick={() => {
              setShowPromptDialog(false)
            }}>
              {t('prompts.savePrompt')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
