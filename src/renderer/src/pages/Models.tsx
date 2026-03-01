import { useTranslation } from 'react-i18next'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ModelList } from '@/components/models'
import { ModelMappingConfig } from '@/components/proxy'
import { Database, ArrowRight, Wrench, DatabaseIcon, Code, CheckCircle2 } from 'lucide-react'

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
              <CardDescription>{t('prompts.toolUseDescription')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <p>{t('prompts.toolUseIntro')}</p>
            
            <h3 className="flex items-center gap-2 text-base font-semibold mt-6 mb-3">
              <CheckCircle2 className="h-4 w-4 text-green-500" />
              {t('prompts.howItWorks')}
            </h3>
            <p>{t('prompts.howItWorksDesc')}</p>
            
            <h3 className="flex items-center gap-2 text-base font-semibold mt-6 mb-3">
              <DatabaseIcon className="h-4 w-4 text-blue-500" />
              {t('prompts.supportedModels')}
            </h3>
            <p>{t('prompts.supportedModelsDesc')}</p>
            
            <h3 className="flex items-center gap-2 text-base font-semibold mt-6 mb-3">
              <Code className="h-4 w-4 text-orange-500" />
              {t('prompts.protocolFormat')}
            </h3>
            <p>{t('prompts.protocolFormatDesc')}</p>
          </div>
          
          <div className="mt-6 p-4 bg-muted/50 rounded-lg border">
            <h4 className="text-sm font-medium mb-2">{t('prompts.exampleOutput')}</h4>
            <pre className="text-xs bg-background p-3 rounded-md overflow-x-auto">
{`[function_calls]
[call:get_weather]{"location": "Beijing"}[/call]
[/function_calls]`}
            </pre>
          </div>
        </CardContent>
      </Card>
      
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('prompts.systemPromptPreview')}</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="text-xs bg-muted/50 p-4 rounded-lg overflow-x-auto whitespace-pre-wrap max-h-[400px] overflow-y-auto">
{`## Available Tools
You can invoke the following developer tools. Call a tool only when it is required and follow the JSON schema exactly when providing arguments.

Tool \`get_weather\`: Get current weather for a city. Arguments JSON schema: {"type":"object","properties":{"location":{"type":"string"}},"required":["location"]}

## Tool Call Protocol
When you decide to call a tool, you MUST respond with NOTHING except a single [function_calls] block:

[function_calls]
[call:tool_name]{"argument": "value"}[/call]
[/function_calls]

CRITICAL RULES:
1. EVERY tool call MUST start with [call:tool_name] and end with [/call]
2. The content between [call:...] and [/call] MUST be a raw JSON object on ONE LINE
3. Do NOT wrap JSON in \`\`\`json blocks
4. Do NOT output any other text before or after the [function_calls] block`}
          </pre>
        </CardContent>
      </Card>
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
