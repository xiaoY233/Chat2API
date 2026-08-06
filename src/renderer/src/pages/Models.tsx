import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { ArrowRight, Database, Wrench } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ModelList } from '@/components/models'
import { ToolCallingPanel } from '@/components/models/ToolCallingPanel'
import { ModelMappingConfig } from '@/components/proxy'
import { useProxyStore } from '@/stores/proxyStore'

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
        <TabsList className="grid h-auto w-full grid-cols-3">
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
          <ToolCallingPanel />
        </TabsContent>
      </Tabs>
    </div>
  )
}

export default Models
